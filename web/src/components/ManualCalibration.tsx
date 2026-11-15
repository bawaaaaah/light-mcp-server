/**
 * Manual calibration of a moving head (T8, lot 6; docs/specs/venue-fixtures-stage.md, « Lyres », calibration manuelle):
 * « aim a mark and correct the gap ». The head aims a known mark with its calibration as it is (`position.aim`), the
 * correction pad (XyPad `span`, ± a few degrees around that aim, on the output's grid) brings its beam onto the mark,
 * then `calibration.correct` folds the gap into the pan and tilt offsets. Every field writes the orientation
 * (`venue.fixture.orient`, once per gesture) or the travel (`venue.fixture.travel.set`) and the head aims the mark
 * again: it moves live. Mounted per head (keyed by its id); the confirmation that the head will move is asked by the
 * assistant (Calibration.tsx), once when the tab opens.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { useCommandEvents } from "../hooks/useTopic";
import { useMotionHeads } from "../hooks/useMotionHeads";
import { useMotionLock } from "../hooks/useMotionLock";
import { stricter } from "../motionLock";
import { CORRECTION_SPANS, defaultSpan, type CorrectionSpan, type PadSpan, type Point } from "../correctionPad";
import { beyondStops, nudgeDeg, parseDeg, roundDeg, stopProblem, type Axis, type Range, type Stops } from "../manualCalibration";
import { isFrench, quoted } from "../typography";
import type { Texts } from "../i18n";
import { XyPad } from "./XyPad";
import { DmxModeSection } from "./DmxModeSection";

interface Orientation {
  yaw?: number;
  invertPan?: boolean;
  invertTilt?: boolean;
  swapPanTilt?: boolean;
  panOffset?: number;
  tiltOffset?: number;
  limits?: Stops;
}
interface Patched {
  id: string;
  name: string;
  manufacturer?: string;
  model?: string;
  mode?: string;
  orientation?: Orientation;
}
type TravelSource = "fixture" | "model" | "definition";
type TravelAxes = { panMax?: number; tiltMax?: number };
/** What venue.fixture.travel and venue.fixture.travel.set answer. */
interface Travel {
  definition: { panMax: number; tiltMax: number };
  model: TravelAxes | null;
  own: TravelAxes | null;
  panMax: number;
  tiltMax: number;
  applies: { panMax: TravelSource; tiltMax: TravelSource };
  modesKeepingTravel: string[];
  fine: { pan: boolean; tilt: boolean };
  step: Point;
  finerModes: string[];
}
/** What calibration.correct answers. */
interface Correction {
  applied: boolean;
  panOffset: number;
  tiltOffset: number;
  panOffsetDelta: number;
  tiltOffsetDelta: number;
  beforeDeg: number;
  afterDeg: number;
  panUndetermined?: true;
  advice?: string;
  note?: string;
  aimed?: { pan?: number; tilt?: number; error?: string };
}
/** The mark, as position.aim and calibration.correct take it. */
export type Mark = { zone: string; height: number } | { point: { x: number; y: number; z: number } };

const AXES = ["pan", "tilt"] as const;
/** The travel's bounds, as the server's schema has them (TravelOverridesSchema). */
const TRAVEL_MIN = 1;
const TRAVEL_MAX = 1080;
/** Typing pauses this long (ms) before a field is written: one write of the patch per gesture, not per key. */
const IDLE_MS = 400;

const num = (t: Texts, v: number, digits = 1): string =>
  v.toLocaleString(isFrench(t) ? "fr" : "en", {
    maximumFractionDigits: digits,
  });
const signed = (t: Texts, v: number, digits = 1): string => `${v > 0 ? "+" : v < 0 ? "−" : ""}${num(t, Math.abs(v), digits)}`;
/** A step of the output: small numbers keep their significant digits (0,008°), large ones a couple of decimals. */
const stepText = (t: Texts, v: number): string => `${v.toLocaleString(isFrench(t) ? "fr" : "en", v < 0.1 ? { maximumSignificantDigits: 2 } : { maximumFractionDigits: 2 })}°`;

/**
 * A degree field written once per gesture: on Enter, on leaving it, after a pause in typing, or after the arrows
 * (± 0.1°, Shift ± 1°) and the − / + buttons stop. Typed with a comma or a point. The draft stays shown until the
 * stored value changes (no flicker back to the old value while the write is on its way).
 */
function DegreeField({
  label,
  value,
  onCommit,
  help,
  buttons = false,
  testId,
}: {
  label: string;
  value: number;
  onCommit: (v: number) => Promise<unknown>;
  help?: string;
  buttons?: boolean;
  testId?: string;
}): ReactElement {
  const t = useT();
  const m = t.manualCal;
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [bad, setBad] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const focused = useRef(false);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  // the stored value moved (this field's write came back, or another client's): shown unless the field is being typed in
  useEffect(() => {
    if (!focused.current) setDraft(null);
  }, [value]);
  const commit = (text: string) => {
    window.clearTimeout(timer.current);
    const v = parseDeg(text);
    if (v === undefined) return setBad(true);
    setBad(false);
    if (roundDeg(v) === roundDeg(value)) return;
    void onCommit(roundDeg(v)).catch(() => setDraft(null));
  };
  const later = (text: string) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => commit(text), IDLE_MS);
  };
  const shown = draft ?? num(t, value);
  const step = (sign: 1 | -1, shift = false) => {
    const next = nudgeDeg(parseDeg(shown) ?? value, sign > 0 ? "ArrowUp" : "ArrowDown", shift)!;
    const text = num(t, next);
    setDraft(text);
    later(text);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") return commit(shown);
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    step(e.key === "ArrowUp" ? 1 : -1, e.shiftKey);
  };
  return (
    <div className="field manual-field" data-testid={testId}>
      <label htmlFor={id}>{label}</label>
      <span className="manual-input">
        {buttons && (
          <button type="button" className="ghost" aria-label={`${label} · ${m.less}`} onClick={() => step(-1)}>
            −
          </button>
        )}
        <input
          id={id}
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={shown}
          aria-invalid={bad || undefined}
          aria-describedby={`${id}-help`}
          onFocus={() => (focused.current = true)}
          onBlur={() => {
            focused.current = false;
            if (draft !== null) commit(draft);
          }}
          onChange={(e) => {
            setDraft(e.target.value);
            later(e.target.value);
          }}
          onKeyDown={onKey}
        />
        {buttons && (
          <button type="button" className="ghost" aria-label={`${label} · ${m.more}`} onClick={() => step(1)}>
            +
          </button>
        )}
      </span>
      <small id={`${id}-help`} className={bad ? "error" : "hint"}>
        {bad ? m.notANumber : (help ?? m.fieldKeys)}
      </small>
    </div>
  );
}

/** A switch of the orientation: the app's ghost button with aria-pressed, its words toggling too. */
function Switch({ label, on, onToggle }: { label: string; on: boolean; onToggle: () => void }): ReactElement {
  return (
    <div className="invert-row">
      <span className="invert-label" onClick={onToggle}>
        {label}
      </span>
      <button type="button" className={`ghost${on ? " on" : ""}`} aria-pressed={on} aria-label={label} onClick={onToggle}>
        {on ? "◉" : "○"}
      </button>
    </div>
  );
}

/** One axis' useful stop: from / to in logical degrees, sent once both ends are valid; « Retirer » removes it. */
function StopRow({ axis, range, travel, onSet }: { axis: Axis; range: Range | undefined; travel: number; onSet: (axis: Axis, range: Range | null) => Promise<unknown> }): ReactElement {
  const t = useT();
  const m = t.manualCal;
  const id = useId();
  const half = travel / 2;
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const [problem, setProblem] = useState("");
  // the stored stop moved (written, removed, changed elsewhere): the drafts give way to it
  const stored = range ? `${range[0]},${range[1]}` : "";
  useEffect(() => {
    setFrom(null);
    setTo(null);
    setProblem("");
  }, [stored]);
  const fromText = from ?? (range ? num(t, range[0]) : "");
  const toText = to ?? (range ? num(t, range[1]) : "");
  const send = () => {
    if (from === null && to === null) return;
    const a = parseDeg(fromText);
    const b = parseDeg(toText);
    if (a === undefined || b === undefined) return setProblem(fromText.trim() && toText.trim() ? m.notANumber : "");
    const next: Range = [roundDeg(a), roundDeg(b)];
    const p = stopProblem(next, travel);
    if (p) return setProblem(p.kind === "order" ? m.stopOrder : m.stopOutside.replace("{half}", num(t, p.half)));
    setProblem("");
    if (range && next[0] === range[0] && next[1] === range[1]) return;
    void onSet(axis, next).catch(() => undefined);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => e.key === "Enter" && send();
  // the stop drawn over the travel: where it leaves the head free
  const left = range ? ((range[0] + half) / travel) * 100 : 0;
  const width = range ? ((range[1] - range[0]) / travel) * 100 : 100;
  const name = axis === "pan" ? "pan" : "tilt";
  return (
    <fieldset className="manual-stop" aria-describedby={`${id}-state`}>
      <legend>{m.stopAxis.replace("{axis}", name)}</legend>
      <div className="manual-stop-fields">
        <label>
          <span>{m.stopFrom}</span>
          <input
            type="text"
            autoComplete="off"
            aria-label={`${m.stopAxis.replace("{axis}", name)} · ${m.stopFrom}`}
            value={fromText}
            aria-invalid={Boolean(problem) || undefined}
            onChange={(e) => setFrom(e.target.value)}
            onBlur={send}
            onKeyDown={onKey}
          />
        </label>
        <label>
          <span>{m.stopTo}</span>
          <input
            type="text"
            autoComplete="off"
            aria-label={`${m.stopAxis.replace("{axis}", name)} · ${m.stopTo}`}
            value={toText}
            aria-invalid={Boolean(problem) || undefined}
            onChange={(e) => setTo(e.target.value)}
            onBlur={send}
            onKeyDown={onKey}
          />
        </label>
        <button type="button" className="ghost" disabled={!range} aria-label={`${m.stopRemove} · ${m.stopAxis.replace("{axis}", name)}`} onClick={() => void onSet(axis, null).catch(() => undefined)}>
          {m.stopRemove}
        </button>
      </div>
      <div className="manual-stop-bar" aria-hidden="true">
        <span style={{ left: `${left}%`, width: `${width}%` }} />
      </div>
      <small id={`${id}-state`} className={problem ? "error" : "hint"} role={problem ? "alert" : undefined}>
        {problem || (range ? m.stopRange.replace("{from}", signed(t, range[0])).replace("{to}", signed(t, range[1])).replace("{half}", num(t, half)) : m.stopNone.replace("{half}", num(t, half)))}
      </small>
    </fieldset>
  );
}

export function ManualCalibration({ head, name, mark, onApplied }: { head: string; name: string; mark: Mark; onApplied: () => void }): ReactElement {
  const t = useT();
  const m = t.manualCal;
  const [fixture, setFixture] = useState<Patched | null>(null);
  const [travel, setTravel] = useState<Travel | null>(null);
  /** The aim the calibration computes for the mark (logical): the correction pad's centre; null until aimed. */
  const [center, setCenter] = useState<Point | null>(null);
  const [span, setSpan] = useState<CorrectionSpan | null>(null);
  const [preview, setPreview] = useState<Correction | null>(null);
  /** Per section, the server's last refusal: said where the operator is working. */
  const [errors, setErrors] = useState<Partial<Record<"aim" | "orient" | "stops" | "travel" | "correct", string>>>({});
  const [keeping, setKeeping] = useState<string[]>([]);
  const [scope, setScope] = useState<"model" | "fixture">("model");
  const [travelDraft, setTravelDraft] = useState<Partial<Record<Axis, string>>>({});
  const scopeButtons = useRef<Partial<Record<"model" | "fixture", HTMLButtonElement | null>>>({});
  const lockView = useMotionLock();
  const frozenHard = Boolean(lockView && stricter(lockView.lock.heads[head] ?? "off", lockView.lock.level) === "hard");
  const { heads } = useMotionHeads({ fixtures: [head] });
  const manual = heads[0]?.manual ?? null;
  const say = useCallback((key: keyof typeof errors, message = "") => setErrors((e) => ({ ...e, [key]: message })), []);
  const markKey = JSON.stringify(mark);
  const markRef = useRef(mark);
  markRef.current = mark;
  /** Bumped by every aim: an answer overtaken by a later aim (a field typed fast) is dropped. */
  const aimSequence = useRef(0);

  const reload = useCallback(() => {
    void cmd<Patched[]>("venue.fixture.list")
      .then((rows) => setFixture(rows.find((r) => r.id === head) ?? null))
      .catch(() => undefined);
    void cmd<Travel>("venue.fixture.travel", { fixture: head })
      .then(setTravel)
      .catch((e: Error) => say("travel", e.message));
  }, [head, say]);
  useEffect(reload, [reload]);
  // changed elsewhere (the plan's orientation panel, the fixture menu, another client): read again
  useCommandEvents(["venue.fixture.", "calibration."], reload);

  /** Aims the mark with the calibration as it is: the head moves there, the pad centres on it. */
  const aim = useCallback(async () => {
    const sequence = ++aimSequence.current;
    say("aim");
    setPreview(null);
    try {
      const r = await cmd<{
        results: { pan?: number; tilt?: number; error?: string }[];
      }>("position.aim", { fixtures: [head], ...markRef.current });
      if (sequence !== aimSequence.current) return;
      const res = r.results[0];
      if (res?.pan !== undefined && res.tilt !== undefined) setCenter({ pan: res.pan, tilt: res.tilt });
      if (res?.error) say("aim", res.error);
    } catch (e) {
      if (sequence === aimSequence.current) say("aim", (e as Error).message);
    }
  }, [head, say]);
  // another mark: the aim no longer holds, aim again only when asked
  useEffect(() => {
    aimSequence.current++;
    setCenter(null);
    setPreview(null);
  }, [markKey]);
  const aimedOnce = center !== null;

  /** Writes part of the orientation, then aims the mark again with it (once aimed): the head moves live. */
  const orient = async (change: Partial<Orientation> | { limits: Partial<Record<Axis, Range | null>> }, section: "orient" | "stops" = "orient") => {
    say(section);
    try {
      const r = await cmd<{ fixture: Patched }>("venue.fixture.orient", {
        id: head,
        ...change,
      });
      setFixture(r.fixture);
      if (aimedOnce) await aim();
    } catch (e) {
      say(section, (e as Error).message);
      throw e;
    }
  };

  const setTravelFor = async (axes: Partial<Record<"panMax" | "tiltMax", number | null>>) => {
    say("travel");
    try {
      const r = await cmd<Travel>("venue.fixture.travel.set", {
        fixture: head,
        scope,
        ...axes,
      });
      setTravel(r);
      setTravelDraft({});
      setKeeping(scope === "model" ? r.modesKeepingTravel : []);
      if (aimedOnce) await aim();
    } catch (e) {
      say("travel", (e as Error).message);
    }
  };

  const correct = async (apply: boolean) => {
    say("correct");
    try {
      const r = await cmd<Correction>("calibration.correct", {
        fixture: head,
        ...markRef.current,
        apply,
      });
      setPreview(r);
      if (apply) {
        if (r.aimed?.pan !== undefined && r.aimed.tilt !== undefined) setCenter({ pan: r.aimed.pan, tilt: r.aimed.tilt });
        reload();
        onApplied();
      }
    } catch (e) {
      say("correct", (e as Error).message);
    }
  };

  const padSpan = useMemo<PadSpan | undefined>(
    () =>
      center && travel
        ? {
            center,
            half: span ?? defaultSpan(travel.step),
            travel: { pan: travel.panMax, tilt: travel.tiltMax },
            step: travel.step,
            fine: travel.fine,
          }
        : undefined,
    [center, travel, span],
  );

  const o = fixture?.orientation ?? {};
  const travelPoint = travel ? { pan: travel.panMax, tilt: travel.tiltMax } : null;
  const beyond = manual && travelPoint && travel ? beyondStops(manual, travelPoint, o.limits, travel.step) : [];
  const spanNow = travel ? (span ?? defaultSpan(travel.step)) : null;
  const stepOf = (axis: Axis) => (travel ? `${axis} ${stepText(t, travel.step[axis])} (${travel.fine[axis] ? m.stepFine : m.stepCoarse})` : "");
  const coarse = travel ? AXES.filter((a) => !travel.fine[a]) : [];
  const moveScope = (e: KeyboardEvent<HTMLButtonElement>, from: "model" | "fixture") => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const next = from === "model" ? "fixture" : "model";
    setScope(next);
    scopeButtons.current[next]?.focus();
  };
  const sourceName = (s: TravelSource) => m.sources[s];
  const scopeCorrection = travel ? (scope === "model" ? travel.model : travel.own) : null;
  const travelChanged = (axis: Axis): number | undefined => {
    const text = travelDraft[axis];
    if (text === undefined || !travel) return undefined;
    const v = parseDeg(text);
    return v !== undefined && v !== travel[axis === "pan" ? "panMax" : "tiltMax"] ? v : undefined;
  };
  /** A travel typed that the server would refuse: not a number, or outside 1..1080°. */
  const travelInvalid = (axis: Axis): boolean => {
    const text = travelDraft[axis];
    if (text === undefined) return false;
    const v = parseDeg(text);
    return v === undefined || v < TRAVEL_MIN || v > TRAVEL_MAX;
  };
  const travelBad = AXES.some(travelInvalid);

  return (
    <div className="manual-cal">
      <p className="hint">{m.help}</p>
      {frozenHard && <p className="warn">{m.frozen}</p>}

      <section className="manual-cal-aim" aria-labelledby={`manual-aim-${head}`}>
        <h4 id={`manual-aim-${head}`}>{m.padTitle}</h4>
        <div className="row actions">
          <button type="button" className={aimedOnce ? "" : "primary"} disabled={frozenHard} onClick={() => void aim()}>
            {aimedOnce ? m.aimAgain : m.aim}
          </button>
          {travel && (
            <div className="swatches" role="radiogroup" aria-label={m.span}>
              {CORRECTION_SPANS.map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={spanNow === s}
                  className={`ghost${spanNow === s ? " on" : ""}`}
                  tabIndex={spanNow === s ? 0 : -1}
                  onKeyDown={(e) => {
                    const i = CORRECTION_SPANS.indexOf(s);
                    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
                    if (!step) return;
                    e.preventDefault();
                    const next = CORRECTION_SPANS[(i + step + CORRECTION_SPANS.length) % CORRECTION_SPANS.length]!;
                    setSpan(next);
                    (e.currentTarget.parentElement?.querySelectorAll("button")[CORRECTION_SPANS.indexOf(next)] as HTMLButtonElement | undefined)?.focus();
                  }}
                  onClick={() => setSpan(s)}
                >
                  ± {s}°
                </button>
              ))}
            </div>
          )}
        </div>
        {errors.aim && (
          <p className="error" role="alert">
            {errors.aim}
          </p>
        )}
        {travel && (
          <p className="hint" data-testid="manual-step">
            {m.step} {stepOf("pan")} · {stepOf("tilt")}
            {coarse.length > 0 && ` — ${m.wholeSteps}`}
          </p>
        )}
        {travel && travel.finerModes.length > 0 && fixture && (
          <div className="manual-finer" data-testid="manual-finer">
            <p className="warn">{m.finer.replace("{modes}", travel.finerModes.map((x) => quoted(t, x)).join(", "))}</p>
            <details>
              <summary>{m.changeMode}</summary>
              <DmxModeSection fixture={fixture} onSaved={reload} />
            </details>
          </div>
        )}
        {padSpan ? (
          <div className="calibration-pad">
            <XyPad fixture={head} label={name} onError={(msg) => say("aim", msg)} span={padSpan} />
          </div>
        ) : (
          <p className="hint">{m.notAimed}</p>
        )}
        {beyond.length > 0 && (
          <p className="warn" role="status">
            {m.padBeyond.replace("{axes}", beyond.join(", "))}
          </p>
        )}
      </section>

      <section className="manual-cal-correct" aria-labelledby={`manual-correct-${head}`}>
        <h4 id={`manual-correct-${head}`}>{m.correct}</h4>
        <p className="hint">{m.correctHelp}</p>
        <div className="row actions">
          <button type="button" disabled={frozenHard || !aimedOnce} onClick={() => void correct(false)}>
            {m.measure}
          </button>
          {preview && !preview.applied && (
            <button type="button" className="primary" disabled={frozenHard} onClick={() => void correct(true)}>
              {t.apply}
            </button>
          )}
        </div>
        {errors.correct && (
          <p className="error" role="alert">
            {errors.correct}
          </p>
        )}
        <div role="status" className="manual-cal-report">
          {preview && (
            <>
              <p data-testid="manual-gap">{m.gap.replace("{before}", num(t, preview.beforeDeg, 2)).replace("{after}", num(t, preview.afterDeg, 2))}</p>
              <p className="hint">
                {m.deltas
                  .replace("{pan}", signed(t, preview.panOffsetDelta, 2))
                  .replace("{panTo}", signed(t, preview.panOffset, 2))
                  .replace("{tilt}", signed(t, preview.tiltOffsetDelta, 2))
                  .replace("{tiltTo}", signed(t, preview.tiltOffset, 2))}
              </p>
              {preview.panUndetermined && <p className="hint">{m.panUndetermined}</p>}
              {preview.note && <p className="warn">{preview.note}</p>}
              {preview.advice && <p className="warn">{preview.advice}</p>}
              {preview.aimed?.error && <p className="warn">{preview.aimed.error}</p>}
              {preview.applied && <p className="ok">✔ {m.applied}</p>}
            </>
          )}
        </div>
      </section>

      <section className="manual-cal-orient" aria-labelledby={`manual-orient-${head}`}>
        <h4 id={`manual-orient-${head}`}>{m.orientation}</h4>
        <div className="manual-fields">
          <DegreeField label={m.yaw} value={o.yaw ?? 0} help={m.yawHelp} buttons testId="manual-yaw" onCommit={(yaw) => orient({ yaw })} />
          <DegreeField label={m.panOffset} value={o.panOffset ?? 0} buttons testId="manual-pan-offset" onCommit={(panOffset) => orient({ panOffset })} />
          <DegreeField label={m.tiltOffset} value={o.tiltOffset ?? 0} buttons testId="manual-tilt-offset" onCommit={(tiltOffset) => orient({ tiltOffset })} />
        </div>
        <div className="manual-switches">
          <Switch label={t.invertPanLabel} on={Boolean(o.invertPan)} onToggle={() => void orient({ invertPan: !o.invertPan }).catch(() => undefined)} />
          <Switch label={t.invertTiltLabel} on={Boolean(o.invertTilt)} onToggle={() => void orient({ invertTilt: !o.invertTilt }).catch(() => undefined)} />
          <Switch label={m.swap} on={Boolean(o.swapPanTilt)} onToggle={() => void orient({ swapPanTilt: !o.swapPanTilt }).catch(() => undefined)} />
        </div>
        {errors.orient && (
          <p className="error" role="alert">
            {errors.orient}
          </p>
        )}
      </section>

      {travel && (
        <section className="manual-cal-stops" aria-labelledby={`manual-stops-${head}`}>
          <h4 id={`manual-stops-${head}`}>{m.stops}</h4>
          <p className="hint">{m.stopsHelp}</p>
          <div className="manual-fields">
            {AXES.map((axis) => (
              <StopRow key={axis} axis={axis} range={o.limits?.[axis]} travel={axis === "pan" ? travel.panMax : travel.tiltMax} onSet={(a, range) => orient({ limits: { [a]: range } }, "stops")} />
            ))}
          </div>
          {errors.stops && (
            <p className="error" role="alert">
              {errors.stops}
            </p>
          )}
        </section>
      )}

      {travel && (
        <section className="manual-cal-travel" aria-labelledby={`manual-travel-${head}`}>
          <h4 id={`manual-travel-${head}`}>{m.travel}</h4>
          <p className="hint">{m.travelHelp}</p>
          <p data-testid="manual-travel-now">
            {m.travelApplies
              .replace("{pan}", num(t, travel.panMax))
              .replace("{panFrom}", sourceName(travel.applies.panMax))
              .replace("{tilt}", num(t, travel.tiltMax))
              .replace("{tiltFrom}", sourceName(travel.applies.tiltMax))}
            <br />
            <small className="hint">{m.travelDefinition.replace("{pan}", num(t, travel.definition.panMax)).replace("{tilt}", num(t, travel.definition.tiltMax))}</small>
          </p>
          <div className="swatches" role="radiogroup" aria-label={t.headsScope}>
            {(["model", "fixture"] as const).map((s) => (
              <button
                key={s}
                type="button"
                ref={(el) => void (scopeButtons.current[s] = el)}
                className={`ghost${scope === s ? " on" : ""}`}
                role="radio"
                aria-checked={scope === s}
                tabIndex={scope === s ? 0 : -1}
                onKeyDown={(e) => moveScope(e, s)}
                onClick={() => setScope(s)}
              >
                {s === "model" ? t.headsScopeModel : t.headsScopeFixture}
              </button>
            ))}
          </div>
          <div className="manual-fields">
            {AXES.map((axis) => (
              <label key={axis} className="field manual-field">
                <span>{axis === "pan" ? m.travelPan : m.travelTilt}</span>
                <input
                  type="text"
                  autoComplete="off"
                  value={travelDraft[axis] ?? num(t, axis === "pan" ? travel.panMax : travel.tiltMax)}
                  aria-invalid={travelInvalid(axis) || undefined}
                  onChange={(e) => setTravelDraft((d) => ({ ...d, [axis]: e.target.value }))}
                />
              </label>
            ))}
          </div>
          {travelBad && (
            <p className="error" role="alert">
              {m.travelRange}
            </p>
          )}
          <div className="row actions">
            <button
              type="button"
              disabled={travelBad || (travelChanged("pan") === undefined && travelChanged("tilt") === undefined)}
              onClick={() => {
                const pan = travelChanged("pan");
                const tilt = travelChanged("tilt");
                void setTravelFor({
                  ...(pan !== undefined ? { panMax: pan } : {}),
                  ...(tilt !== undefined ? { tiltMax: tilt } : {}),
                });
              }}
            >
              {scope === "model" ? m.travelSetModel : m.travelSetFixture}
            </button>
            {scopeCorrection && (
              <button type="button" className="ghost" onClick={() => void setTravelFor({ panMax: null, tiltMax: null })}>
                {scope === "model" ? m.travelResetModel : m.travelResetFixture}
              </button>
            )}
          </div>
          {(keeping.length > 0 || (scope === "model" && travel.model && travel.modesKeepingTravel.length > 0)) && (
            <p className="hint" data-testid="manual-keeping">
              {m.travelKeeping.replace("{modes}", (keeping.length ? keeping : travel.modesKeepingTravel).map((x) => quoted(t, x)).join(", "))}
            </p>
          )}
          {errors.travel && (
            <p className="error" role="alert">
              {errors.travel}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
