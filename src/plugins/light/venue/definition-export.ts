/**
 * Exporting a library definition as a `.qxf` file (docs/specs/venue-fixtures-stage.md, « Exporter une définition »):
 * the one function the command (`fixture.definition.export`: MCP, HTTP, CLI) and the interface share. Reads the
 * library file; the XML work is in qxf-export.ts (pure).
 */
import { readFileSync } from "node:fs";
import { say } from "../../../core/lang.js";
import { applyQxfCorrections, lostAccents, planCorrections, qxfFileName, type ExportNote } from "./qxf-export.js";
import { modelKeyOrUndefined, type FixtureOverrides } from "./overrides.js";
import { GENERIC_DIMMER, parseQxf, sameName } from "./qxf-import.js";
import type { Venue } from "./venue.js";

export interface DefinitionExport {
  /** The name QLC+ would give the file (`Manufacturer-Model.qxf`). */
  file: string;
  /** The library file it comes from, as the library lists it. */
  source: string;
  manufacturer: string;
  model: string;
  /** The file's text (UTF-8). */
  xml: string;
  /** The file's bytes in base64, only when they are not valid UTF-8: `xml` is then a lossy reading of them. */
  base64?: string;
  /** Whether the text differs from the library file (corrections written). */
  corrected: boolean;
  /** What the corrections wrote, and what they could not (QLC+ has no place for it). */
  applied: ExportNote[];
  notExported: ExportNote[];
}

/** Reads bytes as UTF-8, or undefined when they are not valid UTF-8. */
function utf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * A definition of the library as a `.qxf` file: by its model, or by a patched fixture's. Without `corrections`, the
 * library file byte for byte. With them, this venue's corrections written into it where QLC+ has a place for them —
 * the model's (`manufacturer` + `model`), or the fixture's merged over its model's (`fixture`) — and the rest named.
 */
export function exportDefinition(venue: Venue, args: { fixture?: string; manufacturer?: string; model?: string; corrections?: boolean }): DefinitionExport {
  venue.refreshDefinitions();
  const patch = args.fixture !== undefined ? venue.fixtures.get(args.fixture) : undefined;
  if (args.fixture !== undefined && !patch) throw new Error(say(`fixture inconnue : ${args.fixture}`, `unknown fixture: ${args.fixture}`));
  const manufacturer = patch?.manufacturer ?? args.manufacturer;
  const model = patch?.model ?? args.model;
  if (!manufacturer || !model) throw new Error(say("donner fixture, ou manufacturer et model", "give fixture, or manufacturer and model"));
  const found = venue.definitionFileFor(manufacturer, model);
  if (!found) {
    if (sameName(manufacturer, GENERIC_DIMMER.manufacturer) && sameName(model, GENERIC_DIMMER.model))
      throw new Error(say("le gradateur générique est intégré à QLC+ : il n'a pas de fichier .qxf", "the generic dimmer is built into QLC+: it has no .qxf file"));
    throw new Error(say(`aucune définition dans la bibliothèque pour ${manufacturer} ${model}`, `no definition in the library for ${manufacturer} ${model}`));
  }
  const bytes = readFileSync(found.path);
  const text = utf8(bytes);
  const base = { file: qxfFileName(found.def.manufacturer, found.def.model), source: found.source, manufacturer: found.def.manufacturer, model: found.def.model };
  if (!args.corrections) return { ...base, xml: text ?? bytes.toString("utf8"), ...(text === undefined ? { base64: bytes.toString("base64") } : {}), corrected: false, applied: [], notExported: [] };

  const key = modelKeyOrUndefined(found.def.manufacturer, found.def.model);
  const overrides: FixtureOverrides = patch ? venue.overridesOf(patch) : ((key ? venue.models.get(key)?.overrides : undefined) ?? {});
  const source = text ?? bytes.toString("utf8");
  const { corrections, applied, notExported } = planCorrections(found.def, overrides);
  const xml = applyQxfCorrections(source, corrections);
  // read again as an import would: a file this server writes must be one it (and QLC+) can read
  const again = parseQxf(xml);
  notExported.push(...lostAccents(found.def, again, overrides));
  const o = patch?.orientation;
  if (o && (o.invertPan || o.invertTilt || o.swapPanTilt || o.panOffset || o.tiltOffset))
    notExported.push({ part: "orientation", message: say("inversions et décalages pan/tilt de l'appareil : propres à son accrochage, QLC+ les règle dans le workspace, pas dans la définition", "the fixture's pan/tilt inversions and offsets: they belong to how it hangs, QLC+ sets them in the workspace, not in the definition") });
  const corrected = xml !== source;
  return { ...base, xml, ...(text === undefined && !corrected ? { base64: bytes.toString("base64") } : {}), corrected, applied, notExported };
}
