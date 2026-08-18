import { DurableObject } from 'cloudflare:workers';

interface Env {
	LOBBY_REGISTRY: DurableObjectNamespace<LobbyRegistry>;
	DISCORD_WEBHOOK_URL?: string;
}

interface Lobby {
	name: string;
	ipv4: string;
	ipv6: string;
	ipv4Port: number;
	ipv6Port: number;
	version: string;
	resultActions?: boolean;
}

const MAX_LOBBIES = 100;
const LOBBY_PREFIX = 'lobby:';
const PING_TIMEOUT_MS = 5000;
const LOBBY_PING_THROTTLE_MS = 15000;
const PING_MISSES_BEFORE_DROP = 3;

type RequestData = Record<string, unknown> & { action: string | undefined };
type LobbyAttachment = { lobbyId?: string };

export class LobbyRegistry extends DurableObject<Env> {
	private lobbies: Map<string, Lobby> | null = null;
	private pendingPingPromise: Promise<void> | null = null;
	private pendingPongs = new Set<string>();
	private lastPingAt = 0;

	private send(ws: WebSocket, payload: unknown) {
		ws.send(JSON.stringify(payload));
	}

	private error(ws: WebSocket, error: string) {
		this.send(ws, { type: "error", error });
	}

	private lobbyId(ws: WebSocket): string | null {
		const attachment = ws.deserializeAttachment() as LobbyAttachment | null;
		if (typeof attachment?.lobbyId === "string") {
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

	private async getLobbies(ws: WebSocket | null = null): Promise<Map<string, Lobby>> {
		if (!this.lobbies) {
			this.lobbies = new Map();
			for (const [key, lobby] of await this.ctx.storage.list<Lobby>({ prefix: LOBBY_PREFIX })) {
				this.lobbies.set(key.slice(LOBBY_PREFIX.length), lobby);
			}
		}
		const connectedLobbyIds = new Set(
			this.ctx.getWebSockets().map(ws => this.lobbyId(ws)).filter((id): id is string => id !== null)
		);
		if (ws) {
			const lobbyId = this.lobbyId(ws);
			if (lobbyId) connectedLobbyIds.add(lobbyId);
		}
		for (const [id, lobby] of [...this.lobbies]) {
			if (!connectedLobbyIds.has(id))
				await this.dropLobby(id, null, lobby.resultActions ? "disconnected" : "closed");
		}
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

	private async notifyDiscord(lobby: Lobby, action: "opened" | "cancelled" | "closed" | "disconnected" | "started" | "timed_out", players: string[] = [], mapName = "", mapNumber = 0) {
		if (!this.env.DISCORD_WEBHOOK_URL) return;
		try {
			const webhookUrl = new URL(this.env.DISCORD_WEBHOOK_URL);
			webhookUrl.searchParams.set("wait", "true");
			const name = lobby.name || "Unknown";
			let content = `**${name}** opened a lobby (**${lobby.version || "Unknown"}**)`;
			if (action === "cancelled")
				content = `**${name}** cancelled their lobby.`;
			if (action === "closed")
				content = `**${name}** closed their lobby / started the game.`;
			if (action === "disconnected")
				content = `**${name}**'s lobby was closed because the host disconnected.`;
			if (action === "started") {
				let map = mapName;
				if (mapName && mapNumber) map = `${mapName} [${mapNumber}]`;
				if (!mapName && mapNumber) map = `#${mapNumber}`;
				content = `**${name}** started a match`;
				if (players.length) content += `. Players: **${players.join("**, **")}**`;
				if (map) content += `. Map: **${map}**`;
				content += ".";
			}
			if (action === "timed_out")
				content = `**${name}**'s lobby was closed because it timed out.`;
			const response = await fetch(webhookUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					allowed_mentions: { parse: [] },
					content
				})
			});
			if (!response.ok)
				console.error(`[Discord] Webhook failed (${response.status}): ${await response.text()}`);
		} catch (error) {
			console.error("[Discord] Webhook failed:", error);
		}
	}

	private async dropLobby(id: string, ws: WebSocket | null = null, action: "cancelled" | "closed" | "disconnected" | "started" | "timed_out" = "disconnected", players: string[] = [], mapName = "", mapNumber = 0) {
		const lobby = this.lobbies?.get(id);
		this.lobbies?.delete(id);
		this.pendingPongs.delete(id);
		await this.ctx.storage.delete(`${LOBBY_PREFIX}${id}`);
		if (ws) ws.serializeAttachment({});
		if (lobby)
			this.ctx.waitUntil(this.notifyDiscord(lobby, action, players, mapName, mapNumber));
	}

	private playerNames(value: unknown): string[] {
		const players: string[] = [];
		if (!Array.isArray(value)) return players;
		for (const entry of value) {
			if (typeof entry !== "string") continue;
			const player = entry.trim().slice(0, 32);
			if (player) players.push(player);
			if (players.length === 4) break;
		}
		return players;
	}

	private async pingLobbies(lobbies: Map<string, Lobby>) {
		if (this.pendingPingPromise) return this.pendingPingPromise;

		if (Date.now() - this.lastPingAt < LOBBY_PING_THROTTLE_MS) return;
		this.lastPingAt = Date.now();

		this.pendingPingPromise = (async () => {
			try {
				let pendingHosts: { id: string; ws: WebSocket }[] = [];
				for (const client of this.ctx.getWebSockets()) {
					const lobbyId = this.lobbyId(client);
					if (!lobbyId || !lobbies.has(lobbyId)) continue;
					pendingHosts.push({ id: lobbyId, ws: client });
				}
				if (pendingHosts.length === 0) return;

				for (let attempt = 0; attempt < PING_MISSES_BEFORE_DROP && pendingHosts.length > 0; attempt++) {
					this.pendingPongs.clear();
					for (const { id, ws } of pendingHosts) {
						if (lobbies.has(id) && this.lobbyId(ws) === id)
							this.send(ws, { type: "ping" });
					}

					await new Promise(resolve => setTimeout(resolve, PING_TIMEOUT_MS));

					pendingHosts = pendingHosts.filter(({ id, ws }) =>
						lobbies.has(id) && this.lobbyId(ws) === id && !this.pendingPongs.has(id)
					);
				}

				for (const { id, ws } of pendingHosts) await this.dropLobby(id, ws, "timed_out");
				if (pendingHosts.length) this.broadcast(lobbies);
			} finally {
				this.pendingPingPromise = null;
				this.pendingPongs.clear();
			}
		})();

		return this.pendingPingPromise;
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
		if (currentLobbyId) await this.dropLobby(currentLobbyId, ws, "cancelled");
		if (lobbies.size >= MAX_LOBBIES) return this.error(ws, "Server full");

		const id = crypto.randomUUID().replace(/-/g, '');
		const { ipv4, ipv6 } = this.ips(ws, data.ipv4, data.ipv6);
		const name = this.string(data.name, "Unknown").slice(0, 64);
		const version = this.string(data.version).trim().slice(0, 32);
		const ipv6Port = this.port(data.ipv6Port) || ipv4Port;
		const resultActions = data.resultActions === true;
		const lobby = { name, ipv4, ipv6, ipv4Port, ipv6Port, version, resultActions };

		lobbies.set(id, lobby);
		await this.ctx.storage.put(`${LOBBY_PREFIX}${id}`, lobby);
		ws.serializeAttachment({ lobbyId: id });
		this.send(ws, { type: "created", id });
		this.broadcast(lobbies);
		this.ctx.waitUntil(this.notifyDiscord(lobby, "opened"));
	}

	private async onDelete(ws: WebSocket, data: RequestData, lobbies: Map<string, Lobby>, action: "cancelled" | "closed") {
		const lobbyId = this.string(data.id);
		if (lobbyId !== this.lobbyId(ws) || !lobbies.has(lobbyId))
			return this.send(ws, { type: "deleted", success: false });
		await this.dropLobby(lobbyId, ws, action);
		this.send(ws, { type: "deleted", success: true });
		this.broadcast(lobbies);
	}

	private async onGameStarted(ws: WebSocket, data: RequestData, lobbies: Map<string, Lobby>) {
		const lobbyId = this.string(data.id);
		const players = this.playerNames(data.players);
		const mapName = this.string(data.mapName).trim().slice(0, 128);
		let mapNumber = Number(data.mapNumber);
		if (!Number.isInteger(mapNumber) || mapNumber <= 0) mapNumber = 0;
		if (lobbyId !== this.lobbyId(ws) || !lobbies.has(lobbyId))
			return this.error(ws, "Invalid match start");
		await this.dropLobby(lobbyId, ws, "started", players, mapName, mapNumber);
		this.send(ws, { type: "game_started", success: true });
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
			await this.dropLobby(lobbyId, null, lobby.resultActions ? "disconnected" : "closed");
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
				if (lobbyId && this.pendingPingPromise)
					this.pendingPongs.add(lobbyId);
				return;
			}

			const lobbies = await this.getLobbies(ws);

			switch (data.action) {
				case "list":
					ws.send(this.listMessage(lobbies));
					this.ctx.waitUntil(this.pingLobbies(lobbies));
					return;
				case "create":
					return this.onCreate(ws, data, lobbies);
				case "delete":
					return this.onDelete(ws, data, lobbies, "closed");
				case "cancel":
					return this.onDelete(ws, data, lobbies, "cancelled");
				case "game_started":
					return this.onGameStarted(ws, data, lobbies);
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
		const lobbies = await this.getLobbies(ws);
		const lobby = lobbies.get(lobbyId);
		if (!lobby) return;
		await this.dropLobby(lobbyId, null, lobby.resultActions ? "disconnected" : "closed");
		this.broadcast(lobbies);
	}

	async webSocketError(ws: WebSocket) {
		await this.webSocketClose(ws);
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (pathname === '/ip') return new Response(request.headers.get("CF-Connecting-IP") || "");
		return env.LOBBY_REGISTRY.getByName('global').fetch(request);
	}
} satisfies ExportedHandler<Env>;
