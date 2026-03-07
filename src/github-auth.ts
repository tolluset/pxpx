import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const APP_CONFIG_DIR_NAME = "pxboard";
const GITHUB_AUTH_FILE_NAME = "github-auth.json";
const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_LOGIN_SCOPE = "read:user";

type JsonRecord = Record<string, unknown>;

type GithubDeviceCodeApiResponse = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresInSeconds: number;
  pollIntervalSeconds: number;
};

type GithubAccessTokenResponse =
  | {
      type: "success";
      accessToken: string;
    }
  | {
      type: "error";
      error: string;
      description?: string;
    };

type GithubWorkerPollResponse =
  | {
      type: "authorized";
      sessionExpiresAt: string;
      sessionToken: string;
      user: GithubUserProfile;
    }
  | {
      type: "pending";
      error: string;
      description?: string;
    };

export type GithubUserProfile = {
  login: string;
  id: number;
  name: string | null;
  htmlUrl: string;
  avatarUrl: string | null;
};

export type GithubAuthSession = {
  provider: "github";
  createdAt: string;
  workerAuthToken?: string;
  workerAuthTokenExpiresAt?: string;
  user: GithubUserProfile;
};

export type GithubDeviceLogin = {
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresInSeconds: number;
  pollIntervalSeconds: number;
};

export type GithubPendingLogin = {
  deviceLogin: GithubDeviceLogin;
  complete: Promise<GithubAuthSession>;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readOptionalString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getConfigDirectoryPath() {
  const xdgConfigHome = readString(process.env.XDG_CONFIG_HOME);

  if (xdgConfigHome) {
    return path.join(xdgConfigHome, APP_CONFIG_DIR_NAME);
  }

  return path.join(os.homedir(), ".config", APP_CONFIG_DIR_NAME);
}

function normalizeGithubUserProfile(value: unknown): GithubUserProfile | null {
  if (!isRecord(value)) {
    return null;
  }

  const login = readString(value.login);
  const id = readNumber(value.id);
  const htmlUrl = readString(value.htmlUrl);

  if (!login || id === null || !htmlUrl) {
    return null;
  }

  return {
    login,
    id,
    name: readOptionalString(value.name),
    htmlUrl,
    avatarUrl: readOptionalString(value.avatarUrl),
  };
}

function normalizeStoredGithubSession(value: unknown): GithubAuthSession | null {
  if (!isRecord(value)) {
    return null;
  }

  const createdAt = readString(value.createdAt);
  const user = normalizeGithubUserProfile(value.user);

  if (value.provider !== "github" || !createdAt || !user) {
    return null;
  }

  return {
    provider: "github",
    createdAt,
    workerAuthToken: readOptionalString(value.workerAuthToken) ?? undefined,
    workerAuthTokenExpiresAt: readOptionalString(value.workerAuthTokenExpiresAt) ?? undefined,
    user,
  };
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

async function postGithubForm(url: string, body: URLSearchParams) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "pxboard",
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

async function postJson(url: string, body: JsonRecord) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "pxboard",
    },
    body: JSON.stringify(body),
  });
  const payload = await readJsonResponse(response, "Auth server");

  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, `Auth server request failed with status ${response.status}.`));
  }

  return payload;
}

function normalizeDeviceCodeResponse(payload: unknown): GithubDeviceCodeApiResponse {
  if (!isRecord(payload)) {
    throw new Error("GitHub device login response was invalid.");
  }

  const deviceCode = readString(payload.device_code);
  const userCode = readString(payload.user_code);
  const verificationUri = readString(payload.verification_uri);
  const expiresInSeconds = readNumber(payload.expires_in);

  if (!deviceCode || !userCode || !verificationUri || expiresInSeconds === null) {
    throw new Error("GitHub device login response was missing required fields.");
  }

  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: readString(payload.verification_uri_complete) ?? undefined,
    expiresInSeconds,
    pollIntervalSeconds: readNumber(payload.interval) ?? 5,
  };
}

function normalizeAccessTokenResponse(payload: unknown): GithubAccessTokenResponse {
  if (!isRecord(payload)) {
    throw new Error("GitHub access token response was invalid.");
  }

  const error = readString(payload.error);

  if (error) {
    return {
      type: "error",
      error,
      description: readString(payload.error_description) ?? undefined,
    };
  }

  const accessToken = readString(payload.access_token);

  if (!accessToken) {
    throw new Error("GitHub access token response was missing required fields.");
  }

  return {
    type: "success",
    accessToken,
  };
}

function normalizeGithubApiUserProfile(payload: unknown): GithubUserProfile {
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
    name: readOptionalString(payload.name),
    htmlUrl,
    avatarUrl: readOptionalString(payload.avatar_url),
  };
}

function normalizeWorkerPollResponse(payload: unknown): GithubWorkerPollResponse {
  if (!isRecord(payload)) {
    throw new Error("Auth server poll response was invalid.");
  }

  if (payload.status === "authorized") {
    const user = normalizeGithubUserProfile(payload.user);

    if (!user) {
      throw new Error("Auth server poll response was missing the GitHub user profile.");
    }

    const sessionToken = readString(payload.sessionToken);
    const sessionExpiresAt = readString(payload.sessionExpiresAt);

    if (!sessionToken || !sessionExpiresAt) {
      throw new Error("Auth server poll response was missing the GitHub edit session.");
    }

    return {
      type: "authorized",
      sessionExpiresAt,
      sessionToken,
      user,
    };
  }

  const error = readString(payload.error);

  if (!error) {
    throw new Error("Auth server poll response was missing the GitHub status.");
  }

  return {
    type: "pending",
    error,
    description: readString(payload.description) ?? undefined,
  };
}

function getGithubClientId() {
  return readString(process.env.PIXEL_GITHUB_CLIENT_ID) ?? readString(process.env.GITHUB_CLIENT_ID) ?? undefined;
}

function buildGithubSession(
  user: GithubUserProfile,
  options: {
    workerAuthToken?: string;
    workerAuthTokenExpiresAt?: string;
  } = {},
): GithubAuthSession {
  return {
    provider: "github",
    createdAt: new Date().toISOString(),
    workerAuthToken: options.workerAuthToken,
    workerAuthTokenExpiresAt: options.workerAuthTokenExpiresAt,
    user,
  };
}

async function requestDeviceCodeDirect(clientId: string) {
  const payload = await postGithubForm(
    GITHUB_DEVICE_CODE_URL,
    new URLSearchParams({
      client_id: clientId,
      scope: GITHUB_LOGIN_SCOPE,
    }),
  );

  return normalizeDeviceCodeResponse(payload);
}

async function requestAccessTokenDirect(clientId: string, deviceCode: string) {
  const payload = await postGithubForm(
    GITHUB_ACCESS_TOKEN_URL,
    new URLSearchParams({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  );

  return normalizeAccessTokenResponse(payload);
}

async function fetchGithubUserProfile(accessToken: string) {
  const response = await fetch(GITHUB_USER_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "pxboard",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    },
  });
  const payload = await readJsonResponse(response, "GitHub");

  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, `GitHub user request failed with status ${response.status}.`));
  }

  return normalizeGithubApiUserProfile(payload);
}

async function requestDeviceCodeFromWorker(authServerUrl: string) {
  const payload = await postJson(`${authServerUrl}/auth/github/device`, {});
  return normalizeDeviceCodeResponse(payload);
}

async function pollDeviceCodeFromWorker(authServerUrl: string, deviceCode: string) {
  const payload = await postJson(`${authServerUrl}/auth/github/poll`, {
    deviceCode,
  });

  return normalizeWorkerPollResponse(payload);
}

function ensureConfigDirectory() {
  mkdirSync(getConfigDirectoryPath(), { recursive: true });
}

function toPublicDeviceLogin(deviceCodeResponse: GithubDeviceCodeApiResponse): GithubDeviceLogin {
  return {
    userCode: deviceCodeResponse.userCode,
    verificationUri: deviceCodeResponse.verificationUri,
    verificationUriComplete: deviceCodeResponse.verificationUriComplete,
    expiresInSeconds: deviceCodeResponse.expiresInSeconds,
    pollIntervalSeconds: deviceCodeResponse.pollIntervalSeconds,
  };
}

async function completeDirectLogin(clientId: string, deviceCodeResponse: GithubDeviceCodeApiResponse) {
  let pollIntervalMilliseconds = deviceCodeResponse.pollIntervalSeconds * 1000;
  const expiresAt = Date.now() + deviceCodeResponse.expiresInSeconds * 1000;

  while (Date.now() < expiresAt) {
    await delay(pollIntervalMilliseconds);

    const tokenResponse = await requestAccessTokenDirect(clientId, deviceCodeResponse.deviceCode);

    if (tokenResponse.type === "success") {
      const session = buildGithubSession(await fetchGithubUserProfile(tokenResponse.accessToken));
      writeStoredGithubSession(session);
      return session;
    }

    if (tokenResponse.error === "authorization_pending") {
      continue;
    }

    if (tokenResponse.error === "slow_down") {
      pollIntervalMilliseconds += 5000;
      continue;
    }

    if (tokenResponse.error === "expired_token") {
      break;
    }

    throw new Error(tokenResponse.description ?? `GitHub login failed: ${tokenResponse.error}`);
  }

  throw new Error("GitHub device login timed out before authorization completed.");
}

async function completeWorkerLogin(authServerUrl: string, deviceCodeResponse: GithubDeviceCodeApiResponse) {
  let pollIntervalMilliseconds = deviceCodeResponse.pollIntervalSeconds * 1000;
  const expiresAt = Date.now() + deviceCodeResponse.expiresInSeconds * 1000;

  while (Date.now() < expiresAt) {
    await delay(pollIntervalMilliseconds);

    const pollResponse = await pollDeviceCodeFromWorker(authServerUrl, deviceCodeResponse.deviceCode);

    if (pollResponse.type === "authorized") {
      const session = buildGithubSession(pollResponse.user, {
        workerAuthToken: pollResponse.sessionToken,
        workerAuthTokenExpiresAt: pollResponse.sessionExpiresAt,
      });
      writeStoredGithubSession(session);
      return session;
    }

    if (pollResponse.error === "authorization_pending") {
      continue;
    }

    if (pollResponse.error === "slow_down") {
      pollIntervalMilliseconds += 5000;
      continue;
    }

    if (pollResponse.error === "expired_token") {
      break;
    }

    throw new Error(pollResponse.description ?? `GitHub login failed: ${pollResponse.error}`);
  }

  throw new Error("GitHub device login timed out before authorization completed.");
}

export function getGithubAuthFilePath() {
  return path.join(getConfigDirectoryPath(), GITHUB_AUTH_FILE_NAME);
}

export function getAuthServerUrl(serverUrl: string) {
  const url = new URL(serverUrl);

  if (url.protocol === "wss:") {
    url.protocol = "https:";
  } else if (url.protocol === "ws:") {
    url.protocol = "http:";
  }

  url.pathname = "";
  url.search = "";
  url.hash = "";

  return url.toString().replace(/\/$/, "");
}

export function readStoredGithubSession() {
  try {
    const raw = readFileSync(getGithubAuthFilePath(), "utf8");
    const session = normalizeStoredGithubSession(JSON.parse(raw) as unknown);

    if (!session) {
      console.error(`Error: invalid GitHub auth session at ${getGithubAuthFilePath()}`);
      return null;
    }

    return session;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    console.error(`Error: failed to read GitHub auth session: ${(error as Error).message}`);
    return null;
  }
}

export function writeStoredGithubSession(session: GithubAuthSession) {
  ensureConfigDirectory();
  writeFileSync(getGithubAuthFilePath(), `${JSON.stringify(session, null, 2)}\n`, "utf8");

  try {
    chmodSync(getGithubAuthFilePath(), 0o600);
  } catch {}
}

export function clearStoredGithubSession() {
  try {
    rmSync(getGithubAuthFilePath(), { force: true });
  } catch {}
}

export function formatGithubLogin(session: GithubAuthSession | null) {
  return session ? `@${session.user.login}` : "guest";
}

export function getGithubSessionAuthToken(session: GithubAuthSession | null) {
  return session?.workerAuthToken;
}

export async function beginGithubLogin(authServerUrl: string): Promise<GithubPendingLogin> {
  try {
    const deviceCodeResponse = await requestDeviceCodeFromWorker(authServerUrl);

    return {
      deviceLogin: toPublicDeviceLogin(deviceCodeResponse),
      complete: completeWorkerLogin(authServerUrl, deviceCodeResponse),
    };
  } catch (workerError) {
    const clientId = getGithubClientId();

    if (!clientId) {
      throw workerError;
    }

    const deviceCodeResponse = await requestDeviceCodeDirect(clientId);

    return {
      deviceLogin: toPublicDeviceLogin(deviceCodeResponse),
      complete: completeDirectLogin(clientId, deviceCodeResponse),
    };
  }
}
