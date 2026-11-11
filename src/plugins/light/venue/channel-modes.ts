/**
 * A channel's working modes (T6, docs/specs/venue-fixtures-stage.md, « Mode de fonctionnement d'un
 * canal »): a channel cut into named functions (« Auto 1 », « Auto 2 », « Sound 1 », « Color fade
 * slow ») read as modes, each with its variants. The definition (.qxf) groups nothing (neither
 * `preset` nor `tags` says « this is a variant of that »): consecutive capabilities whose names share
 * a root once a final number, a numeric interval or a speed or direction word is taken off are one
 * mode with variants. A wide capability whose name says a progression (« slow → fast », « 0-100 % »)
 * is a continuous mode: its variant is a value inside it.
 *
 * Pure. The flat list of ranges stays the truth (venue.fixture.channels `ranges`): this is only a
 * grouping of the same capabilities, computed, never stored. A wrong grouping hides nothing.
 */

export interface CapabilityLike {
  min: number;
  max: number;
  name: string;
  preset?: string;
}

export interface ModeVariant {
  name: string;
  min: number;
  max: number;
}

export interface ChannelMode {
  /** The mode's name: the shared root of its variants, or the capability's own name. */
  name: string;
  min: number;
  max: number;
  /** Its variants in DMX order; a mode of one capability has one, its own. */
  variants: ModeVariant[];
  /** One wide capability whose value is a progression (a speed): the variant is a value inside it. */
  continuous: boolean;
}

/** The narrowest range read as a progression: below it, a « speed » is a single step. */
export const CONTINUOUS_MIN_WIDTH = 8;

/** Words of speed or direction that tell variants of one mode apart (« Color fade slow », « … fast »). */
const QUALIFIER = String.raw`(?:slow|fast|medium|mid|normal|lent|lente|moyen|moyenne|rapide|cw|ccw|clockwise|counter[- ]?clockwise|forwards?|backwards?|reverse|left|right)`;
/** A progression between two qualifiers (« slow to fast », « slow → fast », « fast-slow »). */
const PROGRESSION = String.raw`${QUALIFIER}\s*(?:->|→|>|to|-|–|à)\s*${QUALIFIER}`;
const TRAILERS: RegExp[] = [
  // a numeric interval at the end: « Auto 1-4 », « Program (0-100%) »
  /[\s(]*\d+\s*%?\s*(?:-|–|to|→|->)\s*\d+\s*%?\s*\)?\s*$/i,
  // a progression at the end: « Speed slow → fast »
  new RegExp(String.raw`[\s(,:-]*${PROGRESSION}\s*\)?\s*$`, "i"),
  // a final number, with its marker: « Auto 1 », « Program #2 », « Sound no. 3 », « Macro12 »
  /[\s(,:-]*(?:#|no\.?|n°|nr\.?)?\s*\d+\s*\)?\s*$/i,
  // a final qualifier: « Color fade slow »
  new RegExp(String.raw`[\s(,:-]+${QUALIFIER}\s*\)?\s*$`, "i"),
];

/**
 * A capability name's root and whether something was taken off it: the root is what variants of one
 * mode share. Each kind of trailer is taken at most once, longest first (« Auto 1 slow » → « Auto »).
 */
export function rootOf(name: string): { root: string; stripped: boolean } {
  let root = name.trim();
  let stripped = false;
  for (let pass = 0; pass < 2; pass++) {
    for (const re of TRAILERS) {
      const next = root.replace(re, "").trim();
      if (next && next !== root) {
        root = next;
        stripped = true;
      }
    }
  }
  return { root, stripped };
}

const key = (root: string) => root.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Whether a capability's name or preset says its value is a progression (a speed, a percentage). */
function progression(c: CapabilityLike): boolean {
  if (/(SlowToFast|FastToSlow|Speed|Percent)/.test(c.preset ?? "")) return true;
  return new RegExp(String.raw`${PROGRESSION}|\d+\s*%?\s*(?:-|–|to|→)\s*\d+\s*%|\bspeed\b|\bvitesse\b|\bmin\b.*\bmax\b|→|->`, "i").test(c.name);
}

/** The modes of a channel's capabilities (sorted by DMX value first); empty for a channel of one capability or none. */
export function channelModes(caps: readonly CapabilityLike[]): ChannelMode[] {
  if (caps.length < 2) return [];
  const sorted = [...caps].sort((a, b) => a.min - b.min);
  const modes: ChannelMode[] = [];
  let run: { key: string; root: string; caps: CapabilityLike[] } | undefined;
  const close = () => {
    if (!run) return;
    const first = run.caps[0]!;
    const last = run.caps[run.caps.length - 1]!;
    const variants = run.caps.map((c) => ({ name: c.name.trim(), min: c.min, max: c.max }));
    if (run.caps.length > 1) modes.push({ name: run.root, min: first.min, max: last.max, variants, continuous: false });
    else modes.push({ name: first.name.trim(), min: first.min, max: first.max, variants, continuous: first.max - first.min + 1 >= CONTINUOUS_MIN_WIDTH && progression(first) });
    run = undefined;
  };
  for (const c of sorted) {
    const { root, stripped } = rootOf(c.name);
    const k = stripped ? key(root) : "";
    // a continuous capability stands alone: « Speed slow → fast » is a mode of its own, not a variant of « Speed 1 »
    if (run && k && run.key === k && !(c.max - c.min + 1 >= CONTINUOUS_MIN_WIDTH && progression(c))) {
      run.caps.push(c);
      continue;
    }
    close();
    run = { key: k || `\u0000${modes.length}`, root, caps: [c] };
  }
  close();
  return modes;
}

/** The mode and the variant a DMX value falls in (anywhere in their range), or undefined between ranges. */
export function modeAt(modes: readonly ChannelMode[], value: number): { mode: ChannelMode; variant: ModeVariant } | undefined {
  for (const mode of modes) {
    const variant = mode.variants.find((v) => value >= v.min && value <= v.max);
    if (variant) return { mode, variant };
  }
  return undefined;
}

/**
 * The DMX value that sets a mode: the middle of the variant's range (it holds through a drift of a
 * DMX step or two, as the middle of a wheel slot does — decision T6, question 3), the first variant
 * when none is named. A continuous mode takes `value` when given, kept inside its range.
 */
export function valueOf(mode: ChannelMode, variant?: string, value?: number): number {
  if (mode.continuous && value !== undefined) return Math.min(mode.max, Math.max(mode.min, Math.round(value)));
  const v = (variant === undefined ? undefined : mode.variants.find((x) => x.name === variant)) ?? mode.variants[0]!;
  return Math.floor((v.min + v.max) / 2);
}
