import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolveCommandPlan } from "./command-plan";
import type { GatewayConfig } from "./config";
import { formatGatewayError } from "./errors";
import { createControlChannel } from "./control-channel";
import { buildRunnerEnvironment, buildSpawnOptions } from "./runner-env";
import type { AuthIdentity, CommandPlan, ExecutionHandle, PtyState, UserAccount } from "./types";
import type { PseudoTtyInfo, ServerChannel } from "ssh2";

const NOOP_EXECUTION_HANDLE: ExecutionHandle = {
  updateWindow: (_rows: number, _cols: number) => {},
};

export function writeErrorAndExit(channel: ServerChannel, message: string) {
  channel.stderr.write(`${message}\n`);
  channel.exit(1);
  channel.end();
}

export function bridgeStreams(
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

export function launchPlainCommand(
  config: GatewayConfig,
  channel: ServerChannel,
  plan: CommandPlan,
  identity: AuthIdentity,
  account: UserAccount,
) {
  const env = buildRunnerEnvironment(config, identity, account, "xterm-256color");
  const child = spawn(config.command, plan.args, buildSpawnOptions(config, account, env)) as ChildProcessWithoutNullStreams;

  bridgeStreams(channel, child, () => {});
}

export function launchInteractiveCommand(
  config: GatewayConfig,
  channel: ServerChannel,
  plan: CommandPlan,
  identity: AuthIdentity,
  account: UserAccount,
  ptyInfo: PseudoTtyInfo,
): ExecutionHandle {
  const env = buildRunnerEnvironment(config, identity, account, (ptyInfo as PtyState).term ?? "xterm-256color");
  const control = createControlChannel(ptyInfo.rows, ptyInfo.cols);
  const runnerArgs = [
    config.runner,
    "--rows",
    String(ptyInfo.rows),
    "--cols",
    String(ptyInfo.cols),
    "--cwd",
    config.workdir,
    "--uid",
    String(account.uid),
    "--gid",
    String(account.gid),
    "--control-socket",
    control.socketPath,
    "--",
    config.command,
    ...plan.args,
  ];

  const runner = spawn("python3", runnerArgs, {
    cwd: config.workdir,
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

export function handleExecution(
  config: GatewayConfig,
  channel: ServerChannel,
  identity: AuthIdentity,
  account: UserAccount,
  command: string | undefined,
  ptyInfo: PseudoTtyInfo | null,
): ExecutionHandle {
  try {
    const plan = resolveCommandPlan(command);

    if (plan.interactive) {
      if (!ptyInfo) {
        writeErrorAndExit(channel, "Interactive board sessions require a TTY. Use `ssh -t pxpx.sh owner/repo`.");
        return NOOP_EXECUTION_HANDLE;
      }

      return launchInteractiveCommand(config, channel, plan, identity, account, ptyInfo);
    }

    launchPlainCommand(config, channel, plan, identity, account);
    return NOOP_EXECUTION_HANDLE;
  } catch (error) {
    writeErrorAndExit(channel, `Error: ${formatGatewayError(error)}`);
    return NOOP_EXECUTION_HANDLE;
  }
}
