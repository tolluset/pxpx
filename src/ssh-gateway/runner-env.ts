import path from "node:path";
import type { SpawnOptions } from "node:child_process";
import type { GatewayConfig } from "./config";
import type { AuthIdentity, UserAccount } from "./types";

function readOptionalProcessEnv(name: string) {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function buildRunnerEnvironment(config: GatewayConfig, identity: AuthIdentity, account: UserAccount, term: string) {
  const authFilePath = path.join(config.authRoot, `${identity.fingerprint}.json`);
  const playServerUrl = readOptionalProcessEnv("PIXEL_SERVER_URL");
  const authServerUrl = readOptionalProcessEnv("PIXEL_AUTH_SERVER_URL");

  return {
    HOME: account.home,
    USER: config.runAsUser,
    LOGNAME: config.runAsUser,
    PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    TERM: term,
    COLORTERM: "truecolor",
    XDG_CONFIG_HOME: path.join(account.home, ".config"),
    PIXEL_GITHUB_AUTH_FILE: authFilePath,
    PXPX_SSH_KEY_FINGERPRINT: identity.fingerprint,
    PXPX_SSH_USERNAME: identity.sshUsername,
    PIXEL_DEFAULT_ROOM: config.defaultRoom,
    ...(playServerUrl ? { PIXEL_SERVER_URL: playServerUrl } : {}),
    ...(authServerUrl ? { PIXEL_AUTH_SERVER_URL: authServerUrl } : {}),
  };
}

export function buildSpawnOptions(config: GatewayConfig, account: UserAccount, env: Record<string, string>): SpawnOptions {
  const options: SpawnOptions = {
    cwd: config.workdir,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  };

  if (typeof process.getuid === "function" && process.getuid() === 0) {
    options.uid = account.uid;
    options.gid = account.gid;
  }

  return options;
}
