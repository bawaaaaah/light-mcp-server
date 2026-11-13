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

type Axis = "pan" | "tilt";
type PositionWrite = { target: MotionTarget; point: Position };
type WriteBatch = { writes: PositionWrite[] };
/** One layer shown for an axis: its text, and how many targeted heads it holds there. */
type LayerChip = { text: string; layer: MotionLayer; count: number };

const AXES: readonly Axis[] = ["pan", "tilt"];
/** Display order of the layers, strongest first (a soft lock under a manual claim never reaches the pad as top). */
const LAYER_ORDER: readonly MotionLayer[] = ["lock", "manual", "target", "look", "hold", "rest"];
const rankOf = (layer: MotionLayer): number => LAYER_ORDER.indexOf(layer);
/** Same tolerance as the server's « arrived » check: a 16-bit read back (0.37 vs 0.37000076) is the same point. */
const POINT_TOLERANCE = 1.5 / 255;
/** A key burst keeps its own per-head base: the 5 Hz reads of the sent position would make held arrows jerky. */
const KEY_BURST_MS = 1000;

const cloneTarget = (target: MotionTarget): MotionTarget => ({
  ...(target.fixtures ? { fixtures: [...target.fixtures] } : {}),
  ...(target.group ? { group: target.group } : {}),
});
const clamp = (value: number): number => Math.max(0, Math.min(1, Math.round(value * 1000) / 1000));
const samePoint = (a: Position | null, b: Position | null): boolean =>
  a !== null && b !== null && Math.abs(a.pan - b.pan) <= POINT_TOLERANCE && Math.abs(a.tilt - b.tilt) <= POINT_TOLERANCE;
const topLayer = (h: MotionHead): MotionLayer => {
  if (!h.motion) return "rest";
  const { pan, tilt } = h.motion;
  return rankOf(pan.layer) <= rankOf(tilt.layer) ? pan.layer : tilt.layer;
};
const sameChips = (a: LayerChip[], b: LayerChip[]): boolean => a.length === b.length && a.every((chip, i) => chip.text === b[i]!.text && chip.count === b[i]!.count);

/**
 * XY pad for moving heads: X = pan, Y = tilt (top = 1). One write is in flight and only the latest pending batch is
 * kept, so a slow link never builds a queue behind the finger. The shared store supplies sent positions and owners.
 */
export function XyPad({ group, fixture, label, onError, disabled = false, resync, restControls = false }: XyPadProps): ReactElement {
  const t = useT();
  const target: MotionTarget = fixture ? { fixtures: [fixture] } : group ? { group } : {};
  const { heads: scopedHeads, loaded, refresh, markGesture } = useMotionHeads(target);
  const [pos, setPos] = useState<Position | null>(null);
  const [dragging, setDragging] = useState(false);
  const [focused, setFocused] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [keyboardHint, setKeyboardHint] = useState("");
  const pad = useRef<HTMLDivElement>(null);
  const info = useRef<HTMLDetailsElement>(null);
  const dragRect = useRef<DOMRect | null>(null);
  const activePointer = useRef<number | null>(null);
  const pending = useRef<WriteBatch | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  /** Per-head base of the current key burst on mixed heads, and when its last key was pressed. */
  const keyBurst = useRef<{ base: Map<string, Position>; at: number } | null>(null);
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
    // The last point of a gesture still goes out: each write carries the target it was made for (cloned).
    dragRect.current = null;
    activePointer.current = null;
    keyBurst.current = null;
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
  useEffect(() => {
    // The info bubble closes like a popover: Escape, or a press anywhere outside it. The element owns its open state
    // (no controlled prop, no reliance on the coalesced toggle event): the listeners read it when they fire.
    const onKey = (event: KeyboardEvent): void => {
      const details = info.current;
      if (event.key !== "Escape" || !details?.open) return;
      details.open = false;
      details.querySelector("summary")?.focus();
    };
    const onPress = (event: PointerEvent): void => {
      const details = info.current;
      if (details?.open && !details.contains(event.target as Node)) details.open = false;
    };
    // Capture phase: a widget that stops the press (the dashboard grid, the stage plan) still closes the bubble.
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPress, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPress, true);
    };
  }, []);

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
        keyBurst.current = null;
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
  const many = scopedHeads.length > 1;
  const firstSent = head?.sent ?? null;
  const sameSent = firstSent !== null && scopedHeads.length > 0 && scopedHeads.every((h) => samePoint(h.sent, firstSent));
  const firstManual = head?.manual ?? null;
  const sameManual = firstManual !== null && scopedHeads.length > 0 && scopedHeads.every((h) => samePoint(h.manual, firstManual));
  const shown = pos ?? (sameManual ? firstManual : null) ?? (sameSent ? firstSent : null);

  const layerText = (status: AxisReport | undefined): string => {
    if (!status) return t.motionLayers.rest;
    const name = status.name ?? (status.owner?.startsWith("look:") ? status.owner.slice(5) : status.owner ?? "—");
    return t.motionLayers[status.layer].replace("{name}", () => (status.layer === "look" ? quoted(t, name) : name));
  };
  /** Each layer holding this axis on some targeted head, strongest first, with its head count. */
  const chipsOf = (axis: Axis): LayerChip[] => {
    const byText = new Map<string, LayerChip>();
    for (const h of scopedHeads) {
      const status = h.motion?.[axis];
      const text = layerText(status);
      const chip = byText.get(text);
      if (chip) chip.count += 1;
      else byText.set(text, { text, layer: status?.layer ?? "rest", count: 1 });
    }
    return [...byText.values()].sort((a, b) => rankOf(a.layer) - rankOf(b.layer) || b.count - a.count);
  };
  const axisErrors = (axis: Axis): string[] => [...new Set(scopedHeads.map((h) => h.motion?.[axis].error).filter((error): error is string => Boolean(error)))];
  const panChips = chipsOf("pan");
  const tiltChips = chipsOf("tilt");
  /** Pan and tilt held alike: one line says both (a Live cell has room for one line of layers). */
  const axisRows: { axes: Axis[]; chips: LayerChip[] }[] = sameChips(panChips, tiltChips)
    ? [{ axes: ["pan", "tilt"], chips: panChips }]
    : [
        { axes: ["pan"], chips: panChips },
        { axes: ["tilt"], chips: tiltChips },
      ];
  const axisName = (axes: Axis[]): string => (axes.length === 2 ? t.motionAxesBoth : t.motionAxes[axes[0]!]);
  const chipText = (chip: LayerChip, chips: LayerChip[]): string => (chips.length > 1 ? `${chip.text} ${chip.count}` : chip.text);
  const rowText = (row: { axes: Axis[]; chips: LayerChip[] }): string =>
    row.chips.length ? `${axisName(row.axes)}${t.colon} ${row.chips.map((chip) => chipText(chip, row.chips)).join(" · ")}` : `${axisName(row.axes)}${t.colon} —`;

  // Claims, not distinct layers: three stacked looks count three, and every effective press lowers the count.
  const countFor = (h: MotionHead): number =>
    Math.max(
      ...AXES.map((axis) => {
        const status = h.motion?.[axis];
        return (status?.layers ?? (status ? [status.layer, "rest"] : ["rest"])).filter((layer) => layer !== "rest").length;
      }),
    );
  const remaining = scopedHeads.length ? Math.max(...scopedHeads.map(countFor)) : 0;
  const remainingText = remaining === 0 ? t.motionLayersRemainingNone : remaining === 1 ? t.motionLayersRemainingOne : t.motionLayersRemainingMany.replace("{count}", () => String(remaining));
  // Heads at rest or under a lock (hard or soft) are set aside, as on the server: nothing else, nothing to release.
  const canRelease = scopedHeads.some((h) => !h.motion || AXES.some((axis) => !["rest", "lock"].includes(h.motion![axis].layer)));

  type Claim = { owner: string; name?: string; released: boolean; heads: number };
  const byOwner = new Map<string, Claim>();
  for (const h of scopedHeads) {
    const seen = new Set<string>();
    const add = (ref: { owner: string; name?: string }, released: boolean): void => {
      if (seen.has(ref.owner)) return;
      seen.add(ref.owner);
      const known = byOwner.get(ref.owner);
      byOwner.set(ref.owner, { ...ref, released: known ? known.released && released : released, heads: (known?.heads ?? 0) + 1 });
    };
    for (const ref of h.motion?.masked ?? []) add(ref, false);
    // A released owner matters while another live layer holds the head; at rest/hold the stack already says enough.
    const covered = h.motion && AXES.some((axis) => ["manual", "target", "look", "lock"].includes(h.motion![axis].layer));
    if (covered) for (const ref of h.motion?.released ?? []) add(ref, true);
  }
  const claims = [...byOwner.values()];
  const ownerText = (claim: Claim): string => {
    const heads = claim.heads === 1 ? t.motionHeadsOne : t.motionHeadsMany.replace("{count}", () => String(claim.heads));
    if (claim.owner.startsWith("look:")) {
      const lookTemplate = many ? t.motionMaskedLookMany : t.motionMaskedLook;
      return lookTemplate.replace("{name}", () => quoted(t, claim.name ?? claim.owner.slice(5))).replace("{heads}", () => heads);
    }
    const layer: MotionLayer = claim.owner === "manual" ? "manual" : claim.owner.startsWith("target:") ? "target" : claim.owner === "hold" ? "hold" : "rest";
    const otherTemplate = many ? t.motionMaskedOtherMany : t.motionMaskedOther;
    return otherTemplate.replace("{name}", () => claim.name ?? t.motionLayers[layer]).replace("{heads}", () => heads);
  };
  const claimText = (claim: Claim): string => `${ownerText(claim)}${claim.released ? ` — ${t.motionReleased}` : ""}`;
  const maskedText = claims.length ? `${claimText(claims[0]!)}${claims.length > 1 ? ` ${t.motionMoreClaims.replace("{count}", () => String(claims.length - 1))}` : ""}` : "";

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (disabled) return;
    const step = event.shiftKey ? 0.1 : 0.01;
    const axis = event.key === "ArrowLeft" || event.key === "ArrowRight" ? "pan" : event.key === "ArrowUp" || event.key === "ArrowDown" ? "tilt" : undefined;
    if (event.key !== "Home" && !axis) return;
    event.preventDefault();
    event.stopPropagation(); // the stage plan's arrows (turn, nudge) are not for the pad
    // Until the scope is resolved the pad does not know its heads: an arrow would send the centre to whatever it targets.
    if (!loaded || !scopedHeads.length) return;
    if (event.key === "Home") {
      keyBurst.current = null;
      send({ pan: 0.5, tilt: 0.5 }); // explicit manual centre, unlike return-to-rest
      return;
    }
    if (!axis) return;
    const delta = event.key === "ArrowLeft" || event.key === "ArrowDown" ? -step : step;
    const now = Date.now();
    const burst = keyBurst.current && now - keyBurst.current.at < KEY_BURST_MS ? keyBurst.current : null;
    if (many && (burst || !sameSent)) {
      // Mixed heads must never jump to a common centre: offset each from its own base (sent, then this burst's own).
      if (!burst && scopedHeads.some((h) => !h.sent)) {
        setKeyboardHint(t.motionKeyboardWaiting);
        return;
      }
      const base = burst?.base ?? new Map(scopedHeads.map((h) => [h.id, h.sent!] as const));
      const next = new Map<string, Position>();
      for (const h of scopedHeads) {
        const from = base.get(h.id) ?? h.sent;
        if (from) next.set(h.id, { ...from, [axis]: clamp(from[axis] + delta) });
      }
      keyBurst.current = { base: next, at: now };
      sendBatch([...next].map(([id, point]) => ({ target: { fixtures: [id] }, point })), null);
      return;
    }
    keyBurst.current = null;
    const at = pos ?? (sameManual ? firstManual : null) ?? (sameSent ? firstSent : null) ?? { pan: 0.5, tilt: 0.5 };
    send({ ...at, [axis]: clamp(at[axis] + delta) });
  };

  const legend = (
    <ul className="xy-legend" aria-label={t.motionLegend}>
      {LAYER_ORDER.map((layer) => (
        <li key={layer} data-layer={layer}>
          <i className="layer-mark" aria-hidden="true" />
          {t.motionLayerNames[layer]}
        </li>
      ))}
    </ul>
  );

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
        tabIndex={disabled ? -1 : 0}
        onKeyDown={onKeyDown}
        onPointerDown={(event) => {
          if (disabled || activePointer.current !== null) return;
          event.preventDefault();
          pad.current?.focus({ preventScroll: true });
          dragRect.current = event.currentTarget.getBoundingClientRect();
          activePointer.current = event.pointerId;
          keyBurst.current = null;
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
          const layer = topLayer(h);
          return (
            <span
              key={h.id}
              className={`dot ${layer === "manual" ? "manual" : "remote"}`}
              data-testid="xy-sent-dot"
              data-fixture={h.id}
              data-layer={layer}
              aria-hidden="true"
              style={{ left: `${point.pan * 100}%`, top: `${(1 - point.tilt) * 100}%` }}
            />
          );
        })}
      </div>
      <span id={hintId} className="sr-only">{t.padKeysHelp} {t.padDotsHelp}</span>
      <div className="xy-status" aria-live={focused || restControls ? "polite" : undefined} aria-atomic="true">
        <div className="xy-heading">
          <label>{label ?? t.heads}</label>
          <small className="xy-position">{shown ? `${Math.round(shown.pan * 100)} / ${Math.round(shown.tilt * 100)}` : "—"}</small>
          <span id={statusId} className="xy-layers" role="group" aria-label={t.motionLayerStatus}>
            {axisRows.map((row) => {
              const errors = row.axes.flatMap(axisErrors);
              return (
                <span key={row.axes.join(" ")} data-axis={row.axes.join(" ")} data-layer={row.chips.length === 1 ? row.chips[0]!.layer : "mixed"} title={[rowText(row), ...errors].join("\n")}>
                  {axisName(row.axes)}{t.colon}{" "}
                  {row.chips.map((chip, i) => (
                    <span key={chip.text} className="xy-chip" data-layer={chip.layer}>
                      {i > 0 && <span aria-hidden="true"> · </span>}
                      <i className="layer-mark" aria-hidden="true" />
                      {chipText(chip, row.chips)}
                    </span>
                  ))}
                  {errors.map((error) => <span key={error} className="error"> {error}</span>)}
                </span>
              );
            })}
          </span>
        </div>
        <div className="xy-detail">
          <small className="xy-layer-count">{remainingText}</small>
          <span className="xy-masked hint" aria-hidden={!confirmation && !claims.length && !keyboardHint}>
            {confirmation || maskedText || " "}
            {keyboardHint ? ` ${keyboardHint}` : ""}
          </span>
        </div>
      </div>
      {restControls && legend}
      <div className="row xy-actions">
        <button title={t.releaseTopHelp} disabled={disabled || !canRelease} onClick={() => void runMotion("position.releaseTop")}>
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
        <details
          ref={info}
          className="xy-release-info"
        >
          <summary aria-label={t.releaseTopInfo}>i</summary>
          <div className="xy-info-body">
            {axisRows.map((row) => (
              <p key={row.axes.join(" ")}>{rowText(row)}</p>
            ))}
            <p>{remainingText}</p>
            {claims.map((claim) => (
              <p key={claim.owner} className="hint">{claimText(claim)}</p>
            ))}
            <p>{t.releaseTopHelp}</p>
            <p>{t.padDotsHelp}</p>
            {legend}
          </div>
        </details>
      </div>
    </div>
  );
}
