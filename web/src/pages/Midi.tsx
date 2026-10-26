import { useEffect, useState } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { control } from "../ws";
import { useTopic } from "../hooks/useTopic";
import { MappingEditor, newMapping, type MappingDraft } from "../components/MappingEditor";
import { Modal } from "../components/Modal";

interface Status {
  localAvailable: boolean;
  localError?: string;
  inputs: { name: string; watched: boolean; open: boolean; lastMessageAt?: number }[];
  outputs: string[];
  feedback?: string;
  rtp: { enabled: boolean; port: number; wanted?: number; peers: string[]; error?: string };
  /** How long Node keeps a message waiting, in ms (core/loop-delay.ts). */
  node?: { p50: number; p99: number; max: number; worst: { ms: number; at: number } | null };
  profile: string;
  profiles: string[];
  profileConfig?: { inputs: string[]; feedbackOutput?: string; clockOutput?: string; rtp: { enabled: boolean; port: number; name: string; advertise?: boolean; connect?: string[] } };
}
interface Mapping {
  id: string;
  label: string;
  input: { type: string; channel: number; number: number; port?: string };
  mode: string;
  on: { command: string; args: Record<string, unknown> };
}

interface MonitorEntry {
  port: string;
  msg: Record<string, unknown>;
  matched?: { id: string; label: string; mode: string }[];
  calls: { command: string; target: string; ok: boolean; error?: string }[];
  ms: number;
}
interface RtpSession {
  name: string;
  host: string;
  address: string;
  port: number;
  connected: boolean;
  kept: boolean;
  self: boolean;
  /** On this machine (its own network sessions). */
  local?: boolean;
}

/** The sessions by device (one address): a device may announce many (an interface, one per port). */
function byDevice(sessions: RtpSession[]): { key: string; host: string; address: string; local: boolean; sessions: RtpSession[] }[] {
  const groups = new Map<string, { key: string; host: string; address: string; local: boolean; sessions: RtpSession[] }>();
  for (const x of sessions) {
    const g = groups.get(x.address) ?? { key: x.address, host: x.host, address: x.address, local: Boolean(x.local), sessions: [] };
    g.sessions.push(x);
    groups.set(x.address, g);
  }
  // this machine first, then by name; inside, in port order (an interface's ports one after the other)
  return [...groups.values()].map((g) => ({ ...g, sessions: g.sessions.sort((a, b) => a.port - b.port) })).sort((a, b) => Number(b.local) - Number(a.local) || a.host.localeCompare(b.host));
}

/** The RTP-MIDI sessions of the network (Bonjour): joined, left, kept; one without Bonjour by its address. */
function RtpPanel({ status, onChange }: { status: Status; onChange: () => void }) {
  const t = useT();
  const [sessions, setSessions] = useState<RtpSession[] | null>(null);
  const [manual, setManual] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const look = () => void cmd<{ sessions: RtpSession[] }>("midi.rtp.sessions").then((r) => setSessions(r.sessions), () => undefined);
  useEffect(() => {
    look();
    const timer = setInterval(look, 10_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const act = (key: string, name: string, args: unknown) => {
    setBusy(key);
    setError("");
    void cmd(name, args)
      .then(() => (look(), onChange()), (e: Error) => setError(e.message))
      .finally(() => setBusy(""));
  };
  const others = (sessions ?? []).filter((x) => !x.self);
  const [address, port] = manual.trim().split(":");
  return (
    <section className="rtp">
      <h2>{t.rtpTitle}</h2>
      <p className="hint">{t.rtpHelp}</p>
      <p>
        {status.rtp.enabled ? (
          <>
            {t.rtpOurs} « {status.profileConfig?.rtp.name} » · port {status.rtp.port}
            {status.rtp.wanted !== undefined && <small className="hint"> · {t.rtpMoved.replace("{wanted}", String(status.rtp.wanted))}</small>}
          </>
        ) : (
          <span className="hint">{t.rtpOff}</span>
        )}
      </p>
      {sessions !== null && others.length === 0 && <p className="hint">{t.rtpNone}</p>}
      {byDevice(others).map((g) => {
        const rows = (
          <div className="rtp-sessions" role="list">
            {g.sessions.map((x) => (
              <div key={`${x.name}:${x.port}`} className="rtp-session" role="listitem">
                <span className={`dot ${x.connected ? "ok" : "idle"}`} />
                <span className="name">{x.name}</span>
                <small className="hint">:{x.port}</small>
                <button disabled={busy !== "" || !status.rtp.enabled} onClick={() => act(x.name, x.connected ? "midi.rtp.disconnect" : "midi.rtp.connect", { name: x.name })}>
                  {x.connected ? t.rtpDisconnect : t.rtpConnect}
                </button>
                <label>
                  <input type="checkbox" checked={x.kept} disabled={busy !== "" || !status.rtp.enabled} onChange={(e) => act(`${x.name}:keep`, e.target.checked ? "midi.rtp.connect" : "midi.rtp.keep", e.target.checked ? { name: x.name, keep: true } : { name: x.name, keep: false })} /> {t.rtpKeep}
                </label>
              </div>
            ))}
          </div>
        );
        const joined = g.sessions.filter((x) => x.connected).length;
        const head = (
          <>
            <strong>{g.local ? t.rtpThisMac : g.host}</strong> <small className="hint">{g.address}</small> <small className="hint">· {g.sessions.length} {t.rtpSessionCount}{joined ? ` · ${joined} ${t.rtpJoined}` : ""}</small>
          </>
        );
        // an interface announcing a session per port is folded, unless one of them is in use
        return g.sessions.length > 3 ? (
          <details key={g.key} className="rtp-device" open={g.sessions.some((x) => x.connected || x.kept)}>
            <summary>{head}</summary>
            {rows}
          </details>
        ) : (
          <div key={g.key} className="rtp-device">
            <div>{head}</div>
            {rows}
          </div>
        );
      })}
      <div className="row">
        <input aria-label={t.rtpManual} placeholder={t.rtpManual} value={manual} onChange={(e) => setManual(e.target.value)} />
        <button disabled={!address || !Number(port) || busy !== "" || !status.rtp.enabled} onClick={() => act("manual", "midi.rtp.connect", { address, port: Number(port) })}>
          {t.rtpConnect}
        </button>
        <button className="ghost" onClick={look}>
          {t.rtpLook}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  );
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
  // the Link session heard, while Link leads
  const [link, setLink] = useState<{ listening: boolean; peers: number; bpm?: number; phase?: boolean } | null>(null);
  const linkLeads = tempo?.source === "link";
  useEffect(() => {
    if (!linkLeads) return setLink(null);
    const load = () => void cmd<{ listening: boolean; peers: number; bpm?: number; phase?: boolean }>("link.status").then(setLink).catch(() => undefined);
    load();
    const timer = setInterval(load, 2000);
    return () => clearInterval(timer);
  }, [linkLeads]);
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
  /** A message and what it did: the mappings it matched, each command, and the time it took when long. */
  const describe = (e: MonitorEntry) => {
    const raw = `${e.port} · ${Object.values(e.msg).join(" ")}`;
    if (!e.matched?.length) return `${raw} · ${t.monitorUnmapped}`;
    const who = e.matched.map((x) => `${x.label || x.id} (${t.modesShort[x.mode as keyof typeof t.modesShort] ?? x.mode})`).join(", ");
    const did = e.calls.length ? e.calls.map((c) => `${c.command}${c.target ? ` ${c.target}` : ""} ${c.ok ? "✓" : `✗ ${c.error ?? ""}`}`).join(", ") : t.monitorNothing;
    return `${raw} → ${who} : ${did}${e.ms >= 20 ? ` · ${Math.round(e.ms)} ms` : ""}`;
  };

  useEffect(() => {
    const load = () => void cmd<Status>("midi.status").then(setStatus).catch(() => undefined);
    load();
    loadMappings();
    const timer = setInterval(() => {
      load();
      setNow(Date.now());
    }, 2000);
    const off = control.subscribe("light:midi", (d) => {
      const e = d as { monitor?: MonitorEntry; error?: string; warning?: string };
      const line = e.monitor ? describe(e.monitor) : (e.error ?? e.warning);
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
        {status?.node && (
          <span className={status.node.max > 50 ? "warn" : "hint"} title={t.nodeDelay}>
            {t.nodeDelay} : {status.node.p99} ms
            {status.node.worst && ` · ${t.nodeWorst} : ${Math.round(status.node.worst.ms)} ms (${new Date(status.node.worst.at).toLocaleTimeString().slice(0, 5)})`}
          </span>
        )}
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
              {(["midi", "manual", "os2l", "link"] as const).map((s) => (
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
              {tempo.source === "link" && link && ` · Link : ${link.peers} ${t.linkPeers}${link.phase ? `, ${t.linkPhase}` : ""}${link.listening ? "" : ` (${t.linkDeaf})`}`}
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
      {status && <RtpPanel status={status} onChange={() => void cmd<Status>("midi.status").then(setStatus)} />}
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
          <p className="hint">{t.monitorHelp}</p>
          <pre className="monitor">{monitor.join("\n")}</pre>
        </section>
        <section>
          <h2>
            {t.mappings} ({shownMappings.length === mappings.length ? mappings.length : `${shownMappings.length} / ${mappings.length}`}){" "}
            <button className="ghost" onClick={() => setEditing(newMapping())}>
              + {t.newMapping}
            </button>
          </h2>
          {/* the mapping management in a modal, like the looks' editors: the page behind stays put */}
          {editing && (
            <Modal label={editing.id ? `${t.editLook} · ${editing.label}` : t.newMapping}>
              <MappingEditor
                key={editing.id || "new-mapping"}
                initial={editing}
                existing={mappings.map((m) => m.id)}
                onClose={() => {
                  setEditing(null);
                  loadMappings();
                }}
              />
            </Modal>
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
