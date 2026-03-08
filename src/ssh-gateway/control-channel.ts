import { rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { Effect } from "effect";
import { sanitizePtyWindow } from "./pty";
import type { ControlChannel } from "./types";

type WritableControlSocket = Pick<net.Socket, "destroyed" | "writableEnded" | "write">;

function isIgnorableSocketWriteError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  const code = "code" in error ? String(error.code) : "";

  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED";
}

function buildSocketPath() {
  const filename = `pxpx-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}.sock`;
  return path.join("/tmp", filename);
}

export function tryWriteControlSocket(socket: WritableControlSocket, payload: string) {
  if (socket.destroyed || socket.writableEnded) {
    return false;
  }

  try {
    socket.write(payload);
    return true;
  } catch (error) {
    if (isIgnorableSocketWriteError(error)) {
      return false;
    }

    throw error;
  }
}

export function createControlChannel(initialRows: number, initialCols: number): ControlChannel {
  const socketPath = buildSocketPath();
  const server = net.createServer();
  let controlSocket: net.Socket | null = null;
  let currentWindow = sanitizePtyWindow(initialRows, initialCols);
  let pendingWindow = `${currentWindow.rows} ${currentWindow.cols}\n`;

  function clearControlSocket(socket: net.Socket) {
    if (controlSocket === socket) {
      controlSocket = null;
    }
  }

  function writeToControlSocket(socket: net.Socket, payload: string) {
    if (!tryWriteControlSocket(socket, payload)) {
      clearControlSocket(socket);
      return false;
    }

    return true;
  }

  server.on("connection", (socket) => {
    controlSocket = socket;
    if (pendingWindow.length > 0) {
      if (writeToControlSocket(socket, pendingWindow)) {
        pendingWindow = "";
      }
    }

    socket.on("error", () => {
      clearControlSocket(socket);
    });

    socket.on("close", () => {
      clearControlSocket(socket);
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
        if (writeToControlSocket(controlSocket, payload)) {
          return;
        }
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
