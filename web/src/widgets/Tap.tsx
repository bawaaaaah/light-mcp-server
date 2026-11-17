import { useRef, useState, useSyncExternalStore, type ReactElement } from "react";
import { useT } from "../i18n-context";
import { microphone } from "../audio/microphone";
import type { WidgetProps } from "./env";

/**
 * The tempo: « Tap », the BPM typed by hand, « ↺ MIDI » to give Ableton's clock the lead back, and the microphone that
 * follows the tempo heard in the room.
 */
export function TapWidget({ env }: WidgetProps): ReactElement {
  const t = useT();
  const { locked, run, tempo } = env;
  const mic = useSyncExternalStore(microphone.subscribe, () => microphone.state);
  // the tempo heard in the room: followed while the microphone is on, a manual tempo again after
  const toggleMic = () => {
    if (!mic.on) void microphone.start(({ bpm, beatAgoMs }) => void run("tempo.set", { bpm, source: "audio", ...(beatAgoMs !== undefined ? { beatAgoMs } : {}) }));
    else {
      microphone.stop();
      if (tempo?.source === "audio") void run("tempo.set", { source: "manual" });
    }
  };
  // the tempo typed by hand: the field keeps what is typed while it has the focus (the live tempo
  // would overwrite it), then sets it — a manual tempo, the microphone off
  const [bpmDraft, setBpmDraft] = useState<{ value: string; typed: boolean } | null>(null);
  const bpmCancelled = useRef(false);
  const setBpmByHand = (value: string) => {
    const typed = bpmDraft?.typed && !bpmCancelled.current;
    bpmCancelled.current = false;
    setBpmDraft(null);
    const bpm = Number(value.replace(",", "."));
    if (!typed || !(bpm >= 20 && bpm <= 400)) return; // left untouched, or Escape: nothing sent
    if (mic.on) microphone.stop();
    void run("tempo.set", { bpm: Math.round(bpm * 10) / 10, source: "manual" });
  };
  return (
    <div className="fill tap-cell">
      <button className="fill tap" {...locked("commands:tempo")} onClick={() => void run("tempo.tap")}>
        {t.tap} <span className={`beat ${tempo && Math.floor(tempo.beats) % 2 === 0 ? "even" : ""}`} />
        {tempo?.clockMissing && <small className="warn"> ⚠</small>}
      </button>
      <input
        className="bpm"
        inputMode="decimal"
        aria-label={t.bpmByHand}
        title={`${t.bpmByHandHelp} (${t.tempoSourceNames[(tempo?.source ?? "manual") as keyof typeof t.tempoSourceNames] ?? tempo?.source})`}
        {...locked("commands:tempo")}
        value={bpmDraft ? bpmDraft.value : tempo ? tempo.bpm.toFixed(1) : ""}
        onFocus={(e) => (setBpmDraft({ value: tempo ? tempo.bpm.toFixed(1) : "", typed: false }), e.target.select())}
        onChange={(e) => setBpmDraft({ value: e.target.value, typed: true })}
        onBlur={(e) => setBpmByHand(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            bpmCancelled.current = true;
            e.currentTarget.blur();
          }
        }}
      />
      {/* Ableton plays but its clock is not followed (a tempo typed or tapped, the DJ): one press gives it the lead back */}
      {tempo && tempo.source !== "midi" && tempo.clock && (
        <button
          className="to-midi"
          {...locked("commands:tempo")}
          title={t.backToMidiHelp}
          aria-label={t.backToMidiHelp}
          onClick={() => {
            if (mic.on) microphone.stop();
            void run("tempo.set", { source: "midi" });
          }}
        >
          ↺<span className="word"> MIDI</span>
        </button>
      )}
      <button
        className={`mic ${mic.on ? (mic.following ? "on following" : "on") : ""}`}
        {...locked("commands:tempo")}
        aria-pressed={mic.on}
        aria-label={t.micListen}
        title={mic.on ? (mic.reading ? `${t.micHeard} ≈ ${mic.reading.bpm} BPM${mic.following ? "" : ` (${t.micUnsure})`}` : t.micListening) : mic.error ? t.micErrors[mic.error] : t.micHelp}
        onClick={toggleMic}
      >
        🎤{mic.on && mic.reading && <small> {Math.round(mic.reading.bpm)}</small>}
        {!mic.on && mic.error && <small className="warn"> ⚠</small>}
      </button>
    </div>
  );
}
