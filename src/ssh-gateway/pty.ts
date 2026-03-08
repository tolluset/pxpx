import type { PseudoTtyInfo } from "ssh2";

const DEFAULT_PTY_ROWS = 24;
const DEFAULT_PTY_COLS = 80;

function sanitizeDimension(value: number, fallback: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.floor(value);
}

export function sanitizePtyWindow(
  rows: number,
  cols: number,
  fallback?: {
    rows?: number;
    cols?: number;
  },
) {
  const safeFallbackRows = sanitizeDimension(fallback?.rows ?? DEFAULT_PTY_ROWS, DEFAULT_PTY_ROWS);
  const safeFallbackCols = sanitizeDimension(fallback?.cols ?? DEFAULT_PTY_COLS, DEFAULT_PTY_COLS);

  return {
    rows: sanitizeDimension(rows, safeFallbackRows),
    cols: sanitizeDimension(cols, safeFallbackCols),
  };
}

export function sanitizePtyInfo(info: PseudoTtyInfo, fallback?: Partial<PseudoTtyInfo>): PseudoTtyInfo {
  const window = sanitizePtyWindow(info.rows, info.cols, {
    rows: fallback?.rows,
    cols: fallback?.cols,
  });

  return {
    ...(fallback ?? {}),
    ...info,
    rows: window.rows,
    cols: window.cols,
  };
}
