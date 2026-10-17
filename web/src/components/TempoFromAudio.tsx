/**
 * « Tempo depuis un fichier audio » (docs/specs/presets-songs-notes.md): the browser decodes the
 * song's recording (whatever format it plays), mixed down to one channel at 22 050 Hz; its first
 * two minutes give the tempo (audio/tempo.ts), offered with ×2 and ÷2 — a beat heard twice too fast
 * or too slow is the usual mistake — and the whole song a draft of its sections in bars
 * (audio/sections.ts). Nothing leaves the browser.
 */
import { useState } from "react";
import { useT } from "../App";
import { detectTempo, type TempoEstimate } from "../audio/tempo";
import { detectSections } from "../audio/sections";

const RATE = 22050;
const MAX_SECONDS = 120;

export function TempoFromAudio({ onBpm, onSections, beatsPerBar }: { onBpm: (bpm: number) => void; onSections: (bars: number[]) => void; beatsPerBar: number }) {
  const t = useT();
  const [state, setState] = useState<{ busy?: boolean; found?: TempoEstimate | null; sections?: number[] | null; error?: string }>({});
  const analyse = async (file: File) => {
    setState({ busy: true });
    try {
      const data = await file.arrayBuffer();
      const audio = await new OfflineAudioContext(1, 2, RATE).decodeAudioData(data);
      const mono = new Float32Array(audio.length);
      for (let c = 0; c < audio.numberOfChannels; c++) {
        const ch = audio.getChannelData(c);
        for (let i = 0; i < audio.length; i++) mono[i]! += ch[i]! / audio.numberOfChannels;
      }
      const found = detectTempo(mono.subarray(0, Math.min(mono.length, MAX_SECONDS * audio.sampleRate)), audio.sampleRate);
      // the sections over the whole song, counted from its first beat
      const sections = found ? detectSections(mono, audio.sampleRate, found.bpm, found.firstBeat ?? 0, beatsPerBar) : null;
      setState({ found, sections });
    } catch (err) {
      setState({ error: (err as Error).message });
    }
  };
  const found = state.found;
  return (
    <div className="tempo-audio">
      <label className="row" title={t.tempoFromAudioHelp}>
        {t.tempoFromAudio} <input type="file" accept="audio/*" aria-label={t.tempoFromAudio} onChange={(e) => e.target.files?.[0] && void analyse(e.target.files[0])} />
      </label>
      {state.busy && <small className="hint">{t.tempoAnalysing}</small>}
      {state.error && <small className="error">{state.error}</small>}
      {found === null && <small className="hint">{t.tempoNone}</small>}
      {found && (
        <span className="row">
          <strong>≈ {found.bpm} BPM</strong>
          <small className="hint">{found.confidence >= 0.6 ? t.tempoSure : t.tempoUnsure}</small>
          <button onClick={() => onBpm(found.bpm)}>{t.tempoUse}</button>
          <button className="ghost" onClick={() => onBpm(Math.round(found.bpm * 20) / 10)}>×2</button>
          <button className="ghost" onClick={() => onBpm(Math.round(found.bpm * 5) / 10)}>÷2</button>
        </span>
      )}
      {found && state.sections && state.sections.length > 1 && (
        <span className="row" title={t.sectionsFromAudioHelp}>
          <small>
            {t.sectionsFromAudio} : {state.sections.join(" + ")} {t.bars.toLowerCase()}
          </small>
          <button onClick={() => onSections(state.sections!)}>{t.sectionsUse}</button>
        </span>
      )}
    </div>
  );
}
