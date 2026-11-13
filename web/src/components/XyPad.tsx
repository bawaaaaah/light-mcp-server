import { useCallback, useEffect, useId, useRef, useState, type ReactElement } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { useCommandEvents, useTopic } from "../hooks/useTopic";
import { quoted } from "../typography";

export interface Position {
  pan: number;
  tilt: number;
}
export type MotionLayer = "lock" | "manual" | "target" | "look" | "hold" | "rest";
export interface MotionAxis {
  layer: MotionLayer;
  owner: string | null;
  name?: string;
  position: number;
  moving: boolean;
  from?: number;
  to?: number;
  remainingMs?: number;
  error?: string;
}
interface MotionOwner {
  owner: string;
  name?: string;
}
export interface MotionHead {
  id: string;
  name?: string;
  manual: Position | null;
  sent: Position | null;
  rest: Position & { set: boolean };
  motion: {
    lock: "off" | "soft" | "hard";
    pan: MotionAxis;
    tilt: MotionAxis;
    masked: MotionOwner[];
    released: MotionOwner[];
  } | null;
}
type MotionTopicHead = Pick<MotionHead, "id" | "sent" | "rest" | "motion">;
interface MotionGroup {
  id: string;
  members: { fixtures: string[]; groups: string[] };
  selector?: { role?: string; tags?: string[] };
}
interface FixtureIdentity {
  id: string;
  role?: string;
  tags?: string[];
}

type XyPadProps = {
  group?: string;
  fixture?: string;
  label?: string;
  onError: (msg: string) => void;
  disabled?: boolean;
  resync?: unknown;
  /** Per-head rest controls belong on the fixture panel, not on a group or all-heads pad. */
  restControls?: boolean;
};

/**
 * XY pad for moving heads: X = pan, Y = tilt (top = 1). Sends `position.set` at most every 40 ms
 * while dragging. The permanent dot reads the position really sent, and each axis names its owner.
 * `light:motion` announces ownership changes; `position.list` seeds and resynchronises the report.
 */
export function XyPad({ group, fixture, label, onError, disabled = false, resync, restControls = false }: XyPadProps): ReactElement {
  const t = useT();
  const [heads, setHeads] = useState<MotionHead[]>([]);
  const [groupFixtures, setGroupFixtures] = useState<ReadonlySet<string> | null>(null);
  const [pos, setPos] = useState<Position | null>(null);
  const pad = useRef<HTMLDivElement>(null);
  const pending = useRef<Position | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const writes = useRef<Promise<void>>(Promise.resolve());
  const headsRef = useRef<MotionHead[]>([]);
  const reading = useRef(false);
  const readAgain = useRef(false);
  const readRef = useRef<() => void>(() => undefined);
  const groupReadSequence = useRef(0);
  const motionSequence = useRef(0);
  const hintId = useId();
  const statusId = useId();
  const target = fixture ? { fixtures: [fixture] } : group ? { group } : {};
  // The unmount flush runs the first render's closure: it reads the current target and callbacks here.
  const targetRef = useRef(target);
  targetRef.current = target;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const applyHeads = useCallback(
    (list: MotionHead[]) => {
      headsRef.current = list;
      setHeads(list);
      // A read must not pull the dot back while the gesture is still being sent.
      if (timer.current !== undefined || pending.current) return;
      const scoped = group ? list.filter((h) => groupFixtures?.has(h.id)) : list;
      const selected = fixture ? list.find((h) => h.id === fixture) : scoped.find((h) => h.manual) ?? scoped[0];
      // `pos` is the requested manual position; mixed targets never show one head's value as the group's.
      const manuals = scoped.map((h) => h.manual);
      const same = manuals.every((p) => p?.pan === manuals[0]?.pan && p?.tilt === manuals[0]?.tilt);
      setPos(same ? selected?.manual ?? null : null);
    },
    [fixture, group, groupFixtures],
  );
  const read = useCallback(async () => {
    // Coalesce callers instead of superseding an in-flight read forever on a slow connection.
    if (reading.current) {
      readAgain.current = true;
      return;
    }
    reading.current = true;
    const motionAtStart = motionSequence.current;
    try {
      const list = await cmd<MotionHead[]>("position.list");
      // A motion event received while reading is newer than this answer.
      if (motionAtStart === motionSequence.current) applyHeads(list);
    } catch {
      // The next motion event, command or reconnection tries again.
    } finally {
      reading.current = false;
      if (readAgain.current) {
        readAgain.current = false;
        readRef.current();
      }
    }
  }, [applyHeads]);
  readRef.current = () => void read();
  const readGroup = useCallback(async () => {
    if (!group) {
      setGroupFixtures(null);
      return;
    }
    const sequence = ++groupReadSequence.current;
    try {
      const [groups, fixtures] = await Promise.all([cmd<MotionGroup[]>("group.list"), cmd<FixtureIdentity[]>("venue.fixture.list")]);
      if (sequence !== groupReadSequence.current) return;
      const byId = new Map(groups.map((g) => [g.id, g]));
      const walk = (id: string, seen = new Set<string>()): Set<string> => {
        const out = new Set<string>();
        const g = byId.get(id);
        if (!g || seen.has(id)) return out;
        seen.add(id);
        g.members.fixtures.forEach((f) => out.add(f));
        if (g.selector) {
          for (const f of fixtures) {
            if (g.selector.role && f.role !== g.selector.role) continue;
            if (g.selector.tags && !g.selector.tags.every((tag) => f.tags?.includes(tag))) continue;
            out.add(f.id);
          }
        }
        for (const sub of g.members.groups) for (const f of walk(sub, seen)) out.add(f);
        return out;
      };
      setGroupFixtures(walk(group));
    } catch {
      if (sequence === groupReadSequence.current) setGroupFixtures(new Set());
    }
  }, [group]);

  useEffect(() => {
    void read();
  }, [group, resync, read]);
  useEffect(() => {
    // light:motion is not a position feed: refresh sent at a quiet 5 Hz while this pad is visible.
    const interval = window.setInterval(() => void read(), 200);
    return () => window.clearInterval(interval);
  }, [read]);
  useEffect(() => {
    // A gesture belongs to the target where it started, never to the next head selected meanwhile.
    pending.current = null;
    window.clearTimeout(timer.current);
    timer.current = undefined;
    setPos(null);
    if (group) setGroupFixtures(null);
  }, [group, fixture]);
  useCommandEvents(["position.", "panic", "show."], () => void read());
  useEffect(() => void readGroup(), [readGroup, resync]);
  useCommandEvents(["group.", "venue.fixture."], () => void readGroup());
  const motion = useTopic<{ heads: MotionTopicHead[] } | null>("light:motion", null);
  useEffect(() => {
    if (!motion) return;
    motionSequence.current += 1;
    // The topic has no fixture names or manual field: keep those from position.list.
    const known = new Map(headsRef.current.map((h) => [h.id, h]));
    applyHeads(
      motion.heads.map((h) => {
        const old = known.get(h.id);
        return { ...old, ...h, name: old?.name, manual: old?.manual ?? null };
      }),
    );
  }, [motion, applyHeads]);

  const flush = () => {
    timer.current = undefined;
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    // Writes stay ordered and keep the target captured when this gesture was flushed.
    const gestureTarget = { ...targetRef.current, ...(targetRef.current.fixtures ? { fixtures: [...targetRef.current.fixtures] } : {}) };
    const request = writes.current
      .then(async () => {
        await cmd("position.set", { ...gestureTarget, ...p });
      })
      .catch((e: Error) => onErrorRef.current(e.message));
    writes.current = request;
    timer.current = window.setTimeout(flush, 40);
  };
  // On unmount only: stop the loop, and send the gesture value not sent yet.
  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      timer.current = undefined;
      if (pending.current) flush();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once, on unmount: `flush` sends to this pad's own target
    [],
  );

  const send = (p: Position) => {
    setPos(p);
    pending.current = p;
    if (timer.current === undefined) flush();
  };
  const fromEvent = (e: React.PointerEvent) => {
    const r = pad.current!.getBoundingClientRect();
    const clamp = (v: number) => Math.max(0, Math.min(1, v));
    return { pan: clamp((e.clientX - r.left) / r.width), tilt: clamp(1 - (e.clientY - r.top) / r.height) };
  };
  const runMotion = async (name: "position.releaseTop" | "position.home" | "position.rest.set" | "position.rest.clear", args: Record<string, unknown> = {}) => {
    const actionTarget = { ...targetRef.current, ...(targetRef.current.fixtures ? { fixtures: [...targetRef.current.fixtures] } : {}) };
    try {
      if (name === "position.rest.set" || name === "position.rest.clear") {
        // Rest settings do not interrupt a manual gesture. `rest.set` receives the visible, really sent point.
        await cmd(name, { ...actionTarget, ...args });
      } else {
        // A release discards a trailing gesture, then waits for writes already sent to this same target.
        pending.current = null;
        window.clearTimeout(timer.current);
        timer.current = undefined;
        await writes.current;
        await cmd(name, { ...actionTarget, ...args });
      }
      await read();
    } catch (e) {
      onErrorRef.current((e as Error).message);
    }
  };

  const scopedHeads = fixture ? heads.filter((h) => h.id === fixture) : group ? heads.filter((h) => groupFixtures?.has(h.id)) : heads;
  const head = scopedHeads.find((h) => h.manual) ?? scopedHeads[0];
  const sentOf = (h: MotionHead | undefined) => h?.sent ?? null;
  const sent = sentOf(head);
  const sameSent = scopedHeads.every((h) => {
    const p = sentOf(h);
    return p?.pan === sent?.pan && p?.tilt === sent?.tilt;
  });
  const manualValues = scopedHeads.map((h) => h.manual);
  const sameManual = manualValues.every((p) => p?.pan === manualValues[0]?.pan && p?.tilt === manualValues[0]?.tilt);
  const shown = pos ?? (sameManual ? head?.manual : null) ?? (sameSent ? sent : null);
  const axisLabel = (axis: "pan" | "tilt") => {
    const labels = scopedHeads.map((h) => {
      const status = h.motion?.[axis];
      if (!status) return t.motionLayers.rest;
      const name = status.name ?? (status.owner?.startsWith("look:") ? status.owner.slice(5) : status.owner ?? "—");
      return t.motionLayers[status.layer].replace("{name}", status.layer === "look" ? quoted(t, name) : name);
    });
    if (!labels.length) return "—";
    return labels.every((value) => value === labels[0]) ? labels[0]! : t.motionMixed;
  };
  const axisErrors = (axis: "pan" | "tilt") => [...new Set(scopedHeads.map((h) => h.motion?.[axis].error).filter((e): e is string => Boolean(e)))];
  const released = new Set(scopedHeads.flatMap((h) => h.motion?.released.map((r) => r.owner) ?? []));
  const byOwner = new Map<string, MotionOwner>();
  for (const h of scopedHeads) for (const ref of [...(h.motion?.masked ?? []), ...(h.motion?.released ?? [])]) byOwner.set(ref.owner, ref);
  const claims = [...byOwner.values()];
  const ownerText = (ref: MotionOwner) => {
    if (ref.owner.startsWith("look:")) return t.motionMaskedLook.replace("{name}", quoted(t, ref.name ?? ref.owner.slice(5)));
    const layer: MotionLayer = ref.owner === "manual" ? "manual" : ref.owner.startsWith("target:") ? "target" : ref.owner === "hold" ? "hold" : "rest";
    return t.motionMaskedOther.replace("{name}", ref.name ?? t.motionLayers[layer]);
  };

  return (
    <div className="xy fill">
      <div
        ref={pad}
        className="pad"
        role="slider"
        aria-label={label ?? t.heads}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={sameSent && sent ? Math.round(sent.pan * 100) : undefined}
        aria-describedby={`${hintId} ${statusId}`}
        aria-valuetext={sameSent && sent ? `pan ${Math.round(sent.pan * 100)} %, tilt ${Math.round(sent.tilt * 100)} %` : sent ? t.motionMixed : "—"}
        aria-disabled={disabled || undefined}
        tabIndex={disabled ? -1 : 0}
        onKeyDown={(e) => {
          // Arrows move by 1% (Shift: 10%); Home sets a manual centre, unlike the return-to-rest button.
          if (disabled) return;
          const step = e.shiftKey ? 0.1 : 0.01;
          const at = shown ?? { pan: 0.5, tilt: 0.5 };
          const clamp = (v: number) => Math.max(0, Math.min(1, Math.round(v * 1000) / 1000));
          const next =
            e.key === "ArrowLeft" ? { ...at, pan: clamp(at.pan - step) }
            : e.key === "ArrowRight" ? { ...at, pan: clamp(at.pan + step) }
            : e.key === "ArrowUp" ? { ...at, tilt: clamp(at.tilt + step) }
            : e.key === "ArrowDown" ? { ...at, tilt: clamp(at.tilt - step) }
            : e.key === "Home" ? { pan: 0.5, tilt: 0.5 }
            : undefined;
          if (!next) return;
          e.preventDefault();
          e.stopPropagation(); // the stage plan's arrows (turn, nudge) are not for the pad
          send(next);
        }}
        onPointerDown={(e) => {
          if (disabled) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          send(fromEvent(e));
        }}
        onPointerMove={(e) => {
          if (e.buttons && !disabled) send(fromEvent(e));
        }}
      >
        <span className="cross" />
        {scopedHeads.map((h) => {
          const point = sentOf(h);
          if (!point) return null;
          return (
            <span
              key={h.id}
              className={`dot ${h.motion?.pan.layer === "manual" || h.motion?.tilt.layer === "manual" ? "manual" : "remote"}`}
              data-testid="xy-sent-dot"
              data-fixture={h.id}
              aria-hidden="true"
              style={{ left: `${point.pan * 100}%`, top: `${(1 - point.tilt) * 100}%` }}
            />
          );
        })}
      </div>
      <span id={hintId} className="sr-only">{t.padKeysHelp}</span>
      <div className="row">
        <label>{label ?? t.heads}</label>
        <small className="xy-position">{shown ? `${Math.round(shown.pan * 100)} / ${Math.round(shown.tilt * 100)}` : "—"}</small>
      </div>
      <div id={statusId} className="xy-layers" aria-label={t.motionLayerStatus}>
        {(["pan", "tilt"] as const).map((axis) => (
          <span key={axis} data-axis={axis}>
            {t.motionAxes[axis]}{t.colon} {axisLabel(axis)}
            {axisErrors(axis).map((error) => <span key={error} className="error"> {error}</span>)}
          </span>
        ))}
      </div>
      {claims.length > 0 && (
        <div className="xy-masked hint" role="status">
          {claims.map((ref) => (
            <span key={ref.owner}>
              {ownerText(ref)}{released.has(ref.owner) ? ` — ${t.motionReleased}` : ""}
            </span>
          ))}
        </div>
      )}
      <div className="row xy-actions">
        <button title={t.releaseTopHelp} aria-label={t.releaseTop} disabled={disabled} onClick={() => void runMotion("position.releaseTop")}>
          ⟲ {t.releaseTop}
        </button>
        <button title={t.homeHeadsHelp} disabled={disabled} onClick={() => void runMotion("position.home")}>
          {t.homeHeads}
        </button>
        {restControls && fixture && (
          <>
            <button
              title={t.setRestHelp}
              disabled={disabled || !head?.sent}
              onClick={() => {
                const currentSent = head?.sent;
                if (currentSent) void runMotion("position.rest.set", { fixtures: [fixture], pan: currentSent.pan, tilt: currentSent.tilt });
              }}
            >
              {t.setRest}
            </button>
            <button title={t.clearRestHelp} disabled={disabled || !head?.rest.set} onClick={() => void runMotion("position.rest.clear", { fixtures: [fixture] })}>
              {t.clearRest}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
