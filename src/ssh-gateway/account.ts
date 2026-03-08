import { spawnSync } from "node:child_process";
import { Effect } from "effect";
import { formatGatewayError, UserAccountLookupError } from "./errors";
import type { GatewayConfig } from "./config";
import type { UserAccount } from "./types";

function runCommandOrThrow(command: string, args: string[], username: string) {
  const result = spawnSync(command, args, { encoding: "utf8" });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    throw new UserAccountLookupError({
      username,
      message: stderr || `failed to run ${command} ${args.join(" ")}`,
    });
  }

  return result.stdout.trim();
}

export function resolveUserAccount(config: GatewayConfig) {
  return Effect.try({
    try: (): UserAccount => {
      const uid = Number.parseInt(runCommandOrThrow("id", ["-u", config.runAsUser], config.runAsUser), 10);
      const gid = Number.parseInt(runCommandOrThrow("id", ["-g", config.runAsUser], config.runAsUser), 10);

      if (!Number.isInteger(uid) || !Number.isInteger(gid)) {
        throw new UserAccountLookupError({
          username: config.runAsUser,
          message: `failed to resolve uid/gid for ${config.runAsUser}`,
        });
      }

      return {
        uid,
        gid,
        home: config.runHome,
      };
    },
    catch: (cause) =>
      cause instanceof UserAccountLookupError
        ? cause
        : new UserAccountLookupError({
            username: config.runAsUser,
            message: formatGatewayError(cause),
          }),
  });
}
