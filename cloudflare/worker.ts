import { DurableObject } from "cloudflare:workers";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

const DOC_STATE_KEY = "doc-state";
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_ACCESS = 4;
const WEBSOCKET_READY_STATE_OPEN = 1;
const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_LOGIN_SCOPE = "read:user";
const GITHUB_SESSION_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

type ConnectionMeta = {
  controlledIds: number[];
  canEdit: boolean;
  githubLogin?: string;
  deniedReason?: string;
};

type JsonRecord = Record<string, unknown>;

type DurableObjectEnv = {
  ROOMS: DurableObjectNamespace;
  GITHUB_CLIENT_ID?: string;
  GITHUB_SESSION_SECRET?: string;
};

type GithubSessionTokenPayload = {
  v: 1;
  iat: number;
  exp: number;
  user: {
    login: string;
    id: number;
    name: string | null;
    htmlUrl: string;
    avatarUrl: string | null;
  };
};

type VerifiedGithubSession =
  | {
      ok: true;
      expiresAt: string;
      user: {
        login: string;
        id: number;
        name: string | null;
        htmlUrl: string;
        avatarUrl: string | null;
      };
    }
  | {
      ok: false;
      reason: string;
    };

type AuthorizedConnection = {
  canEdit: boolean;
  deniedReason?: string;
  githubLogin?: string;
};

function getRoomName(pathname: string) {
  return decodeURIComponent(pathname.replace(/^\/+/, ""));
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBoolean(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);

  headers.set("cache-control", "no-store");
  headers.set("content-type", "application/json; charset=utf-8");

  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
}

function errorResponse(status: number, message: string) {
  return jsonResponse({ error: message }, { status });
}

function methodNotAllowed(methods: string[]) {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: {
      allow: methods.join(", "),
    },
  });
}

function extractErrorMessage(payload: unknown, fallback: string) {
  if (!isRecord(payload)) {
    return fallback;
  }

  const message = readString(payload.message);
  const errorDescription = readString(payload.error_description);
  const error = readString(payload.error);

  return message ?? errorDescription ?? error ?? fallback;
}

async function readJsonResponse(response: Response, sourceName: string) {
  const text = await response.text();

  if (text.trim().length === 0) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${sourceName} returned a non-JSON response with status ${response.status}.`);
  }
}

async function postGithubForm(body: URLSearchParams) {
  const response = await fetch(GITHUB_ACCESS_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "pixel-game-worker",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    },
    body,
  });
  const payload = await readJsonResponse(response, "GitHub");

  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, `GitHub request failed with status ${response.status}.`));
  }

  return payload;
}

async function requestGithubDeviceCode(clientId: string) {
  const response = await fetch(GITHUB_DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "pixel-game-worker",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    },
    body: new URLSearchParams({
      client_id: clientId,
      scope: GITHUB_LOGIN_SCOPE,
    }),
  });
  const payload = await readJsonResponse(response, "GitHub");

  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, `GitHub request failed with status ${response.status}.`));
  }

  return payload;
}

async function fetchGithubUser(accessToken: string) {
  const response = await fetch(GITHUB_USER_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "pixel-game-worker",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    },
  });
  const payload = await readJsonResponse(response, "GitHub");

  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, `GitHub user request failed with status ${response.status}.`));
  }

  if (!isRecord(payload)) {
    throw new Error("GitHub user response was invalid.");
  }

  const login = readString(payload.login);
  const id = readNumber(payload.id);
  const htmlUrl = readString(payload.html_url);

  if (!login || id === null || !htmlUrl) {
    throw new Error("GitHub user response was missing required fields.");
  }

  return {
    login,
    id,
    name: typeof payload.name === "string" ? payload.name : null,
    htmlUrl,
    avatarUrl: typeof payload.avatar_url === "string" ? payload.avatar_url : null,
  };
}

function toBase64Url(value: Uint8Array | ArrayBuffer) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";

  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const paddingLength = (4 - (normalized.length % 4 || 4)) % 4;
  const binary = atob(`${normalized}${"=".repeat(paddingLength)}`);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

async function importGithubSessionKey(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["sign", "verify"],
  );
}

function normalizeGithubSessionTokenPayload(value: unknown): GithubSessionTokenPayload | null {
  if (!isRecord(value)) {
    return null;
  }

  const version = readNumber(value.v);
  const issuedAt = readNumber(value.iat);
  const expiresAt = readNumber(value.exp);
  const user = isRecord(value.user) ? value.user : null;

  if (version !== 1 || issuedAt === null || expiresAt === null || !user) {
    return null;
  }

  const login = readString(user.login);
  const id = readNumber(user.id);
  const htmlUrl = readString(user.htmlUrl);
  const name = readOptionalString(user.name);
  const avatarUrl = readOptionalString(user.avatarUrl);

  if (!login || id === null || !htmlUrl) {
    return null;
  }

  return {
    v: 1,
    iat: issuedAt,
    exp: expiresAt,
    user: {
      login,
      id,
      name,
      htmlUrl,
      avatarUrl,
    },
  };
}

function readOptionalString(value: unknown) {
  return typeof value === "string" ? value : null;
}

async function createGithubSessionToken(secret: string, user: Awaited<ReturnType<typeof fetchGithubUser>>) {
  const payload: GithubSessionTokenPayload = {
    v: 1,
    iat: Date.now(),
    exp: Date.now() + GITHUB_SESSION_TOKEN_TTL_MS,
    user,
  };
  const payloadBytes = textEncoder.encode(JSON.stringify(payload));
  const signature = await crypto.subtle.sign("HMAC", await importGithubSessionKey(secret), payloadBytes);

  return {
    token: `${toBase64Url(payloadBytes)}.${toBase64Url(signature)}`,
    expiresAt: new Date(payload.exp).toISOString(),
  };
}

async function verifyGithubSessionToken(secret: string, token: string): Promise<VerifiedGithubSession> {
  const [payloadSegment, signatureSegment, extraSegment] = token.split(".");

  if (!payloadSegment || !signatureSegment || extraSegment) {
    return {
      ok: false,
      reason: "Stored GitHub login is invalid for this server. Run pxboard login again.",
    };
  }

  let payloadBytes: Uint8Array;
  let signatureBytes: Uint8Array;

  try {
    payloadBytes = fromBase64Url(payloadSegment);
    signatureBytes = fromBase64Url(signatureSegment);
  } catch {
    return {
      ok: false,
      reason: "Stored GitHub login is invalid for this server. Run pxboard login again.",
    };
  }

  const isValid = await crypto.subtle.verify(
    "HMAC",
    await importGithubSessionKey(secret),
    signatureBytes,
    payloadBytes,
  );

  if (!isValid) {
    return {
      ok: false,
      reason: "Stored GitHub login is invalid for this server. Run pxboard login again.",
    };
  }

  let payload: GithubSessionTokenPayload | null;

  try {
    payload = normalizeGithubSessionTokenPayload(JSON.parse(textDecoder.decode(payloadBytes)) as unknown);
  } catch {
    payload = null;
  }

  if (!payload) {
    return {
      ok: false,
      reason: "Stored GitHub login is invalid for this server. Run pxboard login again.",
    };
  }

  if (payload.exp <= Date.now()) {
    return {
      ok: false,
      reason: "Stored GitHub login expired. Run pxboard login again.",
    };
  }

  return {
    ok: true,
    expiresAt: new Date(payload.exp).toISOString(),
    user: payload.user,
  };
}

function resolveConnectionAccess(request: Request, env: DurableObjectEnv): Promise<AuthorizedConnection> {
  const token = readString(new URL(request.url).searchParams.get("github_auth"));
  const sessionSecret = readString(env.GITHUB_SESSION_SECRET);

  if (!token || !sessionSecret) {
    return Promise.resolve({
      canEdit: true,
    });
  }

  return verifyGithubSessionToken(sessionSecret, token).then((result) => {
    if (!result.ok) {
      return {
        canEdit: true,
      };
    }

    return {
      canEdit: true,
      githubLogin: result.user.login,
    };
  });
}

async function handleGithubDeviceAuth(request: Request, env: DurableObjectEnv) {
  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }

  const clientId = readString(env.GITHUB_CLIENT_ID);
  const sessionSecret = readString(env.GITHUB_SESSION_SECRET);

  if (!clientId) {
    return errorResponse(503, "GitHub login is not configured on this worker.");
  }

  if (!sessionSecret) {
    return errorResponse(503, "GitHub edit auth is not configured on this worker.");
  }

  try {
    return jsonResponse(await requestGithubDeviceCode(clientId));
  } catch (error) {
    console.error("Failed to start GitHub device login", error);
    return errorResponse(502, (error as Error).message);
  }
}

async function handleGithubPoll(request: Request, env: DurableObjectEnv) {
  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }

  const clientId = readString(env.GITHUB_CLIENT_ID);
  const sessionSecret = readString(env.GITHUB_SESSION_SECRET);

  if (!clientId) {
    return errorResponse(503, "GitHub login is not configured on this worker.");
  }

  if (!sessionSecret) {
    return errorResponse(503, "GitHub edit auth is not configured on this worker.");
  }

  const payload = await request.json<unknown>().catch(() => null);
  const deviceCode = isRecord(payload) ? readString(payload.deviceCode) : null;

  if (!deviceCode) {
    return errorResponse(400, "deviceCode is required.");
  }

  try {
    const tokenPayload = await postGithubForm(
      new URLSearchParams({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    );

    if (isRecord(tokenPayload)) {
      const error = readString(tokenPayload.error);

      if (error) {
        return jsonResponse({
          status: error === "expired_token" ? "expired" : "pending",
          error,
          description: readString(tokenPayload.error_description) ?? undefined,
        });
      }

      const accessToken = readString(tokenPayload.access_token);

      if (!accessToken) {
        throw new Error("GitHub access token response was missing required fields.");
      }

      const user = await fetchGithubUser(accessToken);
      const sessionToken = await createGithubSessionToken(sessionSecret, user);

      return jsonResponse({
        status: "authorized",
        user,
        sessionToken: sessionToken.token,
        sessionExpiresAt: sessionToken.expiresAt,
      });
    }

    throw new Error("GitHub access token response was invalid.");
  } catch (error) {
    console.error("Failed to poll GitHub device login", error);
    return errorResponse(502, (error as Error).message);
  }
}

function createConnectionMeta({
  controlledIds = [],
  canEdit = false,
  githubLogin,
  deniedReason,
}: Partial<ConnectionMeta> = {}): ConnectionMeta {
  return {
    controlledIds: Array.from(controlledIds),
    canEdit,
    githubLogin: readString(githubLogin) ?? undefined,
    deniedReason: readString(deniedReason) ?? undefined,
  };
}

function normalizeConnectionMeta(value: unknown): ConnectionMeta {
  if (!isRecord(value)) {
    return createConnectionMeta();
  }

  const controlledIds = Array.isArray(value.controlledIds)
    ? value.controlledIds.filter((id): id is number => typeof id === "number" && Number.isInteger(id))
    : [];

  return createConnectionMeta({
    controlledIds,
    canEdit: readBoolean(value.canEdit) ?? false,
    githubLogin: readString(value.githubLogin) ?? undefined,
    deniedReason: readString(value.deniedReason) ?? undefined,
  });
}

function normalizeBinaryMessage(message: ArrayBuffer | ArrayBufferView) {
  if (message instanceof ArrayBuffer) {
    return new Uint8Array(message);
  }

  return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
}

function normalizeStoredUpdate(update: ArrayBuffer | Uint8Array | null | undefined) {
  if (!update) {
    return null;
  }

  return update instanceof Uint8Array ? update : new Uint8Array(update);
}

export default {
  async fetch(request: Request, env: DurableObjectEnv) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("Pixel Game collaboration worker is running.\nConnect via /<room> using WebSocket.", {
        headers: {
          "content-type": "text/plain; charset=utf-8",
        },
      });
    }

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "pixel-game-collaboration",
        date: new Date().toISOString(),
      });
    }

    if (url.pathname === "/auth/github/device") {
      return handleGithubDeviceAuth(request, env);
    }

    if (url.pathname === "/auth/github/poll") {
      return handleGithubPoll(request, env);
    }

    const roomName = getRoomName(url.pathname);

    if (!roomName) {
      return new Response("Room name is required.", { status: 400 });
    }

    const id = env.ROOMS.idFromName(roomName);
    const stub = env.ROOMS.get(id);
    return stub.fetch(request);
  },
};

export class PixelRoom extends DurableObject {
  private readonly ctx: DurableObjectState;
  private readonly env: DurableObjectEnv;
  private readonly doc = new Y.Doc();
  private readonly awareness = new awarenessProtocol.Awareness(this.doc);
  private readonly connections = new Map<WebSocket, ConnectionMeta>();
  private readonly ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: DurableObjectEnv) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.awareness.setLocalState(null);
    this.ready = this.ctx.blockConcurrencyWhile(async () => {
      const storedUpdate = normalizeStoredUpdate(await this.ctx.storage.get<ArrayBuffer | Uint8Array>(DOC_STATE_KEY));

      if (storedUpdate) {
        Y.applyUpdate(this.doc, storedUpdate, "storage");
      }

      for (const socket of this.ctx.getWebSockets()) {
        const attachment = normalizeConnectionMeta(socket.deserializeAttachment() ?? createConnectionMeta());
        this.connections.set(socket, attachment);
      }

      this.attachListeners();
    });
  }

  async fetch(request: Request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Pixel room is ready.", { status: 200 });
    }

    const [client, server] = Object.values(new WebSocketPair());
    const connectionMeta = createConnectionMeta(await resolveConnectionAccess(request, this.env));

    this.connections.set(server, connectionMeta);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(connectionMeta);

    await this.ready;
    this.sendInitialSync(server, connectionMeta);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(socket: WebSocket, message: ArrayBuffer | ArrayBufferView | string) {
    await this.ready;

    if (typeof message === "string") {
      return;
    }

    try {
      const encoder = encoding.createEncoder();
      const decoder = decoding.createDecoder(normalizeBinaryMessage(message));
      const messageType = decoding.readVarUint(decoder);
      const connectionMeta = this.connections.get(socket) ?? createConnectionMeta();

      switch (messageType) {
        case MESSAGE_SYNC: {
          encoding.writeVarUint(encoder, MESSAGE_SYNC);
          const syncMessageType = decoding.readVarUint(decoder);

          if (syncMessageType === syncProtocol.messageYjsSyncStep1) {
            syncProtocol.readSyncStep1(decoder, encoder, this.doc);

            if (encoding.length(encoder) > 1) {
              this.send(socket, encoding.toUint8Array(encoder));
            }

            break;
          }

          if (!connectionMeta.canEdit) {
            this.sendAccessStatus(socket, connectionMeta);
            break;
          }

          if (syncMessageType === syncProtocol.messageYjsSyncStep2) {
            syncProtocol.readSyncStep2(decoder, this.doc, socket);
            break;
          }

          if (syncMessageType === syncProtocol.messageYjsUpdate) {
            syncProtocol.readUpdate(decoder, this.doc, socket);
            break;
          }

          socket.close(1003, "Unsupported sync message type");
          break;
        }
        case MESSAGE_AWARENESS:
          awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), socket);
          break;
        default:
          socket.close(1003, "Unsupported message type");
      }
    } catch (error) {
      console.error("Failed to process websocket message", error);
      socket.close(1011, "Internal error");
    }
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string) {
    await this.ready;
    this.removeConnection(socket);
    try {
      socket.close(code, reason);
    } catch {}
  }

  async webSocketError(socket: WebSocket) {
    await this.ready;
    this.removeConnection(socket);
  }

  private attachListeners() {
    this.doc.on("update", (update) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      const message = encoding.toUint8Array(encoder);

      for (const socket of this.connections.keys()) {
        this.send(socket, message);
      }

      void this.persistDocState();
    });

    this.awareness.on("update", ({ added, updated, removed }, origin) => {
      if (origin instanceof WebSocket) {
        const connectionMeta = this.connections.get(origin);

        if (connectionMeta) {
          for (const clientId of added) {
            if (!connectionMeta.controlledIds.includes(clientId)) {
              connectionMeta.controlledIds.push(clientId);
            }
          }

          for (const clientId of removed) {
            connectionMeta.controlledIds = connectionMeta.controlledIds.filter((id) => id !== clientId);
          }

          origin.serializeAttachment(createConnectionMeta(connectionMeta));
        }
      }

      const changedClients = added.concat(updated, removed);

      if (changedClients.length === 0) {
        return;
      }

      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients),
      );
      const message = encoding.toUint8Array(encoder);

      for (const socket of this.connections.keys()) {
        this.send(socket, message);
      }
    });
  }

  private async persistDocState() {
    await this.ctx.storage.put(DOC_STATE_KEY, Y.encodeStateAsUpdate(this.doc));
  }

  private sendInitialSync(socket: WebSocket, connectionMeta: ConnectionMeta) {
    const syncEncoder = encoding.createEncoder();
    encoding.writeVarUint(syncEncoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(syncEncoder, this.doc);
    this.send(socket, encoding.toUint8Array(syncEncoder));
    this.sendAccessStatus(socket, connectionMeta);

    const awarenessStates = this.awareness.getStates();

    if (awarenessStates.size === 0) {
      return;
    }

    const awarenessEncoder = encoding.createEncoder();
    encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      awarenessEncoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, Array.from(awarenessStates.keys())),
    );
    this.send(socket, encoding.toUint8Array(awarenessEncoder));
  }

  private removeConnection(socket: WebSocket) {
    const connectionMeta = this.connections.get(socket);

    if (connectionMeta && connectionMeta.controlledIds.length > 0) {
      awarenessProtocol.removeAwarenessStates(this.awareness, connectionMeta.controlledIds, null);
    }

    this.connections.delete(socket);
  }

  private sendAccessStatus(socket: WebSocket, connectionMeta: ConnectionMeta) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_ACCESS);
    encoding.writeVarUint(encoder, connectionMeta.canEdit ? 1 : 0);
    encoding.writeVarString(encoder, connectionMeta.deniedReason ?? "");
    this.send(socket, encoding.toUint8Array(encoder));
  }

  private send(socket: WebSocket, message: Uint8Array) {
    if (socket.readyState !== WEBSOCKET_READY_STATE_OPEN) {
      this.removeConnection(socket);
      return;
    }

    try {
      socket.send(message);
    } catch (error) {
      console.error("Failed to send websocket message", error);
      this.removeConnection(socket);
      try {
        socket.close(1011, "Send failed");
      } catch {}
    }
  }
}
