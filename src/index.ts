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

export class LobbyRegistry extends DurableObject<Env> {
	private lobbies: Map<string, Lobby> | null = null;

	private getLobbyId(ws: WebSocket): string | null {
		const attachment = ws.deserializeAttachment() as { lobbyId?: string } | null;
		if (attachment && attachment.lobbyId) return attachment.lobbyId;
		return null;
	}

	private normalizeIPv6(addr: string): string {
		try {
			const url = new URL(`http://[${addr}]`);
			return url.hostname.slice(1, -1);
		} catch {
			return addr;
		}
	}

	private getDetectedIps(ws: WebSocket): { ipv4: string, ipv6: string } {
		const ipTag = this.ctx.getTags(ws).find(t => t.startsWith("ip:"));
		const detectedIp = ipTag ? ipTag.slice(3) : "";
		if (detectedIp.includes(':')) return { ipv4: "", ipv6: this.normalizeIPv6(detectedIp) };
		return { ipv4: detectedIp, ipv6: "" };
	}

	private async getLobbies(): Promise<Map<string, Lobby>> {
		if (this.lobbies) return this.lobbies;
		this.lobbies = new Map();
		for (const [key, lobby] of await this.ctx.storage.list<Lobby>({ prefix: LOBBY_PREFIX })) {
			this.lobbies.set(key.slice(LOBBY_PREFIX.length), lobby);
		}
		const connectedLobbyIds = new Set(
			this.ctx.getWebSockets()
				.map(ws => this.getLobbyId(ws))
				.filter((id): id is string => id !== null)
		);
		for (const id of [...this.lobbies.keys()].filter(id => !connectedLobbyIds.has(id))) {
			this.lobbies.delete(id);
			await this.ctx.storage.delete(`${LOBBY_PREFIX}${id}`);
		}
		return this.lobbies;
	}

	private lobbyListMessage(lobbies: Map<string, Lobby>): string {
		return JSON.stringify({ type: "lobbies", lobbies: Array.from(lobbies, ([id, lobby]) => ({ id, ...lobby })) });
	}

	private broadcastLobbyList(lobbies: Map<string, Lobby>) {
		const message = this.lobbyListMessage(lobbies);
		for (const client of this.ctx.getWebSockets()) {
			if (!this.getLobbyId(client))
				client.send(message);
		}
	}

	private async removeLobby(lobbies: Map<string, Lobby>, id: string) {
		lobbies.delete(id);
		await this.ctx.storage.delete(`${LOBBY_PREFIX}${id}`);
	}

	async fetch(request: Request): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (pathname === '/') return new Response('KeeperFX Matchmaking Server');
		if (pathname !== '/ws') return new Response("Not found", { status: 404 });
		if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
		let ip = request.headers.get("CF-Connecting-IP");
		if (!ip) ip = "";
		const pair = new WebSocketPair();
		this.ctx.acceptWebSocket(pair[1], [`ip:${ip}`]);
		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		try {
			if (typeof message !== "string") return;

			let data: any;
			try {
				data = JSON.parse(message);
			} catch {
				ws.send(JSON.stringify({ type: "error", error: "Invalid JSON" }));
				return;
			}

			const lobbies = await this.getLobbies();

			if (data.action === "list") {
				let version = "";
				if (typeof data.version === "string") version = data.version;
				let filteredLobbies = lobbies;
				if (version) filteredLobbies = new Map(Array.from(lobbies).filter(([, l]) => l.version === version));
				ws.send(this.lobbyListMessage(filteredLobbies));
				return;
			}

			if (data.action === "create") {
				const ipv4Port = Number(data.ipv4Port);
				if (!Number.isInteger(ipv4Port) || ipv4Port < 1 || ipv4Port > 65535) {
					ws.send(JSON.stringify({ type: "error", error: "Invalid port" }));
					return;
				}
				const existingLobbyId = this.getLobbyId(ws);
				if (existingLobbyId) {
					await this.removeLobby(lobbies, existingLobbyId);
				}
				if (lobbies.size >= MAX_LOBBIES) {
					ws.send(JSON.stringify({ type: "error", error: "Server full" }));
					return;
				}
				const id = crypto.randomUUID().replace(/-/g, '');
				let name = "Unknown";
				if (typeof data.name === "string") name = data.name.slice(0, 64);
				let version = "";
				if (typeof data.version === "string") version = data.version.slice(0, 32);
				let ipv6Port = ipv4Port;
				const ipv6PortRaw = Number(data.ipv6Port);
				if (Number.isInteger(ipv6PortRaw) && ipv6PortRaw >= 1 && ipv6PortRaw <= 65535) ipv6Port = ipv6PortRaw;
				let { ipv4, ipv6 } = this.getDetectedIps(ws);
				if (typeof data.ipv4 === "string" && /^[\d.]+$/.test(data.ipv4)) ipv4 = data.ipv4;
				if (typeof data.ipv6 === "string" && /^[\da-fA-F:]+$/.test(data.ipv6)) ipv6 = this.normalizeIPv6(data.ipv6);
				const lobby = { name, ipv4, ipv6, ipv4Port, ipv6Port, version };
				lobbies.set(id, lobby);
				await this.ctx.storage.put(`${LOBBY_PREFIX}${id}`, lobby);
				ws.serializeAttachment({ lobbyId: id });
				ws.send(JSON.stringify({ type: "created", id }));
				this.broadcastLobbyList(lobbies);
				return;
			}

			if (data.action === "delete") {
				const lobbyId = this.getLobbyId(ws);
				if (data.id !== lobbyId || !lobbies.has(data.id)) {
					ws.send(JSON.stringify({ type: "deleted", success: false }));
					return;
				}
				await this.removeLobby(lobbies, data.id);
				ws.serializeAttachment({});
				ws.send(JSON.stringify({ type: "deleted", success: true }));
				this.broadcastLobbyList(lobbies);
				return;
			}

			if (data.action === "punch") {
				const joinerIpv4PortRaw = Number(data.myIpv4Port);
				const joinerIpv6PortRaw = Number(data.myIpv6Port);
				let hasJoinerIpv4Port = Number.isInteger(joinerIpv4PortRaw) && joinerIpv4PortRaw >= 1 && joinerIpv4PortRaw <= 65535;
				let hasJoinerIpv6Port = Number.isInteger(joinerIpv6PortRaw) && joinerIpv6PortRaw >= 1 && joinerIpv6PortRaw <= 65535;
				if (!hasJoinerIpv4Port && !hasJoinerIpv6Port) {
					ws.send(JSON.stringify({ type: "error", error: "Invalid udpPort" }));
					return;
				}
				if (typeof data.lobbyId !== "string" || !lobbies.has(data.lobbyId)) {
					ws.send(JSON.stringify({ type: "error", error: "Lobby not found" }));
					return;
				}
				const lobby = lobbies.get(data.lobbyId)!;
				let { ipv4: joinerIpv4, ipv6: joinerIpv6 } = this.getDetectedIps(ws);
				if (typeof data.myIpv4 === "string" && /^[\d.]+$/.test(data.myIpv4)) joinerIpv4 = data.myIpv4;
				if (typeof data.myIpv6 === "string" && /^[\da-fA-F:]+$/.test(data.myIpv6)) joinerIpv6 = this.normalizeIPv6(data.myIpv6);
				let hostWs: WebSocket | null = null;
				for (const client of this.ctx.getWebSockets()) {
					if (this.getLobbyId(client) === data.lobbyId) {
						hostWs = client;
						break;
					}
				}
				if (!hostWs || hostWs === ws) {
					ws.send(JSON.stringify({ type: "error", error: "Host not connected" }));
					return;
				}
				let joinerIpv4Port = 0;
				let joinerIpv6Port = 0;
				if (hasJoinerIpv4Port) {
					joinerIpv4Port = joinerIpv4PortRaw;
				} else {
					joinerIpv4 = "";
				}
				if (hasJoinerIpv6Port) {
					joinerIpv6Port = joinerIpv6PortRaw;
				} else {
					joinerIpv6 = "";
				}
				hostWs.send(JSON.stringify({ type: "punch", peerIpv4: joinerIpv4, peerIpv6: joinerIpv6, peerIpv4Port: joinerIpv4Port, peerIpv6Port: joinerIpv6Port }));
				ws.send(JSON.stringify({ type: "punch", peerIpv4: lobby.ipv4, peerIpv6: lobby.ipv6, peerIpv4Port: lobby.ipv4Port, peerIpv6Port: lobby.ipv6Port }));
				return;
			}

			ws.send(JSON.stringify({ type: "error", error: "Unknown action" }));
		} catch (error) {
			console.error(`[WS] Error in webSocketMessage:`, error);
			ws.send(JSON.stringify({ type: "error", error: String(error) }));
		}
	}

	async webSocketClose(ws: WebSocket) {
		const lobbyId = this.getLobbyId(ws);
		if (!lobbyId) return;
		const lobbies = await this.getLobbies();
		if (lobbies.has(lobbyId)) {
			await this.removeLobby(lobbies, lobbyId);
			this.broadcastLobbyList(lobbies);
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
