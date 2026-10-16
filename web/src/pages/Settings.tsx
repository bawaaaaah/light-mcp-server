import { useEffect, useState } from "react";
import { can, cmd, type Role } from "../api";
import { useT } from "../App";
import { UsersPanel } from "../components/UsersPanel";
import { RolesPanel } from "../components/RolesPanel";
import { jumpTo } from "../util";

interface Node {
  ip: string;
  shortName: string;
  longName: string;
  outputAddresses: number[];
}
interface Output {
  standby: boolean;
  foreignSources: { ip: string; portAddresses: number[]; local?: boolean }[];
  merging: { ip: string; shortName: string; portAddresses: number[] }[];
  stats: { framesSent: number; packetsSent: number; errors: number; discovery: string; discoveryError?: string };
  config: { routes: { universe: number; artnet?: { portAddress: number }; sacn?: { universe: number } }[] };
}

export function SettingsPage({ role }: { role: Role }) {
  const t = useT();
  const [nodes, setNodes] = useState<Node[]>([]);
  const [output, setOutput] = useState<Output | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const load = () => {
      void cmd<Node[]>("nodes.list").then(setNodes).catch(() => undefined);
      void cmd<Output>("output.status").then(setOutput).catch(() => undefined);
    };
    load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="settings">
      {message && <p className="hint">{message}</p>}
      <nav className="jump" aria-label={t.onThisPage}>
        <a href="#settings-output" onClick={(e) => jumpTo(e, "settings-output")}>{t.output}</a>
        <a href="#settings-users" onClick={(e) => jumpTo(e, "settings-users")}>{t.users}</a>
        {can(role, "auth:admin") && <a href="#settings-roles" onClick={(e) => jumpTo(e, "settings-roles")}>{t.roles}</a>}
      </nav>
      <div className="cols" id="settings-output">
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
              {output.standby ? t.otherHolds : `⚠ ${t.otherSource} :`} {f.ip}
              {f.local ? ` (${t.thisMachine})` : ""} (Art-Net {f.portAddresses.join(", ")})
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
      </div>
      <section id="settings-users">
        <UsersPanel role={role} />
      </section>
      {can(role, "auth:admin") && (
        <section id="settings-roles">
          <RolesPanel />
        </section>
      )}
    </div>
  );
}
