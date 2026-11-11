/**
 * The DMX mode of a patched fixture, in its menu (T6, docs/specs/venue-fixtures-stage.md, « Mode DMX d'un
 * appareil »): its definition's modes in a list (ModePicker), the current one marked. Picking another asks
 * venue.fixture.mode for its plan first (dryRun: what moves, what is lost, overlaps, canvas cells left dark,
 * looks restarted) and shows it; « Appliquer » writes it — after a confirmation naming the losses and the
 * overlaps, then forced. On a venue shared with other shows, the two ways are offered first; choosing one
 * reads the plan again that way (for every show: their losses too; a venue of the show's own: the looks that
 * stop when it is reopened on it), then « Appliquer » confirms. Once applied, « Défaire » takes the mode back
 * (show.revert) — not the venue copy, which stays, and says so.
 */
import { useEffect, useRef, useState, type ReactElement } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { quoted } from "../typography";
import { ModePicker, type ModeItem } from "./ModePicker";

interface Plan {
  unchanged?: true;
  name: string;
  to: string;
  channels: { before: number | null; after: number };
  address: { universe: number; from: number; to: number };
  moved: { message: string }[];
  lost: { message: string; show?: string }[];
  emptied: { name: string; show?: string; usedBy: string[] }[];
  unreadable: { show: string; errors: string[] }[];
  overlaps: string[];
  freeAddress?: number;
  cellsWithoutRender: { name: string; cells: number[] }[];
  info: string[];
  relaunched: string[];
  sharedWith: string[];
  detach?: { stopped: string[] };
  otherShows?: { show: string; looks: number; faders: number; lost: number }[];
  proposal?: string;
  detached?: boolean;
}
interface LibraryDef {
  manufacturer: string;
  model: string;
  modes: { name: string; channels: number }[];
}
type Shared = "copy" | "all";
interface Done {
  mode: string;
  proposal?: string;
  detached?: boolean;
}

/** The last change made from a fixture's menu in this page, so that reopening the menu still offers its undo. */
const lastChange = new Map<string, Done>();

export function DmxModeSection({ fixture, onSaved }: { fixture: { id: string; manufacturer?: string; model?: string; mode?: string }; onSaved: () => void }): ReactElement | null {
  const t = useT();
  const tm = t.fixtureMode;
  const [modes, setModes] = useState<LibraryDef["modes"] | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  /** The way chosen on a shared venue; the plan shown was read that way. */
  const [choice, setChoice] = useState<Shared | undefined>(undefined);
  const [done, setDone] = useState<Done | null>(() => lastChange.get(fixture.id) ?? null);
  /** What the last undo said (the venue copy kept, objects left as they were). */
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLFieldSetElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  /** Where the focus goes once the next render is on screen (the triggering control is gone by then). */
  const focusNext = useRef<"status" | "current" | null>(null);
  // a plan shown below the list is brought into the menu's view once, when it comes
  const planBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // in a block: Chromium's scrollIntoView now returns a promise, which React would take for a cleanup
    void planBox.current?.scrollIntoView({ block: "nearest" });
  }, [plan]);
  useEffect(() => {
    // kept until its target is on screen: a render of the parent may come before the one that shows it
    const target = focusNext.current === "status" ? status.current : focusNext.current === "current" ? box.current?.querySelector<HTMLElement>('.mode-list button[aria-current="true"]') : null;
    if (!target) return;
    focusNext.current = null;
    target.focus();
  });
  useEffect(() => {
    if (!fixture.model) return;
    void cmd<LibraryDef[]>("venue.library", { search: fixture.model })
      .then((defs) => setModes(defs.find((d) => d.manufacturer === fixture.manufacturer && d.model === fixture.model)?.modes ?? []))
      .catch(() => setModes([]));
  }, [fixture.manufacturer, fixture.model]);
  if (!fixture.model || modes === null) return null;

  const preview = (mode: string, shared?: Shared) => {
    setError("");
    setNote("");
    setChoice(shared);
    if (mode === fixture.mode) return setPlan(null);
    void cmd<Plan>("venue.fixture.mode", { id: fixture.id, mode, dryRun: true, ...(shared ? { shared } : {}) }).then((p) => setPlan(p.unchanged ? null : p), (e: Error) => setError(e.message));
  };
  const losses = (p: Plan) => [
    ...p.lost.map((l) => `${l.show ? `${l.show} · ` : ""}${l.message}`),
    ...p.emptied.map((e) => `${e.show ? `${e.show} · ` : ""}${tm.emptied.replace("{name}", e.name)}${e.usedBy.length ? ` (${tm.usedBy.replace("{list}", e.usedBy.join(", "))})` : ""}`),
    ...p.unreadable.map((u) => tm.unreadable.replace("{show}", u.show).replace("{errors}", u.errors.join(" ; "))),
  ];
  const apply = async () => {
    if (!plan) return;
    const lost = losses(plan);
    // what is lost and what overlaps are named before it is forced: one more yes
    if (lost.length || plan.overlaps.length) {
      const parts = [lost.length ? `${tm.lostHeading}\n${lost.map((l) => `• ${l}`).join("\n")}` : "", plan.overlaps.length ? `${tm.overlapHeading}\n${plan.overlaps.map((o) => `• ${o}`).join("\n")}` : ""].filter(Boolean);
      if (!confirm(tm.forceConfirm.replace("{list}", parts.join("\n\n")))) return;
    }
    setBusy(true);
    setError("");
    try {
      const r = await cmd<Plan>("venue.fixture.mode", { id: fixture.id, mode: plan.to, force: lost.length > 0 || plan.overlaps.length > 0, ...(choice ? { shared: choice } : {}) });
      const next: Done = { mode: r.to, ...(r.proposal ? { proposal: r.proposal } : {}), ...(r.detached ? { detached: true } : {}) };
      lastChange.set(fixture.id, next);
      focusNext.current = "status"; // before the updates: the render that shows the status line takes it
      setDone(next);
      setPlan(null);
      setChoice(undefined);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const cancel = () => {
    focusNext.current = "current";
    setPlan(null);
    setChoice(undefined);
  };
  const undo = async () => {
    if (!done?.proposal) return;
    setError("");
    try {
      const r = await cmd<{ warnings?: string[] }>("show.revert", { id: done.proposal });
      lastChange.delete(fixture.id);
      focusNext.current = "status";
      setNote([done.detached ? tm.undoneCopy : tm.undone, r.warnings?.length ? tm.undoWarnings.replace("{list}", r.warnings.join(" ; ")) : ""].filter(Boolean).join(" "));
      setDone(null);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const items: ModeItem[] = modes.map((m) => ({ key: m.name, label: m.name, detail: tm.channels.replace("{n}", String(m.channels)), current: m.name === fixture.mode }));
  const others = plan?.sharedWith ?? [];
  const lostList = plan ? losses(plan) : [];
  const nothing = plan && !plan.moved.length && !lostList.length && !plan.cellsWithoutRender.length;
  return (
    <fieldset className="dmx-mode" ref={box}>
      <legend>{tm.dmxTitle}</legend>
      {modes.length === 0 ? (
        <small className="hint">{tm.noDefinition}</small>
      ) : (
        <>
          <small className="hint">{tm.dmxHelp}</small>
          <ModePicker title={tm.dmxTitle} heading={false} items={items} disabled={busy} onPick={(i) => preview(i.key)} />
        </>
      )}
      {plan && (
        <div className="mode-plan" role="region" aria-label={tm.planTitle.replace("{mode}", plan.to)} ref={planBox}>
          <strong>{tm.planTitle.replace("{mode}", plan.to)}</strong>
          <small>{tm.footprint.replace("{before}", String(plan.channels.before ?? "?")).replace("{after}", String(plan.channels.after)).replace("{u}", String(plan.address.universe)).replace("{from}", String(plan.address.from)).replace("{to}", String(plan.address.to))}</small>
          {nothing && <small className="hint">{tm.nothing}</small>}
          {plan.moved.length > 0 && (
            <details>
              <summary>
                {tm.moved} ({plan.moved.length})
              </summary>
              <ul>
                {plan.moved.map((m, i) => (
                  <li key={i}>{m.message}</li>
                ))}
              </ul>
            </details>
          )}
          {lostList.length > 0 && (
            <div className="warn" role="alert">
              <strong>
                ⚠ {tm.lost} ({lostList.length})
              </strong>
              <ul>
                {lostList.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            </div>
          )}
          {plan.cellsWithoutRender.map((c) => (
            <small key={c.name} className="warn">
              {tm.dark.replace("{name}", c.name).replace("{n}", String(c.cells.length))}
            </small>
          ))}
          {plan.overlaps.length > 0 && (
            <div className="warn" role="alert">
              <strong>⚠ {tm.overlaps}</strong>
              <ul>
                {plan.overlaps.map((o) => (
                  <li key={o}>{o}</li>
                ))}
              </ul>
              {plan.freeAddress !== undefined && <small>{tm.freeAddress.replace("{u}", String(plan.address.universe)).replace("{a}", String(plan.freeAddress))}</small>}
            </div>
          )}
          {plan.info.length > 0 && (
            <small className="hint">
              {tm.info}
              {t.colon} {plan.info.join(" ; ")}
            </small>
          )}
          {plan.relaunched.length > 0 && <small className="warn">{tm.relaunched.replace("{list}", plan.relaunched.join(", "))}</small>}
          {others.length > 0 && !choice && <small className="warn">{tm.shared.replace("{list}", others.join(", "))}</small>}
          {choice === "copy" && <small className="warn">{tm.sharedCopyPlan.replace("{stopped}", plan.detach?.stopped.length ? ` (${plan.detach.stopped.map((s) => quoted(t, s)).join(", ")})` : "")}</small>}
          {choice === "all" && (
            <div className="hint">
              <small>{tm.sharedAllPlan}</small>
              <ul>
                {(plan.otherShows ?? []).map((o) => (
                  <li key={o.show}>{tm.otherShow.replace("{show}", o.show).replace("{looks}", String(o.looks)).replace("{faders}", String(o.faders)).replace("{lost}", String(o.lost))}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="mode-actions">
            {others.length > 0 && !choice ? (
              <>
                <button disabled={busy} onClick={() => preview(plan.to, "copy")}>
                  {tm.sharedCopy}…
                </button>
                <button disabled={busy} onClick={() => preview(plan.to, "all")}>
                  {tm.sharedAll}…
                </button>
              </>
            ) : (
              <button className="primary" disabled={busy} onClick={() => void apply()}>
                {choice === "copy" ? tm.applyCopy : choice === "all" ? tm.applyAll : tm.apply}
              </button>
            )}
            <button className="ghost" disabled={busy} onClick={cancel}>
              {tm.cancel}
            </button>
          </div>
        </div>
      )}
      {(done || note) && (
        <p
          className="mode-done"
          role="status"
          tabIndex={-1}
          ref={status}
        >
          {done ? `${tm.done.replace("{mode}", done.mode)}${done.detached ? ` ${tm.doneCopy}` : ""} ` : note}
          {done?.proposal && (
            <button className="ghost" onClick={() => void undo()}>
              {tm.undo}
            </button>
          )}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
