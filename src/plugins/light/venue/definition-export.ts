/**
 * Exporting a library definition as a `.qxf` file (docs/specs/venue-fixtures-stage.md, « Exporter une définition »):
 * the one function the command (`fixture.definition.export`: MCP, HTTP, CLI) and the interface share. Reads the
 * library file; the XML work is in qxf-export.ts (pure).
 */
import { say } from "../../../core/lang.js";
import { lostAccents, planCorrections, qxfFileName, settleCorrections, writeQxfCorrections, type ExportNote } from "./qxf-export.js";
import { modelKeyOrUndefined, type FixtureOverrides } from "./overrides.js";
import { isGenericDimmer } from "./names.js";
import { parseQxf } from "./qxf-import.js";
import { encodeDefinition, readDefinitionText } from "./definition-files.js";
import type { Venue } from "./venue.js";

export interface DefinitionExport {
  /** The name QLC+ would give the file (`Manufacturer-Model.qxf`). */
  file: string;
  /** The library file it comes from, as the library lists it. */
  source: string;
  manufacturer: string;
  model: string;
  /** The file's text: read as UTF-8, or byte for byte as Latin-1 when its bytes are not valid UTF-8. */
  xml: string;
  /** The file's bytes in base64, only when they are not valid UTF-8: they are then what to save, not `xml`. */
  base64?: string;
  /** Whether the text differs from the library file (corrections written). */
  corrected: boolean;
  /** What the corrections wrote, and what they could not (QLC+ has no place for it). */
  applied: ExportNote[];
  notExported: ExportNote[];
}

/**
 * A definition of the library as a `.qxf` file: by its model, or by a patched fixture's. Without `corrections`, the
 * library file byte for byte. With them, this venue's corrections written into it where QLC+ has a place for them —
 * the model's (`manufacturer` + `model`), or the fixture's merged over its model's (`fixture`) — and the rest named.
 */
export function exportDefinition(venue: Venue, args: { fixture?: string; manufacturer?: string; model?: string; corrections?: boolean }): DefinitionExport {
  if (args.fixture !== undefined && (args.manufacturer !== undefined || args.model !== undefined))
    throw new Error(say("donner fixture, ou manufacturer et model, pas les deux", "give fixture, or manufacturer and model, not both"));
  venue.refreshDefinitions();
  const patch = args.fixture !== undefined ? venue.fixtures.get(args.fixture) : undefined;
  if (args.fixture !== undefined && !patch) throw new Error(say(`fixture inconnue : ${args.fixture}`, `unknown fixture: ${args.fixture}`));
  const manufacturer = patch?.manufacturer ?? args.manufacturer;
  const model = patch?.model ?? args.model;
  if (!manufacturer || !model) throw new Error(say("donner fixture, ou manufacturer et model", "give fixture, or manufacturer and model"));
  const found = venue.definitionFileFor(manufacturer, model);
  if (!found) {
    if (isGenericDimmer(manufacturer, model)) throw new Error(say("le gradateur générique est intégré à QLC+ : il n'a pas de fichier .qxf", "the generic dimmer is built into QLC+: it has no .qxf file"));
    throw new Error(say(`aucune définition dans la bibliothèque pour ${manufacturer} ${model}`, `no definition in the library for ${manufacturer} ${model}`));
  }
  // read as the library reads it (decodeDefinition): a single-byte file (ISO-8859-1, Windows-1252, or all ASCII under
  // such a declaration) byte for byte, so that every byte but the retouches comes back, and retouches are written alike
  const read = readDefinitionText(found.path);
  const latin1 = read.latin1;
  const source = read.text;
  const encoded = (out: string) => (latin1 ? { base64: encodeDefinition(out, read.encoding).toString("base64") } : {});
  const def = found.def;
  const base = { file: qxfFileName(def.manufacturer, def.model), source: found.source, manufacturer: found.def.manufacturer, model: found.def.model };
  // no corrections: the file's own bytes, never re-encoded
  if (!args.corrections) return { ...base, xml: source, ...(latin1 ? { base64: read.bytes.toString("base64") } : {}), corrected: false, applied: [], notExported: [] };

  const key = modelKeyOrUndefined(found.def.manufacturer, found.def.model);
  const overrides: FixtureOverrides = patch ? venue.overridesOf(patch) : ((key ? venue.models.get(key)?.overrides : undefined) ?? {});
  // planned on the text as it is edited (def: its names as written there), not on the library's own reading
  const { corrections, promised, notExported } = planCorrections(def, overrides);
  let written: ReturnType<typeof writeQxfCorrections>;
  let again: ReturnType<typeof parseQxf>;
  try {
    written = writeQxfCorrections(source, corrections);
    // read again as an import would: a file this server writes must be one it (and QLC+) can read
    again = parseQxf(written.xml);
  } catch (err) {
    const why = (err as Error).message;
    throw new Error(say(`${found.source} : les corrections ne peuvent pas être écrites dans ce fichier (${why}) ; l'exporter sans corrections`, `${found.source}: the corrections cannot be written into this file (${why}); export it without corrections`));
  }
  const settled = settleCorrections(promised, again, written.refused);
  notExported.push(...settled.notExported, ...lostAccents(def, again, overrides));
  const o = patch?.orientation;
  if (o && (o.invertPan || o.invertTilt || o.swapPanTilt || o.panOffset || o.tiltOffset))
    notExported.push({ part: "orientation", message: say("inversions et décalages pan/tilt de l'appareil : propres à son accrochage, QLC+ les règle dans le workspace, pas dans la définition", "the fixture's pan/tilt inversions and offsets: they belong to how it hangs, QLC+ sets them in the workspace, not in the definition") });
  const xml = written.xml;
  return { ...base, xml, ...encoded(xml), corrected: xml !== source, applied: settled.applied, notExported };
}
