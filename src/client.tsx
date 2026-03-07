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

type PixelSnapshot = Record<string, string>;
type PositionedBoard = BoxRenderable & {
  screenX: number;
  screenY: number;
};

const BOARD_WIDTH = 16;
const BOARD_HEIGHT = 16;
const CELL_WIDTH = 2;
const SIDEBAR_WIDTH = 30;
const EMPTY_CELL_COLOR = "#111827";
const APP_BACKGROUND = "#020617";
const PANEL_BACKGROUND = "#0f172a";
const BORDER_COLOR = "#334155";
const READY_COLOR = "#22c55e";
const WARNING_COLOR = "#f59e0b";
const SERVER_URL = process.env.PIXEL_SERVER_URL ?? "ws://localhost:1234";
const ROOM_NAME = process.env.PIXEL_ROOM ?? "pixel-game";
const PLAYER_NAME = process.env.PIXEL_NAME ?? `player-${Math.random().toString(36).slice(2, 6)}`;

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

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function getCellKey(x: number, y: number) {
  return `${x},${y}`;
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
}: {
  pixels: PixelSnapshot;
  cursor: Cursor;
}) {
  return (
    <box flexDirection="column" width={BOARD_WIDTH * CELL_WIDTH} height={BOARD_HEIGHT}>
      {Array.from({ length: BOARD_HEIGHT }, (_, y) => (
        <text key={`row-${y}`}>
          {Array.from({ length: BOARD_WIDTH }, (_, x) => {
            const isCursor = cursor.x === x && cursor.y === y;
            const colorHex = getColorHex(pixels[getCellKey(x, y)]);
            const cursorText = isCursor ? "[]" : "  ";

            return (
              <span key={`cell-${x}-${y}`} bg={colorHex} fg={isCursor ? getReadableTextColor(colorHex) : colorHex}>
                {cursorText}
              </span>
            );
          })}
        </text>
      ))}
    </box>
  );
}

function App() {
  const renderer = useRenderer();
  const terminal = useTerminalDimensions();
  const boardRef = useRef<BoxRenderable | null>(null);
  const [doc] = useState(() => new Y.Doc());
  const [provider] = useState(
    () =>
      new WebsocketProvider(SERVER_URL, ROOM_NAME, doc, {
        WebSocketPolyfill: WebSocketPolyfill as unknown as typeof globalThis.WebSocket,
      }),
  );
  const [pixelsMap] = useState(() => doc.getMap<string>("pixels"));
  const [cursor, setCursor] = useState<Cursor>({ x: 0, y: 0 });
  const [selectedColorId, setSelectedColorId] = useState(PALETTE[0].id);
  const [pixelsSnapshot, setPixelsSnapshot] = useState<PixelSnapshot>(() => pixelsMap.toJSON() as PixelSnapshot);
  const [connectionStatus, setConnectionStatus] = useState("connecting");
  const [isSynced, setIsSynced] = useState(false);
  const [playersOnline, setPlayersOnline] = useState(1);
  const [statusMessage, setStatusMessage] = useState(`Joining ${ROOM_NAME} as ${PLAYER_NAME}...`);
  const deferredPixelsSnapshot = useDeferredValue(pixelsSnapshot);
  const selectedColor = COLOR_BY_ID[selectedColorId] ?? PALETTE[0];
  const currentCellColorId = deferredPixelsSnapshot[getCellKey(cursor.x, cursor.y)];
  const currentCellColor = COLOR_BY_ID[currentCellColorId ?? ""]?.name ?? "Empty";
  const minimumWidth = SIDEBAR_WIDTH + BOARD_WIDTH * CELL_WIDTH + 14;
  const minimumHeight = BOARD_HEIGHT + 8;
  const screenTooSmall = terminal.width < minimumWidth || terminal.height < minimumHeight;

  function shutdown() {
    provider.destroy();
    doc.destroy();
    renderer.destroy();
    process.exit(0);
  }

  function moveCursor(dx: number, dy: number) {
    setCursor((previous) => ({
      x: clamp(previous.x + dx, 0, BOARD_WIDTH - 1),
      y: clamp(previous.y + dy, 0, BOARD_HEIGHT - 1),
    }));
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
    setCursor({ x, y });

    const cellKey = getCellKey(x, y);
    const existingColorId = pixelsMap.get(cellKey);

    if (existingColorId === selectedColorId) {
      setStatusMessage(`(${x + 1}, ${y + 1}) already uses ${selectedColor.name}`);
      return;
    }

    pixelsMap.set(cellKey, selectedColorId);
    setStatusMessage(`Painted (${x + 1}, ${y + 1}) with ${selectedColor.name}`);
  }

  function updateCursorFromMouse(event: MouseEvent, shouldPaint: boolean) {
    const board = boardRef.current as PositionedBoard | null;

    if (!board) {
      return;
    }

    const relativeX = event.x - board.screenX;
    const relativeY = event.y - board.screenY;
    const cellX = Math.floor(relativeX / CELL_WIDTH);
    const cellY = relativeY;

    if (cellX < 0 || cellX >= BOARD_WIDTH || cellY < 0 || cellY >= BOARD_HEIGHT) {
      return;
    }

    setCursor({ x: cellX, y: cellY });

    if (shouldPaint && event.button === MouseButton.LEFT) {
      attemptPlacement(cellX, cellY);
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
      attemptPlacement(cursor.x, cursor.y);
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
    provider.awareness.setLocalStateField("user", {
      name: PLAYER_NAME,
    });
    provider.awareness.setLocalStateField("cursor", {
      x: cursor.x,
      y: cursor.y,
      color: selectedColor.hex,
    });
  }, [cursor.x, cursor.y, provider.awareness, selectedColor.hex]);

  useEffect(() => {
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
    const handlePixels = () => {
      startTransition(() => {
        setPixelsSnapshot(pixelsMap.toJSON() as PixelSnapshot);
      });
    };
    const handleAwareness = () => {
      startTransition(() => {
        setPlayersOnline(Math.max(provider.awareness.getStates().size, 1));
      });
    };

    pixelsMap.observe(handlePixels);
    provider.on("status", handleStatus);
    provider.on("sync", handleSync);
    provider.awareness.on("change", handleAwareness);

    handlePixels();
    handleAwareness();

    return () => {
      pixelsMap.unobserve(handlePixels);
      provider.off("status", handleStatus);
      provider.off("sync", handleSync);
      provider.awareness.off("change", handleAwareness);
      provider.destroy();
      doc.destroy();
    };
  }, [doc, pixelsMap, provider]);

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
            Cursor: ({cursor.x + 1}, {cursor.y + 1})
          </text>
          <text fg="#94a3b8">Cell: {currentCellColor}</text>
          <text fg="#94a3b8">Connection: {connectionStatus}</text>
          <text fg={isSynced ? READY_COLOR : WARNING_COLOR}>{isSynced ? "Synced" : "Syncing..."}</text>
          <text fg="#64748b">Arrows/WASD/HJKL move</text>
          <text fg="#64748b">Enter/Space paints</text>
          <text fg="#64748b">1-8 selects color</text>
          <text fg="#64748b">Click paints the board</text>
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
            Board {BOARD_WIDTH}x{BOARD_HEIGHT}
          </text>
          {screenTooSmall ? (
            <text fg={WARNING_COLOR}>
              Resize terminal to at least {minimumWidth}x{minimumHeight} to view the full board.
            </text>
          ) : (
            <box
              ref={boardRef}
              width={BOARD_WIDTH * CELL_WIDTH}
              height={BOARD_HEIGHT}
              onMouseMove={(event) => updateCursorFromMouse(event, false)}
              onMouseDown={(event) => updateCursorFromMouse(event, true)}
              onMouseDrag={(event) => updateCursorFromMouse(event, true)}
            >
              <BoardRows pixels={deferredPixelsSnapshot} cursor={cursor} />
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
        <text fg={READY_COLOR}>No cooldown</text>
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
