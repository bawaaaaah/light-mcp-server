/**
 * The MIDI page's monitor line for a journal entry (docs/specs/midi.md): a message and what it did, or a release made with
 * no message (an input gone, a profile change, a mapping changed) with its cause. Pure: tested without a browser.
 */
import type { Texts } from "./i18n.js";

/** An entry of the MIDI journal as the monitor hears it (wiring/midi-wiring.ts MidiJournalEntry). */
export interface MonitorEntry {
  port: string;
  msg: Record<string, unknown>;
  matched?: { id: string; label: string; mode: string }[];
  calls: { command: string; target: string; ok: boolean; error?: string }[];
  ms: number;
}

const callsText = (e: MonitorEntry): string => e.calls.map((c) => `${c.command}${c.target ? ` ${c.target}` : ""} ${c.ok ? "✓" : `✗ ${c.error ?? ""}`}`).join(", ");

export function describeMonitor(e: MonitorEntry, t: Texts): string {
  if (e.msg.type === "release") {
    const cause = t.releaseCauses[e.msg.cause as keyof Texts["releaseCauses"]] ?? String(e.msg.cause);
    const released = e.matched?.map((x) => x.label || x.id).join(", ") ?? "";
    // a released action without an end command (no `off`): nothing to send, said as such
    return `${e.port || "—"} · ${cause} → ${released}${t.colon} ${callsText(e) || t.releaseNothing}`;
  }
  const raw = `${e.port} · ${Object.values(e.msg).join(" ")}`;
  if (!e.matched?.length) return `${raw} · ${t.monitorUnmapped}`;
  const who = e.matched.map((x) => `${x.label || x.id} (${t.modesShort[x.mode as keyof Texts["modesShort"]] ?? x.mode})`).join(", ");
  return `${raw} → ${who}${t.colon} ${callsText(e) || t.monitorNothing}${e.ms >= 20 ? ` · ${Math.round(e.ms)} ms` : ""}`;
}
