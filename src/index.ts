import { DurableObject } from 'cloudflare:workers';

interface Env {
	LOBBY_REGISTRY: DurableObjectNamespace<LobbyRegistry>;
}

interface Lobby {
	name: string;
	ipv4: string;
	ipv6: string;
	ipv4Port: number;
	ipv6Port: number;
	version: string;
	ownerIp: string;
	expiresAt: number;
}

interface Claim {
	ip: string;
	expiresAt: number;
}

const PROTOCOL_VERSION = 2;
const MAX_LOBBIES = 100;
const MAX_LOBBIES_PER_IP = 4;
const MAX_LISTED_LOBBIES = 32;
const MAX_MESSAGES_PER_MINUTE = 120;
const LOBBY_TTL_MS = 60000;
const LEGACY_LOBBY_TTL_MS = 86400000;
const CLAIM_TTL_MS = 600000;
const PUNCH_THROTTLE_MS = 500;
const LOBBY_PREFIX = 'lobby:';
const CLAIM_PREFIX = 'claim:';

type RequestData = Record<string, unknown> & { action: string | undefined };
type LobbyAttachment = {
	lobbyId?: string;
	ip?: string;
	version?: string;
	windowAt?: number;
	messages?: number;
	lastPunchAt?: number;
};

export class LobbyRegistry extends DurableObject<Env> {
	private lobbies: Map<string, Lobby> | null = null;

	private send(ws: WebSocket, payload: unknown) {
		ws.send(JSON.stringify(payload));
	}

	private error(ws: WebSocket, error: string, requestId = '') {
		this.send(ws, { type: 'error', error, requestId });
	}

	private attachment(ws: WebSocket): LobbyAttachment {
		return (ws.deserializeAttachment() as LobbyAttachment | null) ?? {};
	}

	private saveAttachment(ws: WebSocket, attachment: LobbyAttachment) {
		ws.serializeAttachment(attachment);
	}

	private lobbyId(ws: WebSocket): string | null {
		const lobbyId = this.attachment(ws).lobbyId;
		if (typeof lobbyId === 'string') return lobbyId;
		return null;
	}

	private port(value: unknown): number {
		const port = Number(value);
		if (Number.isInteger(port) && port >= 1 && port <= 65535) return port;
		return 0;
	}

	private string(value: unknown, maximum: number, fallback = ''): string {
		if (typeof value !== 'string') return fallback;
		return value.slice(0, maximum);
	}

	private requestId(data: RequestData): string {
		const requestId = this.string(data.requestId, 32);
		if (/^[\da-f]+$/i.test(requestId)) return requestId;
		return '';
	}

	private normalizeIp(address: string): string {
		if (address.includes(':')) {
			try {
				return new URL(`http://[${address}]`).hostname.slice(1, -1).toLowerCase();
			} catch {
				return '';
			}
		}
		const octets = address.split('.');
		if (octets.length !== 4) return '';
		const numbers = octets.map(Number);
		if (numbers.some((number, index) => !Number.isInteger(number) || number < 0 || number > 255 || String(number) !== octets[index])) return '';
		return numbers.join('.');
	}

	private publicIp(address: string): string {
		const normalized = this.normalizeIp(address);
		if (!normalized) return '';
		if (normalized.includes(':')) {
			if (normalized === '::' || normalized === '::1' || /^(f[cd]|fe[89ab]|ff)/i.test(normalized)) return '';
			return normalized;
		}
		const octets = normalized.split('.').map(Number);
		if (octets[0] === 0 || octets[0] === 10 || octets[0] === 127 || octets[0] >= 224) return '';
		if (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) return '';
		if (octets[0] === 169 && octets[1] === 254) return '';
		if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return '';
		if (octets[0] === 192 && octets[1] === 168) return '';
		return normalized;
	}

	private detectedIp(ws: WebSocket): string {
		for (const tag of this.ctx.getTags(ws)) {
			if (tag.startsWith('ip:')) return this.publicIp(tag.slice(3));
		}
		return '';
	}

	private async claimedIp(token: unknown): Promise<string> {
		if (typeof token !== 'string' || !/^[\da-f]{32}$/i.test(token)) return '';
		const key = `${CLAIM_PREFIX}${token}`;
		const claim = await this.ctx.storage.get<Claim>(key);
		if (!claim) return '';
		if (claim.expiresAt > Date.now()) return this.publicIp(claim.ip);
		await this.ctx.storage.delete(key);
		return '';
	}

	private async ips(ws: WebSocket, ipv4Claim: unknown, ipv6Claim: unknown) {
		const detected = this.detectedIp(ws);
		const addresses = { ipv4: '', ipv6: '' };
		if (detected.includes(':')) addresses.ipv6 = detected;
		if (detected && !detected.includes(':')) addresses.ipv4 = detected;
		const [ipv4, ipv6] = await Promise.all([this.claimedIp(ipv4Claim), this.claimedIp(ipv6Claim)]);
		if (ipv4 && !ipv4.includes(':')) addresses.ipv4 = ipv4;
		if (ipv6.includes(':')) addresses.ipv6 = ipv6;
		return addresses;
	}

	private async scheduleAlarm(expiresAt: number) {
		const alarm = await this.ctx.storage.getAlarm();
		if (alarm === null || expiresAt < alarm) await this.ctx.storage.setAlarm(expiresAt);
	}

	private async getLobbies(): Promise<Map<string, Lobby>> {
		if (!this.lobbies) {
			this.lobbies = new Map();
			for (const [key, lobby] of await this.ctx.storage.list<Lobby>({ prefix: LOBBY_PREFIX })) this.lobbies.set(key.slice(LOBBY_PREFIX.length), lobby);
		}
		const connected = new Set(this.ctx.getWebSockets().map(ws => this.lobbyId(ws)).filter((id): id is string => id !== null));
		const now = Date.now();
		for (const [id, lobby] of [...this.lobbies]) {
			if (lobby.expiresAt <= now || !connected.has(id)) await this.dropLobby(id);
		}
		return this.lobbies;
	}

	private listMessage(lobbies: Map<string, Lobby>, version = ''): string {
		const listed = [];
		for (const [id, lobby] of lobbies) {
			if (version && lobby.version !== version) continue;
			listed.push({ id, name: lobby.name, ipv4: lobby.ipv4, ipv6: lobby.ipv6, ipv4Port: lobby.ipv4Port, ipv6Port: lobby.ipv6Port, version: lobby.version });
			if (listed.length === MAX_LISTED_LOBBIES) break;
		}
		return JSON.stringify({ type: 'lobbies', protocolVersion: PROTOCOL_VERSION, lobbies: listed });
	}

	private broadcast(lobbies: Map<string, Lobby>) {
		for (const client of this.ctx.getWebSockets()) {
			const attachment = this.attachment(client);
			if (!attachment.lobbyId) client.send(this.listMessage(lobbies, attachment.version));
		}
	}

	private async dropLobby(id: string, ws: WebSocket | null = null) {
		if (this.lobbies) this.lobbies.delete(id);
		await this.ctx.storage.delete(`${LOBBY_PREFIX}${id}`);
		if (ws) {
			const attachment = this.attachment(ws);
			delete attachment.lobbyId;
			this.saveAttachment(ws, attachment);
		}
	}

	private allowed(ws: WebSocket, action: string): boolean {
		const now = Date.now();
		const attachment = this.attachment(ws);
		if (!attachment.windowAt || now - attachment.windowAt >= 60000) {
			attachment.windowAt = now;
			attachment.messages = 0;
		}
		attachment.messages = (attachment.messages ?? 0) + 1;
		if (action === 'punch') {
			if (attachment.lastPunchAt && now - attachment.lastPunchAt < PUNCH_THROTTLE_MS) return false;
			attachment.lastPunchAt = now;
		}
		this.saveAttachment(ws, attachment);
		return attachment.messages <= MAX_MESSAGES_PER_MINUTE;
	}

	private async onCreate(ws: WebSocket, data: RequestData, lobbies: Map<string, Lobby>) {
		const requestId = this.requestId(data);
		const ipv4Port = this.port(data.ipv4Port);
		const ipv6Port = this.port(data.ipv6Port);
		if (!ipv4Port && !ipv6Port) return this.error(ws, 'Invalid port', requestId);
		const attachment = this.attachment(ws);
		if (attachment.lobbyId) await this.dropLobby(attachment.lobbyId, ws);
		if (lobbies.size >= MAX_LOBBIES) return this.error(ws, 'Server full', requestId);
		const ownerIp = attachment.ip ?? this.detectedIp(ws);
		if ([...lobbies.values()].filter(lobby => lobby.ownerIp === ownerIp).length >= MAX_LOBBIES_PER_IP) return this.error(ws, 'Lobby limit reached', requestId);
		const addresses = await this.ips(ws, data.ipv4Claim, data.ipv6Claim);
		if (!addresses.ipv4 && !addresses.ipv6) return this.error(ws, 'No verified address', requestId);
		if (!ipv4Port) addresses.ipv4 = '';
		if (!ipv6Port) addresses.ipv6 = '';
		const id = crypto.randomUUID().replace(/-/g, '');
		let lobbyTtl = LEGACY_LOBBY_TTL_MS;
		if (typeof data.ipv4Claim === 'string' || typeof data.ipv6Claim === 'string') lobbyTtl = LOBBY_TTL_MS;
		const lobby = {
			name: this.string(data.name, 64, 'Unknown'),
			ipv4: addresses.ipv4,
			ipv6: addresses.ipv6,
			ipv4Port,
			ipv6Port,
			version: this.string(data.version, 32),
			ownerIp,
			expiresAt: Date.now() + lobbyTtl
		};
		lobbies.set(id, lobby);
		await this.ctx.storage.put(`${LOBBY_PREFIX}${id}`, lobby);
		attachment.lobbyId = id;
		this.saveAttachment(ws, attachment);
		await this.scheduleAlarm(lobby.expiresAt);
		console.log(JSON.stringify({ event: 'lobby_created', version: lobby.version, ipv4: !!lobby.ipv4, ipv6: !!lobby.ipv6 }));
		this.send(ws, { type: 'created', id, requestId, protocolVersion: PROTOCOL_VERSION });
		this.broadcast(lobbies);
	}

	private async onDelete(ws: WebSocket, data: RequestData, lobbies: Map<string, Lobby>) {
		const requestId = this.requestId(data);
		const lobbyId = this.string(data.id, 32);
		if (lobbyId !== this.lobbyId(ws) || !lobbies.has(lobbyId)) return this.send(ws, { type: 'deleted', success: false, requestId });
		await this.dropLobby(lobbyId, ws);
		this.send(ws, { type: 'deleted', success: true, requestId });
		this.broadcast(lobbies);
	}

	private async onHeartbeat(ws: WebSocket, lobbies: Map<string, Lobby>) {
		const lobbyId = this.lobbyId(ws);
		if (!lobbyId) return;
		const lobby = lobbies.get(lobbyId);
		if (!lobby) return;
		lobby.expiresAt = Date.now() + LOBBY_TTL_MS;
		await this.ctx.storage.put(`${LOBBY_PREFIX}${lobbyId}`, lobby);
		await this.scheduleAlarm(lobby.expiresAt);
	}

	private async onUpdate(ws: WebSocket, data: RequestData, lobbies: Map<string, Lobby>) {
		const lobbyId = this.lobbyId(ws);
		if (!lobbyId) return;
		const lobby = lobbies.get(lobbyId);
		if (!lobby) return;
		const ipv4Port = this.port(data.ipv4Port);
		const ipv6Port = this.port(data.ipv6Port);
		if (ipv4Port) lobby.ipv4Port = ipv4Port;
		if (ipv6Port) lobby.ipv6Port = ipv6Port;
		lobby.expiresAt = Date.now() + LOBBY_TTL_MS;
		await this.ctx.storage.put(`${LOBBY_PREFIX}${lobbyId}`, lobby);
		this.broadcast(lobbies);
	}

	private async onPunch(ws: WebSocket, data: RequestData, lobbies: Map<string, Lobby>) {
		const requestId = this.requestId(data) || crypto.randomUUID().replace(/-/g, '');
		const ipv4Port = this.port(data.myIpv4Port);
		const ipv6Port = this.port(data.myIpv6Port);
		if (!ipv4Port && !ipv6Port) return this.error(ws, 'Invalid udpPort', requestId);
		const lobbyId = this.string(data.lobbyId, 32);
		const lobby = lobbies.get(lobbyId);
		if (!lobby) return this.error(ws, 'Lobby not found', requestId);
		const hostWs = this.ctx.getWebSockets().find(client => this.lobbyId(client) === lobbyId);
		if (!hostWs || hostWs === ws) return this.error(ws, 'Host not connected', requestId);
		const joiner = await this.ips(ws, data.ipv4Claim, data.ipv6Claim);
		if (!ipv4Port) joiner.ipv4 = '';
		if (!ipv6Port) joiner.ipv6 = '';
		if (!joiner.ipv4 && !joiner.ipv6) return this.error(ws, 'No verified address', requestId);
		const punch = crypto.randomUUID().replace(/-/g, '');
		console.log(JSON.stringify({ event: 'punch_requested', ipv4: !!joiner.ipv4 && !!lobby.ipv4, ipv6: !!joiner.ipv6 && !!lobby.ipv6 }));
		this.send(hostWs, { type: 'punch', requestId, punch, peerIpv4: joiner.ipv4, peerIpv6: joiner.ipv6, peerIpv4Port: ipv4Port, peerIpv6Port: ipv6Port });
		this.send(ws, { type: 'punch', requestId, punch, peerIpv4: lobby.ipv4, peerIpv6: lobby.ipv6, peerIpv4Port: lobby.ipv4Port, peerIpv6Port: lobby.ipv6Port });
	}

	async fetch(request: Request): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (pathname === '/') return new Response('KeeperFX Matchmaking Server');
		if (pathname === '/claim') {
			const ip = this.publicIp(request.headers.get('CF-Connecting-IP') ?? '');
			if (!ip) return new Response('Unavailable', { status: 400 });
			const token = crypto.randomUUID().replace(/-/g, '');
			const claim = { ip, expiresAt: Date.now() + CLAIM_TTL_MS };
			await this.ctx.storage.put(`${CLAIM_PREFIX}${token}`, claim);
			await this.scheduleAlarm(claim.expiresAt);
			return Response.json({ ip, claim: token });
		}
		if (pathname !== '/ws') return new Response('Not found', { status: 404 });
		if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
		const pair = new WebSocketPair();
		const ip = this.publicIp(request.headers.get('CF-Connecting-IP') ?? '');
		this.ctx.acceptWebSocket(pair[1], [`ip:${ip}`]);
		this.saveAttachment(pair[1], { ip });
		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		try {
			if (typeof message !== 'string' || message.length > 2048) return this.error(ws, 'Invalid message');
			let data: RequestData;
			try {
				data = JSON.parse(message);
			} catch {
				return this.error(ws, 'Invalid JSON');
			}
			const action = this.string(data.action, 16);
			if (!this.allowed(ws, action)) return this.error(ws, 'Rate limited', this.requestId(data));
			const lobbies = await this.getLobbies();
			switch (action) {
				case 'list': {
					const attachment = this.attachment(ws);
					attachment.version = this.string(data.version, 32);
					this.saveAttachment(ws, attachment);
					ws.send(this.listMessage(lobbies, attachment.version));
					return;
				}
				case 'create':
					return this.onCreate(ws, data, lobbies);
				case 'delete':
					return this.onDelete(ws, data, lobbies);
				case 'heartbeat':
					return this.onHeartbeat(ws, lobbies);
				case 'update':
					return this.onUpdate(ws, data, lobbies);
				case 'punch':
					return this.onPunch(ws, data, lobbies);
				default:
					return this.error(ws, 'Unknown action', this.requestId(data));
			}
		} catch (error) {
			console.error('[WS] Error in webSocketMessage:', error);
			this.error(ws, 'Server error');
		}
	}

	async webSocketClose(ws: WebSocket) {
		const lobbyId = this.lobbyId(ws);
		if (!lobbyId) return;
		const lobbies = await this.getLobbies();
		if (!lobbies.has(lobbyId)) return;
		await this.dropLobby(lobbyId);
		this.broadcast(lobbies);
	}

	async webSocketError(ws: WebSocket) {
		await this.webSocketClose(ws);
	}

	async alarm() {
		const now = Date.now();
		const lobbies = await this.getLobbies();
		const claims = await this.ctx.storage.list<Claim>({ prefix: CLAIM_PREFIX });
		for (const [key, claim] of claims) {
			if (claim.expiresAt <= now) await this.ctx.storage.delete(key);
		}
		let next = 0;
		for (const lobby of lobbies.values()) {
			if (!next || lobby.expiresAt < next) next = lobby.expiresAt;
		}
		for (const claim of claims.values()) {
			if (claim.expiresAt > now && (!next || claim.expiresAt < next)) next = claim.expiresAt;
		}
		if (next) await this.ctx.storage.setAlarm(next);
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (pathname === '/ip') return new Response(request.headers.get('CF-Connecting-IP') || '');
		return env.LOBBY_REGISTRY.get(env.LOBBY_REGISTRY.idFromName('global')).fetch(request);
	}
} satisfies ExportedHandler<Env>;
