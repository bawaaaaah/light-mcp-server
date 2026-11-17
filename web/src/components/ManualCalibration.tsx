/**
 * Manual calibration of a moving head (T8, lot 6; docs/specs/venue-fixtures-stage.md, « Lyres », calibration manuelle):
 * « aim a mark and correct the gap ». The head aims a known mark with its calibration as it is (`position.aim`), the
 * correction pad (XyPad `span`, ± a few degrees around that aim, on the output's grid) brings its beam onto the mark,
 * then `calibration.correct` folds the gap into the pan and tilt offsets. Every field writes the orientation
 * (`venue.fixture.orient`, once per gesture) or the travel (`venue.fixture.travel.set`) and the head aims the mark
 * again: it moves live. Mounted per head (keyed by its id); the confirmation that the head will move is asked by the
 * assistant (Calibration.tsx), once when the tab opens.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactElement, type RefObject } from "react";
import { cmd } from "../api";
import { useT } from "../i18n-context";
import { useDomainEvents } from "../hooks/useTopic";
import { useMotionHeads } from "../hooks/useMotionHeads";
import { useMotionLock } from "../hooks/useMotionLock";
import { stricter } from "../motionLock";
import { CORRECTION_SPANS, defaultSpan, type CorrectionSpan, type PadSpan, type Point } from "../correctionPad";
import {
  beyondStops,
  edgeOutside,
  fieldText,
  movedSince,
  nudgeDeg,
  parseDeg,
  parseNumber,
  roundDeg,
  stopBar,
  stopProblem,
  type Axis,
  type Range,
  type StopProblem,
  type Stops,
} from "../manualCalibration";
import { isFrench, quoted } from "../typography";
import type { Texts } from "../i18n";
import { XyPad } from "./XyPad";
import { DmxModeSection } from "./DmxModeSection";
import { ScopeRadio, SegmentedRadio } from "./SegmentedRadio";

/** The spans of the correction pad, as the radio group shows them. */
const SPAN_OPTIONS = CORRECTION_SPANS.map((s) => ({ value: s, label: `± ${s}°` }));

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

const locale = (t: Texts): string => (isFrench(t) ? "fr" : "en");
const num = (t: Texts, v: number, digits = 1): string =>
  v.toLocaleString(locale(t), {
    maximumFractionDigits: digits,
    useGrouping: false,
  });
const signed = (t: Texts, v: number, digits = 1): string => `${v > 0 ? "+" : v < 0 ? "−" : ""}${num(t, Math.abs(v), digits)}`;
/** A step of the output: small numbers keep their significant digits (0,008°), large ones a couple of decimals. */
const stepText = (t: Texts, v: number): string => `${v.toLocaleString(locale(t), v < 0.1 ? { maximumSignificantDigits: 2 } : { maximumFractionDigits: 2 })}°`;
/** A gap below this (degrees) is nothing to apply: « Appliquer » is no longer the primary action. */
const NO_GAP = 0.05;

/**
 * A degree field written once per gesture: on Enter, on leaving it, after a pause in typing, or after the arrows
 * (± 0.1°, Shift ± 1°) and the − / + buttons stop. Typed with a comma or a point; shown to the hundredth it is stored
 * at, so leaving it untouched writes nothing. The draft stays shown until the stored value changes (no flicker back
 * to the old value while the write is on its way), and goes once the write is answered unless the operator typed
 * since (the server may normalise it: a heading of 360 reads back 0). A pause pending when the field goes away
 * (another head chosen, the tab left) is written, not lost.
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
  /** Typed since the last write was sent: such a draft is never replaced under the operator's fingers. */
  const dirty = useRef(false);
  /** The text waiting for the pause in typing. */
  const pending = useRef<string | null>(null);
  /** The value sent and not come back yet: Enter then leaving the field writes it once. */
  const sent = useRef<number | null>(null);
  // the stored value moved (this field's write came back, or another client's): shown unless the operator typed since
  // (in the field, or by the − / + buttons, which leave it unfocused)
  useEffect(() => {
    sent.current = null;
    if (!dirty.current) {
      setDraft(null);
    }
  }, [value]);
  const commit = (text: string) => {
    window.clearTimeout(timer.current);
    pending.current = null;
    const v = parseDeg(text);
    if (v === undefined) {
      setBad(true);
      return;
    }
    setBad(false);
    dirty.current = false;
    const next = roundDeg(v);
    if (next === roundDeg(value)) {
      setDraft(null);
      return;
    }
    if (next === sent.current) {
      return;
    }
    sent.current = next;
    // answered (written or refused): the same value may be sent again, the draft gives way unless typed since
    const settle = () => {
      sent.current = null;
      if (!dirty.current) {
        setDraft(null);
      }
    };
    void onCommit(next).then(settle, settle);
  };
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      if (pending.current !== null) {
        commitRef.current(pending.current);
      }
    },
    [],
  );
  const later = (text: string) => {
    window.clearTimeout(timer.current);
    pending.current = text;
    timer.current = window.setTimeout(() => commit(text), IDLE_MS);
  };
  const typed = (text: string) => {
    dirty.current = true;
    setDraft(text);
    later(text);
  };
  const shown = draft ?? fieldText(value, locale(t));
  const step = (sign: 1 | -1, shift = false) => {
    const next = nudgeDeg(parseDeg(shown) ?? value, sign > 0 ? "ArrowUp" : "ArrowDown", shift);
    if (next !== undefined) {
      typed(fieldText(next, locale(t)));
    }
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      commit(shown);
      return;
    }
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") {
      return;
    }
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
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          value={shown}
          aria-invalid={bad || undefined}
          aria-describedby={`${id}-help`}
          onBlur={() => {
            if (draft !== null && dirty.current) {
              commit(draft);
            }
          }}
          onChange={(e) => typed(e.target.value)}
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

/**
 * A switch of the orientation: a toggle button (aria-pressed) drawn as a sliding switch, a finger's size, inert while
 * its write is on its way (a double press writes once). aria-disabled, not disabled: the button keeps the focus.
 */
function Switch({ label, on, onToggle }: { label: string; on: boolean; onToggle: () => Promise<unknown> }): ReactElement {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const toggle = () => {
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
    setBusy(true);
    void onToggle()
      .catch(() => undefined)
      .finally(() => {
        busyRef.current = false;
        setBusy(false);
      });
  };
  return (
    <div className="invert-row">
      <span className="invert-label" aria-hidden="true" onClick={toggle}>
        {label}
      </span>
      <button type="button" className={`manual-switch${on ? " on" : ""}`} aria-pressed={on} aria-label={label} aria-busy={busy || undefined} aria-disabled={busy || undefined} onClick={toggle}>
        <span className="manual-switch-track" aria-hidden="true">
          <span className="manual-switch-knob" />
        </span>
      </button>
    </div>
  );
}

/**
 * One axis' useful stop: from / to in logical degrees, sent once both ends are valid and the row is left (or on
 * Enter), never the first end alone while the second is being typed (a lone end is said: both are expected); an end
 * beyond the travel is said as soon as it is typed. A pair pending when the row goes away (another head chosen, the
 * tab left) is sent, not lost. « Retirer » removes the stop.
 */
function StopRow({ axis, range, travel, onSet }: { axis: Axis; range: Range | undefined; travel: number; onSet: (axis: Axis, range: Range | null) => Promise<unknown> }): ReactElement {
  const t = useT();
  const m = t.manualCal;
  const id = useId();
  const half = travel / 2;
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const [problem, setProblem] = useState("");
  const fromInput = useRef<HTMLInputElement>(null);
  const toInput = useRef<HTMLInputElement>(null);
  /** The stop sent and not come back yet: Enter then leaving the row writes it once. */
  const sent = useRef<string | null>(null);
  // the stored stop moved (written, removed, changed elsewhere): the drafts and their alert give way to it
  const stored = range ? `${range[0]},${range[1]}` : "";
  useEffect(() => {
    setFrom(null);
    setTo(null);
    setProblem("");
    sent.current = null;
  }, [stored]);
  const fromText = from ?? (range ? fieldText(range[0], locale(t)) : "");
  const toText = to ?? (range ? fieldText(range[1], locale(t)) : "");
  const say = (p: StopProblem | undefined): string => (!p ? "" : p.kind === "order" ? m.stopOrder : m.stopOutside.replace("{half}", num(t, p.half)));
  /** An end typed beyond the travel, said at once (the other end may still be empty). */
  const edgeProblem = (a: string, b: string): string => {
    for (const text of [a, b]) {
      const v = parseDeg(text);
      const p = v === undefined ? undefined : edgeOutside(v, travel);
      if (p) {
        return say(p);
      }
    }
    return "";
  };
  const send = () => {
    if (from === null && to === null) {
      return;
    }
    const a = parseDeg(fromText);
    const b = parseDeg(toText);
    if (a === undefined || b === undefined) {
      const filled = [fromText, toText].filter((x) => x.trim()).length;
      // both ends cleared: nothing to send (« Retirer » removes a stop)
      setProblem(filled === 2 ? m.notANumber : filled === 1 ? edgeProblem(fromText, toText) || m.stopBoth : "");
      return;
    }
    const next: Range = [roundDeg(a), roundDeg(b)];
    const p = stopProblem(next, travel);
    if (p) {
      setProblem(say(p));
      return;
    }
    setProblem("");
    if (range && next[0] === range[0] && next[1] === range[1]) {
      setFrom(null);
      setTo(null);
      return;
    }
    const key = `${next[0]},${next[1]}`;
    if (sent.current === key) {
      return;
    }
    sent.current = key;
    void onSet(axis, next).catch(() => {
      sent.current = null;
    });
  };
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => () => sendRef.current(), []);
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      send();
    }
  };
  /** Leaving the row (not going from one end to the other): the pair is sent. */
  const onBlur = (e: FocusEvent<HTMLInputElement>) => {
    if (e.relatedTarget !== fromInput.current && e.relatedTarget !== toInput.current) {
      send();
    }
  };
  // the stop drawn over the travel: where it leaves the head free, kept on the bar
  const bar = stopBar(range, travel);
  const name = m.stopAxis[axis];
  return (
    <fieldset className="manual-stop" aria-describedby={`${id}-state`}>
      <legend>{name}</legend>
      <div className="manual-stop-fields">
        <label>
          <span>{m.stopFrom}</span>
          <input
            ref={fromInput}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            aria-label={`${name} · ${m.stopFrom}`}
            value={fromText}
            aria-invalid={Boolean(problem) || undefined}
            onChange={(e) => {
              setFrom(e.target.value);
              setProblem(edgeProblem(e.target.value, toText));
            }}
            onBlur={onBlur}
            onKeyDown={onKey}
          />
        </label>
        <label>
          <span>{m.stopTo}</span>
          <input
            ref={toInput}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            aria-label={`${name} · ${m.stopTo}`}
            value={toText}
            aria-invalid={Boolean(problem) || undefined}
            onChange={(e) => {
              setTo(e.target.value);
              setProblem(edgeProblem(fromText, e.target.value));
            }}
            onBlur={onBlur}
            onKeyDown={onKey}
          />
        </label>
        <button type="button" className="ghost" disabled={!range} aria-label={`${m.stopRemove} · ${name}`} onClick={() => void onSet(axis, null).catch(() => undefined)}>
          {m.stopRemove}
        </button>
      </div>
      <div className="manual-stop-bar" aria-hidden="true">
        <span style={{ left: `${bar.left}%`, width: `${bar.width}%` }} />
      </div>
      <small id={`${id}-state`} className={problem ? "error" : "hint"} role={problem ? "alert" : undefined}>
        {problem ||
          (range
            ? m.stopRange
                .replace("{from}", signed(t, range[0], 2))
                .replace("{to}", signed(t, range[1], 2))
                .replace("{half}", num(t, half))
            : m.stopNone.replace("{half}", num(t, half)))}
      </small>
    </fieldset>
  );
}

export function ManualCalibration({
  head,
  name,
  mark,
  markValid,
  onApplied,
  aimButton,
}: {
  head: string;
  name: string;
  mark: Mark;
  /** False while the mark's height is not a number: nothing is aimed nor measured on it. */
  markValid: boolean;
  onApplied: () => void;
  /** « Viser le repère », focused by the assistant once the move is confirmed. */
  aimButton?: RefObject<HTMLButtonElement | null>;
}): ReactElement {
  const t = useT();
  const m = t.manualCal;
  const [fixture, setFixture] = useState<Patched | null>(null);
  const [travel, setTravel] = useState<Travel | null>(null);
  /** The aim the calibration computes for the mark (logical): the correction pad's centre; null until aimed. */
  const [center, setCenter] = useState<Point | null>(null);
  const [span, setSpan] = useState<CorrectionSpan | null>(null);
  const [preview, setPreview] = useState<Correction | null>(null);
  /** Where the head was (logical) when the gap was measured: moved since by more than half a real step, the preview is stale. */
  const [measuredAt, setMeasuredAt] = useState<Point | null>(null);
  /** A measure or an application on its way: a double press sends once (aria-disabled: the button keeps the focus). */
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  /** The axes given a stop while the head is frozen hard: the output does not hold it there until it is unfrozen. */
  const [stopWhileFrozen, setStopWhileFrozen] = useState<Axis[]>([]);
  /** Per section, the server's last refusal: said where the operator is working. */
  const [errors, setErrors] = useState<Partial<Record<"fixture" | "aim" | "orient" | "stops" | "travel" | "correct", string>>>({});
  const [keeping, setKeeping] = useState<string[]>([]);
  const [scope, setScope] = useState<"model" | "fixture">("model");
  const [travelDraft, setTravelDraft] = useState<Partial<Record<Axis, string>>>({});
  const lockView = useMotionLock();
  const frozenHard = Boolean(lockView && stricter(lockView.lock.heads[head] ?? "off", lockView.lock.level) === "hard");
  const { heads } = useMotionHeads({ fixtures: [head] });
  const manual = heads[0]?.manual ?? null;
  const manualRef = useRef(manual);
  manualRef.current = manual;
  const say = useCallback((key: keyof typeof errors, message = "") => setErrors((e) => ({ ...e, [key]: message })), []);
  const markKey = JSON.stringify(mark);
  const markRef = useRef(mark);
  markRef.current = mark;
  /** Bumped by every aim: an answer overtaken by a later aim (a field typed fast) is dropped. */
  const aimSequence = useRef(0);
  /** Bumped by every measure and every change of mark: a gap measured on another mark is dropped. */
  const correctSequence = useRef(0);
  /** Gone (another head chosen, the tab left): a field's last write still goes out, but the head is not aimed again. */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reload = useCallback(() => {
    void cmd<Patched[]>("venue.fixture.list")
      .then((rows) => {
        setFixture(rows.find((r) => r.id === head) ?? null);
        say("fixture");
      })
      .catch((e: Error) => say("fixture", e.message));
    void cmd<Travel>("venue.fixture.travel", { fixture: head })
      .then(setTravel)
      .catch((e: Error) => say("travel", e.message));
  }, [head, say]);
  useEffect(reload, [reload]);
  // changed elsewhere (the plan's orientation panel, the fixture menu, another client): read again
  useDomainEvents(["patch", "calibration"], reload);
  // frozen or unfrozen: the refusals said before no longer hold
  useEffect(() => {
    setErrors({});
    if (!frozenHard) {
      setStopWhileFrozen([]);
    }
  }, [frozenHard]);

  /** Aims the mark with the calibration as it is: the head moves there, the pad centres on it. */
  const aim = useCallback(async () => {
    const sequence = ++aimSequence.current;
    say("aim");
    setPreview(null);
    try {
      const r = await cmd<{
        results: { pan?: number; tilt?: number; error?: string }[];
      }>("position.aim", { fixtures: [head], ...markRef.current });
      if (sequence !== aimSequence.current) {
        return;
      }
      const res = r.results[0];
      if (res?.pan !== undefined && res.tilt !== undefined) {
        setCenter({ pan: res.pan, tilt: res.tilt });
      }
      if (res?.error) {
        say("aim", res.error);
      }
    } catch (e) {
      if (sequence === aimSequence.current) {
        say("aim", (e as Error).message);
      }
    }
  }, [head, say]);
  // another mark: the aim and the measure no longer hold, aim again only when asked
  useEffect(() => {
    aimSequence.current++;
    correctSequence.current++;
    setCenter(null);
    setPreview(null);
    setMeasuredAt(null);
  }, [markKey]);
  const aimedOnce = center !== null;
  /** After a write, the head aims the mark again with it, live: not when frozen hard (it cannot move), nor on a height being typed. */
  const reaim = async () => {
    if (aimedOnce && !frozenHard && markValid && mounted.current) {
      await aim();
    }
  };

  /** Writes part of the orientation, then aims the mark again with it (once aimed): the head moves live. */
  const orient = async (change: Partial<Orientation> | { limits: Partial<Record<Axis, Range | null>> }, section: "orient" | "stops" = "orient") => {
    say(section);
    try {
      const r = await cmd<{ fixture: Patched }>("venue.fixture.orient", {
        id: head,
        ...change,
      });
      setFixture(r.fixture);
      // a stop set (not removed) while frozen hard: the head may stay beyond it, said when it does
      if (frozenHard && "limits" in change) {
        const set = AXES.filter((a) => change.limits?.[a]);
        setStopWhileFrozen((axes) => [...new Set([...axes, ...set])]);
      }
      await reaim();
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
      await reaim();
    } catch (e) {
      say("travel", (e as Error).message);
    }
  };

  const correct = async (apply: boolean) => {
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
    setBusy(true);
    const sequence = ++correctSequence.current;
    const at = manualRef.current;
    say("correct");
    try {
      const r = await cmd<Correction>("calibration.correct", {
        fixture: head,
        ...markRef.current,
        apply,
      });
      if (sequence !== correctSequence.current) {
        return;
      }
      setPreview(r);
      setMeasuredAt(apply ? null : at);
      if (apply) {
        if (r.aimed?.pan !== undefined && r.aimed.tilt !== undefined) {
          setCenter({ pan: r.aimed.pan, tilt: r.aimed.tilt });
        }
        reload();
        onApplied();
      }
    } catch (e) {
      if (sequence === correctSequence.current) {
        say("correct", (e as Error).message);
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
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
  // the stop changed (written here or elsewhere): a refusal said about the old one no longer holds
  const limitsKey = JSON.stringify(o.limits ?? null);
  useEffect(() => say("stops"), [limitsKey, say]);
  const travelPoint = travel ? { pan: travel.panMax, tilt: travel.tiltMax } : null;
  const beyond = manual && travelPoint && travel ? beyondStops(manual, travelPoint, o.limits, travel.step) : [];
  /** The measured gap no longer says where the head is: it moved (pad, another client, a re-aim) since. */
  const stale = Boolean(preview && !preview.applied && travelPoint && travel && (!measuredAt || !manual || movedSince(measuredAt, manual, travelPoint, travel.step)));
  const spanNow = travel ? (span ?? defaultSpan(travel.step)) : null;
  const stepOf = (axis: Axis) => (travel ? `${axis} ${stepText(t, travel.step[axis])} (${travel.fine[axis] ? m.stepFine : m.stepCoarse})` : "");
  const coarse = travel ? AXES.filter((a) => !travel.fine[a]) : [];
  const sourceName = (s: TravelSource) => m.sources[s];
  const scopeCorrection = travel ? (scope === "model" ? travel.model : travel.own) : null;
  const travelKey = (axis: Axis) => (axis === "pan" ? "panMax" : "tiltMax");
  /**
   * The travel to write for an axis, when it differs from the scope's own correction (not from the travel applied):
   * the one typed, or for « Cet appareil seul » without a correction of its own on the axis, the value it inherits
   * (from its model or its definition), pinned for the fixture alone.
   */
  const travelChanged = (axis: Axis): number | undefined => {
    if (!travel) {
      return undefined;
    }
    const text = travelDraft[axis];
    const v = text !== undefined ? parseNumber(text) : scope === "fixture" ? travel[travelKey(axis)] : undefined;
    return v !== undefined && v !== scopeCorrection?.[travelKey(axis)] ? v : undefined;
  };
  /** A travel typed that the server would refuse: not a number, or outside 1..1080°. */
  const travelInvalid = (axis: Axis): boolean => {
    const text = travelDraft[axis];
    if (text === undefined) {
      return false;
    }
    const v = parseNumber(text);
    return v === undefined || v < TRAVEL_MIN || v > TRAVEL_MAX;
  };
  const travelBad = AXES.some(travelInvalid);
  const smallGap = preview !== null && preview.beforeDeg < NO_GAP;

  return (
    <div className="manual-cal">
      <p className="hint">{m.help}</p>
      {frozenHard && <p className="warn">{m.frozen}</p>}
      {errors.fixture && (
        <p className="error" role="alert">
          {errors.fixture}
        </p>
      )}

      <section className="manual-cal-aim" aria-labelledby={`manual-aim-${head}`}>
        <h4 id={`manual-aim-${head}`} tabIndex={-1}>
          {m.padTitle}
        </h4>
        <div className="row actions">
          <button ref={aimButton} type="button" className={aimedOnce ? "" : "primary"} disabled={frozenHard || !markValid} onClick={() => void aim()}>
            {aimedOnce ? m.aimAgain : m.aim}
          </button>
          {travel && <SegmentedRadio label={m.span} options={SPAN_OPTIONS} value={spanNow} onChange={setSpan} />}
        </div>
        {!markValid && <p className="hint">{m.heightFirst}</p>}
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
          <button type="button" disabled={frozenHard || !aimedOnce || !markValid} aria-disabled={busy || undefined} aria-busy={busy || undefined} onClick={() => void correct(false)}>
            {m.measure}
          </button>
          {preview && !preview.applied && !stale && (
            <button type="button" className={smallGap ? "" : "primary"} disabled={frozenHard} aria-disabled={busy || undefined} aria-busy={busy || undefined} onClick={() => void correct(true)}>
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
          {stale && (
            <p className="warn" data-testid="manual-stale">
              {m.moved}
            </p>
          )}
          {preview && (
            <div className={stale ? "manual-cal-stale" : undefined} data-testid="manual-preview">
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
            </div>
          )}
        </div>
      </section>

      {/* the orientation read first: its fields never show zeros, nor write them, before it is known */}
      {fixture && (
        <section className="manual-cal-orient" aria-labelledby={`manual-orient-${head}`}>
          <h4 id={`manual-orient-${head}`}>{m.orientation}</h4>
          <div className="manual-fields">
            <DegreeField label={m.yaw} value={o.yaw ?? 0} help={m.yawHelp} buttons testId="manual-yaw" onCommit={(yaw) => orient({ yaw })} />
            <DegreeField label={m.panOffset} value={o.panOffset ?? 0} buttons testId="manual-pan-offset" onCommit={(panOffset) => orient({ panOffset })} />
            <DegreeField label={m.tiltOffset} value={o.tiltOffset ?? 0} buttons testId="manual-tilt-offset" onCommit={(tiltOffset) => orient({ tiltOffset })} />
          </div>
          <div className="manual-switches">
            <Switch label={t.invertPanLabel} on={Boolean(o.invertPan)} onToggle={() => orient({ invertPan: !o.invertPan })} />
            <Switch label={t.invertTiltLabel} on={Boolean(o.invertTilt)} onToggle={() => orient({ invertTilt: !o.invertTilt })} />
            <Switch label={m.swap} on={Boolean(o.swapPanTilt)} onToggle={() => orient({ swapPanTilt: !o.swapPanTilt })} />
          </div>
          {errors.orient && (
            <p className="error" role="alert">
              {errors.orient}
            </p>
          )}
        </section>
      )}

      {travel && fixture && (
        <section className="manual-cal-stops" aria-labelledby={`manual-stops-${head}`}>
          <h4 id={`manual-stops-${head}`}>{m.stops}</h4>
          <p className="hint">{m.stopsHelp}</p>
          <div className="manual-fields">
            {AXES.map((axis) => (
              <StopRow key={axis} axis={axis} range={o.limits?.[axis]} travel={axis === "pan" ? travel.panMax : travel.tiltMax} onSet={(a, range) => orient({ limits: { [a]: range } }, "stops")} />
            ))}
          </div>
          {frozenHard && beyond.some((a) => stopWhileFrozen.includes(a)) && (
            <p className="warn" role="status" data-testid="manual-stop-frozen">
              {m.stopFrozen}
            </p>
          )}
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
          <ScopeRadio value={scope} onChange={setScope} />
          <div className="manual-fields">
            {AXES.map((axis) => (
              <label key={axis} className="field manual-field">
                <span>{axis === "pan" ? m.travelPan : m.travelTilt}</span>
                <input
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={travelDraft[axis] ?? fieldText(travel[travelKey(axis)], locale(t))}
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
