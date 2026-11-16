/**
 * Calibration of a moving head (docs/specs/venue-fixtures-stage.md, « Lyres »), two tabs on the same head and mark.
 * Guided: aim it by hand at 2–3 known floor marks, record each one, then solve its yaw, tilt offset and inversions.
 * Manual (T8, ManualCalibration.tsx): aim one mark, correct by hand, set orientation, stops and travel; the head moves
 * live, so opening the tab asks once for a confirmation while the output is live (decision Q5 of the user).
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { cmd, lightState } from "../api";
import { useT } from "../App";
import { XyPad } from "./XyPad";
import { ManualCalibration, type Mark } from "./ManualCalibration";
import { useMotionLock } from "../hooks/useMotionLock";
import { stricter } from "../motionLock";
import { onManualCalibration } from "../calibrationLink";
import { control } from "../ws";
import { parseNumber } from "../manualCalibration";

type Tab = "guided" | "manual";
const TABS: Tab[] = ["guided", "manual"];

/**
 * Whether the output is on standby (nothing goes out), null until the server answered: read once, then followed on
 * light:state. `failed` when the read was refused (said, with `retry`, and taken as live: the head may move).
 */
function useStandby(): {
  standby: boolean | null;
  failed: boolean;
  retry: () => void;
} {
  const [standby, setStandby] = useState<boolean | null>(null);
  const [failed, setFailed] = useState(false);
  const live = useRef(true);
  const read = useCallback(() => {
    setFailed(false);
    void lightState().then(
      (s) => {
        if (live.current) {
          setStandby(Boolean(s.standby));
        }
      },
      () => {
        if (live.current) {
          setFailed(true);
        }
      },
    );
  }, []);
  useEffect(() => {
    live.current = true;
    read();
    const off = control.subscribe("light:state", (d) => {
      setFailed(false);
      setStandby(Boolean((d as { standby?: boolean }).standby));
    });
    return () => {
      live.current = false;
      off();
    };
  }, [read]);
  return { standby, failed, retry: read };
}

interface Head {
  id: string;
  name: string;
}
interface Result {
  yaw: number;
  tiltOffset: number;
  invertPan: boolean;
  invertTilt: boolean;
  errorDeg: number;
  errors: number[];
  applied: boolean;
}

export function Calibration({
  zones,
  placed,
  follow,
  onError,
  onApplied,
}: {
  zones: { id: string; name: string }[];
  placed: Set<string>;
  /** The fixture held on the plan: this head opens, wherever it sits in the list. */ follow?: string;
  onError: (msg: string) => void;
  onApplied: () => void;
}): ReactElement {
  const t = useT();
  const [heads, setHeads] = useState<Head[]>([]);
  const [head, setHead] = useState("");
  const [zone, setZone] = useState("");
  const [xy, setXy] = useState({ x: 0, y: 0 });
  /** The manual tab's mark height above the floor, metres (as typed): 0, a floor mark, as calibration.correct takes it. */
  const [height, setHeight] = useState("0");
  const [tab, setTab] = useState<Tab>("guided");
  /** The manual tab's « the head will move live » confirmed, until the tab is left (decision Q5). */
  const [confirmed, setConfirmed] = useState(false);
  const { standby, failed: standbyFailed, retry: readStandby } = useStandby();
  /** The output may move the head: live, or not known (its state could not be read). */
  const mayMove = standby === false || (standby === null && standbyFailed);
  const root = useRef<HTMLDivElement>(null);
  /** The manual tab's « Viser le repère »: focused once the move is confirmed. */
  const aimButton = useRef<HTMLButtonElement>(null);
  const tabButtons = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  /** A head asked by the panel's link before the heads were read: chosen once they are. */
  const asked = useRef<string | null>(null);
  const [marks, setMarks] = useState(0);
  // « Figer les lyres » (T26): a head frozen hard (its own lock or the one on every head) cannot record a mark
  const lockView = useMotionLock();
  const frozenHard = Boolean(lockView && head && stricter(lockView.lock.heads[head] ?? "off", lockView.lock.level) === "hard");
  const [result, setResult] = useState<Result | null>(null);
  /** Refusals stay beside the record button, where the operator is working. */
  const [error, setError] = useState("");
  /** Bumped only when the selected head changes; concurrent actions on that head do not cancel each other. */
  const actionSequence = useRef(0);
  const currentHead = useRef(head);
  currentHead.current = head;

  const placedKey = [...placed].sort().join(",");
  useEffect(() => {
    void cmd<Head[]>("position.list").then((h) => {
      const usable = h.filter((x) => placed.has(x.id));
      setHeads(usable);
      setHead((cur) => {
        const wanted = asked.current;
        if (wanted && usable.some((x) => x.id === wanted)) {
          asked.current = null;
          return wanted;
        }
        if (follow && usable.some((x) => x.id === follow)) return follow;
        if (usable.some((x) => x.id === cur)) return cur;
        return usable[0]?.id ?? "";
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `placed` is a new Set on every render of the page: its content (`placedKey`) is the dependency
  }, [placedKey, follow]);
  useEffect(() => {
    const action = ++actionSequence.current;
    const actionHead = head;
    if (head) {
      void cmd<unknown[]>("calibration.list", { fixture: head })
        .then((list) => {
          if (action === actionSequence.current && currentHead.current === actionHead) setMarks(list.length);
        })
        .catch((cause: Error) => {
          if (action === actionSequence.current && currentHead.current === actionHead) setError(cause.message);
        });
    } else setMarks(0);
    setResult(null);
    setError("");
  }, [head]);
  // « Calibration manuelle » from a fixture's panel: this head, the manual tab, the assistant opened and brought into view
  const headsRef = useRef(heads);
  headsRef.current = heads;
  useEffect(
    () =>
      onManualCalibration((fixture) => {
        if (headsRef.current.some((h) => h.id === fixture)) setHead(fixture);
        else asked.current = fixture;
        setTab("manual");
        const box = root.current?.closest("details");
        if (box) box.open = true;
        // after the render that shows the tab: its button takes the focus, the assistant comes into view
        window.requestAnimationFrame(() => {
          tabButtons.current.manual?.focus({ preventScroll: true });
          root.current?.scrollIntoView({ block: "start", behavior: "smooth" });
        });
      }),
    [],
  );

  if (!heads.length)
    return (
      <p ref={root} className="hint">
        {t.calibrationNone}
      </p>
    );
  const fail = (e: Error) => setError(e.message);
  const held = follow && heads.some((h) => h.id === follow) && head === follow;
  const m = t.manualCal;
  const choose = (next: Tab) => {
    setTab(next);
    // leaving the manual tab: opening it again asks again
    if (next !== "manual") {
      setConfirmed(false);
    }
  };
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, from: Tab) => {
    const i = TABS.indexOf(from);
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    const next = e.key === "Home" ? TABS[0]! : e.key === "End" ? TABS[TABS.length - 1]! : step ? TABS[(i + step + TABS.length) % TABS.length]! : undefined;
    if (!next) {
      return;
    }
    e.preventDefault();
    choose(next);
    tabButtons.current[next]?.focus();
  };
  const headName = heads.find((h) => h.id === head)?.name ?? head;
  const parsedHeight = parseNumber(height);
  const heightValid = parsedHeight !== undefined;
  const heightValue = parsedHeight ?? 0;
  const mark: Mark = zone ? { zone, height: heightValue } : { point: { x: xy.x, y: xy.y, z: heightValue } };
  const confirmMove = () => {
    setConfirmed(true);
    // after the render that shows the tab's controls: the first gesture, « Viser le repère », takes the focus; off
    // (frozen hard, a height that is not a number), its section's title does, so the focus is not lost
    const aimed = head;
    window.requestAnimationFrame(() => {
      const button = aimButton.current;
      if (button && !button.disabled) {
        button.focus();
      } else {
        document.getElementById(`manual-aim-${aimed}`)?.focus();
      }
    });
  };
  return (
    <div ref={root} className="calibration">
      <div className="cal-tabs" role="tablist" aria-label={m.tabs}>
        {TABS.map((k) => (
          <button
            key={k}
            ref={(el) => void (tabButtons.current[k] = el)}
            type="button"
            role="tab"
            id={`cal-tab-${k}`}
            aria-selected={tab === k}
            aria-controls={tab === k ? "cal-panel" : undefined}
            tabIndex={tab === k ? 0 : -1}
            className={`ghost${tab === k ? " on" : ""}`}
            onKeyDown={(e) => onTabKey(e, k)}
            onClick={() => choose(k)}
          >
            {k === "guided" ? m.guided : m.manual}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="cal-panel" aria-labelledby={`cal-tab-${tab}`}>
        {tab === "guided" && (
          <p className="hint">
            {t.calibrationHelp}
            {held ? ` ${t.calibrationFollows}` : ""}
          </p>
        )}
        {tab === "manual" && held && <p className="hint">{t.calibrationFollows}</p>}
        <div className="fields">
          <label className="field">
            <span>{t.heads}</span>
            <select value={head} onChange={(e) => setHead(e.target.value)}>
              {heads.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t.calibrationMark}</span>
            <select value={zone} onChange={(e) => setZone(e.target.value)}>
              <option value="">{t.calibrationPoint}</option>
              {zones.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.name}
                </option>
              ))}
            </select>
          </label>
          {!zone &&
            (["x", "y"] as const).map((k) => (
              <label key={k} className="field">
                <span>{k} (m)</span>
                <input type="number" step={0.1} value={xy[k]} onChange={(e) => setXy({ ...xy, [k]: Number(e.target.value) })} />
              </label>
            ))}
          {tab === "manual" && (
            <div className="field">
              <label htmlFor="cal-height">{m.height}</label>
              <input
                id="cal-height"
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={height}
                aria-invalid={!heightValid || undefined}
                aria-describedby={heightValid ? undefined : "cal-height-error"}
                onChange={(e) => setHeight(e.target.value)}
              />
              {!heightValid && (
                <small id="cal-height-error" className="error">
                  {m.heightInvalid}
                </small>
              )}
            </div>
          )}
        </div>
        {tab === "manual" && (
          <div className="cal-manual">
            {standbyFailed && standby === null ? (
              <p className="error" role="alert" data-testid="cal-output">
                {m.outputUnknown}{" "}
                <button type="button" className="ghost" onClick={readStandby}>
                  {m.retry}
                </button>
              </p>
            ) : (
              standby !== null && (
                <p className={standby ? "hint" : "warn"} role="status" data-testid="cal-output">
                  {standby ? m.outputStandby : m.outputLive}
                </p>
              )
            )}
            {head && (confirmed || standby === true) ? (
              <ManualCalibration key={head} head={head} name={headName} mark={mark} markValid={heightValid} onApplied={onApplied} aimButton={aimButton} />
            ) : (
              head &&
              mayMove && (
                // not a dialog (nothing modal, the rest of the page stays usable): a named group, its text said when it shows
                <div className="cal-confirm" role="group" aria-labelledby="cal-confirm-title" aria-describedby="cal-confirm-text">
                  <p id="cal-confirm-title">
                    <strong>{m.confirmTitle}</strong>
                  </p>
                  <p id="cal-confirm-text" role="alert">
                    {m.confirmText.replace("{name}", headName)}
                  </p>
                  <div className="row actions">
                    <button type="button" className="primary" onClick={confirmMove}>
                      {m.confirmGo}
                    </button>
                    <button type="button" className="ghost" onClick={() => choose("guided")}>
                      {m.confirmBack}
                    </button>
                  </div>
                </div>
              )
            )}
          </div>
        )}
        {tab === "guided" && (
          <div className="cal-guided">
            <div className="calibration-pad">
              <XyPad fixture={head} label={heads.find((h) => h.id === head)?.name} onError={onError} />
            </div>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="row actions">
              <button
                // frozen hard (T26): the head cannot be aimed, a mark would record where it is held — said, not sent
                disabled={frozenHard}
                title={frozenHard ? t.motionLock.calibrationFrozen : undefined}
                onClick={() => {
                  setError("");
                  const actionHead = head;
                  void cmd<{ samples: number }>("calibration.record", {
                    fixture: head,
                    ...(zone ? { zone } : { point: { x: xy.x, y: xy.y, z: 0 } }),
                  })
                    .then((r) => {
                      if (currentHead.current === actionHead) setMarks(r.samples);
                    })
                    .catch((e: Error) => {
                      if (currentHead.current === actionHead) fail(e);
                    });
                }}
              >
                {t.calibrationRecord} ({marks})
              </button>
              {frozenHard && <small className="hint">{t.motionLock.calibrationFrozen}</small>}
              <button
                disabled={marks < 2}
                onClick={() => {
                  setError("");
                  const actionHead = head;
                  void cmd<Result>("calibration.solve", { fixture: head })
                    .then((r) => {
                      if (currentHead.current === actionHead) setResult(r);
                    })
                    .catch((e: Error) => {
                      if (currentHead.current === actionHead) fail(e);
                    });
                }}
              >
                {t.calibrationSolve}
              </button>
              <button
                className="ghost"
                onClick={() => {
                  setError("");
                  const actionHead = head;
                  void cmd("calibration.clear", { fixture: head })
                    .then(() => {
                      if (currentHead.current === actionHead) {
                        setMarks(0);
                        setResult(null);
                      }
                    })
                    .catch((e: Error) => {
                      if (currentHead.current === actionHead) fail(e);
                    });
                }}
              >
                {t.calibrationClear}
              </button>
            </div>
            {result && (
              <div className="report">
                <p>
                  yaw {result.yaw}° · tilt {result.tiltOffset > 0 ? "+" : ""}
                  {result.tiltOffset}° · {result.invertPan ? t.panInverted : t.panNormal} · {result.invertTilt ? t.tiltInverted : t.tiltNormal}
                </p>
                <p className={result.errorDeg > 3 ? "error" : "hint"}>
                  {t.calibrationError}
                  {t.colon} {result.errorDeg}° ({result.errors.join("°, ")}°)
                  {result.errorDeg > 3 ? ` — ${t.calibrationBad}` : ""}
                </p>
                <button
                  className="primary"
                  onClick={() => {
                    setError("");
                    if (result.errorDeg <= 3 || confirm(`${t.calibrationBad}. ${t.calibrationApplyAnyway}`)) {
                      const actionHead = head;
                      void cmd<Result>("calibration.solve", {
                        fixture: head,
                        apply: true,
                      })
                        .then((r) => {
                          if (currentHead.current === actionHead) {
                            setResult(r);
                            setMarks(0);
                            onApplied();
                          }
                        })
                        .catch((e: Error) => {
                          if (currentHead.current === actionHead) fail(e);
                        });
                    }
                  }}
                >
                  {t.apply}
                </button>
                {result.applied && <span className="hint"> ✔</span>}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
