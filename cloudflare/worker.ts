import { DurableObject } from "cloudflare:workers";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

const DOC_STATE_KEY = "doc-state";
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const WEBSOCKET_READY_STATE_OPEN = 1;

type ConnectionMeta = {
  controlledIds: number[];
};

type DurableObjectEnv = {
  ROOMS: DurableObjectNamespace;
};

function getRoomName(pathname: string) {
  return decodeURIComponent(pathname.replace(/^\/+/, ""));
}

function createConnectionMeta(controlledIds: Iterable<number> = []): ConnectionMeta {
  return { controlledIds: Array.from(controlledIds) };
}

function normalizeBinaryMessage(message: ArrayBuffer | ArrayBufferView) {
  if (message instanceof ArrayBuffer) {
    return new Uint8Array(message);
  }

  return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
}

function normalizeStoredUpdate(update: ArrayBuffer | Uint8Array | null | undefined) {
  if (!update) {
    return null;
  }

  return update instanceof Uint8Array ? update : new Uint8Array(update);
}

export default {
  async fetch(request: Request, env: DurableObjectEnv) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("Pixel Game collaboration worker is running.\nConnect via /<room> using WebSocket.", {
        headers: {
          "content-type": "text/plain; charset=utf-8",
        },
      });
    }

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "pixel-game-collaboration",
        date: new Date().toISOString(),
      });
    }

    const roomName = getRoomName(url.pathname);

    if (!roomName) {
      return new Response("Room name is required.", { status: 400 });
    }

    const id = env.ROOMS.idFromName(roomName);
    const stub = env.ROOMS.get(id);
    return stub.fetch(request);
  },
};

export class PixelRoom extends DurableObject {
  private readonly ctx: DurableObjectState;
  private readonly doc = new Y.Doc();
  private readonly awareness = new awarenessProtocol.Awareness(this.doc);
  private readonly connections = new Map<WebSocket, Set<number>>();
  private readonly ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: DurableObjectEnv) {
    super(ctx, env);
    this.ctx = ctx;
    this.awareness.setLocalState(null);
    this.ready = this.ctx.blockConcurrencyWhile(async () => {
      const storedUpdate = normalizeStoredUpdate(await this.ctx.storage.get<ArrayBuffer | Uint8Array>(DOC_STATE_KEY));

      if (storedUpdate) {
        Y.applyUpdate(this.doc, storedUpdate, "storage");
      }

      for (const socket of this.ctx.getWebSockets()) {
        const attachment = (socket.deserializeAttachment() ?? createConnectionMeta()) as ConnectionMeta;
        this.connections.set(socket, new Set(attachment.controlledIds));
      }

      this.attachListeners();
    });
  }

  async fetch(request: Request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Pixel room is ready.", { status: 200 });
    }

    const [client, server] = Object.values(new WebSocketPair());

    this.connections.set(server, new Set());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(createConnectionMeta());

    await this.ready;
    this.sendInitialSync(server);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(socket: WebSocket, message: ArrayBuffer | ArrayBufferView | string) {
    await this.ready;

    if (typeof message === "string") {
      return;
    }

    try {
      const encoder = encoding.createEncoder();
      const decoder = decoding.createDecoder(normalizeBinaryMessage(message));
      const messageType = decoding.readVarUint(decoder);

      switch (messageType) {
        case MESSAGE_SYNC:
          encoding.writeVarUint(encoder, MESSAGE_SYNC);
          syncProtocol.readSyncMessage(decoder, encoder, this.doc, socket);

          if (encoding.length(encoder) > 1) {
            this.send(socket, encoding.toUint8Array(encoder));
          }
          break;
        case MESSAGE_AWARENESS:
          awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), socket);
          break;
        default:
          socket.close(1003, "Unsupported message type");
      }
    } catch (error) {
      console.error("Failed to process websocket message", error);
      socket.close(1011, "Internal error");
    }
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string) {
    await this.ready;
    this.removeConnection(socket);
    try {
      socket.close(code, reason);
    } catch {}
  }

  async webSocketError(socket: WebSocket) {
    await this.ready;
    this.removeConnection(socket);
  }

  private attachListeners() {
    this.doc.on("update", (update) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      const message = encoding.toUint8Array(encoder);

      for (const socket of this.connections.keys()) {
        this.send(socket, message);
      }

      void this.persistDocState();
    });

    this.awareness.on("update", ({ added, updated, removed }, origin) => {
      if (origin instanceof WebSocket) {
        const controlledIds = this.connections.get(origin);

        if (controlledIds) {
          for (const clientId of added) {
            controlledIds.add(clientId);
          }

          for (const clientId of removed) {
            controlledIds.delete(clientId);
          }

          origin.serializeAttachment(createConnectionMeta(controlledIds));
        }
      }

      const changedClients = added.concat(updated, removed);

      if (changedClients.length === 0) {
        return;
      }

      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients),
      );
      const message = encoding.toUint8Array(encoder);

      for (const socket of this.connections.keys()) {
        this.send(socket, message);
      }
    });
  }

  private async persistDocState() {
    await this.ctx.storage.put(DOC_STATE_KEY, Y.encodeStateAsUpdate(this.doc));
  }

  private sendInitialSync(socket: WebSocket) {
    const syncEncoder = encoding.createEncoder();
    encoding.writeVarUint(syncEncoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(syncEncoder, this.doc);
    this.send(socket, encoding.toUint8Array(syncEncoder));

    const awarenessStates = this.awareness.getStates();

    if (awarenessStates.size === 0) {
      return;
    }

    const awarenessEncoder = encoding.createEncoder();
    encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      awarenessEncoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, Array.from(awarenessStates.keys())),
    );
    this.send(socket, encoding.toUint8Array(awarenessEncoder));
  }

  private removeConnection(socket: WebSocket) {
    const controlledIds = this.connections.get(socket);

    if (controlledIds && controlledIds.size > 0) {
      awarenessProtocol.removeAwarenessStates(this.awareness, Array.from(controlledIds), null);
    }

    this.connections.delete(socket);
  }

  private send(socket: WebSocket, message: Uint8Array) {
    if (socket.readyState !== WEBSOCKET_READY_STATE_OPEN) {
      this.removeConnection(socket);
      return;
    }

    try {
      socket.send(message);
    } catch (error) {
      console.error("Failed to send websocket message", error);
      this.removeConnection(socket);
      try {
        socket.close(1011, "Send failed");
      } catch {}
    }
  }
}
