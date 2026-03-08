import { describe, expect, test } from "bun:test";
import { tryWriteControlSocket } from "../../src/ssh-gateway/control-channel";

describe("tryWriteControlSocket", () => {
  test("writes to an open socket", () => {
    const writes: string[] = [];
    const socket = {
      destroyed: false,
      writableEnded: false,
      write(payload: string) {
        writes.push(payload);
        return true;
      },
    };

    expect(tryWriteControlSocket(socket, "24 80\n")).toBe(true);
    expect(writes).toEqual(["24 80\n"]);
  });

  test("returns false for sockets that are already ended", () => {
    const socket = {
      destroyed: false,
      writableEnded: true,
      write() {
        throw new Error("should not be called");
      },
    };

    expect(tryWriteControlSocket(socket, "40 100\n")).toBe(false);
  });

  test("returns false for ignorable EPIPE writes", () => {
    const socket = {
      destroyed: false,
      writableEnded: false,
      write() {
        const error = new Error("ended");
        (error as Error & { code?: string }).code = "EPIPE";
        throw error;
      },
    };

    expect(tryWriteControlSocket(socket, "40 100\n")).toBe(false);
  });
});
