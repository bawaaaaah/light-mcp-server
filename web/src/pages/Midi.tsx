import { useEffect, useId, useState, useSyncExternalStore, type ReactElement } from "react";
import { cmd } from "../api";
import { useT } from "../i18n-context";
import { control } from "../ws";
import { plain } from "../util";
import { useTopic } from "../hooks/useTopic";
import { MappingEditor, newMapping, type LearntInput, type MappingDraft } from "../components/MappingEditor";
import { withInputType, type MidiType } from "../mappingActions";
import { Modal } from "../components/Modal";
import { quoted } from "../typography";
import { useColourPresets } from "../hooks/useColourPresets";
import { describeMonitor, type MonitorEntry } from "../midi-monitor";
import { relayOver } from "../web-midi-relay";
import { MidiBatcher } from "../midi-coalesce";

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
  /** What a wheel holding an action does when its input goes, by kind of input (commands/midi-commands.ts PortLossSchema). */
  portLoss?: Record<PortKind, "release" | "keep">;
}
type PortKind = "local" | "rtp" | "web";
const PORT_KINDS: readonly PortKind[] = ["local", "rtp", "web"];
/** A mapping as midi.mapping.list gives it: the stored mapping, every default filled in (midi/mapping.ts MappingSchema). */
type Mapping = MappingDraft;
/** An input heard by midi.learn. */
type HeardInput = LearntInput;

/** The mappings a heard input plays — the same rule as the server's mapper (port by substring, the DJ's port only its own). */
function playedBy(m: Mapping, heard: HeardInput): boolean {
  if (m.input.type !== heard.type || m.input.channel !== heard.channel) return false;
  if (heard.type !== "pitchbend" && m.input.number !== heard.number) return false; // a pitch bend has no number: the server mapper ignores it
  if (m.input.port && heard.port && !heard.port.toLowerCase().includes(m.input.port.toLowerCase())) return false;
  return heard.port !== "OS2L" || m.input.port?.toLowerCase() === "os2l";
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
            {t.rtpOurs} {quoted(t, status.profileConfig?.rtp.name ?? "")} · port {status.rtp.port}
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

/** A Web MIDI input's name on the server: the same in every browser (what midi.learn gives, one line in the status). */
const webMidiPort = (name: string) => `Web MIDI · ${name}`;

/** Web MIDI on or off, kept for this browser: the relay stops while the MIDI page is closed and starts again on its return. */
const WEB_MIDI_KEY = "webMidiOn";
const readWebMidi = (): boolean => {
  try {
    return localStorage.getItem(WEB_MIDI_KEY) === "1";
  } catch {
    return false;
  }
};
const keepWebMidi = (on: boolean): void => {
  try {
    localStorage.setItem(WEB_MIDI_KEY, on ? "1" : "0");
  } catch {
    // not kept: off again at the next visit
  }
};

/** Held by the one tab of this browser that relays its Web MIDI: the others wait for it (the same devices, twice). */
const WEB_MIDI_LOCK = "light-web-midi-relay";
/**
 * Web MIDI: the controllers plugged into this browser's device relay their messages to the server, over the live control
 * connection (`relayOver`), every input of the page in one batch per 15 ms window (`MidiBatcher`). One tab per browser
 * relays (a Web Lock): another waits, and says so.
 */
/** The hub's channel as `useSyncExternalStore` reads it: one subscription for every render. */
const subscribeLink = (fn: () => void) => control.onStatus(fn);
const linkState = () => control.state;

function useWebMidi(enabled: boolean): { inputs: string[]; error: string; waiting: boolean; paused: boolean; stopped: boolean } {
  const t = useT();
  const [inputs, setInputs] = useState<string[]>([]);
  /** A refusal said: cleared once a message is accepted again; shown beside the inputs, never instead of them. */
  const [error, setError] = useState("");
  const [waiting, setWaiting] = useState(false);
  /** A right missing: the relay stopped (more would only be refused), until Web MIDI is switched on again. */
  const [forbidden, setForbidden] = useState(false);
  // the link as the hub's channel says it: « reconnecting » only once it was up (not on the first connection)
  const link = useSyncExternalStore(subscribeLink, linkState);
  useEffect(() => {
    if (!enabled || forbidden) return;
    setError(""); // switched on (again): what was said before, a refusal included, is no longer news
    const nav = navigator as Navigator & { requestMIDIAccess?: () => Promise<MIDIAccess> };
    if (!nav.requestMIDIAccess) {
      setError(t.webMidiUnavailable);
      return;
    }
    let stopped = false;
    let access: MIDIAccess | undefined;
    // what answers once this relay has stopped (its inputs said gone on the way out) changes nothing said: the next one says its own
    const outcome = {
      ok: () => void (stopped || setError("")),
      refused: (why: string) => void (stopped || setError(`${t.webMidiRefused}${t.colon} ${why}`)),
      forbidden: () => {
        if (stopped) return;
        setError(t.webMidiForbidden); // the right is said there: the server's own words would say it twice
        setForbidden(true);
      },
    };
    /** The inputs relayed: one gone is said to the server, which releases what its wheels held (midi.web.closed). */
    let relayed: string[] = [];
    /** The whole page's inputs in one request per 15 ms window (midi-coalesce.ts); a batch dropped (429) is given back to it. */
    const batcher = new MidiBatcher(
      (batch, done) => relayOver(control, "midi.in", batch, { ...outcome, dropped: done.dropped }),
      (fn, ms) => setTimeout(fn, ms),
      (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    );
    const closed = (names: string[]) => {
      if (!names.length) return;
      batcher.flush(); // what waits goes first, a rest included: never lost behind the input's « closed »
      for (const name of names) relayOver(control, "midi.web.closed", { port: webMidiPort(name) }, outcome);
    };
    const bind = () => {
      if (!access) return;
      const names: string[] = [];
      access.inputs.forEach((input) => {
        if (input.state === "disconnected") return;
        const name = input.name ?? input.id;
        names.push(name);
        input.onmidimessage = (e) => {
          const data = e.data;
          if (!data || data.length === 0 || data[0] === 0xf8 || data[0] === 0xfe) return; // clock/active sensing stay local
          batcher.push(webMidiPort(name), Array.from(data).slice(0, 3));
        };
      });
      closed(relayed.filter((n) => !names.includes(n)));
      relayed = names;
      setInputs(names);
    };
    /** Ends the relay (its promise holds the lock, when there is one). */
    let release: () => void = () => undefined;
    /** Web MIDI refused (no device access): the lock is given back, and not asked for again. */
    let failed = false;
    const relay = () =>
      new Promise<void>((done) => {
        release = done;
        if (stopped) return done();
        setWaiting(false);
        void nav
          .requestMIDIAccess!()
          .then((a) => {
            if (stopped) return;
            access = a;
            a.onstatechange = bind;
            bind();
          })
          .catch((e: Error) => {
            failed = true;
            setError(e.message);
            done();
          });
      });
    const locks = (navigator as Navigator & { locks?: LockManager }).locks;
    if (locks) {
      // another tab relaying: this one waits (the lock comes to it when that tab closes or stops)
      void locks.request(WEB_MIDI_LOCK, { ifAvailable: true }, async (lock) => (lock ? relay() : setWaiting(true))).then(() => {
        if (!stopped && !access && !failed) void locks.request(WEB_MIDI_LOCK, relay);
      });
    } else void relay();
    return () => {
      stopped = true;
      setWaiting(false);
      access?.inputs.forEach((input) => (input.onmidimessage = null));
      if (access) access.onstatechange = null;
      closed(relayed); // relayed no more (Web MIDI off, the page left)
      release();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `t` only words the error: a language change must not close and reopen the MIDI access
  }, [enabled, forbidden]);
  // a right refused: tried again the next time it is switched on
  useEffect(() => {
    if (!enabled) setForbidden(false); // switched off: a right refused before may be there next time
  }, [enabled]);
  return { inputs, error, waiting, paused: enabled && !waiting && !forbidden && link === "reconnecting", stopped: enabled && forbidden };
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

export function MidiPage(): ReactElement {
  const t = useT();
  // the colour presets a mapping may name (T41): one deleted since is marked
  const { presets: colourPresets, loaded: colourLoaded } = useColourPresets();
  const colourIds = new Set(colourPresets.map((p) => p.id));
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
  /** Reverse search: the next note or CC played, and only the mappings it plays. */
  const [heard, setHeard] = useState<HeardInput | null>(null);
  const [listening, setListening] = useState(false);
  const [monitor, setMonitor] = useState<string[]>([]);
  const [now, setNow] = useState(Date.now());
  const [webMidi, setWebMidiState] = useState(readWebMidi);
  const setWebMidi = (on: boolean) => {
    keepWebMidi(on);
    setWebMidiState(on);
  };
  const portLossHelpId = useId();
  /** A port-loss choice on its way to the server: the lists wait for its answer. */
  const [portLossBusy, setPortLossBusy] = useState(false);
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
  // by channel, then notes, CCs, program changes and pitch bends, each in number order (not « note 29, note 3, note 30 »)
  /** « note 50 », « PC 3 », « pitch bend » (the channel's wheel: no number). */
  const inputName = (i: { type: MidiType; number: number }) => (i.type === "pitchbend" ? t.midiTypes.pitchbend : `${i.type === "programchange" ? "PC" : i.type} ${i.number}`);
  const TYPE_ORDER: Record<MidiType, number> = { note: 0, cc: 1, programchange: 2, pitchbend: 3 };
  const needle = mappingSearch.trim().toLowerCase();
  const shownMappings = [...mappings]
    .sort((a, b) => a.input.channel - b.input.channel || TYPE_ORDER[a.input.type] - TYPE_ORDER[b.input.type] || a.input.number - b.input.number || a.id.localeCompare(b.id))
    .filter((m) => !heard || playedBy(m, heard))
    .filter((m) => !needle || [`${m.input.type} ${m.input.number}`, inputName(m.input), m.label, m.on.command, plain(m.on.args.id)].some((x) => x.toLowerCase().includes(needle)));
  const loadMappings = () => void cmd<Mapping[]>("midi.mapping.list").then(setMappings).catch(() => undefined);
  const listen = () => {
    setListening(true);
    setError("");
    void cmd<{ input: HeardInput }>("midi.learn", { timeoutMs: 15000 })
      .then((r) => setHeard(r.input), (e: Error) => setError(e.message))
      .finally(() => setListening(false));
  };
  const heardText = (i: HeardInput) => (i.port === "OS2L" ? `DJ (OS2L) n° ${i.number}` : `${inputName(i)} · ch${i.channel}${i.port ? ` · ${i.port}` : ""}`);
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
      const line = e.monitor ? describeMonitor(e.monitor, t) : (e.error ?? e.warning);
      if (line) setMonitor((m) => [line, ...m].slice(0, 40));
    });
    return () => {
      clearInterval(timer);
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- subscribes once; `describe` only words the monitor lines, and a new closure each render must not re-subscribe or restart the polling
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
        {status && !status.localAvailable && <span className="warn">{t.localMidiMissing}{t.colon} {status.localError}</span>}
        {status?.rtp.enabled && !status.rtp.error && <span className="hint">RTP-MIDI{t.colon}{status.rtp.port} {status.rtp.peers.join(", ")}</span>}
        {status?.rtp.error && <span className="warn">{t.rtpUnavailable}{t.colon} {status.rtp.error}</span>}
        {status?.node && (
          <span className={status.node.max > 50 ? "warn" : "hint"} title={t.nodeDelay}>
            {t.nodeDelay}{t.colon} {status.node.p99} ms
            {status.node.worst && ` · ${t.nodeWorst}${t.colon} ${Math.round(status.node.worst.ms)} ms (${new Date(status.node.worst.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })})`}
          </span>
        )}
        <label className="row">
          <input type="checkbox" checked={webMidi} onChange={(e) => setWebMidi(e.target.checked)} /> {t.webMidi}
        </label>
        {webMidi && (
          <span className="hint" role="status">
            {web.stopped ? t.webMidiStopped : web.waiting ? t.webMidiWaiting : web.paused ? t.webMidiPaused : web.inputs.join(", ") || "—"}
          </span>
        )}
        {webMidi && web.error && (
          <span className="warn" role="alert">
            {web.error}
          </span>
        )}
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
              {tempo.source === "link" && link && ` · Link${t.colon} ${link.peers} ${t.linkPeers}${link.phase ? `, ${t.linkPhase}` : ""}${link.listening ? "" : ` (${t.linkDeaf})`}`}
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
        {/* a wheel holding an action when its input goes: released (by default) or kept, by kind of input */}
        {status?.portLoss && (
          <fieldset className="row" aria-describedby={portLossHelpId} aria-busy={portLossBusy}>
            <legend>{t.portLoss.title}</legend>
            {PORT_KINDS.map((kind) => (
              <label key={kind}>
                {t.portLoss.kinds[kind]}{" "}
                <select
                  value={status.portLoss![kind]}
                  disabled={portLossBusy}
                  onChange={(e) => {
                    setPortLossBusy(true);
                    void cmd("midi.portloss.set", { [kind]: e.target.value })
                      .then(() => cmd<Status>("midi.status").then(setStatus))
                      .catch((err: Error) => setError(err.message))
                      .finally(() => setPortLossBusy(false));
                  }}
                >
                  <option value="release">{t.portLoss.release}</option>
                  <option value="keep">{t.portLoss.keep}</option>
                </select>
              </label>
            ))}
            <small className="hint" id={portLossHelpId}>
              {t.portLoss.help}
            </small>
          </fieldset>
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
              ⚠ {t.ablesetUnmatched}{t.colon} {quoted(t, ableset.lastMatch.song)} · {quoted(t, ableset.lastMatch.section)}
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
          <pre className="monitor">{monitor.length ? monitor.join("\n") : <span className="hint">{t.monitorEmpty}</span>}</pre>
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
            <Modal className="narrow" label={editing.id ? `${t.editLook} · ${editing.label}` : t.newMapping}>
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
          <div className="row mapping-search">
            {mappings.length > 8 && (
              <input className="search" type="search" aria-label={t.searchMappings} placeholder={t.searchMappings} value={mappingSearch} onChange={(e) => setMappingSearch(e.target.value)} />
            )}
            {/* reverse search: play a pad or move a knob, see what it is mapped to */}
            <button className="ghost" title={t.whatPlaysHelp} onClick={listen} disabled={listening}>
              {listening ? t.learning : `🎹 ${t.whatPlays}`}
            </button>
          </div>
          {heard && (
            <p className="heard">
              <span className="chip">
                {t.heardInput}{t.colon} <strong>{heardText(heard)}</strong>{" "}
                <button className="ghost" aria-label={t.clearHeard} title={t.clearHeard} onClick={() => setHeard(null)}>
                  ✕
                </button>
              </span>
              {shownMappings.length === 0 && (
                <>
                  {" "}
                  <span className="hint">{t.heardUnmapped}</span>{" "}
                  <button className="ghost" onClick={() => {
                      const draft: MappingDraft = { ...newMapping(), input: { type: heard.type, channel: heard.channel, number: heard.number, port: heard.port === "OS2L" ? "OS2L" : undefined }, feedback: heard.port === "OS2L" ? "none" : heard.type === "cc" ? "cc" : "note" };
                      // a wheel: its rest threshold, no feedback
                      setEditing(heard.type === "pitchbend" ? withInputType(draft, "pitchbend", "look") : draft);
                    }}
                  >
                    + {t.mapHeard}
                  </button>
                </>
              )}
            </p>
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
                        {inputName(m.input)} <small>ch{m.input.channel}</small>
                      </>
                    )}
                  </td>
                  <td>{t.modes[m.mode as keyof typeof t.modes] ?? m.mode}</td>
                  <td>
                    {m.label || `${m.on.command} ${plain(m.on.args.id)}`}
                    {/* a colour preset deleted since (T41): the mapping applies nothing, said here as show.lint says it */}
                    {m.on.command === "colour.apply" && colourLoaded && typeof m.on.args.id === "string" && !colourIds.has(m.on.args.id) && <small className="warn"> ⚠ {t.colours.deletedMark}</small>}
                  </td>
                  <td>
                    <button className="ghost" aria-label={`${t.edit} ${m.label || m.id}`} onClick={() => setEditing(m)}>
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
