/**
 * QLC+ fixture definition (.qxf) import → internal fixture model (aligned on OFL ideas:
 * channels with typed attributes and capabilities, modes with heads = cells).
 * Pure: takes the XML text.
 */
import { XMLParser } from "fast-xml-parser";

export type ColorComponent = "red" | "green" | "blue" | "white" | "amber" | "uv" | "cyan" | "magenta" | "yellow" | "lime" | "warmWhite" | "coldWhite";

export type CapabilityTag = "soundActive" | "autoProgram" | "builtinMacro" | "strobe" | "reset" | "uv";

export interface FixtureCapability {
  min: number;
  max: number;
  name: string;
  preset?: string;
  /** Colour of a wheel slot ("#rrggbb"), from QLC+'s Res1 / Color attribute. */
  color?: string;
  /** Strobe frequency from min to max of the range, in Hz, when the definition gives it (StrobeFreqRange, StrobeFrequency). */
  hz?: [number, number];
  tags: CapabilityTag[];
}

export interface FixtureChannel {
  name: string;
  /** Normalised meaning used by the engine. */
  attribute: "intensity" | "color" | "colorWheel" | "pan" | "tilt" | "strobe" | "effect" | "speed" | "maintenance" | "other";
  color?: ColorComponent;
  fine?: boolean;
  capabilities: FixtureCapability[];
  tags: CapabilityTag[];
  /** A lens zoom channel and which way it opens as the value grows (BeamZoomSmallBig / BigSmall). */
  zoom?: "opens" | "closes";
}

export interface FixtureMode {
  name: string;
  channels: string[]; // channel names, by DMX offset
  /** Cells: each head lists the DMX offsets of its channels. */
  heads: number[][];
  /** Pan/tilt travel in degrees (mode-specific physical section, else the fixture's). */
  panMax?: number;
  tiltMax?: number;
  /** Beam opening in degrees (<Lens DegreesMax>, the widest of a zoom). */
  beamAngle?: number;
  /** The narrowest of a zoom (<Lens DegreesMin>), when it differs. */
  beamAngleMin?: number;
}

export interface FixtureDefinition {
  manufacturer: string;
  model: string;
  type: string;
  channels: Map<string, FixtureChannel>;
  modes: FixtureMode[];
  panMax?: number;
  tiltMax?: number;
  beamAngle?: number;
  beamAngleMin?: number;
}

const ARRAYS = new Set(["Channel", "Capability", "Mode", "Head"]);
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseTagValue: false,
  isArray: (name) => ARRAYS.has(name),
});

const PRESET_COLORS: Record<string, ColorComponent> = {
  IntensityRed: "red",
  IntensityGreen: "green",
  IntensityBlue: "blue",
  IntensityWhite: "white",
  IntensityAmber: "amber",
  IntensityUV: "uv",
  IntensityCyan: "cyan",
  IntensityMagenta: "magenta",
  IntensityYellow: "yellow",
  IntensityLime: "lime",
  IntensityWarmWhite: "warmWhite",
  IntensityColdWhite: "coldWhite",
  IntensityRedFine: "red",
  IntensityGreenFine: "green",
  IntensityBlueFine: "blue",
  IntensityWhiteFine: "white",
};
const NAME_COLORS: [RegExp, ColorComponent][] = [
  [/\b(uv|ultra ?violet)\b/i, "uv"],
  [/\bwarm ?white\b/i, "warmWhite"],
  [/\bcold ?white\b/i, "coldWhite"],
  [/\bred\b/i, "red"],
  [/\bgreen\b/i, "green"],
  [/\bblue\b/i, "blue"],
  [/\bwhite\b/i, "white"],
  [/\bamber\b/i, "amber"],
  [/\bcyan\b/i, "cyan"],
  [/\bmagenta\b/i, "magenta"],
  [/\byellow\b/i, "yellow"],
  [/\blime\b/i, "lime"],
];

/** Deduces capability tags from names and presets; the user can correct them later. */
/** The strobe frequency (Hz) a value sets, when its capability says; undefined otherwise. */
export function strobeHz(v: number, ch: FixtureChannel): number | undefined {
  const cap = ch.capabilities.find((c) => c.hz && v >= c.min && v <= c.max);
  if (!cap?.hz) return undefined;
  const [h1, h2] = cap.hz;
  return cap.max === cap.min ? h1 : h1 + ((v - cap.min) / (cap.max - cap.min)) * (h2 - h1);
}

/** What a capability range does, for an allowlist rule (« fixed colours and dimmer only »). */
export const CAPABILITY_KINDS = ["colour", "intensity", "strobe", "gobo", "prism", "beam", "rotation", "speed", "effect", "maintenance"] as const;
export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];

/**
 * A range's kind, from its QLC+ preset, then its name. « neutral » (no function, open, closed,
 * stop, off) is what a channel rests on: an allowlist never forbids it. Unknown ranges are « other »,
 * which an allowlist does not let through.
 */
export function capabilityKind(c: Pick<FixtureCapability, "name" | "preset" | "color">): CapabilityKind | "neutral" | "other" {
  const p = c.preset ?? "";
  const n = c.name.trim();
  if (/^(NoFunction|ShutterOpen|ShutterClose|PrismEffectOff|RotationStop|LampOn|LampOff)$/.test(p) || /^(no function|nothing|off|open|closed?|blackout|stop)$/i.test(n)) return "neutral";
  if (/^Color/.test(p) || c.color) return "colour";
  if (/^Intensity/.test(p)) return "intensity";
  if (/Strobe|Pulse|Ramp/.test(p) || /strobe/i.test(n)) return "strobe";
  if (/^Gobo|^GenericPicture/.test(p) || /gobo/i.test(n)) return "gobo";
  if (/^Prism/.test(p) || /prism/i.test(n)) return "prism";
  if (/^Beam/.test(p) || /zoom|focus|iris|frost/i.test(n)) return "beam";
  if (/^Rotation/.test(p)) return "rotation";
  if (/^Reset|^Lamp/.test(p) || /reset|lamp/i.test(n)) return "maintenance";
  if (/Macro|Effect/.test(p) || /macro|effect|program|sound|auto/i.test(n)) return "effect";
  if (/Speed|SlowToFast|FastToSlow/.test(p) || /speed/i.test(n)) return "speed";
  return "other";
}

export function capabilityTags(name: string, preset?: string): CapabilityTag[] {
  const tags = new Set<CapabilityTag>();
  const text = `${name} ${preset ?? ""}`;
  if (/sound|music|audio/i.test(text)) tags.add("soundActive");
  if (/auto(matic)?|pre-?programm|program|show\b|chase/i.test(text) && !/manual/i.test(text)) tags.add("autoProgram");
  if (/macro|built-?in/i.test(text)) tags.add("builtinMacro");
  if (/strobe/i.test(text) && !/off|open/i.test(name)) tags.add("strobe");
  if (/reset/i.test(text)) tags.add("reset");
  if (/\buv\b|ultra ?violet/i.test(text)) tags.add("uv");
  return [...tags];
}

function text(node: unknown): string {
  if (node === undefined || node === null) return "";
  if (typeof node === "string") return node.trim();
  if (typeof node === "object" && "#text" in (node as Record<string, unknown>)) return String((node as Record<string, unknown>)["#text"]).trim();
  return String(node).trim();
}

/**
 * A machine's output named as such: QLC+ definitions often give a hazer's « Fog Output », a bubble
 * machine's « Bubble Output » or its « Fan » the IntensityDimmer preset. Read as dimmers, they would
 * go to full with every colour painted on the machine's LEDs: they only move by raw channels.
 */
const MACHINE_OUTPUT = /\b(fog|haze|hazer|smoke|bubbles?|fan|fluid|pump|snow|foam|confetti|flames?|fire|sparks?|sparkular|co2|mist|blower|heater)\b/i;

function channelFrom(node: Record<string, unknown>): FixtureChannel {
  const name = String(node["@_Name"]);
  const preset = node["@_Preset"] as string | undefined;
  const group = text(node["Group"]);
  const colourNode = text(node["Colour"]);
  const capabilities: FixtureCapability[] = ((node["Capability"] as Record<string, unknown>[] | undefined) ?? []).map((c) => {
    const capName = text(c);
    const capPreset = c["@_Preset"] as string | undefined;
    const hex = [c["@_Res1"], c["@_Res"], c["@_Color"]].find((v): v is string => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v));
    const res = (k: string) => (c[k] === undefined || c[k] === "" ? Number.NaN : Number(c[k]));
    const hz: [number, number] | undefined =
      capPreset === "StrobeFreqRange" && Number.isFinite(res("@_Res1")) && Number.isFinite(res("@_Res2")) ? [res("@_Res1"), res("@_Res2")] : capPreset === "StrobeFrequency" && Number.isFinite(res("@_Res1")) ? [res("@_Res1"), res("@_Res1")] : undefined;
    return { min: Number(c["@_Min"]), max: Number(c["@_Max"]), name: capName, preset: capPreset, ...(hex ? { color: hex.toLowerCase() } : {}), ...(hz ? { hz } : {}), tags: capabilityTags(capName, capPreset) };
  });

  let attribute: FixtureChannel["attribute"] = "other";
  let color: ColorComponent | undefined;
  if (preset && PRESET_COLORS[preset]) {
    attribute = "color";
    color = PRESET_COLORS[preset];
  } else if (preset && /^Intensity(Master)?Dimmer/.test(preset)) attribute = "intensity";
  else if (preset && /^Position(Pan)/.test(preset)) attribute = "pan";
  else if (preset && /^Position(Tilt)/.test(preset)) attribute = "tilt";
  else if (group === "Intensity") {
    const c = colourNode ? NAME_COLORS.find(([re]) => re.test(colourNode))?.[1] : NAME_COLORS.find(([re]) => re.test(name))?.[1];
    if (c) {
      attribute = "color";
      color = c;
    } else attribute = "intensity";
  } else if (group === "Colour") attribute = "colorWheel";
  else if (group === "Pan") attribute = "pan";
  else if (group === "Tilt") attribute = "tilt";
  else if (group === "Shutter") attribute = "strobe";
  else if (group === "Effect") attribute = "effect";
  else if (group === "Speed") attribute = "speed";
  else if (group === "Maintenance") attribute = "maintenance";
  if (attribute === "intensity" && MACHINE_OUTPUT.test(name)) attribute = "effect";

  const tags = new Set<CapabilityTag>(capabilities.flatMap((c) => c.tags));
  if (attribute === "strobe") tags.add("strobe");
  if (color === "uv") tags.add("uv");
  const zoom = preset === "BeamZoomSmallBig" ? "opens" : preset === "BeamZoomBigSmall" ? "closes" : undefined;
  return { name, attribute, color, fine: /Fine$/.test(preset ?? "") || /fine/i.test(name), capabilities, tags: [...tags], ...(zoom ? { zoom } : {}) };
}

/** PanMax / TiltMax (<Focus>) and the beam opening (<Lens>: its widest, and its narrowest for a zoom) of a <Physical> section, when present. */
function physicalOf(node: unknown): { panMax?: number; tiltMax?: number; beamAngle?: number; beamAngleMin?: number } {
  const physical = node as Record<string, Record<string, unknown>> | undefined;
  const num = (v: unknown) => (v !== undefined && Number(v) > 0 ? Number(v) : undefined);
  const panMax = num(physical?.["Focus"]?.["@_PanMax"]);
  const tiltMax = num(physical?.["Focus"]?.["@_TiltMax"]);
  const beamAngle = num(physical?.["Lens"]?.["@_DegreesMax"]) ?? num(physical?.["Lens"]?.["@_DegreesMin"]);
  const narrowest = num(physical?.["Lens"]?.["@_DegreesMin"]);
  const beamAngleMin = beamAngle && narrowest && narrowest < beamAngle ? narrowest : undefined;
  return { ...(panMax ? { panMax } : {}), ...(tiltMax ? { tiltMax } : {}), ...(beamAngle ? { beamAngle } : {}), ...(beamAngleMin ? { beamAngleMin } : {}) };
}

export function parseQxf(xml: string): FixtureDefinition {
  const root = parser.parse(xml).FixtureDefinition as Record<string, unknown>;
  if (!root) throw new Error("not a QLC+ fixture definition");
  const channels = new Map<string, FixtureChannel>();
  for (const ch of (root["Channel"] as Record<string, unknown>[]) ?? []) {
    const c = channelFrom(ch);
    channels.set(c.name, c);
  }
  const modes: FixtureMode[] = ((root["Mode"] as Record<string, unknown>[]) ?? []).map((m) => {
    const chans = ((m["Channel"] as unknown[]) ?? []).map((c) => ({ n: Number((c as Record<string, unknown>)["@_Number"]), name: text(c) }));
    chans.sort((a, b) => a.n - b.n);
    const heads = ((m["Head"] as Record<string, unknown>[]) ?? []).map((h) => ((h["Channel"] as unknown[]) ?? []).map((x) => Number(text(x))));
    return { name: String(m["@_Name"]), channels: chans.map((c) => c.name), heads, ...physicalOf(m["Physical"]) };
  });
  return { manufacturer: text(root["Manufacturer"]), model: text(root["Model"]), type: text(root["Type"]), channels, modes, ...physicalOf(root["Physical"]) };
}

/**
 * Mode names differ between QLC+ versions ("39-channel" vs "39 Channel"): compare loosely. With the
 * channel count of the workspace, a definition whose modes are named otherwise (« Standard » vs
 * « 2ch ») still matches when exactly one of its modes has that many channels.
 */
export function findMode(def: FixtureDefinition, name: string, channels?: number): FixtureMode | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/channels?$/, "ch").replace(/ch$/, "");
  const byName = def.modes.find((m) => m.name === name) ?? def.modes.find((m) => norm(m.name) === norm(name));
  if (byName || channels === undefined) return byName;
  const sameCount = def.modes.filter((m) => m.channels.length === channels);
  return sameCount.length === 1 ? sameCount[0] : undefined;
}

const sameName = (a: string, b: string) => a.toLowerCase().replace(/[^a-z0-9]/g, "") === b.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Most channels a QLC+ generic dimmer pack can have (its editor allows up to 512; packs stay small). */
const GENERIC_DIMMER_MAX = 64;

/**
 * QLC+'s built-in generic dimmer (manufacturer and model « Generic », mode « N Channel »): it has no
 * .qxf file, QLC+ creates it in the code. Every channel is an intensity channel.
 */
export const GENERIC_DIMMER: FixtureDefinition = {
  manufacturer: "Generic",
  model: "Generic",
  type: "Dimmer",
  channels: new Map(
    Array.from({ length: GENERIC_DIMMER_MAX }, (_, i): [string, FixtureChannel] => {
      const name = `Dimmer ${i + 1}`;
      return [name, { name, attribute: "intensity", capabilities: [{ min: 0, max: 255, name: "Intensity", tags: [] }], tags: [] }];
    }),
  ),
  modes: Array.from({ length: GENERIC_DIMMER_MAX }, (_, i) => ({ name: `${i + 1} Channel`, channels: Array.from({ length: i + 1 }, (_, c) => `Dimmer ${c + 1}`), heads: [] })),
};

/** The definition of a model: from the loaded .qxf files, else QLC+'s built-in generic dimmer. */
export function findDefinition(defs: FixtureDefinition[], manufacturer: string, model: string): FixtureDefinition | undefined {
  const match = (d: FixtureDefinition) => sameName(d.manufacturer, manufacturer) && sameName(d.model, model);
  return defs.find(match) ?? (match(GENERIC_DIMMER) ? GENERIC_DIMMER : undefined);
}
