import { EventEmitter, Handler } from "../../lib/event.ts";
import {
  Exact,
  HandlerWithSocket,
  ModuleWS,
  TypedWebsocketLike,
  WS,
} from "../../lib/websocket.ts";
import { easyLog } from "../../lib/log.ts";
import { DispatchServer } from "../util/serving.ts";

const log = easyLog("wall:websocket");

interface WSSOptions {
  /** When specified, opens a new server on this port. */
  port?: number;
  /** If port is not specified, use this dispatchserver as the server. */
  server?: DispatchServer;
  /** The path on the server that should be intercepted for these websocket requests. */
  path?: string;

  /** If we should bind to an existing WebSocketServer, provide it here. */
  existingWSS?: WebSocketServer;
}

export class WebSocketServer extends EventEmitter {
  server: DispatchServer;
  constructor(options: WSSOptions) {
    super();
    if (options.port) {
      this.server = new DispatchServer({ port: options.port });
    } else {
      this.server = options.server!;
    }
    options.path = options.path ?? "/websocket";

    this.server.addHandler(options.path, (req: Request) => {
      // Assert upgrade to websocket.
      const upgrade = req.headers.get("upgrade") || "";
      if (upgrade.toLowerCase() != "websocket") {
        return Promise.resolve(
          new Response("request isn't trying to upgrade to websocket."),
        );
      }
      const { socket, response } = Deno.upgradeWebSocket(req);
      this.emit("connection", socket);
      return Promise.resolve(response);
    });
    this.server.start();
  }
}

export class WSS extends EventEmitter implements TypedWebsocketLike {
  webSocketServer: WebSocketServer;
  clientSockets: Set<WS>;
  /** A set of handlers that should be dynamically added when clients join. */
  readonly clientMessageHandlers = new Map<string, Handler[]>();

  constructor(options: WSSOptions) {
    super();
    this.webSocketServer = options.existingWSS ?? new WebSocketServer(options);
    this.clientSockets = new Set();
    this.webSocketServer.on("connection", (websocket: WebSocket) => {
      const ws = WS.serverWrapper(websocket);
      this.clientSockets.add(ws);
      for (const [msg, fns] of this.clientMessageHandlers) {
        console.log("adding dynamic handler for", msg);
        for (const fn of fns) {
          ws.on(msg as keyof EmittedEvents, fn);
        }
      }
      ws.on("disconnect", (code: number, reason: string) => {
        log.error(`Lost client: ${code} Reason: ${reason}`);
        this.clientSockets.delete(ws);
        this.emit("disconnect", ws);
      });
      this.emit("connection", ws);
    });
  }
  addDynamicHandler<K extends keyof EmittedEvents>(
    msg: K,
    fn: HandlerWithSocket<EmittedEvents[K]>,
  ) {
    console.log(
      "registering dynamic handler for",
      msg,
      "on",
      this.clientSockets.size,
    );
    for (const ws of this.clientSockets) {
      ws.on(msg, fn);
    }
    const fns = this.clientMessageHandlers.get(msg) || [];
    fns.push(fn as Handler);
    this.clientMessageHandlers.set(msg, fns);
  }
  removeDynamicHandler(msg: string, fn: Handler) {
    const fns = this.clientMessageHandlers.get(msg) || [];
    const i = fns.indexOf(fn);
    if (i === -1) {
      return;
    }
    fns.splice(i, 1);
    if (!fns.length) {
      this.clientMessageHandlers.delete(msg);
    }
  }
  removeDynamicHandlers(msg: string) {
    this.clientMessageHandlers.delete(msg);
  }

  on<K extends keyof EmittedEvents, V>(
    msg: K,
    handler: HandlerWithSocket<EmittedEvents[K]>,
  ) {
    super.on(msg, handler as Handler);
  }
  once<K extends keyof EmittedEvents, V>(
    msg: K,
    handler: HandlerWithSocket<EmittedEvents[K]>,
  ): void {
    super.once(msg, handler as Handler);
  }

  send<K extends keyof EmittedEvents, V>(
    msg: K,
    ...payload: Exact<V, Parameters<EmittedEvents[K]>>
  ) {
    for (const websocket of this.clientSockets) {
      websocket.send(msg, ...payload as any);
    }
  }
  close() {
    this.handlers.clear();
    this.clientSockets.clear();
  }
}

export class ModuleWSS implements TypedWebsocketLike {
  readonly savedTypes = new Set<string>();
  readonly moduleWSCache = new Map<WS, ModuleWS>();
  constructor(readonly wss: WSS, readonly moduleId: string) {}

  private lookUpModuleWS(ws: WS) {
    let moduleWs = this.moduleWSCache.get(ws);
    if (!moduleWs) {
      moduleWs = new ModuleWS(ws, this.moduleId);
      this.moduleWSCache.set(ws, moduleWs);
    }
    return moduleWs;
  }

  on<K extends keyof EmittedEvents, V>(
    msg: K,
    handler: HandlerWithSocket<EmittedEvents[K]>,
  ) {
    // When a module listens for a message, they really want to listen for any client
    // listening to a message.

    this.wss.addDynamicHandler(
      `${this.moduleId}:${msg}` as keyof EmittedEvents,
      (...payload) => {
        // Swap the last argument from a normal WS to a ModuleWS.
        const ws = payload.pop() as WS;
        const moduleWs = this.lookUpModuleWS(ws);
        payload.push(moduleWs);
        handler(...payload as any);
      },
    );
  }
  once() {
    throw new Error("Once not implemented for ModuleWSS");
  }
  send<K extends keyof EmittedEvents, V>(
    msg: K,
    ...payload: Parameters<EmittedEvents[K]>
  ) {
    // Send to all clients.
    this.wss.send(msg, ...payload as any);
  }

  clients() {
    const clients = [];
    for (const ws of this.wss.clientSockets) {
      clients.push(this.lookUpModuleWS(ws));
    }
    return clients;
  }
  close() {
    for (const msg of this.savedTypes) {
      this.wss.removeDynamicHandlers(msg);
    }
  }
}
