/* Copyright 2019 Google Inc. All Rights Reserved.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
==============================================================================*/

// Maintains all open socket connections to the clients. Because this connection
// is inherently a global singleton, we provide global functions for sending
// information to the clients and for registering for specific messages from
// the clients. The network library maintains the map of virtual screen space
// to client, so that it can provide APIs to send messages to a client that owns
// a specific pixel or rect of screen real estate.

// The library also imposes a specific protocol that all clients must adhere to:
// - After socket init, the server will ask the clients for details of its
//   _config_, and the client will respond with its visible screen rect. If the
//   client fails to do this, the client is considered invalid and omitted from
//   future calculations.

import { easyLog } from "../../lib/log.ts";
import * as monitor from "../monitoring/monitor.ts";
import { Rectangle } from "../../lib/math/rectangle.ts";
import * as time from "../../lib/adjustable_time.ts";
import { WSS, WSSWrapper } from "./websocket.ts";
import { WS } from "../../lib/websocket.ts";
import { DispatchServer, DispatchServerOptions } from "../util/serving.ts";
import { Handler } from "../../lib/event.ts";
import { flags } from "../flags.ts";

const log = easyLog("wall:network");

interface Point {
  x: number;
  y: number;
}

class ClientInfo {
  constructor(
    readonly offset: Point,
    readonly rect: Rectangle,
    readonly socket: WS,
  ) {
  }
}

export const clients: Record<string, ClientInfo> = {};

let nextClientId = 1;

interface SerializedClientConfig {
  rect: string;
  offset: Point;
}

// Create an serve that can describes the routes that serve the files the client
// needs to run.
const options: DispatchServerOptions = { port: flags.port };
if (flags.https_cert) {
  options.ssl = {
    certFile: flags.https_cert,
    keyFile: flags.https_key,
  };
}
export const server = new DispatchServer(options);
export const wss = new WSS({ server });

/**
 * Main entry point for networking.
 * Initializes the networking layer, given an httpserver instance.
 */
export function init() {
  wss.on("connection", (socket: WS) => {
    const clientId = nextClientId++;
    // When the client boots, it sends a start message that includes the rect
    // of the client. We listen for that message and register that client info.
    socket.on("client-start", (config: SerializedClientConfig) => {
      const clientRect = Rectangle.deserialize(config.rect);
      if (!clientRect) {
        log.error(`Bad client configuration: `, config);
        // Close the connection with this client.
        socket.close();
        return;
      }
      const client = new ClientInfo(config.offset, clientRect, socket);
      if (monitor.isEnabled()) {
        monitor.update({
          layout: {
            time: time.now(),
            event: `newClient: ${client.rect.serialize()}`,
          },
        });
      }
      clients[clientId] = client;
      log(`New client: ${client.rect.serialize()}`);
      // Tell the client the current time.
      socket.send("time", time.now());
    });

    // When the client disconnects, we tell our listeners that we lost the client.
    socket.once("disconnect", () => {
      if (clientId in clients) {
        const { rect } = clients[clientId];
        if (monitor.isEnabled()) {
          monitor.update({
            layout: {
              time: time.now(),
              event: `dropClient: ${rect.serialize()}`,
            },
          });
        }
        log(`Lost client: ${rect.serialize()}`);
      } else {
        if (monitor.isEnabled()) {
          monitor.update({
            layout: {
              time: time.now(),
              event: `dropClient: id ${clientId}`,
            },
          });
        }
      }
      delete clients[clientId];
    });

    // If the client notices an exception, it can send us that information to
    // the server via this channel. The framework might choose to respond to
    // this by, say, moving on to the next module.
    // socket.on("record-error", ...);
  });

  // Set up a timer to send the current time to clients every 10 seconds.
  setInterval(() => {
    wss.sendToAllClients("time", time.now());
  }, 10000);
}

// Return an object that can be opened to create an isolated per-module network,
// and closed to clean up after that module.
export function forModule(id: string) {
  let s: WSSWrapper;
  return {
    open() {
      s = wss.createRoom(id);
      return s;
    },
    close() {
      s?.close();
    },
  };
}
