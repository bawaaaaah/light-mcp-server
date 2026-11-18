/**
 * The Web MIDI relay's sending (docs/specs/midi.md, « Web MIDI »): over the live control connection itself (REST over the
 * WebSocket), so the server knows from the socket which connection relays, and lets go of what its wheels hold when it
 * closes. Pure of the browser: the channel is given (ws.ts's control; a fake in the tests).
 */
import type { Channel } from "./ws-channel.js";

const COMMANDS = "/api/plugins/light/commands/";

/** What the page hears of a relayed request's fate (a batch of messages, or an input said gone). */
export interface RelayOutcome {
  /** Accepted: a refusal said before is over. */
  ok: () => void;
  /** Refused (by its connection, already said closed; or another error): said; the relay goes on. */
  refused: (why: string) => void;
  /** Refused for a right missing (403): said, and the relay stops (more would only be refused). */
  forbidden: () => void;
  /** Dropped by the server past the flow's rate (429): counted and said there; the page may send it again. */
  dropped?: () => void;
  /** Any other end: accepted, refused, or not sent at all (offline). */
  settled?: () => void;
}

/** The refusal the server gives a connection already said closed: the only one a new connection cures. */
const CLOSED = 422;
const FORBIDDEN = 403;
/** Dropped by the server past the flow's rate: counted and said there; given to `outcome.dropped` (the batcher sends it again, a window later, until it is taken — unless a newer message made it stale). */
const DROPPED = 429;

/**
 * Sends a command over `channel`, only while it is online: while it reconnects, a message is dropped, never kept for later
 * (a wheel held must not fire late). A connection the server says closed (422) is opened again; a missing right (403)
 * stops the relay without touching the connection every page shares.
 */
export function relayOver(channel: Pick<Channel, "online" | "request" | "reconnect">, command: string, body: unknown, outcome: RelayOutcome): void {
  if (!channel.online) return outcome.settled?.();
  void channel.request("POST", `${COMMANDS}${command}`, body).then(
    (r) => {
      if (r.status === DROPPED) return outcome.dropped?.();
      outcome.settled?.();
      if (r.status === 200) return outcome.ok();
      if (r.status === FORBIDDEN) return outcome.forbidden();
      const why = (r.body as { error?: string } | null)?.error ?? String(r.status);
      outcome.refused(why);
      if (r.status === CLOSED) channel.reconnect();
    },
    (e: Error) => {
      outcome.settled?.();
      if (e.message === "offline") return; // the connection went meanwhile: dropped, as while reconnecting
      outcome.refused(e.message);
    },
  );
}
