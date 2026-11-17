/**
 * MIDI mapping editor (docs/specs/midi.md): input (note, CC, program change, pitch bend; channel, number) with
 * « Apprendre » (the next message received), mode, and the action — start a look, a DCA level,
 * a flash, a song section, a rule program, the transport, panic or blackout. Saved with `midi.mapping.put`.
 */
import { useEffect, useId, useState, type ReactElement } from "react";
import { cmd } from "../api";
import { useT } from "../i18n-context";
import { slug, uniqueId } from "../util";
import { ACTIONS, MIDI_TYPES, NO_PROGRAM, answersEveryValue, build, actionOf, colourGroupOf, withInputType, type Action, type LearntInput, type MappingDraft, type MidiType } from "../mappingActions";
import { useColourPresets } from "../hooks/useColourPresets";
import { EditorActions } from "./EditorActions";

export { actionOf, build, newMapping, type Action, type LearntInput, type MappingDraft } from "../mappingActions";

interface Named {
  id: string;
  name: string;
  title?: string;
  sections?: { id: string; name: string }[];
}

export function MappingEditor({ initial, existing, onClose }: { initial: MappingDraft; existing: string[]; onClose: () => void }): ReactElement {
  const t = useT();
  const [m, setM] = useState<MappingDraft>(initial);
  const [{ action, target }, setAction] = useState(actionOf(initial));
  const [looks, setLooks] = useState<Named[]>([]);
  const [groups, setGroups] = useState<Named[]>([]);
  const [songs, setSongs] = useState<Named[]>([]);
  const [faders, setFaders] = useState<Named[]>([]);
  const [programs, setPrograms] = useState<Named[]>([]);
  const [snapshots, setSnapshots] = useState<Named[]>([]);
  const [positions, setPositions] = useState<Named[]>([]);
  // a saved colour (T41) and the group it colours ("" = every fixture)
  const { presets: colours, loaded: coloursLoaded } = useColourPresets();
  const [colourGroup, setColourGroup] = useState(() => colourGroupOf(initial));
  const [learning, setLearning] = useState(false);
  const [error, setError] = useState("");
  /** The number before a pitch bend was chosen (which has none): it comes back with another type. */
  const [keptNumber, setKeptNumber] = useState(initial.input.number);
  const bendHintId = useId();

  useEffect(() => {
    void cmd<Named[]>("look.list", { brief: true }).then(setLooks);
    void cmd<Named[]>("group.list").then(setGroups);
    void cmd<Named[]>("song.list").then(setSongs);
    void cmd<Named[]>("fader.list").then(setFaders);
    void cmd<{ programs: Named[] }>("program.list").then((r) => setPrograms(r.programs));
    void cmd<Named[]>("snapshot.list").then(setSnapshots, () => undefined);
    void cmd<Named[]>("position.preset.list").then(setPositions, () => undefined);
  }, []);

  const targets: Named[] =
    action === "look" ? looks : action === "dca" || action === "flash" || action === "freeze" ? groups : action === "fader" ? faders : action === "program" ? [...programs, { id: NO_PROGRAM, name: t.noProgram }] : action === "snapshot" ? snapshots : action === "position" ? positions : action === "colour" ? colours.map((c) => ({ id: c.id, name: `${c.name} (${c.origin === "personal" ? t.colours.originPersonal : t.colours.originShow})` })) : action === "section" ? songs.flatMap((s) => (s.sections ?? []).map((x) => ({ id: `${s.id}/${x.id}`, name: `${s.title ?? s.name} · ${x.name}` }))) : [];
  const learn = () => {
    setLearning(true);
    void cmd<{ input: LearntInput }>("midi.learn", { timeoutMs: 15000 })
      // learnt from any controller; a DJ's command (OS2L) keeps its port: only it plays that mapping, no LED to light (nor
      // for a pitch bend's wheel)
      .then((r) => {
        const learnt: MappingDraft = { ...m, input: { ...r.input, port: r.input.port === "OS2L" ? "OS2L" : undefined }, feedback: r.input.port === "OS2L" || r.input.type === "pitchbend" ? "none" : r.input.type === "cc" ? "cc" : m.feedback };
        setM(r.input.type === "pitchbend" ? withInputType(learnt, "pitchbend") : learnt);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLearning(false));
  };
  const save = () => {
    // a freeze without a group is every head: its target is optional
    if (targets.length && !target && action !== "freeze") return setError(t.targetRequired);
    const label = m.label || targets.find((x) => x.id === target)?.name || t.mappingActions[action];
    const full = build({ ...m, label }, action, target, colourGroup);
    const id = initial.id || uniqueId(slug(`${m.input.type}-${m.input.number}-${label}`, "mapping"), existing);
    void cmd("midi.mapping.put", { mapping: { ...full, id } })
      .then(onClose)
      .catch((e: Error) => setError(e.message));
  };

  const dj = m.input.port === "OS2L";
  const bend = !dj && m.input.type === "pitchbend";
  const setType = (type: MidiType) => {
    if (m.input.type !== "pitchbend") setKeptNumber(m.input.number);
    setM(withInputType(m, type, m.input.type === "pitchbend" ? keptNumber : m.input.number));
  };
  // a level action plays its own way, a CC included (its value is the level: a toggle would flicker);
  // a flash too, except from a CC, where a button may still toggle or hold it
  // a named position is recalled at each press (T32): always « Déclencher »
  const modeLocked = action === "dca" || action === "fader" || action === "grandmaster" || (action === "flash" && !answersEveryValue(m.input.type)) || action === "position" || action === "colour";
  return (
    <section className="mapping-editor look-editor">
      <h2>{initial.id ? `${t.editLook} · ${initial.label}` : t.newMapping}</h2>
      <fieldset className="mapping-group">
        <legend>{t.midiInputSection}</legend>
        <div className="mapping-grid">
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
                <select value={m.input.type} onChange={(e) => setType(e.target.value as MidiType)} aria-describedby={bend ? bendHintId : undefined}>
                  {MIDI_TYPES.map((x) => (
                    <option key={x} value={x}>
                      {t.midiTypes[x]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{t.midiChannel}</span>
                <input type="number" min={1} max={16} value={m.input.channel} onChange={(e) => setM({ ...m, input: { ...m.input, channel: Number(e.target.value) } })} />
              </label>
            </>
          )}
          {/* a pitch bend is the channel's wheel: it has no number */}
          {!bend && (
            <label className="field">
              <span>{dj ? t.djCommandNumber : t.midiNumber}</span>
              <input type="number" min={0} max={127} value={m.input.number} onChange={(e) => setM({ ...m, input: { ...m.input, number: Number(e.target.value) } })} />
            </label>
          )}
          <button className="learn" onClick={learn} disabled={learning}>
            {learning ? t.learning : t.learn}
          </button>
        </div>
        {bend && (
          <p className="hint" id={bendHintId}>
            {t.pitchbendHint}
          </p>
        )}
      </fieldset>
      <fieldset className="mapping-group">
        <legend>{t.midiPlaySection}</legend>
        <div className="mapping-grid">
          <label className="field wide">
            <span>{t.mode}</span>
            <select value={action === "position" || action === "colour" ? "trigger" : m.mode} onChange={(e) => setM({ ...m, mode: e.target.value as MappingDraft["mode"] })} disabled={modeLocked}>
              {(["trigger", "latch", "momentary", "toggle"] as const).map((x) => (
                <option key={x} value={x}>
                  {t.modes[x]}
                </option>
              ))}
            </select>
          </label>
          {/* a CC's value or a note's velocity; a program change has none */}
          {m.input.type !== "programchange" && (
            <label className="field" title={t.thresholdHelp}>
              <span>{t.threshold}</span>
              <input type="number" min={0} max={126} step={1} value={m.threshold ?? 0} onChange={(e) => setM({ ...m, threshold: Math.min(126, Math.max(0, Math.round(Number(e.target.value)) || 0)) })} />
            </label>
          )}
        </div>
        {/* what the chosen mode does, so the choice reads without the docs; a level action follows its control */}
        <p className="hint">{action === "position" ? t.positions.modeLockedHint : action === "colour" ? t.colours.modeHint : modeLocked ? t.modeLockedHint : action === "freeze" && m.mode === "trigger" ? t.motionLock.midiTriggerHint : t.modeHints[m.mode]}</p>
        {m.input.type !== "programchange" && <p className="hint">{t.thresholdHelp}</p>}
      </fieldset>
      <fieldset className="mapping-group">
        <legend>{t.midiDoSection}</legend>
        <div className="mapping-grid">
          <label className="field wide">
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
            <label className="field wide">
              <span>{t.target}</span>
              <select aria-label={t.target} value={target} onChange={(e) => setAction({ action, target: e.target.value })}>
                <option value="">{action === "freeze" ? t.motionLock.allHeads : "—"}</option>
                {targets.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {action === "colour" && target && coloursLoaded && !colours.some((c) => c.id === target) && (
            <p className="warn wide" role="status">
              {t.colours.mappingDeleted}
            </p>
          )}
          {action === "colour" && (
            <label className="field wide">
              <span>{t.colours.mappingGroup}</span>
              <select aria-label={t.colours.mappingGroup} value={colourGroup} onChange={(e) => setColourGroup(e.target.value)}>
                <option value="">{t.colours.widgetAll}</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </fieldset>
      <fieldset className="mapping-group">
        <legend>{t.midiMoreSection}</legend>
        <div className="mapping-grid">
          <label className="field wide">
            <span>{t.labelText}</span>
            <input placeholder={t.optional} value={m.label} onChange={(e) => setM({ ...m, label: e.target.value })} />
          </label>
          <label className="field">
            <span>{t.feedbackLabel}</span>
            <select value={m.feedback} onChange={(e) => setM({ ...m, feedback: e.target.value as MappingDraft["feedback"] })}>
              <option value="note">note</option>
              <option value="cc">CC</option>
              <option value="none">—</option>
            </select>
          </label>
          {/* a pitch bend's hidden number is where its feedback goes: shown once a feedback is chosen */}
          {bend && m.feedback !== "none" && (
            <label className="field">
              <span>{t.feedbackNumber}</span>
              <input type="number" min={0} max={127} value={m.input.number} onChange={(e) => setM({ ...m, input: { ...m.input, number: Number(e.target.value) } })} />
            </label>
          )}
        </div>
      </fieldset>
      <EditorActions onSave={save} onClose={onClose} onDelete={initial.id ? () => void cmd("midi.mapping.delete", { id: initial.id }).then(onClose) : undefined} error={error} onDismissError={() => setError("")} />
    </section>
  );
}
