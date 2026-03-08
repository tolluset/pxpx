import { Effect } from "effect";
import { resolveUserAccount } from "./account";
import { loadGatewayConfig, readHostKeys, validateGatewayPaths } from "./config";
import { formatGatewayError } from "./errors";
import { listenGatewayServer } from "./server";

const bootstrapGateway = Effect.scoped(
  Effect.gen(function* () {
    const config = yield* loadGatewayConfig;
    yield* validateGatewayPaths(config);
    const hostKeys = yield* readHostKeys(config);
    const runAccount = yield* resolveUserAccount(config);

    yield* listenGatewayServer({
      config,
      hostKeys,
      runAccount,
    });

    yield* Effect.never;
  }),
);

export function runGatewayMain() {
  return Effect.runPromise(bootstrapGateway).catch((error) => {
    console.error(`[pxpx-ssh] ${formatGatewayError(error)}`);
    process.exitCode = 1;
  });
}

if (import.meta.main) {
  void runGatewayMain();
}
