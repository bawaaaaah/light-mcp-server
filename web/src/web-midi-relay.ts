/**
 * The Web MIDI relay's sending (docs/specs/midi.md, « Web MIDI »): over the live control connection itself (REST over the
 * WebSocket), so the server knows from the socket which connection relays, and lets go of what its wheels hold when it
 * closes. Pure of the browser: the channel is given (ws.ts's control; a fake in the tests).
 */
import type { Channel } from "./ws-channel.js";

const COMMANDS = "/api/plugins/light/commands/";

/**
 * Sends a command over `channel`, only while it is online: while it reconnects, a message is dropped, never kept for later
 * (a wheel held must not fire late). A refusal is said (`refused`) and the connection opened again.
 */
export function relayOver(channel: Pick<Channel, "online" | "request" | "reconnect">, command: string, body: unknown, refused: (why: string) => void): void {
  if (!channel.online) return;
  void channel.request("POST", `${COMMANDS}${command}`, body).then(
    (r) => {
      if (r.status === 200) return;
      refused((r.body as { error?: string } | null)?.error ?? String(r.status));
      channel.reconnect();
    },
    (e: Error) => {
      if (e.message === "offline") return; // the connection went meanwhile: dropped, as while reconnecting
      refused(e.message);
      channel.reconnect();
    },
  );
}
