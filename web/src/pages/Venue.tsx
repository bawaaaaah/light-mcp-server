import { useCallback, useEffect, useMemo, useState } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { useCommandEvents } from "../hooks/useTopic";
import { jumpTo, labelOf, slug, uniqueId } from "../util";
import { StagePlan, type PlanZone } from "../components/StagePlan";
import { Calibration } from "../components/Calibration";
import { RulesPanel } from "../components/RulesPanel";
import { FixtureMenu } from "../components/FixtureMenu";
import { ZoneMenu } from "../components/ZoneMenu";
import { rectPolygon } from "../zone-shape";
import { useContextMenu } from "../components/menu";

interface Def {
  manufacturer: string;
  model: string;
  type: string;
  modes: { name: string; channels: number; heads: number }[];
}
interface Fixture {
  id: string;
  name: string;
  manufacturer: string;
  model: string;
  mode: string;
  universe: number;
  address: number;
  role?: string;
  target?: string;
  mount?: string;
  position?: { x: number; y: number; z: number };
  color?: string;
}
interface Canvas {
  id: string;
  name: string;
  topology: string;
  cells: number;
}
type Zone = PlanZone;

export function VenuePage() {
  const t = useT();
  const [library, setLibrary] = useState<Def[]>([]);
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [canvases, setCanvases] = useState<Canvas[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState({ name: "", def: "", mode: "", universe: 1, address: 1, role: "" });
  const [canvasDraft, setCanvasDraft] = useState({ name: "", topology: "line", fixtures: [] as string[] });
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  /** The zone whose right-click menu is open, and where. */
  const [zoneMenu, setZoneMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const rowMenu = useContextMenu<string>((at, id) => setMenu({ id, ...at }));
  /** « Placer la sélection »: the checked fixtures, in the order they were checked, along a zone edge. */
  const [arrangeDraft, setArrangeDraft] = useState({ zone: "", edge: "front", height: "", facing: "" });
  /** A rectangular zone: width × depth, centred on x, its front edge at y (metres; x towards cour, y upstage). */
  const [zoneDraft, setZoneDraft] = useState({ name: "", type: "stage", width: "", depth: "", x: "0", y: "0", floor: "0", protected: false, noAim: false });
  const addZone = () => {
    const [w, d, x, y] = [Number(zoneDraft.width), Number(zoneDraft.depth), Number(zoneDraft.x) || 0, Number(zoneDraft.y) || 0];
    const polygon = rectPolygon(w, d, x, y);
    const zone = { id: uniqueId(slug(zoneDraft.name, "zone"), zones.map((z) => z.id)), name: zoneDraft.name, type: zoneDraft.type, polygon, floorHeight: Number(zoneDraft.floor) || 0, protected: zoneDraft.protected, noAim: zoneDraft.noAim };
    void run("stage.zone.put", { zone }).then(() => (setZoneDraft({ ...zoneDraft, name: "" }), refresh()));
  };
  const size = (z: Zone) => {
    const xs = z.polygon.map((p) => p[0]);
    const ys = z.polygon.map((p) => p[1]);
    const m = (v: number) => Math.round(v * 10) / 10;
    return `${m(Math.max(...xs) - Math.min(...xs))} × ${m(Math.max(...ys) - Math.min(...ys))} m${z.floorHeight ? `, ${t.floorAt} ${z.floorHeight} m` : ""}`;
  };
  const [error, setError] = useState("");
  /** The show's looks, for those allowed into a zone closed to moving heads. */
  const [lookNames, setLookNames] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => void cmd<{ id: string; name: string }[]>("look.list").then(setLookNames, () => undefined), []);
  /** Fixtures sharing DMX channels (venue.patch.check), by fixture id: the others' messages. */
  const [overlaps, setOverlaps] = useState<Record<string, string[]>>({});
  /** Fixtures whose .qxf is not in the library (their channels are not decoded). */
  const [undefinedFixtures, setUndefinedFixtures] = useState<Set<string>>(new Set());

  const refresh = useCallback(() => {
    void cmd<Fixture[]>("venue.fixture.list").then(setFixtures).catch((e: Error) => setError(e.message));
    void cmd<{ overlaps: { a: string; b: string; message: string }[]; missingDefinitions: { id: string }[] }>("venue.patch.check")
      .then(({ overlaps: list, missingDefinitions }) => {
        setUndefinedFixtures(new Set(missingDefinitions.map((m) => m.id)));
        const by: Record<string, string[]> = {};
        for (const o of list) for (const id of [o.a, o.b]) (by[id] ??= []).push(o.message);
        setOverlaps(by);
      })
      .catch(() => undefined);
    void cmd<Canvas[]>("venue.canvas.list").then(setCanvases).catch(() => undefined);
    void cmd<Zone[]>("stage.zone.list").then(setZones).catch(() => undefined);
  }, []);
  useEffect(() => {
    refresh();
    void cmd<Def[]>("venue.library").then(setLibrary).catch(() => undefined);
  }, [refresh]);
  useCommandEvents(["venue.", "stage.", "import."], refresh);
  const run = (name: string, args: unknown) => cmd(name, args).catch((e: Error) => setError(e.message));

  const shown = useMemo(() => library.filter((d) => `${d.manufacturer} ${d.model}`.toLowerCase().includes(search.toLowerCase())).slice(0, 50), [library, search]);
  const def = library.find((d) => `${d.manufacturer}|${d.model}` === draft.def);
  const nextAddress = (universe: number) => {
    const used = fixtures.filter((f) => f.universe === universe);
    return used.reduce((m, f) => Math.max(m, f.address + (library.find((d) => d.model === f.model)?.modes.find((x) => x.name === f.mode)?.channels ?? 1)), 1);
  };

  return (
    <div className="venue">
      {error && (
        <p className="error" onClick={() => setError("")}>
          {error}
        </p>
      )}
      <nav className="jump" aria-label={t.onThisPage}>
        <a href="#venue-patch" onClick={(e) => jumpTo(e, "venue-patch")}>{t.patch}</a>
        <a href="#venue-stage" onClick={(e) => jumpTo(e, "venue-stage")}>{t.stagePreview}</a>
        <a href="#venue-rules" onClick={(e) => jumpTo(e, "venue-rules")}>{t.rulesTitle}</a>
      </nav>
      <div className="cols" id="venue-patch">
        <section>
          <h2>{t.patch} ({fixtures.length})</h2>
          {fixtures.length === 0 && <p className="hint">{t.noPatchYet}</p>}
          <table>
            <tbody>
              {[...fixtures]
                .sort((a, b) => a.universe - b.universe || a.address - b.address || a.name.localeCompare(b.name)) /* as on a console: by address */
                .map((f) => (
                <tr key={f.id} className={overlaps[f.id] ? "conflict" : undefined} title={t.fixtureMenuHint} {...rowMenu(f.id)}>
                  <td>
                    <input type="checkbox" checked={canvasDraft.fixtures.includes(f.id)} onChange={(e) => setCanvasDraft((c) => ({ ...c, fixtures: e.target.checked ? [...c.fixtures, f.id] : c.fixtures.filter((x) => x !== f.id) }))} />
                  </td>
                  <td>
                    {f.color && <span className="swatch-dot" style={{ background: f.color }} aria-hidden />}
                    {f.name}
                  </td>
                  <td>
                    <small>
                      {f.manufacturer} {f.model} · {f.mode}
                    </small>
                    {undefinedFixtures.has(f.id) && (
                      <span className="badge conflict" title={t.noDefinitionHelp}>
                        {" "}
                        {t.noDefinition}
                      </span>
                    )}
                  </td>
                  <td className="nowrap" title={overlaps[f.id]?.join("\n")}>
                    U{f.universe}.{f.address}
                    {overlaps[f.id] && <span className="badge conflict"> ⚠ {t.overlapBadge}</span>}
                  </td>
                  <td>{f.role}</td>
                  <td>
                    <button className="ghost" title={t.delete} onClick={() => void run("venue.fixture.delete", { id: f.id }).then((r) => {
                        const usedBy = (r as { usedBy?: string[] } | undefined)?.usedBy ?? [];
                        if (usedBy.length) setError(`${f.name} : ${t.stillUsedBy} ${usedBy.join(", ")}`);
                      })}>
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {menu &&
            (() => {
              const f = fixtures.find((x) => x.id === menu.id);
              return f ? <FixtureMenu key={f.id} fixture={f} at={menu} onSaved={refresh} onClose={() => setMenu(null)} /> : null;
            })()}
          <div className="editor">
            <input placeholder={t.name} value={canvasDraft.name} onChange={(e) => setCanvasDraft({ ...canvasDraft, name: e.target.value })} />
            <select value={canvasDraft.topology} onChange={(e) => setCanvasDraft({ ...canvasDraft, topology: e.target.value })}>
              {(["line", "line-mirror", "ring"] as const).map((k) => (
                <option key={k} value={k}>
                  {t.topologies[k]}
                </option>
              ))}
            </select>
            <button
              disabled={!canvasDraft.name || canvasDraft.fixtures.length === 0}
              onClick={() => void run("venue.canvas.auto", { id: slug(canvasDraft.name), name: canvasDraft.name, topology: canvasDraft.topology, fixtures: canvasDraft.fixtures })}
            >
              {t.makeCanvas} ({canvasDraft.fixtures.length})
            </button>
          </div>
          {zones.length > 0 && (
            <div className="editor arrange" title={t.arrangeHelp}>
              <span className="hint">{t.arrangeTitle}</span>
              <select aria-label={t.zones} value={arrangeDraft.zone} onChange={(e) => setArrangeDraft({ ...arrangeDraft, zone: e.target.value })}>
                <option value="">{t.zones}…</option>
                {zones.map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.name}
                  </option>
                ))}
              </select>
              <select aria-label={t.arrangeEdge} value={arrangeDraft.edge} onChange={(e) => setArrangeDraft({ ...arrangeDraft, edge: e.target.value })}>
                {(["front", "back", "houseLeft", "houseRight", "middle"] as const).map((k) => (
                  <option key={k} value={k}>
                    {t.edges[k]}
                  </option>
                ))}
              </select>
              <input type="number" min={0} max={30} step={0.1} aria-label={t.arrangeHeight} placeholder={t.arrangeHeight} value={arrangeDraft.height} onChange={(e) => setArrangeDraft({ ...arrangeDraft, height: e.target.value })} />
              <select aria-label={t.facingLabel} value={arrangeDraft.facing} onChange={(e) => setArrangeDraft({ ...arrangeDraft, facing: e.target.value })}>
                <option value="">{t.facingKeep}</option>
                {(["audience", "upstage", "houseLeft", "houseRight", "ceiling", "floor"] as const).map((k) => (
                  <option key={k} value={k}>
                    {t.facingLabel} : {t.facings[k]}
                  </option>
                ))}
              </select>
              <button
                disabled={!arrangeDraft.zone || canvasDraft.fixtures.length === 0}
                onClick={() =>
                  void run("venue.fixture.arrange", {
                    fixtures: canvasDraft.fixtures,
                    zone: arrangeDraft.zone,
                    edge: arrangeDraft.edge,
                    ...(arrangeDraft.height !== "" ? { height: Number(arrangeDraft.height) } : {}),
                    ...(arrangeDraft.facing ? { facing: arrangeDraft.facing } : {}),
                  }).then(refresh)
                }
              >
                {t.arrange} ({canvasDraft.fixtures.length})
              </button>
            </div>
          )}
          <h2>{t.canvases}</h2>
          <ul>
            {canvases.map((c) => (
              <li key={c.id}>
                {c.name} <small>({labelOf(t.topologies, c.topology)}, {c.cells})</small>
              </li>
            ))}
          </ul>
          <h2>{t.zones}</h2>
          <ul>
            {zones.map((z) => (
              <li key={z.id}>
                {z.name} <small>({labelOf(t.zoneTypes, z.type)} · {size(z)})</small> {z.protected ? <span className="badge conflict">{t.protectedZone}</span> : ""}{" "}
                <label className="inline" title={t.noAimHelp}>
                  <input type="checkbox" checked={Boolean(z.noAim)} onChange={(e) => void run("stage.zone.put", { zone: { ...z, noAim: e.target.checked } }).then(refresh)} /> {t.noAimZone}
                </label>
                {z.noAim && (
                  <span className="allow-looks" title={t.allowLooksHelp}>
                    {" "}
                    {t.allowLooks}
                    {(z.allowLooks ?? []).map((id) => (
                      <button key={id} className="ghost chip" aria-label={`${t.delete} ${id}`} onClick={() => void run("stage.zone.put", { zone: { ...z, allowLooks: (z.allowLooks ?? []).filter((x) => x !== id) } }).then(refresh)}>
                        {lookNames.find((l) => l.id === id)?.name ?? id} ✕
                      </button>
                    ))}
                    <select aria-label={`${t.allowLooks} ${z.name}`} value="" onChange={(e) => e.target.value && void run("stage.zone.put", { zone: { ...z, allowLooks: [...(z.allowLooks ?? []), e.target.value] } }).then(refresh)}>
                      <option value="">+</option>
                      {lookNames
                        .filter((l) => !(z.allowLooks ?? []).includes(l.id))
                        .map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.name}
                          </option>
                        ))}
                    </select>
                  </span>
                )}
                <button className="ghost" title={`${t.delete} ${z.name}`} aria-label={`${t.delete} ${z.name}`} onClick={() => confirm(`${t.delete} « ${z.name} » ?`) && void run("stage.zone.delete", { id: z.id }).then(refresh)}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
          <div className="editor zone-editor" title={t.zoneHelp}>
            <input placeholder={t.name} aria-label={t.zoneName} value={zoneDraft.name} onChange={(e) => setZoneDraft({ ...zoneDraft, name: e.target.value })} />
            <select aria-label={t.zoneType} value={zoneDraft.type} onChange={(e) => setZoneDraft({ ...zoneDraft, type: e.target.value })}>
              {Object.entries(t.zoneTypes).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            {(
              [
                ["width", t.zoneWidth],
                ["depth", t.zoneDepth],
                ["x", t.zoneCentreX],
                ["y", t.zoneFrontY],
                ["floor", t.zoneFloor],
              ] as const
            ).map(([k, label]) => (
              <label key={k} className="field">
                <span>{label}</span>
                <input type="number" step={0.1} aria-label={label} value={zoneDraft[k]} onChange={(e) => setZoneDraft({ ...zoneDraft, [k]: e.target.value })} />
              </label>
            ))}
            <label className="row">
              <input type="checkbox" checked={zoneDraft.protected} onChange={(e) => setZoneDraft({ ...zoneDraft, protected: e.target.checked })} /> {t.protectedZone}
            </label>
            <label className="row" title={t.noAimHelp}>
              <input type="checkbox" checked={zoneDraft.noAim} onChange={(e) => setZoneDraft({ ...zoneDraft, noAim: e.target.checked })} /> {t.noAimZone}
            </label>
            <button disabled={!zoneDraft.name || !(Number(zoneDraft.width) > 0) || !(Number(zoneDraft.depth) > 0)} onClick={addZone}>
              + {t.addZone}
            </button>
          </div>
        </section>
        <section>
          <h2>{t.library} ({library.length})</h2>
          <input className="search" placeholder={t.search} value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="editor">
            <select value={draft.def} onChange={(e) => setDraft({ ...draft, def: e.target.value, mode: "" })}>
              <option value="">—</option>
              {shown.map((d) => (
                <option key={`${d.manufacturer}|${d.model}`} value={`${d.manufacturer}|${d.model}`}>
                  {d.manufacturer} {d.model}
                </option>
              ))}
            </select>
            <select value={draft.mode} onChange={(e) => setDraft({ ...draft, mode: e.target.value })}>
              <option value="">{t.mode}</option>
              {def?.modes.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name} ({m.channels} ch{m.heads ? `, ${m.heads} ${t.headCount}` : ""})
                </option>
              ))}
            </select>
            <input placeholder={t.name} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            <label className="inline">
              U
              <input type="number" min={1} max={16} value={draft.universe} onChange={(e) => setDraft({ ...draft, universe: Number(e.target.value) })} title={t.universe} />
            </label>
            <label className="inline">
              @
              <input type="number" min={1} max={512} value={draft.address} onChange={(e) => setDraft({ ...draft, address: Number(e.target.value) })} title={t.address} />
            </label>
            <button className="ghost" title={t.firstFreeAddress} onClick={() => setDraft({ ...draft, address: nextAddress(draft.universe) })}>
              {t.auto}
            </button>
            <input placeholder={t.rolePlaceholder} value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value })} />
            <button
              className="primary"
              disabled={!def || !draft.mode || !draft.name}
              onClick={() =>
                void run("venue.fixture.put", {
                  fixture: { id: slug(draft.name), name: draft.name, manufacturer: def!.manufacturer, model: def!.model, mode: draft.mode, universe: draft.universe, address: draft.address, ...(draft.role ? { role: draft.role } : {}) },
                }).then((r) => {
                  setDraft({ ...draft, name: "" });
                  const warning = (r as { warning?: string } | undefined)?.warning;
                  if (warning) setError(warning); // patched, but said: channels already used, definition missing…
                })
              }
            >
              {t.patchIt}
            </button>
          </div>
        </section>
      </div>
      <section id="venue-stage">
        <h2>{t.stagePreview}</h2>
        <StagePlan
          fixtures={fixtures}
          zones={zones}
          onError={setError}
          onMove={(moves) =>
            void (async () => {
              for (const { fixture, position } of moves) await run("venue.fixture.put", { fixture: { ...fixture, position } });
              refresh();
            })()
          }
          onOrient={(f, change) => void run("venue.fixture.orient", { id: f.id, ...change }).then(refresh)}
          onZoneMenu={(z, at) => setZoneMenu({ id: z.id, ...at })}
          onZoneMove={(z, polygon) => void run("stage.zone.put", { zone: { ...z, polygon } }).then(refresh)}
        />
        <p className="hint">{t.zoneHint}</p>
        {zoneMenu &&
          (() => {
            const z = zones.find((x) => x.id === zoneMenu.id);
            return z ? (
              <ZoneMenu
                key={z.id}
                zone={z}
                at={zoneMenu}
                onSave={(zone) => void run("stage.zone.put", { zone }).then(refresh)}
                onDelete={() => void run("stage.zone.delete", { id: z.id }).then(refresh)}
                onClose={() => setZoneMenu(null)}
              />
            ) : null;
          })()}
        <details className="calibration-box">
          <summary>{t.calibrationTitle}</summary>
          <Calibration zones={zones} placed={new Set(fixtures.filter((f) => f.position).map((f) => f.id))} onError={setError} onApplied={refresh} />
        </details>
      </section>
      <section id="venue-rules">
        <h2>{t.rulesTitle}</h2>
        <RulesPanel fixtures={fixtures} zones={zones} onError={setError} />
      </section>
    </div>
  );
}
