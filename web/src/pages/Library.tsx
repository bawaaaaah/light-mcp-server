import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from "react";
import { useMe } from "../app-context";
import { useT } from "../i18n-context";
import { can, cmd } from "../api";
import { Modal } from "../components/Modal";
import { useContextMenu, useFloatingMenu, useMenuFocus } from "../components/menu";
import { useDomainEvents } from "../hooks/useTopic";
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
  /** Fixtures of the other venues of this machine that resolve it. */
  usedElsewhere?: number;
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
  reason?: "deleted" | "replaced";
  /** The venue it came from, named by its shows. */
  venueName?: string;
}
interface Duplicates {
  sameName: { manufacturer: string; model: string; winner: string; others: { source: string; identical: boolean; message?: string }[] }[];
  sameSignature: { names: { manufacturer: string; model: string; sources: string[] }[] }[];
}
type Dialog =
  | { kind: "delete"; row: LibraryRow }
  | { kind: "duplicate"; row: LibraryRow }
  | { kind: "alias"; row: LibraryRow; target?: string }
  | { kind: "pick"; keep: LibraryRow; drop: string[] }
  | { kind: "unalias"; alias: AliasRow }
  | { kind: "restore"; entry: TrashRow }
  | { kind: "empty" };

/** Rows shown at first and added by « Afficher plus » (a library of 600+ definitions). */
const PAGE = 100;

const fill = (s: string, values: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));
const named = (r: { manufacturer: string; model: string }) => `${r.manufacturer} ${r.model}`;
type L = Texts["libraryPage"];
/** A text compared without case nor accents (« eclat » finds « Éclat »). */
const folded = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const modesCount = (l: L, n: number) => (n === 1 ? l.modesOne : fill(l.modesMany, { n }));
/** « 1 appareil », « 3 appareils »: never « appareil(s) ». */
const fixturesCount = (l: L, n: number) => (n === 1 ? l.usedOne : fill(l.usedMany, { n }));
const folderName = (l: L, f: LibraryRow["folder"] | TrashRow["folder"]) => (f === "venue" ? l.folderVenue : f === "shared" ? l.folderShared : l.folderBuiltin);
/** A definition id (`shared/spot.qxf`) as people read it: its file and its folder's name. */
const human = (l: L, id: string) => {
  const slash = id.indexOf("/");
  const folder = id.slice(0, slash);
  return folder === "venue" || folder === "shared" ? fill(l.fileIn, { file: id.slice(slash + 1), folder: folderName(l, folder) }) : id;
};

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
  const me = useMe();
  const [rows, setRows] = useState<LibraryRow[]>([]);
  const [aliases, setAliases] = useState<AliasRow[]>([]);
  const [trash, setTrash] = useState<TrashRow[]>([]);
  const [dups, setDups] = useState<Duplicates>({ sameName: [], sameSignature: [] });
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [filter, setFilter] = useState({ search: "", manufacturer: "", type: "", folder: "", used: false, duplicates: false });
  const [shown, setShown] = useState(PAGE);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState("");

  const refresh = () =>
    Promise.all([cmd<{ definitions: LibraryRow[]; aliases: AliasRow[] }>("library.list"), cmd<TrashRow[]>("library.trash"), cmd<Duplicates>("library.duplicates")]).then(
      ([list, tr, d]) => {
        setRows(list.definitions);
        setAliases(list.aliases);
        setTrash(tr);
        setDups(d);
        setLoaded(true);
        setLoadError("");
      },
      (e: Error) => setLoadError(e.message),
    );
  useEffect(() => void refresh(), []);
  // a definition added, replaced or merged elsewhere (the Import page, another screen, an AI client): read again
  useDomainEvents(["definitions", "patch", "show"], () => void refresh());
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const manufacturers = useMemo(() => [...new Set(rows.map((r) => r.manufacturer))].sort((a, b) => a.localeCompare(b)), [rows]);
  const types = useMemo(() => [...new Set(rows.map((r) => r.type).filter(Boolean))].sort((a, b) => a.localeCompare(b)), [rows]);
  const filtered = useMemo(() => {
    const words = folded(filter.search).split(/\s+/).filter(Boolean);
    return rows.filter(
      (r) =>
        words.every((w) => folded(`${r.manufacturer} ${r.model} ${r.file}`).includes(w)) &&
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
  /** Shift+F10 or the context-menu key on a row's ⋯ button (its one stop for the keyboard): the same menu. */
  const keyMenu = (id: string) => (e: ReactKeyboardEvent<Element>) => {
    if (!((e.shiftKey && e.key === "F10") || e.key === "ContextMenu")) return;
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ id, x: r.left, y: r.bottom });
  };
  /** The row whose ⋯ a dialog opened from the menu gives the keyboard back to, or the button that opened it. */
  const lastRow = useRef<string | null>(null);
  /** The rows after and before it when its menu was used: where the keyboard goes if the action took the row away. */
  const rowNeighbours = useRef<string[]>([]);
  const opener = useRef<HTMLElement | null>(null);
  /** The section the opener was in: its title takes the focus when the opener went with the action (a restored entry). */
  const openerSection = useRef<HTMLElement | null>(null);
  /** The table's section: where the keyboard lands when a row's action took the row away. */
  const listSection = useRef<HTMLElement | null>(null);
  /** A dialog opened by a button of the page (not the row menu): the focus comes back to that button. */
  const openFrom = (el: HTMLElement, d: Dialog) => {
    lastRow.current = null;
    opener.current = el;
    openerSection.current = el.closest("section");
    setDialog(d);
  };
  /** Bumped when a dialog closed, once the lists it changed are drawn again: the effect below gives the keyboard back. */
  const [focusBack, setFocusBack] = useState(0);
  const closeDialog = () => {
    setDialog(null);
    setFocusBack((n) => n + 1);
  };
  /** After an action: the message (a toast, in view wherever the action was), the dialog closed, the lists read again. */
  const done = (message: string) => {
    setDialog(null);
    setNotice(message);
    // the focus once the lists are drawn again: the button the action took away (a restored entry) is gone by then
    void refresh().then(() => setFocusBack((n) => n + 1));
  };
  // after the dialog's own clean-up: the row's ⋯ or the button that opened it (still there), else its section's title
  useEffect(() => {
    if (!focusBack) return;
    // the keyboard already went elsewhere while the lists were read again (a busy machine answers late): leave it there
    const active = document.activeElement;
    if (active && active !== document.body && active !== opener.current) return;
    const rowButton = (id: string) => document.querySelector<HTMLElement>(`button[data-row-actions="${CSS.escape(id)}"]`);
    // the row's ⋯, else (the row gone with the action) its neighbour's
    const row = lastRow.current ? [lastRow.current, ...rowNeighbours.current].map(rowButton).find(Boolean) : null;
    // the button gone with what it acted on (a restored entry, an alias removed, the trash emptied): its section's title
    const title = openerSection.current?.isConnected ? openerSection.current.querySelector<HTMLElement>("h2") : null;
    (row ?? (opener.current?.isConnected ? opener.current : title))?.focus({ preventScroll: true });
  }, [focusBack]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 8000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const menuRow = menu ? byId.get(menu.id) : undefined;
  const mayEmpty = me ? can(me, "show:admin") : false;

  return (
    <div className="library-page">
      <section ref={listSection} aria-labelledby="library-list">
        <h2 id="library-list" tabIndex={-1}>
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
        {loadError ? (
          <div className="error" role="alert">
            {l.loadFailed} {loadError}{" "}
            <button onClick={() => void refresh()}>{l.retry}</button>
          </div>
        ) : (
          <p className="hint" role="status">
            {loaded ? fill(l.showing, { n: Math.min(shown, filtered.length), total: filtered.length }) : t.loading}
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
                  <tr key={r.id} className={r.winner ? undefined : "ignored"} {...(r.folder === "builtin" ? {} : rowMenu(r.id))}>
                    <th scope="row">
                      <span className="model">{r.model}</span>
                      <span className="maker">{r.manufacturer}</span>
                      <Chips row={r} l={l} />
                    </th>
                    <td>{r.manufacturer}</td>
                    <td>{r.type}</td>
                    <td title={r.modes.map((m) => `${m.name} (${m.channels})`).join(", ")}>{r.folder === "builtin" ? "1-64" : r.modes.length}</td>
                    <td>
                      <span className={`folder-chip ${r.folder}`}>{folderName(l, r.folder)}</span>
                      {r.file && <FileName file={r.file} />}
                    </td>
                    <td title={r.usedBy.map((u) => u.name).join(", ") || undefined}>
                      {r.usedBy.length ? `${l.here} : ${fixturesCount(l, r.usedBy.length)}` : r.usedElsewhere ? "" : "—"}
                      {r.usedElsewhere ? (
                        <span className="elsewhere" title={l.elsewhereHint}>
                          {fill(l.elsewhere, { n: r.usedElsewhere })}
                        </span>
                      ) : null}
                    </td>
                    <td>
                      {r.folder !== "builtin" && (
                        <button
                          className="ghost row-actions"
                          data-row-actions={r.id}
                          aria-haspopup="dialog"
                          aria-label={fill(l.actionsOf, { model: named(r) })}
                          onKeyDown={keyMenu(r.id)}
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
        <h2 id="library-dups" tabIndex={-1}>{l.duplicatesTitle}</h2>
        {dups.sameName.length === 0 && dups.sameSignature.length === 0 && <p className="hint">{l.noDuplicates}</p>}
        {dups.sameName.map((g) => (
          <article className="dup-card" key={`${g.manufacturer}|${g.model}`}>
            <h3>{fill(l.sameNameGroup, { n: g.others.length + 1, model: named(g) })}</h3>
            <ul>
              {[{ source: g.winner, identical: true, winner: true, message: undefined as string | undefined }, ...g.others.map((o) => ({ ...o, winner: false }))].map((o) => {
                const row = byId.get(o.source);
                return (
                  <li key={o.source}>
                    <span className="file">{human(l, o.source)}</span> {o.winner ? <span className="chip ok">{l.inUse}</span> : <span className="chip">{o.identical ? l.identical : o.message}</span>}
                    {row && (
                      <button onClick={(ev) => openFrom(ev.currentTarget, { kind: "pick", keep: row, drop: [g.winner, ...g.others.map((x) => x.source)].filter((x) => x !== o.source) })} aria-label={`${l.keepThis} : ${human(l, o.source)}`}>
                        {l.keepThis}
                      </button>
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
                    <span>{named(n)}</span> <span className="file">{n.sources.map((x) => human(l, x)).join(", ")}</span>
                    {row && !row.aliasedTo && (
                      <button onClick={(ev) => openFrom(ev.currentTarget, { kind: "alias", row, target: byId.get(g.names.find((x) => x !== n)?.sources[0] ?? "")?.id })} aria-label={`${l.forward} ${named(n)}`}>
                        {l.forward}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </article>
        ))}
      </section>

      <section aria-labelledby="library-aliases">
        <h2 id="library-aliases" tabIndex={-1}>{l.aliasesTitle}</h2>
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
                <span className="hint">{a.fixtures ? fixturesCount(l, a.fixtures) : "—"}</span>
                <button onClick={(ev) => openFrom(ev.currentTarget, { kind: "unalias", alias: a })} aria-label={`${l.unalias} ${named(a.from)}`}>
                  {l.unalias}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="library-trash">
        <h2 id="library-trash" tabIndex={-1}>
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
                    {e.reason === "replaced" ? l.reasonReplaced : l.reasonDeleted} · {e.file} · {folderName(l, e.folder)}
                    {e.venue ? ` (${e.venueName ?? e.venue})` : ""} · {new Date(e.deletedAt).toLocaleString()}
                  </span>
                  <button aria-label={`${l.restore} ${named(e)}`} onClick={(ev) => openFrom(ev.currentTarget, { kind: "restore", entry: e })}>
                    {l.restore}
                  </button>
                </li>
              ))}
            </ul>
            {!mayEmpty && <p className="hint">{l.adminOnlyTrash}</p>}
            {mayEmpty && (
              <button className="danger" onClick={(ev) => openFrom(ev.currentTarget, { kind: "empty" })}>
                {l.emptyTrash}
              </button>
            )}
          </>
        )}
      </section>

      <p className="library-toast" role="status" hidden={!notice}>
        {notice}
      </p>
      {menu && menuRow && (
        <RowMenu
          row={menuRow}
          at={menu}
          l={l}
          onClose={() => setMenu(null)}
          onPick={(d) => {
            lastRow.current = menu.id;
            // the row gone with the action (deleted, merged away): the next row's ⋯, the previous one's if it was the last;
            // read from the whole sorted list, not the rows drawn: the next row past the page's end slides into its place
            const at = sorted.findIndex((r) => r.id === menu.id);
            rowNeighbours.current = at < 0 ? [] : [sorted[at + 1]?.id, sorted[at - 1]?.id].filter((id): id is string => Boolean(id));
            opener.current = null;
            // no row left at all: the table's title, never an older dialog's section
            openerSection.current = listSection.current;
            setMenu(null);
            // once the menu has given the focus back to the row: the dialog then takes it, and gives it back on close
            window.setTimeout(() => setDialog(d), 0);
          }}
        />
      )}
      {dialog?.kind === "delete" && <DeleteDialog row={dialog.row} l={l} onClose={closeDialog} onDone={done} />}
      {dialog?.kind === "duplicate" && <DuplicateDialog row={dialog.row} rows={rows} l={l} onClose={closeDialog} onDone={done} />}
      {dialog?.kind === "alias" && <AliasDialog row={dialog.row} rows={rows} initial={dialog.target} l={l} onClose={closeDialog} onDone={done} />}
      {dialog?.kind === "pick" && <PickDialog keep={dialog.keep} drop={dialog.drop} l={l} onClose={closeDialog} onDone={done} />}
      {dialog?.kind === "unalias" && <UnaliasDialog alias={dialog.alias} l={l} onClose={closeDialog} onDone={done} />}
      {dialog?.kind === "restore" && <RestoreDialog entry={dialog.entry} l={l} onClose={closeDialog} onDone={done} />}
      {dialog?.kind === "empty" && <EmptyTrashDialog l={l} onClose={closeDialog} onDone={done} />}
    </div>
  );
}

/** The small labels of a row: in use or ignored, copies, same structure, corrections, alias. */
function Chips({ row, l }: { row: LibraryRow; l: L }): ReactElement {
  return (
    <span className="chips">
      {row.copies.length > 0 && <span className={row.winner ? "chip ok" : "chip warn"}>{row.winner ? l.chipWinner : l.chipIgnored}</span>}
      {row.sameStructure.length > 0 && (
        <span className="chip" title={row.sameStructure.map(named).join(", ")}>
          {(row.sameStructureCount ?? row.sameStructure.length) === 1 ? l.chipSameStructureOne : fill(l.chipSameStructure, { n: row.sameStructureCount ?? row.sameStructure.length })}
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
    <div
      ref={box}
      className="widget-menu library-menu"
      role="dialog"
      aria-label={fill(l.actionsOf, { model: named(row) })}
      style={style}
      onKeyDown={(e) => {
        // ↑ ↓ between the entries, Début / Fin to the first and last
        const items = [...(box.current?.querySelectorAll<HTMLElement>("button") ?? [])];
        const current = items.indexOf(document.activeElement as HTMLElement);
        const to = e.key === "ArrowDown" ? (current + 1) % items.length : e.key === "ArrowUp" ? (current - 1 + items.length) % items.length : e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : -1;
        if (to >= 0 && items.length) {
          e.preventDefault();
          items[to]!.focus();
          return;
        }
        trap(e);
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
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

/** The error of a dialog, said inside it, above its buttons. */
function DialogError({ error }: { error: string }): ReactElement | null {
  return error ? (
    <p className="error" role="alert">
      {error}
    </p>
  ) : null;
}

function DeleteDialog({ row, l, onClose, onDone }: { row: LibraryRow; l: L; onClose: () => void; onDone: (m: string) => void }): ReactElement {
  const t = useT();
  type Plan = {
    usedBy: { name: string }[];
    otherVenues: { venue: string; name?: string; fixtures: string[] }[];
    fallback?: string;
    identicalFallback?: boolean;
    aliases: { id: string; from: { manufacturer: string; model: string }; fixtures: { name: string }[] }[];
    orphanOverrides: boolean;
    refused: boolean;
  };
  const [plan, setPlan] = useState<Plan | null>(null);
  const [force, setForce] = useState(false);
  const [dropOverrides, setDropOverrides] = useState(false);
  const [dropAliases, setDropAliases] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => void cmd<Plan>("library.delete", { id: row.id, dryRun: true }).then(setPlan, (e: Error) => setError(e.message)), [row.id]);
  const go = () => void cmd("library.delete", { id: row.id, force, dropOverrides, dropAliases }).then(() => onDone(fill(l.deleted, { model: named(row) })), (e: Error) => setError(e.message));
  return (
    <Modal label={fill(l.deleteTitle, { model: named(row) })} className="narrow library-dialog" onClose={onClose}>
      <h3>{fill(l.deleteTitle, { model: named(row) })}</h3>
      <p className="hint">
        {human(l, row.id)} · {l.toTrashHelp}
      </p>
      {!plan && !error && <p role="status">{t.loading}</p>}
      {plan && (
        <>
          {plan.usedBy.length > 0 && <p>{fill(l.usedHere, { list: fixtureList(plan.usedBy) })}</p>}
          {plan.otherVenues.map((v) => (
            <p key={v.venue} className="warn">
              {fill(l.usedElsewhere, { venue: v.name ?? v.venue, list: v.fixtures.join(", ") })}
            </p>
          ))}
          {(plan.usedBy.length > 0 || plan.otherVenues.length > 0) && <p className={plan.fallback ? "hint" : "warn"}>{plan.fallback ? fill(plan.identicalFallback ? l.fallbackIdentical : l.fallback, { id: human(l, plan.fallback) }) : l.noFallback}</p>}
          {plan.aliases.length > 0 && (
            <>
              <p className="warn">
                {fill(l.aliasesOnIt, { list: plan.aliases.map((a) => `${named(a.from)}${a.fixtures.length ? ` (${fixtureList(a.fixtures)})` : ""}`).join(", ") })} {dropAliases ? "" : l.aliasesLeft}
              </p>
              <label className="inline">
                <input type="checkbox" checked={dropAliases} onChange={(e) => setDropAliases(e.target.checked)} /> {l.dropAliases}
              </label>
            </>
          )}
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
      <DialogError error={error} />
      <div className="row">
        <button onClick={onClose}>{t.cancel}</button>
        <button className="danger" disabled={!plan || (plan.refused && !force)} onClick={go}>
          {l.toTrash}
        </button>
      </div>
    </Modal>
  );
}

/** « <modèle> (copie) », else « (copie 2) », « (copie 3) »…: the first one no definition of that manufacturer has. */
function freeCopyName(row: LibraryRow, rows: readonly LibraryRow[], l: L): string {
  const taken = new Set(rows.filter((r) => folded(r.manufacturer) === folded(row.manufacturer)).map((r) => folded(r.model)));
  const base = l.copySuffix.replace(/\)$/, "");
  let name = `${row.model} ${l.copySuffix}`;
  for (let i = 2; taken.has(folded(name)); i++) name = `${row.model} ${base} ${i})`;
  return name;
}

function DuplicateDialog({ row, rows, l, onClose, onDone }: { row: LibraryRow; rows: readonly LibraryRow[]; l: L; onClose: () => void; onDone: (m: string) => void }): ReactElement {
  const t = useT();
  const [same, setSame] = useState(false);
  const [names, setNames] = useState(() => ({ manufacturer: row.manufacturer, model: freeCopyName(row, rows, l) }));
  const [error, setError] = useState("");
  const go = () => {
    const args = same ? { id: row.id, sameName: true } : { id: row.id, ...(names.manufacturer.trim() !== row.manufacturer ? { manufacturer: names.manufacturer.trim() } : {}), model: names.model.trim() };
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
        <form
          className="library-names"
          onSubmit={(e) => {
            e.preventDefault(); // Enter in a field duplicates
            if (names.model.trim() && names.manufacturer.trim()) go();
          }}
        >
          <label className="field">
            <span>{l.manufacturer}</span>
            <input value={names.manufacturer} onChange={(e) => setNames({ ...names, manufacturer: e.target.value })} />
          </label>
          <label className="field">
            <span>{l.colModel}</span>
            <input value={names.model} onChange={(e) => setNames({ ...names, model: e.target.value })} />
          </label>
          <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
        </form>
      )}
      <p className="hint">{same ? l.asVenueCopyHelp : `${l.asNewModelHelp} ${l.newCopyStructure}`}</p>
      <DialogError error={error} />
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
  following?: { from: { manufacturer: string; model: string }; fixtures: { name: string }[] }[];
  modes?: Record<string, string>;
  unmapped?: string[];
  channelChanges?: { mode: string; to: string; from: number; channels: number }[];
  targetModes?: { name: string; channels: number }[];
  overrides?: "none" | "copied" | "replaced-target" | "kept-target" | "conflict";
  lostModes?: string[];
  otherVenues?: { venue: string; name?: string; fixtures: string[] }[];
  losesDefinition?: string[];
  differs?: string[];
  refused: boolean;
};

/**
 * « Faire suivre vers… »: this model becomes a name of another one (an alias), after its plan. Every mode of the old
 * model gets a list of the target's modes, set to what the server proposes and editable; only the answer to the latest
 * question is shown (a slow plan for an older choice is dropped).
 */
function AliasDialog({ row, rows, initial, l, onClose, onDone }: { row: LibraryRow; rows: LibraryRow[]; initial?: string; l: L; onClose: () => void; onDone: (m: string) => void }): ReactElement {
  const t = useT();
  const targets = useMemo(
    () =>
      rows
        .filter((r) => r.folder !== "builtin" && r.winner && !r.aliasedTo && `${r.manufacturer}|${r.model}`.toLowerCase() !== `${row.manufacturer}|${row.model}`.toLowerCase())
        .sort((a, b) => a.manufacturer.localeCompare(b.manufacturer) || a.model.localeCompare(b.model)),
    [rows, row],
  );
  const [target, setTarget] = useState(initial ?? "");
  const [search, setSearch] = useState("");
  /** The modes chosen by hand: old mode → target mode; the others follow the server's proposal. */
  const [modes, setModes] = useState<Record<string, string>>({});
  const [overrides, setOverrides] = useState<"target" | "source" | "">("");
  const [force, setForce] = useState(false);
  const [plan, setPlan] = useState<MergePlan | null>(null);
  const [error, setError] = useState("");
  const asked = useRef(0);
  const args = { keep: target, drop: [row.id], as: "alias", modes, ...(overrides ? { overrides } : {}), force };
  useEffect(() => {
    setError("");
    if (!target) return setPlan(null);
    const n = ++asked.current;
    void cmd<MergePlan>("library.merge", { ...args, dryRun: true }).then(
      (p) => n === asked.current && setPlan(p),
      (e: Error) => n === asked.current && (setPlan(null), setError(e.message)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the plan follows the choices, not the object rebuilt each render
  }, [target, JSON.stringify(modes), overrides, force]);
  // the target changed: the hand-made choices were for another one's modes
  useEffect(() => setModes({}), [target]);
  const shown = targets.filter((r) => folded(`${r.manufacturer} ${r.model}`).includes(folded(search))).slice(0, 50);
  const blocked = !plan || (plan.unmapped?.length ?? 0) > 0 || plan.overrides === "conflict" || ((plan.channelChanges?.length ?? 0) > 0 && !force);
  const go = () =>
    void cmd<{ retargeted?: { from: { manufacturer: string; model: string }; previousTo?: { manufacturer: string; model: string } }[] }>("library.merge", args).then((r) => {
      const merged = fill(l.merged, { from: named(row), to: named(rows.find((x) => x.id === target) ?? row) });
      const moved = (r.retargeted ?? []).map((x) => `${named(x.from)}${x.previousTo ? ` (${named(x.previousTo)} →)` : ""}`);
      onDone(moved.length ? `${merged} ${fill(l.mergedRepointed, { list: moved.join(", ") })}` : merged);
    }, (e: Error) => setError(e.message));
  const lines = plan ? [...Object.keys(plan.modes ?? {}), ...(plan.unmapped ?? [])] : [];
  return (
    <Modal label={fill(l.forwardTitle, { model: named(row) })} className="library-dialog" onClose={onClose}>
      <h3>{fill(l.forwardTitle, { model: named(row) })}</h3>
      <p className="hint">{l.forwardHelp}</p>
      <input className="search" type="search" aria-label={l.searchTarget} placeholder={l.searchTarget} value={search} onChange={(e) => setSearch(e.target.value)} />
      <select aria-label={l.target} value={target} onChange={(e) => setTarget(e.target.value)}>
        <option value="">{l.chooseTarget}</option>
        {shown.map((r) => (
          <option key={r.id} value={r.id}>
            {named(r)} ({modesCount(l, r.modes.length)})
          </option>
        ))}
        {target && !shown.some((r) => r.id === target) && <option value={target}>{human(l, target)}</option>}
      </select>
      {target && !plan && !error && <p role="status">{t.loading}</p>}
      {plan && (
        <>
          <p>{plan.fixtures.length ? fill(l.followers, { list: fixtureList(plan.fixtures) }) : l.noFollowers}</p>
          {(plan.following ?? []).length > 0 && <p className="warn">{fill(l.retargeted, { list: plan.following!.map((f) => `${named(f.from)} (${fixtureList(f.fixtures)})`).join(", ") })}</p>}
          <table className="listing mode-table">
            <caption>{l.modeTable}</caption>
            <thead>
              <tr>
                <th scope="col">{fill(l.modesOf, { model: row.model })}</th>
                <th scope="col">{l.targetMode}</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((m) => {
                const unmapped = plan.unmapped?.includes(m);
                return (
                  <tr key={m} className={unmapped ? "conflict" : undefined}>
                    <td>{m}</td>
                    <td>
                      <select aria-label={fill(l.mapMode, { mode: m })} value={modes[m] ?? plan.modes?.[m] ?? ""} onChange={(e) => setModes({ ...modes, [m]: e.target.value })}>
                        {unmapped && !modes[m] && <option value="">{l.noEquivalent}</option>}
                        {(plan.targetModes ?? []).map((x) => (
                          <option key={x.name} value={x.name}>
                            {x.name} ({x.channels})
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                );
              })}
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
      <DialogError error={error} />
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
  const go = () => void cmd("library.merge", { keep: keep.id, drop, as: "pick", force }).then(() => onDone(fill(l.picked, { id: human(l, keep.id) })), (e: Error) => setError(e.message));
  const loses = (plan?.losesDefinition ?? []).length > 0;
  const title = fill(l.pickTitle, { id: human(l, keep.id) });
  return (
    <Modal label={title} className="narrow library-dialog" onClose={onClose}>
      <h3>{title}</h3>
      <p>{fill(l.pickHelp, { list: drop.map((d) => human(l, d)).join(", ") })}</p>
      {plan && <p className={(plan.differs ?? []).length && plan.fixtures.length ? "warn" : "hint"}>{(plan.differs ?? []).length && plan.fixtures.length ? fill(l.pickChanges, { list: fixtureList(plan.fixtures) }) : l.pickSame}</p>}
      {!plan && !error && <p role="status">{t.loading}</p>}
      {plan && (plan.differs ?? []).length > 0 && <p className="warn">{fill(l.pickDiffers, { list: plan.differs!.map((d) => human(l, d)).join(", ") })}</p>}
      {plan && (plan.lostModes ?? []).length > 0 && <p className="error">{fill(l.lostModes, { list: plan.lostModes!.join(", ") })}</p>}
      {plan &&
        (plan.otherVenues ?? []).map((v) => (
          <p key={v.venue} className="warn">
            {fill(l.usedElsewhere, { venue: v.name ?? v.venue, list: v.fixtures.join(", ") })}
          </p>
        ))}
      {loses && (
        <label className="inline">
          <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> {l.forceDelete}
        </label>
      )}
      <DialogError error={error} />
      <div className="row">
        <button onClick={onClose}>{t.cancel}</button>
        <button className="primary" disabled={!plan || (plan.lostModes ?? []).length > 0 || (loses && !force)} onClick={go}>
          {l.keepThis}
        </button>
      </div>
    </Modal>
  );
}

/** « Retirer l'alias »: its plan first (each fixture's mode before and after, a channel count that changes), then a yes. */
function UnaliasDialog({ alias, l, onClose, onDone }: { alias: AliasRow; l: L; onClose: () => void; onDone: (m: string) => void }): ReactElement {
  const t = useT();
  type Plan = {
    fixtures: { name: string; before: { mode: string; channels: number } | null; after: { mode: string; channels: number } | null }[];
    repointed: { from: { manufacturer: string; model: string } }[];
    noDefinition?: boolean;
  };
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState("");
  useEffect(() => void cmd<Plan>("library.unalias", { id: alias.id, dryRun: true }).then(setPlan, (e: Error) => setError(e.message)), [alias.id]);
  const go = () => void cmd("library.unalias", { id: alias.id }).then(() => onDone(fill(l.unaliased, { from: named(alias.from) })), (e: Error) => setError(e.message));
  const title = fill(l.unaliasTitle, { from: named(alias.from), to: named(alias.to) });
  const changes = (plan?.fixtures ?? []).filter((f) => f.before && f.after && f.before.channels !== f.after.channels);
  return (
    <Modal label={title} className="narrow library-dialog" onClose={onClose}>
      <h3>{title}</h3>
      <p className="hint">{fill(l.unaliasHelp, { from: named(alias.from), to: named(alias.to) })}</p>
      {!plan && !error && <p role="status">{t.loading}</p>}
      {plan && (
        <>
          <p>{plan.fixtures.length ? fill(l.unaliasBack, { list: fixtureList(plan.fixtures) }) : l.noFollowers}</p>
          {plan.noDefinition && plan.fixtures.length > 0 && <p className="warn">{fill(l.unaliasNoDefinition, { from: named(alias.from) })}</p>}
          {plan.fixtures.some((f) => f.after) && <p>{fill(l.unaliasModes, { list: plan.fixtures.map((f) => `${f.name} (${f.before?.mode ?? "—"} → ${f.after?.mode ?? "—"})`).join(", ") })}</p>}
          {plan.repointed.length > 0 && <p className="warn">{fill(plan.repointed.length === 1 ? l.repointedNote : l.repointedNoteMany, { list: plan.repointed.map((x) => named(x.from)).join(", "), from: named(alias.from), to: named(alias.to) })}</p>}
          {changes.length > 0 && <p className="warn">{fill(l.unaliasChannels, { list: changes.map((f) => `${f.name} ${f.before!.channels} → ${f.after!.channels}`).join(", ") })}</p>}
        </>
      )}
      <DialogError error={error} />
      <div className="row">
        <button onClick={onClose}>{t.cancel}</button>
        <button className="primary" disabled={!plan} onClick={go}>
          {l.unaliasIt}
        </button>
      </div>
    </Modal>
  );
}

/** « Vider la corbeille » (show:admin, decision L4): what goes, listed by a dry run, then a yes. */
function EmptyTrashDialog({ l, onClose, onDone }: { l: L; onClose: () => void; onDone: (m: string) => void }): ReactElement {
  const t = useT();
  type Plan = { removed: { id: string; manufacturer: string; model: string; file: string; folder: TrashRow["folder"]; venue?: string; venueName?: string; deletedAt: string }[]; count: number; missing?: string[] };
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState("");
  useEffect(() => void cmd<Plan>("library.trash.empty", { dryRun: true }).then(setPlan, (e: Error) => setError(e.message)), []);
  // only what was listed here goes: a definition put in the trash since stays
  const go = () =>
    void cmd<Plan>("library.trash.empty", { ids: plan!.removed.map((e) => e.id) }).then(
      (r) => onDone(`${fill(l.emptied, { n: r.count })}${r.missing?.length ? ` ${fill(l.emptiedMissing, { n: r.missing.length })}` : ""}`),
      (e: Error) => setError(e.message),
    );
  return (
    <Modal label={l.emptyTrash} className="narrow library-dialog" onClose={onClose}>
      <h3>{l.emptyTrash}</h3>
      <DialogError error={error} />
      {plan && (
        <>
          <p>{plan.count === 1 ? l.emptyTrashAskOne : fill(l.emptyTrashAsk, { n: plan.count })}</p>
          <p className="hint">{l.emptyTrashList}</p>
          <ul className="library-list compact">
            {plan.removed.map((e) => (
              <li key={e.id}>
                {named(e)} · {e.file} · {folderName(l, e.folder)}
                {e.venue ? ` (${e.venueName ?? e.venue})` : ""} · {new Date(e.deletedAt).toLocaleString()}
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="row">
        <button onClick={onClose}>{t.cancel}</button>
        <button className="danger" disabled={!plan || plan.count === 0} onClick={go}>
          {l.emptyForGood}
        </button>
      </div>
    </Modal>
  );
}

/** A file name that wraps in its stem, never inside « .qxf » (a narrow phone column). */
function FileName({ file }: { file: string }): ReactElement {
  const dot = file.toLowerCase().endsWith(".qxf") ? file.length - 4 : file.length;
  return (
    <span className="file">
      <span className="stem">{file.slice(0, dot)}</span>
      <span className="ext">{file.slice(dot)}</span>
    </span>
  );
}

/** « Restaurer »: where it goes back, whether it then wins for its model and whose definition changes, then a yes. */
function RestoreDialog({ entry, l, onClose, onDone }: { entry: TrashRow; l: L; onClose: () => void; onDone: (m: string) => void }): ReactElement {
  const t = useT();
  type Plan = {
    file: string;
    where: string;
    toShared?: boolean;
    displaces?: string;
    displacesWhere?: string;
    identical?: boolean;
    options?: { replace: string; beside: string };
    copies: string[];
    usedBy: { name: string }[];
    otherVenues: { venue: string; name?: string; fixtures: string[] }[];
    refused: boolean;
  };
  const [plan, setPlan] = useState<Plan | null>(null);
  const [as, setAs] = useState<"auto" | "replace" | "beside">("auto");
  const [force, setForce] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => void cmd<Plan>("library.restore", { id: entry.id, dryRun: true }).then(setPlan, (e: Error) => setError(e.message)), [entry.id]);
  const go = () => void cmd<{ file: string; toShared?: boolean }>("library.restore", { id: entry.id, as, force }).then((r) => onDone(fill(r.toShared ? l.restoredToShared : l.restored, { file: r.file })), (e: Error) => setError(e.message));
  const title = fill(l.restoreTitle, { file: entry.file });
  const affected = plan ? [...plan.usedBy.map((u) => u.name), ...plan.otherVenues.map((v) => `${v.name ?? v.venue} (${v.fixtures.join(", ")})`)] : [];
  // with a choice, « replace » is the explicit yes and « beside » changes nothing: only « auto » may need « quand même »
  const needsYes = Boolean(plan?.refused) && as === "auto";
  return (
    <Modal label={title} className="narrow library-dialog" onClose={onClose}>
      <h3>{title}</h3>
      <p className="hint">
        {named(entry)} · {folderName(l, entry.folder)}
        {entry.venue ? ` (${entry.venueName ?? entry.venue})` : ""}
      </p>
      {!plan && !error && <p role="status">{t.loading}</p>}
      {plan && (
        <>
          {plan.toShared && <p className="warn">{fill(l.willGoToShared, { file: plan.file })}</p>}
          {plan.displaces && !plan.options && (
            <p className={plan.identical ? "hint" : "warn"}>
              {fill(l.restoreWins, { file: plan.file, where: plan.where, displaces: plan.displaces, displacesWhere: plan.displacesWhere ?? "" })} {plan.identical ? l.restoreIdentical : ""}
            </p>
          )}
          {plan.options && (
            <fieldset>
              <legend>{l.restoreHow}</legend>
              <label className="inline">
                <input type="radio" name="restore-as" checked={as === "replace"} onChange={() => setAs("replace")} /> {fill(l.restoreReplace, { file: plan.options.replace })}
              </label>
              <label className="inline">
                <input type="radio" name="restore-as" checked={as === "beside"} onChange={() => setAs("beside")} /> {fill(l.restoreBeside, { file: plan.options.beside, current: plan.options.replace })}
              </label>
              <label className="inline">
                <input type="radio" name="restore-as" checked={as === "auto"} onChange={() => setAs("auto")} /> {fill(l.restoreAuto, { file: plan.file })}
              </label>
            </fieldset>
          )}
          {plan.copies.length > 0 && <p className="hint">{fill(l.restoreCopies, { list: plan.copies.map((c) => human(l, c)).join(", ") })}</p>}
          {affected.length > 0 && !plan.identical && as !== "beside" && <p className="warn">{fill(l.restoreChanges, { list: affected.join(", ") })}</p>}
          {needsYes && (
            <label className="inline">
              <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> {l.forceDelete}
            </label>
          )}
        </>
      )}
      <DialogError error={error} />
      <div className="row">
        <button onClick={onClose}>{t.cancel}</button>
        <button className="primary" disabled={!plan || (needsYes && !force)} onClick={go}>
          {l.restoreIt}
        </button>
      </div>
    </Modal>
  );
}
