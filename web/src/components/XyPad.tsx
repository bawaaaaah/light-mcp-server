import { useCallback, useEffect, useId, useRef, useState, type ReactElement } from "react";
import { cmd } from "../api";
import { useT } from "../App";
import { useMotionHeads, type MotionHead, type MotionTarget, type Position } from "../hooks/useMotionHeads";
import { quoted } from "../typography";
import type { AxisLayer } from "../../../src/plugins/light/engine/motion";
import type { AxisReport } from "../../../src/plugins/light/show/motion-report";

export type { MotionHead, Position };
export type MotionLayer = AxisLayer;
export type MotionAxis = AxisReport;

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

type PositionWrite = { target: MotionTarget; point: Position };
type WriteBatch = { writes: PositionWrite[] };

const cloneTarget = (target: MotionTarget): MotionTarget => ({
  ...(target.fixtures ? { fixtures: [...target.fixtures] } : {}),
  ...(target.group ? { group: target.group } : {}),
});
const clamp = (value: number): number => Math.max(0, Math.min(1, Math.round(value * 1000) / 1000));
const samePoint = (a: Position | null, b: Position | null): boolean => a !== null && b !== null && a.pan === b.pan && a.tilt === b.tilt;

/**
 * XY pad for moving heads: X = pan, Y = tilt (top = 1). One write is in flight and only the latest pending batch is
 * kept, so a slow link never builds a queue behind the finger. The shared store supplies sent positions and owners.
 */
export function XyPad({ group, fixture, label, onError, disabled = false, resync, restControls = false }: XyPadProps): ReactElement {
  const t = useT();
  const target: MotionTarget = fixture ? { fixtures: [fixture] } : group ? { group } : {};
  const { heads: scopedHeads, refresh, markGesture } = useMotionHeads(target);
  const [pos, setPos] = useState<Position | null>(null);
  const [dragging, setDragging] = useState(false);
  const [focused, setFocused] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [keyboardHint, setKeyboardHint] = useState("");
  const pad = useRef<HTMLDivElement>(null);
  const dragRect = useRef<DOMRect | null>(null);
  const activePointer = useRef<number | null>(null);
  const pending = useRef<WriteBatch | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const hintId = useId();
  const statusId = useId();
  const targetRef = useRef(target);
  targetRef.current = target;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  /** Latest wins: never enqueue behind an in-flight request; its completion sends only the current pending batch. */
  const pump = useCallback(() => {
    if (inFlight.current || !pending.current) return;
    const batch = pending.current;
    pending.current = null;
    inFlight.current = Promise.all(
      batch.writes.map(async (write) => {
        try {
          await cmd("position.set", { ...write.target, ...write.point });
        } catch (error) {
          onErrorRef.current((error as Error).message);
        }
      }),
    ).then(() => undefined).finally(() => {
      inFlight.current = null;
      markGesture(); // one last read follows even a slow final write, then the local-activity window expires
      pump();
    });
  }, [markGesture]);

  const sendBatch = (writes: PositionWrite[], requested: Position | null): void => {
    setPos(requested);
    setKeyboardHint("");
    pending.current = { writes: writes.map((write) => ({ target: cloneTarget(write.target), point: { ...write.point } })) };
    markGesture();
    pump();
  };
  const send = (point: Position): void => sendBatch([{ target: targetRef.current, point }], point);

  // On unmount, the in-flight completion still pumps the one pending value; no timer or promise chain remains.
  useEffect(() => () => pump(), [pump]);
  useEffect(() => {
    // A gesture belongs to the target where it started, never to the next head selected meanwhile.
    pending.current = null;
    dragRect.current = null;
    activePointer.current = null;
    setDragging(false);
    setPos(null);
    setConfirmation("");
    setKeyboardHint("");
  }, [group, fixture]);
  useEffect(() => refresh(), [refresh, resync]);
  const manualSignature = scopedHeads.map((h) => `${h.id}:${h.manual?.pan},${h.manual?.tilt}`).join("|");
  useEffect(() => {
    if (dragging || pending.current || inFlight.current || !pos) return;
    // Only a changed manual report can supersede the requested point; motion/sent-only events must not pull it back.
    if (!scopedHeads.length || !scopedHeads.every((h) => samePoint(h.manual, pos))) setPos(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the signature is the manual value, not the frequently updated sent report
  }, [manualSignature, dragging]);
  useEffect(() => {
    if (!confirmation) return;
    const timer = window.setTimeout(() => setConfirmation(""), 2500);
    return () => window.clearTimeout(timer);
  }, [confirmation]);

  const fromEvent = (event: React.PointerEvent): Position => {
    // Layout may change during a gesture; the pad's geometry at pointerdown remains the gesture's reference.
    const rect = dragRect.current ?? pad.current!.getBoundingClientRect();
    return { pan: clamp((event.clientX - rect.left) / rect.width), tilt: clamp(1 - (event.clientY - rect.top) / rect.height) };
  };
  const endPointer = (event: React.PointerEvent): void => {
    if (activePointer.current !== event.pointerId) return;
    activePointer.current = null;
    dragRect.current = null;
    setDragging(false);
  };

  const runMotion = async (name: "position.releaseTop" | "position.home" | "position.rest.set" | "position.rest.clear", args: Record<string, unknown> = {}): Promise<void> => {
    const actionTarget = cloneTarget(targetRef.current);
    try {
      if (name !== "position.rest.set" && name !== "position.rest.clear") {
        // Discard the trailing gesture and await only the request already on the wire, never a backlog.
        pending.current = null;
        setPos(null);
        const writing = inFlight.current;
        if (writing) await writing;
      }
      await cmd(name, { ...actionTarget, ...args });
      if (name === "position.rest.set") setConfirmation(t.restSaved);
      if (name !== "position.rest.set") setConfirmation("");
      refresh();
    } catch (error) {
      onErrorRef.current((error as Error).message);
    }
  };

  const head = scopedHeads[0];
  const firstSent = head?.sent ?? null;
  const sameSent = firstSent !== null && scopedHeads.length > 0 && scopedHeads.every((h) => samePoint(h.sent, firstSent));
  const firstManual = head?.manual ?? null;
  const sameManual = firstManual !== null && scopedHeads.length > 0 && scopedHeads.every((h) => samePoint(h.manual, firstManual));
  const shown = pos ?? (sameManual ? firstManual : null) ?? (sameSent ? firstSent : null);

  const axisLabel = (axis: "pan" | "tilt"): { text: string; layer: MotionLayer | "mixed" } => {
    const labels = scopedHeads.map((h) => {
      const status = h.motion?.[axis];
      if (!status) return t.motionLayers.rest;
      const name = status.name ?? (status.owner?.startsWith("look:") ? status.owner.slice(5) : status.owner ?? "—");
      return t.motionLayers[status.layer].replace("{name}", () => (status.layer === "look" ? quoted(t, name) : name));
    });
    if (!labels.length) return { text: "—", layer: "rest" };
    const layers = scopedHeads.map((h) => h.motion?.[axis].layer ?? "rest");
    return labels.every((value) => value === labels[0])
      ? { text: labels[0]!, layer: layers[0] ?? "rest" }
      : { text: t.motionMixed, layer: "mixed" };
  };
  const axisErrors = (axis: "pan" | "tilt"): string[] => [...new Set(scopedHeads.map((h) => h.motion?.[axis].error).filter((error): error is string => Boolean(error)))];
  const countFor = (h: MotionHead): number =>
    Math.max(
      ...(["pan", "tilt"] as const).map((axis) => {
        const status = h.motion?.[axis];
        return (status?.layers ?? (status ? [status.layer, "rest"] : ["rest"])).filter((layer) => layer !== "rest").length;
      }),
    );
  const remaining = scopedHeads.length ? Math.max(...scopedHeads.map(countFor)) : 0;
  const remainingText = remaining === 0 ? t.motionLayersRemainingNone : remaining === 1 ? t.motionLayersRemainingOne : t.motionLayersRemainingMany.replace("{count}", () => String(remaining));
  const canRelease = scopedHeads.some((h) => {
    if (!h.motion) return true;
    return (["pan", "tilt"] as const).some((axis) => {
      const layer = h.motion![axis].layer;
      return layer !== "rest" && !(layer === "lock" && h.motion!.lock === "hard");
    });
  });

  type Claim = { owner: string; name?: string; released: boolean };
  const byOwner = new Map<string, Claim>();
  for (const h of scopedHeads) {
    for (const ref of h.motion?.masked ?? []) byOwner.set(ref.owner, { ...ref, released: false });
    // A released owner matters while another live layer holds the head; at rest/hold the stack already says enough.
    const covered = h.motion && (["pan", "tilt"] as const).some((axis) => ["manual", "target", "look", "lock"].includes(h.motion![axis].layer));
    if (covered) for (const ref of h.motion?.released ?? []) byOwner.set(ref.owner, { ...ref, released: true });
  }
  const claims = [...byOwner.values()];
  const ownerText = (claim: Claim): string => {
    const many = scopedHeads.length > 1;
    if (claim.owner.startsWith("look:")) {
      const lookTemplate = many ? t.motionMaskedLookMany : t.motionMaskedLook;
      return lookTemplate.replace("{name}", () => quoted(t, claim.name ?? claim.owner.slice(5)));
    }
    const layer: MotionLayer = claim.owner === "manual" ? "manual" : claim.owner.startsWith("target:") ? "target" : claim.owner === "hold" ? "hold" : "rest";
    const otherTemplate = many ? t.motionMaskedOtherMany : t.motionMaskedOther;
    return otherTemplate.replace("{name}", () => claim.name ?? t.motionLayers[layer]);
  };
  const claimText = (claim: Claim): string => `${ownerText(claim)}${claim.released ? ` — ${t.motionReleased}` : ""}`;
  const claimsTitle = claims.map(claimText).join("\n");
  const maskedText = claims.length ? `${claimText(claims[0]!)}${claims.length > 1 ? ` ${t.motionMoreClaims.replace("{count}", () => String(claims.length - 1))}` : ""}` : "";

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (disabled) return;
    const step = event.shiftKey ? 0.1 : 0.01;
    if (event.key === "Home") {
      event.preventDefault();
      event.stopPropagation();
      send({ pan: 0.5, tilt: 0.5 }); // explicit manual centre, unlike return-to-rest
      return;
    }
    const axis = event.key === "ArrowLeft" || event.key === "ArrowRight" ? "pan" : event.key === "ArrowUp" || event.key === "ArrowDown" ? "tilt" : undefined;
    if (!axis) return;
    event.preventDefault();
    event.stopPropagation(); // the stage plan's arrows (turn, nudge) are not for the pad
    const delta = event.key === "ArrowLeft" || event.key === "ArrowDown" ? -step : step;
    if (scopedHeads.length > 1 && !sameSent) {
      // Mixed heads must never jump to a common centre: offset each from its own position really sent.
      if (scopedHeads.some((h) => !h.sent)) {
        setKeyboardHint(t.motionKeyboardWaiting);
        return;
      }
      sendBatch(
        scopedHeads.map((h) => ({
          target: { fixtures: [h.id] },
          point: { ...h.sent!, [axis]: clamp(h.sent![axis] + delta) },
        })),
        null,
      );
      return;
    }
    const at = pos ?? (sameManual ? firstManual : null) ?? (sameSent ? firstSent : null) ?? { pan: 0.5, tilt: 0.5 };
    send({ ...at, [axis]: clamp(at[axis] + delta) });
  };

  return (
    <div
      className={`xy fill${dragging ? " dragging" : ""}`}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      <div
        ref={pad}
        className="pad"
        role="slider"
        aria-label={label ?? t.heads}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={sameSent && firstSent ? Math.round(firstSent.pan * 100) : undefined}
        aria-describedby={`${hintId} ${statusId}`}
        aria-valuetext={sameSent && firstSent ? `pan ${Math.round(firstSent.pan * 100)} %, tilt ${Math.round(firstSent.tilt * 100)} %` : firstSent ? t.motionMixed : "—"}
        aria-disabled={disabled || undefined}
        title={t.padDotsHelp}
        tabIndex={disabled ? -1 : 0}
        onKeyDown={onKeyDown}
        onPointerDown={(event) => {
          if (disabled || activePointer.current !== null) return;
          event.preventDefault();
          pad.current?.focus({ preventScroll: true });
          dragRect.current = event.currentTarget.getBoundingClientRect();
          activePointer.current = event.pointerId;
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(true);
          send(fromEvent(event));
        }}
        onPointerMove={(event) => {
          if (activePointer.current === event.pointerId && !disabled) send(fromEvent(event));
        }}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
      >
        <span className="cross" />
        {restControls && head && <span className="rest-dot" data-testid="xy-rest-dot" aria-hidden="true" style={{ left: `${head.rest.pan * 100}%`, top: `${(1 - head.rest.tilt) * 100}%` }} />}
        {pos && (!sameSent || !samePoint(pos, firstSent)) && (
          <span className="dot requested" data-testid="xy-requested-dot" aria-hidden="true" style={{ left: `${pos.pan * 100}%`, top: `${(1 - pos.tilt) * 100}%` }} />
        )}
        {scopedHeads.map((h) => {
          const point = h.sent;
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
      <span id={hintId} className="sr-only">{t.padKeysHelp} {t.padDotsHelp}</span>
      <div className="row xy-heading">
        <label>{label ?? t.heads}</label>
        <small className="xy-position">{shown ? `${Math.round(shown.pan * 100)} / ${Math.round(shown.tilt * 100)}` : "—"}</small>
      </div>
      <div className="xy-status" aria-live={focused || restControls ? "polite" : undefined} aria-atomic="true">
        <div id={statusId} className="xy-layers" role="group" aria-label={t.motionLayerStatus}>
          {(["pan", "tilt"] as const).map((axis) => {
            const current = axisLabel(axis);
            return (
              <span key={axis} data-axis={axis} data-layer={current.layer} title={[current.text, ...axisErrors(axis)].join("\n")}>
                <i className="layer-mark" aria-hidden="true" />
                {t.motionAxes[axis]}{t.colon} {current.text}
                {axisErrors(axis).map((error) => <span key={error} className="error"> {error}</span>)}
              </span>
            );
          })}
          <small className="xy-layer-count">{remainingText}</small>
        </div>
        <div className="xy-masked hint" title={confirmation || claimsTitle || keyboardHint || undefined} aria-hidden={!confirmation && !claims.length && !keyboardHint}>
          {confirmation || maskedText || " "}
          {keyboardHint ? ` ${keyboardHint}` : ""}
        </div>
      </div>
      <div className="row xy-actions">
        <button title={t.releaseTopHelp} aria-label={t.releaseTop} disabled={disabled || !canRelease} onClick={() => void runMotion("position.releaseTop")}>
          {t.releaseTop}
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
        <details className="xy-release-info">
          <summary aria-label={t.releaseTopInfo} title={t.releaseTopHelp}>i</summary>
          <p>{t.releaseTopHelp}</p>
        </details>
      </div>
    </div>
  );
}
