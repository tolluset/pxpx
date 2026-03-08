import { DurableObject } from "cloudflare:workers";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { FAVICON_SVG, getFaviconIcoBytes } from "./favicon";

const DOC_STATE_KEY = "doc-state";
const ROOM_ACCESS_POLICY_KEY = "room-access-policy";
const ROOM_DECORATION_VERSION_KEY = "room-decoration-version";
const INITIAL_BOARD_WIDTH = 16;
const INITIAL_BOARD_HEIGHT = 16;
const MAX_PAINT_LOG_ENTRIES = 200;
const MAX_API_COORDINATE = 4095;
const REPOSITORY_ROOM_DECORATION_VERSION = 2;
const REPOSITORY_ROOM_DECORATION_BOARD_WIDTH = 40;
const REPOSITORY_ROOM_DECORATION_BOARD_HEIGHT = 24;
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_ACCESS = 4;
const WEBSOCKET_READY_STATE_OPEN = 1;
const ROOM_RESET_INTERNAL_PATH = "/__admin/reset";
const ROOM_ACCESS_INTERNAL_PATH = "/__admin/access";
const ROOM_ACCESS_EDITORS_INTERNAL_PATH = "/__admin/access/editors";
const ROOM_PIXELS_INTERNAL_PATH = "/__api/pixels";
const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_LOGIN_SCOPE = "read:user";
const GITHUB_SESSION_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const PALETTE_COLOR_IDS = new Set(["rose", "amber", "lime", "emerald", "sky", "violet", "pink", "slate"]);
const DECORATION_COLOR_IDS = ["rose", "amber", "lime", "emerald", "sky", "violet", "pink"];

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

type RepositoryAccessMode = "open" | "owner_allowlist";
type RepositoryAccessRole = "open" | "owner" | "editor" | "viewer";

type ConnectionMeta = {
  controlledIds: number[];
  canEdit: boolean;
  githubLogin?: string;
  deniedReason?: string;
  accessMode?: RepositoryAccessMode;
  role?: RepositoryAccessRole;
  ownerLogin?: string;
  repoSlug?: string;
  collaboratorCount?: number;
};

type JsonRecord = Record<string, unknown>;

type DurableObjectEnv = {
  ROOMS: DurableObjectNamespace<PixelRoom>;
  GITHUB_USERS: DurableObjectNamespace<GithubUserRegistry>;
  GITHUB_CLIENT_ID?: string;
  GITHUB_SESSION_SECRET?: string;
  ROOM_RESET_TOKEN?: string;
};

type GithubUser = GithubSessionTokenPayload["user"];

type PersistedGithubUser = GithubUser & {
  provider: "github";
  createdAt: string;
  updatedAt: string;
  firstAuthenticatedAt: string;
  lastAuthenticatedAt: string;
  loginCount: number;
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
  accessMode?: RepositoryAccessMode;
  role?: RepositoryAccessRole;
  ownerLogin?: string;
  repoSlug?: string;
  collaboratorCount?: number;
};

type GithubAuthResolution =
  | {
      ok: true;
      user: GithubUser;
    }
  | {
      ok: false;
      reason: string;
      status: "missing" | "invalid" | "unconfigured";
    };

type RepositoryRoom = {
  roomName: string;
  repoSlug: string;
  ownerLogin: string;
  repoName: string;
};

type RepositoryAccessPolicy = {
  v: 1;
  mode: RepositoryAccessMode;
  repoSlug: string;
  ownerLogin: string;
  editors: string[];
  createdAt: string;
  updatedAt: string;
};

type AwarenessUpdateEvent = {
  added: number[];
  updated: number[];
  removed: number[];
};

type DecorationCell = {
  x: number;
  y: number;
  color: string;
};

function getRoomName(pathname: string) {
  return decodeURIComponent(pathname.replace(/^\/+/, ""));
}

function getRoomResetPathRoomName(pathname: string) {
  const match = pathname.match(/^\/admin\/rooms\/(.+)\/reset$/);

  if (!match) {
    return null;
  }

  return readString(decodeURIComponent(match[1]));
}

function getRoomAccessPathRoomName(pathname: string) {
  const match = pathname.match(/^\/admin\/rooms\/(.+)\/access$/);

  if (!match) {
    return null;
  }

  return readString(decodeURIComponent(match[1]));
}

function getRoomAccessEditorsPath(pathname: string) {
  const match = pathname.match(/^\/admin\/rooms\/(.+)\/access\/editors(?:\/([^/]+))?$/);

  if (!match) {
    return null;
  }

  return {
    roomName: readString(decodeURIComponent(match[1])),
    githubLogin: match[2] ? readString(decodeURIComponent(match[2])) : undefined,
  };
}

function getRoomPixelsPathRoomName(pathname: string) {
  const match = pathname.match(/^\/api\/rooms\/(.+)\/pixels$/);

  if (!match) {
    return null;
  }

  return readString(decodeURIComponent(match[1]));
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function normalizeGithubLogin(value: string) {
  const normalized = value.trim().replace(/^@/, "").toLowerCase();

  if (!/^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(normalized)) {
    return null;
  }

  return normalized;
}

function normalizeRepositoryName(value: string) {
  const normalized = value.trim().toLowerCase();

  if (!/^[a-z\d._-]+$/i.test(normalized)) {
    return null;
  }

  return normalized;
}

function parseRepositoryRoomName(roomName: string): RepositoryRoom | null {
  const segments = roomName
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter((segment) => segment.length > 0);

  if (segments.length !== 2) {
    return null;
  }

  const ownerLogin = normalizeGithubLogin(segments[0]);
  const repoName = normalizeRepositoryName(segments[1]);

  if (!ownerLogin || !repoName) {
    return null;
  }

  return {
    roomName,
    ownerLogin,
    repoName,
    repoSlug: `${ownerLogin}/${repoName}`,
  };
}

function readBearerToken(authorizationHeader: string | null) {
  if (!authorizationHeader) {
    return null;
  }

  const [scheme, token, extra] = authorizationHeader.trim().split(/\s+/);

  if (scheme?.toLowerCase() !== "bearer" || !token || extra) {
    return null;
  }

  return token;
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
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

function staticAssetResponse(body: BodyInit | null, contentType: string) {
  return new Response(body, {
    headers: {
      "cache-control": "public, max-age=86400, stale-while-revalidate=604800",
      "content-type": contentType,
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

  const user = normalizeGithubUser(payload);

  if (!user) {
    throw new Error("GitHub user response was missing required fields.");
  }

  return user;
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

  const normalizedUser = normalizeGithubUser(user);

  if (!normalizedUser) {
    return null;
  }

  return {
    v: 1,
    iat: issuedAt,
    exp: expiresAt,
    user: normalizedUser,
  };
}

function readOptionalString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function normalizeHexColor(value: string | undefined) {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(normalized) ? normalized : null;
}

function normalizePixelColorValue(value: unknown) {
  const raw = readString(value);

  if (!raw) {
    return null;
  }

  const normalizedPaletteId = raw.trim().toLowerCase();

  if (PALETTE_COLOR_IDS.has(normalizedPaletteId)) {
    return normalizedPaletteId;
  }

  return normalizeHexColor(raw);
}

function normalizePlayerName(value: unknown) {
  const normalized = readString(value)?.trim();

  if (!normalized) {
    return null;
  }

  return normalized.slice(0, 40);
}

function createPaintLogEntry(options: {
  x: number;
  y: number;
  colorId: string;
  playerName: string;
  githubLogin?: string;
}) {
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    x: options.x,
    y: options.y,
    colorId: options.colorId,
    playerName: options.playerName,
    githubLogin: options.githubLogin,
  };
}

function hashString(value: string) {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function pickDecorationColors(repositoryRoom: RepositoryRoom) {
  const hash = hashString(repositoryRoom.repoSlug);
  const colors: string[] = [];

  for (let index = 0; colors.length < 3; index += 1) {
    const color = DECORATION_COLOR_IDS[(hash + index * 3) % DECORATION_COLOR_IDS.length];

    if (!colors.includes(color)) {
      colors.push(color);
    }
  }

  return {
    primary: colors[0],
    secondary: colors[1],
    accent: colors[2],
    neutral: "slate",
  };
}

function pushDecorationCells(
  cells: DecorationCell[],
  originX: number,
  originY: number,
  points: Array<[number, number]>,
  color: string,
  options: { mirrorX?: boolean; mirrorY?: boolean } = {},
) {
  for (const [rawX, rawY] of points) {
    cells.push({
      x: options.mirrorX ? originX - rawX : originX + rawX,
      y: options.mirrorY ? originY - rawY : originY + rawY,
      color,
    });
  }
}

function createRepositoryDecorationCells(repositoryRoom: RepositoryRoom) {
  const cells: DecorationCell[] = [];
  const { primary, secondary, accent, neutral } = pickDecorationColors(repositoryRoom);
  const hash = hashString(repositoryRoom.repoSlug);
  const slashYOffset = hash % 3;
  const sparkleOffset = hash % 5;
  const cornerFramePoints: Array<[number, number]> = [
    [0, 0],
    [1, 0],
    [2, 0],
    [0, 1],
    [0, 2],
  ];
  const cornerAccentPoints: Array<[number, number]> = [
    [1, 1],
    [2, 1],
  ];
  const slashPoints: Array<[number, number]> = [
    [0, 3],
    [1, 2],
    [2, 1],
    [3, 0],
    [4, 1],
    [5, 2],
    [6, 3],
    [7, 4],
  ];
  const shadowPoints: Array<[number, number]> = [
    [0, 4],
    [3, 1],
    [6, 4],
    [7, 5],
  ];
  const sparkles: Array<[number, number]> = [
    [10 + sparkleOffset, 4],
    [16, 2 + slashYOffset],
    [24, 18 - slashYOffset],
    [30 - sparkleOffset, 15],
  ];

  pushDecorationCells(cells, 2, 2, cornerFramePoints, primary);
  pushDecorationCells(cells, 2, 2, cornerAccentPoints, accent);
  pushDecorationCells(cells, REPOSITORY_ROOM_DECORATION_BOARD_WIDTH - 3, 2, cornerFramePoints, secondary, {
    mirrorX: true,
  });
  pushDecorationCells(cells, REPOSITORY_ROOM_DECORATION_BOARD_WIDTH - 3, 2, cornerAccentPoints, accent, {
    mirrorX: true,
  });
  pushDecorationCells(cells, 2, REPOSITORY_ROOM_DECORATION_BOARD_HEIGHT - 3, cornerFramePoints, secondary, {
    mirrorY: true,
  });
  pushDecorationCells(cells, 2, REPOSITORY_ROOM_DECORATION_BOARD_HEIGHT - 3, cornerAccentPoints, accent, {
    mirrorY: true,
  });
  pushDecorationCells(
    cells,
    REPOSITORY_ROOM_DECORATION_BOARD_WIDTH - 3,
    REPOSITORY_ROOM_DECORATION_BOARD_HEIGHT - 3,
    cornerFramePoints,
    primary,
    {
      mirrorX: true,
      mirrorY: true,
    },
  );
  pushDecorationCells(
    cells,
    REPOSITORY_ROOM_DECORATION_BOARD_WIDTH - 3,
    REPOSITORY_ROOM_DECORATION_BOARD_HEIGHT - 3,
    cornerAccentPoints,
    accent,
    {
      mirrorX: true,
      mirrorY: true,
    },
  );
  pushDecorationCells(cells, 16, 9 + slashYOffset, slashPoints, accent);
  pushDecorationCells(cells, 16, 9 + slashYOffset, shadowPoints, neutral);

  for (const [x, y] of sparkles) {
    cells.push({
      x,
      y,
      color: (x + y + hash) % 2 === 0 ? primary : secondary,
    });
  }

  return cells.filter(
    (cell, index, source) =>
      cell.x >= 0 &&
      cell.y >= 0 &&
      cell.x < REPOSITORY_ROOM_DECORATION_BOARD_WIDTH &&
      cell.y < REPOSITORY_ROOM_DECORATION_BOARD_HEIGHT &&
      source.findIndex((candidate) => candidate.x === cell.x && candidate.y === cell.y) === index,
  );
}

function normalizeGithubUser(value: unknown): GithubUser | null {
  if (!isRecord(value)) {
    return null;
  }

  const login = readString(value.login);
  const id = readNumber(value.id);
  const htmlUrl = readString(value.htmlUrl) ?? readString(value.html_url);

  if (!login || id === null || !htmlUrl) {
    return null;
  }

  return {
    login,
    id,
    name: readOptionalString(value.name),
    htmlUrl,
    avatarUrl: readOptionalString(value.avatarUrl) ?? readOptionalString(value.avatar_url),
  };
}

function getGithubUserStorageKey(id: number) {
  return `github-user:${id}`;
}

function getGithubUserLoginIndexKey(login: string) {
  return `github-user-login:${login.toLowerCase()}`;
}

async function persistGithubUser(env: DurableObjectEnv, user: GithubUser) {
  const id = env.GITHUB_USERS.idFromName("github-users");
  const stub = env.GITHUB_USERS.get(id);
  const response = await stub.fetch("https://github-users/internal/upsert", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(user),
  });
  const payload = await readJsonResponse(response, "GitHub user registry");

  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, `GitHub user registry request failed with status ${response.status}.`));
  }

  return payload;
}

function readGithubSessionToken(request: Request) {
  return readString(new URL(request.url).searchParams.get("github_auth")) ?? readBearerToken(request.headers.get("authorization"));
}

async function resolveGithubAuth(request: Request, env: DurableObjectEnv): Promise<GithubAuthResolution> {
  const sessionSecret = readString(env.GITHUB_SESSION_SECRET);

  if (!sessionSecret) {
    return {
      ok: false,
      status: "unconfigured",
      reason: "GitHub access control is not configured on this worker.",
    };
  }

  const token = readGithubSessionToken(request);

  if (!token) {
    return {
      ok: false,
      status: "missing",
      reason: "Run `pxboard login` to verify your GitHub identity.",
    };
  }

  const verification = await verifyGithubSessionToken(sessionSecret, token);

  if (verification.ok === false) {
    return {
      ok: false,
      status: "invalid",
      reason: verification.reason,
    };
  }

  return {
    ok: true,
    user: verification.user,
  };
}

function createDefaultRepositoryAccessPolicy(repositoryRoom: RepositoryRoom, now = new Date().toISOString()): RepositoryAccessPolicy {
  return {
    v: 1,
    mode: "open",
    repoSlug: repositoryRoom.repoSlug,
    ownerLogin: repositoryRoom.ownerLogin,
    editors: [],
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeRepositoryAccessMode(value: unknown): RepositoryAccessMode | null {
  return value === "open" || value === "owner_allowlist" ? value : null;
}

function normalizeRepositoryAccessPolicy(
  value: unknown,
  repositoryRoom: RepositoryRoom,
): RepositoryAccessPolicy {
  const fallback = createDefaultRepositoryAccessPolicy(repositoryRoom);

  if (!isRecord(value)) {
    return fallback;
  }

  const mode = normalizeRepositoryAccessMode(value.mode) ?? fallback.mode;
  const editors = Array.isArray(value.editors)
    ? Array.from(
        new Set(
          value.editors
            .map((editor) => (typeof editor === "string" ? normalizeGithubLogin(editor) : null))
            .filter((editor): editor is string => editor !== null && editor !== repositoryRoom.ownerLogin),
        ),
      ).sort()
    : fallback.editors;

  return {
    v: 1,
    mode,
    repoSlug: repositoryRoom.repoSlug,
    ownerLogin: repositoryRoom.ownerLogin,
    editors,
    createdAt: readString(value.createdAt) ?? fallback.createdAt,
    updatedAt: readString(value.updatedAt) ?? fallback.updatedAt,
  };
}

function createProtectedRoomDeniedReason(ownerLogin: string) {
  return `This repository board is read-only. Only @${ownerLogin} and invited collaborators can edit.`;
}

async function createGithubSessionToken(secret: string, user: GithubUser) {
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

  const payload = await request.json().catch(() => null);
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
      await persistGithubUser(env, user);
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
  accessMode,
  role,
  ownerLogin,
  repoSlug,
  collaboratorCount,
}: Partial<ConnectionMeta> = {}): ConnectionMeta {
  return {
    controlledIds: Array.from(controlledIds),
    canEdit,
    githubLogin: typeof githubLogin === "string" ? normalizeGithubLogin(githubLogin) ?? undefined : undefined,
    deniedReason: readString(deniedReason) ?? undefined,
    accessMode: normalizeRepositoryAccessMode(accessMode) ?? undefined,
    role: role === "open" || role === "owner" || role === "editor" || role === "viewer" ? role : undefined,
    ownerLogin: typeof ownerLogin === "string" ? normalizeGithubLogin(ownerLogin) ?? undefined : undefined,
    repoSlug: readString(repoSlug) ?? undefined,
    collaboratorCount: readNumber(collaboratorCount) ?? undefined,
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
    accessMode: normalizeRepositoryAccessMode(value.accessMode) ?? undefined,
    role:
      value.role === "open" || value.role === "owner" || value.role === "editor" || value.role === "viewer"
        ? value.role
        : undefined,
    ownerLogin: readString(value.ownerLogin) ?? undefined,
    repoSlug: readString(value.repoSlug) ?? undefined,
    collaboratorCount: readNumber(value.collaboratorCount) ?? undefined,
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

function authorizeRoomReset(request: Request, env: DurableObjectEnv) {
  const configuredToken = readString(env.ROOM_RESET_TOKEN);

  if (!configuredToken) {
    return {
      ok: false as const,
      response: errorResponse(503, "Room reset is not configured on this worker."),
    };
  }

  const providedToken = readBearerToken(request.headers.get("authorization"));

  if (!providedToken || providedToken !== configuredToken) {
    return {
      ok: false as const,
      response: errorResponse(401, "Room reset token is invalid."),
    };
  }

  return {
    ok: true as const,
    token: configuredToken,
  };
}

async function handleRoomReset(request: Request, env: DurableObjectEnv, roomName: string) {
  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }

  const authorization = authorizeRoomReset(request, env);

  if (!authorization.ok) {
    return authorization.response;
  }

  const id = env.ROOMS.idFromName(roomName);
  const stub = env.ROOMS.get(id);
  const resetUrl = new URL(`https://pixel-room${ROOM_RESET_INTERNAL_PATH}`);
  resetUrl.searchParams.set("room", roomName);
  const response = await stub.fetch(resetUrl.toString(), {
    method: "POST",
    headers: {
      authorization: `Bearer ${authorization.token}`,
    },
  });
  const payload = await readJsonResponse(response, "Pixel room reset");

  if (!response.ok) {
    return jsonResponse(payload ?? { error: "Room reset failed." }, { status: response.status });
  }

  return jsonResponse(payload ?? { ok: true, roomName });
}

async function proxyRoomInternalRequest(request: Request, env: DurableObjectEnv, roomName: string, internalPath: string) {
  const id = env.ROOMS.idFromName(roomName);
  const stub = env.ROOMS.get(id);
  const internalUrl = new URL(`https://pixel-room${internalPath}`);

  internalUrl.searchParams.set("room", roomName);

  return stub.fetch(new Request(internalUrl.toString(), request));
}

export default {
  async fetch(request: Request, env: DurableObjectEnv) {
    const url = new URL(request.url);
    const roomResetName = getRoomResetPathRoomName(url.pathname);
    const roomAccessName = getRoomAccessPathRoomName(url.pathname);
    const roomAccessEditors = getRoomAccessEditorsPath(url.pathname);
    const roomPixelsName = getRoomPixelsPathRoomName(url.pathname);

    if (url.pathname === "/favicon.svg") {
      return staticAssetResponse(FAVICON_SVG, "image/svg+xml; charset=utf-8");
    }

    if (url.pathname === "/favicon.ico") {
      return staticAssetResponse(getFaviconIcoBytes(), "image/x-icon");
    }

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

    if (roomResetName) {
      return handleRoomReset(request, env, roomResetName);
    }

    if (roomAccessName) {
      return proxyRoomInternalRequest(request, env, roomAccessName, ROOM_ACCESS_INTERNAL_PATH);
    }

    if (roomAccessEditors?.roomName) {
      const editorSuffix = roomAccessEditors.githubLogin
        ? `/${encodeURIComponent(roomAccessEditors.githubLogin)}`
        : "";

      return proxyRoomInternalRequest(
        request,
        env,
        roomAccessEditors.roomName,
        `${ROOM_ACCESS_EDITORS_INTERNAL_PATH}${editorSuffix}`,
      );
    }

    if (roomPixelsName) {
      return proxyRoomInternalRequest(request, env, roomPixelsName, ROOM_PIXELS_INTERNAL_PATH);
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

export class PixelRoom extends DurableObject<DurableObjectEnv> {
  private readonly doc = new Y.Doc();
  private readonly awareness = new awarenessProtocol.Awareness(this.doc);
  private readonly connections = new Map<WebSocket, ConnectionMeta>();
  private readonly ready: Promise<void>;
  private decorationChecked = false;

  constructor(ctx: DurableObjectState, env: DurableObjectEnv) {
    super(ctx, env);
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
    const url = new URL(request.url);

    if (url.pathname === ROOM_RESET_INTERNAL_PATH) {
      return this.handleRoomReset(request, url);
    }

    if (url.pathname === ROOM_ACCESS_INTERNAL_PATH) {
      return this.handleRoomAccess(request, url);
    }

    if (
      url.pathname === ROOM_ACCESS_EDITORS_INTERNAL_PATH ||
      url.pathname.startsWith(`${ROOM_ACCESS_EDITORS_INTERNAL_PATH}/`)
    ) {
      return this.handleRoomEditors(request, url);
    }

    if (url.pathname === ROOM_PIXELS_INTERNAL_PATH) {
      return this.handleRoomPixels(request, url);
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Pixel room is ready.", { status: 200 });
    }

    const roomName = getRoomName(url.pathname);
    await this.ready;
    await this.ensureRepositoryRoomDecoration(roomName);
    const [client, server] = Object.values(new WebSocketPair());
    const connectionMeta = createConnectionMeta(await this.resolveConnectionAccess(request, roomName));

    this.connections.set(server, connectionMeta);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(connectionMeta);

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

  private async handleRoomReset(request: Request, url: URL) {
    if (request.method !== "POST") {
      return methodNotAllowed(["POST"]);
    }

    const authorization = authorizeRoomReset(request, this.env);

    if (!authorization.ok) {
      return authorization.response;
    }

    await this.ready;

    return jsonResponse(await this.resetRoomState(readString(url.searchParams.get("room")) ?? undefined));
  }

  private async handleRoomAccess(request: Request, url: URL) {
    await this.ready;

    const roomName = readString(url.searchParams.get("room"));
    const repositoryRoom = roomName ? parseRepositoryRoomName(roomName) : null;

    if (!repositoryRoom) {
      return errorResponse(400, "Repository access control only works for owner/repo rooms.");
    }

    if (request.method !== "GET" && request.method !== "PUT") {
      return methodNotAllowed(["GET", "PUT"]);
    }

    const authorization = await this.requireRepositoryOwner(request, repositoryRoom);

    if (!authorization.ok) {
      return authorization.response;
    }

    const policy = await this.readRepositoryAccessPolicy(repositoryRoom);

    if (request.method === "GET") {
      return jsonResponse(this.createRepositoryAccessResponse(repositoryRoom, policy, authorization.user.login));
    }

    const payload = await request.json().catch(() => null);
    const mode = normalizeRepositoryAccessMode(isRecord(payload) ? payload.mode : null);

    if (!mode) {
      return errorResponse(400, "mode must be either open or owner_allowlist.");
    }

    const nextPolicy: RepositoryAccessPolicy = {
      ...policy,
      mode,
      updatedAt: new Date().toISOString(),
    };

    await this.writeRepositoryAccessPolicy(nextPolicy);
    await this.refreshConnectionAccess(repositoryRoom);

    return jsonResponse({
      action: mode === "owner_allowlist" ? "enabled" : "disabled",
      ...this.createRepositoryAccessResponse(repositoryRoom, nextPolicy, authorization.user.login),
    });
  }

  private async handleRoomEditors(request: Request, url: URL) {
    await this.ready;

    const roomName = readString(url.searchParams.get("room"));
    const repositoryRoom = roomName ? parseRepositoryRoomName(roomName) : null;

    if (!repositoryRoom) {
      return errorResponse(400, "Repository access control only works for owner/repo rooms.");
    }

    const authorization = await this.requireRepositoryOwner(request, repositoryRoom);

    if (!authorization.ok) {
      return authorization.response;
    }

    const policy = await this.readRepositoryAccessPolicy(repositoryRoom);

    if (url.pathname === ROOM_ACCESS_EDITORS_INTERNAL_PATH) {
      if (request.method !== "POST") {
        return methodNotAllowed(["POST"]);
      }

      const payload = await request.json().catch(() => null);
      const githubLogin = isRecord(payload) ? normalizeGithubLogin(readString(payload.login) ?? "") : null;

      if (!githubLogin) {
        return errorResponse(400, "login must be a valid GitHub handle.");
      }

      if (githubLogin === repositoryRoom.ownerLogin) {
        return errorResponse(400, "The repository owner already has edit access.");
      }

      const editors = Array.from(new Set(policy.editors.concat(githubLogin))).sort();
      const nextPolicy: RepositoryAccessPolicy = {
        ...policy,
        editors,
        updatedAt: new Date().toISOString(),
      };

      await this.writeRepositoryAccessPolicy(nextPolicy);
      await this.refreshConnectionAccess(repositoryRoom);

      return jsonResponse({
        action: policy.editors.includes(githubLogin) ? "unchanged" : "granted",
        editor: githubLogin,
        ...this.createRepositoryAccessResponse(repositoryRoom, nextPolicy, authorization.user.login),
      });
    }

    const loginSegment = readString(url.pathname.slice(ROOM_ACCESS_EDITORS_INTERNAL_PATH.length + 1));
    const githubLogin = loginSegment ? normalizeGithubLogin(loginSegment) : null;

    if (request.method !== "DELETE") {
      return methodNotAllowed(["DELETE"]);
    }

    if (!githubLogin) {
      return errorResponse(400, "login must be a valid GitHub handle.");
    }

    const nextPolicy: RepositoryAccessPolicy = {
      ...policy,
      editors: policy.editors.filter((editor) => editor !== githubLogin),
      updatedAt: new Date().toISOString(),
    };

    await this.writeRepositoryAccessPolicy(nextPolicy);
    await this.refreshConnectionAccess(repositoryRoom);

    return jsonResponse({
      action: nextPolicy.editors.length === policy.editors.length ? "unchanged" : "revoked",
      editor: githubLogin,
      ...this.createRepositoryAccessResponse(repositoryRoom, nextPolicy, authorization.user.login),
    });
  }

  private async handleRoomPixels(request: Request, url: URL) {
    await this.ready;

    if (request.method !== "POST") {
      return methodNotAllowed(["POST"]);
    }

    const roomName = readString(url.searchParams.get("room"));

    if (!roomName) {
      return errorResponse(400, "room is required.");
    }

    const access = await this.resolveConnectionAccess(request, roomName);

    if (!access.canEdit) {
      return errorResponse(403, access.deniedReason ?? "You do not have edit access for this room.");
    }

    const payload = await request.json().catch(() => null);

    if (!isRecord(payload)) {
      return errorResponse(400, "Request body must be a JSON object.");
    }

    const x = readInteger(payload.x);
    const y = readInteger(payload.y);
    const color = normalizePixelColorValue(payload.color);

    if (x === null || y === null || x < 0 || y < 0 || x > MAX_API_COORDINATE || y > MAX_API_COORDINATE) {
      return errorResponse(400, `x and y must be integers between 0 and ${MAX_API_COORDINATE}.`);
    }

    if (!color) {
      return errorResponse(400, "color must be a palette id or #rrggbb hex value.");
    }

    const playerName = normalizePlayerName(payload.playerName) ?? access.githubLogin ?? "pxpx-http";
    return jsonResponse(await this.paintPixel(roomName, x, y, color, playerName, access.githubLogin));
  }

  private async requireRepositoryOwner(request: Request, repositoryRoom: RepositoryRoom) {
    const auth = await resolveGithubAuth(request, this.env);

    if (auth.ok === false) {
      return {
        ok: false as const,
        response: errorResponse(
          auth.status === "unconfigured" ? 503 : 401,
          auth.status === "missing"
            ? `Run \`pxboard login\` as @${repositoryRoom.ownerLogin} to manage access.`
            : auth.reason,
        ),
      };
    }

    const githubLogin = normalizeGithubLogin(auth.user.login);

    if (githubLogin !== repositoryRoom.ownerLogin) {
      return {
        ok: false as const,
        response: errorResponse(403, `Only @${repositoryRoom.ownerLogin} can manage access for ${repositoryRoom.repoSlug}.`),
      };
    }

    return {
      ok: true as const,
      user: auth.user,
    };
  }

  private async readRepositoryAccessPolicy(repositoryRoom: RepositoryRoom) {
    return normalizeRepositoryAccessPolicy(
      await this.ctx.storage.get<RepositoryAccessPolicy>(ROOM_ACCESS_POLICY_KEY),
      repositoryRoom,
    );
  }

  private async writeRepositoryAccessPolicy(policy: RepositoryAccessPolicy) {
    await this.ctx.storage.put(ROOM_ACCESS_POLICY_KEY, policy);
  }

  private createRepositoryAccessResponse(
    repositoryRoom: RepositoryRoom,
    policy: RepositoryAccessPolicy,
    requesterLogin: string,
  ) {
    return {
      ok: true,
      roomName: repositoryRoom.roomName,
      repoSlug: repositoryRoom.repoSlug,
      ownerLogin: repositoryRoom.ownerLogin,
      mode: policy.mode,
      editors: policy.editors,
      collaboratorCount: policy.editors.length,
      requesterLogin,
    };
  }

  private buildRepositoryConnectionAccess(options: {
    repositoryRoom: RepositoryRoom;
    policy: RepositoryAccessPolicy;
    githubLogin?: string;
    deniedReason?: string;
  }): AuthorizedConnection {
    const githubLogin = options.githubLogin ? normalizeGithubLogin(options.githubLogin) : null;
    const base = {
      githubLogin: githubLogin ?? undefined,
      accessMode: options.policy.mode,
      ownerLogin: options.repositoryRoom.ownerLogin,
      repoSlug: options.repositoryRoom.repoSlug,
      collaboratorCount: options.policy.editors.length,
    } satisfies Omit<AuthorizedConnection, "canEdit">;

    if (options.policy.mode === "open") {
      return {
        ...base,
        canEdit: true,
        role: githubLogin === options.repositoryRoom.ownerLogin ? "owner" : "open",
      };
    }

    if (githubLogin === options.repositoryRoom.ownerLogin) {
      return {
        ...base,
        canEdit: true,
        role: "owner",
      };
    }

    if (githubLogin && options.policy.editors.includes(githubLogin)) {
      return {
        ...base,
        canEdit: true,
        role: "editor",
      };
    }

    return {
      ...base,
      canEdit: false,
      role: "viewer",
      deniedReason: options.deniedReason ?? createProtectedRoomDeniedReason(options.repositoryRoom.ownerLogin),
    };
  }

  private async resolveConnectionAccess(request: Request, roomName: string): Promise<AuthorizedConnection> {
    const repositoryRoom = parseRepositoryRoomName(roomName);

    if (!repositoryRoom) {
      return {
        canEdit: true,
        accessMode: "open",
        role: "open",
      };
    }

    const policy = await this.readRepositoryAccessPolicy(repositoryRoom);
    const auth = await resolveGithubAuth(request, this.env);

    if (policy.mode === "open") {
      return this.buildRepositoryConnectionAccess({
        repositoryRoom,
        policy,
        githubLogin: auth.ok ? auth.user.login : undefined,
      });
    }

    if (auth.ok === false) {
      return this.buildRepositoryConnectionAccess({
        repositoryRoom,
        policy,
        deniedReason:
          auth.status === "missing"
            ? `Protected mode is enabled for ${repositoryRoom.repoSlug}. Run \`pxboard login\` and ask @${repositoryRoom.ownerLogin} for access.`
            : auth.reason,
      });
    }

    return this.buildRepositoryConnectionAccess({
      repositoryRoom,
      policy,
      githubLogin: auth.user.login,
    });
  }

  private async refreshConnectionAccess(repositoryRoom: RepositoryRoom) {
    const policy = await this.readRepositoryAccessPolicy(repositoryRoom);

    for (const [socket, connectionMeta] of this.connections.entries()) {
      const nextConnectionMeta = createConnectionMeta({
        ...this.buildRepositoryConnectionAccess({
          repositoryRoom,
          policy,
          githubLogin: connectionMeta.githubLogin,
        }),
        controlledIds: connectionMeta.controlledIds,
      });

      this.connections.set(socket, nextConnectionMeta);
      socket.serializeAttachment(nextConnectionMeta);
      this.sendAccessStatus(socket, nextConnectionMeta);
    }
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

    this.awareness.on("update", ({ added, updated, removed }: AwarenessUpdateEvent, origin: unknown) => {
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

  private async ensureRepositoryRoomDecoration(roomName: string) {
    if (this.decorationChecked) {
      return;
    }

    const repositoryRoom = parseRepositoryRoomName(roomName);

    if (!repositoryRoom) {
      this.decorationChecked = true;
      return;
    }

    await this.ctx.blockConcurrencyWhile(async () => {
      if (this.decorationChecked) {
        return;
      }

      const storedVersion = readNumber(await this.ctx.storage.get<number>(ROOM_DECORATION_VERSION_KEY));

      if (storedVersion === REPOSITORY_ROOM_DECORATION_VERSION) {
        this.decorationChecked = true;
        return;
      }

      const boardMap = this.doc.getMap<number>("board");
      const pixelsMap = this.doc.getMap<string>("pixels");
      const paintLogArray = this.doc.getArray<unknown>("paintLog");
      const boardWidth = readNumber(boardMap.get("width")) ?? INITIAL_BOARD_WIDTH;
      const boardHeight = readNumber(boardMap.get("height")) ?? INITIAL_BOARD_HEIGHT;
      const hasUserState = pixelsMap.size > 0 || paintLogArray.length > 0 || boardWidth > INITIAL_BOARD_WIDTH || boardHeight > INITIAL_BOARD_HEIGHT;

      if (hasUserState) {
        await this.ctx.storage.put(ROOM_DECORATION_VERSION_KEY, REPOSITORY_ROOM_DECORATION_VERSION);
        this.decorationChecked = true;
        return;
      }

      const decorationCells = createRepositoryDecorationCells(repositoryRoom);

      this.doc.transact(() => {
        boardMap.set("width", REPOSITORY_ROOM_DECORATION_BOARD_WIDTH);
        boardMap.set("height", REPOSITORY_ROOM_DECORATION_BOARD_HEIGHT);

        for (const cell of decorationCells) {
          pixelsMap.set(`${cell.x},${cell.y}`, cell.color);
        }
      });

      await this.persistDocState();
      await this.ctx.storage.put(ROOM_DECORATION_VERSION_KEY, REPOSITORY_ROOM_DECORATION_VERSION);
      this.decorationChecked = true;
    });
  }

  private async paintPixel(
    roomName: string,
    x: number,
    y: number,
    color: string,
    playerName: string,
    githubLogin?: string,
  ) {
    const boardMap = this.doc.getMap<number>("board");
    const pixelsMap = this.doc.getMap<string>("pixels");
    const paintLogArray = this.doc.getArray<unknown>("paintLog");
    const cellKey = `${x},${y}`;
    const previousColor = pixelsMap.get(cellKey);
    const previousBoardWidth = readNumber(boardMap.get("width")) ?? INITIAL_BOARD_WIDTH;
    const previousBoardHeight = readNumber(boardMap.get("height")) ?? INITIAL_BOARD_HEIGHT;
    const nextBoardWidth = Math.max(previousBoardWidth, x + 1, INITIAL_BOARD_WIDTH);
    const nextBoardHeight = Math.max(previousBoardHeight, y + 1, INITIAL_BOARD_HEIGHT);
    const boardChanged = nextBoardWidth !== previousBoardWidth || nextBoardHeight !== previousBoardHeight;
    const paintedAt = new Date().toISOString();
    let action = previousColor === color ? "unchanged" : previousColor === undefined ? "painted" : "repainted";

    if (action === "unchanged" && boardChanged) {
      action = "resized";
    }

    if (action !== "unchanged" || boardChanged) {
      const paintLogEntry = createPaintLogEntry({
        x,
        y,
        colorId: color,
        playerName,
        githubLogin,
      });

      this.doc.transact(() => {
        if (action !== "unchanged") {
          pixelsMap.set(cellKey, color);
          paintLogArray.push([paintLogEntry]);

          if (paintLogArray.length > MAX_PAINT_LOG_ENTRIES) {
            paintLogArray.delete(0, paintLogArray.length - MAX_PAINT_LOG_ENTRIES);
          }
        }

        if (boardChanged) {
          boardMap.set("width", nextBoardWidth);
          boardMap.set("height", nextBoardHeight);
        }
      });

      await this.persistDocState();
    }

    return {
      ok: true,
      roomName,
      action,
      x,
      y,
      cellKey,
      color,
      previousColor: previousColor ?? null,
      playerName,
      githubLogin,
      paintedAt,
      boardSize: {
        width: nextBoardWidth,
        height: nextBoardHeight,
      },
      pixelCount: pixelsMap.size,
      paintLogCount: paintLogArray.length,
    };
  }

  private async resetRoomState(roomName?: string) {
    const boardMap = this.doc.getMap<number>("board");
    const pixelsMap = this.doc.getMap<string>("pixels");
    const paintLogArray = this.doc.getArray<unknown>("paintLog");
    const clearedPixels = pixelsMap.size;
    const clearedPaintLogEntries = paintLogArray.length;
    const previousBoardWidth = readNumber(boardMap.get("width")) ?? INITIAL_BOARD_WIDTH;
    const previousBoardHeight = readNumber(boardMap.get("height")) ?? INITIAL_BOARD_HEIGHT;
    const boardKeys: string[] = [];
    const pixelKeys: string[] = [];

    boardMap.forEach((_, key) => {
      boardKeys.push(key);
    });
    pixelsMap.forEach((_, key) => {
      pixelKeys.push(key);
    });

    this.doc.transact(() => {
      boardKeys.forEach((key) => {
        boardMap.delete(key);
      });
      pixelKeys.forEach((key) => {
        pixelsMap.delete(key);
      });

      if (paintLogArray.length > 0) {
        paintLogArray.delete(0, paintLogArray.length);
      }

      boardMap.set("width", INITIAL_BOARD_WIDTH);
      boardMap.set("height", INITIAL_BOARD_HEIGHT);
    });

    await this.persistDocState();

    return {
      ok: true,
      roomName,
      resetAt: new Date().toISOString(),
      clearedPixels,
      clearedPaintLogEntries,
      previousBoardSize: {
        width: previousBoardWidth,
        height: previousBoardHeight,
      },
      boardSize: {
        width: INITIAL_BOARD_WIDTH,
        height: INITIAL_BOARD_HEIGHT,
      },
    };
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
    encoding.writeVarString(encoder, connectionMeta.accessMode ?? "open");
    encoding.writeVarString(encoder, connectionMeta.role ?? "open");
    encoding.writeVarString(encoder, connectionMeta.ownerLogin ?? "");
    encoding.writeVarString(encoder, connectionMeta.repoSlug ?? "");
    encoding.writeVarUint(encoder, connectionMeta.collaboratorCount ?? 0);
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

export class GithubUserRegistry extends DurableObject<DurableObjectEnv> {
  constructor(ctx: DurableObjectState, env: DurableObjectEnv) {
    super(ctx, env);
  }

  async fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === "/internal/upsert") {
      return this.handleUpsert(request);
    }

    return new Response("GitHub user registry is ready.", { status: 200 });
  }

  private async handleUpsert(request: Request) {
    if (request.method !== "POST") {
      return methodNotAllowed(["POST"]);
    }

    const payload = await request.json().catch(() => null);
    const user = normalizeGithubUser(payload);

    if (!user) {
      return errorResponse(400, "GitHub user payload is invalid.");
    }

    const now = new Date().toISOString();
    const userKey = getGithubUserStorageKey(user.id);
    const loginKey = getGithubUserLoginIndexKey(user.login);
    const existing = await this.ctx.storage.get<PersistedGithubUser>(userKey);
    const record: PersistedGithubUser = existing
      ? {
          ...existing,
          ...user,
          updatedAt: now,
          lastAuthenticatedAt: now,
          loginCount: existing.loginCount + 1,
        }
      : {
          ...user,
          provider: "github",
          createdAt: now,
          updatedAt: now,
          firstAuthenticatedAt: now,
          lastAuthenticatedAt: now,
          loginCount: 1,
        };

    await this.ctx.storage.put(userKey, record);
    await this.ctx.storage.put(loginKey, user.id);

    if (existing && existing.login.toLowerCase() !== user.login.toLowerCase()) {
      await this.ctx.storage.delete(getGithubUserLoginIndexKey(existing.login));
    }

    return jsonResponse({
      ok: true,
      created: existing === undefined,
      user: record,
    });
  }
}
