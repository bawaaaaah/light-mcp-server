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
type UsbKind = "open" | "pro";
interface Route {
  universe: number;
  artnet?: { portAddress: number };
  sacn?: { universe: number };
  usb?: { path: string; kind: UsbKind };
}
interface UsbPort {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  ftdi: boolean;
}
interface Output {
  standby: boolean;
  foreignSources: { ip: string; portAddresses: number[]; local?: boolean }[];
  merging: { ip: string; shortName: string; portAddresses: number[] }[];
  stats: { framesSent: number; packetsSent: number; errors: number; discovery: string; discoveryError?: string };
  config: { routes: Route[] };
  coverage?: { unheard: { universe: number; portAddress: number }[]; unfed: { key: string; ip: string; shortName: string; portAddress: number }[] };
  universes?: number;
  usb?: { available: boolean; error?: string; devices: { path: string; kind: UsbKind; open: boolean; framesSent: number; error?: string }[] };
}
/** A route's change: an output set, removed (null), or left as it is (absent). */
type RouteChange = { artnet?: number | null; sacn?: number | null; usb?: { path: string; kind: UsbKind } | null };

/** What a route sends, in words. */
function describeRoute(route: Route, kinds: Record<UsbKind, string>): string {
  return [route.artnet && `Art-Net ${route.artnet.portAddress}`, route.sacn && `sACN ${route.sacn.universe}`, route.usb && `DMX USB ${route.usb.path} (${kinds[route.usb.kind]})`].filter(Boolean).join(" · ");
}

/** One universe's outputs, each chosen by its box: an Art-Net address, an sACN universe, a DMX USB interface. */
function RouteRow({ route, editable, ports, onSave }: { route: Route; editable: boolean; ports: UsbPort[]; onSave: (change: RouteChange) => void }) {
  const t = useT();
  const initial = () => ({
    artnet: route.artnet ? String(route.artnet.portAddress) : "",
    sacn: route.sacn ? String(route.sacn.universe) : "",
    usb: route.usb ?? null,
  });
  const [state, setState] = useState(initial);
  useEffect(() => setState(initial()), [route.artnet?.portAddress, route.sacn?.universe, route.usb?.path, route.usb?.kind]);
  const before = initial();
  const changed = state.artnet !== before.artnet || state.sacn !== before.sacn || state.usb?.path !== before.usb?.path || state.usb?.kind !== before.usb?.kind;
  const label = `${t.universe} ${route.universe}`;
  if (!editable)
    return (
      <li>
        {label} → {describeRoute(route, t.usbKinds)}
        {!route.artnet && !route.sacn && !route.usb && <small className="hint">{t.routeNone}</small>}
      </li>
    );
  // the interface of the route stays listed while unplugged
  const choices = route.usb && !ports.some((p) => p.path === route.usb!.path) ? [...ports, { path: route.usb.path, ftdi: false, unplugged: true }] : ports;
  const firstPort = (ports.find((p) => p.ftdi) ?? ports[0])?.path;
  return (
    <li className="row route">
      <strong>{label}</strong> →
      <span className="out">
        <label>
          <input type="checkbox" checked={state.artnet !== ""} onChange={(e) => setState({ ...state, artnet: e.target.checked ? String(route.artnet?.portAddress ?? route.universe - 1) : "" })} /> Art-Net
        </label>
        {state.artnet !== "" && <input type="number" min={0} max={32767} aria-label={`${label} · Art-Net`} value={state.artnet} onChange={(e) => setState({ ...state, artnet: e.target.value })} />}
      </span>
      <span className="out">
        <label>
          <input type="checkbox" checked={state.sacn !== ""} onChange={(e) => setState({ ...state, sacn: e.target.checked ? String(route.sacn?.universe ?? route.universe) : "" })} /> sACN
        </label>
        {state.sacn !== "" && <input type="number" min={1} max={63999} aria-label={`${label} · sACN`} value={state.sacn} onChange={(e) => setState({ ...state, sacn: e.target.value })} />}
      </span>
      <span className="out">
        <label title={firstPort || state.usb ? undefined : t.usbNone}>
          <input type="checkbox" checked={state.usb !== null} disabled={!firstPort && !state.usb} onChange={(e) => setState({ ...state, usb: e.target.checked ? (route.usb ?? { path: firstPort!, kind: "open" }) : null })} /> DMX USB
        </label>
        {state.usb && (
          <>
            <select aria-label={`${label} · DMX USB`} value={state.usb.path} onChange={(e) => setState({ ...state, usb: { ...state.usb!, path: e.target.value } })}>
              {choices.map((p) => (
                <option key={p.path} value={p.path}>
                  {p.path}
                  {"unplugged" in p ? ` (${t.usbUnplugged})` : p.manufacturer ? ` · ${p.manufacturer}` : ""}
                </option>
              ))}
            </select>
            <select aria-label={`${label} · ${t.usbKind}`} value={state.usb.kind} onChange={(e) => setState({ ...state, usb: { ...state.usb!, kind: e.target.value as UsbKind } })}>
              <option value="open">{t.usbKinds.open}</option>
              <option value="pro">{t.usbKinds.pro}</option>
            </select>
          </>
        )}
      </span>
      {changed && (
        <button className="primary" onClick={() => onSave({ artnet: state.artnet === "" ? null : Number(state.artnet), sacn: state.sacn === "" ? null : Number(state.sacn), usb: state.usb })}>
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
  const [ports, setPorts] = useState<UsbPort[]>([]);
  const routing = can(role, "commands:output");

  const load = useCallback(() => {
    void cmd<Node[]>("nodes.list").then(setNodes).catch(() => undefined);
    void cmd<Output>("output.status").then(setOutput).catch(() => undefined);
    void cmd<Os2l>("os2l.status").then(setOs2l).catch(() => undefined);
  }, []);
  const loadPorts = useCallback(() => void cmd<{ ports: UsbPort[] }>("output.usb.list").then((r) => setPorts(r.ports)).catch(() => undefined), []);
  useEffect(() => {
    load();
    loadPorts();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [load, loadPorts]);
  // the light moves at once: asked first, unless nothing is sent (standby)
  const route = (universe: number, change: RouteChange) => {
    if (!output?.standby && !confirm(t.routeConfirm)) return;
    setError("");
    const { artnet, sacn, usb } = change;
    void cmd("output.route", {
      universe,
      ...(artnet === undefined ? {} : { artnet: artnet === null ? null : { portAddress: artnet } }),
      ...(sacn === undefined ? {} : { sacn: sacn === null ? null : { universe: sacn } }),
      ...(usb === undefined ? {} : { usb }),
    }).then(
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
          <h2>{t.routes}</h2>
          {routing && <p className="hint">{t.routeHelp}</p>}
          {error && <p className="error">{error}</p>}
          <ul className="routes">
            {routes.map((r) => (
              <RouteRow key={r.universe} route={r} editable={routing} ports={ports} onSave={(change) => route(r.universe, change)} />
            ))}
          </ul>
          {routing && nextUniverse !== undefined && (
            <button className="ghost" onClick={() => setAdded((a) => [...a, nextUniverse])}>
              {t.routeAdd} {nextUniverse}
            </button>
          )}
          {routing && (
            <button className="ghost" onClick={loadPorts}>
              {t.usbRefresh}
            </button>
          )}
          {output?.usb && !output.usb.available && output.config.routes.some((r) => r.usb) && <p className="warn">⚠ {t.usbOff} ({output.usb.error})</p>}
          {(output?.usb?.devices.length ?? 0) > 0 && (
            <>
              <h2>{t.usbTitle}</h2>
              <ul className="usb">
                {output!.usb!.devices.map((d) => (
                  <li key={d.path}>
                    <span className={`dot ${d.open ? "ok" : "idle"}`} /> {d.path} ({t.usbKinds[d.kind]}) · {d.open ? `${t.usbSending}${d.kind === "open" ? ` (${d.framesSent})` : ""}` : t.usbClosed}
                    {d.error && <small className="warn"> · {d.error}</small>}
                  </li>
                ))}
              </ul>
            </>
          )}
          {output?.coverage?.unheard.map((u) => (
            <p key={u.universe} className="warn">
              ⚠ {t.universe} {u.universe} → Art-Net {u.portAddress} : {t.unheard}
              {routing &&
                output.coverage!.unfed.map((p) => (
                  <button key={p.key + p.portAddress} onClick={() => route(u.universe, { artnet: p.portAddress })}>
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
