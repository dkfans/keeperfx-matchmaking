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
	directIpv4Port: number;
	version: string;
	createdAt?: number;
	resultActions?: boolean;
	phase?: "Lobby" | "In-Game" | "In-Landview";
	joinable?: boolean;
	maxPlayers?: number;
	players?: string[];
}

const MAX_LOBBIES = 100;
const LOBBY_PREFIX = 'lobby:';
const HEARTBEAT_INTERVAL_MS = 30000;
const HEARTBEAT_TIMEOUT_MS = 5000;
const HEARTBEAT_FAILURE_LIMIT = 3;
const textEncoder = new TextEncoder();

enum NetJoinRejection {
	InGame = 1,
	Locked = 2,
	Full = 3,
	Version = 4,
}

type RequestData = Record<string, unknown> & { action: string };
type LobbyAttachment = { lobbyId?: string; lobby?: Lobby; expiresAt?: number; heartbeatAttempts?: number };
type LobbyAction = "opened" | "cancelled" | "closed" | "disconnected" | "started" | "timed_out";

function escapeDiscordMarkdown(value: string)
{
	const text = value.replace(/[\r\n]+/g, " ");
	return text.replace(/([\\`*_{}\[\]()<>#+\-.!|~])/g, "\\$1");
}

export class LobbyRegistry extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env)
	{
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			const stored = await ctx.storage.list<Lobby>({ prefix: LOBBY_PREFIX });
			const keys = [...stored.keys()];
			for (const ws of ctx.getWebSockets()) {
				const attachment = ws.deserializeAttachment() as LobbyAttachment | null;
				if (!attachment?.lobbyId) continue;
				const key = LOBBY_PREFIX + attachment.lobbyId;
				const lobby = attachment.lobby || stored.get(key);
				if (lobby && (!attachment.lobby || !attachment.expiresAt)) ws.serializeAttachment({ lobbyId: attachment.lobbyId, lobby, expiresAt: Date.now() + HEARTBEAT_INTERVAL_MS });
				stored.delete(key);
			}
			for (const lobby of stored.values()) {
				if (lobby.phase === "In-Game") continue;
				let action: LobbyAction = "closed";
				if (lobby.resultActions) action = "disconnected";
				ctx.waitUntil(this.notifyDiscord(lobby, action));
			}
			if (keys.length) await ctx.storage.delete(keys);
			const alarmAt = await ctx.storage.getAlarm();
			if (this.getLobbies().size && (alarmAt === null || alarmAt <= Date.now())) await ctx.storage.setAlarm(Date.now());
		});
	}

	private error(ws: WebSocket, error: string, reason = 0)
	{
		ws.send(JSON.stringify({ type: "error", error, reason }));
	}

	private port(value: unknown): number
	{
		const n = Number(value);
		if (Number.isInteger(n) && n >= 1 && n <= 65535) {
			return n;
		}
		return 0;
	}

	private string(value: unknown, fallback = ""): string
	{
		if (typeof value === "string") {
			return value;
		}
		return fallback;
	}

	private normalizeIPv6(addr: string): string
	{
		try {
			return new URL(`http://[${addr}]`).hostname.slice(1, -1);
		} catch {
			return "";
		}
	}

	private ips(ws: WebSocket, ipv4Raw: unknown, ipv6Raw: unknown)
	{
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
		if (typeof ipv4Raw === "string" && /^(\d{1,3}\.){3}\d{1,3}$/.test(ipv4Raw) && ipv4Raw.split('.').every(part => Number(part) <= 255)) {
			ips.ipv4 = ipv4Raw;
		}
		if (typeof ipv6Raw === "string" && ipv6Raw.length <= 39 && /^[\da-fA-F:]+$/.test(ipv6Raw)) {
			const ipv6 = this.normalizeIPv6(ipv6Raw);
			if (ipv6) ips.ipv6 = ipv6;
		}
		return ips;
	}

	private getLobbies(): Map<string, WebSocket>
	{
		const lobbies = new Map<string, WebSocket>();
		for (const ws of this.ctx.getWebSockets()) {
			const attachment = ws.deserializeAttachment() as LobbyAttachment | null;
			if (attachment?.lobbyId && attachment.lobby) lobbies.set(attachment.lobbyId, ws);
		}
		return lobbies;
	}

	private listMessage(lobbies: Map<string, WebSocket>): string
	{
		return JSON.stringify({ type: "lobbies", lobbies: Array.from(lobbies, ([id, ws]) => {
			const { directIpv4Port, ...lobby } = (ws.deserializeAttachment() as LobbyAttachment).lobby!;
			return { id, ...lobby };
		}) });
	}

	private broadcast()
	{
		const message = this.listMessage(this.getLobbies());
		for (const client of this.ctx.getWebSockets()) {
			if ((client.deserializeAttachment() as LobbyAttachment | null)?.lobbyId) continue;
			try {
				client.send(message);
			} catch {
				client.close(1011, "Send failed");
			}
		}
	}

	private async notifyDiscord(lobby: Lobby, action: LobbyAction, players: string[] = [], mapName = "", mapNumber = 0)
	{
		if (lobby.name === "test" || !this.env.DISCORD_WEBHOOK_URL) return;
		try {
			const webhookUrl = new URL(this.env.DISCORD_WEBHOOK_URL);
			webhookUrl.searchParams.set("wait", "true");
			const name = escapeDiscordMarkdown(lobby.name || "Unknown");
			let content = `**${name}** opened a lobby (**${escapeDiscordMarkdown(lobby.version || "Unknown")}**)`;
			if (action === "cancelled") content = `**${name}** cancelled their lobby.`;
			if (action === "closed") content = `**${name}** closed their lobby / started the game.`;
			if (action === "disconnected") content = `**${name}**'s lobby was closed because the host disconnected.`;
			if (action === "timed_out") content = `**${name}**'s lobby was closed because it timed out.`;
			if (action === "started") {
				let map = escapeDiscordMarkdown(mapName);
				if (mapName && mapNumber) map = `${map} [${mapNumber}]`;
				if (!mapName && mapNumber) map = `#${mapNumber}`;
				content = `**${name}** started a match`;
				if (players.length) content += `. Players: **${players.map(escapeDiscordMarkdown).join("**, **")}**`;
				if (map) content += `. Map: **${map}**`;
				content += ".";
			}
			const response = await fetch(webhookUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ allowed_mentions: { parse: [] }, content })
			});
			if (!response.ok) console.error(`[Discord] Webhook failed (${response.status}): ${await response.text()}`);
		} catch (error) {
			console.error("[Discord] Webhook failed:", error);
		}
	}

	private dropLobby(ws: WebSocket, action: LobbyAction)
	{
		const attachment = ws.deserializeAttachment() as LobbyAttachment | null;
		if (!attachment?.lobbyId) return;
		ws.serializeAttachment({});
		if (action === "disconnected" && !attachment.lobby?.resultActions) action = "closed";
		if (attachment.lobby && attachment.lobby.phase !== "In-Game") {
			this.ctx.waitUntil(this.notifyDiscord(attachment.lobby, action));
		}
	}

	private metadata(data: RequestData, lobby: Lobby)
	{
		if (data.maxPlayers !== undefined && (!Number.isInteger(data.maxPlayers) || Number(data.maxPlayers) < 1 || Number(data.maxPlayers) > 4)) return false;
		if (data.players !== undefined && (!Array.isArray(data.players) || data.players.length > 4 || data.players.some(player => typeof player !== "string" || !player.length || textEncoder.encode(player).length > 31 || /[\u0000-\u001f]/.test(player)))) return false;
		if (data.joinable !== undefined && typeof data.joinable !== "boolean") return false;
		if (data.phase !== undefined && data.phase !== "Lobby" && data.phase !== "In-Game" && data.phase !== "In-Landview") return false;
		if (data.maxPlayers !== undefined) lobby.maxPlayers = Number(data.maxPlayers);
		if (Array.isArray(data.players)) lobby.players = data.players;
		if (typeof data.joinable === "boolean") lobby.joinable = data.joinable;
		if ((data.phase === "Lobby" || data.phase === "In-Landview") && lobby.phase !== "In-Game") lobby.phase = data.phase;
		if (lobby.phase === "In-Game" || data.phase === "In-Game") lobby.joinable = false;
		return true;
	}

	private onHostMessage(ws: WebSocket, data: RequestData)
	{
		const attachment = ws.deserializeAttachment() as LobbyAttachment | null;
		const lobby = attachment?.lobby;
		if (!lobby || data.id !== attachment.lobbyId) {
			if (data.action === "delete" || data.action === "cancel") {
				return ws.send(JSON.stringify({ type: "deleted", success: false }));
			}
			return this.error(ws, "Invalid lobby owner");
		}
		if (data.action === "delete" || data.action === "cancel") {
			let action: LobbyAction = "closed";
			if (data.action === "cancel") action = "cancelled";
			this.dropLobby(ws, action);
			ws.send(JSON.stringify({ type: "deleted", success: true }));
		} else {
			if (!this.metadata(data, lobby)) return this.error(ws, "Invalid lobby metadata");
			const started = data.action === "game_started" && lobby.phase !== "In-Game";
			if (started) {
				lobby.phase = "In-Game";
				lobby.joinable = false;
			}
			ws.serializeAttachment(attachment);
			if (started) {
				const mapName = this.string(data.mapName).trim().slice(0, 128);
				let mapNumber = Number(data.mapNumber);
				if (!Number.isInteger(mapNumber) || mapNumber <= 0) mapNumber = 0;
				this.ctx.waitUntil(this.notifyDiscord(lobby, "started", lobby.players, mapName, mapNumber));
			}
			if (data.action === "game_started") ws.send(JSON.stringify({ type: "game_started", success: true }));
		}
		this.broadcast();
	}

	async alarm()
	{
		const now = Date.now();
		let nextAlarm = Infinity;
		let removed = 0;
		for (const ws of this.getLobbies().values()) {
			const attachment = ws.deserializeAttachment() as LobbyAttachment;
			if (attachment.expiresAt! <= now) {
				if ((attachment.heartbeatAttempts || 0) >= HEARTBEAT_FAILURE_LIMIT) {
					this.dropLobby(ws, "timed_out");
					ws.close(1000, "Lobby timed out");
					removed++;
					continue;
				}
				try {
					ws.send(JSON.stringify({ type: "ping" }));
				} catch {
					this.dropLobby(ws, "disconnected");
					removed++;
					continue;
				}
				attachment.heartbeatAttempts = (attachment.heartbeatAttempts || 0) + 1;
				attachment.expiresAt = now + HEARTBEAT_TIMEOUT_MS;
				ws.serializeAttachment(attachment);
			}
			nextAlarm = Math.min(nextAlarm, attachment.expiresAt!);
		}
		if (removed) this.broadcast();
		if (nextAlarm !== Infinity) await this.ctx.storage.setAlarm(nextAlarm);
	}

	async fetch(request: Request): Promise<Response>
	{
		const { pathname } = new URL(request.url);
		if (pathname === '/') return new Response('KeeperFX Matchmaking Server');
		if (pathname !== '/ws') return new Response("Not found", { status: 404 });
		if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
		const pair = new WebSocketPair();
		this.ctx.acceptWebSocket(pair[1], [`ip:${request.headers.get("CF-Connecting-IP") || ""}`]);
		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	private async onCreate(ws: WebSocket, data: RequestData)
	{
		const ipv4Port = this.port(data.ipv4Port);
		if (!ipv4Port) return this.error(ws, "Invalid port");
		const lobbies = this.getLobbies();
		if (lobbies.size >= MAX_LOBBIES && !(ws.deserializeAttachment() as LobbyAttachment | null)?.lobbyId) return this.error(ws, "Server full");
		const id = crypto.randomUUID().replace(/-/g, '');
		const { ipv4, ipv6 } = this.ips(ws, data.ipv4, data.ipv6);
		const name = this.string(data.name, "Unknown").slice(0, 64);
		const version = this.string(data.version).trim().slice(0, 32);
		const ipv6Port = this.port(data.ipv6Port) || ipv4Port;
		const directIpv4Port = this.port(data.directIpv4Port);
		const resultActions = data.resultActions === true;
		const lobby: Lobby = { name, ipv4, ipv6, ipv4Port, ipv6Port, directIpv4Port, version, resultActions, createdAt: Date.now() };
		if (!this.metadata(data, lobby)) return this.error(ws, "Invalid lobby metadata");
		this.dropLobby(ws, "cancelled");
		ws.serializeAttachment({ lobbyId: id, lobby, expiresAt: Date.now() + HEARTBEAT_INTERVAL_MS });
		ws.send(JSON.stringify({ type: "created", id }));
		this.broadcast();
		this.ctx.waitUntil(this.notifyDiscord(lobby, "opened"));
		await this.ctx.storage.setAlarm(Date.now());
	}

	private onPunch(ws: WebSocket, data: RequestData)
	{
		const ipv4Port = this.port(data.myIpv4Port);
		const ipv6Port = this.port(data.myIpv6Port);
		if (!ipv4Port && !ipv6Port) return this.error(ws, "Invalid udpPort");
		const hostWs = this.getLobbies().get(this.string(data.lobbyId));
		if (!hostWs) return this.error(ws, "Lobby not found");
		const lobby = (hostWs.deserializeAttachment() as LobbyAttachment).lobby!;
		const version = this.string(data.version).trim().split(/\s+/, 1)[0];
		const hostVersion = lobby.version.trim().split(/\s+/, 1)[0];
		if (version && hostVersion && version !== hostVersion) return this.error(ws, "The host is using a different game version.", NetJoinRejection.Version);
		if (lobby.phase === "In-Game") return this.error(ws, "Game has already started.", NetJoinRejection.InGame);
		if (lobby.joinable === false) return this.error(ws, "Joining is temporarily locked.", NetJoinRejection.Locked);
		if (lobby.players && lobby.maxPlayers && lobby.players.length >= lobby.maxPlayers) return this.error(ws, "Lobby is full.", NetJoinRejection.Full);
		if (hostWs === ws) return this.error(ws, "Host not connected");
		const joiner = this.ips(ws, data.myIpv4, data.myIpv6);
		if (!ipv4Port) joiner.ipv4 = "";
		if (!ipv6Port) joiner.ipv6 = "";
		try {
			hostWs.send(JSON.stringify({ type: "punch", peerIpv4: joiner.ipv4, peerIpv6: joiner.ipv6, peerIpv4Port: ipv4Port, peerIpv6Port: ipv6Port }));
		} catch {
			this.dropLobby(hostWs, "disconnected");
			this.broadcast();
			return this.error(ws, "Lobby not found");
		}
		const response: Record<string, unknown> = { type: "punch", peerIpv4: lobby.ipv4, peerIpv6: lobby.ipv6, peerIpv4Port: lobby.ipv4Port, peerIpv6Port: lobby.ipv6Port };
		if (lobby.directIpv4Port) response.peerDirectIpv4Port = lobby.directIpv4Port;
		ws.send(JSON.stringify(response));
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer)
	{
		if (typeof message !== "string") return;
		let data: RequestData;
		try {
			data = JSON.parse(message);
		} catch {
			return this.error(ws, "Invalid JSON");
		}
		if (!data || typeof data !== "object" || Array.isArray(data) || typeof data.action !== "string") return this.error(ws, "Invalid request");
		try {
			const attachment = ws.deserializeAttachment() as LobbyAttachment | null;
			if (attachment?.lobby) {
				attachment.expiresAt = Date.now() + HEARTBEAT_INTERVAL_MS;
				attachment.heartbeatAttempts = 0;
				ws.serializeAttachment(attachment);
			}
			switch (data.action) {
				case "pong":
					return;
				case "ping":
					if (!attachment?.lobby) return this.error(ws, "Host not connected");
					return ws.send(JSON.stringify({ type: "pong" }));
				case "list":
					ws.send(this.listMessage(this.getLobbies()));
					return;
				case "create":
					return await this.onCreate(ws, data);
				case "delete":
				case "cancel":
				case "game_started":
				case "update":
					return this.onHostMessage(ws, data);
				case "punch":
					return this.onPunch(ws, data);
				default:
					return this.error(ws, "Unknown action");
			}
		} catch (error) {
			console.error("[WS] Error in webSocketMessage:", error);
			this.error(ws, "Internal server error");
		}
	}

	webSocketClose(ws: WebSocket)
	{
		this.dropLobby(ws, "disconnected");
		ws.close();
		this.broadcast();
	}

	webSocketError(ws: WebSocket)
	{
		this.dropLobby(ws, "disconnected");
		this.broadcast();
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response>
	{
		const { pathname } = new URL(request.url);
		if (pathname === '/ip') return new Response(request.headers.get("CF-Connecting-IP") || "");
		return env.LOBBY_REGISTRY.getByName('global').fetch(request);
	}
} satisfies ExportedHandler<Env>;
