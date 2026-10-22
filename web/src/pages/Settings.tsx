import { useCallback, useEffect, useState } from "react";
import { can, cmd, type Role } from "../api";
import { useT } from "../App";
import { UsersPanel } from "../components/UsersPanel";
import { RolesPanel } from "../components/RolesPanel";
import { ActivityPanel, OnlinePanel } from "../components/ActivityPanel";
import { jumpTo } from "../util";

interface Node {
  key: string;
  ip: string;
  shortName: string;
  longName: string;
  outputAddresses: number[];
  ports?: { portAddress: number; outputting: boolean; sacn: boolean; ltp: boolean; merging: boolean }[];
}
interface Os2l {
  enabled: boolean;
  port?: number;
  addresses: string[];
  clients: { address: string; since: number; beats: number; bpm?: number }[];
  log: { at: number; address: string; event: { evt: string; name?: string; state?: string; id?: number } }[];
}
interface Route {
  universe: number;
  artnet?: { portAddress: number };
  sacn?: { universe: number };
}
interface Output {
  standby: boolean;
  foreignSources: { ip: string; portAddresses: number[]; local?: boolean }[];
  merging: { ip: string; shortName: string; portAddresses: number[] }[];
  stats: { framesSent: number; packetsSent: number; errors: number; discovery: string; discoveryError?: string };
  config: { routes: Route[] };
  coverage?: { unheard: { universe: number; portAddress: number }[]; unfed: { key: string; ip: string; shortName: string; portAddress: number }[] };
  universes?: number;
}

/** One universe's route: an Art-Net address and an sACN universe, either left empty. */
function RouteRow({ route, editable, onSave }: { route: Route; editable: boolean; onSave: (artnet: number | null, sacn: number | null) => void }) {
  const t = useT();
  const [artnet, setArtnet] = useState(route.artnet ? String(route.artnet.portAddress) : "");
  const [sacn, setSacn] = useState(route.sacn ? String(route.sacn.universe) : "");
  useEffect(() => {
    setArtnet(route.artnet ? String(route.artnet.portAddress) : "");
    setSacn(route.sacn ? String(route.sacn.universe) : "");
  }, [route.artnet?.portAddress, route.sacn?.universe]);
  const changed = artnet !== (route.artnet ? String(route.artnet.portAddress) : "") || sacn !== (route.sacn ? String(route.sacn.universe) : "");
  const label = `${t.universe} ${route.universe}`;
  if (!editable)
    return (
      <li>
        {label} → {route.artnet ? `Art-Net ${route.artnet.portAddress}` : ""} {route.sacn ? `sACN ${route.sacn.universe}` : ""}
        {!route.artnet && !route.sacn && <small className="hint">{t.routeNone}</small>}
      </li>
    );
  return (
    <li className="row route">
      <strong>{label}</strong> →
      <label>
        Art-Net <input type="number" min={0} max={32767} placeholder="—" aria-label={`${label} · Art-Net`} value={artnet} onChange={(e) => setArtnet(e.target.value)} />
      </label>
      <label>
        sACN <input type="number" min={1} max={63999} placeholder="—" aria-label={`${label} · sACN`} value={sacn} onChange={(e) => setSacn(e.target.value)} />
      </label>
      {changed && (
        <button className="primary" onClick={() => onSave(artnet === "" ? null : Number(artnet), sacn === "" ? null : Number(sacn))}>
          {t.save}
        </button>
      )}
    </li>
  );
}

export function SettingsPage({ role }: { role: Role }) {
  const t = useT();
  const [nodes, setNodes] = useState<Node[]>([]);
  const [output, setOutput] = useState<Output | null>(null);
  const [os2l, setOs2l] = useState<Os2l | null>(null);
  const [error, setError] = useState("");
  const [added, setAdded] = useState<number[]>([]);
  const routing = can(role, "commands:output");

  const load = useCallback(() => {
    void cmd<Node[]>("nodes.list").then(setNodes).catch(() => undefined);
    void cmd<Output>("output.status").then(setOutput).catch(() => undefined);
    void cmd<Os2l>("os2l.status").then(setOs2l).catch(() => undefined);
  }, []);
  useEffect(() => {
    load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [load]);
  // the light moves at once: asked first, unless nothing is sent (standby)
  const route = (universe: number, artnet: number | null, sacn: number | null) => {
    if (!output?.standby && !confirm(t.routeConfirm)) return;
    setError("");
    void cmd("output.route", { universe, artnet: artnet === null ? null : { portAddress: artnet }, sacn: sacn === null ? null : { universe: sacn } }).then(
      () => (setAdded((a) => a.filter((u) => u !== universe)), load()),
      (e: Error) => setError(e.message),
    );
  };
  const routes = [...(output?.config.routes ?? []), ...added.filter((u) => !output?.config.routes.some((r) => r.universe === u)).map((universe) => ({ universe }))].sort((a, b) => a.universe - b.universe);
  const nextUniverse = Array.from({ length: output?.universes ?? 0 }, (_, i) => i + 1).find((u) => !routes.some((r) => r.universe === u));

  return (
    <div className="settings">
      <nav className="jump" aria-label={t.onThisPage}>
        <a href="#settings-output" onClick={(e) => jumpTo(e, "settings-output")}>{t.output}</a>
        <a href="#settings-users" onClick={(e) => jumpTo(e, "settings-users")}>{t.users}</a>
        {can(role, "auth:admin") && <a href="#settings-roles" onClick={(e) => jumpTo(e, "settings-roles")}>{t.roles}</a>}
        <a href="#settings-activity" onClick={(e) => jumpTo(e, "settings-activity")}>{t.activity}</a>
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
              {output.stats.framesSent} {t.outputStats.frames} · {output.stats.packetsSent} {t.outputStats.packets} · {output.stats.errors} {t.outputStats.errors} · {t.outputStats.discovery} {output.stats.discovery}
              {output.stats.discoveryError && <small className="warn"> ({output.stats.discoveryError})</small>}
            </p>
          )}
          <h3>{t.routes}</h3>
          {routing && <p className="hint">{t.routeHelp}</p>}
          {error && <p className="error">{error}</p>}
          <ul className="routes">
            {routes.map((r) => (
              <RouteRow key={r.universe} route={r} editable={routing} onSave={(a, s) => route(r.universe, a, s)} />
            ))}
          </ul>
          {routing && nextUniverse !== undefined && (
            <button className="ghost" onClick={() => setAdded((a) => [...a, nextUniverse])}>
              {t.routeAdd} {nextUniverse}
            </button>
          )}
          {output?.coverage?.unheard.map((u) => (
            <p key={u.universe} className="warn">
              ⚠ {t.universe} {u.universe} → Art-Net {u.portAddress} : {t.unheard}
              {routing &&
                output.coverage!.unfed.map((p) => (
                  <button key={p.key + p.portAddress} onClick={() => route(u.universe, p.portAddress, output.config.routes.find((r) => r.universe === u.universe)?.sacn?.universe ?? null)}>
                    → {p.shortName || p.ip} (Art-Net {p.portAddress})
                  </button>
                ))}
            </p>
          ))}
          <h2>{t.nodes}</h2>
          {nodes.length === 0 && <p className="hint">{t.noNodes}</p>}
          <ul className="nodes">
            {nodes.map((n) => (
              <li key={n.key}>
                <strong>{n.shortName}</strong> {n.ip} <small className="hint">{n.longName}</small>
                <ul>
                  {(n.ports ?? n.outputAddresses.map((portAddress) => ({ portAddress, outputting: false, sacn: false, ltp: false, merging: false }))).map((p) => {
                    const unfed = output?.coverage?.unfed.some((u) => u.key === n.key && u.portAddress === p.portAddress);
                    return (
                      <li key={p.portAddress}>
                        <span className={`dot ${p.outputting ? "ok" : "idle"}`} /> {p.sacn ? "sACN" : "Art-Net"} {p.portAddress} · {p.outputting ? t.portLive : t.portIdle}
                        {p.ltp && " · LTP"}
                        {unfed && <small className="hint"> · {t.unfed}</small>}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
          <button onClick={() => void cmd("nodes.discover")}>{t.discover}</button>
          <h2>{t.os2lTitle}</h2>
          <p className="hint">{t.os2lHelp}</p>
          {os2l && !os2l.enabled && <p className="hint">{t.os2lOff}</p>}
          {os2l?.enabled && (
            <div className="os2l">
              <p>
                {t.os2lAddress} : <code>{(os2l.addresses.length ? os2l.addresses : ["—"]).map((a) => `${a}:${os2l.port ?? "—"}`).join(" · ")}</code>
              </p>
              {os2l.clients.length === 0 && <p className="hint">{t.os2lNone}</p>}
              <ul>
                {os2l.clients.map((c) => (
                  <li key={`${c.address}-${c.since}`}>
                    <span className="dot ok" /> {c.address} · {c.bpm ? `${c.bpm.toFixed(1)} BPM` : "—"} · {c.beats} {t.os2lBeats}
                  </li>
                ))}
              </ul>
              {os2l.log.length > 0 && (
                <p className="hint">
                  {t.os2lLast} : {os2l.log.map((e) => (e.event.evt === "btn" ? `${e.event.name} (${e.event.state})` : `cmd ${e.event.id}`)).join(" · ")}
                </p>
              )}
            </div>
          )}
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
      <section id="settings-activity">
        <OnlinePanel />
        <ActivityPanel />
      </section>
    </div>
  );
}
