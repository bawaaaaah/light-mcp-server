/**
 * OS2L (Open Sound to Light, docs/specs/midi.md, « OS2L ») : what DJ software (VirtualDJ…) sends a
 * lighting server over TCP — JSON objects one after the other, with anything or nothing between
 * them. Pure: bytes in, events out.
 *
 * - beat: `{"evt":"beat","change":false,"pos":128,"bpm":124.0,"strength":0.4}` on each beat;
 *   `change` when the beats jumped (a new track, a scratch), `pos` the beat in the track;
 * - btn: `{"evt":"btn","name":"Strobe","page":"…","state":"on"}` a button of the DJ's pad;
 * - cmd: `{"evt":"cmd","id":3,"param":0.5}` a numbered command, `param` 0..1;
 * - feedback (lighting → DJ): `{"evt":"feedback","name":"Strobe","page":"…","state":"on"}`.
 */

export type Os2lEvent =
  | { evt: "beat"; change: boolean; pos: number; bpm: number; strength: number }
  | { evt: "btn"; name: string; page?: string; state: "on" | "off" }
  | { evt: "cmd"; id: number; param: number };

/** Reads a stream of JSON objects; a message cut between two TCP packets waits for its end. */
export class Os2lReader {
  private buffer = "";

  push(chunk: string): Os2lEvent[] {
    this.buffer += chunk;
    const out: Os2lEvent[] = [];
    let depth = 0;
    let inString = false;
    let start = -1;
    for (let i = 0; i < this.buffer.length; i++) {
      const c = this.buffer[i];
      if (inString) {
        if (c === "\\") i++;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"' && depth > 0) inString = true;
      else if (c === "{") {
        if (depth === 0) start = i;
        depth++;
      } else if (c === "}" && depth > 0 && --depth === 0) {
        const event = toEvent(this.buffer.slice(start, i + 1));
        if (event) out.push(event);
      }
    }
    // what is left: an unfinished object (kept), or noise between objects (dropped)
    this.buffer = depth > 0 ? this.buffer.slice(start) : "";
    if (this.buffer.length > 64 * 1024) this.buffer = ""; // never a message: not OS2L
    return out;
  }
}

function toEvent(text: string): Os2lEvent | undefined {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN);
  switch (o.evt) {
    case "beat": {
      const bpm = num(o.bpm);
      if (!(bpm > 0)) return undefined;
      return { evt: "beat", change: o.change === true || o.change === "true", pos: Number.isFinite(num(o.pos)) ? num(o.pos) : 0, bpm, strength: Number.isFinite(num(o.strength)) ? num(o.strength) : 0 };
    }
    case "btn":
      if (typeof o.name !== "string" || !o.name.trim()) return undefined;
      return { evt: "btn", name: o.name.trim(), ...(typeof o.page === "string" && o.page ? { page: o.page } : {}), state: o.state === "off" ? "off" : "on" };
    case "cmd": {
      const id = num(o.id);
      const param = num(o.param);
      if (!Number.isFinite(id)) return undefined;
      return { evt: "cmd", id, param: Number.isFinite(param) ? Math.max(0, Math.min(1, param)) : 0 };
    }
    default:
      return undefined;
  }
}

/** A button's state for the DJ's pad. */
export const encodeFeedback = (name: string, on: boolean, page?: string): string => JSON.stringify({ evt: "feedback", name, ...(page ? { page } : {}), state: on ? "on" : "off" });
