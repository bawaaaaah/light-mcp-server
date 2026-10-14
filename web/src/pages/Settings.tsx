import { useEffect, useState } from "react";
import { cmd, getToken } from "../api";
import { useT } from "../App";

interface Role {
  id: string;
  name: string;
  rights: string[];
  pinHash?: string;
}
interface Node {
  ip: string;
  shortName: string;
  longName: string;
  outputAddresses: number[];
}
interface Output {
  standby: boolean;
  foreignSources: { ip: string; portAddresses: number[] }[];
  merging: { ip: string; shortName: string; portAddresses: number[] }[];
  stats: { framesSent: number; packetsSent: number; errors: number; discovery: string; discoveryError?: string };
  config: { routes: { universe: number; artnet?: { portAddress: number }; sacn?: { universe: number } }[] };
}

export function SettingsPage() {
  const t = useT();
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [pins, setPins] = useState<Record<string, string>>({});
  const [nodes, setNodes] = useState<Node[]>([]);
  const [output, setOutput] = useState<Output | null>(null);
  const [message, setMessage] = useState("");

  const loadRoles = () =>
    void fetch("/api/auth/roles", { headers: { authorization: `Bearer ${getToken()}` } })
      .then((r) => (r.ok ? (r.json() as Promise<Role[]>) : null))
      .then(setRoles);
  useEffect(() => {
    loadRoles();
    const load = () => {
      void cmd<Node[]>("nodes.list").then(setNodes).catch(() => undefined);
      void cmd<Output>("output.status").then(setOutput).catch(() => undefined);
    };
    load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, []);

  const setPin = async (id: string) => {
    const res = await fetch(`/api/auth/roles/${id}/pin`, { method: "PUT", headers: { authorization: `Bearer ${getToken()}`, "content-type": "application/json" }, body: JSON.stringify({ pin: pins[id] }) });
    setMessage(res.ok ? `✔ ${id}` : ((await res.json()) as { error: string }).error);
    setPins({ ...pins, [id]: "" });
    loadRoles();
  };

  return (
    <div className="settings">
      {message && <p className="hint">{message}</p>}
      <div className="cols">
        <section>
          <h2>{t.output}</h2>
          {output && (
            <div className="row standby-bar">
              {output.standby ? (
                <button className="primary" onClick={() => confirm(t.takeOverConfirm) && void cmd("output.standby", { on: false }).then(() => cmd<Output>("output.status").then(setOutput))}>
                  ▶ {t.takeOver}
                </button>
              ) : (
                <button onClick={() => confirm(t.standbyConfirm) && void cmd("output.standby", { on: true }).then(() => cmd<Output>("output.status").then(setOutput))}>⏸ {t.goStandby}</button>
              )}
              {output.standby && <span className="badge standby">{t.standby}</span>}
            </div>
          )}
          {output?.foreignSources.map((f) => (
            <p key={f.ip} className={output.standby ? "hint" : "error"}>
              {output.standby ? t.otherHolds : `⚠ ${t.otherSource} :`} {f.ip} (Art-Net {f.portAddresses.join(", ")})
            </p>
          ))}
          {output?.merging.map((n) => (
            <p key={n.ip} className="error">
              ⚠ {n.shortName || n.ip} {t.merging} (Art-Net {n.portAddresses.join(", ")})
            </p>
          ))}
          {output && (
            <p>
              {output.stats.framesSent} trames · {output.stats.packetsSent} paquets · {output.stats.errors} erreurs · découverte {output.stats.discovery}
              {output.stats.discoveryError && <small className="warn"> ({output.stats.discoveryError})</small>}
            </p>
          )}
          <ul>
            {output?.config.routes.map((r) => (
              <li key={r.universe}>
                {t.universe} {r.universe} → {r.artnet ? `Art-Net ${r.artnet.portAddress}` : ""} {r.sacn ? `sACN ${r.sacn.universe}` : ""}
              </li>
            ))}
          </ul>
          <h2>{t.nodes}</h2>
          {nodes.length === 0 && <p className="hint">{t.noNodes}</p>}
          <ul>
            {nodes.map((n) => (
              <li key={n.ip}>
                <strong>{n.shortName}</strong> {n.ip} <small>sorties {n.outputAddresses.join(", ")}</small>
              </li>
            ))}
          </ul>
          <button onClick={() => void cmd("nodes.discover")}>{t.discover}</button>
        </section>
        <section>
          <h2>{t.roles}</h2>
          {roles === null && <p className="hint">{t.adminOnly}</p>}
          <table>
            <tbody>
              {roles?.map((r) => (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td>{r.pinHash ? "PIN ✔" : "—"}</td>
                  <td>
                    <input type="password" inputMode="numeric" placeholder="PIN" value={pins[r.id] ?? ""} onChange={(e) => setPins({ ...pins, [r.id]: e.target.value })} />
                  </td>
                  <td>
                    <button disabled={!pins[r.id]} onClick={() => void setPin(r.id)}>
                      ✔
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
