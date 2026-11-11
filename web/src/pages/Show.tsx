import { beforeMark, quoted } from "../typography";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode, type ReactElement } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { useCommandEvents } from "../hooks/useTopic";
import { labelOf } from "../util";
import { folderLabel, folderOf, foldersOf, inTree, withParents, withoutFolderTag } from "../folder";
import { pick } from "../selection";
import { LookEditor, newLook, type LookDraft } from "../components/LookEditor";
import { Modal } from "../components/Modal";
import { FolderMenu } from "../components/FolderMenu";
import { LookMenu } from "../components/LookMenu";
import { useContextMenu } from "../components/menu";
import { GroupEditor, newGroup, type GroupDraft } from "../components/GroupEditor";
import { FaderEditor, newFader, type FaderDraft } from "../components/FaderEditor";
import { RecentlyDeleted } from "../components/Versions";
import { Proposals } from "../components/Proposals";
import { TypeGroups } from "../components/TypeGroups";
import { ThemePicker } from "../components/ThemePicker";
import { themeLabel, themesOf, type KnowledgeMoods } from "../themes";

interface Look {
  id: string;
  name: string;
  canvas: string;
  technique: { kind: string };
  move?: { shape: string };
  timing: { every: { beats?: number; seconds?: number }; attack: number; order: string };
  tags: string[];
  active: boolean;
  /** Dominant colour of the look (look.list), for the dot before its name. */
  swatch?: string;
}
interface Group {
  id: string;
  name: string;
  exclusive: boolean;
  master?: { level: number; mute: boolean };
  limits?: { min?: number; max?: number; mode?: "clamp" | "scale" };
  members: { fixtures: string[]; looks: string[]; groups: string[] };
  effectiveLevel: number;
}
interface ChannelFader extends FaderDraft {
  id: string;
  name: string;
  level: number;
  channels: { fixture: string; offset: number }[];
}
interface Canvas {
  id: string;
  name: string;
  cells: number;
}
interface Lint {
  ok: boolean;
  issues: { level: string; where: string; message: string }[];
}
/** What the pointer drags: picked looks, or a folder heading to nest elsewhere. */
type Carry = { kind: "looks"; ids: string[] } | { kind: "folder"; path: string };
interface Settings {
  safeLook?: string;
  safeSnapshot?: string;
  startupSnapshot?: string;
  grandMaster: number;
  liveAi?: boolean;
  looksMerge?: "last" | "highest";
  /** Folders named ahead for this show (show.folder.create), to group even before a look carries them. */
  folders?: string[];
}
interface Snapshot {
  id: string;
  name: string;
  looks: string[];
  groups: Record<string, { level: number; mute: boolean }>;
  faders: Record<string, number>;
  blackout: boolean;
  savedAt?: string;
}

export function ShowPage(): ReactElement {
  const t = useT();
  const [looks, setLooks] = useState<Look[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [faders, setFaders] = useState<ChannelFader[]>([]);
  const [canvases, setCanvases] = useState<Canvas[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [snapshotName, setSnapshotName] = useState("");
  const [lint, setLint] = useState<Lint | null>(null);
  const [intent, setIntent] = useState({ name: "", mood: [] as string[], canvas: "", energy: "" });
  const [knowledge, setKnowledge] = useState<KnowledgeMoods | null>(null);
  const [proposal, setProposal] = useState<{ explanation: string[]; unknownMoods: string[] } | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<LookDraft | null>(null);
  /** The look whose right-click menu is open, and where. */
  const [lookMenu, setLookMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const rowMenu = useContextMenu<string>((at, id) => setLookMenu({ id, ...at }));
  /** The folder header whose right-click menu is open (renamed or disbanded from there). */
  const [folderMenu, setFolderMenu] = useState<{ folder: string; x: number; y: number } | null>(null);
  const folderRowMenu = useContextMenu<string>((at, path) => setFolderMenu({ folder: path, ...at }));
  /** The looks picked to be moved together (⌘/Ctrl: one, Shift: framed from the anchor). */
  const [selection, setSelected] = useState<string[]>([]);
  const anchor = useRef<string | undefined>(undefined);
  /** A looks list mirroring the latest render, for the pointer listeners that live for the page. */
  const looksRef = useRef(looks);
  looksRef.current = looks;
  const pressed = useRef<(Carry & { x: number; y: number }) | null>(null);
  const dragging = useRef(false);
  /** What the pointer carries once it moved enough: picked looks, or a folder to nest elsewhere. */
  const [carried, setCarried] = useState<Carry | null>(null);
  /** The header hovered during a drag: undefined = none, "" = « sans dossier », or the folder name. */
  const [dropTarget, setDropTarget] = useState<string | null | undefined>(undefined);
  /** The member look row hovered during a drag: dropping there files into that look's folder. */
  const [dropRow, setDropRow] = useState<string | null>(null);
  /** The click that follows a real drag must not launch the look under it. */
  const afterDrag = useRef(false);
  /** The ghost label that follows the pointer while the picked looks are dragged. */
  const ghostEl = useRef<HTMLDivElement | null>(null);
  /** A folder named here takes the looks picked in the list (a folder only exists through its looks). */
  const [folderBar, setFolderBar] = useState(false);
  const [folderDraft, setFolderDraft] = useState("");
  const [editingGroup, setEditingGroup] = useState<GroupDraft | null>(null);
  const [editingFader, setEditingFader] = useState<FaderDraft | null>(null);
  const [lookSearch, setLookSearch] = useState("");
  const [folder, setFolder] = useState("");
  /** The folders folded up by their header; empty, every group is unfolded (the imported lists stay readable at a glance). */
  const [folded, setFolded] = useState<Set<string>>(new Set());
  /** Fixture and channel names, to show what a channel fader drives instead of ids and offsets. */
  const [channelNames, setChannelNames] = useState<Record<string, { name: string; channels: string[] }>>({});

  const refresh = useCallback(() => {
    void cmd<Look[]>("look.list", { brief: true }).then(setLooks).catch((e: Error) => setError(e.message));
    void cmd<Group[]>("group.list").then(setGroups).catch(() => undefined);
    void cmd<ChannelFader[]>("fader.list").then(setFaders).catch(() => undefined);
    void cmd<Canvas[]>("venue.canvas.list").then((c) => {
      setCanvases(c);
      setIntent((i) => (i.canvas || !c[0] ? i : { ...i, canvas: c[0].id }));
    });
    void cmd<Settings>("show.settings").then(setSettings).catch(() => undefined);
    void cmd<KnowledgeMoods>("knowledge.get").then(setKnowledge).catch(() => undefined);
    void cmd<Snapshot[]>("snapshot.list").then(setSnapshots).catch(() => undefined);
    void cmd<{ id: string; name: string; channels: { offset: number; name: string }[] }[]>("venue.fixture.channels")
      .then((l) => setChannelNames(Object.fromEntries(l.map((f) => [f.id, { name: f.name, channels: f.channels.map((c) => c.name) }]))))
      .catch(() => undefined);
  }, []);
  useEffect(refresh, [refresh]);
  useCommandEvents(["look.", "group.", "fader.", "import.", "show.settings", "show.folder", "show.autopresets", "song.grid_fill", "snapshot."], refresh);
  const run = (name: string, args: unknown = {}) => cmd(name, args).catch((e: Error) => setError(e.message));

  const themes = useMemo(() => themesOf(knowledge), [knowledge]);
  const intentArgs = (save: boolean) => ({
    name: intent.name || intent.mood.map((m) => themeLabel(themes, m)).join(", "),
    canvas: intent.canvas,
    mood: intent.mood,
    ...(intent.energy ? { energy: intent.energy } : {}),
    save,
  });
  // the folders in use — a look counts under its first named dossier: tag, an empty one counts for
  // nothing — plus the ones named ahead (show.folder.create) which exist empty until dissolved
  // (a nested one brings its parents: « A » heads « A/B » and has its menu even without a look of its own)
  const savedFolders = useMemo(() => new Set(settings?.folders ?? []), [settings]);
  const folders = useMemo(() => withParents([...foldersOf(looks), ...(settings?.folders ?? [])]), [looks, settings]);
  const actifFolder = folders.includes(folder) ? folder : "";
  // a folder chosen for the filter and vanished since no longer filters, and does not silently come back when a later folder takes the same name
  useEffect(() => {
    if (folders.length > 0 && !folders.includes(folder)) setFolder("");
  }, [folders, folder]);
  const needle = lookSearch.trim().toLowerCase();
  const shownLooks = useMemo(
    () =>
      looks.filter(
        (l) =>
          // the filter follows the tree: a folder shows its looks and the ones of its sub-folders
          (!actifFolder || inTree(l.tags, actifFolder)) &&
          (!needle || [l.name, l.id, labelOf(t.techniqueNames, l.technique.kind), ...l.tags].some((s) => s.toLowerCase().includes(needle))),
      ),
    [looks, actifFolder, needle, t],
  );
  const shownIds = useMemo(() => new Set(shownLooks.map((l) => l.id)), [shownLooks]);
  // a selection with a look deleted since loses it
  useEffect(() => setSelected((s) => (s.length ? s.filter((id) => looks.some((l) => l.id === id)) : s)), [looks]);
  // Échap désélectionne, comme en édition d'un dashboard
  useEffect(() => {
    if (!selection.length) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setSelected([]);
      anchor.current = undefined;
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [selection.length]);
  // the drag of picked looks onto a folder header (mouse or pen: a touch finger keeps scrolling, and
  // its menus move looks): one move command per drop, the looks read whole server-side
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const p = pressed.current;
      if (!p) return;
      if (!dragging.current) {
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < 8) return;
        dragging.current = true;
        setCarried(p.kind === "looks" ? { kind: "looks", ids: p.ids } : { kind: "folder", path: p.path });
      }
      // the ghost label is moved straight in the DOM: a state per pixel move would re-render the page
      const at2 = ghostEl.current;
      if (at2) {
        at2.style.left = `${e.clientX + 14}px`;
        at2.style.top = `${e.clientY + 14}px`;
      }
      // a header highlights itself, a member look row lights too: it is a drop target of its own now
      const over = elementAt(e.clientX, e.clientY);
      setDropTarget(over.rowId ? null : over.header);
      setDropRow(over.rowId ?? null);
    };
    /** What the pointer stands on while dragging: a group header (its folder) or a member row (its look, whose folder answers). */
    const elementAt = (x: number, y: number): { header?: string; rowId?: string } => {
      const el = document.elementFromPoint(x, y)?.closest("tr") as HTMLTableRowElement | null;
      const rowId = el?.getAttribute("data-look") ?? undefined;
      return { rowId, header: rowId ? undefined : el?.classList.contains("group-row") ? el.dataset.folder ?? "" : undefined };
    };
    let release: number | undefined;
    const settle = (start: boolean) => {
      dragging.current = false;
      setCarried(null);
      setDropTarget(undefined);
      setDropRow(null);
      if (start) {
        afterDrag.current = true;
        window.clearTimeout(release);
        release = window.setTimeout(() => (afterDrag.current = false), 500);
      }
    };
    const drop = (e: PointerEvent) => {
      const p = pressed.current;
      pressed.current = null;
      if (!p || !dragging.current) return;
      settle(true);
      const { header, rowId } = elementAt(e.clientX, e.clientY);
      // dropped on a member row: the look's own folder answers (a folder nests into it as well)
      const target = rowId ? folderOf(looksRef.current.find((l) => l.id === rowId)?.tags ?? []) : header;
      if (target === undefined) return;
      if (p.kind === "folder") {
        // a folder dropped on a header nests it there (or back to the top on « sans dossier »); its own header and its own subtree change nothing
        if (target === p.path || target.startsWith(p.path + "/")) return;
        void run("show.folder.nest", { src: p.path, ...(target ? { under: target } : {}) });
        return;
      }
      // dropping back in the folder the looks already sit in would only churn versions
      if (p.ids.every((id) => folderOf(looksRef.current.find((l) => l.id === id)?.tags ?? []) === target)) return;
      void run("show.folder.move", { ids: p.ids, ...(target ? { folder: target } : {}) });
    };
    const cancel = () => {
      if (!pressed.current) return;
      pressed.current = null;
      settle(true);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", drop);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", drop);
      window.removeEventListener("pointercancel", cancel);
      window.clearTimeout(release);
    };
  }, []);
  /** « Spot 3 · Dimmer/CW » per fixture, in the order of the fader's channels; ids for an unknown fixture. */
  const faderTargets = (f: ChannelFader) => {
    const byFixture = new Map<string, number[]>();
    for (const c of f.channels) byFixture.set(c.fixture, [...(byFixture.get(c.fixture) ?? []), c.offset]);
    return [...byFixture]
      .map(([id, offsets]) => {
        const known = channelNames[id];
        return known ? `${known.name} · ${offsets.map((o) => known.channels[o] ?? `ch ${o + 1}`).join("/")}` : `${id}+${offsets.map((o) => o + 1).join("/")}`;
      })
      .join(", ");
  };
  /** What a group drives, zeros left out: a DCA of channel faders is not « empty » (it scales them). */
  const groupSummary = (g: Group) =>
    [
      [g.members.looks.length, "looks"],
      [g.members.fixtures.length, "fixtures"],
      [g.members.groups.length, t.subGroups.toLowerCase()],
      [faders.filter((f) => f.dca === g.id).length, t.fadersCount],
    ]
      .filter(([n]) => n)
      .map(([n, what]) => `${n} ${what}`)
      .join(" · ") || "—";
  /** « ✖ 2 erreurs · ⚠ 4 alertes », or « ✔ Rien à signaler »: a check mark above six warnings misled. */
  const rank = (level: string) => (level === "erreur" ? 0 : level === "info" ? 2 : 1);
  const lintSummary = (l: Lint) => {
    const errors = l.issues.filter((i) => i.level === "erreur").length;
    // information notes (a gap in the patch, a proposal): nothing wrong
    const infos = l.issues.filter((i) => i.level === "info").length;
    const warnings = l.issues.length - errors - infos;
    if (!l.issues.length) return `✔ ${t.lintClean}`;
    return [errors ? `✖ ${errors} ${t.lintErrors}` : "✔", warnings ? `⚠ ${warnings} ${t.lintWarnings}` : "", infos ? `ℹ ${infos} ${t.lintInfos}` : ""].filter(Boolean).join(" · ");
  };
  const cadence = (l: Look) => ("beats" in l.timing.every && l.timing.every.beats ? `${l.timing.every.beats} ${t.beatsShort}` : `${l.timing.every.seconds} s`);
  /** The folder named in the bar takes the picked looks; bare-handed, it is born empty (show.folder.create). */
  const createFolder = () => {
    const name = folderDraft.trim();
    if (!name) return;
    // the bar stays open with the name typed while the server refuses it (« Sans dossier »…): it is said, then fixed in place
    void cmd(selection.length ? "show.folder.move" : "show.folder.create", selection.length ? { ids: selection, folder: name } : { folder: name }).then(
      () => {
        if (selection.length) {
          setSelected([]);
          anchor.current = undefined;
        }
        setFolderBar(false);
        setFolderDraft("");
        setError("");
      },
      (e: Error) => setError(e.message),
    );
  };
  /** The ghost label a drag carries: the look's name (or the count), or the folder's name. */
  const carryLabel = carried
    ? carried.kind === "folder"
      ? carried.path.slice(carried.path.lastIndexOf("/") + 1)
      : (() => {
          const names = carried.ids.map((id) => looksRef.current.find((x) => x.id === id)?.name).filter(Boolean);
          return names.length === 1 ? names[0] : `${names.length} looks · ${names.slice(0, 2).join(", ")}${names.length > 2 ? ", …" : ""}`;
        })()
    : "";
  /** ⌘/Ctrl or Shift on a look's click selects instead of launching (the picked ones drag together). */
  const pickClick = (l: Look, e: ReactMouseEvent) => {
    if (!e.metaKey && !e.ctrlKey && !e.shiftKey) return false;
    e.preventDefault();
    const boxes = shownLooks.map((x, i) => ({ id: x.id, x: 0, y: i, w: 1, h: 1 }));
    const at = boxes.findIndex((b) => b.id === l.id);
    if (at >= 0) {
      const got = pick(boxes, selection, anchor.current, boxes[at]!, { add: e.metaKey || e.ctrlKey, frame: e.shiftKey });
      anchor.current = got.anchor;
      setSelected(got.selection);
    }
    return true;
  };
  const lookRow = (l: Look, depth = 0) => (
    <tr
      key={l.id}
      data-look={l.id}
      className={`${folders.length > 0 && folderOf(l.tags) ? "member" : ""}${selection.includes(l.id) ? " selected" : ""}${carried?.kind === "looks" && carried.ids.includes(l.id) ? " dragging" : ""}${carried && dropRow === l.id ? " drop-row" : ""}`}
      style={depth ? ({ "--depth": depth } as CSSProperties) : undefined}
      title={t.lookRowHint}
      {...rowMenu(l.id)}
      onDragStart={(e) => e.preventDefault()} // the browser's own text drag would take the pointer over
      onContextMenu={(e) => {
        // Ctrl+click on a mac keyboard is a right-click for the browser: here it selects, like ⌘
        if (e.ctrlKey && !e.metaKey && !e.shiftKey) {
          e.preventDefault();
          pickClick(l, e);
          return;
        }
        rowMenu(l.id).onContextMenu(e); // the true right-click opens the look's menu
      }}
      onPointerDown={(e) => {
        rowMenu(l.id).onPointerDown(e); // the long press of a touch keeps its menu
        if (e.pointerType === "touch" || e.button !== 0) return;
        pressed.current = { kind: "looks", ids: selection.includes(l.id) ? selection.filter((id) => shownIds.has(id)) : [l.id], x: e.clientX, y: e.clientY };
      }}
    >
      <td style={depth ? ({ "--depth": depth } as CSSProperties) : undefined}>
        {folders.length > 0 && <span className="grip" aria-hidden />}
        {/* the branch of the look flows through its members: the last leg, its folder's own, in accent */}
        {depth > 0 && folderOf(l.tags) && <span className="spine" aria-hidden style={{ "--depth": depth } as CSSProperties} />}
        <button
          className={`look ${l.active ? "on" : ""}`}
          title={t.selectLooks}
          onClick={(e) => {
            if (pickClick(l, e) || afterDrag.current) return;
            void run(l.active ? "look.stop" : "look.go", { id: l.id });
          }}
        >
          {l.swatch && <span className="swatch-dot" style={{ background: l.swatch }} aria-hidden />}
          {l.name}
        </button>
      </td>
      <td>
        {labelOf(t.techniqueNames, l.technique.kind)}
        {l.move && <small> · ↻ {labelOf(t.moveShapes, l.move.shape)}</small>}
      </td>
      <td>{cadence(l)}</td>
      <td>{l.timing.attack < 0.2 ? t.snap : l.timing.attack > 0.8 ? t.breathe : `${Math.round(l.timing.attack * 100)} %`}</td>
      <td>{labelOf(t.orders, l.timing.order)}</td>
      <td>
        <small>{withoutFolderTag(l.tags).join(" · ")}</small>
      </td>
      <td>
        <button
          className="ghost"
          title={t.edit}
          aria-label={`${t.edit} ${l.name}`}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey) return; // the click selects, the edit stays at the plain click
            void cmd<LookDraft>("look.get", { id: l.id }).then(setEditing, (e2: Error) => setError(e2.message)) /* the list is brief: the editor needs the whole look */;
          }}
        >
          ✎
        </button>
      </td>
    </tr>
  );
  /** The folders as a tree: a look stands under the deepest header of its path, a header's count includes its subtree; « sans dossier » is the node of the looks without any folder. */
  type FolderNode = { path: string; segment: string; rows: Look[]; children: FolderNode[]; total: number };
  const tree = (() => {
    const container: FolderNode = { path: "root", segment: "", rows: [], children: [], total: 0 };
    const sans: FolderNode = { path: "", segment: "", rows: [], children: [], total: 0 };
    const by = new Map<string, FolderNode>([["", sans]]);
    const ensure = (path: string): FolderNode => {
      const found = by.get(path);
      if (found) return found;
      const cut = path.lastIndexOf("/");
      const node: FolderNode = { path, segment: path.slice(cut + 1), rows: [], children: [], total: 0 };
      ensure(cut === -1 ? "" : path.slice(0, cut)); // the parents exist so a path finds its way down
      const parent = cut === -1 ? container : by.get(path.slice(0, cut))!;
      parent.children.push(node);
      by.set(path, node);
      return node;
    };
    for (const f of folders) ensure(f); // the ones named ahead, empty at best
    for (const l of shownLooks) {
      const p = folderOf(l.tags);
      if (p) ensure(p).rows.push(l);
      else sans.rows.push(l);
    }
    const settle = (n: FolderNode) => {
      n.children.sort((a, b) => a.segment.localeCompare(b.segment));
      n.total = n.rows.length + n.children.reduce((sum, c) => (settle(c), sum + c.total), 0);
    };
    settle(container);
    settle(sans);
    return { sans, container };
  })();
  const renderNode = (n: FolderNode, depth: number): ReactNode => {
    const nested = n.children.flatMap((c) => renderNode(c, depth + 1));
    // at rest a folder named ahead shows its empty header: there are looks to drop on it; a search or the filter shows only what matched
    if (n.total === 0 && !(savedFolders.has(n.path) && !needle && !actifFolder) && nested.length === 0) return null;
    const open = !folded.has(n.path);
    return (
      <Fragment key={`folder-${n.path}`}>
        <tr
          className={`group-row${dropTarget === n.path ? " drop" : ""}`}
          data-folder={n.path}
          onDragStart={(e) => e.preventDefault()}
          {...(n.path !== "" ? folderRowMenu(n.path) : {})}
          onPointerDown={(e) => {
            if (n.path !== "") folderRowMenu(n.path).onPointerDown(e); // a touch long-press opens the header's menu
            if (n.path === "" || e.pointerType === "touch" || e.button !== 0) return;
            pressed.current = { kind: "folder", path: n.path, x: e.clientX, y: e.clientY };
          }}
        >
          {/* as wide as the whole header (7 columns); a nested header is indented under its parent */}
          <td colSpan={7}>
            <button className={depth ? "nested" : undefined} style={depth ? ({ "--depth": depth } as CSSProperties) : undefined} aria-expanded={open} title={open ? t.collapse : t.expand} onClick={() => setFolded((s) => { const next = new Set(s); if (next.has(n.path)) next.delete(n.path); else next.add(n.path); return next; })}>
              {depth > 0 && <span className="rails" aria-hidden />}
              <span className="grip" aria-hidden />
              <span className="fold" aria-hidden>{open ? "▾" : "▸"}</span>
              {" "}
              {n.path === "" ? t.noFolder : n.segment} (<span className="count">{n.total}</span>)

            </button>
          </td>
        </tr>
        {open && nested}
        {open && n.rows.map((l) => lookRow(l, depth))}
      </Fragment>
    );
  };

  return (
    <div className="show">
      <Proposals onChanged={refresh} />
      <section className="bar">
        <label title={t.safeStateHelp}>
          {t.safeState}{" "}
          <select
            value={settings?.safeSnapshot ? `snapshot:${settings.safeSnapshot}` : settings?.safeLook ? `look:${settings.safeLook}` : ""}
            onChange={(e) => {
              const [kind, id] = e.target.value.split(/:(.*)/);
              // null clears: a key set to undefined would vanish from the JSON and the server keep the old one
              // one fallback at a time: a look left behind a snapshot would come back silently were the snapshot deleted
              void run("show.settings.set", kind === "snapshot" ? { safeSnapshot: id, safeLook: null } : { safeSnapshot: null, safeLook: kind === "look" ? id : null });
            }}
          >
            <option value="">{t.none} ({t.blackout})</option>
            <optgroup label={t.snapshots}>
              {snapshots.map((s) => (
                <option key={s.id} value={`snapshot:${s.id}`}>
                  {s.name}
                </option>
              ))}
            </optgroup>
            <optgroup label={t.looks}>
              {looks.map((l) => (
                <option key={l.id} value={`look:${l.id}`}>
                  {l.name}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        <label title={t.startupSnapshotHelp}>
          {t.startupSnapshot}{" "}
          <select
            data-testid="startup-snapshot"
            value={settings?.startupSnapshot ?? ""}
            // null clears: a key set to undefined would vanish from the JSON and the server keep the old one
            onChange={(e) => void run("show.settings.set", { startupSnapshot: e.target.value || null })}
          >
            <option value="">{t.none}</option>
            {snapshots.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label title={t.looksMergeHelp}>
          {t.looksMerge}{" "}
          <select value={settings?.looksMerge ?? "last"} onChange={(e) => void run("show.settings.set", { looksMerge: e.target.value })}>
            <option value="last">{t.looksMergeLast}</option>
            <option value="highest">{t.looksMergeHighest}</option>
          </select>
        </label>
        <label className={`inline ${settings?.liveAi ? "live-ai on" : "live-ai"}`} title={t.liveAiHelp}>
          <input type="checkbox" checked={Boolean(settings?.liveAi)} onChange={(e) => void run("show.settings.set", { liveAi: e.target.checked })} /> {t.liveAi}
        </label>
        <button onClick={() => void cmd<Lint>("show.lint").then(setLint)}>{t.lint}</button>
        <button
          title={t.autopresetsHelp}
          onClick={() =>
            void cmd<{ created: string[]; kept: string[]; canvas: string; safeLook?: string }>("show.autopresets", {})
              .then((p) => {
                if (!p.created.length) return setError(t.autopresetsNothing);
                const summary = `${t.autopresets} (${p.canvas}) :\n${p.created.join("\n")}${p.safeLook ? `\n\n${t.safeLook} : ${p.safeLook}` : ""}`;
                if (confirm(summary)) return cmd("show.autopresets", { apply: true }).then(refresh);
              })
              .catch((e: Error) => setError(e.message))
          }
        >
          ★ {t.autopresets}
        </button>
        {error && (
          <span className="error" onClick={() => setError("")}>
            {error}
          </span>
        )}
      </section>

      {lint && (
        <div className="report lint-report" role="status">
          <div className="row">
            <strong>{lintSummary(lint)}</strong>
            <span className="grow" />
            <button className="ghost" aria-label={t.close} onClick={() => setLint(null)}>
              ✕
            </button>
          </div>
          <ul className="warnings">
            {[...lint.issues]
              .sort((a, b) => rank(a.level) - rank(b.level)) /* errors first, notes last */
              .map((i, k) => (
                <li key={k} className={i.level === "erreur" ? "error" : i.level === "info" ? "hint" : ""}>
                  {i.level === "erreur" ? "✖" : i.level === "info" ? "ℹ" : "⚠"} {i.where} : {i.message}
                </li>
              ))}
          </ul>
          <TypeGroups onError={setError} onApplied={() => void cmd<Lint>("show.lint").then(setLint)} />
        </div>
      )}

      <section className="snapshots">
        <h2>{t.snapshots}</h2>
        <p className="hint">{t.snapshotsHelp}</p>
        <div className="row">
          <input aria-label={t.snapshotName} placeholder={t.snapshotName} value={snapshotName} onChange={(e) => setSnapshotName(e.target.value)} />
          <button className="primary" disabled={!snapshotName.trim()} onClick={() => void run("snapshot.save", { name: snapshotName.trim() }).then(() => setSnapshotName(""))}>
            {t.saveSnapshot}
          </button>
        </div>
        {snapshots.length === 0 && <p className="hint">{t.noSnapshots}</p>}
        <table className="listing" hidden={snapshots.length === 0}>
          <thead><tr><th>{t.cols.snapshot}</th><th>{t.cols.content}</th><th /></tr></thead>
          <tbody>
            {snapshots.map((s) => (
              <tr key={s.id}>
                <td>
                  {s.name}
                  {settings?.safeSnapshot === s.id && <>{" "}<span className="badge standby">{t.safeBadge}</span></>}
                  {settings?.startupSnapshot === s.id && <>{" "}<span className="badge standby">{t.startupBadge}</span></>}
                </td>
                <td className="hint">
                  {s.looks.length} look(s) · {Object.keys(s.groups).length} DCA · {Object.keys(s.faders).length} fader(s){s.blackout ? " · Blackout" : ""}
                </td>
                <td className="row">
                  <button onClick={() => void run("snapshot.recall", { id: s.id })}>{t.recall}</button>
                  <button title={t.overwriteHelp} onClick={() => confirm(`${t.overwriteConfirm} ${quoted(t, s.name)}`) && void run("snapshot.save", { id: s.id, name: s.name })}>
                    {t.overwrite}
                  </button>
                  <button className="ghost" onClick={() => confirm(`${t.delete} ${quoted(t, s.name)}${beforeMark(t)}?`) && void run("snapshot.delete", { id: s.id })}>
                    {t.delete}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>{t.fromIntent}</h2>
        {canvases.length === 0 && <p className="hint">{t.needCanvas}</p>}
        <div className="editor">
          <ThemePicker themes={themes} chosen={intent.mood} onChange={(mood) => setIntent((i) => ({ ...i, mood }))} />
          <input placeholder={t.name} value={intent.name} onChange={(e) => setIntent({ ...intent, name: e.target.value })} />
          <select aria-label={t.energy} value={intent.energy} onChange={(e) => setIntent({ ...intent, energy: e.target.value })}>
            <option value="">
              {t.energy} {t.auto}
            </option>
            {(["pose", "dynamique", "survolte"] as const).map((e) => (
              <option key={e} value={e}>
                {t.energies[e]}
              </option>
            ))}
          </select>
          <select aria-label={t.canvas} value={intent.canvas} onChange={(e) => setIntent({ ...intent, canvas: e.target.value })}>
            {canvases.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.cells})
              </option>
            ))}
          </select>
          <button disabled={intent.mood.length === 0 || !intent.canvas} onClick={() => void cmd<{ explanation: string[]; unknownMoods: string[] }>("look.from_intent", intentArgs(false)).then(setProposal).catch((e: Error) => setError(e.message))}>
            {t.dryRun}
          </button>
          <button className="primary" disabled={intent.mood.length === 0 || !intent.canvas} onClick={() => void run("look.from_intent", intentArgs(true)).then(() => setProposal(null))}>
            {t.apply}
          </button>
        </div>
        {proposal && (
          <ul className="hint">
            {proposal.explanation.map((x) => (
              <li key={x}>{x}</li>
            ))}
            {proposal.unknownMoods.length > 0 && <li className="warn">? {proposal.unknownMoods.join(", ")}</li>}
          </ul>
        )}
      </section>

      {editing && (
        <Modal label={editing.name || t.newLook}>
          <LookEditor
            key={editing.id || "new"}
            initial={editing}
            existing={looks.map((l) => l.id)}
            folders={folders}
            onClose={() => {
              setEditing(null);
              refresh();
            }}
          />
        </Modal>
      )}

      <section>
        <h2>
          {t.looks} ({shownLooks.length === looks.length ? looks.length : `${shownLooks.length} / ${looks.length}`}){" "}
          <button className="ghost" onClick={() => setEditing(newLook(canvases[0]?.id ?? ""))}>
            + {t.newLook}
          </button>{" "}
          <button className="ghost" title={t.folderCreateHelp} aria-pressed={folderBar} onClick={() => setFolderBar(!folderBar)}>
            📁 {t.newFolder}
          </button>
        </h2>
        {folderBar && (
          <div className="editor folder-create">
            <input value={folderDraft} list="show-folder-suggestions" placeholder={t.newFolder} aria-label={t.newFolder} autoFocus onChange={(e) => setFolderDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createFolder()} />
            <datalist id="show-folder-suggestions">
              {folders.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
            <button className="primary" disabled={!folderDraft.trim()} aria-label={t.save} title={t.save} onClick={createFolder}>
              ✔
            </button>
            <button className="ghost" aria-label={t.close} onClick={() => setFolderBar(false)}>
              ✕
            </button>
            <small className="hint">
              {selection.length ? t.folderPicked.replace("{count}", String(selection.length)) : t.folderCreateEmpty}
            </small>
          </div>
        )}
        {looks.length > 8 && (
          <div className="row look-filters">
            <input className="search" type="search" aria-label={t.searchLooks} placeholder={t.searchLooks} title={t.searchLooksHelp} value={lookSearch} onChange={(e) => setLookSearch(e.target.value)} />
            {folders.length > 0 && (
              <select aria-label={t.folder} value={folder} onChange={(e) => setFolder(e.target.value)}>
                <option value="">{t.allFolders}</option>
                {folders.map((f) => (
                  <option key={f} value={f}>
                    {folderLabel(f)}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}
        {looks.length === 0 ? <p className="hint">{t.noLooks}</p> : shownLooks.length === 0 && <p className="hint">{t.noMatch}</p>}
        <table className={`${folders.length ? "listing folder-list" : "listing"}${carried ? " grabbing" : ""}`} hidden={shownLooks.length === 0}>
          <thead><tr><th>{t.cols.look}</th><th>{t.technique}</th><th>{t.timing}</th><th>{t.attack}</th><th>{t.order}</th><th>{t.cols.tags}</th><th /></tr></thead>
          <tbody>
            {folders.length === 0
              ? shownLooks.map((l) => lookRow(l))
              : [...tree.container.children.map((c) => renderNode(c, 0)), renderNode(tree.sans, 0)]}
          </tbody>
        </table>
        {lookMenu &&
          (() => {
            const l = looks.find((x) => x.id === lookMenu.id);
            return l ? <LookMenu key={l.id} look={l} folder={folderOf(l.tags)} folders={folders} at={lookMenu} onEdit={setEditing} onChanged={refresh} onClose={() => setLookMenu(null)} /> : null;
          })()}
        {carried && (
          <div ref={ghostEl} className="drag-ghost" aria-hidden>
            {carryLabel}
          </div>
        )}
        {folderMenu && folders.includes(folderMenu.folder) && <FolderMenu key={folderMenu.folder} folder={folderMenu.folder} at={folderMenu} onChanged={refresh} onClose={() => setFolderMenu(null)} />}
      </section>

      {editingGroup && (
        <Modal label={editingGroup.name || t.newGroup}>
          <GroupEditor
            key={editingGroup.id || "new-group"}
            initial={editingGroup}
            existing={groups.map((g) => g.id)}
            onClose={() => {
              setEditingGroup(null);
              refresh();
            }}
          />
        </Modal>
      )}
      <section>
        <h2>
          {t.groupsDca} ({groups.length}){" "}
          <button className="ghost" onClick={() => setEditingGroup(newGroup())}>
            + {t.newGroup}
          </button>
        </h2>
        {groups.length === 0 && <p className="hint">{t.noGroups}</p>}
        <table className="listing" hidden={groups.length === 0}>
          <thead><tr><th>{t.cols.group}</th><th>{t.exclusive}</th><th>DCA</th><th>{t.cols.limits}</th><th>{t.cols.content}</th></tr></thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.id}>
                <td className="nowrap">
                  <button className="ghost" aria-label={`${t.edit} ${g.name}`} onClick={() => setEditingGroup(g as unknown as GroupDraft)}>
                    ✎
                  </button>{" "}
                  {g.name}
                </td>
                <td>{g.exclusive ? t.exclusive : ""}</td>
                <td className="nowrap">{g.master ? `DCA ${Math.round(g.master.level * 100)} % → ${Math.round(g.effectiveLevel * 100)} %` : ""}</td>
                <td>
                  {g.master && (
                    <span className="row dca-limits">
                      {(["min", "max"] as const).map((k) => (
                        <label key={k} className="inline">
                          {k}
                          <input
                            type="number"
                            min={0}
                            max={100}
                            step={5}
                            aria-label={`${k} ${g.name}`}
                            placeholder={k === "min" ? "0" : "100"}
                            defaultValue={g.limits?.[k] !== undefined ? Math.round(g.limits[k]! * 100) : ""}
                            onBlur={(e) => {
                              const v = e.target.value === "" ? undefined : Number(e.target.value) / 100;
                              const { effectiveLevel: _e, ...group } = g;
                              void run("group.put", { group: { ...group, limits: { ...g.limits, mode: g.limits?.mode ?? "clamp", [k]: v } } }).then(refresh);
                            }}
                          />
                        </label>
                      ))}
                      <select
                        aria-label={`${t.dcaMode} ${g.name}`}
                        value={g.limits?.mode ?? "clamp"}
                        onChange={(e) => {
                          const { effectiveLevel: _e, ...group } = g;
                          void run("group.put", { group: { ...group, limits: { ...g.limits, mode: e.target.value } } }).then(refresh);
                        }}
                      >
                        <option value="clamp">{t.dcaClamp}</option>
                        <option value="scale">{t.dcaScale}</option>
                      </select>
                    </span>
                  )}
                </td>
                <td>
                  <small>{groupSummary(g)}</small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {editingFader && (
        <Modal label={editingFader.name || t.newFader}>
          <FaderEditor
            key={editingFader.id || "new-fader"}
            initial={editingFader}
            existing={faders.map((f) => f.id)}
            onClose={() => {
              setEditingFader(null);
              refresh();
            }}
          />
        </Modal>
      )}
      <section>
        <h2>
          {t.channelFaders} ({faders.length}){" "}
          <button className="ghost" onClick={() => setEditingFader(newFader())}>
            + {t.newFader}
          </button>
        </h2>
        <p className="hint">{t.channelFadersHelp}</p>
        {faders.length === 0 && <p className="hint">{t.noFaders}</p>}
        <table className="listing" hidden={faders.length === 0}>
          <thead><tr><th>{t.cols.fader}</th><th>{t.cols.channels}</th><th>{t.cols.level}</th></tr></thead>
          <tbody>
            {faders.map((f) => (
              <tr key={f.id}>
                <td className="nowrap">
                  <button className="ghost" aria-label={`${t.edit} ${f.name}`} onClick={() => setEditingFader(f)}>
                    ✎
                  </button>{" "}
                  {f.name}
                </td>
                <td>
                  <small>{faderTargets(f)}</small>
                </td>
                <td>{Math.round(f.level * 100)} %</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section>
        <RecentlyDeleted collections={["looks", "groups", "faders"]} onRestored={refresh} />
      </section>
    </div>
  );
}
