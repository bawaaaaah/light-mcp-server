/**
 * WebSocket client for the hub (envelope {t, id, topic, data}; docs/architecture.md).
 * Two connections: control topics in JSON, DMX frames on the stream channel in msgpack (bytes
 * travel as native binary). The hub uses one codec per connection in both directions.
 * The connection itself is ws-channel.ts; here, the browser's ticket, socket and timers.
 */
import { wsTicket } from "./api";
import { Channel, type ChannelDeps, type SocketLike } from "./ws-channel";

const browser: ChannelDeps = {
  ticket: wsTicket,
  socket: (ticket, protocol) => {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    return new WebSocket(`${scheme}://${location.host}/api/ws?ticket=${encodeURIComponent(ticket)}`, protocol) as unknown as SocketLike;
  },
  later: (fn, ms) => setTimeout(fn, ms),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout> | undefined),
};

export const control = new Channel("control", "json", browser);
export const stream = new Channel("stream", "msgpack", browser);
