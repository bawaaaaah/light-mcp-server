/**
 * The DMX mode of a patched fixture, in its menu (T6, docs/specs/venue-fixtures-stage.md, « Mode DMX d'un
 * appareil »): its definition's modes in a list (ModePicker), the current one marked. Picking another asks
 * venue.fixture.mode for its plan first (dryRun: what moves, what is lost, overlaps, canvas cells left dark,
 * looks restarted) and shows it; « Appliquer » writes it — after a confirmation naming the losses, then
 * forced. On a venue shared with other shows the two ways are offered instead (a venue of this show's own,
 * or the change for every show). Once applied, « Défaire » takes it all back (show.revert).
 */
import { useEffect, useRef, useState, type ReactElement } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { ModePicker, type ModeItem } from "./ModePicker";

interface Plan {
  name: string;
  to: string;
  channels: { before: number | null; after: number };
  address: { universe: number; from: number; to: number };
  moved: { message: string }[];
  lost: { message: string; show?: string }[];
  emptied: { name: string }[];
  overlaps: string[];
  freeAddress?: number;
  cellsWithoutRender: { name: string; cells: number[] }[];
  info: string[];
  relaunched: string[];
  sharedWith: string[];
  proposal?: string;
  detached?: boolean;
}
interface LibraryDef {
  manufacturer: string;
  model: string;
  modes: { name: string; channels: number }[];
}

export function DmxModeSection({ fixture, onSaved }: { fixture: { id: string; manufacturer?: string; model?: string; mode?: string }; onSaved: () => void }): ReactElement | null {
  const t = useT();
  const tm = t.fixtureMode;
  const [modes, setModes] = useState<LibraryDef["modes"] | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [done, setDone] = useState<{ mode: string; proposal?: string; detached?: boolean } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // a plan shown below the list is brought into the menu's view once, when it comes
  const planBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // in a block: Chromium's scrollIntoView now returns a promise, which React would take for a cleanup
    void planBox.current?.scrollIntoView({ block: "nearest" });
  }, [plan]);
  useEffect(() => {
    if (!fixture.model) return;
    void cmd<LibraryDef[]>("venue.library", { search: fixture.model })
      .then((defs) => setModes(defs.find((d) => d.manufacturer === fixture.manufacturer && d.model === fixture.model)?.modes ?? []))
      .catch(() => setModes([]));
  }, [fixture.manufacturer, fixture.model]);
  if (!fixture.model || modes === null) return null;

  const preview = (mode: string) => {
    setError("");
    setDone(null);
    if (mode === fixture.mode) return setPlan(null);
    void cmd<Plan>("venue.fixture.mode", { id: fixture.id, mode, dryRun: true }).then(setPlan, (e: Error) => setError(e.message));
  };
  const apply = async (shared?: "copy" | "all") => {
    if (!plan) return;
    const losses = [...plan.lost.map((l) => (l.show ? `${l.show} · ${l.message}` : l.message)), ...plan.emptied.map((e) => tm.emptied.replace("{name}", e.name)), ...plan.overlaps];
    // what is lost or overlapped is named before it is forced: one more yes
    if (losses.length && !confirm(tm.forceConfirm.replace("{list}", losses.map((l) => `• ${l}`).join("\n")))) return;
    setBusy(true);
    setError("");
    try {
      const r = await cmd<Plan>("venue.fixture.mode", { id: fixture.id, mode: plan.to, force: losses.length > 0, ...(shared ? { shared } : {}) });
      setDone({ mode: r.to, ...(r.proposal ? { proposal: r.proposal } : {}), ...(r.detached ? { detached: true } : {}) });
      setPlan(null);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const undo = async () => {
    if (!done?.proposal) return;
    setError("");
    try {
      await cmd("show.revert", { id: done.proposal });
      setDone(null);
      setError("");
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const items: ModeItem[] = modes.map((m) => ({ key: m.name, label: m.name, detail: tm.channels.replace("{n}", String(m.channels)), current: m.name === fixture.mode }));
  const otherShows = plan?.sharedWith.length ? plan.sharedWith : [];
  const nothing = plan && !plan.moved.length && !plan.lost.length && !plan.emptied.length && !plan.cellsWithoutRender.length;
  return (
    <fieldset className="dmx-mode">
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
                {plan.moved.map((m) => (
                  <li key={m.message}>{m.message}</li>
                ))}
              </ul>
            </details>
          )}
          {(plan.lost.length > 0 || plan.emptied.length > 0) && (
            <div className="warn" role="alert">
              <strong>
                ⚠ {tm.lost} ({plan.lost.length})
              </strong>
              <ul>
                {plan.lost.map((l) => (
                  <li key={`${l.show ?? ""}${l.message}`}>{l.show ? `${l.show} · ${l.message}` : l.message}</li>
                ))}
                {plan.emptied.map((e) => (
                  <li key={`emptied-${e.name}`}>{tm.emptied.replace("{name}", e.name)}</li>
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
              {tm.info} : {plan.info.join(" ; ")}
            </small>
          )}
          {plan.relaunched.length > 0 && <small className="warn">{tm.relaunched.replace("{list}", plan.relaunched.join(", "))}</small>}
          {otherShows.length > 0 && <small className="warn">{tm.shared.replace("{list}", otherShows.join(", "))}</small>}
          <div className="mode-actions">
            {otherShows.length > 0 ? (
              <>
                <button disabled={busy} onClick={() => void apply("copy")}>
                  {tm.sharedCopy}
                </button>
                <button disabled={busy} onClick={() => void apply("all")}>
                  {tm.sharedAll}
                </button>
              </>
            ) : (
              <button className="primary" disabled={busy} onClick={() => void apply()}>
                {tm.apply}
              </button>
            )}
            <button className="ghost" disabled={busy} onClick={() => setPlan(null)}>
              {tm.cancel}
            </button>
          </div>
        </div>
      )}
      {done && (
        <p className="mode-done" role="status">
          {tm.done.replace("{mode}", done.mode)} {done.detached ? tm.doneCopy : ""}{" "}
          {done.proposal && (
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
