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
import { foldLatin } from "./names.js";
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

/**
 * A retouch the writer refused (the file names two channels or two modes alike: which one QLC+ keeps is not
 * certain), with the key of the promises it covers (`channel:<name>`, `mode:<name>`).
 */
export interface RefusedRetouch {
  key: string;
  note: ExportNote;
}

/**
 * What `planCorrections` promises to write, checked once the written file is read again (`settleCorrections`):
 * `note` when it is there, `missed` when it is not. `key` ties it to a refusal of the writer.
 */
export interface PromisedRetouch {
  key: string;
  note: ExportNote;
  missed: ExportNote;
  written: (again: FixtureDefinition) => boolean;
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
  /** Written `<X/>`: no end tag, no content. */
  selfClosing: boolean;
  children: XmlElement[];
}

/**
 * An attribute's value as the import reads it (fast-xml-parser, qxf-import.ts): trimmed, the five predefined entities
 * and the numeric character references decoded in one pass (the import decodes both; it also knows HTML's named
 * entities, which a .qxf does not use: such a name is not matched, and that is caught when the file is read again).
 * Names compared through this
 * match those of the parsed definition; a DOCTYPE's own entities do not, and what is then not written is caught when
 * the file is read again.
 */
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s: string): string =>
  s.trim().replace(/&(amp|lt|gt|quot|apos|#x[0-9a-fA-F]+|#\d+);/g, (m, e: string) => {
    if (!e.startsWith("#")) return ENTITIES[e]!;
    const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    // as the parser does: beyond Unicode kept as written, NUL and a lone surrogate dropped
    if (!(cp <= 0x10ffff)) return m;
    return cp === 0 || (cp >= 0xd800 && cp <= 0xdfff) ? "" : String.fromCodePoint(cp);
  });
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
    else if (xml.startsWith("<!", i)) {
      // a DOCTYPE with an internal subset (`[ <!ENTITY …> ]`) ends at the `>` after its `]`
      const gt = skipTo(">", i + 2);
      const bracket = xml.indexOf("[", i);
      next = bracket >= 0 && bracket < gt ? skipTo(">", skipTo("]", bracket + 1)) : gt;
    }
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
      const el: XmlElement = { name, attrs, start: i, attrsEnd, openEnd: next, closeStart: next, end: next, selfClosing: !!c[1], children: [] };
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

/** Writes the corrections into a `.qxf` text (`writeQxfCorrections`), its text only. */
export function applyQxfCorrections(xml: string, c: QxfCorrections): string {
  return writeQxfCorrections(xml, c).xml;
}

/** Whether a set of corrections asks for anything at all. */
const asksNothing = (c: QxfCorrections): boolean => !c.wheel?.length && !c.heads?.length && c.travel?.panMax === undefined && c.travel?.tiltMax === undefined;

/**
 * Writes the corrections into a `.qxf` text; returns the text unchanged (the same string) when there is nothing to
 * write, without reading it (a file the import accepts but this scanner would not still exports). A slot or a mode
 * not found is skipped (`planCorrections` only asks for what the definition has); a channel or a mode the file names
 * twice is refused (`refused`): which of the two QLC+ keeps is not certain. Throws on a text it cannot scan.
 */
export function writeQxfCorrections(xml: string, c: QxfCorrections): { xml: string; refused: RefusedRetouch[] } {
  const refused: RefusedRetouch[] = [];
  if (asksNothing(c)) return { xml, refused };
  const root = scan(xml).find((e) => e.name === "FixtureDefinition");
  if (!root) throw new Error("not a QLC+ fixture definition");
  const edits: Edit[] = [];
  const nl = eol(xml);
  const unit = (outer: XmlElement, inner: XmlElement | undefined) => {
    const o = indentOf(xml, outer) ?? "";
    const i = inner ? indentOf(xml, inner) : undefined;
    return { outer: o, inner: i ?? `${o} ` };
  };
  /** The one element of that name, or undefined (none, or several: then refused once, with `note`). */
  const theOne = (list: XmlElement[], name: string, key: string, note: () => ExportNote) => {
    const found = list.filter((el) => attr(el, "Name") === name);
    if (found.length > 1 && !refused.some((r) => r.key === key)) refused.push({ key, note: note() });
    return found.length === 1 ? found[0] : undefined;
  };

  for (const w of c.wheel ?? []) {
    const channel = theOne(childrenNamed(root, "Channel"), w.channel, `channel:${w.channel}`, () => ({
      part: "wheel",
      message: say(`roue « ${w.channel} » : plusieurs canaux portent ce nom dans le fichier, ses couleurs n'y sont pas écrites`, `wheel “${w.channel}”: several channels bear this name in the file, its colours are not written`),
    }));
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
    const mode = theOne(childrenNamed(root, "Mode"), h.mode, `mode:${h.mode}`, () => ({
      part: "heads",
      message: say(`mode « ${h.mode} » : plusieurs modes portent ce nom dans le fichier, ses têtes n'y sont pas déclarées`, `mode “${h.mode}”: several modes bear this name in the file, its heads are not declared`),
    }));
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
    } else if (rootPhysical.selfClosing) {
      // `<Physical/>`: opened up to hold the <Focus>, its attributes kept
      const { outer, inner } = unit(rootPhysical, undefined);
      edits.push({ at: rootPhysical.attrsEnd, end: rootPhysical.openEnd, text: `>${nl}${inner}${focusTag}${nl}${outer}</Physical>` });
    } else if (!childrenNamed(rootPhysical, "Focus").length) {
      const { inner } = unit(rootPhysical, rootPhysical.children[0]);
      const at = rootPhysical.children.at(-1)?.end ?? rootPhysical.openEnd;
      edits.push({ at, end: at, text: `${nl}${inner}${focusTag}` });
    }
  }

  if (!edits.length) return { xml, refused };
  // from the end, so that each edit keeps the positions of those before it; two insertions at one place (Res1, then
  // Preset) end up in the reverse order they were pushed: `Preset="ColorMacro" Res1="…"`, as QLC+ writes them
  edits.sort((a, b) => b.at - a.at);
  let out = xml;
  for (const e of edits) out = out.slice(0, e.at) + e.text + out.slice(e.end);
  return { xml: out, refused };
}

/** The DMX value a wheel slot override is keyed by. */
const slotKey = (min: number) => String(min);

/**
 * What the corrections of this venue (a model's, or one fixture's merged over its model's) write into a definition's
 * `.qxf`, and what they cannot: `corrections` for `applyQxfCorrections`, `applied` and `notExported` said in words.
 * The deduced heads are written too: they are how this server reads the definition (heads.ts), whether or not a
 * correction touched them.
 */
export function planCorrections(def: FixtureDefinition, o: FixtureOverrides): { corrections: QxfCorrections; promised: PromisedRetouch[]; applied: ExportNote[]; notExported: ExportNote[] } {
  const promised: PromisedRetouch[] = [];
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
          const min = cap.min;
          promised.push({
            key: `channel:${name}`,
            note: { part: "wheel", message: say(`roue « ${name} », case « ${cap.name} » : couleur ${hex}${cap.color ? ` (au lieu de ${cap.color})` : ""}`, `wheel “${name}”, slot “${cap.name}”: colour ${hex}${cap.color ? ` (instead of ${cap.color})` : ""}`) },
            missed: { part: "wheel", message: say(`roue « ${name} », case « ${cap.name} » : la couleur ${hex} n'a pas pu être écrite (le fichier relu ne la porte pas)`, `wheel “${name}”, slot “${cap.name}”: colour ${hex} could not be written (the file read again does not carry it)`) },
            written: (again) => {
              const slotsAgain = again.channels.get(name)?.capabilities.filter((x) => x.min === min) ?? [];
              return slotsAgain.length > 0 && slotsAgain.every((x) => x.color === hex);
            },
          });
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
    const wanted = JSON.stringify(heads);
    promised.push({
      key: `mode:${mode.name}`,
      note: { part: "heads", message: say(`mode « ${mode.name} » : ${heads.length} têtes déclarées (déduites des noms des canaux)`, `mode “${mode.name}”: ${heads.length} heads declared (deduced from the channel names)`) },
      missed: { part: "heads", message: say(`mode « ${mode.name} » : les têtes déduites n'ont pas pu être déclarées (le fichier relu ne les porte pas)`, `mode “${mode.name}”: the deduced heads could not be declared (the file read again does not carry them)`) },
      written: (again) => {
        const modes = again.modes.filter((m) => m.name === mode.name);
        return modes.length > 0 && modes.every((m) => JSON.stringify(m.heads) === wanted);
      },
    });
  }
  if (o.heads?.follow === false)
    notExported.push({ part: "heads", message: say("halo : « reste éteint sauf peint » est un réglage de ce serveur, QLC+ n'a pas de tête d'accent", "halo: “stays dark unless painted” is a setting of this server, QLC+ has no accent head") });

  if (o.tracks && (o.tracks.enabled !== undefined || o.tracks.fade))
    notExported.push({ part: "tracks", message: say("pistes fondables : QLC+ n'a pas de liste des canaux qui suivent les fondus dans une définition", "fadeable tracks: QLC+ has no list of the channels that follow the fades in a definition") });

  return { corrections, promised, applied: promised.map((p) => p.note), notExported };
}

/**
 * Each promise of `planCorrections` checked on the written file read again: `applied` what it really carries,
 * `notExported` what it does not (a refusal of the writer said once for all the promises it covers, else `missed`).
 */
export function settleCorrections(promised: PromisedRetouch[], again: FixtureDefinition, refused: RefusedRetouch[]): { applied: ExportNote[]; notExported: ExportNote[] } {
  const applied: ExportNote[] = [];
  const notExported: ExportNote[] = refused.map((r) => r.note);
  for (const p of promised) {
    if (p.written(again)) applied.push(p.note);
    else if (!refused.some((r) => r.key === p.key)) notExported.push(p.missed);
  }
  return { applied, notExported };
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

/** Names Windows reserves for devices, whatever follows the first dot (`CON.qxf`, `CON.v2.qxf` cannot be saved there). */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** A short stable fingerprint of a text (FNV-1a, 32 bits, hex). */
function fingerprint(s: string): string {
  let h = 0x811c9dc5;
  for (const c of s) {
    h ^= c.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * The file name QLC+ gives a definition, `Manufacturer-Model.qxf` (spaces as `-`), kept plain as the library's
 * names are (definitionFileName: accents dropped, other signs as `-`), without doubled or trailing dashes. Letters
 * with a usual Latin spelling are folded (« Straße » as « Strasse »); a name with letters of another script, which
 * the plain name drops, gets a fingerprint of the full names, so two such models never share a file name; a name
 * Windows reserves (CON, NUL, COM1…) gets a `_`.
 */
export function qxfFileName(manufacturer: string, model: string): string {
  const part = (s: string) => foldLatin(s.trim()).replace(/[^\p{L}\p{N}_.]+/gu, "-").replace(/^-+|-+$/g, "");
  const parts = [part(manufacturer), part(model)];
  const lossy = parts.some((p) => /[^A-Za-z0-9_.-]/.test(p));
  const name = definitionFileName(parts.filter(Boolean).join("-"))
    .replace(/-{2,}/g, "-")
    .replace(/-+\.qxf$/, ".qxf");
  const stem = name.slice(0, -".qxf".length);
  if (lossy) return `${stem === "definition" ? "" : `${stem}-`}${fingerprint(`${manufacturer}\u0000${model}`)}.qxf`;
  // Windows reads the name before the first dot: « CON.v2.qxf » is reserved too
  return WINDOWS_RESERVED.test(stem.split(".")[0]!) ? `${stem}_.qxf` : name;
}
