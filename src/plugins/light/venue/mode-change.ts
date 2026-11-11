/**
 * Changing a patched fixture's DMX mode (T6, docs/specs/venue-fixtures-stage.md, « Mode DMX d'un
 * appareil »): what moves and what is lost in the objects that name its channels by offset (the raw
 * channels of looks, the channels of channel faders) and its heads by index (canvas targets). They
 * are carried over by channel name (decision T6, question 4).
 *
 * Matching rule, exact: the channel's name at the old offset must be found as it is in the new mode,
 * once in each of the two modes; its new offset is where it is found. A name absent from the new mode,
 * or repeated in either mode (ambiguous), is lost. A head is known by the set of its channels' names.
 *
 * Pure: `from` and `to` are any two layouts (two modes of one definition here; two definitions for
 * T20b), the objects are given and the rewritten ones returned, nothing is written.
 */

/** A mode as the carry-over reads it: its channel names by offset, and its heads (index → channel offsets). */
export interface ModeLayout {
  channels: readonly string[];
  /** Head index → the offsets of its channels; -1 alone: a fixture painted as one. */
  heads: ReadonlyMap<number, readonly number[]>;
}

export type ChannelFate =
  | { kind: "same"; offset: number; name: string }
  | { kind: "moved"; offset: number; to: number; name: string }
  | { kind: "lost"; offset: number; name?: string; why: "absent" | "ambiguous" | "beyond" };

export type HeadFate = { kind: "same" | "moved"; head: number; to: number } | { kind: "lost"; head: number };

export interface Remap {
  channel(offset: number): ChannelFate;
  head(head: number): HeadFate;
}

const counts = (names: readonly string[]) => {
  const n = new Map<string, number>();
  for (const x of names) n.set(x, (n.get(x) ?? 0) + 1);
  return n;
};
const headKey = (layout: ModeLayout, offsets: readonly number[]) => JSON.stringify([...new Set(offsets.map((o) => layout.channels[o] ?? ""))].sort());

/** How each offset and head of `from` lands in `to`, by channel name. */
export function remapByName(from: ModeLayout, to: ModeLayout): Remap {
  const inFrom = counts(from.channels);
  const inTo = counts(to.channels);
  const realHeads = (l: ModeLayout) => [...l.heads.keys()].filter((h) => h >= 0);
  const toHeads = new Map<string, number[]>();
  for (const h of realHeads(to)) {
    if (!to.heads.get(h)!.length) continue;
    const k = headKey(to, to.heads.get(h)!);
    toHeads.set(k, [...(toHeads.get(k) ?? []), h]);
  }
  return {
    channel(offset) {
      const name = from.channels[offset];
      if (name === undefined) return { kind: "lost", offset, why: "beyond" };
      if ((inFrom.get(name) ?? 0) > 1 || (inTo.get(name) ?? 0) > 1) return { kind: "lost", offset, name, why: "ambiguous" };
      const to2 = to.channels.indexOf(name);
      if (to2 < 0) return { kind: "lost", offset, name, why: "absent" };
      return to2 === offset ? { kind: "same", offset, name } : { kind: "moved", offset, to: to2, name };
    },
    head(head) {
      if (head < 0) return { kind: "same", head, to: head };
      const offsets = from.heads.get(head);
      if (!offsets) {
        // a head the old mode did not have: nothing to match it by
        return { kind: "lost", head };
      }
      // a head with no channel name to know it by matches nothing (two empty heads would pair by chance)
      const k = headKey(from, offsets);
      const found = offsets.length ? toHeads.get(k) : undefined;
      if (found?.length === 1) return { kind: found[0] === head ? "same" : "moved", head, to: found[0]! };
      // no distinct heads left: the whole fixture, only when the old mode had a single one (else which one?)
      if (!found && realHeads(to).length === 0 && realHeads(from).length === 1) return { kind: "moved", head, to: -1 };
      return { kind: "lost", head };
    },
  };
}

export interface ChannelRef {
  fixture: string;
  offset: number;
}
export interface LookLike {
  id: string;
  name: string;
  channels?: { targets: ChannelRef[]; steps: number[][] };
}
export interface FaderLike {
  id: string;
  name: string;
  channels: ChannelRef[];
}
export interface CanvasLike {
  id: string;
  name: string;
  cells: number;
  render: { from: number; to: number; targets: { fixture: string; head: number }[] }[];
}

/** One reference to the fixture and what becomes of it. */
export interface Carried {
  /** looks, faders (channels) or canvases (heads) */
  kind: "look" | "fader" | "canvas";
  id: string;
  name: string;
  /** The channel's offset or the head's index before. */
  from: number;
  /** After; absent when lost. */
  to?: number;
  /** The channel's name (channels only). */
  channel?: string;
  fate: "same" | "moved" | "lost";
  why?: "absent" | "ambiguous" | "beyond";
}

export interface ModePlan<L, F, C> {
  carried: Carried[];
  /** The objects to write again (something moved or was lost), rewritten; the others are not listed. */
  looks: L[];
  faders: F[];
  canvases: C[];
  /** Faders left with no channel at all: they cannot stay (a fader drives one channel at least). */
  emptied: F[];
  /** Per canvas, the cells left with no target at all once lost targets are taken out. */
  cellsWithoutRender: { canvas: string; name: string; cells: number[] }[];
}

/**
 * The plan of a mode change for one fixture: its looks' raw channels, its faders' channels and its canvas
 * targets, carried by `remap`. A lost raw channel is taken out of the look (its column of steps with it);
 * a lost fader channel out of the fader; a lost canvas target out of `render` (never left dangling).
 */
export function planReferences<L extends LookLike, F extends FaderLike, C extends CanvasLike>(fixture: string, remap: Remap, parts: { looks: readonly L[]; faders: readonly F[]; canvases: readonly C[] }): ModePlan<L, F, C> {
  const carried: Carried[] = [];
  const note = (kind: Carried["kind"], o: { id: string; name: string }, fate: ChannelFate) =>
    carried.push({ kind, id: o.id, name: o.name, from: fate.offset, ...(fate.kind === "lost" ? { why: fate.why } : { to: fate.kind === "moved" ? fate.to : fate.offset }), ...(fate.name !== undefined ? { channel: fate.name } : {}), fate: fate.kind });
  const looks: L[] = [];
  for (const look of parts.looks) {
    const ch = look.channels;
    if (!ch?.targets.some((t) => t.fixture === fixture)) continue;
    const keep: number[] = [];
    const targets: ChannelRef[] = [];
    let changed = false;
    ch.targets.forEach((t, i) => {
      if (t.fixture !== fixture) return void (keep.push(i), targets.push(t));
      const fate = remap.channel(t.offset);
      note("look", look, fate);
      if (fate.kind === "lost") return void (changed = true);
      if (fate.kind === "moved") changed = true;
      keep.push(i);
      targets.push({ ...t, offset: fate.kind === "moved" ? fate.to : t.offset });
    });
    if (!changed) continue;
    const { channels: _drop, ...rest } = look;
    looks.push((targets.length ? { ...rest, channels: { targets, steps: ch.steps.map((row) => keep.map((i) => row[i] ?? 0)) } } : rest) as L);
  }
  const faders: F[] = [];
  const emptied: F[] = [];
  for (const fader of parts.faders) {
    if (!fader.channels.some((c) => c.fixture === fixture)) continue;
    let changed = false;
    const channels = fader.channels.flatMap((c) => {
      if (c.fixture !== fixture) return [c];
      const fate = remap.channel(c.offset);
      note("fader", fader, fate);
      if (fate.kind === "lost") return (changed = true), [];
      if (fate.kind === "moved") changed = true;
      return [{ ...c, offset: fate.kind === "moved" ? fate.to : c.offset }];
    });
    if (!changed) continue;
    if (channels.length) faders.push({ ...fader, channels });
    else emptied.push(fader);
  }
  const canvases: C[] = [];
  const cellsWithoutRender: ModePlan<L, F, C>["cellsWithoutRender"] = [];
  for (const canvas of parts.canvases) {
    if (!canvas.render.some((r) => r.targets.some((t) => t.fixture === fixture))) continue;
    let changed = false;
    const seen = new Set<number>();
    const render = canvas.render
      .map((r) => ({
        ...r,
        targets: r.targets.flatMap((t) => {
          if (t.fixture !== fixture) return [t];
          const fate = remap.head(t.head);
          if (!seen.has(t.head)) {
            seen.add(t.head);
            carried.push({ kind: "canvas", id: canvas.id, name: canvas.name, from: t.head, ...(fate.kind === "lost" ? {} : { to: fate.to }), fate: fate.kind });
          }
          if (fate.kind === "lost") return (changed = true), [];
          if (fate.to !== t.head) changed = true;
          return [{ ...t, head: fate.to }];
        }),
      }))
      .filter((r) => r.targets.length > 0);
    if (!changed) continue;
    const lit = new Set<number>();
    for (const r of render) for (let i = r.from; i <= Math.min(r.to, canvas.cells - 1); i++) lit.add(i);
    const wasLit = new Set<number>();
    for (const r of canvas.render) for (let i = r.from; i <= Math.min(r.to, canvas.cells - 1); i++) wasLit.add(i);
    const dark = [...wasLit].filter((i) => !lit.has(i)).sort((a, b) => a - b);
    if (dark.length) cellsWithoutRender.push({ canvas: canvas.id, name: canvas.name, cells: dark });
    canvases.push({ ...canvas, render });
  }
  return { carried, looks, faders, canvases, emptied, cellsWithoutRender };
}

/**
 * The first start address in `universe` where `channels` channels fit without sharing one with the
 * others (`ranges`, the fixture itself left out), or undefined when the universe has no such room.
 */
export function freeAddress(ranges: readonly { id: string; universe: number; address: number; channels: number }[], universe: number, channels: number, except: string, slots = 512): number | undefined {
  const taken = ranges
    .filter((r) => r.universe === universe && r.id !== except)
    .map((r) => [r.address, r.address + Math.max(1, r.channels) - 1] as const)
    .sort((a, b) => a[0] - b[0]);
  let at = 1;
  for (const [from, to] of taken) {
    if (at + channels - 1 < from) return at;
    at = Math.max(at, to + 1);
  }
  return at + channels - 1 <= slots ? at : undefined;
}
