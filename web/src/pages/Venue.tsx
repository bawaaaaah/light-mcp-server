import { useCallback, useEffect, useMemo, useState } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { useCommandEvents } from "../hooks/useTopic";
import { slug } from "../util";
import { StagePlan, type PlanZone } from "../components/StagePlan";
import { Calibration } from "../components/Calibration";

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
  const [error, setError] = useState("");

  const refresh = useCallback(() => {
    void cmd<Fixture[]>("venue.fixture.list").then(setFixtures).catch((e: Error) => setError(e.message));
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
      <section>
        <h2>{t.stagePreview}</h2>
        <StagePlan
          fixtures={fixtures}
          zones={zones}
          onError={setError}
          onMove={(f, position) => void run("venue.fixture.put", { fixture: { ...f, position } }).then(refresh)}
        />
        <details className="calibration-box">
          <summary>{t.calibrationTitle}</summary>
          <Calibration zones={zones} placed={new Set(fixtures.filter((f) => f.position).map((f) => f.id))} onError={setError} onApplied={refresh} />
        </details>
      </section>
      <div className="cols">
        <section>
          <h2>{t.patch} ({fixtures.length})</h2>
          <table>
            <tbody>
              {fixtures.map((f) => (
                <tr key={f.id}>
                  <td>
                    <input type="checkbox" checked={canvasDraft.fixtures.includes(f.id)} onChange={(e) => setCanvasDraft((c) => ({ ...c, fixtures: e.target.checked ? [...c.fixtures, f.id] : c.fixtures.filter((x) => x !== f.id) }))} />
                  </td>
                  <td>{f.name}</td>
                  <td>
                    <small>
                      {f.manufacturer} {f.model} · {f.mode}
                    </small>
                  </td>
                  <td>
                    U{f.universe}.{f.address}
                  </td>
                  <td>{f.role}</td>
                  <td>
                    <button className="ghost" title={t.delete} onClick={() => void run("venue.fixture.delete", { id: f.id })}>
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="editor">
            <input placeholder={t.name} value={canvasDraft.name} onChange={(e) => setCanvasDraft({ ...canvasDraft, name: e.target.value })} />
            <select value={canvasDraft.topology} onChange={(e) => setCanvasDraft({ ...canvasDraft, topology: e.target.value })}>
              <option value="line">ligne</option>
              <option value="line-mirror">ligne miroir</option>
              <option value="ring">anneau</option>
            </select>
            <button
              disabled={!canvasDraft.name || canvasDraft.fixtures.length === 0}
              onClick={() => void run("venue.canvas.auto", { id: slug(canvasDraft.name), name: canvasDraft.name, topology: canvasDraft.topology, fixtures: canvasDraft.fixtures })}
            >
              {t.makeCanvas} ({canvasDraft.fixtures.length})
            </button>
          </div>
          <h2>{t.canvases}</h2>
          <ul>
            {canvases.map((c) => (
              <li key={c.id}>
                {c.name} <small>({c.topology}, {c.cells})</small>
              </li>
            ))}
          </ul>
          <h2>{t.zones}</h2>
          <ul>
            {zones.map((z) => (
              <li key={z.id}>
                {z.name} <small>({z.type})</small> {z.protected ? <span className="badge conflict">{t.protectedZone}</span> : ""}
              </li>
            ))}
          </ul>
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
              <option value="">mode</option>
              {def?.modes.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name} ({m.channels} ch{m.heads ? `, ${m.heads} têtes` : ""})
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
            <button className="ghost" onClick={() => setDraft({ ...draft, address: nextAddress(draft.universe) })}>
              auto
            </button>
            <input placeholder="rôle (face, contre…)" value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value })} />
            <button
              className="primary"
              disabled={!def || !draft.mode || !draft.name}
              onClick={() =>
                void run("venue.fixture.put", {
                  fixture: { id: slug(draft.name), name: draft.name, manufacturer: def!.manufacturer, model: def!.model, mode: draft.mode, universe: draft.universe, address: draft.address, ...(draft.role ? { role: draft.role } : {}) },
                }).then(() => setDraft({ ...draft, name: "" }))
              }
            >
              {t.patchIt}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
