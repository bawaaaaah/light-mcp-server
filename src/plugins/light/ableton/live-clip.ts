/**
 * Ableton clip files (.alc) for rule programs (docs/specs/midi.md, Ableton): a clip that sends a
 * Program Change when launched — like the user's « A #100 » clip on a « Show TAG » track. Same rule
 * as the rack: a shell clip exported by the user's Live is cloned and only the first clip's name
 * and Program Change change; everything else stays byte for byte (the groove pool's own clips are
 * left alone). Pure: XML text in, XML text out.
 */

export interface ProgramClip {
  /** Clip name, e.g. « Prière #100 ». */
  name: string;
  /** 0..127, the MIDI byte (Live shows it +1). */
  programChange: number;
}

const attr = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The clip name Live users expect: the program's name and Live's own numbering (#PC + 1). */
export const programClipName = (name: string, programChange: number) => `${name} #${programChange + 1}`;

export function cloneProgramClip(shellXml: string, clip: ProgramClip): string {
  const start = shellXml.indexOf("<MidiClip ");
  const end = start < 0 ? -1 : shellXml.indexOf("</MidiClip>", start);
  if (start < 0 || end < 0) throw new Error("coquille .alc invalide : aucun clip MIDI (exporter un clip MIDI depuis Live)");
  let body = shellXml.slice(start, end);
  const name = /<Name Value="[^"]*" \/>/;
  const pc = /<ProgramChange Value="-?\d+" \/>/;
  if (!name.test(body) || !pc.test(body)) throw new Error("coquille .alc invalide : nom ou Program Change du clip introuvable");
  body = body.replace(name, `<Name Value="${attr(clip.name)}" />`).replace(pc, `<ProgramChange Value="${clip.programChange}" />`);
  return shellXml.slice(0, start) + body + shellXml.slice(end);
}

/** Reads back the first clip's name and Program Change (verification, tests). */
export function readProgramClip(xml: string): ProgramClip | undefined {
  const start = xml.indexOf("<MidiClip ");
  const body = start < 0 ? "" : xml.slice(start, xml.indexOf("</MidiClip>", start));
  const name = /<Name Value="([^"]*)" \/>/.exec(body)?.[1];
  const pc = /<ProgramChange Value="(-?\d+)" \/>/.exec(body)?.[1];
  return name !== undefined && pc !== undefined ? { name: name.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"), programChange: Number(pc) } : undefined;
}
