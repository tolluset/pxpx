import type { Connection, ExecInfo, PseudoTtyInfo } from "ssh2";
import { handleExecution } from "./child-process";
import { sanitizePtyInfo } from "./pty";
import type { AuthIdentity, ExecutionHandle, UserAccount } from "./types";
import type { GatewayConfig } from "./config";

const NOOP_EXECUTION_HANDLE: ExecutionHandle = {
  updateWindow: (_rows: number, _cols: number) => {},
};

export function attachSessionHandlers(
  client: Connection,
  config: GatewayConfig,
  identity: AuthIdentity,
  runAccount: UserAccount,
) {
  client.on("request", (_accept, reject, _name, _info) => {
    reject?.();
  });

  client.on("tcpip", (_accept, reject, _info) => {
    reject();
  });

  client.on("openssh.streamlocal", (_accept, reject, _info) => {
    reject();
  });

  client.on("session", (accept, _reject) => {
    const session = accept();
    let ptyInfo: PseudoTtyInfo | null = null;
    let execution: ExecutionHandle = NOOP_EXECUTION_HANDLE;

    session.on("pty", (sessionAccept, _sessionReject, info) => {
      ptyInfo = sanitizePtyInfo(info, ptyInfo ?? undefined);
      sessionAccept?.();
    });

    session.on("window-change", (sessionAccept, _sessionReject, info) => {
      ptyInfo = sanitizePtyInfo(
        {
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
        },
        ptyInfo ?? undefined,
      );
      execution.updateWindow(ptyInfo.rows, ptyInfo.cols);
      sessionAccept?.();
    });

    session.on("env", (_sessionAccept, sessionReject, _info) => {
      sessionReject?.();
    });

    session.on("auth-agent", (_sessionAccept, sessionReject) => {
      sessionReject?.();
    });

    session.on("x11", (_sessionAccept, sessionReject, _info) => {
      sessionReject?.();
    });

    session.on("sftp", (_sessionAccept, sessionReject) => {
      sessionReject?.();
    });

    session.on("shell", (sessionAccept, _sessionReject) => {
      const channel = sessionAccept();
      execution = handleExecution(config, channel, identity, runAccount, undefined, ptyInfo);
    });

    session.on("exec", (sessionAccept, _sessionReject, info: ExecInfo) => {
      const channel = sessionAccept();
      execution = handleExecution(config, channel, identity, runAccount, info.command, ptyInfo);
    });
  });
}
