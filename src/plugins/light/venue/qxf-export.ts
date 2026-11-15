/**
 * A library definition back to a QLC+ `.qxf` file (docs/specs/venue-fixtures-stage.md, « Exporter une définition »).
 * Pure: the file's text in, the text out. Without corrections the file is the library's, untouched; with them, only
 * what QLC+ can say is written into it, by targeted edits of the text (every other byte, comments, order and spacing
 * included, stays as it was): a wheel slot's real colour (`Res1`), the heads deduced from the channel names
 * (`<Head>` in a mode that declares none), the real pan/tilt travel (`<Focus PanMax TiltMax>`). The rest of the
 * venue's corrections has no place in a `.qxf`: `planCorrections` names it, the export says it.
 */
import { say } from "../../../core/lang.js";
import { definitionFileName } from "./definition-files.js";
import { headsOf, partsOf } from "./heads.js";
import type { FixtureOverrides } from "./overrides.js";
import type { FixtureDefinition } from "./qxf-import.js";

/** What the export writes into the XML. */
export interface QxfCorrections {
  /** Wheel slot colours: the wheel channel (by name), its slots by first DMX value (`min`) → "#rrggbb". */
  wheel?: { channel: string; slots: Record<number, string> }[];
  /** Heads to declare in a mode that declares none (offsets in the mode, one list per head). */
  heads?: { mode: string; heads: number[][] }[];
  /** The real pan/tilt travel in degrees, written on every <Focus> (the fixture's and its modes'). */
  travel?: { panMax?: number; tiltMax?: number };
}

/** One line of the export's report: which part of the corrections, and what it says. */
export interface ExportNote {
  part: "wheel" | "heads" | "tracks" | "travel" | "orientation";
  message: string;
}

// ---- a minimal XML scanner: element positions, enough to edit a .qxf in place

interface XmlAttr {
  name: string;
  /** Raw value (entities not decoded) and where it sits, quotes excluded. */
  raw: string;
  valueStart: number;
  valueEnd: number;
}

interface XmlElement {
  name: string;
  attrs: XmlAttr[];
  /** `<` of the start tag; just after the last attribute; just after the start tag's `>`. */
  start: number;
  attrsEnd: number;
  openEnd: number;
  /** `<` of the end tag (= openEnd for a self-closing one); just after the element. */
  closeStart: number;
  end: number;
  children: XmlElement[];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s: string): string => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => (e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e] ?? m)));
const escapeAttr = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

const NAME_RE = /[^\s/>=]+/y;
const ATTR_RE = /\s+([^\s=/>]+)\s*=\s*("[^"]*"|'[^']*')/y;

/** The elements of an XML text, nested; comments, CDATA, processing instructions and the DOCTYPE skipped. Throws on a broken nesting. */
function scan(xml: string): XmlElement[] {
  const roots: XmlElement[] = [];
  const stack: XmlElement[] = [];
  let i = xml.indexOf("<");
  const skipTo = (marker: string, from: number) => {
    const at = xml.indexOf(marker, from);
    if (at < 0) throw new Error("unterminated markup");
    return at + marker.length;
  };
  while (i >= 0 && i < xml.length) {
    let next: number;
    if (xml.startsWith("<!--", i)) next = skipTo("-->", i + 4);
    else if (xml.startsWith("<![CDATA[", i)) next = skipTo("]]>", i + 9);
    else if (xml.startsWith("<?", i)) next = skipTo("?>", i + 2);
    else if (xml.startsWith("<!", i)) next = skipTo(">", i + 2);
    else if (xml[i + 1] === "/") {
      next = skipTo(">", i + 2);
      const name = xml.slice(i + 2, next - 1).trim();
      const open = stack.pop();
      if (!open || open.name !== name) throw new Error(`unexpected </${name}>`);
      open.closeStart = i;
      open.end = next;
    } else {
      NAME_RE.lastIndex = i + 1;
      const name = NAME_RE.exec(xml)?.[0];
      if (!name) throw new Error("bad tag");
      let at = NAME_RE.lastIndex;
      const attrs: XmlAttr[] = [];
      for (;;) {
        ATTR_RE.lastIndex = at;
        const m = ATTR_RE.exec(xml);
        if (!m) break;
        const quoted = m[2]!;
        const valueEnd = ATTR_RE.lastIndex - 1;
        attrs.push({ name: m[1]!, raw: quoted.slice(1, -1), valueStart: valueEnd - (quoted.length - 2), valueEnd });
        at = ATTR_RE.lastIndex;
      }
      const attrsEnd = at;
      const close = /\s*(\/?)>/y;
      close.lastIndex = at;
      const c = close.exec(xml);
      if (!c) throw new Error(`bad tag <${name}>`);
      next = close.lastIndex;
      const el: XmlElement = { name, attrs, start: i, attrsEnd, openEnd: next, closeStart: next, end: next, children: [] };
      (stack.at(-1)?.children ?? roots).push(el);
      if (!c[1]) stack.push(el);
    }
    i = xml.indexOf("<", next);
  }
  if (stack.length) throw new Error(`unclosed <${stack.at(-1)!.name}>`);
  return roots;
}

const attr = (el: XmlElement, name: string): string | undefined => {
  const a = el.attrs.find((x) => x.name === name);
  return a ? decode(a.raw) : undefined;
};
const childrenNamed = (el: XmlElement, name: string) => el.children.filter((c) => c.name === name);

interface Edit {
  at: number;
  end: number;
  text: string;
}

/** Sets an attribute: its value replaced where it is, or appended after the last attribute. */
function setAttr(el: XmlElement, name: string, value: string): Edit {
  const a = el.attrs.find((x) => x.name === name);
  return a ? { at: a.valueStart, end: a.valueEnd, text: escapeAttr(value) } : { at: el.attrsEnd, end: el.attrsEnd, text: ` ${name}="${escapeAttr(value)}"` };
}

/** The spaces before an element on its line, or undefined when something else stands before it on that line. */
function indentOf(xml: string, el: XmlElement): string | undefined {
  const lineStart = xml.lastIndexOf("\n", el.start - 1) + 1;
  const before = xml.slice(lineStart, el.start);
  return /^[ \t]*$/.test(before) ? before : undefined;
}

/** The newline the file uses. */
const eol = (xml: string) => (xml.includes("\r\n") ? "\r\n" : "\n");

/** A wheel slot's colour can be written: a plain range, or one QLC+ reads as a colour (ColorMacro, ColorDoubleMacro). */
const COLOUR_PRESET = /^Color(Double)?Macro$/;

/**
 * Writes the corrections into a `.qxf` text; returns the text unchanged (the same string) when there is nothing to
 * write. A slot or a mode not found is skipped (`planCorrections` only asks for what the definition has).
 */
export function applyQxfCorrections(xml: string, c: QxfCorrections): string {
  const root = scan(xml).find((e) => e.name === "FixtureDefinition");
  if (!root) throw new Error("not a QLC+ fixture definition");
  const edits: Edit[] = [];
  const nl = eol(xml);
  const unit = (outer: XmlElement, inner: XmlElement | undefined) => {
    const o = indentOf(xml, outer) ?? "";
    const i = inner ? indentOf(xml, inner) : undefined;
    return { outer: o, inner: i ?? `${o} ` };
  };

  for (const w of c.wheel ?? []) {
    const channel = childrenNamed(root, "Channel").find((ch) => attr(ch, "Name") === w.channel);
    if (!channel) continue;
    for (const cap of childrenNamed(channel, "Capability")) {
      const hex = w.slots[Number(attr(cap, "Min"))];
      if (!hex) continue;
      const preset = attr(cap, "Preset");
      // the colour where the definition has it (Res1, an old Res, an old Color), else Res1 with the preset QLC+ reads it by
      const where = ["Res1", "Res", "Color"].find((k) => /^#[0-9a-f]{6}$/i.test(attr(cap, k) ?? ""));
      edits.push(setAttr(cap, where ?? "Res1", hex.toLowerCase()));
      if (!where && !preset) edits.push(setAttr(cap, "Preset", "ColorMacro"));
    }
  }

  for (const h of c.heads ?? []) {
    const mode = childrenNamed(root, "Mode").find((m) => attr(m, "Name") === h.mode);
    if (!mode || childrenNamed(mode, "Head").length || !h.heads.length) continue;
    const last = childrenNamed(mode, "Channel").at(-1) ?? mode.children.at(-1);
    const { inner } = unit(mode, mode.children[0]);
    const step = inner.length > (indentOf(xml, mode) ?? "").length ? inner.slice((indentOf(xml, mode) ?? "").length) : " ";
    const text = h.heads.map((offsets) => `${nl}${inner}<Head>${offsets.map((o) => `${nl}${inner}${step}<Channel>${o}</Channel>`).join("")}${nl}${inner}</Head>`).join("");
    const at = last ? last.end : mode.openEnd;
    edits.push({ at, end: at, text });
  }

  const t = c.travel;
  if (t && (t.panMax !== undefined || t.tiltMax !== undefined)) {
    const focusAttrs = (focus: XmlElement) => [...(t.panMax !== undefined ? [setAttr(focus, "PanMax", String(t.panMax))] : []), ...(t.tiltMax !== undefined ? [setAttr(focus, "TiltMax", String(t.tiltMax))] : [])];
    const physicals = [...childrenNamed(root, "Physical"), ...childrenNamed(root, "Mode").flatMap((m) => childrenNamed(m, "Physical"))];
    for (const p of physicals) {
      const focus = childrenNamed(p, "Focus")[0];
      if (focus) edits.push(...focusAttrs(focus));
    }
    const rootPhysical = childrenNamed(root, "Physical")[0];
    const focusTag = `<Focus Type="Head" PanMax="${t.panMax ?? 0}" TiltMax="${t.tiltMax ?? 0}"/>`;
    if (!rootPhysical) {
      // the fixture's own <Physical>, after its modes as QLC+ writes it
      const { outer, inner } = unit(root, root.children[0]);
      const step = inner.slice(outer.length) || " ";
      const at = root.children.at(-1)?.end ?? root.openEnd;
      edits.push({ at, end: at, text: `${nl}${inner}<Physical>${nl}${inner}${step}${focusTag}${nl}${inner}</Physical>` });
    } else if (!childrenNamed(rootPhysical, "Focus").length) {
      const { inner } = unit(rootPhysical, rootPhysical.children[0]);
      const at = rootPhysical.children.at(-1)?.end ?? rootPhysical.openEnd;
      edits.push({ at, end: at, text: `${nl}${inner}${focusTag}` });
    }
  }

  if (!edits.length) return xml;
  // from the end, so that each edit keeps the positions of those before it; two insertions at one place (Res1, then
  // Preset) end up in the reverse order they were pushed: `Preset="ColorMacro" Res1="…"`, as QLC+ writes them
  edits.sort((a, b) => b.at - a.at);
  let out = xml;
  for (const e of edits) out = out.slice(0, e.at) + e.text + out.slice(e.end);
  return out;
}

/** The DMX value a wheel slot override is keyed by. */
const slotKey = (min: number) => String(min);

/**
 * What the corrections of this venue (a model's, or one fixture's merged over its model's) write into a definition's
 * `.qxf`, and what they cannot: `corrections` for `applyQxfCorrections`, `applied` and `notExported` said in words.
 * The deduced heads are written too: they are how this server reads the definition (heads.ts), whether or not a
 * correction touched them.
 */
export function planCorrections(def: FixtureDefinition, o: FixtureOverrides): { corrections: QxfCorrections; applied: ExportNote[]; notExported: ExportNote[] } {
  const applied: ExportNote[] = [];
  const notExported: ExportNote[] = [];
  const corrections: QxfCorrections = {};

  // the wheel: each mode's first wheel channel, as the engine drives it (Venue.resolve)
  const wheels = [...new Set(def.modes.flatMap((m) => m.channels.find((n) => def.channels.get(n)?.attribute === "colorWheel") ?? []))];
  const w = o.wheel;
  for (const name of wheels) {
    const caps = def.channels.get(name)!.capabilities;
    const slots: Record<number, string> = {};
    for (const [key, slot] of Object.entries(w?.slots ?? {})) {
      const cap = caps.find((c) => slotKey(c.min) === key);
      if (!cap) {
        notExported.push({ part: "wheel", message: say(`roue « ${name} » : aucune case ne commence à ${key}, sa correction est ignorée`, `wheel “${name}”: no slot starts at ${key}, its correction is ignored`) });
        continue;
      }
      if (slot.color) {
        const hex = slot.color.toLowerCase();
        if (cap.preset && !COLOUR_PRESET.test(cap.preset)) notExported.push({ part: "wheel", message: say(`roue « ${name} », case « ${cap.name} » : son préréglage QLC+ (${cap.preset}) n'a pas de couleur, ${hex} n'y est pas écrit`, `wheel “${name}”, slot “${cap.name}”: its QLC+ preset (${cap.preset}) has no colour, ${hex} is not written`) });
        else if (cap.color !== hex) {
          slots[cap.min] = hex;
          applied.push({ part: "wheel", message: say(`roue « ${name} », case « ${cap.name} » : couleur ${hex}${cap.color ? ` (au lieu de ${cap.color})` : ""}`, `wheel “${name}”, slot “${cap.name}”: colour ${hex}${cap.color ? ` (instead of ${cap.color})` : ""}`) });
        }
      }
      if (slot.answers?.length) notExported.push({ part: "wheel", message: say(`roue « ${name} », case « ${cap.name} » : les couleurs auxquelles elle répond (${slot.answers.join(", ")}) n'existent pas dans QLC+`, `wheel “${name}”, slot “${cap.name}”: the colours it answers to (${slot.answers.join(", ")}) do not exist in QLC+`) });
      if (slot.off) notExported.push({ part: "wheel", message: say(`roue « ${name} », case « ${cap.name} » : « jamais choisie » n'existe pas dans QLC+`, `wheel “${name}”, slot “${cap.name}”: “never chosen” does not exist in QLC+`) });
    }
    if (Object.keys(slots).length) (corrections.wheel ??= []).push({ channel: name, slots });
  }
  if (w && (w.doubles !== undefined || w.change !== undefined || w.changeMs !== undefined))
    notExported.push({ part: "wheel", message: say("roue : le choix des cases doubles et le passage d'une case à l'autre (au milieu du fondu, par le noir) sont des réglages de ce serveur, pas de la définition", "wheel: split slots allowed and how the wheel changes slot (mid-fade, through black) are settings of this server, not of the definition") });

  // the heads: a mode that declares none gets those deduced from its channel names
  for (const mode of def.modes) {
    const { parts, deduced } = partsOf(def, mode);
    if (!deduced) continue;
    const heads = parts.map((p) => [...p.offsets].sort((a, b) => a - b));
    (corrections.heads ??= []).push({ mode: mode.name, heads });
    applied.push({ part: "heads", message: say(`mode « ${mode.name} » : ${heads.length} têtes déclarées (déduites des noms des canaux)`, `mode “${mode.name}”: ${heads.length} heads declared (deduced from the channel names)`) });
  }
  if (o.heads?.follow === false)
    notExported.push({ part: "heads", message: say("halo : « reste éteint sauf peint » est un réglage de ce serveur, QLC+ n'a pas de tête d'accent", "halo: “stays dark unless painted” is a setting of this server, QLC+ has no accent head") });

  if (o.tracks && (o.tracks.enabled !== undefined || o.tracks.fade))
    notExported.push({ part: "tracks", message: say("pistes fondables : QLC+ n'a pas de liste des canaux qui suivent les fondus dans une définition", "fadeable tracks: QLC+ has no list of the channels that follow the fades in a definition") });

  return { corrections, applied, notExported };
}

/**
 * The accent heads (halo) this server would no longer find once the file is read again: QLC+ has no accent head, a
 * declared head is an accent here only when named halo or aura (heads.ts). Compares each mode before and after.
 */
export function lostAccents(before: FixtureDefinition, after: FixtureDefinition, o: FixtureOverrides): ExportNote[] {
  const out: ExportNote[] = [];
  for (const mode of before.modes) {
    const was = headsOf(before, mode, o.heads);
    const again = after.modes.find((m) => m.name === mode.name);
    if (!again || !was.accent.size) continue;
    const now = headsOf(after, again, undefined);
    const names = (h: { heads: Map<number, Partial<Record<string, number>>> }, i: number) =>
      Object.values(h.heads.get(i) ?? {})
        .map((off) => mode.channels[off!])
        .join(", ");
    const lost = [...was.accent].filter((i) => !now.accent.has(i)).map((i) => names(was, i));
    if (lost.length) out.push({ part: "heads", message: say(`mode « ${mode.name} » : ${lost.map((n) => `« ${n} »`).join(", ")} écrit comme une tête ordinaire (QLC+ n'a pas de tête d'accent, ce serveur ne la reconnaît comme halo qu'à son nom)`, `mode “${mode.name}”: ${lost.map((n) => `“${n}”`).join(", ")} written as an ordinary head (QLC+ has no accent head, this server only tells a halo by its name)`) });
  }
  return out;
}

/**
 * The file name QLC+ gives a definition, `Manufacturer-Model.qxf` (spaces as `-`), kept plain as the library's
 * names are (definitionFileName: accents dropped, other signs as `-`), without doubled or trailing dashes.
 */
export function qxfFileName(manufacturer: string, model: string): string {
  const part = (s: string) => s.trim().replace(/[^\p{L}\p{N}_.]+/gu, "-").replace(/^-+|-+$/g, "");
  return definitionFileName([part(manufacturer), part(model)].filter(Boolean).join("-"))
    .replace(/-{2,}/g, "-")
    .replace(/-+\.qxf$/, ".qxf");
}
