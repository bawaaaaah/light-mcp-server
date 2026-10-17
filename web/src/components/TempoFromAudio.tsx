/**
 * « Tempo depuis un fichier audio » (docs/specs/presets-songs-notes.md): the browser decodes the
 * song's recording (whatever format it plays), mixed down to one channel at 22 050 Hz, its first
 * two minutes are analysed (audio/tempo.ts), and the BPM found is offered — with ×2 and ÷2, as a beat
 * heard twice too fast or too slow is the usual mistake. Nothing leaves the browser.
 */
import { useState } from "react";
import { useT } from "../App";
import { detectTempo, type TempoEstimate } from "../audio/tempo";

const RATE = 22050;
const MAX_SECONDS = 120;

export function TempoFromAudio({ onBpm }: { onBpm: (bpm: number) => void }) {
  const t = useT();
  const [state, setState] = useState<{ busy?: boolean; found?: TempoEstimate | null; error?: string }>({});
  const analyse = async (file: File) => {
    setState({ busy: true });
    try {
      const data = await file.arrayBuffer();
      const audio = await new OfflineAudioContext(1, 2, RATE).decodeAudioData(data);
      const length = Math.min(audio.length, MAX_SECONDS * audio.sampleRate);
      const mono = new Float32Array(length);
      for (let c = 0; c < audio.numberOfChannels; c++) {
        const ch = audio.getChannelData(c);
        for (let i = 0; i < length; i++) mono[i]! += ch[i]! / audio.numberOfChannels;
      }
      setState({ found: detectTempo(mono, audio.sampleRate) });
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
    </div>
  );
}
