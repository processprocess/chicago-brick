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

// A handy wrapper around peer.js that makes it easy for client modules to
// connect to one another.
import * as info from '../util/info.ts';
import {easyLog} from '/lib/log.ts';
import * as network from './network.js';

const log = easyLog('wall:peer');

const peers = new Map();
const myPeerid = `${info.virtualOffset.x},${info.virtualOffset.y}`;
const handlers = new Map();

function addChannelEventListeners(channel, peerid) {
  channel.addEventListener('open', () => {
    log('Open channel with peer:', peerid);
    const peer = peers.get(peerid);
    if (!peer) {
      log.error('Bad peer connection. No record found for peer', peerid);
      return;
    }
    fire('connection', peerid, peerid);
  });
  channel.addEventListener('message', event => {
    log(`Received message from ${peerid}`);
    const {data} = event;
    try {
      const [msgType, payload] = JSON.parse(data);
      fire(msgType, payload, peerid);
    } catch (e) {
      log.error(`Invalid message from peer: ${peerid}`);
    }
  });
  channel.addEventListener('close', () => {
    log(`Closed channel with peer: ${peerid}`);
    peers.delete(peerid);
    fire('disconnect', peerid, peerid);
  });
  channel.addEventListener('error', event => {
    log.error(`Error with peer: ${peerid}`, event.error);
  });
}

function addIceEventListeners(connection, peerid) {
  connection.addEventListener('icecandidate', event => {
    network.send('peer-icecandidate', {
      from: myPeerid,
      to: peerid,
      candidate: event.candidate,
    });
  });
}

async function connect(peerid) {
  const connection = new RTCPeerConnection({iceServers: [{urls: 'stun:stun.l.google.com:19302'}]});
  const channel = connection.createDataChannel(peerid);
  const peer = {
    id: peerid,
    connection,
    channel,
  };
  peers.set(peerid, peer);
  addChannelEventListeners(channel, peerid);
  addIceEventListeners(connection, peerid);

  const offer = await connection.createOffer();
  await connection.setLocalDescription(offer);

  network.send('peer-offer', {
    from: myPeerid,
    to: peerid,
    offer,
  });
}

export function init(network) {
  network.on('peer-list', msg => {
    const {knownPeers} = msg;
    log(`peer-list: got ${knownPeers.length}`);
    for (const peerid of knownPeers) {
      connect(peerid);
    }
  });
  network.on('peer-icecandidate', async msg => {
    const {from, candidate} = msg;
    log(`peer-icecandidate from: ${from}`);
    const peer = peers.get(from);
    if (!peer) {
      log.error(`Unknown ice-candidate from: ${from}`);
      return;
    }
    try {
      await peer.connection.addIceCandidate(candidate);
    } catch (e) {
      log.error(`Error adding ice candidate from: ${from}`);
    }
    log(`peer-icecandidate accepted from: ${from}`);
  });
  network.on('peer-offer', async msg => {
    const {from, offer} = msg;
    log(`peer-offer from: ${from}`);
    const connection = new RTCPeerConnection({iceServers: [{urls: 'stun:stun.l.google.com:19302'}]});
    const peer = {
      id: from,
      connection,
    };
    peers.set(from, peer);
    connection.addEventListener('datachannel', e => {
      log(`Created data channel by: ${from}`);
      peer.channel = e.channel;
      addChannelEventListeners(peer.channel, from);
    });
    addIceEventListeners(connection, from);
    connection.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);
    log(`Sending answer to: ${from}`);
    network.send('peer-answer', {
      from: myPeerid,
      to: from,
      answer,
    });
  });
  network.on('peer-answer', async msg => {
    const {from, answer} = msg;
    log(`peer-answer from: ${from}`);
    const peer = peers.get(from);
    if (!peer) {
      log.error(`Answer from unknown peer: ${from}`);
      return;
    }
    await peer.connection.setRemoteDescription(new RTCSessionDescription(answer));
    log(`peer-answer accepted from: ${from}`);
  });
  network.send('peer-register', {id: myPeerid});
}

export function sendToAllPeers(msgType, payload) {
  for (const [peer] of peers.values()) {
    peer.channel.send(JSON.stringify([msgType, payload]));
  }
}

export function send(peerid, msgType, payload) {
  const peer = peer.get(peerid);
  if (!peer) {
    log.error(`Asked to send data to non-existent peer: ${peerid}`);
    return;
  }
  peer.channel.send(JSON.stringify([msgType, payload]));
}

export function on(msgType, handler) {
  const msgHandlers = handlers.get(msgType) || [];
  msgHandlers.push(handler);
  handlers.set(msgType, msgHandlers);
}

function fire(msgType, payload, peerid) {
  const msgHandlers = handlers.get(msgType);
  if (!msgHandlers) {
    return;
  }
  for (const handler of msgHandlers) {
    handler(payload, peerid);
  }
}

export function forModule(moduleid) {
  // Return an object that provides "scoped" versions of the standard api.
  const handlers = new Set();
  return {
    send(peerid, msgType, payload) {
      send(peerid, `${moduleid}-${msgType}`, payload);
    },
    sendToAllPeers(msgType, payload) {
      sendToAllPeers(`${moduleid}-${msgType}`, payload);
    },
    on(msgType, handler) {
      const handlerName = `${moduleid}-${msgType}`;
      handlers.add(handlerName);
      on(handlerName, handler);
    },
    cleanup() {
      for (const name of handlers) {
        handlers.delete(name);
      }
    },
  };
}
