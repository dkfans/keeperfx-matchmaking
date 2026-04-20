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
}

const MAX_LOBBIES = 100;
const LOBBY_PREFIX = 'lobby:';
const PING_TIMEOUT_MS = 5000;

type RequestData = Record<string, unknown> & { action: string | undefined };

export class LobbyRegistry extends DurableObject<Env> {
	private lobbies: Map<string, Lobby> | null = null;
	private pendingPingPromise: Promise<void> | null = null;
	private pendingPongs = new Set<string>();

	private send(ws: WebSocket, payload: unknown) {
		ws.send(JSON.stringify(payload));
	}

	private error(ws: WebSocket, error: string) {
		this.send(ws, { type: "error", error });
	}

	private lobbyId(ws: WebSocket): string | null {
		const attachment = ws.deserializeAttachment() as { lobbyId: string | undefined } | null;
		if (attachment && typeof attachment.lobbyId === "string") {
			return attachment.lobbyId;
		}
		return null;
	}

	private port(value: unknown): number {
		const n = Number(value);
		if (Number.isInteger(n) && n >= 1 && n <= 65535) {
			return n;
		}
		return 0;
	}

	private string(value: unknown, fallback = ""): string {
		if (typeof value === "string") return value;
		return fallback;
	}

	private normalizeIPv6(addr: string): string {
		try {
			return new URL(`http://[${addr}]`).hostname.slice(1, -1);
		} catch {
			return addr;
		}
	}

	private ips(ws: WebSocket, ipv4Raw: unknown, ipv6Raw: unknown) {
		let detectedIp = "";
		for (const tag of this.ctx.getTags(ws)) {
			if (tag.startsWith("ip:")) {
				detectedIp = tag.slice(3);
				break;
			}
		}
		const ips = { ipv4: detectedIp, ipv6: "" };
		if (detectedIp.includes(':')) {
			ips.ipv4 = "";
			ips.ipv6 = this.normalizeIPv6(detectedIp);
		}
		if (typeof ipv4Raw === "string" && /^[\d.]+$/.test(ipv4Raw)) ips.ipv4 = ipv4Raw;
		if (typeof ipv6Raw === "string" && /^[\da-fA-F:]+$/.test(ipv6Raw)) ips.ipv6 = this.normalizeIPv6(ipv6Raw);
		return ips;
	}

	private async getLobbies(): Promise<Map<string, Lobby>> {
		if (!this.lobbies) {
			this.lobbies = new Map();
			for (const [key, lobby] of await this.ctx.storage.list<Lobby>({ prefix: LOBBY_PREFIX })) {
				this.lobbies.set(key.slice(LOBBY_PREFIX.length), lobby);
			}
		}
		const connectedLobbyIds = new Set(
			this.ctx.getWebSockets().map(ws => this.lobbyId(ws)).filter((id): id is string => id !== null)
		);
		for (const id of [...this.lobbies.keys()].filter(id => !connectedLobbyIds.has(id)))
			await this.dropLobby(id);
		return this.lobbies;
	}

	private listMessage(lobbies: Map<string, Lobby>): string {
		return JSON.stringify({ type: "lobbies", lobbies: Array.from(lobbies, ([id, lobby]) => ({ id, ...lobby })) });
	}

	private broadcast(lobbies: Map<string, Lobby>) {
		const message = this.listMessage(lobbies);
		for (const client of this.ctx.getWebSockets())
			if (!this.lobbyId(client))
				client.send(message);
	}

	private async dropLobby(id: string, ws: WebSocket | null = null) {
		if (this.lobbies) {
			this.lobbies.delete(id);
		}
		await this.ctx.storage.delete(`${LOBBY_PREFIX}${id}`);
		if (ws) {
			ws.serializeAttachment({});
		}
	}

	private async pingLobbies(lobbies: Map<string, Lobby>) {
		if (this.pendingPingPromise) {
			await this.pendingPingPromise;
			return;
		}

		this.pendingPingPromise = (async () => {
			try {
				const hostLobbyIds: string[] = [];
				this.pendingPongs.clear();
				for (const client of this.ctx.getWebSockets()) {
					const lobbyId = this.lobbyId(client);
					if (!lobbyId || !lobbies.has(lobbyId)) continue;
					hostLobbyIds.push(lobbyId);
					this.send(client, { type: "ping" });
				}
				if (hostLobbyIds.length === 0) return;

				await new Promise(resolve => setTimeout(resolve, PING_TIMEOUT_MS));

				const toRemove = hostLobbyIds.filter(id => !this.pendingPongs.has(id) && lobbies.has(id));
				for (const id of toRemove) await this.dropLobby(id);
				if (toRemove.length) this.broadcast(lobbies);
			} finally {
				this.pendingPingPromise = null;
			}
		})();

		await this.pendingPingPromise;
	}

	async fetch(request: Request): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (pathname === '/') return new Response('KeeperFX Matchmaking Server');
		if (pathname !== '/ws') return new Response("Not found", { status: 404 });
		if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
		const pair = new WebSocketPair();
		this.ctx.acceptWebSocket(pair[1], [`ip:${request.headers.get("CF-Connecting-IP") || ""}`]);
		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	private async onCreate(ws: WebSocket, data: RequestData, lobbies: Map<string, Lobby>) {
		const ipv4Port = this.port(data.ipv4Port);
		if (!ipv4Port) return this.error(ws, "Invalid port");
		const currentLobbyId = this.lobbyId(ws);
		if (currentLobbyId) await this.dropLobby(currentLobbyId, ws);
		if (lobbies.size >= MAX_LOBBIES) return this.error(ws, "Server full");

		const id = crypto.randomUUID().replace(/-/g, '');
		const { ipv4, ipv6 } = this.ips(ws, data.ipv4, data.ipv6);
		const name = this.string(data.name, "Unknown").slice(0, 64);
		const version = this.string(data.version).slice(0, 32);
		const ipv6Port = this.port(data.ipv6Port) || ipv4Port;
		const lobby = { name, ipv4, ipv6, ipv4Port, ipv6Port, version };

		lobbies.set(id, lobby);
		await this.ctx.storage.put(`${LOBBY_PREFIX}${id}`, lobby);
		ws.serializeAttachment({ lobbyId: id });
		this.send(ws, { type: "created", id });
		this.broadcast(lobbies);
	}

	private async onDelete(ws: WebSocket, data: RequestData, lobbies: Map<string, Lobby>) {
		const lobbyId = this.string(data.id);
		if (lobbyId !== this.lobbyId(ws) || !lobbies.has(lobbyId))
			return this.send(ws, { type: "deleted", success: false });
		await this.dropLobby(lobbyId, ws);
		this.send(ws, { type: "deleted", success: true });
		this.broadcast(lobbies);
	}

	private async onPunch(ws: WebSocket, data: RequestData, lobbies: Map<string, Lobby>) {
		const ipv4Port = this.port(data.myIpv4Port);
		const ipv6Port = this.port(data.myIpv6Port);
		if (!ipv4Port && !ipv6Port) return this.error(ws, "Invalid udpPort");

		const lobbyId = this.string(data.lobbyId);
		const lobby = lobbies.get(lobbyId);
		if (!lobby) return this.error(ws, "Lobby not found");

		const hostWs = this.ctx.getWebSockets().find(client => this.lobbyId(client) === lobbyId);
		if (!hostWs) {
			await this.dropLobby(lobbyId);
			this.broadcast(lobbies);
			return this.error(ws, "Lobby not found");
		}
		if (hostWs === ws) return this.error(ws, "Host not connected");

		const joiner = this.ips(ws, data.myIpv4, data.myIpv6);
		if (!ipv4Port) joiner.ipv4 = "";
		if (!ipv6Port) joiner.ipv6 = "";
		this.send(hostWs, { type: "punch", peerIpv4: joiner.ipv4, peerIpv6: joiner.ipv6, peerIpv4Port: ipv4Port, peerIpv6Port: ipv6Port });
		this.send(ws, { type: "punch", peerIpv4: lobby.ipv4, peerIpv6: lobby.ipv6, peerIpv4Port: lobby.ipv4Port, peerIpv6Port: lobby.ipv6Port });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		try {
			if (typeof message !== "string") return;

			let data: RequestData;
			try {
				data = JSON.parse(message);
			} catch {
				this.error(ws, "Invalid JSON");
				return;
			}

			if (data.action === "pong") {
				const lobbyId = this.lobbyId(ws);
				if (lobbyId && this.pendingPingPromise) this.pendingPongs.add(lobbyId);
				return;
			}

			const lobbies = await this.getLobbies();

			switch (data.action) {
				case "list":
					ws.send(this.listMessage(lobbies));
					this.ctx.waitUntil(this.pingLobbies(lobbies));
					return;
				case "create":
					return this.onCreate(ws, data, lobbies);
				case "delete":
					return this.onDelete(ws, data, lobbies);
				case "punch":
					return this.onPunch(ws, data, lobbies);
				default:
					return this.error(ws, "Unknown action");
			}
		} catch (error) {
			console.error(`[WS] Error in webSocketMessage:`, error);
			this.error(ws, String(error));
		}
	}

	async webSocketClose(ws: WebSocket) {
		const lobbyId = this.lobbyId(ws);
		if (!lobbyId) return;
		const lobbies = await this.getLobbies();
		if (lobbies.has(lobbyId)) {
			await this.dropLobby(lobbyId);
			this.broadcast(lobbies);
		}
	}

	async webSocketError(ws: WebSocket) {
		await this.webSocketClose(ws);
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (pathname === '/ip') return new Response(request.headers.get("CF-Connecting-IP") || "");
		return env.LOBBY_REGISTRY.get(env.LOBBY_REGISTRY.idFromName('global')).fetch(request);
	}
} satisfies ExportedHandler<Env>;
