import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { ApiError, cmd } from "../api";
import { useT } from "../App";
import { useMotionHeads, type MotionHead, type MotionTarget, type Position } from "../hooks/useMotionHeads";
import { isFrench, quoted } from "../typography";
import { pressesLeft } from "../motionPresses";
import { useMotionLock } from "../hooks/useMotionLock";
import { needRight, useLockRights } from "./MotionLockButton";
import { noKeyRepeat, useArm } from "../hooks/useArm";
import { useThrottledSend } from "../hooks/useThrottledSend";
import { holdText } from "../hold-text";
import { arrowStep, logicalToPad, offsetDeg, onPad, padCenter, padToLogical, type PadSpan } from "../correctionPad";
import { leftOut } from "../positionRecall";
import { showLockToast } from "./MotionLockButton";
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
  /** A Live cell: the « i » sits in the button row, where the fixed-height cell keeps its room (elsewhere: by the count). */
  compact?: boolean;
  /**
   * Correction pad (T8, manual calibration): the pad covers ± `span.half` degrees around `span.center` (the aim the
   * calibration computes) instead of the whole travel, on the output's grid (correctionPad.ts). Absent: the whole travel.
   */
  span?: PadSpan;
  /** Called on each move sent from this pad (a drag, a tap, an arrow key): the Show page's « Modifier à la main » keeps the heads adjusted (T32, Q-A). */
  onMoved?: () => void;
  /**
   * The aiming zones offered as chips under a group's pad (T27, lot 4): a press sends the pad's heads to the zone's
   * aiming point (`position.aim {zone}`, layer Manuel). Absent: no chips.
   */
  zones?: readonly ZoneChip[];
};

/** An aiming zone as a chip: its name and its colour (absent: the aiming zones' colour). */
export type ZoneChip = { id: string; name: string; color?: string | undefined };
type AimReply = { results?: { fixture: string; error?: string }[]; refused?: string[] };

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
/** « Rendre la main » turning disabled hands the focus to the pad only if it had it this recently. */
const RELEASE_FOCUS_MS = 1000;

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
/** Room kept between the info bubble and the viewport's edges, and between the bubble and its « i ». */
const BUBBLE_MARGIN = 8;
const BUBBLE_GAP = 4;
const sameChips = (a: LayerChip[], b: LayerChip[]): boolean => a.length === b.length && a.every((chip, i) => chip.text === b[i]!.text && chip.count === b[i]!.count);

/**
 * XY pad for moving heads: X = pan, Y = tilt (top = 1). One write is in flight and only the latest pending batch is
 * kept (useThrottledSend, at most 25 a second), so a slow link never builds a queue behind the finger. The shared store supplies sent positions and owners.
 */
export function XyPad({ group, fixture, label, onError, disabled: disabledByCaller = false, resync, restControls = false, compact = false, span, onMoved, zones }: XyPadProps): ReactElement {
  const t = useT();
  /** A logical position → where it sits on the pad (0..1 across and up), kept on the pad's edge when beyond it. */
  const placed = (p: Position): Position => {
    if (!span) return p;
    const at = logicalToPad(span, p);
    return { pan: Math.max(0, Math.min(1, at.pan)), tilt: Math.max(0, Math.min(1, at.tilt)) };
  };
  /** Where a position is, as read: percent of the travel, or on a correction pad its offset from the centre in degrees. */
  const positionText = (p: Position, sep: string): string => {
    if (!span) return `${Math.round(p.pan * 100)}${sep}${Math.round(p.tilt * 100)}`;
    const d = offsetDeg(span, p);
    const deg = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toLocaleString(isFrench(t) ? "fr" : "en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}°`;
    return `${deg(d.pan)}${sep}${deg(d.tilt)}`;
  };
  /**
   * A correction pad's « arrived »: within one and a half real steps of the output on each axis. The pad-wide tolerance
   * (1.5 / 255 of the travel: 3° of pan) would hide the point asked on a ± 2° pad.
   */
  const onGrid = (a: Position, b: Position | null): boolean =>
    span !== undefined && b !== null && (["pan", "tilt"] as const).every((axis) => Math.abs(a[axis] - b[axis]) <= (1.5 * span.step[axis]) / span.travel[axis]);
  /** A value moved by an arrow, on the pad's grid: within the travel, or on a correction pad within its span and on the output's own steps. */
  const moved = (axis: Axis, v: number): number => (span ? onPad(span, axis, v) : clamp(v));
  const target: MotionTarget = fixture ? { fixtures: [fixture] } : group ? { group } : {};
  const { heads: scopedHeads, loaded, refresh, markGesture } = useMotionHeads(target);
  // « Figer les lyres » (T26): every targeted head frozen hard → the pad is off, with the reason and « Défiger »; frozen
  // soft → the pad still moves them; some frozen hard on a group → the others move (decision U1), those stay
  const lockView = useMotionLock();
  const lockRights = useLockRights();
  const lockOf = (h: MotionHead) => h.motion?.lock ?? "off";
  const hardCount = scopedHeads.filter((h) => lockOf(h) === "hard").length;
  const softCount = scopedHeads.filter((h) => lockOf(h) === "soft").length;
  const allHard = scopedHeads.length > 0 && hardCount === scopedHeads.length;
  const disabled = disabledByCaller || allHard;
  // « Défiger » asks a second press, not sooner than CONFIRM_MIN_MS (a double tap, a held key), on the target as armed
  const { armed: unfreezeArmed, press: armUnfreeze, disarm: disarmUnfreeze } = useArm<MotionTarget>();
  // a calibration pad switches heads without a new key: the armed « Défiger » must not fire on the next head
  useEffect(() => disarmUnfreeze(), [allHard, group, fixture, disarmUnfreeze]);
  /** Heads a gesture left in place (frozen hard on a partly frozen group), named in the status line until the lock changes. */
  const [refusedIds, setRefusedIds] = useState<string[]>([]);
  useEffect(() => setRefusedIds([]), [hardCount, group, fixture]);
  useEffect(() => {
    if (!refusedIds.length) return;
    const timer = window.setTimeout(() => setRefusedIds([]), 4000);
    return () => window.clearTimeout(timer);
  }, [refusedIds]);
  const [pos, setPos] = useState<Position | null>(null);
  const [dragging, setDragging] = useState(false);
  const [focused, setFocused] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [keyboardHint, setKeyboardHint] = useState("");
  const pad = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const info = useRef<HTMLDetailsElement>(null);
  /** The bubble's body, in a portal on document.body: no ancestor's container-type ever contains its position: fixed. */
  const infoBody = useRef<HTMLDivElement>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  /** The bubble's text overflows its height: it then takes the keyboard focus, to scroll it with the arrows. */
  const [infoScrolls, setInfoScrolls] = useState(false);
  const releaseButton = useRef<HTMLButtonElement>(null);
  /** When « Rendre la main » last had the focus (0: not since the focus left the pad): turning disabled, it hands it to the pad. */
  const releaseFocusAt = useRef(0);
  const dragRect = useRef<DOMRect | null>(null);
  const activePointer = useRef<number | null>(null);
  /** Per-head base of the current key burst on mixed heads, and when its last key was pressed. */
  const keyBurst = useRef<{ base: Map<string, Position>; at: number } | null>(null);
  const hintId = useId();
  const statusId = useId();
  const infoId = useId();
  const targetRef = useRef(target);
  targetRef.current = target;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onMovedRef = useRef(onMoved);
  onMovedRef.current = onMoved;
  /** Heads a gesture left in place (frozen hard on a partly frozen group): said in the status line, not as an error. */
  const refusedRef = useRef<(ids: string[]) => void>(() => undefined);

  /** Latest wins: never enqueued behind an in-flight request; at most one batch every 40 ms (useThrottledSend). */
  const sender = useThrottledSend<WriteBatch>(
    async (batch) => {
      await Promise.all(
        batch.writes.map(async (write) => {
          try {
            const reply = await cmd<{ refused?: string[] }>("position.set", { ...write.target, ...write.point });
            if (reply?.refused?.length) refusedRef.current(reply.refused);
          } catch (error) {
            // frozen hard between the gesture and the light:motion update that turns the pad off: said as heads left in
            // place, not as an error banner
            const refused = error instanceof ApiError ? error.detail?.refused : undefined;
            if (Array.isArray(refused)) refusedRef.current(refused.filter((id): id is string => typeof id === "string"));
            else onErrorRef.current((error as Error).message);
          }
        }),
      );
    },
    // one last read follows even a slow final write, then the local-activity window expires
    { onSettled: markGesture },
  );

  const sendBatch = (writes: PositionWrite[], requested: Position | null): void => {
    setPos(requested);
    setKeyboardHint("");
    sender.send({ writes: writes.map((write) => ({ target: cloneTarget(write.target), point: { ...write.point } })) });
    markGesture();
    onMovedRef.current?.();
  };
  const send = (point: Position): void => sendBatch([{ target: targetRef.current, point }], point);

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
    if (dragging || !sender.idle() || !pos) return;
    // Only a changed manual report can supersede the requested point; motion/sent-only events must not pull it back.
    if (!scopedHeads.length || !scopedHeads.every((h) => samePoint(h.manual, pos))) setPos(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the signature is the manual value, not the frequently updated sent report
  }, [manualSignature, dragging]);
  useEffect(() => {
    if (!confirmation) return;
    const timer = window.setTimeout(() => setConfirmation(""), 2500);
    return () => window.clearTimeout(timer);
  }, [confirmation]);
  /** Inside the bubble: its « i » (the details) or its body, which the portal keeps out of the details' DOM. */
  const inBubble = (node: Node | null): boolean => Boolean(node && (info.current?.contains(node) || infoBody.current?.contains(node)));
  /** Inside the pad: its own DOM or the bubble's body (a portal elsewhere in the page). */
  const inPad = (node: Node | null): boolean => Boolean(node && (root.current?.contains(node) || infoBody.current?.contains(node)));

  useEffect(() => {
    // The info bubble closes like a popover: Escape, or a press anywhere outside it. The element owns its open state
    // (no controlled prop, no reliance on the coalesced toggle event): the listeners read it when they fire.
    const onKey = (event: KeyboardEvent): void => {
      const details = info.current;
      if (event.key !== "Escape" || !details?.open) return;
      // Escape closes the bubble only: not the panel, the selection or the dialog behind it (capture phase, first).
      event.preventDefault();
      event.stopPropagation();
      const inside = inBubble(document.activeElement);
      details.open = false;
      if (inside) details.querySelector("summary")?.focus();
    };
    const onPress = (event: PointerEvent): void => {
      const details = info.current;
      if (details?.open && !inBubble(event.target as Node)) details.open = false;
    };
    // Capture phase: a widget that stops the press (the dashboard grid, the stage plan) still closes the bubble.
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPress, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPress, true);
    };
  }, []);

  useLayoutEffect(() => {
    // A popover over the page, anchored to its « i » and kept inside the viewport: a Live cell clips nothing, and a
    // phone panel never pushes it above the screen or under the navigation bar.
    if (!infoOpen) return;
    const place = (): void => {
      const details = info.current;
      const body = infoBody.current;
      const summary = details?.querySelector("summary");
      if (!details?.open || !body || !summary) return;
      const width = document.documentElement.clientWidth;
      const height = window.innerHeight;
      const anchor = summary.getBoundingClientRect();
      if (anchor.bottom <= 0 || anchor.top >= height || anchor.right <= 0 || anchor.left >= width) {
        // Its « i » scrolled out of the viewport: a bubble left alone at the edge would point at nothing.
        details.open = false;
        return;
      }
      body.style.maxHeight = `${height - 2 * BUBBLE_MARGIN}px`;
      const box = body.getBoundingClientRect();
      let top = anchor.top - BUBBLE_GAP - box.height; // above the « i » first, else below it, else as low as it fits
      if (top < BUBBLE_MARGIN) top = anchor.bottom + BUBBLE_GAP;
      if (top + box.height > height - BUBBLE_MARGIN) top = Math.max(BUBBLE_MARGIN, height - BUBBLE_MARGIN - box.height);
      const left = Math.min(Math.max(BUBBLE_MARGIN, anchor.right - box.width), width - BUBBLE_MARGIN - box.width);
      body.style.top = `${Math.round(top)}px`;
      body.style.left = `${Math.round(Math.max(BUBBLE_MARGIN, left))}px`;
      body.dataset.placed = "";
      setInfoScrolls(body.scrollHeight > body.clientHeight + 1);
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  });

  const fromEvent = (event: React.PointerEvent): Position => {
    // Layout may change during a gesture; the pad's geometry at pointerdown remains the gesture's reference.
    const rect = dragRect.current ?? pad.current!.getBoundingClientRect();
    const [x, y] = [(event.clientX - rect.left) / rect.width, 1 - (event.clientY - rect.top) / rect.height];
    return span ? padToLogical(span, x, y) : { pan: clamp(x), tilt: clamp(y) };
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
        keyBurst.current = null;
        setPos(null);
        await sender.drop();
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
  // a hold for a target is said in the interface's language (its reason as data), any other error as the server says it
  const axisErrors = (axis: Axis): string[] =>
    [
      ...new Set(
        scopedHeads.flatMap((h) => {
          const a = h.motion?.[axis];
          return a?.error ? [holdText(t, a)] : [];
        }),
      ),
    ];
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

  // Presses, not layers: the server's rule replayed (locks set aside, the strongest layer present first), so the count
  // drops on every press, also on a mixed group, never counts what a lock protects, and a released claim leaves both axes.
  const remaining = pressesLeft(scopedHeads);
  const remainingText = remaining === 0 ? t.motionLayersRemainingNone : remaining === 1 ? t.motionLayersRemainingOne : t.motionLayersRemainingMany.replace("{count}", () => String(remaining));
  // A head without a frame yet may still hold something: the server answers, the count waits for the report.
  const canRelease = remaining > 0 || scopedHeads.some((h) => !h.motion);

  /** An owner beaten on some heads and released on others: both counted apart, each head once. */
  type Claim = { owner: string; name?: string; masked: number; released: number };
  const byOwner = new Map<string, Claim>();
  for (const h of scopedHeads) {
    const maskedHere = new Set<string>();
    const releasedHere = new Set<string>();
    const claimOf = (ref: { owner: string; name?: string }): Claim => {
      const known = byOwner.get(ref.owner) ?? { ...ref, masked: 0, released: 0 };
      byOwner.set(ref.owner, known);
      return known;
    };
    for (const ref of h.motion?.masked ?? []) {
      if (maskedHere.has(ref.owner)) continue;
      maskedHere.add(ref.owner);
      claimOf(ref).masked += 1;
    }
    // A released owner matters while another live layer holds the head; at rest/hold the stack already says enough.
    const covered = h.motion && AXES.some((axis) => ["manual", "target", "look", "lock"].includes(h.motion![axis].layer));
    if (!covered) continue;
    for (const ref of h.motion?.released ?? []) {
      if (maskedHere.has(ref.owner) || releasedHere.has(ref.owner)) continue; // masked again by a relaunch: said masked
      releasedHere.add(ref.owner);
      claimOf(ref).released += 1;
    }
  }
  // What still wants the heads comes first; what was handed back after (« … — relâché » never opens the line).
  const claims = [...byOwner.values()].sort((a, b) => Number(b.masked > 0) - Number(a.masked > 0));
  const headsText = (count: number): string => (count === 1 ? t.motionHeadsOne : t.motionHeadsMany.replace("{count}", () => String(count)));
  const ownerLayer = (owner: string): MotionLayer => (owner === "manual" ? "manual" : owner.startsWith("target:") ? "target" : owner === "hold" ? "hold" : "rest");
  const ownerName = (claim: Claim): string => (claim.owner.startsWith("look:") ? quoted(t, claim.name ?? claim.owner.slice(5)) : (claim.name ?? t.motionLayers[ownerLayer(claim.owner)]));
  /** The whole sentence: the info bubble, the line's title and screen readers. */
  const claimText = (claim: Claim): string => {
    const look = claim.owner.startsWith("look:");
    const parts: string[] = [];
    if (claim.masked > 0) {
      const template = many ? (look ? t.motionMaskedLookMany : t.motionMaskedOtherMany) : look ? t.motionMaskedLook : t.motionMaskedOther;
      parts.push(template.replace("{name}", () => ownerName(claim)).replace("{heads}", () => headsText(claim.masked)));
    } else parts.push(look ? t.motionOwnerLook.replace("{name}", () => ownerName(claim)) : ownerName(claim));
    if (claim.released > 0) parts.push(many ? t.motionReleasedOn.replace("{heads}", () => headsText(claim.released)) : t.motionReleased);
    return parts.join(" — ");
  };
  /**
   * A group's short form, the counts first and whole, then the name, which alone is cut in a narrow Live cell:
   * « 1 lyre masquée · « Balayage lent… » ». One head: the sentence, cut at its end.
   */
  const claimShort = (claim: Claim): { counts: string; name: string } => {
    if (!many) return { counts: "", name: claimText(claim) };
    const counts: string[] = [];
    if (claim.masked > 0) counts.push(claim.masked === 1 ? t.motionMaskedCountOne : t.motionMaskedCountMany.replace("{count}", () => String(claim.masked)));
    if (claim.released > 0) counts.push(claim.released === 1 ? t.motionReleasedCountOne : t.motionReleasedCountMany.replace("{count}", () => String(claim.released)));
    return { counts: counts.join(", "), name: ownerName(claim) };
  };
  const more = claims.length > 1 ? ` ${t.motionMoreClaims.replace("{count}", () => String(claims.length - 1))}` : "";
  const masked = claims.length ? claimShort(claims[0]!) : null;
  const maskedFull = claims.map(claimText).join("\n");

  const nameOfHead = (id: string): string => scopedHeads.find((h) => h.id === id)?.name ?? id;
  /**
   * A zone chip pressed (T27, lot 4): the pad's heads aim at the zone's aiming point, a manual position as the pad's;
   * heads frozen hard (T26) and heads that cannot reach it are said in the app's toast, never left unsaid.
   */
  const aimAtZone = async (zone: ZoneChip): Promise<void> => {
    if (disabled) return;
    const aimTarget = cloneTarget(targetRef.current);
    keyBurst.current = null;
    setPos(null);
    // the pad's pending write would land after the aim and undo it: dropped, the one on the wire awaited
    await sender.drop();
    try {
      const reply = await cmd<AimReply>("position.aim", { ...aimTarget, zone: zone.id });
      const unreachable = (reply?.results ?? []).flatMap((r) => (r.error ? [{ fixture: r.fixture, error: r.error }] : []));
      const said = leftOut(t, zone.name, { refused: reply?.refused ?? [], unreachable }, nameOfHead);
      if (said.length) showLockToast(said.join(" · "));
      markGesture();
      onMovedRef.current?.();
    } catch (error) {
      const refused = error instanceof ApiError ? error.detail?.refused : undefined;
      const said = Array.isArray(refused) ? leftOut(t, zone.name, { refused: refused.filter((id): id is string => typeof id === "string") }, nameOfHead) : [];
      showLockToast(said.length ? said.join(" · ") : (error as Error).message);
    }
    refresh();
  };
  refusedRef.current = setRefusedIds;
  // the names first: a narrow cell cuts the end of the line, never who stayed in place
  const refusal = refusedIds.length ? (refusedIds.length === 1 ? t.motionLock.padRefusedOne : t.motionLock.padRefused).replace("{names}", () => refusedIds.map(nameOfHead).join(", ")) : "";
  const statusLine = confirmation || refusal;
  /** The pad's lock line, short (the layers line already says « Verrou »): all hard, some hard (they stay), or soft (the pad is still free). */
  const lockChip = allHard
    ? { level: "hard", text: `🔒🔒 ${t.motionLock.padHard}` }
    : hardCount > 0
      ? { level: "hard", text: `🔒🔒 ${(hardCount === 1 ? t.motionLock.padSomeHardOne : t.motionLock.padSomeHard).replace("{n}", String(hardCount))}` }
      : softCount > 0
        ? { level: "soft", text: `🔒 ${scopedHeads.length > 1 ? (softCount === 1 ? t.motionLock.padSoftOne : t.motionLock.padSoftMany.replace("{n}", String(softCount))) : t.motionLock.padSoft}` }
        : null;
  // decision V4: heads held by the global lock are unfrozen from the top bar, not here; the pad's « Défiger » is only for
  // the head's or the group's own lock
  const globalHard = lockView?.lock.level === "hard";
  const unfreeze = (): void => {
    // someone may be up by a head: a second press, as for a look marked « À confirmer »; the target as it was when armed
    const fire = armUnfreeze("unfreeze", cloneTarget(targetRef.current));
    if (fire) void cmd("motion.unfreeze", fire.payload).then(refresh, (error: Error) => onErrorRef.current(error.message));
  };

  useEffect(() => {
    // « Rendre la main » turning disabled under the focus (used within the last second) must not drop it to the page:
    // the pad itself takes it, never « Retour au repos », which a second press would trigger by mistake.
    if (canRelease || Date.now() - releaseFocusAt.current > RELEASE_FOCUS_MS) return;
    releaseFocusAt.current = 0;
    const active = document.activeElement;
    if (active !== releaseButton.current && active !== document.body && active !== null) return;
    pad.current?.focus({ preventScroll: true });
  }, [canRelease]);

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (disabled) return;
    const axis = event.key === "ArrowLeft" || event.key === "ArrowRight" ? "pan" : event.key === "ArrowUp" || event.key === "ArrowDown" ? "tilt" : undefined;
    if (event.key !== "Home" && !axis) return;
    // a correction pad: a hundredth of the pad (Shift a tenth, Alt one real step of the output); else 1 % of the travel (Shift 10 %)
    const step = span && axis ? arrowStep(span, axis, { shift: event.shiftKey, finest: event.altKey }) : event.shiftKey ? 0.1 : 0.01;
    event.preventDefault();
    event.stopPropagation(); // the stage plan's arrows (turn, nudge) are not for the pad
    // Until the scope is resolved the pad does not know its heads: an arrow would send the centre to whatever it targets.
    if (!loaded || !scopedHeads.length) return;
    if (event.key === "Home") {
      keyBurst.current = null;
      send(span ? padCenter(span) : { pan: 0.5, tilt: 0.5 }); // explicit manual centre (a correction pad's: the computed aim), unlike return-to-rest
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
        if (from) next.set(h.id, { ...from, [axis]: moved(axis, from[axis] + delta) });
      }
      keyBurst.current = { base: next, at: now };
      sendBatch([...next].map(([id, point]) => ({ target: { fixtures: [id] }, point })), null);
      return;
    }
    keyBurst.current = null;
    const at = pos ?? (sameManual ? firstManual : null) ?? (sameSent ? firstSent : null) ?? (span ? padCenter(span) : { pan: 0.5, tilt: 0.5 });
    send({ ...at, [axis]: moved(axis, at[axis] + delta) });
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

  const infoBubble = (
    <details
      ref={info}
      className="xy-release-info"
      onToggle={(event) => setInfoOpen(event.currentTarget.open)}
      onBlur={(event) => {
        // Focus leaving the bubble (Tab past it) closes it, like a press outside does. React bubbles the body's blur
        // here through the portal; the DOM check covers both parts.
        const details = event.currentTarget;
        if (details.open && !inBubble(event.relatedTarget as Node | null)) details.open = false;
      }}
    >
      <summary
        aria-label={t.releaseTopInfo}
        aria-controls={infoOpen ? infoId : undefined}
        onKeyDown={(event) => {
          // The body lives at the end of the page: Tab from the « i » goes into it when it has to be scrolled.
          if (event.key !== "Tab" || event.shiftKey || !infoOpen || !infoScrolls || !infoBody.current) return;
          event.preventDefault();
          infoBody.current.focus();
        }}
      >
        i
      </summary>
      {infoOpen &&
        createPortal(
          // focusable: a press on its text keeps the focus inside, so it does not read as leaving the bubble; in the
          // Tab order only when its text overflows, to scroll it with the arrows
          <div
            ref={infoBody}
            id={infoId}
            className="xy-info-body"
            tabIndex={infoScrolls ? 0 : -1}
            onKeyDown={(event) => {
              if (event.key !== "Tab") return;
              // Back to the « i »; on Tab, the browser then moves on from it to the pad's next control.
              const details = info.current;
              const summary = details?.querySelector("summary");
              if (!summary) return;
              if (!event.shiftKey && details?.open) {
                details.open = false;
                if (infoBody.current) infoBody.current.tabIndex = -1;
              }
              summary.focus();
              if (event.shiftKey) event.preventDefault();
            }}
          >
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
          </div>,
          document.body,
        )}
    </details>
  );

  return (
    <div
      ref={root}
      className={`xy fill${dragging ? " dragging" : ""}`}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (inPad(event.relatedTarget as Node | null)) return;
        setFocused(false);
        // The button blurred because it turned disabled is not the focus leaving: the effect below hands it to the pad.
        const button = releaseButton.current;
        if ((event.target as Element) !== button || !button?.disabled) releaseFocusAt.current = 0;
      }}
    >
      <div
        ref={pad}
        className="pad"
        role="slider"
        aria-label={label ?? t.heads}
        aria-valuemin={span ? -span.half : 0}
        aria-valuemax={span ? span.half : 100}
        aria-valuenow={sameSent && firstSent ? (span ? Math.round(offsetDeg(span, firstSent).pan * 100) / 100 : Math.round(firstSent.pan * 100)) : undefined}
        aria-describedby={`${hintId} ${statusId}`}
        aria-valuetext={
          sameSent && firstSent
            ? span
              ? `pan ${positionText(firstSent, ", tilt ")}`
              : `pan ${Math.round(firstSent.pan * 100)} %, tilt ${Math.round(firstSent.tilt * 100)} %`
            : firstSent
              ? t.motionMixed
              : "—"
        }
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
        {allHard && (
          <span className="xy-lock-mark" aria-hidden="true">
            🔒🔒
          </span>
        )}
        {restControls && head && <span className="rest-dot" data-testid="xy-rest-dot" aria-hidden="true" style={{ left: `${placed(head.rest).pan * 100}%`, top: `${(1 - placed(head.rest).tilt) * 100}%` }} />}
        {pos && (!sameSent || !(span ? onGrid(pos, firstSent) : samePoint(pos, firstSent))) && (
          <span className="dot requested" data-testid="xy-requested-dot" aria-hidden="true" style={{ left: `${placed(pos).pan * 100}%`, top: `${(1 - placed(pos).tilt) * 100}%` }} />
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
              style={{ left: `${placed(point).pan * 100}%`, top: `${(1 - placed(point).tilt) * 100}%` }}
            />
          );
        })}
      </div>
      <span id={hintId} className="sr-only">{t.padKeysHelp} {t.padDotsHelp}</span>
      <div className="xy-status" aria-live={focused || restControls ? "polite" : undefined} aria-atomic="true">
        <div className="xy-heading">
          <label>{label ?? t.heads}</label>
          {lockChip && (
            <small className="xy-lock-chip" data-level={lockChip.level} data-testid="xy-lock">
              {lockChip.text}
            </small>
          )}
          <small className="xy-position">{shown ? positionText(shown, " / ") : "—"}</small>
          <span id={statusId} className="xy-layers" role="group" aria-label={t.motionLayerStatus}>
            {axisRows.map((row) => {
              const errors = [...new Set(row.axes.flatMap(axisErrors))]; // pan and tilt held for the same reason: said once
              return (
                <span key={row.axes.join(" ")} data-axis={row.axes.join(" ")} data-layer={row.chips.length === 1 ? row.chips[0]!.layer : "mixed"} title={[rowText(row), ...errors].join("\n")}>
                  {`${axisName(row.axes)}${t.colon}`.replace(/ /g, "\u00a0")}{"\u00a0"}
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
          {!compact && infoBubble}
          <span className="xy-masked hint" aria-hidden={!statusLine && !claims.length && !keyboardHint} title={statusLine || maskedFull || undefined}>
            <span className="xy-masked-line" aria-hidden={!statusLine && claims.length > 0 ? true : undefined}>
              {statusLine ? (
                <span className="xy-masked-name" data-testid={refusal && !confirmation ? "xy-refused" : undefined}>{statusLine}</span>
              ) : masked ? (
                <>
                  {masked.counts && <span className="xy-masked-count">{`${masked.counts} · `}</span>}
                  <span className="xy-masked-name">{masked.name}</span>
                  {more && <span className="xy-masked-count">{more}</span>}
                </>
              ) : (
                !keyboardHint && " "
              )}
              {keyboardHint && <span className="xy-masked-name">{` ${keyboardHint}`}</span>}
            </span>
            {!statusLine && claims.length > 0 && <span className="sr-only">{maskedFull}</span>}
          </span>
        </div>
      </div>
      {restControls && legend}
      <div className="row xy-actions">
        {allHard && globalHard && (
          <small className="hint xy-lock-why" data-testid="xy-lock-global">
            {scopedHeads.length > 1 ? t.motionLock.padGlobalMany : t.motionLock.padGlobal}
          </small>
        )}
        {allHard && !globalHard && !disabledByCaller && lockRights.position && (
          <button className={`xy-unfreeze${unfreezeArmed ? " armed" : ""}`} data-testid="xy-unfreeze" title={t.motionLock.helpHard} onClick={unfreeze} {...noKeyRepeat}>
            {unfreezeArmed ? t.motionLock.pressAgain : t.motionLock.unfreeze}
          </button>
        )}
        {allHard && !globalHard && !lockRights.position && <small className="hint xy-lock-why">{needRight(t, "commands:position")}</small>}
        {!allHard && (
        <>
        <button
          ref={releaseButton}
          title={t.releaseTopHelp}
          disabled={disabled || !canRelease}
          onFocus={() => {
            releaseFocusAt.current = Date.now();
          }}
          onClick={() => {
            releaseFocusAt.current = Date.now();
            void runMotion("position.releaseTop");
          }}
        >
          {t.releaseTop}
        </button>
        <button title={t.homeHeadsHelp} disabled={disabled} onClick={() => void runMotion("position.home")}>
          {t.homeHeads}
        </button>
        </>
        )}
        {restControls && fixture && (
          <>
            <button
              title={t.setRestHelp}
              // the rest position is the show's, not a move: the lock leaves it free (the server does too)
              disabled={disabledByCaller || !head?.sent}
              onClick={() => {
                const currentSent = head?.sent;
                if (currentSent) void runMotion("position.rest.set", { fixtures: [fixture], pan: currentSent.pan, tilt: currentSent.tilt });
              }}
            >
              {t.setRest}
            </button>
            <button title={t.clearRestHelp} disabled={disabledByCaller || !head?.rest.set} onClick={() => void runMotion("position.rest.clear", { fixtures: [fixture] })}>
              {t.clearRest}
            </button>
          </>
        )}
        {compact && infoBubble}
      </div>
      {zones && zones.length > 0 && (
        <div className="xy-zone-chips" role="group" aria-label={t.zoneAim.chips} data-testid="xy-zone-chips">
          {zones.map((zone) => (
            <button
              key={zone.id}
              type="button"
              className="xy-zone-chip"
              data-zone={zone.id}
              disabled={disabled || !scopedHeads.length}
              title={t.zoneAim.chipHelp.replace("{name}", () => zone.name)}
              style={{ "--zone-color": zone.color ?? "var(--aim-color)" } as React.CSSProperties}
              onClick={() => void aimAtZone(zone)}
            >
              <i className="zone-chip-mark" aria-hidden="true" />
              {zone.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
