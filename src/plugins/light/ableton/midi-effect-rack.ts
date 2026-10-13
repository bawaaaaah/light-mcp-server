/**
 * Builds an Ableton Live MIDI Effect Rack (.adg) whose chains are named after light actions, each
 * on a one-key zone. In Live, the chain lights up when its note plays: a living legend of what a
 * clip triggers (docs/specs/midi.md).
 *
 * Live's XML is never written by hand: we clone the single <MidiEffectBranchPreset> of a "shell"
 * rack exported unmodified by the user's own Live version, and only change Name, colour and
 * KeyRange. Everything else must come out byte for byte identical.
 */
import { gunzipSync, gzipSync } from "node:zlib";

export interface RackChain {
  name: string;
  note: number; // 0..127
  /** Live palette colour index (0-69). */
  color: number;
}

export interface RackSpec {
  /** Shown by Live once the rack is dropped on a track: put the show / band / channel here. */
  userName: string;
  /** Device info text: the place for CC legends, which cannot be chains. */
  annotation: string;
  chains: RackChain[];
}

const BRANCH_RE = /(\t*)<MidiEffectBranchPreset Id="\d+">[\s\S]*?<\/MidiEffectBranchPreset>\n/;
const DEVICE_LABEL_RE = /<UserName Value="[^"]*" \/>(\s*)<Annotation Value="[^"]*" \/>/;
const KEY_RANGE_RE =
  /(<ZoneSettings>\s*<KeyRange>\s*)<Min Value="\d+" \/>(\s*)<Max Value="\d+" \/>(\s*)<CrossfadeMin Value="\d+" \/>(\s*)<CrossfadeMax Value="\d+" \/>/;

export class ShellError extends Error {}

function xmlAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function replaceOnce(text: string, re: RegExp, replacement: (m: RegExpExecArray) => string, what: string): string {
  const m = re.exec(text);
  if (!m) throw new ShellError(`shell rack: ${what} not found — was the shell modified or from another Live version?`);
  return text.slice(0, m.index) + replacement(m) + text.slice(m.index + m[0].length);
}

function branchFor(template: string, index: number, chain: RackChain): string {
  if (!Number.isInteger(chain.note) || chain.note < 0 || chain.note > 127) {
    throw new RangeError(`chain "${chain.name}": note ${chain.note} out of 0..127`);
  }
  let b = template.replace(/<MidiEffectBranchPreset Id="\d+">/, `<MidiEffectBranchPreset Id="${index}">`);
  b = replaceOnce(b, /<Name Value="[^"]*" \/>/, () => `<Name Value="${xmlAttr(chain.name)}" />`, "branch Name");
  b = replaceOnce(b, /<DocumentColorIndex Value="-?\d+" \/>/, () => `<DocumentColorIndex Value="${chain.color}" />`, "DocumentColorIndex");
  b = replaceOnce(b, /<AutoColored Value="\w+" \/>/, () => `<AutoColored Value="false" />`, "AutoColored");
  // Only the KeyRange of ZoneSettings: BranchSelectorRange has the very same shape, earlier on.
  const n = chain.note;
  b = replaceOnce(
    b,
    KEY_RANGE_RE,
    (m) =>
      `${m[1]}<Min Value="${n}" />${m[2]}<Max Value="${n}" />${m[3]}<CrossfadeMin Value="${n}" />${m[4]}<CrossfadeMax Value="${n}" />`,
    "ZoneSettings/KeyRange",
  );
  return b;
}

/** Builds the rack XML from the shell XML. Throws ShellError if the shell is not usable. */
export function buildRackXml(shellXml: string, spec: RackSpec): string {
  const notes = new Set<number>();
  for (const c of spec.chains) {
    if (notes.has(c.note)) throw new RangeError(`note ${c.note} used by two chains: a note in two key zones is duplicated`);
    notes.add(c.note);
  }
  const template = BRANCH_RE.exec(shellXml);
  if (!template) throw new ShellError("shell rack: no <MidiEffectBranchPreset> to clone — the shell needs exactly one chain");
  const body = spec.chains.map((c, i) => branchFor(template[0], i, c)).join("");
  let xml = shellXml.slice(0, template.index) + body + shellXml.slice(template.index + template[0].length);
  // The first UserName/Annotation pair belongs to the group device (branch mixers come later).
  xml = replaceOnce(
    xml,
    DEVICE_LABEL_RE,
    (m) => `<UserName Value="${xmlAttr(spec.userName)}" />${m[1]}<Annotation Value="${xmlAttr(spec.annotation)}" />`,
    "device UserName/Annotation",
  );
  return xml;
}

export function readAdg(bytes: Buffer): string {
  return gunzipSync(bytes).toString("utf8");
}

/** Deterministic gzip (no mtime), so two runs give identical bytes. */
export function writeAdg(xml: string): Buffer {
  return gzipSync(Buffer.from(xml, "utf8"), { level: 9 });
}

/** Lists the chains of a rack XML: used to verify a generated rack (and by tests). */
export function listChains(xml: string): RackChain[] {
  const chains: RackChain[] = [];
  const re = /<MidiEffectBranchPreset Id="\d+">([\s\S]*?)<\/MidiEffectBranchPreset>/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const block = m[1]!;
    const name = /<Name Value="([^"]*)" \/>/.exec(block)?.[1] ?? "";
    const color = Number(/<DocumentColorIndex Value="(-?\d+)" \/>/.exec(block)?.[1] ?? NaN);
    const note = Number(/<ZoneSettings>\s*<KeyRange>\s*<Min Value="(\d+)" \/>/.exec(block)?.[1] ?? NaN);
    chains.push({ name: name.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"), note, color });
  }
  return chains;
}
