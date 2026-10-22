/**
 * MIDI mapping editor (docs/specs/midi.md): input (note, CC, program change; channel, number) with
 * « Apprendre » (the next message received), mode, and the action — start a look, a DCA level,
 * a flash, a song section, a rule program, the transport, panic or blackout. Saved with `midi.mapping.put`.
 */
import { useEffect, useState } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { slug, uniqueId } from "../util";

export interface MappingDraft {
  id: string;
  label: string;
  input: { type: "note" | "cc" | "programchange"; channel: number; number: number; port?: string };
  mode: "trigger" | "latch" | "momentary";
  on: { command: string; args: Record<string, unknown> };
  off?: { command: string; args: Record<string, unknown> };
  levelArg?: string;
  feedback: "none" | "note" | "cc";
}
interface Named {
  id: string;
  name: string;
  title?: string;
  sections?: { id: string; name: string }[];
}

/** Actions offered; the editor builds the on/off commands and the level argument from them. */
const ACTIONS = ["look", "dca", "grandmaster", "fader", "flash", "section", "program", "snapshot", "song.next", "song.prev", "setlist.next", "setlist.prev", "look.stopall", "tempo.tap", "panic", "blackout"] as const;
export type Action = (typeof ACTIONS)[number];
/** Target meaning « no program » (program.select with id null). */
const NO_PROGRAM = "-";

export function actionOf(m: MappingDraft): { action: Action; target: string } {
  const id = String(m.on.args.id ?? "");
  if (m.on.command === "look.go") return { action: "look", target: id };
  if (m.on.command === "group.level") return { action: "dca", target: id };
  if (m.on.command === "fader.level") return { action: "fader", target: id };
  if (m.on.command === "grandmaster.set") return { action: "grandmaster", target: "" };
  if (m.on.command === "group.flash") return { action: "flash", target: id };
  if (m.on.command === "snapshot.recall") return { action: "snapshot", target: String(m.on.args.id ?? "") };
  if (m.on.command === "program.select") return { action: "program", target: m.on.args.id === null ? NO_PROGRAM : String(m.on.args.id ?? "") };
  if (m.on.command === "song.section.go") return { action: "section", target: `${String(m.on.args.song ?? "")}/${String(m.on.args.section ?? "")}` };
  return { action: (ACTIONS as readonly string[]).includes(m.on.command) ? (m.on.command as Action) : "look", target: "" };
}

export function build(m: MappingDraft, action: Action, target: string): MappingDraft {
  const base = { ...m, off: undefined, levelArg: undefined };
  switch (action) {
    case "look":
      return { ...base, on: { command: "look.go", args: { id: target } }, off: m.mode === "trigger" ? undefined : { command: "look.stop", args: { id: target } } };
    case "dca":
      return { ...base, on: { command: "group.level", args: { id: target } }, levelArg: "level" };
    case "fader":
      return { ...base, on: { command: "fader.level", args: { id: target } }, levelArg: "level" };
    case "grandmaster":
      return { ...base, on: { command: "grandmaster.set", args: {} }, levelArg: "level" };
    case "flash":
      return { ...base, mode: "momentary", on: { command: "group.flash", args: { id: target, on: true } }, off: { command: "group.flash", args: { id: target, on: false } } };
    case "section": {
      const [song, section] = target.split("/");
      return { ...base, on: { command: "song.section.go", args: { song, section } } };
    }
    case "program":
      return { ...base, mode: "trigger", on: { command: "program.select", args: { id: target === NO_PROGRAM ? null : target } } };
    case "snapshot":
      return { ...base, mode: "trigger", on: { command: "snapshot.recall", args: { id: target } } };
    case "blackout":
      return { ...base, on: { command: "blackout", args: { on: true } }, off: m.mode === "trigger" ? undefined : { command: "blackout", args: { on: false } } };
    default:
      return { ...base, on: { command: action, args: {} } };
  }
}

export const newMapping = (): MappingDraft => ({ id: "", label: "", input: { type: "note", channel: 1, number: 36 }, mode: "trigger", on: { command: "look.go", args: { id: "" } }, feedback: "note" });

export function MappingEditor({ initial, existing, onClose }: { initial: MappingDraft; existing: string[]; onClose: () => void }) {
  const t = useT();
  const [m, setM] = useState<MappingDraft>(initial);
  const [{ action, target }, setAction] = useState(actionOf(initial));
  const [looks, setLooks] = useState<Named[]>([]);
  const [groups, setGroups] = useState<Named[]>([]);
  const [songs, setSongs] = useState<Named[]>([]);
  const [faders, setFaders] = useState<Named[]>([]);
  const [programs, setPrograms] = useState<Named[]>([]);
  const [snapshots, setSnapshots] = useState<Named[]>([]);
  const [learning, setLearning] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void cmd<Named[]>("look.list", { brief: true }).then(setLooks);
    void cmd<Named[]>("group.list").then(setGroups);
    void cmd<Named[]>("song.list").then(setSongs);
    void cmd<Named[]>("fader.list").then(setFaders);
    void cmd<{ programs: Named[] }>("program.list").then((r) => setPrograms(r.programs));
    void cmd<Named[]>("snapshot.list").then(setSnapshots, () => undefined);
  }, []);

  const targets: Named[] =
    action === "look" ? looks : action === "dca" || action === "flash" ? groups : action === "fader" ? faders : action === "program" ? [...programs, { id: NO_PROGRAM, name: t.noProgram }] : action === "snapshot" ? snapshots : action === "section" ? songs.flatMap((s) => (s.sections ?? []).map((x) => ({ id: `${s.id}/${x.id}`, name: `${s.title ?? s.name} · ${x.name}` }))) : [];
  const learn = () => {
    setLearning(true);
    void cmd<{ input: MappingDraft["input"] }>("midi.learn", { timeoutMs: 15000 })
      // learnt from any controller; a DJ's command (OS2L) keeps its port: only it plays that mapping, no LED to light
      .then((r) => setM({ ...m, input: { ...r.input, port: r.input.port === "OS2L" ? "OS2L" : undefined }, feedback: r.input.port === "OS2L" ? "none" : r.input.type === "cc" ? "cc" : m.feedback }))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLearning(false));
  };
  const save = () => {
    if (targets.length && !target) return setError(t.targetRequired);
    const label = m.label || targets.find((x) => x.id === target)?.name || t.mappingActions[action];
    const full = build({ ...m, label }, action, target);
    const id = initial.id || uniqueId(slug(`${m.input.type}-${m.input.number}-${label}`, "mapping"), existing);
    void cmd("midi.mapping.put", { mapping: { ...full, id } })
      .then(onClose)
      .catch((e: Error) => setError(e.message));
  };

  const dj = m.input.port === "OS2L";
  return (
    <section className="mapping-editor look-editor">
      <h2>{initial.id ? `${t.editLook} · ${initial.label}` : t.newMapping}</h2>
      <div className="fields">
        {/* a controller (any watched input), or the DJ's numbered commands (OS2L), which only it plays */}
        <label className="field">
          <span>{t.mappingSource}</span>
          <select
            aria-label={t.mappingSource}
            value={dj ? "os2l" : ""}
            onChange={(e) => setM(e.target.value === "os2l" ? { ...m, input: { ...m.input, port: "OS2L", type: "cc", channel: 1 }, feedback: "none" } : { ...m, input: { ...m.input, port: undefined } })}
          >
            <option value="">{t.sourceController}</option>
            <option value="os2l">DJ (OS2L)</option>
          </select>
        </label>
        {!dj && (
          <>
            <label className="field">
              <span>{t.midiType}</span>
              <select value={m.input.type} onChange={(e) => setM({ ...m, input: { ...m.input, type: e.target.value as MappingDraft["input"]["type"] } })}>
                <option value="note">note</option>
                <option value="cc">CC</option>
                <option value="programchange">program change</option>
              </select>
            </label>
            <label className="field">
              <span>{t.midiChannel}</span>
              <input type="number" min={1} max={16} value={m.input.channel} onChange={(e) => setM({ ...m, input: { ...m.input, channel: Number(e.target.value) } })} />
            </label>
          </>
        )}
        <label className="field">
          <span>{dj ? t.djCommandNumber : t.midiNumber}</span>
          <input type="number" min={0} max={127} value={m.input.number} onChange={(e) => setM({ ...m, input: { ...m.input, number: Number(e.target.value) } })} />
        </label>
        <button onClick={learn} disabled={learning}>
          {learning ? t.learning : t.learn}
        </button>
        <label className="field">
          <span>{t.mode}</span>
          <select value={m.mode} onChange={(e) => setM({ ...m, mode: e.target.value as MappingDraft["mode"] })} disabled={action === "flash" || action === "dca" || action === "fader" || action === "grandmaster"}>
            {(["trigger", "latch", "momentary"] as const).map((x) => (
              <option key={x} value={x}>
                {t.modes[x]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t.action}</span>
          <select value={action} onChange={(e) => setAction({ action: e.target.value as Action, target: "" })}>
            {ACTIONS.map((a) => (
              <option key={a} value={a}>
                {t.mappingActions[a]}
              </option>
            ))}
          </select>
        </label>
        {targets.length > 0 && (
          <label className="field">
            <span>{t.target}</span>
            <select aria-label={t.target} value={target} onChange={(e) => setAction({ action, target: e.target.value })}>
              <option value="">—</option>
              {targets.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          <span>{t.feedbackLabel}</span>
          <select value={m.feedback} onChange={(e) => setM({ ...m, feedback: e.target.value as MappingDraft["feedback"] })}>
            <option value="note">note</option>
            <option value="cc">CC</option>
            <option value="none">—</option>
          </select>
        </label>
        <label className="field">
          <span>{t.labelText}</span>
          <input placeholder={t.optional} value={m.label} onChange={(e) => setM({ ...m, label: e.target.value })} />
        </label>
      </div>
      <div className="row actions">
        <button className="primary" onClick={save}>
          {t.save}
        </button>
        <button className="ghost" onClick={onClose}>
          {t.close}
        </button>
        {initial.id && (
          <button className="ghost danger" onClick={() => void cmd("midi.mapping.delete", { id: initial.id }).then(onClose)}>
            {t.delete}
          </button>
        )}
        {error && (
          <span className="error" onClick={() => setError("")}>
            {error}
          </span>
        )}
      </div>
    </section>
  );
}
