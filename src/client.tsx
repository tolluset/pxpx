import {
  MouseButton,
  createCliRenderer,
  type BoxRenderable,
  type KeyEvent,
  type MouseEvent,
} from "@opentui/core";
import { createRoot, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import {
  startTransition,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
} from "react";
import { WebSocket as WebSocketPolyfill } from "ws";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";

type PaletteColor = {
  id: string;
  name: string;
  hex: string;
  hotkey: string;
};

type Cursor = {
  x: number;
  y: number;
};

type BoardSize = {
  width: number;
  height: number;
};

type BoardViewport = {
  startX: number;
  startY: number;
  width: number;
  height: number;
};

type PixelSnapshot = Record<string, string>;
type RecentPaintSnapshot = Record<string, number>;

type AwarenessUser = {
  name?: string;
};

type AwarenessCursor = {
  x?: number;
  y?: number;
  color?: string;
};

type AwarenessState = {
  user?: AwarenessUser;
  cursor?: AwarenessCursor;
};

type RemotePlayer = {
  id: number;
  name: string;
  color: string;
  cursor: Cursor;
  cellKey: string;
};

type CliOptions = {
  help: boolean;
  name?: string;
  repo?: string;
  room?: string;
  serverUrl?: string;
};

const INITIAL_BOARD_WIDTH = 16;
const INITIAL_BOARD_HEIGHT = 16;
const BOARD_GROWTH_STEP = 8;
const CELL_WIDTH = 2;
const SIDEBAR_WIDTH = 30;
const MIN_VIEWPORT_WIDTH = 6;
const MIN_VIEWPORT_HEIGHT = 6;
const EMPTY_CELL_COLOR = "#111827";
const APP_BACKGROUND = "#020617";
const PANEL_BACKGROUND = "#0f172a";
const BORDER_COLOR = "#334155";
const READY_COLOR = "#22c55e";
const WARNING_COLOR = "#f59e0b";
const RECENT_PAINT_WINDOW_MS = 2500;
const RECENT_PAINT_PRUNE_MS = 250;
const DEFAULT_SERVER_URL = "wss://pixel-game-collab.dlqud19.workers.dev";
const DEFAULT_ROOM_NAME = "pixel-game";

function exitWithError(message: string): never {
  console.error(`Error: ${message}`);
  console.error("Run with --help for usage.");
  process.exit(1);
}

function printUsage() {
  console.log(`Usage: pixel-game [options]

Options:
  --repo <owner/repo>   Join the room mapped to a GitHub repository
  --room <name>         Join a room directly
  --server-url <url>    Override the websocket server URL
  --name <player>       Override the player name
  -h, --help            Show this help message

Environment variables:
  PIXEL_REPO
  PIXEL_ROOM
  PIXEL_SERVER_URL
  PIXEL_NAME
`);
}

function readOptionValue(args: string[], index: number, optionName: string) {
  const value = args[index + 1];

  if (value === undefined || value.trim().length === 0) {
    exitWithError(`missing value for ${optionName}`);
  }

  return value;
}

function parseCliOptions(args: string[]) {
  const options: CliOptions = {
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    switch (argument) {
      case "--repo":
        options.repo = readOptionValue(args, index, "--repo");
        index += 1;
        break;
      case "--room":
        options.room = readOptionValue(args, index, "--room");
        index += 1;
        break;
      case "--server-url":
        options.serverUrl = readOptionValue(args, index, "--server-url");
        index += 1;
        break;
      case "--name":
        options.name = readOptionValue(args, index, "--name");
        index += 1;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        exitWithError(`unknown argument: ${argument}`);
    }
  }

  return options;
}

function normalizeRoomName(value: string, source: string) {
  const normalized = value.trim().replace(/^\/+|\/+$/g, "");

  if (normalized.length === 0) {
    exitWithError(`${source} cannot be empty`);
  }

  return normalized;
}

function normalizeNonEmptyValue(value: string, source: string) {
  const normalized = value.trim();

  if (normalized.length === 0) {
    exitWithError(`${source} cannot be empty`);
  }

  return normalized;
}

function normalizeRepoSlug(value: string, source: string) {
  const normalized = value
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);

  if (segments.length !== 2) {
    exitWithError(`${source} must use owner/repo format`);
  }

  return `${segments[0].toLowerCase()}/${segments[1].toLowerCase()}`;
}

function resolveRuntimeValue(cliValue: string | undefined, envValue: string | undefined) {
  if (cliValue !== undefined) {
    return cliValue;
  }

  if (envValue !== undefined) {
    return envValue;
  }

  return undefined;
}

function resolveRuntimeConfig() {
  const cliOptions = parseCliOptions(process.argv.slice(2));

  if (cliOptions.help) {
    printUsage();
    process.exit(0);
  }

  const serverUrl = resolveRuntimeValue(cliOptions.serverUrl, process.env.PIXEL_SERVER_URL) ?? DEFAULT_SERVER_URL;
  const playerName =
    resolveRuntimeValue(cliOptions.name, process.env.PIXEL_NAME) ??
    `player-${Math.random().toString(36).slice(2, 6)}`;
  const roomName =
    cliOptions.room !== undefined
      ? normalizeRoomName(cliOptions.room, "--room")
      : cliOptions.repo !== undefined
        ? normalizeRepoSlug(cliOptions.repo, "--repo")
        : process.env.PIXEL_ROOM !== undefined
          ? normalizeRoomName(process.env.PIXEL_ROOM, "PIXEL_ROOM")
          : process.env.PIXEL_REPO !== undefined
            ? normalizeRepoSlug(process.env.PIXEL_REPO, "PIXEL_REPO")
            : DEFAULT_ROOM_NAME;

  return {
    playerName: normalizeNonEmptyValue(playerName, cliOptions.name !== undefined ? "--name" : "PIXEL_NAME"),
    roomName,
    serverUrl: normalizeNonEmptyValue(
      serverUrl,
      cliOptions.serverUrl !== undefined ? "--server-url" : "PIXEL_SERVER_URL",
    ),
  };
}

const RUNTIME_CONFIG = resolveRuntimeConfig();
const SERVER_URL = RUNTIME_CONFIG.serverUrl;
const ROOM_NAME = RUNTIME_CONFIG.roomName;
const PLAYER_NAME = RUNTIME_CONFIG.playerName;

const PALETTE: PaletteColor[] = [
  { id: "rose", name: "Rose", hex: "#fb7185", hotkey: "1" },
  { id: "amber", name: "Amber", hex: "#f59e0b", hotkey: "2" },
  { id: "lime", name: "Lime", hex: "#84cc16", hotkey: "3" },
  { id: "emerald", name: "Emerald", hex: "#10b981", hotkey: "4" },
  { id: "sky", name: "Sky", hex: "#38bdf8", hotkey: "5" },
  { id: "violet", name: "Violet", hex: "#8b5cf6", hotkey: "6" },
  { id: "pink", name: "Pink", hex: "#ec4899", hotkey: "7" },
  { id: "slate", name: "Slate", hex: "#94a3b8", hotkey: "8" },
];

const COLOR_BY_ID = Object.fromEntries(PALETTE.map((color) => [color.id, color])) as Record<string, PaletteColor>;
const COLOR_BY_HOTKEY = Object.fromEntries(PALETTE.map((color) => [color.hotkey, color])) as Record<
  string,
  PaletteColor
>;
const DEFAULT_CURSOR: Cursor = { x: 0, y: 0 };
const DEFAULT_BOARD_SIZE: BoardSize = {
  width: INITIAL_BOARD_WIDTH,
  height: INITIAL_BOARD_HEIGHT,
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function getCellKey(x: number, y: number) {
  return `${x},${y}`;
}

function isValidBoardIndex(value: number, size: number) {
  return Number.isInteger(value) && value >= 0 && value < size;
}

function sanitizeBoardDimension(value: number, fallback: number) {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(fallback, Math.floor(value));
}

function sanitizeBoardSize(size: Partial<BoardSize> | null | undefined): BoardSize {
  return {
    width: sanitizeBoardDimension(Number(size?.width), INITIAL_BOARD_WIDTH),
    height: sanitizeBoardDimension(Number(size?.height), INITIAL_BOARD_HEIGHT),
  };
}

function sanitizeNonNegativeIndex(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.floor(value));
}

function isValidCursor(cursor: Cursor, boardSize: BoardSize) {
  return isValidBoardIndex(cursor.x, boardSize.width) && isValidBoardIndex(cursor.y, boardSize.height);
}

function sanitizeBoardIndex(value: number, size: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return clamp(Math.floor(value), 0, size - 1);
}

function sanitizeCursor(cursor: Cursor, boardSize: BoardSize): Cursor {
  return {
    x: sanitizeBoardIndex(cursor.x, boardSize.width),
    y: sanitizeBoardIndex(cursor.y, boardSize.height),
  };
}

function parseCellKey(key: string): Cursor | null {
  const [xValue, yValue, extra] = key.split(",");

  if (xValue === undefined || yValue === undefined || extra !== undefined) {
    return null;
  }

  const cursor = {
    x: Number(xValue),
    y: Number(yValue),
  };

  if (!Number.isInteger(cursor.x) || !Number.isInteger(cursor.y) || cursor.x < 0 || cursor.y < 0) {
    return null;
  }

  return cursor;
}

function getBoardSizeFromState(boardMap: Y.Map<number>, pixelsMap: Y.Map<string>) {
  const boardSize = sanitizeBoardSize({
    width: Number(boardMap.get("width")),
    height: Number(boardMap.get("height")),
  });

  pixelsMap.forEach((_, key) => {
    const cell = parseCellKey(key);

    if (!cell) {
      return;
    }

    boardSize.width = Math.max(boardSize.width, cell.x + 1);
    boardSize.height = Math.max(boardSize.height, cell.y + 1);
  });

  return boardSize;
}

function getExpandedBoardSize(boardSize: BoardSize, cursor: Cursor) {
  return {
    width: cursor.x >= boardSize.width - 1 ? boardSize.width + BOARD_GROWTH_STEP : boardSize.width,
    height: cursor.y >= boardSize.height - 1 ? boardSize.height + BOARD_GROWTH_STEP : boardSize.height,
  };
}

function getOverflowExpandedBoardSize(boardSize: BoardSize, cursor: Cursor) {
  return {
    width: cursor.x >= boardSize.width ? boardSize.width + BOARD_GROWTH_STEP : boardSize.width,
    height: cursor.y >= boardSize.height ? boardSize.height + BOARD_GROWTH_STEP : boardSize.height,
  };
}

function getBoardViewport(boardSize: BoardSize, cursor: Cursor, width: number, height: number): BoardViewport {
  const viewportWidth = clamp(width, 1, boardSize.width);
  const viewportHeight = clamp(height, 1, boardSize.height);
  const maxStartX = Math.max(boardSize.width - viewportWidth, 0);
  const maxStartY = Math.max(boardSize.height - viewportHeight, 0);

  return {
    startX: clamp(cursor.x - Math.floor(viewportWidth / 2), 0, maxStartX),
    startY: clamp(cursor.y - Math.floor(viewportHeight / 2), 0, maxStartY),
    width: viewportWidth,
    height: viewportHeight,
  };
}

function getColorHex(colorId: string | undefined) {
  return (colorId && COLOR_BY_ID[colorId]?.hex) || EMPTY_CELL_COLOR;
}

function getReadableTextColor(hex: string) {
  const normalized = hex.replace("#", "");
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  const luminance = (red * 299 + green * 587 + blue * 114) / 1000;
  return luminance > 150 ? "#020617" : "#f8fafc";
}

function mixHex(hex: string, targetHex: string, weight: number) {
  const normalizedHex = hex.replace("#", "");
  const normalizedTarget = targetHex.replace("#", "");
  const ratio = clamp(weight, 0, 1);
  const mixedChannels = [0, 2, 4].map((start) => {
    const source = Number.parseInt(normalizedHex.slice(start, start + 2), 16);
    const target = Number.parseInt(normalizedTarget.slice(start, start + 2), 16);
    const value = Math.round(source + (target - source) * ratio);
    return value.toString(16).padStart(2, "0");
  });

  return `#${mixedChannels.join("")}`;
}

function getRecentPaintColor(hex: string) {
  return mixHex(hex, "#f8fafc", 0.28);
}

function truncateLabel(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  if (maxLength <= 3) {
    return value.slice(0, maxLength);
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function getPlayerName(state: AwarenessState | undefined, clientId: number) {
  const rawName = state?.user?.name;

  if (typeof rawName === "string" && rawName.trim().length > 0) {
    return rawName.trim();
  }

  return `player-${String(clientId).slice(-4)}`;
}

function getRemotePlayer(state: AwarenessState | undefined, clientId: number): RemotePlayer | null {
  const rawCursor = state?.cursor;

  if (rawCursor === undefined) {
    return null;
  }

  const x = Number(rawCursor.x);
  const y = Number(rawCursor.y);

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }

  const cursor = {
    x: sanitizeNonNegativeIndex(x),
    y: sanitizeNonNegativeIndex(y),
  };

  return {
    id: clientId,
    name: getPlayerName(state, clientId),
    color: typeof rawCursor.color === "string" ? rawCursor.color : READY_COLOR,
    cursor,
    cellKey: getCellKey(cursor.x, cursor.y),
  };
}

function ColorPalette({
  selectedColorId,
  onSelect,
}: {
  selectedColorId: string;
  onSelect: (colorId: string) => void;
}) {
  return (
    <box flexDirection="column" gap={1}>
      {PALETTE.map((color) => {
        const isSelected = color.id === selectedColorId;

        return (
          <box
            key={color.id}
            flexDirection="row"
            justifyContent="space-between"
            onMouseDown={() => onSelect(color.id)}
          >
            <text fg={isSelected ? "#f8fafc" : "#cbd5e1"}>
              {isSelected ? ">" : " "} [{color.hotkey}] {color.name}
            </text>
            <text bg={color.hex} fg={color.hex}>
              {"  "}
            </text>
          </box>
        );
      })}
    </box>
  );
}

function BoardRows({
  pixels,
  cursor,
  viewport,
  remotePlayersByCell,
  recentPaints,
}: {
  pixels: PixelSnapshot;
  cursor: Cursor;
  viewport: BoardViewport;
  remotePlayersByCell: Record<string, RemotePlayer[]>;
  recentPaints: RecentPaintSnapshot;
}) {
  return (
    <box flexDirection="column" width={viewport.width * CELL_WIDTH} height={viewport.height}>
      {Array.from({ length: viewport.height }, (_, rowOffset) => {
        const y = viewport.startY + rowOffset;

        return (
          <text key={`row-${y}`}>
            {Array.from({ length: viewport.width }, (_, columnOffset) => {
              const x = viewport.startX + columnOffset;
              const cellKey = getCellKey(x, y);
              const isCursor = cursor.x === x && cursor.y === y;
              const remotePlayers = remotePlayersByCell[cellKey] ?? [];
              const colorHex = getColorHex(pixels[cellKey]);
              const displayColor = recentPaints[cellKey] ? getRecentPaintColor(colorHex) : colorHex;
              const remoteInitial = Array.from(remotePlayers[0]?.name ?? "?")[0]?.toUpperCase() ?? "?";
              const cursorText = isCursor
                ? "[]"
                : remotePlayers.length === 1
                  ? `${remoteInitial} `
                  : remotePlayers.length > 1
                    ? `${Math.min(remotePlayers.length, 9)}+`
                    : "  ";
              const textColor =
                cursorText.trim().length > 0 ? getReadableTextColor(displayColor) : displayColor;

              return (
                <span key={`cell-${x}-${y}`} bg={displayColor} fg={textColor}>
                  {cursorText}
                </span>
              );
            })}
          </text>
        );
      })}
    </box>
  );
}

function App() {
  const renderer = useRenderer();
  const terminal = useTerminalDimensions();
  const boardRef = useRef<BoxRenderable | null>(null);
  const isMousePaintingRef = useRef(false);
  const hasHydratedPixelsRef = useRef(false);
  const [doc] = useState(() => new Y.Doc());
  const [provider] = useState(
    () =>
      new WebsocketProvider(SERVER_URL, ROOM_NAME, doc, {
        WebSocketPolyfill: WebSocketPolyfill as unknown as typeof globalThis.WebSocket,
      }),
  );
  const [boardMap] = useState(() => doc.getMap<number>("board"));
  const [pixelsMap] = useState(() => doc.getMap<string>("pixels"));
  const [cursor, setCursor] = useState<Cursor>(DEFAULT_CURSOR);
  const [boardSize, setBoardSize] = useState<BoardSize>(() => getBoardSizeFromState(boardMap, pixelsMap));
  const [selectedColorId, setSelectedColorId] = useState(PALETTE[0].id);
  const [pixelsSnapshot, setPixelsSnapshot] = useState<PixelSnapshot>(() => pixelsMap.toJSON() as PixelSnapshot);
  const [recentPaints, setRecentPaints] = useState<RecentPaintSnapshot>({});
  const [connectionStatus, setConnectionStatus] = useState("connecting");
  const [isSynced, setIsSynced] = useState(false);
  const [playersOnline, setPlayersOnline] = useState(1);
  const [remotePlayers, setRemotePlayers] = useState<RemotePlayer[]>([]);
  const [statusMessage, setStatusMessage] = useState(`Joining ${ROOM_NAME} as ${PLAYER_NAME}...`);
  const deferredPixelsSnapshot = useDeferredValue(pixelsSnapshot);
  const selectedColor = COLOR_BY_ID[selectedColorId] ?? PALETTE[0];
  const safeCursor = sanitizeCursor(cursor, boardSize);
  const currentCellColorId = deferredPixelsSnapshot[getCellKey(safeCursor.x, safeCursor.y)];
  const currentCellColor = COLOR_BY_ID[currentCellColorId ?? ""]?.name ?? "Empty";
  const remotePlayersByCell: Record<string, RemotePlayer[]> = {};
  const visibleRemotePlayers = remotePlayers.slice(0, 3);
  const rawViewportWidth = Math.floor((terminal.width - SIDEBAR_WIDTH - 14) / CELL_WIDTH);
  const rawViewportHeight = terminal.height - 14;
  const minimumWidth = SIDEBAR_WIDTH + MIN_VIEWPORT_WIDTH * CELL_WIDTH + 14;
  const minimumHeight = MIN_VIEWPORT_HEIGHT + 14;
  const screenTooSmall = rawViewportWidth < MIN_VIEWPORT_WIDTH || rawViewportHeight < MIN_VIEWPORT_HEIGHT;
  const viewport = getBoardViewport(
    boardSize,
    safeCursor,
    Math.max(rawViewportWidth, 1),
    Math.max(rawViewportHeight, 1),
  );
  const viewportEndX = viewport.startX + viewport.width;
  const viewportEndY = viewport.startY + viewport.height;

  remotePlayers.forEach((player) => {
    if (!remotePlayersByCell[player.cellKey]) {
      remotePlayersByCell[player.cellKey] = [];
    }

    remotePlayersByCell[player.cellKey].push(player);
  });

  function writeBoardSize(nextBoardSize: BoardSize) {
    const currentBoardSize = getBoardSizeFromState(boardMap, pixelsMap);
    const sanitizedNextBoardSize = sanitizeBoardSize(nextBoardSize);

    if (sanitizedNextBoardSize.width > currentBoardSize.width) {
      boardMap.set("width", sanitizedNextBoardSize.width);
    }

    if (sanitizedNextBoardSize.height > currentBoardSize.height) {
      boardMap.set("height", sanitizedNextBoardSize.height);
    }

    return {
      width: Math.max(currentBoardSize.width, sanitizedNextBoardSize.width),
      height: Math.max(currentBoardSize.height, sanitizedNextBoardSize.height),
    };
  }

  function shutdown() {
    provider.destroy();
    doc.destroy();
    renderer.destroy();
    process.exit(0);
  }

  function moveCursor(dx: number, dy: number) {
    const currentBoardSize = getBoardSizeFromState(boardMap, pixelsMap);
    const nextCursor = {
      x: sanitizeCursor(cursor, currentBoardSize).x + dx,
      y: sanitizeCursor(cursor, currentBoardSize).y + dy,
    };
    const expandedBoardSize = getOverflowExpandedBoardSize(currentBoardSize, nextCursor);
    const willExpand =
      expandedBoardSize.width > currentBoardSize.width || expandedBoardSize.height > currentBoardSize.height;

    if (willExpand) {
      doc.transact(() => {
        writeBoardSize(expandedBoardSize);
      });

      setStatusMessage(`Frontier opened to ${expandedBoardSize.width}x${expandedBoardSize.height}.`);
    }

    setCursor({
      x: clamp(nextCursor.x, 0, expandedBoardSize.width - 1),
      y: clamp(nextCursor.y, 0, expandedBoardSize.height - 1),
    });
  }

  function setSelectedColor(colorId: string) {
    const color = COLOR_BY_ID[colorId];

    if (!color) {
      return;
    }

    setSelectedColorId(colorId);
    setStatusMessage(`Selected ${color.name}`);
  }

  function attemptPlacement(x: number, y: number) {
    const currentBoardSize = getBoardSizeFromState(boardMap, pixelsMap);
    const targetCursor = { x, y };

    if (!isValidCursor(targetCursor, currentBoardSize)) {
      return;
    }

    setCursor(targetCursor);

    const cellKey = getCellKey(x, y);
    const existingColorId = pixelsMap.get(cellKey);

    if (existingColorId === selectedColorId) {
      setStatusMessage(`(${x + 1}, ${y + 1}) already uses ${selectedColor.name}`);
      return;
    }

    const expandedBoardSize = getExpandedBoardSize(currentBoardSize, targetCursor);
    const willExpand =
      expandedBoardSize.width > currentBoardSize.width || expandedBoardSize.height > currentBoardSize.height;

    doc.transact(() => {
      pixelsMap.set(cellKey, selectedColorId);

      if (willExpand) {
        writeBoardSize(expandedBoardSize);
      }
    });

    if (willExpand) {
      setStatusMessage(
        `Painted (${x + 1}, ${y + 1}) with ${selectedColor.name}. Frontier opened to ${expandedBoardSize.width}x${expandedBoardSize.height}.`,
      );
      return;
    }

    setStatusMessage(`Painted (${x + 1}, ${y + 1}) with ${selectedColor.name}`);
  }

  function updateCursorFromMouse(event: MouseEvent, shouldPaint: boolean) {
    const board = boardRef.current;

    if (!board) {
      return;
    }

    if (!Number.isFinite(event.x) || !Number.isFinite(event.y) || !Number.isFinite(board.x) || !Number.isFinite(board.y)) {
      return;
    }

    const relativeX = event.x - board.x;
    const relativeY = event.y - board.y;
    const cellX = viewport.startX + Math.floor(relativeX / CELL_WIDTH);
    const cellY = Math.floor(relativeY);

    const targetCursor = {
      x: cellX,
      y: viewport.startY + cellY,
    };

    if (!isValidCursor(targetCursor, boardSize)) {
      return;
    }

    setCursor(targetCursor);

    if (shouldPaint && event.button === MouseButton.LEFT) {
      attemptPlacement(targetCursor.x, targetCursor.y);
    }
  }

  function handleKeyInput(key: KeyEvent) {
    if (key.ctrl && key.name === "c") {
      shutdown();
      return;
    }

    if (key.name === "escape" || key.name === "q") {
      shutdown();
      return;
    }

    if (key.name === "up" || key.name === "w" || key.name === "k") {
      moveCursor(0, -1);
      return;
    }

    if (key.name === "down" || key.name === "s" || key.name === "j") {
      moveCursor(0, 1);
      return;
    }

    if (key.name === "left" || key.name === "a" || key.name === "h") {
      moveCursor(-1, 0);
      return;
    }

    if (key.name === "right" || key.name === "d" || key.name === "l") {
      moveCursor(1, 0);
      return;
    }

    if (key.name === "return" || key.name === "enter" || key.name === "space") {
      attemptPlacement(safeCursor.x, safeCursor.y);
      return;
    }

    const hotkeyColor = COLOR_BY_HOTKEY[key.name];

    if (hotkeyColor) {
      setSelectedColor(hotkeyColor.id);
    }
  }

  useKeyboard((key) => {
    handleKeyInput(key);
  });

  useEffect(() => {
    const pruneRecentPaints = () => {
      const cutoff = Date.now() - RECENT_PAINT_WINDOW_MS;

      setRecentPaints((previous) => {
        const entries = Object.entries(previous);

        if (entries.length === 0) {
          return previous;
        }

        const nextEntries = entries.filter(([, timestamp]) => timestamp >= cutoff);

        if (nextEntries.length === entries.length) {
          return previous;
        }

        return Object.fromEntries(nextEntries);
      });
    };
    const resetMousePainting = () => {
      isMousePaintingRef.current = false;
    };
    const interval = setInterval(pruneRecentPaints, RECENT_PAINT_PRUNE_MS);

    renderer.on("blur", resetMousePainting);
    renderer.on("focus", resetMousePainting);

    return () => {
      clearInterval(interval);
      renderer.off("blur", resetMousePainting);
      renderer.off("focus", resetMousePainting);
    };
  }, [renderer]);

  useEffect(() => {
    provider.awareness.setLocalStateField("user", {
      name: PLAYER_NAME,
    });
    provider.awareness.setLocalStateField("cursor", {
      x: safeCursor.x,
      y: safeCursor.y,
      color: selectedColor.hex,
    });
  }, [provider.awareness, safeCursor.x, safeCursor.y, selectedColor.hex]);

  useEffect(() => {
    const removeInvalidPixels = () => {
      const invalidKeys: string[] = [];

      pixelsMap.forEach((_, key) => {
        if (!parseCellKey(key)) {
          invalidKeys.push(key);
        }
      });

      if (invalidKeys.length === 0) {
        return false;
      }

      doc.transact(() => {
        invalidKeys.forEach((key) => {
          pixelsMap.delete(key);
        });
      });

      return true;
    };
    const syncBoardMetadata = () => {
      const nextBoardSize = getBoardSizeFromState(boardMap, pixelsMap);
      const storedBoardSize = sanitizeBoardSize({
        width: Number(boardMap.get("width")),
        height: Number(boardMap.get("height")),
      });

      if (
        storedBoardSize.width === nextBoardSize.width &&
        storedBoardSize.height === nextBoardSize.height
      ) {
        return;
      }

      doc.transact(() => {
        boardMap.set("width", nextBoardSize.width);
        boardMap.set("height", nextBoardSize.height);
      });
    };
    const updateRecentPaints = (changedKeys: Iterable<string>, snapshot: PixelSnapshot) => {
      if (!hasHydratedPixelsRef.current) {
        hasHydratedPixelsRef.current = true;
        return;
      }

      const validKeys = Array.from(changedKeys).filter((key) => parseCellKey(key) && snapshot[key] !== undefined);

      if (validKeys.length === 0) {
        return;
      }

      const timestamp = Date.now();

      setRecentPaints((previous) => {
        const nextPaints = { ...previous };

        validKeys.forEach((key) => {
          nextPaints[key] = timestamp;
        });

        return nextPaints;
      });
    };
    const handleStatus = (event: { status: string }) => {
      setConnectionStatus(event.status);

      if (event.status === "connected") {
        setStatusMessage(`Connected to ${ROOM_NAME}`);
      }

      if (event.status === "disconnected") {
        setStatusMessage("Connection lost. Reconnecting...");
      }
    };
    const handleSync = (synced: boolean) => {
      setIsSynced(synced);

      if (synced) {
        setStatusMessage(`Synced room ${ROOM_NAME}`);
      }
    };
    const handlePixels = (event?: Y.YMapEvent<string>) => {
      if (removeInvalidPixels()) {
        return;
      }

      const nextSnapshot = pixelsMap.toJSON() as PixelSnapshot;
      updateRecentPaints(event?.keysChanged ?? [], nextSnapshot);

      startTransition(() => {
        setPixelsSnapshot(nextSnapshot);
        setBoardSize(getBoardSizeFromState(boardMap, pixelsMap));
      });
    };
    const handleBoard = () => {
      startTransition(() => {
        setBoardSize(getBoardSizeFromState(boardMap, pixelsMap));
      });
    };
    const handleAwareness = () => {
      const nextRemotePlayers: RemotePlayer[] = [];

      provider.awareness.getStates().forEach((state, clientId) => {
        if (clientId === doc.clientID) {
          return;
        }

        const remotePlayer = getRemotePlayer(state as AwarenessState | undefined, clientId);

        if (remotePlayer) {
          nextRemotePlayers.push(remotePlayer);
        }
      });

      nextRemotePlayers.sort((left, right) => left.name.localeCompare(right.name) || left.id - right.id);

      startTransition(() => {
        setPlayersOnline(Math.max(provider.awareness.getStates().size, 1));
        setRemotePlayers(nextRemotePlayers);
      });
    };

    pixelsMap.observe(handlePixels);
    boardMap.observe(handleBoard);
    provider.on("status", handleStatus);
    provider.on("sync", handleSync);
    provider.awareness.on("change", handleAwareness);

    syncBoardMetadata();
    handlePixels();
    handleBoard();
    handleAwareness();

    return () => {
      pixelsMap.unobserve(handlePixels);
      boardMap.unobserve(handleBoard);
      provider.off("status", handleStatus);
      provider.off("sync", handleSync);
      provider.awareness.off("change", handleAwareness);
      provider.destroy();
      doc.destroy();
    };
  }, [boardMap, doc, pixelsMap, provider]);

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={APP_BACKGROUND}>
      <box
        border
        borderColor={BORDER_COLOR}
        backgroundColor={PANEL_BACKGROUND}
        paddingX={1}
        paddingY={0}
        flexDirection="row"
        justifyContent="space-between"
      >
        <text fg="#f8fafc">Pixel Game</text>
        <text fg="#cbd5e1">
          Room {ROOM_NAME} | {PLAYER_NAME} | {playersOnline} online
        </text>
      </box>

      <box flexGrow={1} flexDirection="row" gap={1} padding={1} backgroundColor={APP_BACKGROUND}>
        <box
          width={SIDEBAR_WIDTH}
          border
          borderColor={BORDER_COLOR}
          backgroundColor={PANEL_BACKGROUND}
          padding={1}
          flexDirection="column"
          gap={1}
        >
          <text fg="#f8fafc">Palette</text>
          <ColorPalette selectedColorId={selectedColorId} onSelect={setSelectedColor} />
          <text fg="#94a3b8">Selected: {selectedColor.name}</text>
          <text fg="#94a3b8">
            Cursor: ({safeCursor.x + 1}, {safeCursor.y + 1})
          </text>
          <text fg="#94a3b8">Board: {boardSize.width}x{boardSize.height}</text>
          <text fg="#94a3b8">
            View x: {viewport.startX + 1}-{viewportEndX}
          </text>
          <text fg="#94a3b8">
            View y: {viewport.startY + 1}-{viewportEndY}
          </text>
          <text fg="#94a3b8">Cell: {currentCellColor}</text>
          <text fg="#94a3b8">Connection: {connectionStatus}</text>
          <text fg={isSynced ? READY_COLOR : WARNING_COLOR}>{isSynced ? "Synced" : "Syncing..."}</text>
          <text fg="#f8fafc">Live cursors</text>
          {visibleRemotePlayers.length === 0 ? (
            <text fg="#64748b">Waiting for another painter</text>
          ) : (
            visibleRemotePlayers.map((player) => (
              <text key={player.id} fg={player.color}>
                {truncateLabel(player.name, 14)} ({player.cursor.x + 1},{player.cursor.y + 1})
              </text>
            ))
          )}
          {remotePlayers.length > visibleRemotePlayers.length ? (
            <text fg="#64748b">+{remotePlayers.length - visibleRemotePlayers.length} more nearby</text>
          ) : null}
          <text fg="#64748b">Arrows/WASD/HJKL move</text>
          <text fg="#64748b">Enter/Space paints</text>
          <text fg="#64748b">1-8 selects color</text>
          <text fg="#64748b">Initials mark live cursors</text>
          <text fg="#64748b">Fresh paint glows briefly</text>
          <text fg="#64748b">Click paints the board</text>
          <text fg="#64748b">Push or paint east/south edge to grow</text>
          <text fg="#64748b">Esc or Q exits</text>
        </box>

        <box
          flexGrow={1}
          border
          borderColor={BORDER_COLOR}
          backgroundColor={PANEL_BACKGROUND}
          padding={1}
          flexDirection="column"
          gap={1}
        >
          <text fg="#f8fafc">
            Board {boardSize.width}x{boardSize.height} | View x {viewport.startX + 1}-{viewportEndX} | y{" "}
            {viewport.startY + 1}-{viewportEndY}
          </text>
          {screenTooSmall ? (
            <text fg={WARNING_COLOR}>
              Resize terminal to at least {minimumWidth}x{minimumHeight} for a {MIN_VIEWPORT_WIDTH}x
              {MIN_VIEWPORT_HEIGHT} viewport.
            </text>
          ) : (
            <box
              ref={boardRef}
              width={viewport.width * CELL_WIDTH}
              height={viewport.height}
              onMouseMove={(event) => updateCursorFromMouse(event, false)}
              onMouseDown={(event) => {
                isMousePaintingRef.current = event.button === MouseButton.LEFT;
                updateCursorFromMouse(event, isMousePaintingRef.current);
              }}
              onMouseUp={() => {
                isMousePaintingRef.current = false;
              }}
              onMouseDrag={(event) => {
                if (!isMousePaintingRef.current) {
                  return;
                }

                updateCursorFromMouse(event, true);
              }}
              onMouseDragEnd={() => {
                isMousePaintingRef.current = false;
              }}
            >
              <BoardRows
                pixels={deferredPixelsSnapshot}
                cursor={safeCursor}
                viewport={viewport}
                remotePlayersByCell={remotePlayersByCell}
                recentPaints={recentPaints}
              />
            </box>
          )}
          <text fg="#94a3b8">{statusMessage}</text>
        </box>
      </box>

      <box
        border
        borderColor={BORDER_COLOR}
        backgroundColor={PANEL_BACKGROUND}
        paddingX={1}
        paddingY={0}
        flexDirection="row"
        justifyContent="space-between"
      >
        <text fg="#94a3b8">
          {connectionStatus === "connected" ? "Connected" : "Reconnecting"} | Collaborative via Yjs websocket
        </text>
        <text fg={READY_COLOR}>No cooldown | Live presence | Frontier growth</text>
      </box>
    </box>
  );
}

const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  useMouse: true,
  enableMouseMovement: true,
  useAlternateScreen: true,
  autoFocus: true,
  backgroundColor: APP_BACKGROUND,
});

createRoot(renderer).render(<App />);
