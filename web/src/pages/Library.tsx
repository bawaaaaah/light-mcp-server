import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from "react";
import { useT } from "../App";
import { cmd } from "../api";
import { Modal } from "../components/Modal";
import { useContextMenu, useFloatingMenu, useMenuFocus } from "../components/menu";
import type { Texts } from "../i18n";

/** A definition as `library.list` gives it (T20b). */
export interface LibraryRow {
  id: string;
  file: string;
  folder: "venue" | "shared" | "builtin";
  manufacturer: string;
  model: string;
  type: string;
  modes: { name: string; channels: number; heads: number }[];
  winner: boolean;
  copies: string[];
  sameStructure: { manufacturer: string; model: string }[];
  sameStructureCount?: number;
  usedBy: { id: string; name: string }[];
  overrides: boolean;
  aliasedTo?: { manufacturer: string; model: string };
  aliasedFrom?: { manufacturer: string; model: string }[];
}
interface AliasRow {
  id: string;
  from: { manufacturer: string; model: string };
  to: { manufacturer: string; model: string };
  modes: Record<string, string>;
  fixtures: number;
}
interface TrashRow {
  id: string;
  file: string;
  folder: "venue" | "shared";
  venue?: string;
  manufacturer: string;
  model: string;
  deletedAt: string;
}
interface Duplicates {
  sameName: { manufacturer: string; model: string; winner: string; others: { source: string; identical: boolean; message?: string }[] }[];
  sameSignature: { names: { manufacturer: string; model: string; sources: string[] }[] }[];
}
type Dialog = { kind: "delete"; row: LibraryRow } | { kind: "duplicate"; row: LibraryRow } | { kind: "alias"; row: LibraryRow; target?: string } | { kind: "pick"; keep: LibraryRow; drop: string[] } | { kind: "empty" };

/** Rows shown at first and added by « Afficher plus » (a library of 600+ definitions). */
const PAGE = 100;

const fill = (s: string, values: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));
const named = (r: { manufacturer: string; model: string }) => `${r.manufacturer} ${r.model}`;

/**
 * « Bibliothèque » (T20b, first delivery; docs/specs/venue-fixtures-stage.md, « Bibliothèque »): every fixture definition
 * of the machine, searchable and filtered (manufacturer, type, folder, used in this venue, duplicates), with where each one
 * lies and who uses it; the duplicates side by side; duplicate, delete to a trash, merge (keep one file, or forward one
 * name to another: an alias); the aliases and the trash. Every action goes through a command (library.*), shown first
 * by a dry run where it has one. The editor comes with T39.
 */
export function LibraryPage(): ReactElement {
  const t = useT();
  const l = t.libraryPage;
  const [rows, setRows] = useState<LibraryRow[]>([]);
  const [aliases, setAliases] = useState<AliasRow[]>([]);
  const [trash, setTrash] = useState<TrashRow[]>([]);
  const [dups, setDups] = useState<Duplicates>({ sameName: [], sameSignature: [] });
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState({ search: "", manufacturer: "", type: "", folder: "", used: false, duplicates: false });
  const [shown, setShown] = useState(PAGE);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const refresh = () =>
    Promise.all([cmd<{ definitions: LibraryRow[]; aliases: AliasRow[] }>("library.list"), cmd<TrashRow[]>("library.trash"), cmd<Duplicates>("library.duplicates")]).then(
      ([list, tr, d]) => {
        setRows(list.definitions);
        setAliases(list.aliases);
        setTrash(tr);
        setDups(d);
        setLoaded(true);
      },
      (e: Error) => setError(e.message),
    );
  useEffect(() => void refresh(), []);
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const manufacturers = useMemo(() => [...new Set(rows.map((r) => r.manufacturer))].sort((a, b) => a.localeCompare(b)), [rows]);
  const types = useMemo(() => [...new Set(rows.map((r) => r.type).filter(Boolean))].sort((a, b) => a.localeCompare(b)), [rows]);
  const filtered = useMemo(() => {
    const words = filter.search.toLowerCase().split(/\s+/).filter(Boolean);
    return rows.filter(
      (r) =>
        words.every((w) => `${r.manufacturer} ${r.model} ${r.file}`.toLowerCase().includes(w)) &&
        (!filter.manufacturer || r.manufacturer === filter.manufacturer) &&
        (!filter.type || r.type === filter.type) &&
        (!filter.folder || r.folder === filter.folder) &&
        (!filter.used || r.usedBy.length > 0) &&
        (!filter.duplicates || r.copies.length > 0 || r.sameStructure.length > 0),
    );
  }, [rows, filter]);
  /** By manufacturer and model, the file in use before its ignored copies; the built-in dimmer last. */
  const sorted = useMemo(
    () => [...filtered].sort((a, b) => Number(a.folder === "builtin") - Number(b.folder === "builtin") || a.manufacturer.localeCompare(b.manufacturer) || a.model.localeCompare(b.model) || Number(b.winner) - Number(a.winner) || a.id.localeCompare(b.id)),
    [filtered],
  );
  useEffect(() => setShown(PAGE), [filter]);
  const rowMenu = useContextMenu<string>((at, id) => setMenu({ id, ...at }));
  /** Shift+F10 or the context-menu key on a focused row: the same menu, by the row. */
  const keyMenu = (id: string) => (e: ReactKeyboardEvent<Element>) => {
    if (!((e.shiftKey && e.key === "F10") || e.key === "ContextMenu")) return;
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ id, x: r.left + 16, y: r.bottom });
  };
  /** After an action: the message, the lists read again, the dialog closed. */
  const done = (message: string) => {
    setDialog(null);
    setError("");
    setNotice(message);
    void refresh();
  };
  const folderName = (f: LibraryRow["folder"] | TrashRow["folder"]) => (f === "venue" ? l.folderVenue : f === "shared" ? l.folderShared : l.folderBuiltin);
  const menuRow = menu ? byId.get(menu.id) : undefined;

  return (
    <div className="library-page">
      <section>
        <h2>
          {t.library} <span className="count">({rows.length})</span>
        </h2>
        <p className="hint">{l.help}</p>
        <div className="library-filters" role="search" aria-label={l.filters}>
          <input className="search" type="search" aria-label={t.search} placeholder={l.searchPlaceholder} value={filter.search} onChange={(e) => setFilter({ ...filter, search: e.target.value })} />
          <select aria-label={l.manufacturer} value={filter.manufacturer} onChange={(e) => setFilter({ ...filter, manufacturer: e.target.value })}>
            <option value="">{l.allManufacturers}</option>
            {manufacturers.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <select aria-label={l.type} value={filter.type} onChange={(e) => setFilter({ ...filter, type: e.target.value })}>
            <option value="">{l.allTypes}</option>
            {types.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <select aria-label={l.folder} value={filter.folder} onChange={(e) => setFilter({ ...filter, folder: e.target.value })}>
            <option value="">{l.allFolders}</option>
            <option value="venue">{l.folderVenue}</option>
            <option value="shared">{l.folderShared}</option>
            <option value="builtin">{l.folderBuiltin}</option>
          </select>
          <label className="inline">
            <input type="checkbox" checked={filter.used} onChange={(e) => setFilter({ ...filter, used: e.target.checked })} /> {l.usedOnly}
          </label>
          <label className="inline">
            <input type="checkbox" checked={filter.duplicates} onChange={(e) => setFilter({ ...filter, duplicates: e.target.checked })} /> {l.duplicatesOnly}
          </label>
        </div>
        <p className="hint" role="status">
          {loaded ? fill(l.showing, { n: Math.min(shown, filtered.length), total: filtered.length }) : t.loading}
        </p>
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {loaded && filtered.length === 0 && <p className="hint">{t.noMatch}</p>}
        {filtered.length > 0 && (
          <div className="library-scroll">
            <table className="listing library-table">
              <thead>
                <tr>
                  <th scope="col">{l.colModel}</th>
                  <th scope="col">{l.manufacturer}</th>
                  <th scope="col">{l.type}</th>
                  <th scope="col">{l.colModes}</th>
                  <th scope="col">{l.folder}</th>
                  <th scope="col">{l.colUsed}</th>
                  <th scope="col">
                    <span className="sr-only">{l.actions}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sorted.slice(0, shown).map((r) => (
                  <tr key={r.id} className={r.winner ? undefined : "ignored"} title={l.rowHint} tabIndex={0} onKeyDown={keyMenu(r.id)} {...(r.folder === "builtin" ? {} : rowMenu(r.id))}>
                    <th scope="row">
                      <span className="model">{r.model}</span>
                      <span className="maker">{r.manufacturer}</span>
                      <Chips row={r} l={l} />
                    </th>
                    <td>{r.manufacturer}</td>
                    <td>{r.type}</td>
                    <td title={r.modes.map((m) => `${m.name} (${m.channels})`).join(", ")}>{r.folder === "builtin" ? "1-64" : r.modes.length}</td>
                    <td>
                      <span className={`folder-chip ${r.folder}`}>{folderName(r.folder)}</span>
                      {r.file && <span className="file">{r.file}</span>}
                    </td>
                    <td title={r.usedBy.map((u) => u.name).join(", ") || undefined}>{r.usedBy.length ? fill(l.usedCount, { n: r.usedBy.length }) : "—"}</td>
                    <td>
                      {r.folder !== "builtin" && (
                        <button
                          className="ghost row-actions"
                          aria-haspopup="dialog"
                          aria-label={fill(l.actionsOf, { model: named(r) })}
                          onClick={(e) => {
                            const b = e.currentTarget.getBoundingClientRect();
                            setMenu({ id: r.id, x: b.left, y: b.bottom });
                          }}
                        >
                          <span aria-hidden="true">⋯</span>
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {filtered.length > shown && (
          <button className="more" onClick={() => setShown((n) => n + PAGE)}>
            {fill(l.showMore, { n: Math.min(PAGE, filtered.length - shown) })}
          </button>
        )}
      </section>

      <section className="library-duplicates" aria-labelledby="library-dups">
        <h2 id="library-dups">{l.duplicatesTitle}</h2>
        {dups.sameName.length === 0 && dups.sameSignature.length === 0 && <p className="hint">{l.noDuplicates}</p>}
        {dups.sameName.map((g) => (
          <article className="dup-card" key={`${g.manufacturer}|${g.model}`}>
            <h3>{fill(l.sameNameGroup, { n: g.others.length + 1, model: named(g) })}</h3>
            <ul>
              {[{ source: g.winner, identical: true, winner: true, message: undefined as string | undefined }, ...g.others.map((o) => ({ ...o, winner: false }))].map((o) => {
                const row = byId.get(o.source);
                return (
                  <li key={o.source}>
                    <span className="file">{o.source}</span> {o.winner ? <span className="chip ok">{l.inUse}</span> : <span className="chip">{o.identical ? l.identical : o.message}</span>}
                    {row && (
                      <button onClick={() => setDialog({ kind: "pick", keep: row, drop: [g.winner, ...g.others.map((x) => x.source)].filter((x) => x !== o.source) })}>{l.keepThis}</button>
                    )}
                  </li>
                );
              })}
            </ul>
          </article>
        ))}
        {dups.sameSignature.map((g) => (
          <article className="dup-card" key={g.names.map((n) => n.sources[0]).join("|")}>
            <h3>{l.sameStructureGroup}</h3>
            <ul>
              {g.names.map((n) => {
                const row = byId.get(n.sources[0] ?? "");
                return (
                  <li key={named(n)}>
                    <span>{named(n)}</span> <span className="file">{n.sources.join(", ")}</span>
                    {row && !row.aliasedTo && (
                      <button onClick={() => setDialog({ kind: "alias", row, target: byId.get(g.names.find((x) => x !== n)?.sources[0] ?? "")?.id })}>{l.forward}</button>
                    )}
                  </li>
                );
              })}
            </ul>
          </article>
        ))}
      </section>

      <section aria-labelledby="library-aliases">
        <h2 id="library-aliases">{l.aliasesTitle}</h2>
        <p className="hint">{l.aliasesHelp}</p>
        {aliases.length === 0 ? (
          <p className="hint">{l.noAliases}</p>
        ) : (
          <ul className="library-list">
            {aliases.map((a) => (
              <li key={a.id}>
                <span>
                  {named(a.from)} → {named(a.to)}
                </span>
                <span className="hint">{fill(l.usedCount, { n: a.fixtures })}</span>
                <button onClick={() => void cmd("library.unalias", { id: a.id }).then(() => done(fill(l.unaliased, { from: named(a.from) })), (e: Error) => setError(e.message))}>{l.unalias}</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="library-trash">
        <h2 id="library-trash">
          {l.trashTitle} <span className="count">({trash.length})</span>
        </h2>
        {trash.length === 0 ? (
          <p className="hint">{l.trashEmpty}</p>
        ) : (
          <>
            <ul className="library-list">
              {trash.map((e) => (
                <li key={e.id}>
                  <span>{named(e)}</span>
                  <span className="hint">
                    {e.file} · {folderName(e.folder)}
                    {e.venue ? ` (${e.venue})` : ""} · {new Date(e.deletedAt).toLocaleString()}
                  </span>
                  <button onClick={() => void cmd<{ file: string }>("library.restore", { id: e.id }).then((r) => done(fill(l.restored, { file: r.file })), (err: Error) => setError(err.message))}>{l.restore}</button>
                </li>
              ))}
            </ul>
            <button className="danger" onClick={() => setDialog({ kind: "empty" })}>
              {l.emptyTrash}
            </button>
          </>
        )}
      </section>

      {menu && menuRow && (
        <RowMenu
          row={menuRow}
          at={menu}
          l={l}
          onClose={() => setMenu(null)}
          onPick={(d) => {
            setMenu(null);
            setDialog(d);
          }}
        />
      )}
      {dialog?.kind === "delete" && <DeleteDialog row={dialog.row} l={l} onClose={() => setDialog(null)} onDone={done} />}
      {dialog?.kind === "duplicate" && <DuplicateDialog row={dialog.row} l={l} onClose={() => setDialog(null)} onDone={done} />}
      {dialog?.kind === "alias" && <AliasDialog row={dialog.row} rows={rows} initial={dialog.target} l={l} onClose={() => setDialog(null)} onDone={done} />}
      {dialog?.kind === "pick" && <PickDialog keep={dialog.keep} drop={dialog.drop} l={l} onClose={() => setDialog(null)} onDone={done} />}
      {dialog?.kind === "empty" && (
        <Modal label={l.emptyTrash} className="narrow" onClose={() => setDialog(null)}>
          <h3>{l.emptyTrash}</h3>
          <p>{fill(l.emptyTrashAsk, { n: trash.length })}</p>
          <div className="row">
            <button onClick={() => setDialog(null)}>{t.cancel}</button>
            <button className="danger" onClick={() => void cmd<{ removed: number }>("library.trash.empty").then((r) => done(fill(l.emptied, { n: r.removed })), (e: Error) => setError(e.message))}>
              {l.emptyForGood}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

type L = Texts["libraryPage"];

/** The small labels of a row: in use or ignored, copies, same structure, corrections, alias. */
function Chips({ row, l }: { row: LibraryRow; l: L }): ReactElement {
  return (
    <span className="chips">
      {row.copies.length > 0 && <span className={row.winner ? "chip ok" : "chip warn"}>{row.winner ? l.chipWinner : l.chipIgnored}</span>}
      {row.sameStructure.length > 0 && (
        <span className="chip" title={row.sameStructure.map(named).join(", ")}>
          {fill(l.chipSameStructure, { n: row.sameStructureCount ?? row.sameStructure.length })}
        </span>
      )}
      {row.overrides && <span className="chip">{l.chipOverrides}</span>}
      {row.aliasedTo && <span className="chip accent">{fill(l.chipAliasTo, { model: named(row.aliasedTo) })}</span>}
      {row.aliasedFrom && <span className="chip accent">{fill(l.chipAliasFrom, { names: row.aliasedFrom.map(named).join(", ") })}</span>}
    </span>
  );
}

/** Right-click, a long press, the row's ⋯ button or Shift+F10: what can be done with one definition. */
function RowMenu({ row, at, l, onClose, onPick }: { row: LibraryRow; at: { x: number; y: number }; l: L; onClose: () => void; onPick: (d: Dialog) => void }): ReactElement {
  const { box, style } = useFloatingMenu(at, onClose);
  const trap = useMenuFocus(box);
  useEffect(() => box.current?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true }), [box]);
  return (
    <div ref={box} className="widget-menu library-menu" role="dialog" aria-label={fill(l.actionsOf, { model: named(row) })} style={style} onKeyDown={trap} onContextMenu={(e) => e.preventDefault()}>
      <h3>{named(row)}</h3>
      <button onClick={() => onPick({ kind: "duplicate", row })}>
        <span aria-hidden="true">⧉</span> {l.duplicate}
      </button>
      {!row.aliasedTo && (
        <button onClick={() => onPick({ kind: "alias", row })}>
          <span aria-hidden="true">⇢</span> {l.forward}
        </button>
      )}
      <button className="danger" onClick={() => onPick({ kind: "delete", row })}>
        <span aria-hidden="true">🗑</span> {l.delete}
      </button>
    </div>
  );
}

/** The fixtures a plan names, said in one line. */
const fixtureList = (fs: { name: string }[]) => fs.map((f) => f.name).join(", ");

function DeleteDialog({ row, l, onClose, onDone }: { row: LibraryRow; l: L; onClose: () => void; onDone: (m: string) => void }): ReactElement {
  const t = useT();
  type Plan = { usedBy: { name: string }[]; otherVenues: { venue: string; fixtures: string[] }[]; fallback?: string; identicalFallback?: boolean; orphanOverrides: boolean; refused: boolean };
  const [plan, setPlan] = useState<Plan | null>(null);
  const [force, setForce] = useState(false);
  const [dropOverrides, setDropOverrides] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => void cmd<Plan>("library.delete", { id: row.id, dryRun: true }).then(setPlan, (e: Error) => setError(e.message)), [row.id]);
  const go = () => void cmd("library.delete", { id: row.id, force, dropOverrides }).then(() => onDone(fill(l.deleted, { model: named(row) })), (e: Error) => setError(e.message));
  return (
    <Modal label={fill(l.deleteTitle, { model: named(row) })} className="narrow library-dialog" onClose={onClose}>
      <h3>{fill(l.deleteTitle, { model: named(row) })}</h3>
      <p className="hint">
        {row.file} · {l.toTrashHelp}
      </p>
      {!plan && !error && <p role="status">{t.loading}</p>}
      {plan && (
        <>
          {plan.usedBy.length > 0 && <p>{fill(l.usedHere, { list: fixtureList(plan.usedBy) })}</p>}
          {plan.otherVenues.map((v) => (
            <p key={v.venue}>{fill(l.usedElsewhere, { venue: v.venue, list: v.fixtures.join(", ") })}</p>
          ))}
          {(plan.usedBy.length > 0 || plan.otherVenues.length > 0) && <p className={plan.fallback ? "hint" : "warn"}>{plan.fallback ? fill(plan.identicalFallback ? l.fallbackIdentical : l.fallback, { id: plan.fallback }) : l.noFallback}</p>}
          {plan.refused && (
            <label className="inline">
              <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> {l.forceDelete}
            </label>
          )}
          {plan.orphanOverrides && (
            <label className="inline">
              <input type="checkbox" checked={dropOverrides} onChange={(e) => setDropOverrides(e.target.checked)} /> {l.dropOverrides}
            </label>
          )}
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button onClick={onClose}>{t.cancel}</button>
        <button className="danger" disabled={!plan || (plan.refused && !force)} onClick={go}>
          {l.toTrash}
        </button>
      </div>
    </Modal>
  );
}

function DuplicateDialog({ row, l, onClose, onDone }: { row: LibraryRow; l: L; onClose: () => void; onDone: (m: string) => void }): ReactElement {
  const t = useT();
  const [same, setSame] = useState(false);
  const [names, setNames] = useState({ manufacturer: row.manufacturer, model: `${row.model} ${l.copySuffix}` });
  const [error, setError] = useState("");
  const go = () => {
    const args = same ? { id: row.id, sameName: true } : { id: row.id, manufacturer: names.manufacturer.trim(), model: names.model.trim() };
    void cmd<{ model: string; takesOver?: { name: string }[] }>("library.duplicate", args).then(
      (r) => onDone(r.takesOver?.length ? `${fill(l.duplicated, { model: r.model })} ${fill(l.takesOver, { list: fixtureList(r.takesOver) })}` : fill(l.duplicated, { model: r.model })),
      (e: Error) => setError(e.message),
    );
  };
  return (
    <Modal label={fill(l.duplicateTitle, { model: named(row) })} className="narrow library-dialog" onClose={onClose}>
      <h3>{fill(l.duplicateTitle, { model: named(row) })}</h3>
      <fieldset>
        <legend className="sr-only">{l.duplicateHow}</legend>
        <label className="inline">
          <input type="radio" name="dup-how" checked={!same} onChange={() => setSame(false)} /> {l.asNewModel}
        </label>
        {row.folder === "shared" && (
          <label className="inline">
            <input type="radio" name="dup-how" checked={same} onChange={() => setSame(true)} /> {l.asVenueCopy}
          </label>
        )}
      </fieldset>
      {!same && (
        <div className="library-names">
          <label className="field">
            <span>{l.manufacturer}</span>
            <input value={names.manufacturer} onChange={(e) => setNames({ ...names, manufacturer: e.target.value })} />
          </label>
          <label className="field">
            <span>{l.colModel}</span>
            <input value={names.model} onChange={(e) => setNames({ ...names, model: e.target.value })} />
          </label>
        </div>
      )}
      <p className="hint">{same ? l.asVenueCopyHelp : l.asNewModelHelp}</p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button onClick={onClose}>{t.cancel}</button>
        <button className="primary" disabled={!same && (!names.model.trim() || !names.manufacturer.trim())} onClick={go}>
          {l.duplicateIt}
        </button>
      </div>
    </Modal>
  );
}

type MergePlan = {
  fixtures: { name: string }[];
  modes?: Record<string, string>;
  unmapped?: string[];
  channelChanges?: { mode: string; to: string; from: number; channels: number }[];
  targetModes?: { name: string; channels: number }[];
  overrides?: "none" | "copied" | "replaced-target" | "kept-target" | "conflict";
  lostModes?: string[];
  otherVenues?: { venue: string; fixtures: string[] }[];
  differs?: string[];
  refused: boolean;
};

/** « Faire suivre vers… »: this model becomes a name of another one (an alias), after its plan: modes, corrections. */
function AliasDialog({ row, rows, initial, l, onClose, onDone }: { row: LibraryRow; rows: LibraryRow[]; initial?: string; l: L; onClose: () => void; onDone: (m: string) => void }): ReactElement {
  const t = useT();
  const targets = useMemo(() => rows.filter((r) => r.folder !== "builtin" && r.winner && !r.aliasedTo && `${r.manufacturer}|${r.model}`.toLowerCase() !== `${row.manufacturer}|${row.model}`.toLowerCase()), [rows, row]);
  const [target, setTarget] = useState(initial ?? "");
  const [search, setSearch] = useState("");
  const [modes, setModes] = useState<Record<string, string>>({});
  const [overrides, setOverrides] = useState<"target" | "source" | "">("");
  const [force, setForce] = useState(false);
  const [plan, setPlan] = useState<MergePlan | null>(null);
  const [error, setError] = useState("");
  const args = { keep: target, drop: [row.id], as: "alias", modes, ...(overrides ? { overrides } : {}), force };
  useEffect(() => {
    setPlan(null);
    setError("");
    if (target) void cmd<MergePlan>("library.merge", { ...args, dryRun: true }).then(setPlan, (e: Error) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the plan follows the choices, not the object rebuilt each render
  }, [target, JSON.stringify(modes), overrides, force]);
  const shown = targets.filter((r) => `${r.manufacturer} ${r.model}`.toLowerCase().includes(search.toLowerCase())).slice(0, 50);
  const blocked = !plan || (plan.unmapped?.length ?? 0) > 0 || plan.overrides === "conflict" || ((plan.channelChanges?.length ?? 0) > 0 && !force);
  const go = () => void cmd("library.merge", args).then(() => onDone(fill(l.merged, { from: named(row), to: named(rows.find((r) => r.id === target) ?? row) })), (e: Error) => setError(e.message));
  return (
    <Modal label={fill(l.forwardTitle, { model: named(row) })} className="library-dialog" onClose={onClose}>
      <h3>{fill(l.forwardTitle, { model: named(row) })}</h3>
      <p className="hint">{l.forwardHelp}</p>
      <input className="search" type="search" aria-label={l.searchTarget} placeholder={l.searchTarget} value={search} onChange={(e) => setSearch(e.target.value)} />
      <select aria-label={l.target} value={target} onChange={(e) => setTarget(e.target.value)}>
        <option value="">{l.chooseTarget}</option>
        {shown.map((r) => (
          <option key={r.id} value={r.id}>
            {named(r)} ({r.modes.length} {l.colModes.toLowerCase()})
          </option>
        ))}
        {target && !shown.some((r) => r.id === target) && <option value={target}>{target}</option>}
      </select>
      {target && !plan && !error && <p role="status">{t.loading}</p>}
      {plan && (
        <>
          <p>{plan.fixtures.length ? fill(l.followers, { list: fixtureList(plan.fixtures) }) : l.noFollowers}</p>
          <table className="listing mode-table">
            <caption>{l.modeTable}</caption>
            <thead>
              <tr>
                <th scope="col">{fill(l.modesOf, { model: row.model })}</th>
                <th scope="col">{l.targetMode}</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(plan.modes ?? {}).map(([from, to]) => (
                <tr key={from}>
                  <td>{from}</td>
                  <td>{to}</td>
                </tr>
              ))}
              {(plan.unmapped ?? []).map((m) => (
                <tr key={m} className="conflict">
                  <td>{m}</td>
                  <td>
                    <select aria-label={fill(l.mapMode, { mode: m })} value={modes[m] ?? ""} onChange={(e) => setModes({ ...modes, [m]: e.target.value })}>
                      <option value="">{l.noEquivalent}</option>
                      {(plan.targetModes ?? []).map((x) => (
                        <option key={x.name} value={x.name}>
                          {x.name} ({x.channels})
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {(plan.channelChanges ?? []).length > 0 && (
            <>
              <p className="warn">{fill(l.channelChanges, { list: plan.channelChanges!.map((c) => `${c.mode} ${c.from} → ${c.to} ${c.channels}`).join(", ") })}</p>
              <label className="inline">
                <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> {l.forceChannels}
              </label>
            </>
          )}
          {(plan.overrides === "conflict" || overrides) && (
            <fieldset>
              <legend>{l.overridesConflict}</legend>
              <label className="inline">
                <input type="radio" name="ov" checked={overrides === "target"} onChange={() => setOverrides("target")} /> {l.keepTarget}
              </label>
              <label className="inline">
                <input type="radio" name="ov" checked={overrides === "source"} onChange={() => setOverrides("source")} /> {fill(l.takeSource, { model: row.model })}
              </label>
            </fieldset>
          )}
          {plan.overrides === "copied" && <p className="hint">{l.overridesCopied}</p>}
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button onClick={onClose}>{t.cancel}</button>
        <button className="primary" disabled={blocked} onClick={go}>
          {l.forwardIt}
        </button>
      </div>
    </Modal>
  );
}

/** « Garder celle-ci »: one file of a model kept, the others to the trash, after its plan. */
function PickDialog({ keep, drop, l, onClose, onDone }: { keep: LibraryRow; drop: string[]; l: L; onClose: () => void; onDone: (m: string) => void }): ReactElement {
  const t = useT();
  const [plan, setPlan] = useState<MergePlan | null>(null);
  const [force, setForce] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => void cmd<MergePlan>("library.merge", { keep: keep.id, drop, as: "pick", dryRun: true }).then(setPlan, (e: Error) => setError(e.message)), [keep.id, drop]);
  const go = () => void cmd("library.merge", { keep: keep.id, drop, as: "pick", force }).then(() => onDone(fill(l.picked, { id: keep.id })), (e: Error) => setError(e.message));
  const others = (plan?.otherVenues ?? []).length > 0;
  return (
    <Modal label={fill(l.pickTitle, { id: keep.id })} className="narrow library-dialog" onClose={onClose}>
      <h3>{fill(l.pickTitle, { id: keep.id })}</h3>
      <p>{fill(l.pickHelp, { list: drop.join(", ") })}</p>
      {!plan && !error && <p role="status">{t.loading}</p>}
      {plan && (plan.differs ?? []).length > 0 && <p className="warn">{fill(l.pickDiffers, { list: plan.differs!.join(", ") })}</p>}
      {plan && (plan.lostModes ?? []).length > 0 && <p className="error">{fill(l.lostModes, { list: plan.lostModes!.join(", ") })}</p>}
      {plan &&
        (plan.otherVenues ?? []).map((v) => (
          <p key={v.venue} className="warn">
            {fill(l.usedElsewhere, { venue: v.venue, list: v.fixtures.join(", ") })}
          </p>
        ))}
      {others && (
        <label className="inline">
          <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> {l.forceDelete}
        </label>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button onClick={onClose}>{t.cancel}</button>
        <button className="primary" disabled={!plan || (plan.lostModes ?? []).length > 0 || (others && !force)} onClick={go}>
          {l.keepThis}
        </button>
      </div>
    </Modal>
  );
}
