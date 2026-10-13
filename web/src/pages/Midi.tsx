import { useEffect, useState } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { control } from "../ws";

interface Status {
  localAvailable: boolean;
  localError?: string;
  inputs: { name: string; watched: boolean; open: boolean; lastMessageAt?: number }[];
  outputs: string[];
  feedback?: string;
  rtp: { enabled: boolean; port: number; peers: string[] };
  profile: string;
  profiles: string[];
}
interface Mapping {
  id: string;
  label: string;
  input: { type: string; channel: number; number: number };
  mode: string;
  on: { command: string; args: Record<string, unknown> };
}

export function MidiPage() {
  const t = useT();
  const [status, setStatus] = useState<Status | null>(null);
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [monitor, setMonitor] = useState<string[]>([]);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const load = () => void cmd<Status>("midi.status").then(setStatus).catch(() => undefined);
    load();
    void cmd<Mapping[]>("midi.mapping.list").then(setMappings).catch(() => undefined);
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
        {status?.rtp.enabled && <span className="hint">RTP-MIDI :{status.rtp.port} {status.rtp.peers.join(", ")}</span>}
      </section>
      <div className="cols">
        <section>
          <h2>{t.inputs}</h2>
          <ul className="inputs">
            {status?.inputs.map((i) => {
              const active = i.lastMessageAt !== undefined && now - i.lastMessageAt < 3000;
              return (
                <li key={i.name}>
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
            {t.mappings} ({mappings.length})
          </h2>
          <table>
            <tbody>
              {mappings.map((m) => (
                <tr key={m.id}>
                  <td>
                    {m.input.type} {m.input.number} <small>ch{m.input.channel}</small>
                  </td>
                  <td>{m.mode}</td>
                  <td>{m.label || `${m.on.command} ${String(m.on.args.id ?? "")}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
