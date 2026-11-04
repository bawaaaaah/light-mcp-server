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
type ArtnetSend = "auto" | "broadcast" | "nodes";
/** Where a universe goes now (output.status). */
interface Destinations {
  universe: number;
  artnet?: string[];
  sacn?: string[];
}
interface Route {
  universe: number;
  artnet?: { portAddress: number; send?: ArtnetSend; targets?: string[]; broadcast?: boolean };
  sacn?: { universe: number; unicast?: string[] };
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
  destinations?: Destinations[];
  coverage?: { unheard: { universe: number; portAddress: number }[]; unfed: { key: string; ip: string; shortName: string; portAddress: number }[] };
  universes?: number;
  usb?: { available: boolean; error?: string; devices: { path: string; kind: UsbKind; open: boolean; framesSent: number; error?: string }[] };
}
/** A route's change: an output set, removed (null), or left as it is (absent). */
type RouteChange = { artnet?: { portAddress: number; send?: ArtnetSend; targets?: string[] } | null; sacn?: { universe: number; unicast?: string[] } | null; usb?: { path: string; kind: UsbKind } | null };

/** A node's output ports; an older server only gives their port-addresses. */
const nodePorts = (n: Node) => n.ports ?? n.outputAddresses.map((portAddress) => ({ portAddress, outputting: false, sacn: false, ltp: false, merging: false }));

/** How an Art-Net route is sent; a route saved before the choice goes to its targets when it has some. */
const artnetSendOf = (a: NonNullable<Route["artnet"]>): ArtnetSend => a.send ?? (a.targets?.length ? "nodes" : "auto");

/** The nodes by IP (a multi-port node answers once per bind index), then the chosen IPs no node answers from. */
function nodesByIp(nodes: Node[], chosen: string[]): { ip: string; name: string; ports: ReturnType<typeof nodePorts>; seen: boolean }[] {
  const out = new Map<string, { ip: string; name: string; ports: ReturnType<typeof nodePorts>; seen: boolean }>();
  for (const n of nodes) {
    const known = out.get(n.ip);
    if (known) known.ports.push(...nodePorts(n));
    else out.set(n.ip, { ip: n.ip, name: n.shortName, ports: [...nodePorts(n)], seen: true });
  }
  for (const ip of chosen) if (!out.has(ip)) out.set(ip, { ip, name: "", ports: [], seen: false });
  return [...out.values()];
}

/** What a route sends, in words. */
function describeRoute(route: Route, t: ReturnType<typeof useT>): string {
  return [route.artnet && `Art-Net ${route.artnet.portAddress} (${t.artnetSends[artnetSendOf(route.artnet)]})`, route.sacn && `sACN ${route.sacn.universe}${route.sacn.unicast?.length ? ` (${t.sacnSends.unicast})` : ""}`, route.usb && `DMX USB ${route.usb.path} (${t.usbKinds[route.usb.kind]})`].filter(Boolean).join(" · ");
}

/** Where a universe goes now, as the server sends it: the node IPs, the broadcast or multicast address. */
function SendingNow({ hosts }: { hosts?: string[] }) {
  const t = useT();
  if (!hosts) return null;
  return (
    <small className="sending-now">
      {t.sendingNow} {hosts.length ? hosts.join(", ") : t.routeNone}
    </small>
  );
}

/** One universe's outputs, each chosen by its box: an Art-Net address, an sACN universe, a DMX USB interface. */
function RouteRow({ route, editable, ports, nodes, sending, onSave }: { route: Route; editable: boolean; ports: UsbPort[]; nodes: Node[]; sending?: Destinations; onSave: (change: RouteChange) => void }) {
  const t = useT();
  const initial = () => ({
    artnet: route.artnet ? String(route.artnet.portAddress) : "",
    send: route.artnet ? artnetSendOf(route.artnet) : ("auto" as ArtnetSend),
    targets: route.artnet?.targets ?? [],
    sacn: route.sacn ? String(route.sacn.universe) : "",
    unicast: Boolean(route.sacn?.unicast?.length),
    sacnTargets: route.sacn?.unicast ?? [],
    usb: route.usb ?? null,
  });
  type State = ReturnType<typeof initial>;
  const [state, setState] = useState(initial);
  const key = JSON.stringify([route.artnet, route.sacn, route.usb]);
  useEffect(() => setState(initial()), [key]);
  // what Save sends; also what tells a change
  const change = (s: State): RouteChange => ({
    artnet: s.artnet === "" ? null : { portAddress: Number(s.artnet), send: s.send, targets: s.targets },
    sacn: s.sacn === "" ? null : { universe: Number(s.sacn), unicast: s.unicast ? s.sacnTargets : [] },
    usb: s.usb,
  });
  const changed = JSON.stringify(change(state)) !== JSON.stringify(change(initial()));
  const label = `${t.universe} ${route.universe}`;
  if (!editable)
    return (
      <li>
        {label} → {describeRoute(route, t)}
        {!route.artnet && !route.sacn && !route.usb && <small className="hint">{t.routeNone}</small>}
      </li>
    );
  const address = Number(state.artnet);
  const toggle = (list: string[], ip: string, on: boolean) => (on ? [...new Set([...list, ip])] : list.filter((x) => x !== ip));
  // « auto » lists the nodes it sends to, « nodes » every node to tick; « broadcast » goes to all of them
  const artnetNodes = nodesByIp(nodes, state.send === "nodes" ? state.targets : []).filter((n) => state.send === "nodes" || n.ports.some((p) => !p.sacn && p.portAddress === address));
  const sacnNodes = nodesByIp(nodes, state.sacnTargets).filter((n) => !n.seen || n.ports.some((p) => p.sacn));
  // the interface of the route stays listed while unplugged
  const choices = route.usb && !ports.some((p) => p.path === route.usb!.path) ? [...ports, { path: route.usb.path, ftdi: false, unplugged: true }] : ports;
  const firstPort = (ports.find((p) => p.ftdi) ?? ports[0])?.path;
  return (
    <li className="row route">
      <strong className="nowrap">{label}</strong> →
      <span className="out">
        <label>
          <input type="checkbox" checked={state.artnet !== ""} onChange={(e) => setState({ ...state, artnet: e.target.checked ? String(route.artnet?.portAddress ?? route.universe - 1) : "" })} /> Art-Net
        </label>
        {state.artnet !== "" && (
          <>
            <input type="number" min={0} max={32767} aria-label={`${label} · Art-Net`} value={state.artnet} onChange={(e) => setState({ ...state, artnet: e.target.value })} />
            <span className="send-choice" role="radiogroup" aria-label={`${label} · ${t.artnetSend}`}>
              {(["auto", "broadcast", "nodes"] as const).map((m) => (
                <label key={m}>
                  <input type="radio" name={`artnet-send-${route.universe}`} checked={state.send === m} onChange={() => setState({ ...state, send: m })} /> {t.artnetSends[m]}
                </label>
              ))}
            </span>
            <small className="hint send-help">{t.artnetSendHelp[state.send]}</small>
            {state.send !== "broadcast" && (
              <ul className="send-nodes">
                {artnetNodes.length === 0 && <li className="hint">{state.send === "nodes" ? t.noNodes : route.artnet?.broadcast === false ? t.artnetNoOutputQuiet : t.artnetNoOutput}</li>}
                {artnetNodes.map((n) => {
                  const outputs = n.ports.some((p) => !p.sacn && p.portAddress === address);
                  const live = sending?.artnet?.includes(n.ip);
                  const name = (
                    <>
                      <span className={`dot ${live ? "ok" : "idle"}`} title={live ? t.receivesNow : t.receivesNot} /> {n.name} {n.ip}
                    </>
                  );
                  return (
                    <li key={n.ip}>
                      {state.send === "nodes" ? (
                        <label>
                          <input type="checkbox" checked={state.targets.includes(n.ip)} onChange={(e) => setState({ ...state, targets: toggle(state.targets, n.ip, e.target.checked) })} />
                          {name}
                        </label>
                      ) : (
                        name
                      )}
                      {outputs ? <small className="hint"> · {t.outputsAddress} {address}</small> : n.seen && <small className="hint"> · {t.otherAddresses} {[...new Set(n.ports.filter((p) => !p.sacn).map((p) => p.portAddress))].join(", ") || "—"}</small>}
                      {!n.seen && <small className="warn"> · {t.nodeUnseen}</small>}
                    </li>
                  );
                })}
              </ul>
            )}
            <SendingNow hosts={sending?.artnet} />
          </>
        )}
      </span>
      <span className="out">
        <label>
          <input type="checkbox" checked={state.sacn !== ""} onChange={(e) => setState({ ...state, sacn: e.target.checked ? String(route.sacn?.universe ?? route.universe) : "" })} /> sACN
        </label>
        {state.sacn !== "" && (
          <>
            <input type="number" min={1} max={63999} aria-label={`${label} · sACN`} value={state.sacn} onChange={(e) => setState({ ...state, sacn: e.target.value })} />
            <span className="send-choice" role="radiogroup" aria-label={`${label} · ${t.artnetSend} sACN`}>
              {(["multicast", "unicast"] as const).map((m) => (
                <label key={m}>
                  <input type="radio" name={`sacn-send-${route.universe}`} checked={state.unicast === (m === "unicast")} onChange={() => setState({ ...state, unicast: m === "unicast" })} /> {t.sacnSends[m]}
                </label>
              ))}
            </span>
            {state.unicast && (
              <ul className="send-nodes">
                {sacnNodes.length === 0 && <li className="hint">{t.noSacnNodes}</li>}
                {sacnNodes.map((n) => (
                  <li key={n.ip}>
                    <label>
                      <input type="checkbox" checked={state.sacnTargets.includes(n.ip)} onChange={(e) => setState({ ...state, sacnTargets: toggle(state.sacnTargets, n.ip, e.target.checked) })} />
                      <span className={`dot ${sending?.sacn?.includes(n.ip) ? "ok" : "idle"}`} /> {n.name} {n.ip}
                    </label>
                    {!n.seen && <small className="warn"> · {t.nodeUnseen}</small>}
                  </li>
                ))}
              </ul>
            )}
            <SendingNow hosts={sending?.sacn} />
          </>
        )}
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
        <button className="primary" onClick={() => onSave(change(state))}>
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
      ...(artnet === undefined ? {} : { artnet }),
      ...(sacn === undefined ? {} : { sacn }),
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
              <RouteRow key={r.universe} route={r} editable={routing} ports={ports} nodes={nodes} sending={output?.destinations?.find((d) => d.universe === r.universe)} onSave={(change) => route(r.universe, change)} />
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
                  <button key={p.key + p.portAddress} onClick={() => route(u.universe, { artnet: { portAddress: p.portAddress } })}>
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
                  {nodePorts(n).map((p) => {
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
