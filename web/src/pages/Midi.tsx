import { useEffect, useState } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { control } from "../ws";
import { useTopic } from "../hooks/useTopic";
import { MappingEditor, newMapping, type MappingDraft } from "../components/MappingEditor";

interface Status {
  localAvailable: boolean;
  localError?: string;
  inputs: { name: string; watched: boolean; open: boolean; lastMessageAt?: number }[];
  outputs: string[];
  feedback?: string;
  rtp: { enabled: boolean; port: number; peers: string[]; error?: string };
  profile: string;
  profiles: string[];
  profileConfig?: { inputs: string[]; feedbackOutput?: string; clockOutput?: string; rtp: { enabled: boolean; port: number; name: string } };
}
interface Mapping {
  id: string;
  label: string;
  input: { type: string; channel: number; number: number; port?: string };
  mode: string;
  on: { command: string; args: Record<string, unknown> };
}

/** Web MIDI: a controller plugged into this browser's device relays its messages to the server. */
function useWebMidi(enabled: boolean): { inputs: string[]; error: string } {
  const t = useT();
  const [inputs, setInputs] = useState<string[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!enabled) return;
    const nav = navigator as Navigator & { requestMIDIAccess?: () => Promise<MIDIAccess> };
    if (!nav.requestMIDIAccess) {
      setError(t.webMidiUnavailable);
      return;
    }
    let access: MIDIAccess | undefined;
    const bind = () => {
      if (!access) return;
      const names: string[] = [];
      access.inputs.forEach((input) => {
        names.push(input.name ?? input.id);
        input.onmidimessage = (e) => {
          const data = e.data;
          if (!data || data.length === 0 || data[0] === 0xf8 || data[0] === 0xfe) return; // clock/active sensing stay local
          void cmd("midi.in", { port: `Web MIDI · ${input.name ?? input.id}`, bytes: Array.from(data).slice(0, 3) }).catch(() => undefined);
        };
      });
      setInputs(names);
    };
    void nav
      .requestMIDIAccess()
      .then((a) => {
        access = a;
        a.onstatechange = bind;
        bind();
      })
      .catch((e: Error) => setError(e.message));
    return () => {
      access?.inputs.forEach((input) => (input.onmidimessage = null));
      if (access) access.onstatechange = null;
    };
  }, [enabled]);
  return { inputs, error };
}

interface AbleSetStatus {
  enabled: boolean;
  host: string;
  port: number;
  connected: boolean;
  song: string;
  section: string;
  playing: boolean;
  lastMatch?: { song: string; section: string; found: boolean };
}

export function MidiPage() {
  const t = useT();
  const tempo = useTopic<{ bpm: number; source: string; clock?: boolean } | null>("light:tempo", null);
  const [status, setStatus] = useState<Status | null>(null);
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [mappingSearch, setMappingSearch] = useState("");
  const [monitor, setMonitor] = useState<string[]>([]);
  const [now, setNow] = useState(Date.now());
  const [webMidi, setWebMidi] = useState(false);
  const [editing, setEditing] = useState<MappingDraft | null>(null);
  const [error, setError] = useState("");
  // AbleSet followed over OSC: its state every two seconds while this page is open
  const [ableset, setAbleset] = useState<AbleSetStatus | null>(null);
  useEffect(() => {
    const load = () => void cmd<AbleSetStatus>("ableset.status").then(setAbleset).catch(() => undefined);
    load();
    const timer = setInterval(load, 2000);
    return () => clearInterval(timer);
  }, []);
  const configureAbleSet = (patch: Partial<Pick<AbleSetStatus, "enabled" | "host">>) =>
    void cmd<AbleSetStatus>("ableset.configure", patch).then(setAbleset, (e: Error) => setError(e.message));
  // by channel, then notes, CCs and program changes, each in number order (not « note 29, note 3, note 30 »)
  const TYPE_ORDER: Record<string, number> = { note: 0, cc: 1, programchange: 2 };
  const needle = mappingSearch.trim().toLowerCase();
  const shownMappings = [...mappings]
    .sort((a, b) => a.input.channel - b.input.channel || (TYPE_ORDER[a.input.type] ?? 9) - (TYPE_ORDER[b.input.type] ?? 9) || a.input.number - b.input.number || a.id.localeCompare(b.id))
    .filter((m) => !needle || [`${m.input.type} ${m.input.number}`, m.label, m.on.command, String(m.on.args.id ?? "")].some((x) => x.toLowerCase().includes(needle)));
  const loadMappings = () => void cmd<Mapping[]>("midi.mapping.list").then(setMappings).catch(() => undefined);
  /** Watch or stop watching a port in the active profile (patterns match by substring). */
  const saveProfile = (patch: Partial<NonNullable<Status["profileConfig"]>>) => {
    if (!status?.profileConfig) return;
    void cmd("midi.profile.save", { name: status.profile, profile: { ...status.profileConfig, ...patch } })
      .then(() => cmd<Status>("midi.status").then(setStatus))
      .catch((e: Error) => setError(e.message));
  };
  const toggleWatch = (name: string, on: boolean) => {
    const inputs = status?.profileConfig?.inputs ?? [];
    saveProfile({ inputs: on ? [...inputs, name] : inputs.filter((p) => !name.toLowerCase().includes(p.toLowerCase())) });
  };
  const web = useWebMidi(webMidi);

  useEffect(() => {
    const load = () => void cmd<Status>("midi.status").then(setStatus).catch(() => undefined);
    load();
    loadMappings();
    const timer = setInterval(() => {
      load();
      setNow(Date.now());
    }, 2000);
    const off = control.subscribe("light:midi", (d) => {
      const e = d as { monitor?: { port: string; msg: Record<string, unknown> }; error?: string; warning?: string };
      const line = e.monitor ? `${e.monitor.port} · ${Object.values(e.monitor.msg).join(" ")}` : (e.error ?? e.warning);
      if (line) setMonitor((m) => [line, ...m].slice(0, 40));
    });
    return () => {
      clearInterval(timer);
      off();
    };
  }, []);

  return (
    <div className="midi">
      <section className="bar">
        <label>
          {t.profile}{" "}
          <select value={status?.profile ?? ""} onChange={(e) => void cmd("midi.profile.select", { name: e.target.value }).then(() => cmd<Status>("midi.status").then(setStatus))}>
            {status?.profiles.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
        {status && !status.localAvailable && <span className="warn">{t.localMidiMissing} : {status.localError}</span>}
        {status?.rtp.enabled && !status.rtp.error && <span className="hint">RTP-MIDI :{status.rtp.port} {status.rtp.peers.join(", ")}</span>}
        {status?.rtp.error && <span className="warn">{t.rtpUnavailable} : {status.rtp.error}</span>}
        <label className="row">
          <input type="checkbox" checked={webMidi} onChange={(e) => setWebMidi(e.target.checked)} /> {t.webMidi}
        </label>
        {webMidi && <span className="hint">{web.error || web.inputs.join(", ") || "—"}</span>}
        {status?.profileConfig && (
          <label>
            {t.feedbackOut}{" "}
            <select value={status.profileConfig.feedbackOutput ?? ""} onChange={(e) => saveProfile({ feedbackOutput: e.target.value || undefined })}>
              <option value="">—</option>
              {status.outputs.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          </label>
        )}
        {/* who leads the tempo: Ableton's clock, a tempo set by hand, the DJ; the microphone is switched from the Tap widget */}
        {tempo && (
          <label title={t.tempoSourceHelp}>
            {t.tempoSource}{" "}
            <select aria-label={t.tempoSource} value={tempo.source === "tap" ? "manual" : tempo.source} onChange={(e) => void cmd("tempo.set", { source: e.target.value }).catch((err: Error) => setError(err.message))}>
              {(["midi", "manual", "os2l"] as const).map((s) => (
                <option key={s} value={s}>
                  {t.tempoSourceNames[s]}
                </option>
              ))}
              {tempo.source === "audio" && (
                <option value="audio" disabled>
                  {t.tempoSourceNames.audio}
                </option>
              )}
            </select>{" "}
            <small className="hint">
              {tempo.bpm.toFixed(1)} BPM{tempo.clock ? ` · ${t.clockArriving}` : ""}
            </small>
          </label>
        )}
        {/* the light's tempo as MIDI clock, for Ableton or a drum machine set to follow it */}
        {status?.profileConfig && (
          <label title={t.clockOutHelp}>
            {t.clockOut}{" "}
            <select aria-label={t.clockOut} value={status.profileConfig.clockOutput ?? ""} onChange={(e) => saveProfile({ clockOutput: e.target.value || undefined })}>
              <option value="">—</option>
              {status.outputs.map((o) => (
                <option key={o}>{o}</option>
              ))}
              {status.rtp.enabled && <option value="rtp">RTP-MIDI</option>}
            </select>
          </label>
        )}
        {error && (
          <span className="error" onClick={() => setError("")}>
            {error}
          </span>
        )}
      </section>
      {ableset && (
        <section className="ableset">
          <h2>AbleSet</h2>
          <p className="hint">{t.ablesetHelp}</p>
          <div className="row">
            <label>
              <input type="checkbox" checked={ableset.enabled} onChange={(e) => configureAbleSet({ enabled: e.target.checked })} /> {t.ablesetFollow}
            </label>
            <label>
              {t.ablesetHost} <input aria-label={t.ablesetHost} defaultValue={ableset.host} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== ableset.host && configureAbleSet({ host: e.target.value.trim() })} />
            </label>
            {ableset.enabled && (
              <span className="hint">
                <span className={`dot ${ableset.connected ? "ok" : "idle"}`} /> {ableset.connected ? `${ableset.song || "—"} · ${ableset.section || "—"}${ableset.playing ? " ▶" : ""}` : t.ablesetAbsent}
              </span>
            )}
          </div>
          {ableset.enabled && ableset.lastMatch && !ableset.lastMatch.found && (
            <p className="warn">
              ⚠ {t.ablesetUnmatched} : « {ableset.lastMatch.song} » · « {ableset.lastMatch.section} »
            </p>
          )}
        </section>
      )}
      <div className="cols">
        <section>
          <h2>{t.inputs}</h2>
          {status?.inputs.length === 0 && <p className="hint">{t.noInputs}</p>}
          <ul className="inputs">
            {status?.inputs.map((i) => {
              const active = i.lastMessageAt !== undefined && now - i.lastMessageAt < 3000;
              return (
                <li key={i.name}>
                  <input type="checkbox" aria-label={`${t.watch} ${i.name}`} checked={i.watched} disabled={!status.profileConfig} onChange={(e) => toggleWatch(i.name, e.target.checked)} />{" "}
                  <span className={active ? "dot ok" : i.open ? "dot idle" : "dot ko"} /> {i.name}{" "}
                  <small>{i.watched ? `${t.watched}, ${active ? t.active : t.silent}` : ""}</small>
                </li>
              );
            })}
          </ul>
          <h2>{t.monitor}</h2>
          <pre className="monitor">{monitor.join("\n")}</pre>
        </section>
        <section>
          <h2>
            {t.mappings} ({shownMappings.length === mappings.length ? mappings.length : `${shownMappings.length} / ${mappings.length}`}){" "}
            <button className="ghost" onClick={() => setEditing(newMapping())}>
              + {t.newMapping}
            </button>
          </h2>
          {editing && (
            <MappingEditor
              key={editing.id || "new-mapping"}
              initial={editing}
              existing={mappings.map((m) => m.id)}
              onClose={() => {
                setEditing(null);
                loadMappings();
              }}
            />
          )}
          {mappings.length > 8 && (
            <input className="search" type="search" aria-label={t.searchMappings} placeholder={t.searchMappings} value={mappingSearch} onChange={(e) => setMappingSearch(e.target.value)} />
          )}
          <table>
            <tbody>
              {shownMappings.map((m) => (
                <tr key={m.id}>
                  <td>
                    {m.input.port === "OS2L" ? (
                      <>
                        DJ (OS2L) n° {m.input.number}
                      </>
                    ) : (
                      <>
                        {m.input.type} {m.input.number} <small>ch{m.input.channel}</small>
                      </>
                    )}
                  </td>
                  <td>{t.modes[m.mode as keyof typeof t.modes] ?? m.mode}</td>
                  <td>{m.label || `${m.on.command} ${String(m.on.args.id ?? "")}`}</td>
                  <td>
                    <button className="ghost" aria-label={`${t.edit} ${m.label || m.id}`} onClick={() => setEditing(m as unknown as MappingDraft)}>
                      ✎
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
