/**
 * Edits an Ableton Live Set (.als: gzipped XML) to lay out a setlist: one locator per song, one
 * clip per section on named MIDI tracks, a flat tempo step per song. Same method as the rack
 * builder — never write Live XML from scratch: clone a clip Live itself wrote on the track.
 *
 * Lessons from real use (docs/research/retour-experience-utilisateur.md):
 * - clips must be AUTONOMOUS (LoopEnd = their own length, StartRelative = 0). Clips that are
 *   windows onto longer content crashed Live at load beyond ~25 note-bearing clips;
 * - TakeId must be unique per clip (cloned duplicates crashed Live);
 * - tracks are found by name, never by position; everything else must come out unchanged;
 * - Live must be closed while writing (it keeps the set in memory and would overwrite it).
 */
import { gunzipSync, gzipSync } from "node:zlib";

export class LiveSetError extends Error {}

export interface ClipNote {
  time: number; // beats, relative to the clip start
  note: number;
  duration: number; // beats
  velocity?: number;
}

export interface ClipSpec {
  name: string;
  start: number; // beats in the arrangement
  end: number;
  notes: ClipNote[];
}

export interface TempoStep {
  start: number;
  end: number;
  bpm: number;
}

export function readAls(bytes: Buffer): string {
  return gunzipSync(bytes).toString("utf8");
}

export function writeAls(xml: string): Buffer {
  return gzipSync(Buffer.from(xml, "utf8"), { level: 9 });
}

function attr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const TRACK_RE = /^(\t*)<(MidiTrack|AudioTrack|GroupTrack|ReturnTrack) Id="\d+"[^>]*>\n[\s\S]*?^\1<\/\2>\n/gm;

export interface TrackInfo {
  kind: string;
  name: string;
  start: number;
  end: number;
}

/** Top-level tracks, with their user-visible name (the track's own Name/EffectiveName). */
export function listTracks(xml: string): TrackInfo[] {
  const out: TrackInfo[] = [];
  for (const m of xml.matchAll(TRACK_RE)) {
    // The track's own <Name> block comes before any device or clip.
    const name = /<Name>\s*<EffectiveName Value="([^"]*)" \/>/.exec(m[0])?.[1] ?? "";
    out.push({ kind: m[2]!, name, start: m.index!, end: m.index! + m[0].length });
  }
  return out;
}

function track(xml: string, name: string): TrackInfo {
  const matches = listTracks(xml).filter((t) => t.name === name);
  if (matches.length === 0) throw new LiveSetError(`track "${name}" not found (tracks: ${listTracks(xml).map((t) => t.name).join(", ")})`);
  if (matches.length > 1) throw new LiveSetError(`track name "${name}" is ambiguous`);
  return matches[0]!;
}

export function listLocators(xml: string): { time: number; name: string }[] {
  const block = /<Locators>\s*<Locators>([\s\S]*?)<\/Locators>\s*<\/Locators>/.exec(xml)?.[1] ?? "";
  return [...block.matchAll(/<Time Value="([^"]*)" \/>\s*<Name Value="([^"]*)" \/>/g)].map((m) => ({ time: Number(m[1]), name: m[2]! }));
}

export function setLocators(xml: string, entries: { time: number; name: string }[]): string {
  const m = /([ \t]*)<Locators>\n([ \t]*)<Locators>(?:\s*\/>|[\s\S]*?\n[ \t]*<\/Locators>)\n[ \t]*<\/Locators>/.exec(xml) ?? /([ \t]*)<Locators>\n([ \t]*)<Locators \/>\n[ \t]*<\/Locators>/.exec(xml);
  if (!m) throw new LiveSetError("<Locators> block not found");
  const [ind0, ind1] = [m[1]!, m[2]!];
  const i0 = `${ind1}\t`;
  const body = entries
    .map(
      (e, i) =>
        `${i0}<Locator Id="${i}">\n${i0}\t<LomId Value="0" />\n${i0}\t<Time Value="${e.time}" />\n${i0}\t<Name Value="${attr(e.name)}" />\n${i0}\t<Annotation Value="" />\n${i0}\t<IsSongStart Value="false" />\n${i0}</Locator>`,
    )
    .join("\n");
  const inner = entries.length ? `${ind1}<Locators>\n${body}\n${ind1}</Locators>` : `${ind1}<Locators />`;
  return xml.slice(0, m.index) + `${ind0}<Locators>\n${inner}\n${ind0}</Locators>` + xml.slice(m.index + m[0].length);
}

function keyTracks(notes: ClipNote[], indent: string): string {
  if (notes.length === 0) return `${indent}<KeyTracks />`;
  const i0 = `${indent}\t`;
  const i1 = `${i0}\t`;
  const i2 = `${i1}\t`;
  const lines = [`${indent}<KeyTracks>`];
  notes.forEach((n, k) => {
    lines.push(
      `${i0}<KeyTrack Id="${k}">`,
      `${i1}<Notes>`,
      `${i2}<MidiNoteEvent Time="${n.time}" Duration="${n.duration}" Velocity="${n.velocity ?? 100}" OffVelocity="64" NoteId="${k + 1}" />`,
      `${i1}</Notes>`,
      `${i1}<MidiKey Value="${n.note}" />`,
      `${i0}</KeyTrack>`,
    );
  });
  lines.push(`${indent}</KeyTracks>`);
  return lines.join("\n");
}

function setValue(block: string, tag: string, value: string | number): string {
  const re = new RegExp(`<${tag} Value="[^"]*" />`);
  if (!re.test(block)) throw new LiveSetError(`clip template has no <${tag}> — Live format changed?`);
  return block.replace(re, `<${tag} Value="${value}" />`);
}

/** Clones the template clip into an autonomous clip. */
export function buildClip(template: string, id: number, takeId: number, spec: ClipSpec): string {
  if (spec.end <= spec.start) throw new RangeError(`clip "${spec.name}": end must be after start`);
  const width = spec.end - spec.start;
  for (const n of spec.notes) {
    if (n.time < 0 || n.time + n.duration > width + 1e-9) throw new RangeError(`clip "${spec.name}": note outside the clip (autonomous clips only)`);
  }
  let c = template.replace(/<MidiClip Id="\d+" Time="[^"]*">/, `<MidiClip Id="${id}" Time="${spec.start}">`);
  for (const [tag, value] of [
    ["CurrentStart", spec.start],
    ["CurrentEnd", spec.end],
    ["LoopStart", 0],
    ["LoopEnd", width],
    ["StartRelative", 0],
    ["OutMarker", width],
    ["HiddenLoopStart", 0],
    ["HiddenLoopEnd", width],
    ["TakeId", takeId],
  ] as const) {
    c = setValue(c, tag, value);
  }
  c = c.replace(/<Name Value="[^"]*" \/>/, `<Name Value="${attr(spec.name)}" />`);
  c = c.replace(/(<NoteIdGenerator>\s*<NextId Value=")\d+(")/, `$1${spec.notes.length + 1}$2`);
  const kt = /([ \t]*)<KeyTracks(?:\s*\/>|>[\s\S]*?<\/KeyTracks>)/.exec(c);
  if (!kt) throw new LiveSetError("clip template has no <KeyTracks>");
  return c.slice(0, kt.index) + keyTracks(spec.notes, kt[1]!) + c.slice(kt.index + kt[0].length);
}

/**
 * Replaces the arrangement clips of a MIDI track with `clips`, cloned from the first clip already
 * on that track (draw one clip by hand in Live once). TakeIds start at `takeIdBase`.
 */
export function setTrackClips(xml: string, trackName: string, clips: ClipSpec[], takeIdBase = 1000): string {
  const t = track(xml, trackName);
  let seg = xml.slice(t.start, t.end);
  const tpl = /[ \t]*<MidiClip Id="\d+"[^>]*>[\s\S]*?<\/MidiClip>\n?/.exec(seg);
  if (!tpl) throw new LiveSetError(`track "${trackName}" has no clip to use as a template — draw one clip in Live first`);
  const events = /([ \t]*)<ArrangerAutomation>\s*\n?([ \t]*)(<Events\s*\/>|<Events>[\s\S]*?<\/Events>)/.exec(seg);
  if (!events) throw new LiveSetError(`track "${trackName}": arrangement <Events> not found`);
  const ind = events[2]!;
  const template = tpl[0].replace(/^[ \t]*/, "").replace(/\n?$/, "");
  const tplIndent = /^([ \t]*)/.exec(tpl[0])![1]!;
  const reindent = (s: string) => s.split("\n").map((l) => (l.startsWith(tplIndent) ? `${ind}\t${l.slice(tplIndent.length)}` : l)).join("\n");
  const body = clips.map((c, i) => reindent(tplIndent + buildClip(template, i, takeIdBase + i, c))).join("\n");
  const replacement = clips.length ? `<Events>\n${body}\n${ind}</Events>` : "<Events />";
  const start = events.index + events[0].length - events[3]!.length;
  seg = seg.slice(0, start) + replacement + seg.slice(start + events[3]!.length);
  return xml.slice(0, t.start) + seg + xml.slice(t.end);
}

/** Replaces the master tempo automation (PointeeId 8 in the MainTrack) with flat steps. */
export function setTempoSteps(xml: string, steps: TempoStep[]): string {
  const main = /<MainTrack[ >]/.exec(xml);
  if (!main) throw new LiveSetError("<MainTrack> not found");
  const head = xml.slice(0, main.index);
  const tail = xml.slice(main.index);
  const m = /(<AutomationEnvelope Id="\d+">\s*<EnvelopeTarget>\s*<PointeeId Value="8" \/>\s*<\/EnvelopeTarget>\s*<Automation>\s*<Events>\n)([ \t]*)<FloatEvent[\s\S]*?\n(?:[ \t]*<FloatEvent[^>]*\/>\n)*/.exec(tail);
  if (!m) throw new LiveSetError("tempo automation not found — draw one tempo automation point in Live first");
  const ind = m[2]!;
  const lines: string[] = [];
  let id = 0;
  for (const s of steps) {
    lines.push(`${ind}<FloatEvent Id="${id++}" Time="${s.start}" Value="${s.bpm}" />`, `${ind}<FloatEvent Id="${id++}" Time="${s.end}" Value="${s.bpm}" />`);
  }
  const newTail = tail.slice(0, m.index + m[1]!.length) + lines.join("\n") + "\n" + tail.slice(m.index + m[0].length);
  return head + newTail;
}

export interface LiveSetSummary {
  creator: string;
  tracks: TrackInfo[];
  locators: { time: number; name: string }[];
  clipCount: Record<string, number>;
  tempo: { time: number; bpm: number }[];
}

export function summarize(xml: string): LiveSetSummary {
  const tracks = listTracks(xml);
  const clipCount: Record<string, number> = {};
  for (const t of tracks) {
    const seg = xml.slice(t.start, t.end);
    const arr = /<ArrangerAutomation>[\s\S]*?<\/ArrangerAutomation>/.exec(seg)?.[0] ?? "";
    clipCount[t.name] = (arr.match(/<MidiClip Id=/g) ?? []).length;
  }
  const main = xml.slice(xml.search(/<MainTrack[ >]/));
  const env = /<PointeeId Value="8" \/>[\s\S]*?<Events>([\s\S]*?)<\/Events>/.exec(main)?.[1] ?? "";
  const tempo = [...env.matchAll(/<FloatEvent Id="\d+" Time="([^"]*)" Value="([^"]*)" \/>/g)].map((m) => ({ time: Number(m[1]), bpm: Number(m[2]) }));
  return { creator: /Creator="([^"]*)"/.exec(xml)?.[1] ?? "", tracks, locators: listLocators(xml), clipCount, tempo };
}
