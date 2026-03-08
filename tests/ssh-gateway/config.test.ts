import { describe, expect, test } from "bun:test";
import { buildGatewayConfig, type GatewayRawConfig } from "../../src/ssh-gateway/config";

function makeRawConfig(overrides: Partial<GatewayRawConfig> = {}): GatewayRawConfig {
  return {
    bindHost: "0.0.0.0",
    bindPort: 22,
    runAsUser: "pxpx",
    runHomeOverride: "",
    workdirOverride: "",
    command: "/usr/local/bin/pxpx",
    runner: "/workspace/scripts/ssh-pty-runner.py",
    authRootOverride: "",
    defaultRoom: "tolluset/pxpx",
    hostKeysRaw: "/etc/ssh/a,/etc/ssh/b",
    ...overrides,
  };
}

describe("buildGatewayConfig", () => {
  test("uses the current user's home directory when runAsUser matches", () => {
    const config = buildGatewayConfig(makeRawConfig({ runAsUser: "bh" }), {
      currentUsername: "bh",
      homeDir: "/Users/bh",
    });

    expect(config.runHome).toBe("/Users/bh");
    expect(config.workdir).toBe("/Users/bh");
    expect(config.authRoot).toBe("/Users/bh/.local/share/pxpx-auth");
  });

  test("defaults to /home/<user> for a dedicated service account", () => {
    const config = buildGatewayConfig(makeRawConfig({ runAsUser: "pxpx" }), {
      currentUsername: "bh",
      homeDir: "/Users/bh",
    });

    expect(config.runHome).toBe("/home/pxpx");
    expect(config.workdir).toBe("/home/pxpx");
    expect(config.authRoot).toBe("/home/pxpx/.local/share/pxpx-auth");
  });

  test("respects explicit overrides", () => {
    const config = buildGatewayConfig(
      makeRawConfig({
        runHomeOverride: "/srv/pxpx",
        workdirOverride: "/srv/pxpx/app",
        authRootOverride: "/srv/pxpx/auth",
      }),
      {
        currentUsername: "bh",
        homeDir: "/Users/bh",
      },
    );

    expect(config.runHome).toBe("/srv/pxpx");
    expect(config.workdir).toBe("/srv/pxpx/app");
    expect(config.authRoot).toBe("/srv/pxpx/auth");
  });

  test("splits and trims host key paths", () => {
    const config = buildGatewayConfig(
      makeRawConfig({
        hostKeysRaw: " /etc/ssh/first , , /etc/ssh/second ",
      }),
      {
        currentUsername: "bh",
        homeDir: "/Users/bh",
      },
    );

    expect(config.hostKeyPaths).toEqual(["/etc/ssh/first", "/etc/ssh/second"]);
  });
});
