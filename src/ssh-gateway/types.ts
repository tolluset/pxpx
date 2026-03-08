import type { PseudoTtyInfo } from "ssh2";
import type { GatewayConfig } from "./config";

export type AuthIdentity = {
  fingerprint: string;
  sshUsername: string;
};

export type CommandPlan = {
  args: string[];
  interactive: boolean;
};

export type UserAccount = {
  uid: number;
  gid: number;
  home: string;
};

export type ControlChannel = {
  socketPath: string;
  close: () => void;
  updateWindow: (rows: number, cols: number) => void;
};

export type ExecutionHandle = {
  updateWindow: (rows: number, cols: number) => void;
};

export type PtyState = PseudoTtyInfo & {
  term?: string;
};

export type GatewayRuntime = {
  config: GatewayConfig;
  hostKeys: Buffer[];
  runAccount: UserAccount;
};
