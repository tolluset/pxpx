import { describe, expect, test } from "bun:test";
import { sanitizePtyInfo, sanitizePtyWindow } from "../../src/ssh-gateway/pty";

describe("sanitizePtyWindow", () => {
  test("falls back to default dimensions for invalid initial sizes", () => {
    expect(sanitizePtyWindow(0, 0)).toEqual({
      rows: 24,
      cols: 80,
    });
  });

  test("preserves the previous valid size when a resize update is invalid", () => {
    expect(
      sanitizePtyWindow(0, -4, {
        rows: 32,
        cols: 120,
      }),
    ).toEqual({
      rows: 32,
      cols: 120,
    });
  });

  test("keeps valid resize updates", () => {
    expect(
      sanitizePtyWindow(18, 90, {
        rows: 32,
        cols: 120,
      }),
    ).toEqual({
      rows: 18,
      cols: 90,
    });
  });
});

describe("sanitizePtyInfo", () => {
  test("keeps previous rows and cols while updating the rest of the PTY metadata", () => {
    expect(
      sanitizePtyInfo(
        {
          term: "xterm-256color",
          width: 1024,
          height: 640,
          rows: 0,
          cols: 0,
          modes: {},
        },
        {
          term: "screen-256color",
          width: 800,
          height: 600,
          rows: 28,
          cols: 100,
          modes: {},
        },
      ),
    ).toEqual({
      term: "xterm-256color",
      width: 1024,
      height: 640,
      rows: 28,
      cols: 100,
      modes: {},
    });
  });
});
