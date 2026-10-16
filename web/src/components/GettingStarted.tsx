import { useCallback, useEffect, useState } from "react";
import { can, cmd, lightState, type Role } from "../api";
import { useNav, useT } from "../App";
import { useCommandEvents } from "../hooks/useTopic";
import { slug } from "../util";

/** Widgets of the safety bar: a dashboard with only these is still to fill. */
const SAFETY = new Set(["panic", "blackout", "tap", "stop-all", "song-nav", "label"]);
type Dash = { id: string; name: string; widgets: { kind: string }[] };

/**
 * « Pour commencer », on the Live page of a show not ready to play: patch, canvas, looks, dashboard,
 * each with what does it in one click (or the page where it is done). Gone once the four are done,
 * or hidden for this show by the user. « Générer » fills the dashboard on screen, which then holds
 * only the safety bar (no dashboard is filled yet). A role that cannot write the show only reads that it is empty.
 */
export function GettingStarted({ role, looks, dashboards, current, onDashboard }: { role: Role; looks: number; dashboards: Dash[]; current?: Dash; onDashboard: () => void }) {
  const t = useT();
  const nav = useNav();
  const [fixtures, setFixtures] = useState<string[] | null>(null);
  const [canvases, setCanvases] = useState(0);
  const [show, setShow] = useState("");
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const editor = can(role, "show:write");

  const load = useCallback(() => {
    void cmd<{ id: string }[]>("venue.fixture.list")
      .then((l) => setFixtures(l.map((f) => f.id)))
      .catch(() => undefined);
    void cmd<unknown[]>("venue.canvas.list")
      .then((l) => setCanvases(l.length))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    load();
    void lightState().then((s) => {
      const id = s.show?.id ?? "";
      setShow(id);
      try {
        setHidden(localStorage.getItem(`gettingStarted.hidden.${id}`) === "1");
      } catch {
        /* per-browser comfort only */
      }
    }, () => undefined);
  }, [load]);
  useCommandEvents(["venue.", "import.", "show."], load);

  if (fixtures === null || hidden) return null;
  // one dashboard with something to play is enough: a second one left empty on purpose is no reason to show the guide
  const filled = dashboards.some((d) => d.widgets.some((w) => !SAFETY.has(w.kind)));
  const steps = [fixtures.length > 0, canvases > 0, looks > 0, filled];
  if (steps.every(Boolean)) return null;
  if (!editor) return looks === 0 ? <p className="hint getting-started-note">{t.emptyShowViewer}</p> : null;

  const act = (p: Promise<unknown>) => {
    setBusy(true);
    setError("");
    void p
      .then(load, (e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  const hide = () => {
    setHidden(true);
    try {
      localStorage.setItem(`gettingStarted.hidden.${show}`, "1");
    } catch {
      /* per-browser comfort only */
    }
  };
  const next = steps.indexOf(false);
  const step = (i: number, title: string, help: string, actions: React.ReactNode) => (
    <li className={steps[i] ? "done" : i === next ? "next" : undefined}>
      <span className="mark" aria-hidden>
        {steps[i] ? "✔" : i + 1}
      </span>
      <div>
        <strong>{title}</strong>
        {!steps[i] && <p className="hint">{help}</p>}
        {!steps[i] && <div className="row">{actions}</div>}
      </div>
    </li>
  );

  return (
    <section className="getting-started" aria-label={t.gettingStarted}>
      <div className="row">
        <h2>{t.gettingStarted}</h2>
        <span className="grow" />
        <button className="ghost" onClick={hide}>
          {t.hideGuide}
        </button>
      </div>
      <p className="hint">{t.gettingStartedHelp}</p>
      <ol>
        {step(
          0,
          `${t.stepPatch}${fixtures.length ? ` (${fixtures.length})` : ""}`,
          t.stepPatchHelp,
          <>
            <button className={next === 0 ? "primary" : undefined} onClick={() => nav("venue")}>
              {t.goVenue}
            </button>
            <button onClick={() => nav("import")}>{t.goImport}</button>
          </>,
        )}
        {step(
          1,
          t.stepCanvas,
          t.stepCanvasHelp,
          <>
            <button className={next === 1 ? "primary" : undefined} disabled={busy || fixtures.length === 0} onClick={() => act(cmd("venue.canvas.auto", { id: slug(t.canvasAllName, "patch"), name: t.canvasAllName, fixtures, topology: "line" }))}>
              {t.canvasAll}
            </button>
            <button onClick={() => nav("venue")}>{t.goVenue}</button>
          </>,
        )}
        {step(
          2,
          t.stepLooks,
          t.stepLooksHelp,
          <>
            <button className={next === 2 ? "primary" : undefined} disabled={busy || canvases === 0} title={t.autopresetsHelp} onClick={() => act(cmd("show.autopresets", { apply: true }))}>
              ★ {t.autopresets}
            </button>
            <button onClick={() => nav("show")}>{t.goShow}</button>
          </>,
        )}
        {step(
          3,
          t.stepDashboard,
          t.stepDashboardHelp,
          <button
            className={next === 3 ? "primary" : undefined}
            disabled={busy || looks === 0}
            title={t.generateDashboardHelp}
            onClick={() => act(cmd("dashboard.generate", current ? { id: current.id, name: current.name } : {}).then(onDashboard))}
          >
            {t.generateDashboard}
          </button>,
        )}
      </ol>
      {error && (
        <p className="error" onClick={() => setError("")}>
          {error}
        </p>
      )}
    </section>
  );
}
