import {
  MouseButton,
  createCliRenderer,
  type BoxRenderable,
  type KeyEvent,
  type MouseEvent,
} from "@opentui/core";
import { createRoot, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import * as decoding from "lib0/decoding";
import {
  startTransition,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
} from "react";
import { WebSocket as WebSocketPolyfill } from "ws";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import {
  beginGithubLogin,
  clearStoredGithubSession,
  formatGithubLogin,
  getAuthServerUrl,
  getGithubAuthFilePath,
  getGithubSessionAuthToken,
  readStoredGithubSession,
  type GithubAuthSession,
} from "./github-auth";

type PaletteColor = {
  id: string;
  name: string;
  hex: string;
  hotkey: string;
};

type Cursor = {
  x: number;
  y: number;
};

type BoardSize = {
  width: number;
  height: number;
};

type BoardViewport = {
  startX: number;
  startY: number;
  width: number;
  height: number;
};

type PixelSnapshot = Record<string, string>;
type RecentPaintSnapshot = Record<string, number>;
type JsonRecord = Record<string, unknown>;

type PaintLogEntry = {
  id: string;
  timestamp: string;
  x: number;
  y: number;
  colorId: string;
  playerName: string;
  githubLogin?: string;
};

type EditAccessMode = "open" | "owner_allowlist";
type EditAccessRole = "open" | "owner" | "editor" | "viewer";

type EditAccessState = {
  resolved: boolean;
  canEdit: boolean;
  reason: string;
  accessMode: EditAccessMode;
  role: EditAccessRole;
  ownerLogin?: string;
  repoSlug?: string;
  collaboratorCount: number;
};

type AwarenessUser = {
  name?: string;
  githubLogin?: string;
};

type AwarenessCursor = {
  x?: number;
  y?: number;
  color?: string;
};

type AwarenessState = {
  user?: AwarenessUser;
  cursor?: AwarenessCursor;
};

type RemotePlayer = {
  id: number;
  name: string;
  color: string;
  cursor: Cursor;
  cellKey: string;
};

type RemoteCursorLabel = {
  key: string;
  label: string;
  color: string;
  left: number;
  top: number;
};

type AccessCommand = "status" | "enable" | "disable" | "grant" | "revoke";
type CliCommand = "play" | "login" | "logout" | "whoami" | "access";

type CliOptions = {
  command: CliCommand;
  help: boolean;
  accessAction?: AccessCommand;
  accessLogin?: string;
  name?: string;
  positionalRepo?: string;
  repo?: string;
  room?: string;
  serverUrl?: string;
};

type RepositoryAccessApiResponse = {
  ok: boolean;
  roomName: string;
  repoSlug: string;
  ownerLogin: string;
  mode: EditAccessMode;
  editors: string[];
  collaboratorCount: number;
  requesterLogin: string;
  action?: string;
  editor?: string;
};

const INITIAL_BOARD_WIDTH = 16;
const INITIAL_BOARD_HEIGHT = 16;
const BOARD_GROWTH_STEP = 8;
const CELL_WIDTH = 2;
const SIDEBAR_WIDTH = 30;
const ACTIVITY_WIDTH = 34;
const MIN_VIEWPORT_WIDTH = 6;
const MIN_VIEWPORT_HEIGHT = 6;
const EMPTY_CELL_COLOR = "#111827";
const APP_BACKGROUND = "#020617";
const PANEL_BACKGROUND = "#0f172a";
const BORDER_COLOR = "#334155";
const READY_COLOR = "#22c55e";
const WARNING_COLOR = "#f59e0b";
const LOG_ERASE_COLOR = "#e2e8f0";
const RECENT_PAINT_WINDOW_MS = 2500;
const RECENT_PAINT_PRUNE_MS = 250;
const REMOTE_CURSOR_LABEL_WIDTH = 18;
const MAX_PAINT_LOG_ENTRIES = 200;
const MAX_VISIBLE_PAINT_LOGS = 10;
const ERASE_LOG_COLOR_ID = "__erase__";
const MESSAGE_ACCESS = 4;
const DEFAULT_PLAY_SERVER_URL = "wss://pixel-game-collab.dlqud19.workers.dev";
const DEFAULT_AUTH_SERVER_URL = "wss://pixel-game-collab.dlqud19.workers.dev";
const DEFAULT_ROOM_NAME = "pixel-game";

function exitWithError(message: string): never {
  console.error(`Error: ${message}`);
  console.error("Run with --help for usage.");
  process.exit(1);
}

function printUsage() {
  console.log(`Usage:
  pxboard [owner/repo] [options]
  pxboard login [--server-url <url>]
  pxboard logout
  pxboard whoami
  pxboard access status [owner/repo] [--server-url <url>]
  pxboard access enable [owner/repo] [--server-url <url>]
  pxboard access disable [owner/repo] [--server-url <url>]
  pxboard access grant [owner/repo] <github-login> [--server-url <url>]
  pxboard access revoke [owner/repo] <github-login> [--server-url <url>]

Options:
  --repo <owner/repo>   Alias for the positional repository selector
  --room <name>         Join a room directly
  --server-url <url>    Override the websocket server URL or auth worker
  --name <player>       Override the player name
  -h, --help            Show this help message

Environment variables:
  PIXEL_SERVER_URL      Websocket server URL for gameplay (default: wss://pixel-game-collab.dlqud19.workers.dev)
  PIXEL_ROOM            Shared room name for collaborators (default: pixel-game)
  PIXEL_NAME            Local player label (default: GitHub login or player-xxxx)
  PIXEL_REPO            Repository slug alias for PIXEL_ROOM, for example owner/repo
  PIXEL_AUTH_SERVER_URL GitHub login worker URL (default: wss://pixel-game-collab.dlqud19.workers.dev)
`);
}

function readOptionValue(args: string[], index: number, optionName: string) {
  const value = args[index + 1];

  if (value === undefined || value.trim().length === 0) {
    exitWithError(`missing value for ${optionName}`);
  }

  return value;
}

function parseCliOptions(args: string[]) {
  const options: CliOptions = {
    command: "play",
    help: false,
  };

  let index = 0;

  if (args[0] === "login" || args[0] === "logout" || args[0] === "whoami") {
    options.command = args[0];
    index = 1;
  } else if (args[0] === "access") {
    const accessAction = args[1];

    if (accessAction === undefined || accessAction === "-h" || accessAction === "--help") {
      options.command = "access";
      options.help = true;
      return options;
    }

    if (
      accessAction !== "status" &&
      accessAction !== "enable" &&
      accessAction !== "disable" &&
      accessAction !== "grant" &&
      accessAction !== "revoke"
    ) {
      exitWithError("access requires one of: status, enable, disable, grant, revoke");
    }

    options.command = "access";
    options.accessAction = accessAction;
    index = 2;
  }

  for (; index < args.length; index += 1) {
    const argument = args[index];

    switch (argument) {
      case "--repo":
        options.repo = readOptionValue(args, index, "--repo");
        index += 1;
        break;
      case "--room":
        options.room = readOptionValue(args, index, "--room");
        index += 1;
        break;
      case "--server-url":
        options.serverUrl = readOptionValue(args, index, "--server-url");
        index += 1;
        break;
      case "--name":
        options.name = readOptionValue(args, index, "--name");
        index += 1;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        if (argument.startsWith("-")) {
          exitWithError(`unknown argument: ${argument}`);
        }

        if (options.command === "access") {
          if (options.positionalRepo === undefined) {
            options.positionalRepo = argument;
            continue;
          }

          if (
            (options.accessAction === "grant" || options.accessAction === "revoke") &&
            options.accessLogin === undefined
          ) {
            options.accessLogin = argument;
            continue;
          }

          exitWithError(`unexpected argument: ${argument}`);
        }

        if (options.command !== "play") {
          exitWithError(`unexpected argument: ${argument}`);
        }

        if (options.positionalRepo !== undefined) {
          exitWithError(`unexpected argument: ${argument}`);
        }

        options.positionalRepo = argument;
    }
  }

  if (options.room !== undefined && (options.repo !== undefined || options.positionalRepo !== undefined)) {
    exitWithError("use either --room or a repository selector, not both");
  }

  if (options.repo !== undefined && options.positionalRepo !== undefined) {
    exitWithError("use either --repo or a positional repository argument, not both");
  }

  if (
    options.command === "login" &&
    (options.repo !== undefined ||
      options.room !== undefined ||
      options.positionalRepo !== undefined ||
      options.name !== undefined)
  ) {
    exitWithError("login only supports --server-url and --help");
  }

  if (
    (options.command === "logout" || options.command === "whoami") &&
    (options.repo !== undefined ||
      options.room !== undefined ||
      options.positionalRepo !== undefined ||
      options.name !== undefined ||
      options.serverUrl !== undefined)
  ) {
    exitWithError(`${options.command} does not accept board options`);
  }

  if (
    options.command === "access" &&
    (options.room !== undefined || options.name !== undefined)
  ) {
    exitWithError("access only supports repository selectors, --server-url, and --help");
  }

  if (
    options.command === "access" &&
    (options.accessAction === "grant" || options.accessAction === "revoke") &&
    options.accessLogin === undefined
  ) {
    exitWithError(`${options.accessAction} requires a GitHub login`);
  }

  return options;
}

function normalizeRoomName(value: string, source: string) {
  const normalized = value.trim().replace(/^\/+|\/+$/g, "");

  if (normalized.length === 0) {
    exitWithError(`${source} cannot be empty`);
  }

  return normalized;
}

function parseGithubRepoSlug(value: string) {
  const normalized = value
    .trim()
    .replace(/^@/, "")
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^ssh:\/\/git@github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/^github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);

  if (segments.length !== 2) {
    return null;
  }

  return `${segments[0].toLowerCase()}/${segments[1].toLowerCase()}`;
}

function normalizeNonEmptyValue(value: string, source: string) {
  const normalized = value.trim();

  if (normalized.length === 0) {
    exitWithError(`${source} cannot be empty`);
  }

  return normalized;
}

function normalizeRepoSlug(value: string, source: string) {
  const normalized = parseGithubRepoSlug(value);

  if (!normalized) {
    exitWithError(`${source} must use owner/repo format`);
  }

  return normalized;
}

function normalizeGithubHandle(value: string, source: string) {
  const normalized = value.trim().replace(/^@/, "").toLowerCase();

  if (!/^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(normalized)) {
    exitWithError(`${source} must be a valid GitHub login`);
  }

  return normalized;
}

function normalizeAccessMode(value: unknown): EditAccessMode {
  return value === "owner_allowlist" ? "owner_allowlist" : "open";
}

function normalizeAccessRole(value: unknown, canEdit: boolean): EditAccessRole {
  if (value === "owner" || value === "editor" || value === "viewer" || value === "open") {
    return value;
  }

  return canEdit ? "open" : "viewer";
}

function createInitialEditAccessState(): EditAccessState {
  return {
    resolved: false,
    canEdit: false,
    reason: "Checking edit access...",
    accessMode: "open",
    role: "open",
    collaboratorCount: 0,
  };
}

function extractErrorMessage(payload: unknown, fallback: string) {
  if (!isRecord(payload)) {
    return fallback;
  }

  const message = readOptionalString(payload.error);
  const description = readOptionalString(payload.description);

  return message ?? description ?? fallback;
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

function normalizeStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function normalizeRepositoryAccessResponse(payload: unknown): RepositoryAccessApiResponse {
  if (!isRecord(payload)) {
    throw new Error("Access server response was invalid.");
  }

  const repoSlug = readOptionalString(payload.repoSlug);
  const roomName = readOptionalString(payload.roomName);
  const ownerLogin = readOptionalString(payload.ownerLogin);
  const requesterLogin = readOptionalString(payload.requesterLogin);

  if (!repoSlug || !roomName || !ownerLogin || !requesterLogin) {
    throw new Error("Access server response was missing required fields.");
  }

  return {
    ok: payload.ok === true,
    roomName,
    repoSlug,
    ownerLogin,
    mode: normalizeAccessMode(payload.mode),
    editors: normalizeStringArray(payload.editors),
    collaboratorCount: readInteger(payload.collaboratorCount) ?? 0,
    requesterLogin,
    action: readOptionalString(payload.action) ?? undefined,
    editor: readOptionalString(payload.editor) ?? undefined,
  };
}

function describeAccessMode(mode: EditAccessMode) {
  return mode === "owner_allowlist" ? "protected" : "open";
}

function formatEditors(editors: string[]) {
  return editors.length === 0 ? "(none)" : editors.map((editor) => `@${editor}`).join(", ");
}

function printRepositoryAccessSummary(result: RepositoryAccessApiResponse) {
  console.log(`Repository: ${result.repoSlug}`);
  console.log(`Owner: @${result.ownerLogin}`);
  console.log(`Mode: ${describeAccessMode(result.mode)}`);
  console.log(`Editors: ${formatEditors(result.editors)}`);
}

async function requestRepositoryAccess(
  url: string,
  sessionToken: string,
  init: RequestInit = {},
): Promise<RepositoryAccessApiResponse> {
  const headers = new Headers(init.headers);

  headers.set("Accept", "application/json");
  headers.set("Authorization", `Bearer ${sessionToken}`);

  if (init.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(url, {
    ...init,
    headers,
  });
  const payload = await readJsonResponse(response, "Access server");

  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, `Access request failed with status ${response.status}.`));
  }

  return normalizeRepositoryAccessResponse(payload);
}

function getEditStatusText(editAccess: EditAccessState) {
  if (!editAccess.resolved) {
    return "Edit access: checking";
  }

  if (editAccess.role === "owner") {
    return "Edit access: owner";
  }

  if (editAccess.role === "editor") {
    return "Edit access: invited";
  }

  if (!editAccess.canEdit) {
    return "Edit access: read-only";
  }

  return editAccess.accessMode === "open" ? "Edit access: open" : "Edit access: enabled";
}

function getEditHintText(editAccess: EditAccessState, githubSession: GithubAuthSession | null) {
  if (!editAccess.resolved) {
    return "Waiting for access info";
  }

  if (editAccess.role === "owner") {
    if (editAccess.accessMode === "owner_allowlist") {
      return editAccess.collaboratorCount === 0
        ? "Protected: no editors"
        : `Protected: ${editAccess.collaboratorCount} editors`;
    }

    return "Run `pxboard access enable`";
  }

  if (editAccess.role === "editor") {
    return editAccess.ownerLogin ? `Invited by @${editAccess.ownerLogin}` : "Owner granted access";
  }

  if (editAccess.canEdit) {
    return githubSession ? "GitHub identity connected" : "Guests can paint";
  }

  return editAccess.reason;
}

function getFooterAccessText(editAccess: EditAccessState) {
  if (!editAccess.resolved) {
    return "Checking edit access";
  }

  if (editAccess.role === "owner") {
    return editAccess.accessMode === "owner_allowlist"
      ? `Protected | ${editAccess.collaboratorCount} editors`
      : "Open room | Run access enable";
  }

  if (editAccess.role === "editor") {
    return "Invited editor | Live presence";
  }

  if (editAccess.canEdit) {
    return "Open room | Live presence | Frontier growth";
  }

  return editAccess.reason;
}

function getOwnerAccessMessage(editAccess: EditAccessState) {
  if (editAccess.role !== "owner" || !editAccess.repoSlug) {
    return null;
  }

  if (editAccess.accessMode === "owner_allowlist") {
    return editAccess.collaboratorCount === 0
      ? `Protected mode is on for ${editAccess.repoSlug}. Invite an editor with \`pxboard access grant ${editAccess.repoSlug} <github-login>\`.`
      : `Protected mode is on for ${editAccess.repoSlug}. Review editors with \`pxboard access status ${editAccess.repoSlug}\`.`;
  }

  return `You own ${editAccess.repoSlug}. Run \`pxboard access enable ${editAccess.repoSlug}\` to limit editing to you and invited collaborators.`;
}

function resolveRuntimeValue(cliValue: string | undefined, envValue: string | undefined) {
  if (cliValue !== undefined) {
    return cliValue;
  }

  if (envValue !== undefined) {
    return envValue;
  }

  return undefined;
}

function formatPlayerIdentity(playerName: string, githubSession: GithubAuthSession | null) {
  const githubLogin = githubSession?.user.login;

  if (!githubLogin) {
    return playerName;
  }

  if (playerName.toLowerCase() === githubLogin.toLowerCase()) {
    return `@${githubLogin}`;
  }

  return `${playerName} (@${githubLogin})`;
}

function resolvePlayRuntimeConfig(cliOptions: CliOptions) {
  const githubSession = readStoredGithubSession();
  const serverUrl = resolveRuntimeValue(cliOptions.serverUrl, process.env.PIXEL_SERVER_URL) ?? DEFAULT_PLAY_SERVER_URL;
  const playerName =
    resolveRuntimeValue(cliOptions.name, process.env.PIXEL_NAME) ??
    githubSession?.user.login ??
    `player-${Math.random().toString(36).slice(2, 6)}`;
  const cliRepoSelector = cliOptions.positionalRepo ?? cliOptions.repo;
  const roomName =
    cliOptions.room !== undefined
      ? normalizeRoomName(cliOptions.room, "--room")
      : cliRepoSelector !== undefined
        ? normalizeRepoSlug(cliRepoSelector, cliOptions.positionalRepo !== undefined ? "owner/repo" : "--repo")
        : process.env.PIXEL_ROOM !== undefined
          ? normalizeRoomName(process.env.PIXEL_ROOM, "PIXEL_ROOM")
          : process.env.PIXEL_REPO !== undefined
            ? normalizeRepoSlug(process.env.PIXEL_REPO, "PIXEL_REPO")
            : DEFAULT_ROOM_NAME;

  return {
    githubSession,
    identityLabel: formatPlayerIdentity(playerName, githubSession),
    playerName: normalizeNonEmptyValue(playerName, cliOptions.name !== undefined ? "--name" : "PIXEL_NAME"),
    roomName,
    serverUrl: normalizeNonEmptyValue(
      serverUrl,
      cliOptions.serverUrl !== undefined ? "--server-url" : "PIXEL_SERVER_URL",
    ),
  };
}

function getLoginAuthServerUrl(cliOptions: CliOptions) {
  const serverUrl =
    resolveRuntimeValue(cliOptions.serverUrl, process.env.PIXEL_AUTH_SERVER_URL) ?? DEFAULT_AUTH_SERVER_URL;

  return getAuthServerUrl(serverUrl);
}

function resolveAccessRuntimeConfig(cliOptions: CliOptions) {
  const githubSession = readStoredGithubSession();
  const sessionToken = getGithubSessionAuthToken(githubSession);
  const repoSelector = cliOptions.positionalRepo ?? cliOptions.repo ?? process.env.PIXEL_REPO;

  if (!repoSelector) {
    exitWithError("access requires owner/repo or PIXEL_REPO");
  }

  if (!githubSession) {
    exitWithError("run `pxboard login` before managing repository access");
  }

  if (!sessionToken) {
    exitWithError("stored GitHub login is not linked to this worker. Run `pxboard login` against the worker again.");
  }

  return {
    authServerUrl: getLoginAuthServerUrl(cliOptions),
    githubLogin: githubSession.user.login,
    repoSlug: normalizeRepoSlug(repoSelector, cliOptions.positionalRepo !== undefined ? "owner/repo" : "--repo"),
    sessionToken,
  };
}

function getConnectionLabel(connectionStatus: string) {
  if (connectionStatus === "connected") {
    return "Connected";
  }

  if (connectionStatus === "disconnected") {
    return "Reconnecting";
  }

  return "Connecting";
}

async function runGithubLoginCommand(cliOptions: CliOptions) {
  const existingSession = readStoredGithubSession();
  const authServerUrl = getLoginAuthServerUrl(cliOptions);

  if (existingSession) {
    console.log(`Replacing stored GitHub login for @${existingSession.user.login}.`);
  }

  const pendingLogin = await beginGithubLogin(authServerUrl);

  console.log("GitHub device login");
  console.log(`1. Open ${pendingLogin.deviceLogin.verificationUri}`);

  if (pendingLogin.deviceLogin.verificationUriComplete) {
    console.log(`   Direct link: ${pendingLogin.deviceLogin.verificationUriComplete}`);
  }

  console.log(`2. Enter code ${pendingLogin.deviceLogin.userCode}`);
  console.log("3. Approve access in the browser");
  console.log(`Waiting for authorization via ${authServerUrl}...`);

  const session = await pendingLogin.complete;

  console.log(`Logged in as @${session.user.login}`);
  console.log(`Stored at ${getGithubAuthFilePath()}`);
}

function runGithubLogoutCommand() {
  const session = readStoredGithubSession();

  if (!session) {
    console.log("GitHub login is already cleared.");
    return;
  }

  clearStoredGithubSession();
  console.log(`Logged out @${session.user.login}`);
}

function runGithubWhoAmICommand() {
  const session = readStoredGithubSession();

  if (!session) {
    console.log("GitHub: guest");
    console.log(`Storage: ${getGithubAuthFilePath()}`);
    return;
  }

  console.log(`GitHub: @${session.user.login}`);

  if (session.user.name) {
    console.log(`Name: ${session.user.name}`);
  }

  console.log(`Profile: ${session.user.htmlUrl}`);
  console.log(`Storage: ${getGithubAuthFilePath()}`);
}

async function runAccessCommand(cliOptions: CliOptions) {
  if (!cliOptions.accessAction) {
    exitWithError("access requires a subcommand");
  }

  const runtime = resolveAccessRuntimeConfig(cliOptions);
  const baseUrl = `${runtime.authServerUrl}/admin/rooms/${encodeURIComponent(runtime.repoSlug)}/access`;

  switch (cliOptions.accessAction) {
    case "status": {
      const result = await requestRepositoryAccess(baseUrl, runtime.sessionToken);
      printRepositoryAccessSummary(result);
      return;
    }
    case "enable": {
      const result = await requestRepositoryAccess(baseUrl, runtime.sessionToken, {
        method: "PUT",
        body: JSON.stringify({ mode: "owner_allowlist" }),
      });
      console.log(`Protected mode enabled for ${result.repoSlug}.`);
      printRepositoryAccessSummary(result);
      return;
    }
    case "disable": {
      const result = await requestRepositoryAccess(baseUrl, runtime.sessionToken, {
        method: "PUT",
        body: JSON.stringify({ mode: "open" }),
      });
      console.log(`Protected mode disabled for ${result.repoSlug}.`);
      printRepositoryAccessSummary(result);
      return;
    }
    case "grant": {
      const githubLogin = normalizeGithubHandle(cliOptions.accessLogin ?? "", "github-login");
      const result = await requestRepositoryAccess(
        `${baseUrl}/editors`,
        runtime.sessionToken,
        {
          method: "POST",
          body: JSON.stringify({ login: githubLogin }),
        },
      );
      const action = result.action === "unchanged" ? "already had" : "now has";
      console.log(`@${githubLogin} ${action} edit access for ${result.repoSlug}.`);
      printRepositoryAccessSummary(result);
      return;
    }
    case "revoke": {
      const githubLogin = normalizeGithubHandle(cliOptions.accessLogin ?? "", "github-login");
      const result = await requestRepositoryAccess(
        `${baseUrl}/editors/${encodeURIComponent(githubLogin)}`,
        runtime.sessionToken,
        {
          method: "DELETE",
        },
      );
      const action = result.action === "unchanged" ? "did not have" : "no longer has";
      console.log(`@${githubLogin} ${action} edit access for ${result.repoSlug}.`);
      printRepositoryAccessSummary(result);
      return;
    }
  }
}

const CLI_OPTIONS = parseCliOptions(process.argv.slice(2));

if (CLI_OPTIONS.help) {
  printUsage();
  process.exit(0);
}

if (CLI_OPTIONS.command === "login") {
  await runGithubLoginCommand(CLI_OPTIONS);
  process.exit(0);
}

if (CLI_OPTIONS.command === "logout") {
  runGithubLogoutCommand();
  process.exit(0);
}

if (CLI_OPTIONS.command === "whoami") {
  runGithubWhoAmICommand();
  process.exit(0);
}

if (CLI_OPTIONS.command === "access") {
  await runAccessCommand(CLI_OPTIONS);
  process.exit(0);
}

const RUNTIME_CONFIG = resolvePlayRuntimeConfig(CLI_OPTIONS);
const SERVER_URL = RUNTIME_CONFIG.serverUrl;
const ROOM_NAME = RUNTIME_CONFIG.roomName;
const GITHUB_SESSION = RUNTIME_CONFIG.githubSession;
const GITHUB_AUTH_TOKEN = getGithubSessionAuthToken(GITHUB_SESSION);
const GITHUB_LOGIN = formatGithubLogin(GITHUB_SESSION);
const PLAYER_IDENTITY = RUNTIME_CONFIG.identityLabel;
const PLAYER_NAME = RUNTIME_CONFIG.playerName;

const PALETTE: PaletteColor[] = [
  { id: "rose", name: "Rose", hex: "#fb7185", hotkey: "1" },
  { id: "amber", name: "Amber", hex: "#f59e0b", hotkey: "2" },
  { id: "lime", name: "Lime", hex: "#84cc16", hotkey: "3" },
  { id: "emerald", name: "Emerald", hex: "#10b981", hotkey: "4" },
  { id: "sky", name: "Sky", hex: "#38bdf8", hotkey: "5" },
  { id: "violet", name: "Violet", hex: "#8b5cf6", hotkey: "6" },
  { id: "pink", name: "Pink", hex: "#ec4899", hotkey: "7" },
  { id: "slate", name: "Slate", hex: "#94a3b8", hotkey: "8" },
];

const COLOR_BY_ID = Object.fromEntries(PALETTE.map((color) => [color.id, color])) as Record<string, PaletteColor>;
const COLOR_BY_HOTKEY = Object.fromEntries(PALETTE.map((color) => [color.hotkey, color])) as Record<
  string,
  PaletteColor
>;
const DEFAULT_CURSOR: Cursor = { x: 0, y: 0 };
const DEFAULT_BOARD_SIZE: BoardSize = {
  width: INITIAL_BOARD_WIDTH,
  height: INITIAL_BOARD_HEIGHT,
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function readOptionalString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function readInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function getCellKey(x: number, y: number) {
  return `${x},${y}`;
}

function isValidBoardIndex(value: number, size: number) {
  return Number.isInteger(value) && value >= 0 && value < size;
}

function sanitizeBoardDimension(value: number, fallback: number) {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(fallback, Math.floor(value));
}

function sanitizeBoardSize(size: Partial<BoardSize> | null | undefined): BoardSize {
  return {
    width: sanitizeBoardDimension(Number(size?.width), INITIAL_BOARD_WIDTH),
    height: sanitizeBoardDimension(Number(size?.height), INITIAL_BOARD_HEIGHT),
  };
}

function sanitizeNonNegativeIndex(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.floor(value));
}

function isValidCursor(cursor: Cursor, boardSize: BoardSize) {
  return isValidBoardIndex(cursor.x, boardSize.width) && isValidBoardIndex(cursor.y, boardSize.height);
}

function sanitizeBoardIndex(value: number, size: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return clamp(Math.floor(value), 0, size - 1);
}

function sanitizeCursor(cursor: Cursor, boardSize: BoardSize): Cursor {
  return {
    x: sanitizeBoardIndex(cursor.x, boardSize.width),
    y: sanitizeBoardIndex(cursor.y, boardSize.height),
  };
}

function parseCellKey(key: string): Cursor | null {
  const [xValue, yValue, extra] = key.split(",");

  if (xValue === undefined || yValue === undefined || extra !== undefined) {
    return null;
  }

  const cursor = {
    x: Number(xValue),
    y: Number(yValue),
  };

  if (!Number.isInteger(cursor.x) || !Number.isInteger(cursor.y) || cursor.x < 0 || cursor.y < 0) {
    return null;
  }

  return cursor;
}

function getBoardSizeFromState(boardMap: Y.Map<number>, pixelsMap: Y.Map<string>) {
  const boardSize = sanitizeBoardSize({
    width: Number(boardMap.get("width")),
    height: Number(boardMap.get("height")),
  });

  pixelsMap.forEach((_, key) => {
    const cell = parseCellKey(key);

    if (!cell) {
      return;
    }

    boardSize.width = Math.max(boardSize.width, cell.x + 1);
    boardSize.height = Math.max(boardSize.height, cell.y + 1);
  });

  return boardSize;
}

function getExpandedBoardSize(boardSize: BoardSize, cursor: Cursor) {
  return {
    width: cursor.x >= boardSize.width - 1 ? boardSize.width + BOARD_GROWTH_STEP : boardSize.width,
    height: cursor.y >= boardSize.height - 1 ? boardSize.height + BOARD_GROWTH_STEP : boardSize.height,
  };
}

function getOverflowExpandedBoardSize(boardSize: BoardSize, cursor: Cursor) {
  return {
    width: cursor.x >= boardSize.width ? boardSize.width + BOARD_GROWTH_STEP : boardSize.width,
    height: cursor.y >= boardSize.height ? boardSize.height + BOARD_GROWTH_STEP : boardSize.height,
  };
}

function getBoardViewport(boardSize: BoardSize, cursor: Cursor, width: number, height: number): BoardViewport {
  const viewportWidth = clamp(width, 1, boardSize.width);
  const viewportHeight = clamp(height, 1, boardSize.height);
  const maxStartX = Math.max(boardSize.width - viewportWidth, 0);
  const maxStartY = Math.max(boardSize.height - viewportHeight, 0);

  return {
    startX: clamp(cursor.x - Math.floor(viewportWidth / 2), 0, maxStartX),
    startY: clamp(cursor.y - Math.floor(viewportHeight / 2), 0, maxStartY),
    width: viewportWidth,
    height: viewportHeight,
  };
}

function getColorHex(colorId: string | undefined) {
  return (colorId && COLOR_BY_ID[colorId]?.hex) || EMPTY_CELL_COLOR;
}

function getReadableTextColor(hex: string) {
  const normalized = hex.replace("#", "");
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  const luminance = (red * 299 + green * 587 + blue * 114) / 1000;
  return luminance > 150 ? "#020617" : "#f8fafc";
}

function mixHex(hex: string, targetHex: string, weight: number) {
  const normalizedHex = hex.replace("#", "");
  const normalizedTarget = targetHex.replace("#", "");
  const ratio = clamp(weight, 0, 1);
  const mixedChannels = [0, 2, 4].map((start) => {
    const source = Number.parseInt(normalizedHex.slice(start, start + 2), 16);
    const target = Number.parseInt(normalizedTarget.slice(start, start + 2), 16);
    const value = Math.round(source + (target - source) * ratio);
    return value.toString(16).padStart(2, "0");
  });

  return `#${mixedChannels.join("")}`;
}

function getRecentPaintColor(hex: string) {
  return mixHex(hex, "#f8fafc", 0.28);
}

function getPresenceColor(hex: string, presenceHex: string | undefined) {
  if (typeof presenceHex !== "string" || !presenceHex.startsWith("#")) {
    return hex;
  }

  return mixHex(hex, presenceHex, 0.45);
}

function truncateLabel(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  if (maxLength <= 3) {
    return value.slice(0, maxLength);
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function getPlayerName(state: AwarenessState | undefined, clientId: number) {
  const rawName = state?.user?.name;
  const rawGithubLogin = state?.user?.githubLogin;
  const normalizedName = typeof rawName === "string" && rawName.trim().length > 0 ? rawName.trim() : null;
  const normalizedGithubLogin =
    typeof rawGithubLogin === "string" && rawGithubLogin.trim().length > 0 ? rawGithubLogin.trim() : null;

  if (normalizedName && normalizedGithubLogin && normalizedName.toLowerCase() !== normalizedGithubLogin.toLowerCase()) {
    return `${normalizedName} (@${normalizedGithubLogin})`;
  }

  if (normalizedName) {
    return normalizedName;
  }

  if (normalizedGithubLogin) {
    return `@${normalizedGithubLogin}`;
  }

  return `player-${String(clientId).slice(-4)}`;
}

function normalizePaintLogEntry(value: unknown): PaintLogEntry | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = readOptionalString(value.id);
  const timestamp = readOptionalString(value.timestamp);
  const x = readInteger(value.x);
  const y = readInteger(value.y);
  const colorId = readOptionalString(value.colorId);
  const playerName = readOptionalString(value.playerName);
  const githubLogin = readOptionalString(value.githubLogin) ?? undefined;

  if (!id || !timestamp || x === null || y === null || !colorId || !playerName) {
    return null;
  }

  return {
    id,
    timestamp,
    x,
    y,
    colorId,
    playerName,
    githubLogin,
  };
}

function normalizePaintLogEntries(entries: unknown[]) {
  return entries
    .map((entry) => normalizePaintLogEntry(entry))
    .filter((entry): entry is PaintLogEntry => entry !== null);
}

function formatPaintActor(entry: PaintLogEntry) {
  if (entry.githubLogin && entry.playerName.toLowerCase() !== entry.githubLogin.toLowerCase()) {
    return `${entry.playerName} (@${entry.githubLogin})`;
  }

  if (entry.githubLogin) {
    return `@${entry.githubLogin}`;
  }

  return entry.playerName;
}

function formatPaintTime(timestamp: string) {
  const date = new Date(timestamp);

  if (!Number.isFinite(date.getTime())) {
    return "--:--:--";
  }

  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(
    date.getSeconds(),
  ).padStart(2, "0")}`;
}

function getPaintLogLabel(colorId: string) {
  if (colorId === ERASE_LOG_COLOR_ID) {
    return "Cleared";
  }

  return COLOR_BY_ID[colorId]?.name ?? colorId;
}

function getPaintLogTextColor(colorId: string) {
  if (colorId === ERASE_LOG_COLOR_ID) {
    return LOG_ERASE_COLOR;
  }

  return COLOR_BY_ID[colorId]?.hex ?? "#f8fafc";
}

function getRemotePlayer(state: AwarenessState | undefined, clientId: number): RemotePlayer | null {
  const rawCursor = state?.cursor;

  if (rawCursor === undefined) {
    return null;
  }

  const x = Number(rawCursor.x);
  const y = Number(rawCursor.y);

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }

  const cursor = {
    x: sanitizeNonNegativeIndex(x),
    y: sanitizeNonNegativeIndex(y),
  };

  return {
    id: clientId,
    name: getPlayerName(state, clientId),
    color: typeof rawCursor.color === "string" ? rawCursor.color : READY_COLOR,
    cursor,
    cellKey: getCellKey(cursor.x, cursor.y),
  };
}

function ColorPalette({
  selectedColorId,
  onSelect,
}: {
  selectedColorId: string;
  onSelect: (colorId: string) => void;
}) {
  return (
    <box flexDirection="column" gap={1}>
      {PALETTE.map((color) => {
        const isSelected = color.id === selectedColorId;

        return (
          <box key={color.id} flexDirection="row" justifyContent="space-between">
            <text fg={isSelected ? "#f8fafc" : "#cbd5e1"}>
              {isSelected ? ">" : " "} [{color.hotkey}] {color.name}
            </text>
            <text bg={color.hex} fg={color.hex}>
              {"  "}
            </text>
          </box>
        );
      })}
    </box>
  );
}

function BoardRows({
  pixels,
  cursor,
  viewport,
  remotePlayersByCell,
  recentPaints,
}: {
  pixels: PixelSnapshot;
  cursor: Cursor;
  viewport: BoardViewport;
  remotePlayersByCell: Record<string, RemotePlayer[]>;
  recentPaints: RecentPaintSnapshot;
}) {
  return (
    <box flexDirection="column" width={viewport.width * CELL_WIDTH} height={viewport.height}>
      {Array.from({ length: viewport.height }, (_, rowOffset) => {
        const y = viewport.startY + rowOffset;

        return (
          <text key={`row-${y}`}>
            {Array.from({ length: viewport.width }, (_, columnOffset) => {
              const x = viewport.startX + columnOffset;
              const cellKey = getCellKey(x, y);
              const isCursor = cursor.x === x && cursor.y === y;
              const remotePlayers = remotePlayersByCell[cellKey] ?? [];
              const colorHex = getColorHex(pixels[cellKey]);
              const recentPaintColor = recentPaints[cellKey] ? getRecentPaintColor(colorHex) : colorHex;
              const primaryRemotePlayer = remotePlayers[0];
              const displayColor = getPresenceColor(recentPaintColor, primaryRemotePlayer?.color);
              const cursorText = isCursor
                ? "[]"
                : remotePlayers.length === 1
                  ? "<>"
                : remotePlayers.length > 1
                  ? `${Math.min(remotePlayers.length, 9)}+`
                  : "  ";
              const textColor =
                cursorText.trim().length > 0 ? getReadableTextColor(displayColor) : displayColor;

              return (
                <span key={`cell-${x}-${y}`} bg={displayColor} fg={textColor}>
                  {cursorText}
                </span>
              );
            })}
          </text>
        );
      })}
    </box>
  );
}

function App() {
  const renderer = useRenderer();
  const terminal = useTerminalDimensions();
  const boardRef = useRef<BoxRenderable | null>(null);
  const isMousePaintingRef = useRef(false);
  const hasHydratedPixelsRef = useRef(false);
  const accessMessageReceivedRef = useRef(false);
  const [doc] = useState(() => new Y.Doc());
  const [provider] = useState(
    () =>
      new WebsocketProvider(SERVER_URL, ROOM_NAME, doc, {
        connect: false,
        params: GITHUB_AUTH_TOKEN ? { github_auth: GITHUB_AUTH_TOKEN } : {},
        WebSocketPolyfill: WebSocketPolyfill as unknown as typeof globalThis.WebSocket,
      }),
  );
  const [boardMap] = useState(() => doc.getMap<number>("board"));
  const [pixelsMap] = useState(() => doc.getMap<string>("pixels"));
  const [paintLogArray] = useState(() => doc.getArray<PaintLogEntry>("paintLog"));
  const [cursor, setCursor] = useState<Cursor>(DEFAULT_CURSOR);
  const [boardSize, setBoardSize] = useState<BoardSize>(() => getBoardSizeFromState(boardMap, pixelsMap));
  const [selectedColorId, setSelectedColorId] = useState(PALETTE[0].id);
  const [pixelsSnapshot, setPixelsSnapshot] = useState<PixelSnapshot>(() => pixelsMap.toJSON() as PixelSnapshot);
  const [paintLogSnapshot, setPaintLogSnapshot] = useState<PaintLogEntry[]>(
    () => normalizePaintLogEntries(paintLogArray.toJSON() as unknown[]),
  );
  const [recentPaints, setRecentPaints] = useState<RecentPaintSnapshot>({});
  const [connectionStatus, setConnectionStatus] = useState("connecting");
  const [isSynced, setIsSynced] = useState(false);
  const [playersOnline, setPlayersOnline] = useState(1);
  const [remotePlayers, setRemotePlayers] = useState<RemotePlayer[]>([]);
  const [editAccess, setEditAccess] = useState<EditAccessState>(() => createInitialEditAccessState());
  const [statusMessage, setStatusMessage] = useState(
    `Connecting to ${SERVER_URL} in room ${ROOM_NAME} as ${PLAYER_IDENTITY}...`,
  );
  const deferredPixelsSnapshot = useDeferredValue(pixelsSnapshot);
  const selectedColor = COLOR_BY_ID[selectedColorId] ?? PALETTE[0];
  const safeCursor = sanitizeCursor(cursor, boardSize);
  const currentCellColorId = deferredPixelsSnapshot[getCellKey(safeCursor.x, safeCursor.y)];
  const currentCellColor = COLOR_BY_ID[currentCellColorId ?? ""]?.name ?? "Empty";
  const githubStatusText = GITHUB_SESSION ? `GitHub ${GITHUB_LOGIN}` : "GitHub guest";
  const githubHintText = GITHUB_SESSION ? "Run `pxboard logout` to clear" : "Run `pxboard login` to connect";
  const connectionLabel = getConnectionLabel(connectionStatus);
  const editStatusText = getEditStatusText(editAccess);
  const editHintText = getEditHintText(editAccess, GITHUB_SESSION);
  const footerAccessText = getFooterAccessText(editAccess);
  const remotePlayersByCell: Record<string, RemotePlayer[]> = {};
  const remoteCursorLabels: RemoteCursorLabel[] = [];
  const visibleRemotePlayers = remotePlayers.slice(0, 3);
  const visiblePaintLogs = paintLogSnapshot.slice(-MAX_VISIBLE_PAINT_LOGS).reverse();
  const rawViewportWidth = Math.floor(
    (terminal.width - SIDEBAR_WIDTH - ACTIVITY_WIDTH - 16 - REMOTE_CURSOR_LABEL_WIDTH) / CELL_WIDTH,
  );
  const rawViewportHeight = terminal.height - 14;
  const minimumWidth =
    SIDEBAR_WIDTH + ACTIVITY_WIDTH + MIN_VIEWPORT_WIDTH * CELL_WIDTH + 16 + REMOTE_CURSOR_LABEL_WIDTH;
  const minimumHeight = MIN_VIEWPORT_HEIGHT + 14;
  const screenTooSmall = rawViewportWidth < MIN_VIEWPORT_WIDTH || rawViewportHeight < MIN_VIEWPORT_HEIGHT;
  const viewport = getBoardViewport(
    boardSize,
    safeCursor,
    Math.max(rawViewportWidth, 1),
    Math.max(rawViewportHeight, 1),
  );
  const viewportEndX = viewport.startX + viewport.width;
  const viewportEndY = viewport.startY + viewport.height;

  remotePlayers.forEach((player) => {
    if (!remotePlayersByCell[player.cellKey]) {
      remotePlayersByCell[player.cellKey] = [];
    }

    remotePlayersByCell[player.cellKey].push(player);
  });

  Object.entries(remotePlayersByCell).forEach(([cellKey, playersAtCell]) => {
    const cell = parseCellKey(cellKey);

    if (
      !cell ||
      cell.x < viewport.startX ||
      cell.x >= viewportEndX ||
      cell.y < viewport.startY ||
      cell.y >= viewportEndY
    ) {
      return;
    }

    const primaryPlayer = playersAtCell[0];
    const labelSuffix = playersAtCell.length > 1 ? ` +${playersAtCell.length - 1}` : "";
    const label = truncateLabel(`${primaryPlayer.name}${labelSuffix}`, REMOTE_CURSOR_LABEL_WIDTH - 1);
    const desiredLeft = (cell.x - viewport.startX) * CELL_WIDTH + CELL_WIDTH;
    const maxLeft = Math.max(viewport.width * CELL_WIDTH + REMOTE_CURSOR_LABEL_WIDTH - label.length, 0);
    const desiredTop = cell.y - viewport.startY > 0 ? cell.y - viewport.startY - 1 : cell.y - viewport.startY + 1;

    remoteCursorLabels.push({
      key: cellKey,
      label,
      color: primaryPlayer.color,
      left: clamp(desiredLeft, 0, maxLeft),
      top: clamp(desiredTop, 0, Math.max(viewport.height - 1, 0)),
    });
  });

  remoteCursorLabels.sort((left, right) => left.top - right.top || left.left - right.left || left.key.localeCompare(right.key));

  function writeBoardSize(nextBoardSize: BoardSize) {
    const currentBoardSize = getBoardSizeFromState(boardMap, pixelsMap);
    const sanitizedNextBoardSize = sanitizeBoardSize(nextBoardSize);

    if (sanitizedNextBoardSize.width > currentBoardSize.width) {
      boardMap.set("width", sanitizedNextBoardSize.width);
    }

    if (sanitizedNextBoardSize.height > currentBoardSize.height) {
      boardMap.set("height", sanitizedNextBoardSize.height);
    }

    return {
      width: Math.max(currentBoardSize.width, sanitizedNextBoardSize.width),
      height: Math.max(currentBoardSize.height, sanitizedNextBoardSize.height),
    };
  }

  function shutdown() {
    provider.destroy();
    doc.destroy();
    renderer.destroy();
    process.exit(0);
  }

  function moveCursor(dx: number, dy: number) {
    const currentBoardSize = getBoardSizeFromState(boardMap, pixelsMap);
    const nextCursor = {
      x: sanitizeCursor(cursor, currentBoardSize).x + dx,
      y: sanitizeCursor(cursor, currentBoardSize).y + dy,
    };
    const expandedBoardSize = getOverflowExpandedBoardSize(currentBoardSize, nextCursor);
    const willExpand =
      expandedBoardSize.width > currentBoardSize.width || expandedBoardSize.height > currentBoardSize.height;

    if (willExpand) {
      doc.transact(() => {
        writeBoardSize(expandedBoardSize);
      });

      setStatusMessage(`Frontier opened to ${expandedBoardSize.width}x${expandedBoardSize.height}.`);
    }

    setCursor({
      x: clamp(nextCursor.x, 0, expandedBoardSize.width - 1),
      y: clamp(nextCursor.y, 0, expandedBoardSize.height - 1),
    });
  }

  function setSelectedColor(colorId: string) {
    const color = COLOR_BY_ID[colorId];

    if (!color) {
      return;
    }

    setSelectedColorId(colorId);
    setStatusMessage(`Selected ${color.name}`);
  }

  function createPaintLogEntry(x: number, y: number, colorId: string): PaintLogEntry {
    return {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      x,
      y,
      colorId,
      playerName: PLAYER_NAME,
      githubLogin: GITHUB_SESSION?.user.login,
    };
  }

  function appendPaintLogEntry(entry: PaintLogEntry) {
    paintLogArray.push([entry]);

    if (paintLogArray.length > MAX_PAINT_LOG_ENTRIES) {
      paintLogArray.delete(0, paintLogArray.length - MAX_PAINT_LOG_ENTRIES);
    }
  }

  function attemptPlacement(x: number, y: number) {
    if (!editAccess.canEdit) {
      setStatusMessage(editAccess.reason);
      return;
    }

    const currentBoardSize = getBoardSizeFromState(boardMap, pixelsMap);
    const targetCursor = { x, y };

    if (!isValidCursor(targetCursor, currentBoardSize)) {
      return;
    }

    setCursor(targetCursor);

    const cellKey = getCellKey(x, y);
    const existingColorId = pixelsMap.get(cellKey);

    if (existingColorId === selectedColorId) {
      setStatusMessage(`(${x + 1}, ${y + 1}) already uses ${selectedColor.name}`);
      return;
    }

    const expandedBoardSize = getExpandedBoardSize(currentBoardSize, targetCursor);
    const willExpand =
      expandedBoardSize.width > currentBoardSize.width || expandedBoardSize.height > currentBoardSize.height;
    const paintLogEntry = createPaintLogEntry(x, y, selectedColorId);

    doc.transact(() => {
      pixelsMap.set(cellKey, selectedColorId);
      appendPaintLogEntry(paintLogEntry);

      if (willExpand) {
        writeBoardSize(expandedBoardSize);
      }
    });

    if (willExpand) {
      setStatusMessage(
        `Painted (${x + 1}, ${y + 1}) with ${selectedColor.name}. Frontier opened to ${expandedBoardSize.width}x${expandedBoardSize.height}.`,
      );
      return;
    }

    setStatusMessage(`Painted (${x + 1}, ${y + 1}) with ${selectedColor.name}`);
  }

  function attemptErase(x: number, y: number) {
    if (!editAccess.canEdit) {
      setStatusMessage(editAccess.reason);
      return;
    }

    const currentBoardSize = getBoardSizeFromState(boardMap, pixelsMap);
    const targetCursor = { x, y };

    if (!isValidCursor(targetCursor, currentBoardSize)) {
      return;
    }

    setCursor(targetCursor);

    const cellKey = getCellKey(x, y);
    const existingColorId = pixelsMap.get(cellKey);

    if (existingColorId === undefined) {
      setStatusMessage(`(${x + 1}, ${y + 1}) is already empty`);
      return;
    }

    const clearedColorName = COLOR_BY_ID[existingColorId]?.name ?? existingColorId;
    const paintLogEntry = createPaintLogEntry(x, y, ERASE_LOG_COLOR_ID);

    doc.transact(() => {
      pixelsMap.delete(cellKey);
      appendPaintLogEntry(paintLogEntry);
    });

    setStatusMessage(`Cleared (${x + 1}, ${y + 1}) from ${clearedColorName}`);
  }

  function updateCursorFromMouse(event: MouseEvent, shouldPaint: boolean) {
    const board = boardRef.current;

    if (!board) {
      return;
    }

    if (!Number.isFinite(event.x) || !Number.isFinite(event.y) || !Number.isFinite(board.x) || !Number.isFinite(board.y)) {
      return;
    }

    const relativeX = event.x - board.x;
    const relativeY = event.y - board.y;
    const cellX = viewport.startX + Math.floor(relativeX / CELL_WIDTH);
    const cellY = Math.floor(relativeY);
    const targetCursor = {
      x: cellX,
      y: viewport.startY + cellY,
    };

    if (!isValidCursor(targetCursor, boardSize)) {
      return;
    }

    setCursor(targetCursor);

    if (shouldPaint && event.button === MouseButton.LEFT) {
      attemptPlacement(targetCursor.x, targetCursor.y);
    }
  }

  function handleKeyInput(key: KeyEvent) {
    if (key.ctrl && key.name === "c") {
      shutdown();
      return;
    }

    if (key.name === "escape" || key.name === "q") {
      shutdown();
      return;
    }

    if (key.name === "up" || key.name === "w" || key.name === "k") {
      moveCursor(0, -1);
      return;
    }

    if (key.name === "down" || key.name === "s" || key.name === "j") {
      moveCursor(0, 1);
      return;
    }

    if (key.name === "left" || key.name === "a" || key.name === "h") {
      moveCursor(-1, 0);
      return;
    }

    if (key.name === "right" || key.name === "d" || key.name === "l") {
      moveCursor(1, 0);
      return;
    }

    if (key.name === "return" || key.name === "enter" || key.name === "space") {
      attemptPlacement(safeCursor.x, safeCursor.y);
      return;
    }

    if (key.name === "x") {
      attemptErase(safeCursor.x, safeCursor.y);
      return;
    }

    const hotkeyColor = COLOR_BY_HOTKEY[key.name];

    if (hotkeyColor) {
      setSelectedColor(hotkeyColor.id);
    }
  }

  useKeyboard((key) => {
    handleKeyInput(key);
  });

  useEffect(() => {
    const pruneRecentPaints = () => {
      const cutoff = Date.now() - RECENT_PAINT_WINDOW_MS;

      setRecentPaints((previous) => {
        const entries = Object.entries(previous);

        if (entries.length === 0) {
          return previous;
        }

        const nextEntries = entries.filter(([, timestamp]) => timestamp >= cutoff);

        if (nextEntries.length === entries.length) {
          return previous;
        }

        return Object.fromEntries(nextEntries);
      });
    };
    const interval = setInterval(pruneRecentPaints, RECENT_PAINT_PRUNE_MS);

    return () => {
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const resetMousePainting = () => {
      isMousePaintingRef.current = false;
    };

    renderer.on("blur", resetMousePainting);
    renderer.on("focus", resetMousePainting);

    return () => {
      renderer.off("blur", resetMousePainting);
      renderer.off("focus", resetMousePainting);
    };
  }, [renderer]);

  useEffect(() => {
    provider.awareness.setLocalStateField("user", {
      name: PLAYER_NAME,
      githubLogin: GITHUB_SESSION?.user.login,
    });
    provider.awareness.setLocalStateField("cursor", {
      x: safeCursor.x,
      y: safeCursor.y,
      color: selectedColor.hex,
    });
  }, [GITHUB_SESSION?.user.login, PLAYER_NAME, provider.awareness, safeCursor.x, safeCursor.y, selectedColor.hex]);

  useEffect(() => {
    const removeInvalidPixels = () => {
      const invalidKeys: string[] = [];

      pixelsMap.forEach((_, key) => {
        if (!parseCellKey(key)) {
          invalidKeys.push(key);
        }
      });

      if (invalidKeys.length === 0) {
        return false;
      }

      doc.transact(() => {
        invalidKeys.forEach((key) => {
          pixelsMap.delete(key);
        });
      });

      return true;
    };
    const syncBoardMetadata = () => {
      const nextBoardSize = getBoardSizeFromState(boardMap, pixelsMap);
      const storedBoardSize = sanitizeBoardSize({
        width: Number(boardMap.get("width")),
        height: Number(boardMap.get("height")),
      });

      if (
        storedBoardSize.width === nextBoardSize.width &&
        storedBoardSize.height === nextBoardSize.height
      ) {
        return;
      }

      doc.transact(() => {
        boardMap.set("width", nextBoardSize.width);
        boardMap.set("height", nextBoardSize.height);
      });
    };
    const updateRecentPaints = (changedKeys: Iterable<string>, snapshot: PixelSnapshot) => {
      if (!hasHydratedPixelsRef.current) {
        hasHydratedPixelsRef.current = true;
        return;
      }

      const validKeys = Array.from(changedKeys).filter((key) => parseCellKey(key));

      if (validKeys.length === 0) {
        return;
      }

      const timestamp = Date.now();

      setRecentPaints((previous) => {
        const nextPaints = { ...previous };

        validKeys.forEach((key) => {
          nextPaints[key] = timestamp;
        });

        return nextPaints;
      });
    };
    const handleStatus = (event: { status: string }) => {
      setConnectionStatus(event.status);

      if (event.status === "connected") {
        setStatusMessage(`Connected to ${ROOM_NAME} via ${SERVER_URL}`);
      }

      if (event.status === "disconnected") {
        setStatusMessage(`Connection lost. Reconnecting to ${SERVER_URL}...`);
      }
    };
    const handleSync = (synced: boolean) => {
      setIsSynced(synced);

      if (synced) {
        setStatusMessage(`Synced room ${ROOM_NAME}`);
      }
    };
    const handlePixels = (event?: Y.YMapEvent<string>) => {
      if (removeInvalidPixels()) {
        return;
      }

      const nextSnapshot = pixelsMap.toJSON() as PixelSnapshot;
      updateRecentPaints(event?.keysChanged ?? [], nextSnapshot);

      startTransition(() => {
        setPixelsSnapshot(nextSnapshot);
        setBoardSize(getBoardSizeFromState(boardMap, pixelsMap));
      });
    };
    const handleBoard = () => {
      startTransition(() => {
        setBoardSize(getBoardSizeFromState(boardMap, pixelsMap));
      });
    };
    const handlePaintLog = () => {
      startTransition(() => {
        setPaintLogSnapshot(normalizePaintLogEntries(paintLogArray.toJSON() as unknown[]));
      });
    };
    const handleAwareness = () => {
      const nextRemotePlayers: RemotePlayer[] = [];

      provider.awareness.getStates().forEach((state, clientId) => {
        if (clientId === doc.clientID) {
          return;
        }

        const remotePlayer = getRemotePlayer(state as AwarenessState | undefined, clientId);

        if (remotePlayer) {
          nextRemotePlayers.push(remotePlayer);
        }
      });

      nextRemotePlayers.sort((left, right) => left.name.localeCompare(right.name) || left.id - right.id);

      startTransition(() => {
        setPlayersOnline(Math.max(provider.awareness.getStates().size, 1));
        setRemotePlayers(nextRemotePlayers);
      });
    };
    const previousAccessMessageHandler = provider.messageHandlers[MESSAGE_ACCESS];
    const handleAccessMessage = ((
      _encoder: unknown,
      decoder: decoding.Decoder,
    ) => {
      accessMessageReceivedRef.current = true;
      const canEdit = decoding.readVarUint(decoder) === 1;
      const reason = decoding.readVarString(decoder).trim();
      const deniedReason = reason || "Editing is disabled on this server.";
      const accessMode = decoding.hasContent(decoder) ? normalizeAccessMode(decoding.readVarString(decoder)) : "open";
      const role = decoding.hasContent(decoder)
        ? normalizeAccessRole(decoding.readVarString(decoder), canEdit)
        : normalizeAccessRole(undefined, canEdit);
      const ownerLoginValue = decoding.hasContent(decoder) ? decoding.readVarString(decoder).trim() : "";
      const repoSlugValue = decoding.hasContent(decoder) ? decoding.readVarString(decoder).trim() : "";
      const ownerLogin = ownerLoginValue.length > 0 ? ownerLoginValue : undefined;
      const repoSlug = repoSlugValue.length > 0 ? repoSlugValue : undefined;
      const collaboratorCount = decoding.hasContent(decoder) ? decoding.readVarUint(decoder) : 0;
      const nextEditAccess: EditAccessState = {
        resolved: true,
        canEdit,
        reason: canEdit ? "" : deniedReason,
        accessMode,
        role,
        ownerLogin,
        repoSlug,
        collaboratorCount,
      };

      startTransition(() => {
        setEditAccess(nextEditAccess);
      });

      const ownerAccessMessage = getOwnerAccessMessage(nextEditAccess);

      if (ownerAccessMessage) {
        setStatusMessage(ownerAccessMessage);
      } else if (!canEdit) {
        setStatusMessage(deniedReason);
      }
    }) as (typeof provider.messageHandlers)[number];

    provider.messageHandlers[MESSAGE_ACCESS] = handleAccessMessage;
    pixelsMap.observe(handlePixels);
    boardMap.observe(handleBoard);
    paintLogArray.observe(handlePaintLog);
    provider.on("status", handleStatus);
    provider.on("sync", handleSync);
    provider.awareness.on("change", handleAwareness);
    provider.connect();

    const legacyAccessTimeout = setTimeout(() => {
      if (accessMessageReceivedRef.current) {
        return;
      }

      startTransition(() => {
        setEditAccess({
          resolved: true,
          canEdit: true,
          reason: "",
          accessMode: "open",
          role: "open",
          collaboratorCount: 0,
        });
      });
    }, 1200);

    syncBoardMetadata();
    handlePixels();
    handleBoard();
    handlePaintLog();
    handleAwareness();

    return () => {
      provider.messageHandlers[MESSAGE_ACCESS] = previousAccessMessageHandler;
      pixelsMap.unobserve(handlePixels);
      boardMap.unobserve(handleBoard);
      paintLogArray.unobserve(handlePaintLog);
      provider.off("status", handleStatus);
      provider.off("sync", handleSync);
      provider.awareness.off("change", handleAwareness);
      clearTimeout(legacyAccessTimeout);
      provider.destroy();
      doc.destroy();
    };
  }, [boardMap, doc, paintLogArray, pixelsMap, provider]);

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={APP_BACKGROUND}>
      <box
        border
        borderColor={BORDER_COLOR}
        backgroundColor={PANEL_BACKGROUND}
        paddingX={1}
        paddingY={0}
        flexDirection="row"
        justifyContent="space-between"
      >
        <text fg="#f8fafc">Pixel Game</text>
        <text fg="#cbd5e1">
          Room {ROOM_NAME} | {playersOnline} online
        </text>
      </box>

      <box flexGrow={1} flexDirection="row" gap={1} padding={1} backgroundColor={APP_BACKGROUND}>
        <box
          width={SIDEBAR_WIDTH}
          border
          borderColor={BORDER_COLOR}
          backgroundColor={PANEL_BACKGROUND}
          padding={1}
          flexDirection="column"
          gap={1}
        >
          <text fg="#f8fafc">Palette</text>
          <ColorPalette selectedColorId={selectedColorId} onSelect={setSelectedColor} />
          <text fg="#94a3b8">Selected: {selectedColor.name}</text>
          <text fg="#94a3b8">
            Cursor: ({safeCursor.x + 1}, {safeCursor.y + 1})
          </text>
          <text fg="#94a3b8">Board: {boardSize.width}x{boardSize.height}</text>
          <text fg="#94a3b8">
            View x: {viewport.startX + 1}-{viewportEndX}
          </text>
          <text fg="#94a3b8">
            View y: {viewport.startY + 1}-{viewportEndY}
          </text>
          <text fg="#94a3b8">Cell: {currentCellColor}</text>
          <text fg="#94a3b8">Connection: {connectionLabel}</text>
          <text fg={isSynced ? READY_COLOR : WARNING_COLOR}>{isSynced ? "Synced" : "Syncing..."}</text>
          <text fg="#94a3b8">Player: {truncateLabel(PLAYER_IDENTITY, 22)}</text>
          <text fg={GITHUB_SESSION ? READY_COLOR : WARNING_COLOR}>{truncateLabel(githubStatusText, 22)}</text>
          <text fg="#64748b">{truncateLabel(githubHintText, 26)}</text>
          <text fg={editAccess.canEdit ? READY_COLOR : WARNING_COLOR}>{truncateLabel(editStatusText, 22)}</text>
          <text fg="#64748b">{truncateLabel(editHintText, 26)}</text>
          {editAccess.repoSlug ? (
            <text fg="#94a3b8">
              Access: {editAccess.accessMode === "owner_allowlist" ? "Protected" : "Open"}
            </text>
          ) : null}
          {editAccess.repoSlug ? (
            <text fg="#64748b">Editors: {editAccess.collaboratorCount}</text>
          ) : null}
          <text fg="#f8fafc">Live cursors</text>
          {visibleRemotePlayers.length === 0 ? (
            <text fg="#64748b">Waiting for another painter</text>
          ) : (
            visibleRemotePlayers.map((player) => (
              <text key={player.id} fg={player.color}>
                {truncateLabel(player.name, 14)} ({player.cursor.x + 1},{player.cursor.y + 1})
              </text>
            ))
          )}
          {remotePlayers.length > visibleRemotePlayers.length ? (
            <text fg="#64748b">+{remotePlayers.length - visibleRemotePlayers.length} more nearby</text>
          ) : null}
          <text fg="#64748b">Arrows/WASD/HJKL move</text>
          <text fg="#64748b">{editAccess.canEdit ? "Enter/Space paints" : "Enter/Space locked"}</text>
          <text fg="#64748b">{editAccess.canEdit ? "X clears the current cell" : "X is locked"}</text>
          <text fg="#64748b">1-8 selects color</text>
          <text fg="#64748b">Live cursor cells are color-tinted</text>
          <text fg="#64748b">Name tags track visible cursors</text>
          <text fg="#64748b">Fresh paint glows briefly</text>
          <text fg="#64748b">{editAccess.canEdit ? "Click paints the board" : "Click only moves cursor"}</text>
          <text fg="#64748b">Push or paint east/south edge to grow</text>
          <text fg="#64748b">Esc or Q exits</text>
        </box>

        <box
          flexGrow={1}
          border
          borderColor={BORDER_COLOR}
          backgroundColor={PANEL_BACKGROUND}
          padding={1}
          flexDirection="column"
          gap={1}
        >
          <text fg="#f8fafc">
            Board {boardSize.width}x{boardSize.height} | View x {viewport.startX + 1}-{viewportEndX} | y{" "}
            {viewport.startY + 1}-{viewportEndY}
          </text>
          {screenTooSmall ? (
            <text fg={WARNING_COLOR}>
              Resize terminal to at least {minimumWidth}x{minimumHeight} for a {MIN_VIEWPORT_WIDTH}x
              {MIN_VIEWPORT_HEIGHT} viewport.
            </text>
          ) : (
            <box width={viewport.width * CELL_WIDTH + REMOTE_CURSOR_LABEL_WIDTH} height={viewport.height}>
              <box
                ref={boardRef}
                width={viewport.width * CELL_WIDTH}
                height={viewport.height}
                onMouseMove={(event) => updateCursorFromMouse(event, false)}
                onMouseDown={(event) => {
                  isMousePaintingRef.current = event.button === MouseButton.LEFT;
                  updateCursorFromMouse(event, isMousePaintingRef.current);
                }}
                onMouseUp={() => {
                  isMousePaintingRef.current = false;
                }}
                onMouseDrag={(event) => {
                  if (!isMousePaintingRef.current) {
                    return;
                  }

                  updateCursorFromMouse(event, true);
                }}
                onMouseDragEnd={() => {
                  isMousePaintingRef.current = false;
                }}
              >
                <BoardRows
                  pixels={deferredPixelsSnapshot}
                  cursor={safeCursor}
                  viewport={viewport}
                  remotePlayersByCell={remotePlayersByCell}
                  recentPaints={recentPaints}
                />
              </box>
              {remoteCursorLabels.map((remoteCursorLabel) => (
                <box
                  key={remoteCursorLabel.key}
                  position="absolute"
                  left={remoteCursorLabel.left}
                  top={remoteCursorLabel.top}
                  zIndex={1}
                >
                  <text bg={remoteCursorLabel.color} fg={getReadableTextColor(remoteCursorLabel.color)}>
                    {remoteCursorLabel.label}
                  </text>
                </box>
              ))}
            </box>
          )}
          <text fg="#94a3b8">{statusMessage}</text>
        </box>

        <box
          width={ACTIVITY_WIDTH}
          border
          borderColor={BORDER_COLOR}
          backgroundColor={PANEL_BACKGROUND}
          padding={1}
          flexDirection="column"
          gap={1}
        >
          <text fg="#f8fafc">Paint log</text>
          <text fg="#94a3b8">{paintLogSnapshot.length} events</text>
          {visiblePaintLogs.length === 0 ? (
            <text fg="#64748b">No paint yet</text>
          ) : (
            visiblePaintLogs.map((entry) => {
              return (
                <box key={entry.id} flexDirection="column">
                  <text fg={getPaintLogTextColor(entry.colorId)}>
                    {truncateLabel(`${formatPaintActor(entry)} -> ${getPaintLogLabel(entry.colorId)}`, ACTIVITY_WIDTH - 4)}
                  </text>
                  <text fg="#64748b">
                    {truncateLabel(`${formatPaintTime(entry.timestamp)} (${entry.x + 1}, ${entry.y + 1})`, ACTIVITY_WIDTH - 4)}
                  </text>
                </box>
              );
            })
          )}
          {paintLogSnapshot.length > visiblePaintLogs.length ? (
            <text fg="#64748b">+{paintLogSnapshot.length - visiblePaintLogs.length} older events</text>
          ) : null}
        </box>
      </box>

      <box
        border
        borderColor={BORDER_COLOR}
        backgroundColor={PANEL_BACKGROUND}
        paddingX={1}
        paddingY={0}
        flexDirection="row"
        justifyContent="space-between"
      >
        <text fg="#94a3b8">
          {connectionLabel} | {githubStatusText}
        </text>
        <text fg={editAccess.canEdit ? READY_COLOR : WARNING_COLOR}>
          {truncateLabel(footerAccessText, 42)}
        </text>
      </box>
    </box>
  );
}

const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  useMouse: true,
  enableMouseMovement: true,
  useAlternateScreen: true,
  autoFocus: true,
  backgroundColor: APP_BACKGROUND,
});

createRoot(renderer).render(<App />);
