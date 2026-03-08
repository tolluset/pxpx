import { afterEach, describe, expect, test } from "bun:test";
import { buildRunnerEnvironment } from "../../src/ssh-gateway/runner-env";

const originalPixelServerUrl = process.env.PIXEL_SERVER_URL;
const originalPixelAuthServerUrl = process.env.PIXEL_AUTH_SERVER_URL;

afterEach(() => {
  if (originalPixelServerUrl === undefined) {
    delete process.env.PIXEL_SERVER_URL;
  } else {
    process.env.PIXEL_SERVER_URL = originalPixelServerUrl;
  }

  if (originalPixelAuthServerUrl === undefined) {
    delete process.env.PIXEL_AUTH_SERVER_URL;
  } else {
    process.env.PIXEL_AUTH_SERVER_URL = originalPixelAuthServerUrl;
  }
});

describe("buildRunnerEnvironment", () => {
  test("passes hosted worker URLs through to the child process", () => {
    process.env.PIXEL_SERVER_URL = "wss://pixel-game-collab.example.workers.dev";
    process.env.PIXEL_AUTH_SERVER_URL = "wss://pixel-game-collab.example.workers.dev";

    const env = buildRunnerEnvironment(
      {
        bindHost: "0.0.0.0",
        bindPort: 22,
        runAsUser: "pxpx",
        runHome: "/home/pxpx",
        workdir: "/home/pxpx",
        command: "/usr/local/bin/pxpx",
        runner: "/workspace/scripts/ssh-pty-runner.py",
        authRoot: "/home/pxpx/.local/share/pxpx-auth",
        defaultRoom: "tolluset/pxpx",
        hostKeyPaths: ["/etc/ssh/ssh_host_ed25519_key"],
      },
      {
        fingerprint: "abc123",
        sshUsername: "bh",
      },
      {
        uid: 1001,
        gid: 1001,
        home: "/home/pxpx",
      },
      "xterm-256color",
    );

    expect(env.PIXEL_SERVER_URL).toBe("wss://pixel-game-collab.example.workers.dev");
    expect(env.PIXEL_AUTH_SERVER_URL).toBe("wss://pixel-game-collab.example.workers.dev");
    expect(env.PIXEL_GITHUB_AUTH_FILE).toBe("/home/pxpx/.local/share/pxpx-auth/abc123.json");
    expect(env.PIXEL_DEFAULT_ROOM).toBe("tolluset/pxpx");
  });
});
