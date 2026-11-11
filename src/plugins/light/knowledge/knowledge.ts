/**
 * Colour knowledge base (docs/specs/presets-songs-notes.md): mood keyword → colours, energy,
 * family. A generic base ships with the repository; the user's own (private, never committed)
 * data/private/knowledge.json is merged on top, keyword by keyword.
 *
 * Also turns an intention into a look proposal, following the method's rules: energy decides steps,
 * cadence, attack and order (posé → respire, dynamique → claque au temps, survolté → aléatoire).
 */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { say } from "../../../core/lang.js";
import type { Technique } from "../engine/techniques.js";
import type { Timing } from "../engine/player.js";
import { hexToColor } from "../engine/techniques.js";

export const EnergySchema = z.enum(["pose", "dynamique", "survolte"]);
const MoodSchema = z.object({ label: z.string().optional(), colors: z.array(z.string()).min(1), energy: EnergySchema.default("dynamique"), family: z.string().default(""), notes: z.string().optional() });
export const KnowledgeSchema = z.object({ version: z.number().default(1), source: z.string().default(""), moods: z.record(z.string(), MoodSchema).prefault({}), rules: z.array(z.string()).default([]) });
export type Knowledge = z.infer<typeof KnowledgeSchema>;
export type Mood = z.infer<typeof MoodSchema>;
export type Energy = z.infer<typeof EnergySchema>;

/**
 * The one key of an intention (T15): accents and case dropped, every run of separators (spaces,
 * punctuation) one « - », none at either end. « Joie », « joie ! » and « JOIE » are « joie »;
 * « lever de rideau » is « lever-de-rideau », a valid collection id. Used for the base's keys, the
 * show's and the personal library's, the words of `song.mood` and the `ambiance:` tags alike.
 */
export const normalizeMood = (word: string): string =>
  word
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** The two files the base is made of: the generic one shipped, the user's private one when present. */
export interface KnowledgeLayers {
  generic: Knowledge;
  private?: Knowledge;
}

export function loadKnowledgeLayers(privatePath?: string): KnowledgeLayers {
  const generic = KnowledgeSchema.parse(JSON.parse(readFileSync(new URL("./generic.json", import.meta.url), "utf8")));
  if (!privatePath || !existsSync(privatePath)) return { generic };
  const own = KnowledgeSchema.parse(JSON.parse(readFileSync(privatePath, "utf8")));
  return { generic, private: { ...own, moods: Object.fromEntries(Object.entries(own.moods).map(([k, v]) => [normalizeMood(k), v])) } };
}

/** The generic base with the private one merged on top, keyword by keyword. */
export function loadKnowledge(privatePath?: string): Knowledge {
  return flattenLayers(loadKnowledgeLayers(privatePath));
}

export function flattenLayers({ generic, private: own }: KnowledgeLayers): Knowledge {
  if (!own) return generic;
  return { version: own.version, source: `${generic.source} + base personnelle`, moods: { ...generic.moods, ...own.moods }, rules: [...generic.rules, ...own.rules] };
}

/** Perceptual distance between two colours (CIE76 ΔE on Lab), for contrast checks. */
export function deltaE(a: string, b: string): number {
  const lab = (hex: string) => {
    const c = hexToColor(hex);
    const lin = (u: number) => (u > 0.04045 ? ((u + 0.055) / 1.055) ** 2.4 : u / 12.92);
    const [r, g, bl] = [lin(c.red ?? 0), lin(c.green ?? 0), lin(c.blue ?? 0)];
    const x = (r * 0.4124 + g * 0.3576 + bl * 0.1805) / 0.95047;
    const y = r * 0.2126 + g * 0.7152 + bl * 0.0722;
    const zc = (r * 0.0193 + g * 0.1192 + bl * 0.9505) / 1.08883;
    const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(zc))] as const;
  };
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

export interface IntentProposal {
  colors: string[];
  energy: Energy;
  technique: Technique;
  timing: Timing;
  explanation: string[];
  unknownMoods: string[];
}

/** An energy said as people read it (the key is « pose », « survolte »…). */
const energyWord = (e: Energy): string => (e === "pose" ? say("posée", "settled") : e === "survolte" ? say("survoltée", "high") : say("dynamique", "dynamic"));

export function proposeLook(kb: Knowledge, intent: { mood: string[]; energy?: Energy; colors?: string[]; cut?: boolean }): IntentProposal {
  const explanation: string[] = [];
  const unknown: string[] = [];
  const colors: string[] = [...(intent.colors ?? [])];
  const energies: Energy[] = [];
  for (const word of intent.mood) {
    const m = kb.moods[normalizeMood(word)];
    if (!m) {
      unknown.push(word);
      continue;
    }
    for (const c of m.colors) if (!colors.includes(c)) colors.push(c);
    energies.push(m.energy);
    explanation.push(say(`« ${m.label ?? word} » → ${m.colors.join(" ")} (${m.family || "—"}, énergie ${energyWord(m.energy)})`, `“${m.label ?? word}” → ${m.colors.join(" ")} (${m.family || "—"}, ${energyWord(m.energy)} energy)`));
  }
  if (colors.length === 0) colors.push("#fff1d6");
  const energy: Energy = intent.energy ?? (energies.includes("survolte") ? "survolte" : energies.includes("dynamique") ? "dynamique" : energies.length ? "pose" : "dynamique");
  let technique: Technique;
  let timing: Timing;
  if (energy === "pose") {
    technique = colors.length > 1 ? { kind: "respiration", colors, steps: 4, depth: 0.3 } : { kind: "plat", color: colors[0]! };
    timing = { every: { beats: 2 }, attack: 1, order: "loop", entryFade: 2, exitFade: 0 };
    explanation.push(say("énergie posée : respiration lente, 2 temps par pas, fondu continu", "settled energy: slow breathing, 2 beats a step, continuous fade"));
  } else if (energy === "dynamique") {
    technique = colors.length >= 3 ? { kind: "palette", colors: colors.slice(0, 4), block: 4 } : { kind: "damier", colors: [colors[0]!, colors[1] ?? "#ffffff"], block: 4 };
    timing = { every: { beats: 1 }, attack: intent.cut === false ? 1 : 0.05, order: "loop", entryFade: 0.5, exitFade: 0 };
    explanation.push(say(`énergie dynamique : ${technique.kind}, 1 temps par pas, ${intent.cut === false ? "respire" : "bord franc (claque)"}`, `dynamic energy: ${technique.kind}, 1 beat a step, ${intent.cut === false ? "breathing" : "hard edge (snap)"}`));
  } else {
    technique =
      colors.length >= 3
        ? { kind: "palette", colors: colors.slice(0, 5), block: 2 }
        : { kind: "masques", colors: [colors[0]!, colors[1] ?? colors[0]!], block: 4, masks: ["####", "-##-", "#--#", "##--", "--##"], floor: 0 };
    timing = { every: { beats: 1 }, attack: 0.03, order: "random", entryFade: 0, exitFade: 0 };
    explanation.push(say(`énergie survoltée : ${technique.kind} en ordre aléatoire, claque`, `high energy: ${technique.kind} in random order, snap`));
  }
  if (colors.length >= 2 && (technique.kind === "damier" || technique.kind === "masques")) {
    const d = deltaE(colors[0]!, colors[1]!);
    if (d < 25) explanation.push(say(`attention : contraste faible entre ${colors[0]} et ${colors[1]} (ΔE ${d.toFixed(0)})`, `warning: low contrast between ${colors[0]} and ${colors[1]} (ΔE ${d.toFixed(0)})`));
  }
  return { colors, energy, technique, timing, explanation, unknownMoods: unknown };
}
