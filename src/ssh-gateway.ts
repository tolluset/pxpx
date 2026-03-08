import { spawn, spawnSync, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Server,
  utils,
  type AuthContext,
  type ExecInfo,
  type ParsedKey,
  type PseudoTtyInfo,
  type PublicKeyAuthContext,
  type ServerChannel,
  type Session,
} from "ssh2";

type AuthIdentity = {
  fingerprint: string;
  sshUsername: string;
};

type CommandPlan = {
  args: string[];
  interactive: boolean;
};

type UserAccount = {
  uid: number;
  gid: number;
  home: string;
};

type ControlChannel = {
  socketPath: string;
  close: () => void;
  updateWindow: (rows: number, cols: number) => void;
};

type PtyState = PseudoTtyInfo & {
  term?: string;
};

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(MODULE_DIR, "..");
const DEFAULT_BIND_HOST = process.env.PXPX_GATEWAY_HOST ?? "0.0.0.0";
const DEFAULT_BIND_PORT = Number.parseInt(process.env.PXPX_GATEWAY_PORT ?? "22", 10);
const DEFAULT_RUN_AS_USER = process.env.PXPX_GATEWAY_RUN_AS_USER ?? "pxpx";
const DEFAULT_RUN_HOME =
  process.env.PXPX_GATEWAY_RUN_HOME ??
  (DEFAULT_RUN_AS_USER === os.userInfo().username ? os.homedir() : path.join("/home", DEFAULT_RUN_AS_USER));
const DEFAULT_WORKDIR = process.env.PXPX_GATEWAY_WORKDIR ?? DEFAULT_RUN_HOME;
const DEFAULT_COMMAND = process.env.PXPX_GATEWAY_COMMAND ?? "/usr/local/bin/pxpx";
const DEFAULT_RUNNER = process.env.PXPX_GATEWAY_RUNNER ?? path.join(REPO_ROOT, "scripts", "ssh-pty-runner.py");
const DEFAULT_AUTH_ROOT =
  process.env.PXPX_GATEWAY_AUTH_ROOT ?? path.join(DEFAULT_RUN_HOME, ".local", "share", "pxpx-auth");
const DEFAULT_ROOM_NAME = process.env.PXPX_GATEWAY_DEFAULT_ROOM ?? "pixel-game";
const HOST_KEY_PATHS = (process.env.PXPX_GATEWAY_HOST_KEYS ??
  ["/etc/ssh/ssh_host_ed25519_key", "/etc/ssh/ssh_host_rsa_key"].join(","))
  .split(",")
  .map((value) => value.trim())
  .filter((value) => value.length > 0);

const REPO_SLUG_PATTERN = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i;
const GITHUB_LOGIN_PATTERN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;
const ALLOWED_ACCESS_ACTIONS = new Set(["status", "enable", "disable", "grant", "revoke"]);

function log(message: string, extra?: Record<string, string | number | boolean | undefined>) {
  const details = extra
    ? Object.entries(extra)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join(" ")
    : "";

  console.log(`[pxpx-ssh] ${message}${details ? ` ${details}` : ""}`);
}

function exitWithConfigurationError(message: string): never {
  console.error(`[pxpx-ssh] ${message}`);
  process.exit(1);
}

function readHostKeys() {
  const hostKeys = HOST_KEY_PATHS.filter((filePath) => existsSync(filePath)).map((filePath) => readFileSync(filePath));

  if (hostKeys.length === 0) {
    exitWithConfigurationError(
      `No SSH host keys found. Checked: ${HOST_KEY_PATHS.join(", ")}`,
    );
  }

  return hostKeys;
}

function requireExistingPath(filePath: string, label: string) {
  if (!existsSync(filePath)) {
    exitWithConfigurationError(`${label} not found at ${filePath}`);
  }
}

function runCommandOrThrow(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: "utf8" });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    throw new Error(stderr || `failed to run ${command} ${args.join(" ")}`);
  }

  return result.stdout.trim();
}

function resolveUserAccount(username: string): UserAccount {
  const uid = Number.parseInt(runCommandOrThrow("id", ["-u", username]), 10);
  const gid = Number.parseInt(runCommandOrThrow("id", ["-g", username]), 10);

  if (!Number.isInteger(uid) || !Number.isInteger(gid)) {
    throw new Error(`failed to resolve uid/gid for ${username}`);
  }

  return {
    uid,
    gid,
    home: DEFAULT_RUN_HOME,
  };
}

function sanitizeGithubLogin(value: string) {
  const normalized = value.trim().replace(/^@/, "").toLowerCase();

  if (!GITHUB_LOGIN_PATTERN.test(normalized)) {
    throw new Error("github-login must be a valid GitHub handle");
  }

  return normalized;
}

function sanitizeRepoSlug(value: string) {
  const normalized = value
    .trim()
    .replace(/^@/, "")
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^ssh:\/\/git@github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/^github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();

  if (!REPO_SLUG_PATTERN.test(normalized)) {
    throw new Error("repository selector must use owner/repo format");
  }

  return normalized;
}

function tokenizeCommand(command: string) {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }

    if ((char === "'" || char === '"') && !quote) {
      quote = char;
      continue;
    }

    if (quote && char === quote) {
      quote = null;
      continue;
    }

    if (!quote && /\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaped || quote) {
    throw new Error("command contains an unterminated escape or quote");
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function resolveCommandPlan(command?: string): CommandPlan {
  if (!command || command.trim().length === 0) {
    return {
      args: [],
      interactive: true,
    };
  }

  const tokens = tokenizeCommand(command);

  if (tokens.length === 0) {
    return {
      args: [],
      interactive: true,
    };
  }

  if (tokens.length === 1 && (tokens[0] === "-h" || tokens[0] === "--help")) {
    return {
      args: tokens,
      interactive: false,
    };
  }

  if (tokens.length === 1 && REPO_SLUG_PATTERN.test(tokens[0])) {
    return {
      args: [sanitizeRepoSlug(tokens[0])],
      interactive: true,
    };
  }

  if (tokens.length === 1 && (tokens[0] === "login" || tokens[0] === "logout" || tokens[0] === "whoami")) {
    return {
      args: tokens,
      interactive: false,
    };
  }

  if (tokens[0] !== "access") {
    throw new Error("unsupported command. Use an empty command, owner/repo, login, logout, whoami, or access.");
  }

  const action = tokens[1];

  if (!action || !ALLOWED_ACCESS_ACTIONS.has(action)) {
    throw new Error("access requires one of: status, enable, disable, grant, revoke");
  }

  if (!tokens[2]) {
    throw new Error("access requires owner/repo");
  }

  const args = ["access", action, sanitizeRepoSlug(tokens[2])];

  if ((action === "grant" || action === "revoke")) {
    if (!tokens[3]) {
      throw new Error(`${action} requires a GitHub login`);
    }

    args.push(sanitizeGithubLogin(tokens[3]));

    if (tokens.length > 4) {
      throw new Error("unexpected extra arguments");
    }
  } else if (tokens.length > 3) {
    throw new Error("unexpected extra arguments");
  }

  return {
    args,
    interactive: false,
  };
}

function getPublicKeyFingerprint(publicKey: Buffer) {
  return createHash("sha256").update(publicKey).digest("hex");
}

function parsePresentedPublicKey(context: PublicKeyAuthContext) {
  const parsedKey = utils.parseKey(context.key.data);

  if (parsedKey instanceof Error) {
    return null;
  }

  return parsedKey as ParsedKey;
}

function verifyPublicKey(context: PublicKeyAuthContext, parsedKey: ParsedKey) {
  if (!context.signature || !context.blob) {
    return true;
  }

  return parsedKey.verify(context.blob, context.signature, context.hashAlgo) === true;
}

function buildIdentity(context: PublicKeyAuthContext): AuthIdentity {
  return {
    fingerprint: getPublicKeyFingerprint(context.key.data),
    sshUsername: context.username,
  };
}

function buildRunnerEnvironment(identity: AuthIdentity, account: UserAccount, term: string) {
  const authFilePath = path.join(DEFAULT_AUTH_ROOT, `${identity.fingerprint}.json`);

  return {
    HOME: account.home,
    USER: DEFAULT_RUN_AS_USER,
    LOGNAME: DEFAULT_RUN_AS_USER,
    PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    TERM: term,
    COLORTERM: "truecolor",
    XDG_CONFIG_HOME: path.join(account.home, ".config"),
    PIXEL_GITHUB_AUTH_FILE: authFilePath,
    PXPX_SSH_KEY_FINGERPRINT: identity.fingerprint,
    PXPX_SSH_USERNAME: identity.sshUsername,
    PIXEL_DEFAULT_ROOM: DEFAULT_ROOM_NAME,
  };
}

function createControlChannel(initialRows: number, initialCols: number): ControlChannel {
  const socketPath = path.join(
    os.tmpdir(),
    `pxpx-ssh-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
  );
  const server = net.createServer();
  let controlSocket: net.Socket | null = null;
  let pendingWindow = `${initialRows} ${initialCols}\n`;

  server.on("connection", (socket) => {
    controlSocket = socket;
    if (pendingWindow.length > 0) {
      socket.write(pendingWindow);
      pendingWindow = "";
    }

    socket.on("close", () => {
      if (controlSocket === socket) {
        controlSocket = null;
      }
    });
  });

  server.listen(socketPath);

  return {
    socketPath,
    close() {
      controlSocket?.destroy();
      server.close();
      rmSync(socketPath, { force: true });
    },
    updateWindow(rows, cols) {
      const payload = `${rows} ${cols}\n`;

      if (controlSocket) {
        controlSocket.write(payload);
        return;
      }

      pendingWindow = payload;
    },
  };
}

function buildSpawnOptions(account: UserAccount, env: Record<string, string>): SpawnOptions {
  const options: SpawnOptions = {
    cwd: DEFAULT_WORKDIR,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  };

  if (typeof process.getuid === "function" && process.getuid() === 0) {
    options.uid = account.uid;
    options.gid = account.gid;
  }

  return options;
}

function writeErrorAndExit(channel: ServerChannel, message: string) {
  channel.stderr.write(`${message}\n`);
  channel.exit(1);
  channel.end();
}

function bridgeStreams(
  channel: ServerChannel,
  child: ChildProcessWithoutNullStreams,
  onClose: () => void,
) {
  let closed = false;

  const closeChannel = (code?: number | null) => {
    if (closed) {
      return;
    }

    closed = true;
    onClose();
    channel.exit(typeof code === "number" ? code : 1);
    channel.end();
  };

  child.stdout.on("data", (chunk: Buffer) => {
    channel.write(chunk);
  });

  child.stderr.on("data", (chunk: Buffer) => {
    channel.stderr.write(chunk);
  });

  channel.on("data", (chunk: Buffer) => {
    child.stdin.write(chunk);
  });

  channel.on("end", () => {
    child.stdin.end();
  });

  channel.on("close", () => {
    child.kill("SIGTERM");
    closeChannel(child.exitCode);
  });

  child.on("error", (error) => {
    channel.stderr.write(`Failed to start pxpx: ${error.message}\n`);
    closeChannel(1);
  });

  child.on("close", (code) => {
    closeChannel(code);
  });
}

function launchPlainCommand(channel: ServerChannel, plan: CommandPlan, identity: AuthIdentity, account: UserAccount) {
  const env = buildRunnerEnvironment(identity, account, "xterm-256color");
  const child = spawn(DEFAULT_COMMAND, plan.args, buildSpawnOptions(account, env)) as ChildProcessWithoutNullStreams;

  bridgeStreams(channel, child, () => {});
}

function launchInteractiveCommand(
  channel: ServerChannel,
  plan: CommandPlan,
  identity: AuthIdentity,
  account: UserAccount,
  ptyInfo: PseudoTtyInfo,
) {
  const env = buildRunnerEnvironment(identity, account, (ptyInfo as PtyState).term ?? "xterm-256color");
  const control = createControlChannel(ptyInfo.rows, ptyInfo.cols);
  const runnerArgs = [
    DEFAULT_RUNNER,
    "--rows",
    String(ptyInfo.rows),
    "--cols",
    String(ptyInfo.cols),
    "--cwd",
    DEFAULT_WORKDIR,
    "--uid",
    String(account.uid),
    "--gid",
    String(account.gid),
    "--control-socket",
    control.socketPath,
    "--",
    DEFAULT_COMMAND,
    ...plan.args,
  ];

  const runner = spawn("python3", runnerArgs, {
    cwd: DEFAULT_WORKDIR,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;

  bridgeStreams(channel, runner, () => {
    control.close();
  });

  return {
    updateWindow(rows: number, cols: number) {
      control.updateWindow(rows, cols);
    },
  };
}

function handleExecution(
  channel: ServerChannel,
  identity: AuthIdentity,
  account: UserAccount,
  command: string | undefined,
  ptyInfo: PseudoTtyInfo | null,
) {
  try {
    const plan = resolveCommandPlan(command);

    if (plan.interactive) {
      if (!ptyInfo) {
        writeErrorAndExit(channel, "Interactive board sessions require a TTY. Use `ssh -t pxpx.sh owner/repo`.");
        return { updateWindow: (_rows: number, _cols: number) => {} };
      }

      return launchInteractiveCommand(channel, plan, identity, account, ptyInfo);
    }

    launchPlainCommand(channel, plan, identity, account);
    return { updateWindow: (_rows: number, _cols: number) => {} };
  } catch (error) {
    writeErrorAndExit(channel, `Error: ${(error as Error).message}`);
    return { updateWindow: (_rows: number, _cols: number) => {} };
  }
}

requireExistingPath(DEFAULT_COMMAND, "pxpx binary");
requireExistingPath(DEFAULT_RUNNER, "PTY runner");

const hostKeys = readHostKeys();
const runAccount = resolveUserAccount(DEFAULT_RUN_AS_USER);

const server = new Server(
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

        log("client authenticated", {
          fingerprint: sessionIdentity.fingerprint.slice(0, 12),
          sshUsername: sessionIdentity.sshUsername,
        });

        client.on("request", (_accept, reject) => {
          reject?.();
        });

        client.on("tcpip", (_accept, reject) => {
          reject();
        });

        client.on("openssh.streamlocal", (_accept, reject) => {
          reject();
        });

        client.on("session", (accept) => {
          const session = accept();
          let ptyInfo: PseudoTtyInfo | null = null;
          let execution = { updateWindow: (_rows: number, _cols: number) => {} };

          session.on("pty", (sessionAccept, _reject, info) => {
            ptyInfo = info;
            sessionAccept?.();
          });

          session.on("window-change", (sessionAccept, _reject, info) => {
            ptyInfo = {
              ...(ptyInfo ?? {
                term: "xterm-256color",
                modes: {},
                width: info.width,
                height: info.height,
                rows: info.rows,
                cols: info.cols,
              }),
              width: info.width,
              height: info.height,
              rows: info.rows,
              cols: info.cols,
            };
            execution.updateWindow(info.rows, info.cols);
            sessionAccept?.();
          });

          session.on("env", (_sessionAccept, sessionReject) => {
            sessionReject?.();
          });

          session.on("auth-agent", (_sessionAccept, sessionReject) => {
            sessionReject?.();
          });

          session.on("x11", (_sessionAccept, sessionReject) => {
            sessionReject?.();
          });

          session.on("sftp", (_sessionAccept, sessionReject) => {
            sessionReject?.();
          });

          session.on("shell", (sessionAccept) => {
            const channel = sessionAccept();
            execution = handleExecution(channel, sessionIdentity, runAccount, undefined, ptyInfo);
          });

          session.on("exec", (sessionAccept, _sessionReject, info: ExecInfo) => {
            const channel = sessionAccept();
            execution = handleExecution(channel, sessionIdentity, runAccount, info.command, ptyInfo);
          });
        });
      })
      .on("close", () => {
        if (!identity) {
          return;
        }

        log("client disconnected", {
          fingerprint: identity.fingerprint.slice(0, 12),
          sshUsername: identity.sshUsername,
        });
      })
      .on("error", (error) => {
        log("client error", {
          error: error.message,
        });
      });
  },
);

server.listen(DEFAULT_BIND_PORT, DEFAULT_BIND_HOST, () => {
  log("gateway listening", {
    host: DEFAULT_BIND_HOST,
    port: DEFAULT_BIND_PORT,
    defaultRoom: DEFAULT_ROOM_NAME,
    runAsUser: DEFAULT_RUN_AS_USER,
  });
});
