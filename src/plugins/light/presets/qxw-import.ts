/**
 * QLC+ workspace (.qxw) import → neutral model: fixtures, functions (scenes, sequences, chasers,
 * collections, matrices), Virtual Console widgets with their MIDI inputs, solo frames (exclusive
 * groups) and speed dials. Pure: takes the XML text.
 *
 * QLC+ MIDI input channel numbering (plugins/midi/src/common/midiprotocol.h, QLC+ 4.14):
 *   CC n → n, Note n → 128+n, poly aftertouch → 256+n, program change → 384+n,
 *   channel aftertouch 512, pitch wheel 513, MIDI beat clock: playback 529, beat 530, stop 531;
 *   + 4096 × (MIDI channel − 1) when the plugin listens to all channels.
 */
import { XMLParser } from "fast-xml-parser";

export interface QxwFixture {
  id: number;
  name: string;
  manufacturer: string;
  model: string;
  mode: string;
  universe: number;
  address: number; // 0-based
  channels: number;
}

export interface QxwStep {
  fadeIn: number;
  hold: number;
  fadeOut: number;
  /** fixtureId → (channel offset → value) */
  values: Map<number, Map<number, number>>;
  functionId?: number; // chaser steps
}

export interface QxwFunction {
  id: number;
  type: string;
  name: string;
  path: string;
  speed: { fadeIn: number; fadeOut: number; duration: number };
  runOrder?: string;
  direction?: string;
  speedModes?: { fadeIn: string; fadeOut: string; duration: string };
  boundScene?: number;
  steps: QxwStep[];
  /** Scene channel values: fixtureId → (channel → value) */
  values: Map<number, Map<number, number>>;
  /** Collection members */
  members: number[];
}

export type MidiBinding =
  | { kind: "note"; channel: number; note: number }
  | { kind: "cc"; channel: number; controller: number }
  | { kind: "programchange"; channel: number; program: number }
  | { kind: "polyaftertouch"; channel: number; note: number }
  | { kind: "clock"; what: "playback" | "beat" | "stop" }
  | { kind: "other"; raw: number };

export interface QxwWidget {
  kind: "button" | "slider" | "speeddial" | "cuelist" | "label" | "xypad" | "other";
  id: number;
  caption: string;
  /** Solo frame that makes this widget exclusive with its siblings. */
  soloFrame?: number;
  frames: string[]; // captions of enclosing frames
  functionId?: number;
  action?: string;
  input?: { universe: number; channel: number; midi: MidiBinding };
  sliderMode?: string;
  levelChannels?: { fixture: number; channel: number }[];
  speedDialFunctions?: { id: number; fadeIn: number; fadeOut: number; duration: number }[];
}

export interface QxwWorkspace {
  qlcVersion: string;
  fixtures: QxwFixture[];
  functions: Map<number, QxwFunction>;
  widgets: QxwWidget[];
  soloFrames: { id: number; caption: string; members: number[] }[];
}

const ARRAYS = new Set(["Fixture", "Function", "Step", "FixtureVal", "Universe", "Frame", "SoloFrame", "Button", "Slider", "SpeedDial", "CueList", "Label", "XYPad", "Channel", "Input"]);
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  isArray: (name) => ARRAYS.has(name),
});

type Node = Record<string, unknown>;
const txt = (v: unknown): string => (v === undefined || v === null ? "" : typeof v === "object" ? String((v as Node)["#text"] ?? "") : String(v)).trim();
const num = (v: unknown, d = 0): number => {
  const n = Number(txt(v));
  return Number.isFinite(n) ? n : d;
};

export function decodeMidiInput(channel: number): MidiBinding {
  const midiChannel = (channel >> 12) + 1;
  const c = channel & 0x0fff;
  if (c === 529) return { kind: "clock", what: "playback" };
  if (c === 530) return { kind: "clock", what: "beat" };
  if (c === 531) return { kind: "clock", what: "stop" };
  if (c < 128) return { kind: "cc", channel: midiChannel, controller: c };
  if (c < 256) return { kind: "note", channel: midiChannel, note: c - 128 };
  if (c < 384) return { kind: "polyaftertouch", channel: midiChannel, note: c - 256 };
  if (c < 512) return { kind: "programchange", channel: midiChannel, program: c - 384 };
  return { kind: "other", raw: channel };
}

/** "0:7,103,8,9:1:7,255" → fixture → channel → value */
export function parseStepValues(raw: string): Map<number, Map<number, number>> {
  const out = new Map<number, Map<number, number>>();
  const parts = raw.trim().split(":");
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const fixture = Number(parts[i]);
    const nums = parts[i + 1]!.split(",").filter(Boolean).map(Number);
    const map = new Map<number, number>();
    for (let k = 0; k + 1 < nums.length; k += 2) map.set(nums[k]!, nums[k + 1]!);
    out.set(fixture, map);
  }
  return out;
}

function parseFunction(f: Node): QxwFunction {
  const speed = (f["Speed"] as Node | undefined) ?? {};
  const sm = f["SpeedModes"] as Node | undefined;
  const fn: QxwFunction = {
    id: num(f["@_ID"]),
    type: String(f["@_Type"]),
    name: String(f["@_Name"] ?? ""),
    path: String(f["@_Path"] ?? ""),
    speed: { fadeIn: num(speed["@_FadeIn"]), fadeOut: num(speed["@_FadeOut"]), duration: num(speed["@_Duration"]) },
    runOrder: f["RunOrder"] !== undefined ? txt(f["RunOrder"]) : undefined,
    direction: f["Direction"] !== undefined ? txt(f["Direction"]) : undefined,
    speedModes: sm ? { fadeIn: String(sm["@_FadeIn"]), fadeOut: String(sm["@_FadeOut"]), duration: String(sm["@_Duration"]) } : undefined,
    boundScene: f["@_BoundScene"] !== undefined ? num(f["@_BoundScene"]) : undefined,
    steps: [],
    values: new Map(),
    members: [],
  };
  for (const s of (f["Step"] as Node[] | undefined) ?? []) {
    const body = txt(s);
    const isChaserStep = fn.type === "Chaser" || (!body.includes(":") && /^\d+$/.test(body));
    fn.steps.push({
      fadeIn: num(s["@_FadeIn"]),
      hold: num(s["@_Hold"]),
      fadeOut: num(s["@_FadeOut"]),
      values: isChaserStep ? new Map() : parseStepValues(body),
      functionId: isChaserStep ? Number(body) : undefined,
    });
  }
  for (const fv of (f["FixtureVal"] as Node[] | undefined) ?? []) {
    const nums = txt(fv).split(",").filter(Boolean).map(Number);
    const map = new Map<number, number>();
    for (let k = 0; k + 1 < nums.length; k += 2) map.set(nums[k]!, nums[k + 1]!);
    fn.values.set(num(fv["@_ID"]), map);
  }
  const fns = f["Function"];
  if (fn.type === "Collection" && fns) fn.members = (Array.isArray(fns) ? fns : [fns]).map((x) => num(x));
  return fn;
}

function inputOf(w: Node): QxwWidget["input"] {
  const inputs = w["Input"] as Node[] | undefined;
  const input = inputs?.[0];
  if (!input) return undefined;
  const channel = num(input["@_Channel"]);
  return { universe: num(input["@_Universe"]), channel, midi: decodeMidiInput(channel) };
}

function walkVc(node: Node, frames: string[], solo: number | undefined, out: QxwWidget[], soloFrames: QxwWorkspace["soloFrames"]): void {
  for (const b of (node["Button"] as Node[] | undefined) ?? []) {
    const fn = b["Function"] as Node | undefined;
    out.push({ kind: "button", id: num(b["@_ID"]), caption: String(b["@_Caption"] ?? ""), soloFrame: solo, frames, functionId: fn ? num(fn["@_ID"]) : undefined, action: txt(b["Action"]), input: inputOf(b) });
  }
  for (const s of (node["Slider"] as Node[] | undefined) ?? []) {
    const level = s["Level"] as Node | undefined;
    const chans = ((level?.["Channel"] as unknown[]) ?? []).map((c) => ({ fixture: num((c as Node)["@_Fixture"]), channel: num(c) }));
    out.push({ kind: "slider", id: num(s["@_ID"]), caption: String(s["@_Caption"] ?? ""), soloFrame: solo, frames, sliderMode: txt(s["SliderMode"]), input: inputOf(s), levelChannels: chans });
  }
  for (const d of (node["SpeedDial"] as Node[] | undefined) ?? []) {
    const fns = d["Function"];
    const list = (Array.isArray(fns) ? fns : fns ? [fns] : []) as Node[];
    const tap = d["Tap"] as Node | undefined;
    out.push({
      kind: "speeddial",
      id: num(d["@_ID"]),
      caption: String(d["@_Caption"] ?? ""),
      frames,
      input: tap ? inputOf(tap) : undefined,
      speedDialFunctions: list.map((f) => ({ id: num(f), fadeIn: num(f["@_FadeIn"]), fadeOut: num(f["@_FadeOut"]), duration: num(f["@_Duration"]) })),
    });
  }
  for (const c of (node["CueList"] as Node[] | undefined) ?? []) out.push({ kind: "cuelist", id: num(c["@_ID"]), caption: String(c["@_Caption"] ?? ""), frames, input: inputOf(c) });
  for (const f of (node["Frame"] as Node[] | undefined) ?? []) walkVc(f, [...frames, String(f["@_Caption"] ?? "")], solo, out, soloFrames);
  for (const f of (node["SoloFrame"] as Node[] | undefined) ?? []) {
    const id = num(f["@_ID"]);
    const before = out.length;
    walkVc(f, [...frames, String(f["@_Caption"] ?? "")], id, out, soloFrames);
    soloFrames.push({ id, caption: String(f["@_Caption"] ?? ""), members: out.slice(before).filter((w) => w.kind === "button" && w.soloFrame === id).map((w) => w.id) });
  }
}

export function parseQxw(xml: string): QxwWorkspace {
  const ws = parser.parse(xml).Workspace as Node;
  if (!ws) throw new Error("not a QLC+ workspace");
  const engine = ws["Engine"] as Node;
  const fixtures: QxwFixture[] = ((engine["Fixture"] as Node[]) ?? []).map((f) => ({
    id: num(f["ID"]),
    name: txt(f["Name"]),
    manufacturer: txt(f["Manufacturer"]),
    model: txt(f["Model"]),
    mode: txt(f["Mode"]),
    universe: num(f["Universe"]),
    address: num(f["Address"]),
    channels: num(f["Channels"]),
  }));
  const functions = new Map<number, QxwFunction>();
  for (const f of (engine["Function"] as Node[]) ?? []) {
    const fn = parseFunction(f);
    functions.set(fn.id, fn);
  }
  const widgets: QxwWidget[] = [];
  const soloFrames: QxwWorkspace["soloFrames"] = [];
  const vc = ws["VirtualConsole"] as Node | undefined;
  if (vc) for (const frame of (vc["Frame"] as Node[] | undefined) ?? []) walkVc(frame, [], undefined, widgets, soloFrames);
  return { qlcVersion: txt((ws["Creator"] as Node | undefined)?.["Version"]), fixtures, functions, widgets, soloFrames };
}
