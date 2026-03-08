import { Effect } from "effect";
import { Server, type AuthContext, type ExecInfo, type PseudoTtyInfo } from "ssh2";
import { buildIdentity, parsePresentedPublicKey, verifyPublicKey } from "./auth";
import { logGateway } from "./logger";
import { attachSessionHandlers } from "./session";
import type { AuthIdentity, GatewayRuntime } from "./types";

export function createGatewayServer({ config, hostKeys, runAccount }: GatewayRuntime) {
  return new Server(
    {
      hostKeys,
      ident: "SSH-2.0-pxpx",
      banner: "pxpx terminal gateway",
    },
    (client) => {
      let identity: AuthIdentity | null = null;

      client
        .on("authentication", (context: AuthContext) => {
          if (context.method !== "publickey") {
            context.reject(["publickey"]);
            return;
          }

          const parsedKey = parsePresentedPublicKey(context);

          if (!parsedKey || parsedKey.type !== context.key.algo || parsedKey.getPublicSSH().compare(context.key.data) !== 0) {
            context.reject(["publickey"]);
            return;
          }

          if (context.signature && !verifyPublicKey(context, parsedKey)) {
            context.reject(["publickey"]);
            return;
          }

          if (context.signature) {
            identity = buildIdentity(context);
          }

          context.accept();
        })
        .on("ready", () => {
          if (!identity) {
            client.end();
            return;
          }

          const sessionIdentity = identity;

          logGateway("client authenticated", {
            fingerprint: sessionIdentity.fingerprint.slice(0, 12),
            sshUsername: sessionIdentity.sshUsername,
          });

          attachSessionHandlers(client, config, sessionIdentity, runAccount);
        })
        .on("close", () => {
          if (!identity) {
            return;
          }

          logGateway("client disconnected", {
            fingerprint: identity.fingerprint.slice(0, 12),
            sshUsername: identity.sshUsername,
          });
        })
        .on("error", (error) => {
          logGateway("client error", {
            error: error.message,
          });
        });
    },
  );
}

export function listenGatewayServer(runtime: GatewayRuntime) {
  return Effect.acquireRelease(
    Effect.async<Server, Error>((resume) => {
      const server = createGatewayServer(runtime);
      const onError = (error: Error) => {
        server.off("error", onError);
        resume(Effect.fail(error));
      };

      server.once("error", onError);
      server.listen(runtime.config.bindPort, runtime.config.bindHost, () => {
        server.off("error", onError);
        logGateway("gateway listening", {
          host: runtime.config.bindHost,
          port: runtime.config.bindPort,
          defaultRoom: runtime.config.defaultRoom,
          runAsUser: runtime.config.runAsUser,
        });
        resume(Effect.succeed(server));
      });

      return Effect.sync(() => {
        server.off("error", onError);
        if (server.listening) {
          server.close();
        }
      });
    }),
    (server) =>
      Effect.async<void, never>((resume) => {
        if (!server.listening) {
          resume(Effect.void);
          return;
        }

        server.close(() => {
          resume(Effect.void);
        });
      }),
  );
}
