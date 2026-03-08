import { rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { sanitizePtyWindow } from "./pty";
import type { ControlChannel } from "./types";

export function createControlChannel(initialRows: number, initialCols: number): ControlChannel {
  const socketPath = path.join(
    os.tmpdir(),
    `pxpx-ssh-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
  );
  const server = net.createServer();
  let controlSocket: net.Socket | null = null;
  let currentWindow = sanitizePtyWindow(initialRows, initialCols);
  let pendingWindow = `${currentWindow.rows} ${currentWindow.cols}\n`;

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
      currentWindow = sanitizePtyWindow(rows, cols, currentWindow);
      const payload = `${currentWindow.rows} ${currentWindow.cols}\n`;

      if (controlSocket) {
        controlSocket.write(payload);
        return;
      }

      pendingWindow = payload;
    },
  };
}

export function acquireControlChannel(initialRows: number, initialCols: number) {
  return Effect.acquireRelease(
    Effect.sync(() => createControlChannel(initialRows, initialCols)),
    (control) =>
      Effect.sync(() => {
        control.close();
      }),
  );
}
