/**
 * QLC+ workspace → venue + show proposal (docs/specs/presets-songs-notes.md, « Import QLC+ puis
 * reconstruction »). Nothing is written here: the result is a proposal (objects + report) that
 * `import.qxw` applies only when asked.
 *
 * Fidelity first (v0 must replay the user's current shows): every sequence becomes a look with its
 * exact steps (technique "pas"), tagged with the recognised technique so it can be rebuilt as a
 * parametric one later. Mapping:
 *   fixtures → patch; decoded cells → one canvas "qlc" rendered on the fixtures' heads;
 *   SoloFrames → exclusive groups; level sliders on dimmer channels → groups with a master;
 *   buttons' MIDI notes → mappings (look.go, mode trigger) with the same notes pinned;
 *   level sliders' CCs → group.level mappings; SpeedDial tap on MIDI clock → tempo from MIDI clock;
 *   SpeedDial multipliers → cadence in beats and attack (QLC+ grid: 1 step = 1 tap = 1 beat);
 *   EFX (moving-head movements) → position-only looks with a Move FX on a group of their fixtures;
 *   level sliders on other channels (white, UV, strobe, machines) → channel faders (HTP, like QLC+);
 *   Submaster sliders → a DCA dosing the looks started by the buttons of their frame.
 */
import type { QxwFunction, QxwWorkspace } from "./qxw-import.js";
import { analyzeSequence, cellsFor, stepColors, type Rgbw } from "./qxw-analyze.js";
import type { FixtureDefinition } from "../venue/qxf-import.js";
import { findDefinition, findMode } from "../venue/qxf-import.js";
import { slugify } from "../data/store.js";
import type { Canvas, PatchedFixture } from "../venue/venue.js";
import type { ChannelFader, Group, Look, LookChannels } from "../show/model.js";
import type { Move } from "../engine/move.js";

/** QLC+ EFX algorithm → Move FX shape; the others are approximated by a circle (reported). */
const EFX_SHAPES: Record<string, Move["shape"]> = { Circle: "cercle", Eight: "huit", Line: "pan", Line2: "tilt" };
import type { Mapping } from "../midi/mapping.js";

/** QLC+ SpeedDial multiplier index → factor (VCSpeedDialFunction::SpeedMultiplier). */
export const QLC_MULTIPLIERS = [NaN, 0, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8, 16] as const;

export interface ImportProposal {
  fixtures: PatchedFixture[];
  canvas: Canvas | null;
  looks: Look[];
  groups: Group[];
  faders: ChannelFader[];
  mappings: Mapping[];
  pinnedNotes: { action: string; channel: number; note: number }[];
  tempoFromMidiClock: boolean;
  report: { converted: string[]; warnings: string[] };
}

const hex = (c: Rgbw | null): string => {
  if (!c) return "";
  if (c.every((v) => v < 8)) return "-";
  const h = "#" + c.slice(0, 3).map((v) => v.toString(16).padStart(2, "0")).join("");
  return c[3] ? `${h}+w${c[3]}` : h;
};

function uniqueId(base: string, taken: Set<string>): string {
  let id = slugify(base);
  for (let n = 2; taken.has(id); n++) id = `${slugify(base).slice(0, 58)}-${n}`;
  taken.add(id);
  return id;
}

/**
 * Raw channels of a sequence (every channel it writes, by fixture and offset), one row per step;
 * a value missing from a step is 0 (QLC+ drops zeros when saving). Null when it writes nothing.
 */
function rawChannels(fn: QxwFunction, fixtureIds: Map<number, string>): LookChannels | null {
  const keys = new Map<string, { fixture: string; offset: number; qlc: number }>();
  for (const st of fn.steps)
    for (const [fid, vals] of st.values) {
      const fixture = fixtureIds.get(fid);
      if (fixture) for (const ch of vals.keys()) keys.set(`${fid}:${ch}`, { fixture, offset: ch, qlc: fid });
    }
  if (!keys.size) return null;
  const targets = [...keys.values()].sort((a, b) => a.qlc - b.qlc || a.offset - b.offset);
  return {
    targets: targets.map(({ fixture, offset }) => ({ fixture, offset })),
    steps: fn.steps.map((st) => targets.map((t) => st.values.get(t.qlc)?.get(t.offset) ?? 0)),
  };
}

export function qxwToShow(ws: QxwWorkspace, defs: FixtureDefinition[]): ImportProposal {
  const warnings: string[] = [];
  const converted: string[] = [];
  const fixtureIds = new Map<number, string>();
  const taken = new Set<string>();
  const fixtures: PatchedFixture[] = ws.fixtures.map((f) => {
    const id = uniqueId(f.name || `${f.model}-${f.id}`, taken);
    fixtureIds.set(f.id, id);
    const def = findDefinition(defs, f.manufacturer, f.model);
    const mode = def ? findMode(def, f.mode, f.channels) : undefined;
    if (!def || !mode) warnings.push(`définition manquante : ${f.manufacturer} ${f.model} (${f.mode}) — « ${f.name} » patchée sans décodage`);
    else if (findMode(def, f.mode) !== mode) warnings.push(`« ${f.name} » : mode « ${f.mode} » absent de la définition, « ${mode.name} » retenu (même nombre de canaux)`);
    return { id, name: f.name, manufacturer: f.manufacturer, model: f.model, mode: mode?.name ?? f.mode, universe: f.universe + 1, address: f.address + 1, tags: [], notes: undefined } as PatchedFixture;
  });
  converted.push(`${fixtures.length} fixtures patchées`);

  // Canvas from the decoded cells, in workspace order (fixture order, then heads).
  const { cells } = cellsFor(ws, defs);
  const canvas: Canvas | null = cells.length
    ? {
        id: "qlc",
        name: "Import QLC+",
        topology: "line",
        cells: cells.length,
        render: cells.map((c, i) => ({ from: i, to: i, targets: [{ fixture: fixtureIds.get(c.fixtureId)!, head: c.head }] })),
      }
    : null;
  if (canvas) converted.push(`canevas « qlc » de ${cells.length} cellules`);

  // Speed dial: functions it drives, with their multipliers.
  const dialed = new Map<number, { fadeIn: number; duration: number }>();
  let tempoFromMidiClock = false;
  for (const w of ws.widgets.filter((x) => x.kind === "speeddial")) {
    if (w.input?.midi.kind === "clock") tempoFromMidiClock = true;
    for (const f of w.speedDialFunctions ?? []) dialed.set(f.id, { fadeIn: QLC_MULTIPLIERS[f.fadeIn] ?? 1, duration: QLC_MULTIPLIERS[f.duration] ?? 1 });
  }

  const looks: Look[] = [];
  const lookIds = new Map<number, string>();
  const lookTaken = new Set<string>();
  const sequences = [...ws.functions.values()].filter((f) => f.type === "Sequence");
  for (const fn of sequences) {
    if (!canvas) break;
    const written = new Set<number>(fn.steps.flatMap((s) => [...s.values.keys()]));
    let steps = fn.steps.map((s) => stepColors(s, cells, written).map(hex));
    // « Pas 0 d'entrée »: a first step with a fade much longer than the others is an entry fade.
    const entry = entryStep(fn);
    if (entry > 0) steps = steps.slice(1);
    if (steps.every((row) => row.every((c) => c === ""))) {
      // no colour: machines (smoke, hazer) or lamps — played as raw channels, like QLC+ does
      const channels = rawChannels(fn, fixtureIds);
      if (!channels) {
        warnings.push(fn.steps.length ? `« ${fn.name} » : aucune valeur enregistrée (tout à 0 ?) — non importée` : `« ${fn.name} » : séquence vide — non importée`);
        continue;
      }
      const id = uniqueId(fn.name || `seq-${fn.id}`, lookTaken);
      lookIds.set(fn.id, id);
      looks.push({
        id,
        name: fn.name,
        canvas: "qlc",
        technique: { kind: "aucune" },
        channels,
        timing: { ...timingOf(fn, dialed.get(fn.id), false), entryFade: 0 },
        manualOnly: false,
        noCut: false,
        danger: false,
        tags: ["machines", ...(fn.path ? [`dossier:${fn.path}`] : [])],
        notes: `Importé de QLC+ (#${fn.id}) : ${channels.targets.length} canal(aux) hors couleur, ${channels.steps.length} pas.`,
      });
      continue;
    }
    const analysis = analyzeSequence(fn, cells);
    const id = uniqueId(fn.name || `seq-${fn.id}`, lookTaken);
    lookIds.set(fn.id, id);
    looks.push({
      id,
      name: fn.name,
      canvas: "qlc",
      technique: { kind: "pas", steps },
      timing: { ...timingOf(fn, dialed.get(fn.id), entry > 0), entryFade: entry },
      manualOnly: false,
      noCut: false,
      danger: false,
      tags: [`technique:${analysis.technique}`, `attaque:${analysis.attackLabel}`, ...(fn.path ? [`dossier:${fn.path}`] : [])],
      notes: `Importé de QLC+ (#${fn.id}). Technique reconnue : ${analysis.technique} (${analysis.confidence}). Couleurs : ${analysis.colors.slice(0, 6).join(" ")}`,
    });
    if (fn.speedModes && (fn.speedModes.duration === "PerStep" || fn.speedModes.fadeIn === "PerStep")) warnings.push(`« ${fn.name} » : timing par pas approximé par sa moyenne`);
  }
  converted.push(`${looks.length} looks (pas exacts, technique reconnue en étiquette)`);

  const groupTaken = new Set<string>();
  // EFX → position-only looks moving a group of their fixtures (format from QLC+'s efx.cpp).
  const efxGroups: Group[] = [];
  let efxCanvas: Canvas | null = null;
  const efxFns = [...ws.functions.values()].filter((f) => f.type === "EFX" && f.efx);
  for (const fn of efxFns) {
    const efx = fn.efx!;
    const moving = efx.fixtures.filter((f) => f.mode === 0 && fixtureIds.has(f.id));
    if (efx.fixtures.some((f) => f.mode !== 0)) warnings.push(`EFX « ${fn.name} » : les parties gradateur ou RGB ne sont pas converties (seulement pan/tilt)`);
    if (!moving.length) {
      warnings.push(`EFX « ${fn.name} » : aucune fixture en mode position — non importé`);
      continue;
    }
    const shape = EFX_SHAPES[efx.algorithm];
    if (!shape) warnings.push(`EFX « ${fn.name} » : forme ${efx.algorithm} approximée par un cercle`);
    if (efx.rotation) warnings.push(`EFX « ${fn.name} » : rotation de ${efx.rotation}° ignorée`);
    if (efx.propagation === "Asymmetric") warnings.push(`EFX « ${fn.name} » : propagation asymétrique approximée (ailes)`);
    const id = uniqueId(fn.name || `efx-${fn.id}`, lookTaken);
    const groupId = uniqueId(`efx-${id}`, groupTaken);
    const members = [...new Set(moving.map((f) => fixtureIds.get(f.id)!))];
    efxGroups.push(group(groupId, `EFX · ${fn.name}`, { fixtures: members }));
    if (!canvas && !efxCanvas) {
      // no colour cells at all (a moving-head rig): a canvas of the moving fixtures to hold the looks
      const all = [...new Set(efxFns.flatMap((f) => f.efx!.fixtures.map((x) => fixtureIds.get(x.id)).filter((x): x is string => Boolean(x))))];
      efxCanvas = { id: "qlc", name: "Import QLC+", topology: "line", cells: all.length, render: all.map((f, i) => ({ from: i, to: i, targets: [{ fixture: f, head: -1 }] })) };
    }
    lookIds.set(fn.id, id);
    const seconds = fn.speed.duration > 0 ? fn.speed.duration / 1000 : 20;
    looks.push({
      id,
      name: fn.name,
      canvas: "qlc",
      technique: { kind: "aucune" },
      move: {
        shape: shape ?? "cercle",
        center: { pan: efx.xOffset / 255, tilt: efx.yOffset / 255 },
        size: { pan: Math.min(0.5, efx.width / 255), tilt: Math.min(0.5, efx.height / 255) },
        every: { seconds },
        // QLC+ « Serial » spreads the heads evenly over one cycle: the last one is (n-1)/n behind
        spread: efx.propagation === "Serial" ? (members.length - 1) / Math.max(1, members.length) : efx.propagation === "Asymmetric" ? 0.5 : 0,
        wings: efx.propagation === "Asymmetric",
        reverse: fn.direction === "Backward",
        fan: 0,
        group: groupId,
      },
      timing: { every: { seconds: 1 }, attack: 0, order: "loop", entryFade: 0 },
      manualOnly: false,
      noCut: false,
      danger: false,
      tags: [`technique:efx-${efx.algorithm.toLowerCase()}`, ...(fn.path ? [`dossier:${fn.path}`] : [])],
      notes: `Importé de QLC+ (EFX #${fn.id}) : ${efx.algorithm}, ${seconds} s par cycle, propagation ${efx.propagation}.`,
    });
  }
  if (efxFns.length) converted.push(`${efxGroups.length} EFX → looks de mouvement (Move FX) sur leurs groupes`);

  // Exclusive groups from solo frames; level sliders on dimmers → groups with masters.
  const groups: Group[] = [];
  for (const sf of ws.soloFrames) {
    const members = sf.members
      .map((wid) => ws.widgets.find((w) => w.id === wid)?.functionId)
      .map((fid) => (fid === undefined ? undefined : lookIds.get(fid)))
      .filter((x): x is string => Boolean(x));
    if (members.length < 2) continue;
    groups.push(group(uniqueId(sf.caption || `solo-${sf.id}`, groupTaken), sf.caption || `Cadre solo ${sf.id}`, { exclusive: true, looks: [...new Set(members)] }));
  }
  const sliderGroups = new Map<number, string>();
  const sliderFaders = new Map<number, string>();
  const faders: ChannelFader[] = [];
  const faderTaken = new Set<string>();
  for (const w of ws.widgets.filter((x) => x.kind === "slider" && x.levelChannels?.length)) {
    const dimmerFixtures = new Set<string>();
    const others: ChannelFader["channels"] = [];
    for (const lc of w.levelChannels!) {
      const f = ws.fixtures.find((x) => x.id === lc.fixture);
      const fixtureId = fixtureIds.get(lc.fixture);
      if (!f || !fixtureId) continue;
      const def = findDefinition(defs, f.manufacturer, f.model);
      const mode = def ? findMode(def, f.mode, f.channels) : undefined;
      const ch = def && mode ? def.channels.get(mode.channels[lc.channel] ?? "") : undefined;
      // a DCA doses the colours the looks paint; a lamp without colour (generic dimmer) is driven like in QLC+
      const colored = Boolean(mode?.channels.some((n) => def!.channels.get(n)?.color));
      if (ch?.attribute === "intensity" && colored) dimmerFixtures.add(fixtureId);
      else others.push({ fixture: fixtureId, offset: lc.channel }); // white, UV, strobe, machines, lamps — or undecoded: kept by offset
    }
    if (dimmerFixtures.size) {
      const id = uniqueId(w.caption || `slider-${w.id}`, groupTaken);
      sliderGroups.set(w.id, id);
      groups.push(group(id, w.caption || `Fader ${w.id}`, { fixtures: [...dimmerFixtures], master: true }));
    }
    if (others.length) {
      // a QLC+ level slider writes its channels directly (HTP): a channel fader does the same; it starts at 0
      const id = uniqueId(dimmerFixtures.size ? `${w.caption || `slider-${w.id}`}-canaux` : w.caption || `slider-${w.id}`, faderTaken);
      sliderFaders.set(w.id, id);
      faders.push({ id, name: w.caption || `Fader ${w.id}`, channels: others, level: 0, notes: `Importé de QLC+ (fader #${w.id}, ${others.length} canal(aux) hors gradateur).` });
    }
  }
  if (faders.length) converted.push(`${faders.length} faders de canaux (blanc, UV, strobe, machines… pilotés comme dans QLC+)`);
  // Submaster sliders: a DCA dosing what its frame (and sub-frames) holds — the looks its buttons
  // start, the DCAs and channel faders its level sliders became (like in QLC+).
  for (const w of ws.widgets.filter((x) => x.kind === "slider" && x.sliderMode === "Submaster")) {
    const inFrame = ws.widgets.filter((b) => b !== w && (b.frameKey === w.frameKey || b.frameKey.startsWith(`${w.frameKey}/`)));
    const looksInFrame = inFrame
      .filter((b) => b.kind === "button" && b.functionId !== undefined)
      .map((b) => lookIds.get(b.functionId!))
      .filter((x): x is string => Boolean(x));
    const dcasInFrame = inFrame.map((b) => sliderGroups.get(b.id)).filter((x): x is string => Boolean(x));
    const fadersInFrame = inFrame.map((b) => sliderFaders.get(b.id)).filter((x): x is string => Boolean(x));
    if (!looksInFrame.length && !dcasInFrame.length && !fadersInFrame.length) {
      warnings.push(`submaster « ${w.caption} » : rien d'importé dans son cadre (look, fader) — non converti`);
      continue;
    }
    const id = uniqueId(w.caption || `submaster-${w.id}`, groupTaken);
    sliderGroups.set(w.id, id);
    const sub = group(id, w.caption || `Submaster ${w.id}`, { master: true });
    groups.push({ ...sub, members: { ...sub.members, groups: [...new Set(dcasInFrame)] }, presets: { included: [...new Set(looksInFrame)], excluded: [] } });
    for (const f of faders) if (fadersInFrame.includes(f.id)) f.dca = id;
  }
  groups.push(...efxGroups);
  converted.push(`${groups.length} groupes (${groups.filter((g) => g.exclusive).length} exclusifs, ${groups.filter((g) => g.master).length} avec master)`);

  // MIDI mappings: same notes, same CCs.
  const mappings: Mapping[] = [];
  const pinnedNotes: ImportProposal["pinnedNotes"] = [];
  const mapTaken = new Set<string>();
  for (const w of ws.widgets) {
    const midi = w.input?.midi;
    if (!midi) continue;
    if (w.kind === "button" && midi.kind === "note" && w.functionId !== undefined && lookIds.has(w.functionId)) {
      const look = lookIds.get(w.functionId)!;
      const id = uniqueId(`note-${midi.note}-${look}`, mapTaken);
      mappings.push(mapping(id, w.caption, { type: "note", channel: midi.channel, number: midi.note }, w.action === "Flash" ? "momentary" : "trigger", { command: "look.go", args: { id: look } }, w.action === "Flash" ? { command: "look.stop", args: { id: look } } : undefined));
      pinnedNotes.push({ action: `look:${look}:${w.id}`, channel: midi.channel, note: midi.note });
    } else if (w.kind === "slider" && midi.kind === "cc") {
      const input = { type: "cc" as const, channel: midi.channel, number: midi.controller };
      const g = sliderGroups.get(w.id);
      if (g) mappings.push({ ...mapping(uniqueId(`cc-${midi.controller}-${g}`, mapTaken), w.caption, input, "trigger", { command: "group.level", args: { id: g } }), levelArg: "level" });
      const f = sliderFaders.get(w.id);
      if (f) mappings.push({ ...mapping(uniqueId(`cc-${midi.controller}-${f}`, mapTaken), w.caption, input, "trigger", { command: "fader.level", args: { id: f } }), levelArg: "level", feedback: "cc" });
    }
  }
  converted.push(`${mappings.length} mappings MIDI (${pinnedNotes.length} notes épinglées à l'identique)`);
  if (tempoFromMidiClock) converted.push("tempo : horloge MIDI (molette QLC+ sur l'horloge de Live)");
  return { fixtures, canvas: canvas ?? efxCanvas, looks, groups, faders, mappings, pinnedNotes, tempoFromMidiClock, report: { converted, warnings } };
}

/** Entry fade in seconds when step 0 is a soft entry (fade ≥ 1 s and ≥ 3× the other steps' fades), else 0. */
export function entryStep(fn: QxwFunction): number {
  if (fn.steps.length < 3) return 0;
  const first = fn.steps[0]!.fadeIn;
  const others = fn.steps.slice(1).map((s) => s.fadeIn).sort((a, b) => a - b);
  const median = others[Math.floor(others.length / 2)] ?? 0;
  return first >= 1000 && first >= 3 * Math.max(median, 1) ? first / 1000 : 0;
}

function timingOf(fn: QxwFunction, dial?: { fadeIn: number; duration: number }, skipFirst = false): Look["timing"] {
  const order = fn.runOrder === "Random" ? "random" : fn.runOrder === "PingPong" ? "pingpong" : "loop";
  if (dial && dial.duration > 0) {
    return { every: { beats: dial.duration }, attack: Math.min(1, dial.fadeIn / dial.duration), order, entryFade: 0 };
  }
  const loopSteps = skipFirst ? fn.steps.slice(1) : fn.steps;
  const durations = loopSteps.map((s) => (fn.speedModes?.duration === "PerStep" ? s.fadeIn + s.hold : fn.speed.duration)).filter((d) => d > 0);
  const avg = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 1000;
  const fade = fn.speedModes?.fadeIn === "PerStep" ? loopSteps.reduce((a, s) => a + s.fadeIn, 0) / Math.max(1, loopSteps.length) : fn.speed.fadeIn;
  return { every: { seconds: Math.max(0.01, avg / 1000) }, attack: Math.min(1, fade / Math.max(1, avg)), order, entryFade: 0 };
}

function group(id: string, name: string, o: { exclusive?: boolean; looks?: string[]; fixtures?: string[]; master?: boolean }): Group {
  return {
    id,
    name,
    members: { fixtures: o.fixtures ?? [], looks: o.looks ?? [], groups: [] },
    exclusive: o.exclusive ?? false,
    master: o.master ? { level: 1, mute: false } : undefined,
    presets: { included: [], excluded: [] },
  } as Group;
}

function mapping(id: string, label: string, input: Mapping["input"], mode: Mapping["mode"], on: Mapping["on"], off?: Mapping["off"]): Mapping {
  return {
    id,
    label,
    input,
    mode,
    on,
    off,
    scale: { inMin: 0, inMax: 127, outMin: 0, outMax: 1, curve: "linear" },
    followAftertouch: false,
    pickup: false,
    feedback: "none",
    danger: false,
  } as Mapping;
}
