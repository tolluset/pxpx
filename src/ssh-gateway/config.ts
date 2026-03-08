import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Config, Effect } from "effect";
import {
  FilesystemValidationError,
  formatGatewayError,
  GatewayConfigurationError,
  HostKeysNotFoundError,
} from "./errors";

export type GatewayRawConfig = {
  bindHost: string;
  bindPort: number;
  runAsUser: string;
  runHomeOverride: string;
  workdirOverride: string;
  command: string;
  runner: string;
  authRootOverride: string;
  defaultRoom: string;
  hostKeysRaw: string;
};

export type GatewayConfig = {
  bindHost: string;
  bindPort: number;
  runAsUser: string;
  runHome: string;
  workdir: string;
  command: string;
  runner: string;
  authRoot: string;
  defaultRoom: string;
  hostKeyPaths: string[];
};

const DEFAULT_HOST_KEYS = ["/etc/ssh/ssh_host_ed25519_key", "/etc/ssh/ssh_host_rsa_key"].join(",");
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(MODULE_DIR, "..", "..");

type GatewayConfigBuildContext = {
  currentUsername: string;
  homeDir: string;
};

export function buildGatewayConfig(
  raw: GatewayRawConfig,
  context: GatewayConfigBuildContext,
): GatewayConfig {
  const runHome =
    raw.runHomeOverride.length > 0
      ? raw.runHomeOverride
      : raw.runAsUser === context.currentUsername
        ? context.homeDir
        : path.join("/home", raw.runAsUser);

  const workdir = raw.workdirOverride.length > 0 ? raw.workdirOverride : runHome;
  const authRoot =
    raw.authRootOverride.length > 0
      ? raw.authRootOverride
      : path.join(runHome, ".local", "share", "pxpx-auth");

  const hostKeyPaths = raw.hostKeysRaw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return {
    bindHost: raw.bindHost,
    bindPort: raw.bindPort,
    runAsUser: raw.runAsUser,
    runHome,
    workdir,
    command: raw.command,
    runner: raw.runner,
    authRoot,
    defaultRoom: raw.defaultRoom,
    hostKeyPaths,
  };
}

const GatewayConfigSpec = Config.all({
  bindHost: Config.string("PXPX_GATEWAY_HOST").pipe(Config.withDefault("0.0.0.0")),
  bindPort: Config.number("PXPX_GATEWAY_PORT").pipe(Config.withDefault(22)),
  runAsUser: Config.string("PXPX_GATEWAY_RUN_AS_USER").pipe(Config.withDefault("pxpx")),
  runHomeOverride: Config.string("PXPX_GATEWAY_RUN_HOME").pipe(Config.withDefault("")),
  workdirOverride: Config.string("PXPX_GATEWAY_WORKDIR").pipe(Config.withDefault("")),
  command: Config.string("PXPX_GATEWAY_COMMAND").pipe(Config.withDefault("/usr/local/bin/pxpx")),
  runner: Config.string("PXPX_GATEWAY_RUNNER").pipe(
    Config.withDefault(path.join(REPO_ROOT, "scripts", "ssh-pty-runner.py")),
  ),
  authRootOverride: Config.string("PXPX_GATEWAY_AUTH_ROOT").pipe(Config.withDefault("")),
  defaultRoom: Config.string("PXPX_GATEWAY_DEFAULT_ROOM").pipe(Config.withDefault("tolluset/pxpx")),
  hostKeysRaw: Config.string("PXPX_GATEWAY_HOST_KEYS").pipe(Config.withDefault(DEFAULT_HOST_KEYS)),
}).pipe(
  Config.map((raw: GatewayRawConfig): GatewayConfig =>
    buildGatewayConfig(raw, {
      currentUsername: os.userInfo().username,
      homeDir: os.homedir(),
    })),
);

function requireExistingPath(filePath: string, label: string) {
  if (!existsSync(filePath)) {
    throw new FilesystemValidationError({
      label,
      filePath,
      message: `${label} not found at ${filePath}`,
    });
  }
}

export const loadGatewayConfig = Effect.gen(function* () {
  return yield* GatewayConfigSpec;
}).pipe(
  Effect.mapError(
    (cause) =>
      new GatewayConfigurationError({
        message: `Failed to load gateway configuration: ${String(cause)}`,
      }),
  ),
);

export function validateGatewayPaths(config: GatewayConfig) {
  return Effect.sync(() => {
    requireExistingPath(config.command, "pxpx binary");
    requireExistingPath(config.runner, "PTY runner");
  });
}

export function readHostKeys(config: GatewayConfig) {
  return Effect.try({
    try: () => {
      const hostKeys = config.hostKeyPaths.filter((filePath) => existsSync(filePath)).map((filePath) => readFileSync(filePath));

      if (hostKeys.length === 0) {
        throw new HostKeysNotFoundError({
          checkedPaths: config.hostKeyPaths,
          message: `No SSH host keys found. Checked: ${config.hostKeyPaths.join(", ")}`,
        });
      }

      return hostKeys;
    },
    catch: (cause) =>
      cause instanceof HostKeysNotFoundError
        ? cause
        : new FilesystemValidationError({
            label: "SSH host keys",
            filePath: config.hostKeyPaths.join(", "),
            message: `Failed to read SSH host keys: ${formatGatewayError(cause)}`,
          }),
  });
}
