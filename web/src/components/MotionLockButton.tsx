import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { can, cmd } from "../api";
import { useMe, useT } from "../App";
import { useMotionHeads } from "../hooks/useMotionHeads";
import { useMotionLock, type MotionLockView } from "../hooks/useMotionLock";
import { groupLevels, planLock, stricter, tapTarget, type LockLevel, type LockPlan, type LockRights } from "../motionLock";
import { useFloatingMenu } from "./menu";

/** How long a press held still opens the level menu (decision Q1: a long press or the chevron), as elsewhere. */
const LONG_PRESS_MS = 600;
/** How long « Défiger » of a hard lock waits for its second press, like an « À confirmer » button. */
const CONFIRM_MS = 3000;
const LEVELS: readonly LockLevel[] = ["off", "soft", "hard"];

/** What a lock control acts on and shows: every head (the top bar, a widget without group), or a group's heads. */
interface LockScope {
  /** The level shown: the strictest effective level of the scope's heads. */
  shown: LockLevel;
  /** For planning: the loosest and strictest level the commands start from (planLock). */
  base: LockLevel;
  top: LockLevel;
  total: number;
  frozen: number;
  /** The command target: none (global) or the group. */
  target: { group?: string };
  /** Heads held by the global lock beyond what this scope's own commands can loosen (a group under a global lock). */
  globalHolds: boolean;
}

/** Every head: the top bar, a widget without group (the global lock; its « Défiger » lifts everything, decision U2). */
function globalScope(view: MotionLockView): LockScope {
  const { lock, movingHeads } = view;
  return { shown: lock.effective, base: lock.level, top: lock.effective, total: movingHeads.total, frozen: movingHeads.frozen, target: {}, globalHolds: false };
}

/** A group's heads (members resolved by the server: selectors, sub-groups), from their own and the global levels. */
function groupScope(view: MotionLockView, group: string, ids: readonly string[]): LockScope {
  const own = ids.map((id) => view.lock.heads[id] ?? "off");
  const effective = own.map((level) => stricter(level, view.lock.level));
  const { base, top } = groupLevels(own);
  return { shown: effective.reduce<LockLevel>(stricter, "off"), base, top, total: ids.length, frozen: effective.filter((l) => l !== "off").length, target: { group }, globalHolds: view.lock.level !== "off" };
}

/** Sends a plan's calls in order (loosening first, then freezing): the second never runs after a refused first. */
export async function runLockPlan(plan: LockPlan, target: { group?: string; fixtures?: string[] }): Promise<void> {
  for (const call of plan.calls ?? []) await cmd(call.command, { ...call.args, ...target });
}

/** The rights the signed-in role has over the lock (commands:position brings commands:freeze). */
export function useLockRights(): LockRights {
  const me = useMe();
  return { freeze: me ? can(me, "commands:freeze") : false, position: me ? can(me, "commands:position") : false };
}

/**
 * « Figer les lyres » (T26, lot 4; docs/specs/ui-dashboards.md): one button, three states readable without the colour
 * (« Lyres libres », « 🔒 Figées », « 🔒🔒 Figées — tout », from the effective level); a press freezes soft or frees,
 * a long press or the chevron opens the levels (decision Q1); loosening a hard lock asks a second press (the « armer »
 * pattern of the look buttons). Rights: soft for commands:freeze, hard and loosening for commands:position; a choice
 * the role may not make is greyed with its reason. `variant`: the top bar's badge, or a dashboard widget (with an
 * optional group). Nothing at all where the venue has no moving head.
 */
export function MotionLockButton(props: LockButtonProps): ReactElement | null {
  return props.group ? <GroupLockButton {...props} group={props.group} /> : <GlobalLockButton {...props} />;
}

type LockButtonProps = { variant: "bar" | "widget"; group?: string; label?: string; inert?: boolean; onError?: (message: string) => void };

function GlobalLockButton(props: LockButtonProps): ReactElement | null {
  const view = useMotionLock();
  return view ? <LockControl {...props} scope={globalScope(view)} /> : null;
}

function GroupLockButton(props: LockButtonProps & { group: string }): ReactElement | null {
  const view = useMotionLock();
  const { heads, loaded } = useMotionHeads({ group: props.group });
  return view && loaded ? <LockControl {...props} scope={groupScope(view, props.group, heads.map((h) => h.id))} /> : null;
}

function LockControl({ variant, label, inert = false, onError, scope }: LockButtonProps & { scope: LockScope }): ReactElement | null {
  const t = useT();
  const rights = useLockRights();
  const [armed, setArmed] = useState<LockLevel | null>(null);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [notice, setNotice] = useState("");
  const [announced, setAnnounced] = useState("");
  const main = useRef<HTMLButtonElement>(null);
  const chevron = useRef<HTMLButtonElement>(null);
  const press = useRef<{ timer: number; x: number; y: number; fired: boolean } | null>(null);
  const armTimer = useRef(0);
  const lastShown = useRef<LockLevel | null>(null);
  useEffect(() => () => window.clearTimeout(armTimer.current), []);
  // a change of level is said to screen readers (aria-live), never the first state the page shows
  const shownNow = scope.shown;
  useEffect(() => {
    if (lastShown.current !== null && lastShown.current !== shownNow) setAnnounced(t.motionLock.announce[shownNow]);
    lastShown.current = shownNow;
    setArmed(null);
  }, [shownNow, t]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  if (variant === "bar" && scope.total === 0) return null;
  const fail = (message: string) => (onError ? onError(message) : setNotice(message));
  const planFor = (wanted: LockLevel): LockPlan => planLock({ base: scope.base, top: scope.top }, wanted, rights);
  const reason = (plan: LockPlan): string | undefined => (plan.calls ? undefined : plan.blocked === "freeze" ? t.motionLock.needFreeze : plan.blocked === "position" ? t.motionLock.needPosition : undefined);

  /** Sends `wanted`, or arms it first when it loosens a hard lock; returns whether it was sent. */
  const choose = (wanted: LockLevel): boolean => {
    const plan = planFor(wanted);
    if (!plan.calls) {
      // a group frozen by the global lock: its own commands cannot free it, say so rather than nothing
      if (plan.blocked === "same" && scope.globalHolds && wanted !== scope.shown) setNotice(t.motionLock.stillGlobal.replace("{names}", label ?? t.heads));
      return false;
    }
    window.clearTimeout(armTimer.current);
    if (plan.confirm && armed !== wanted) {
      setArmed(wanted);
      armTimer.current = window.setTimeout(() => setArmed(null), CONFIRM_MS);
      return false;
    }
    setArmed(null);
    runLockPlan(plan, scope.target).catch((e: Error) => fail(e.message));
    return true;
  };

  const tap = tapTarget(scope.shown);
  const tapPlan = planFor(tap);
  const tapReason = reason(tapPlan);
  const partial = scope.frozen > 0 && scope.frozen < scope.total;
  const stateText = scope.shown === "off" ? t.motionLock.free : scope.shown === "soft" ? t.motionLock.soft : t.motionLock.hard;
  const icon = scope.shown === "off" ? "" : scope.shown === "soft" ? "🔒 " : "🔒🔒 ";
  const help = scope.shown === "off" ? t.motionLock.helpFree : scope.shown === "soft" ? t.motionLock.helpSoft : t.motionLock.helpHard;
  const some = partial ? t.motionLock.some.replace("{n}", String(scope.frozen)).replace("{total}", String(scope.total)) : "";
  const openMenu = () => {
    const r = (chevron.current ?? main.current)?.getBoundingClientRect();
    setMenuAt(r ? { x: r.left, y: r.bottom + 4 } : { x: 8, y: 8 });
  };
  const cancelPress = () => {
    const p = press.current;
    if (p && !p.fired) {
      window.clearTimeout(p.timer);
      press.current = null;
    }
  };

  return (
    <span className={`motion-lock ${variant}`} data-level={scope.shown} data-testid={variant === "bar" ? "motion-lock-bar" : "motion-lock-widget"}>
      <button
        ref={main}
        className={`motion-lock-main lock-${scope.shown}${armed ? " armed" : ""}`}
        aria-pressed={scope.shown !== "off"}
        disabled={inert}
        // the state stays readable: a press the role may not make says why instead of greying the whole badge
        aria-disabled={tapReason ? true : undefined}
        title={[label, stateText + (some ? ` (${some})` : ""), help, tapReason].filter(Boolean).join(" · ")}
        onClickCapture={(e) => {
          if (!press.current?.fired) return;
          // the click that ends a long press only opened the menu
          press.current = null;
          e.stopPropagation();
          e.preventDefault();
        }}
        onClick={() => (tapReason ? setNotice(tapReason) : choose(tap))}
        onContextMenu={(e) => {
          if (variant !== "bar") return; // on the Live, a right-click is the widget's own menu
          e.preventDefault();
          cancelPress();
          setMenuAt({ x: e.clientX, y: e.clientY });
        }}
        onPointerDown={(e) => {
          if (inert || e.button !== 0) return;
          const at = { x: e.clientX, y: e.clientY };
          const timer = window.setTimeout(() => {
            if (!press.current) return;
            press.current.fired = true;
            setMenuAt(at);
          }, LONG_PRESS_MS);
          press.current = { timer, ...at, fired: false };
        }}
        onPointerMove={(e) => {
          const p = press.current;
          if (p && !p.fired && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) cancelPress();
        }}
        onPointerUp={cancelPress}
        onPointerCancel={cancelPress}
      >
        {variant === "widget" && label && <span className="motion-lock-label">{label}</span>}
        <span className="motion-lock-state">
          {armed ? t.motionLock.pressAgain : `${icon}${stateText}`}
        </span>
        {some && !armed && <small className="motion-lock-some">{some}</small>}
      </button>
      <button
        ref={chevron}
        className={`motion-lock-more lock-${scope.shown}`}
        aria-haspopup="menu"
        aria-expanded={menuAt !== null}
        aria-label={t.motionLock.choose}
        title={t.motionLock.choose}
        disabled={inert || (!rights.freeze && !rights.position)}
        // open: this press closes it here, not also through the menu's « press outside » (which would reopen it)
        onPointerDown={(e) => menuAt && e.stopPropagation()}
        onClick={() => (menuAt ? setMenuAt(null) : openMenu())}
      >
        ▾
      </button>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {announced}
      </span>
      {notice && (
        <span className="motion-lock-notice" role="status">
          {notice}
        </span>
      )}
      {menuAt && (
        <LockMenu
          at={menuAt}
          shown={scope.shown}
          partial={partial}
          armed={armed}
          planFor={planFor}
          reason={reason}
          onChoose={(level) => {
            if (choose(level)) setMenuAt(null);
          }}
          onClose={() => {
            setMenuAt(null);
            setArmed(null);
            chevron.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </span>
  );
}

/** The three levels, the current one checked; a level the role may not choose is greyed with its reason. */
function LockMenu({ at, shown, partial, armed, planFor, reason, onChoose, onClose }: { at: { x: number; y: number }; shown: LockLevel; partial: boolean; armed: LockLevel | null; planFor: (level: LockLevel) => LockPlan; reason: (plan: LockPlan) => string | undefined; onChoose: (level: LockLevel) => void; onClose: () => void }): ReactElement {
  const t = useT();
  const { box, style } = useFloatingMenu(at, onClose);
  useEffect(() => {
    box.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when it opens; `box` is a stable ref
  }, []);
  const names: Record<LockLevel, string> = { off: t.motionLock.menuFree, soft: `🔒 ${t.motionLock.menuSoft}`, hard: `🔒🔒 ${t.motionLock.menuHard}` };
  const onKey = (e: ReactKeyboardEvent) => {
    const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const items = [...(box.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(i + step + items.length) % items.length]?.focus();
  };
  // in a portal: the sticky header's stacking context would put the Live's sticky bar over it
  return createPortal(
    <div ref={box} className="widget-menu motion-lock-menu" role="menu" aria-label={t.motionLock.choose} style={style} onKeyDown={onKey} onContextMenu={(e) => e.preventDefault()}>
      {LEVELS.map((level) => {
        const plan = planFor(level);
        const why = reason(plan);
        const checked = level === shown && !partial;
        return (
          <button key={level} role="menuitemradio" aria-checked={checked} data-level={level} className={`${armed === level ? "armed" : ""}${checked ? " chosen" : ""}`.trim() || undefined} disabled={Boolean(why)} title={why} onClick={() => onChoose(level)}>
            <span className="check" aria-hidden="true">{checked ? "●" : "○"}</span>
            {armed === level ? t.motionLock.pressAgain : names[level]}
            {why && <small className="hint"> — {why}</small>}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}

/**
 * The three levels side by side for a head or a group (the fixture menu's « Mouvement : libre / figé / figé — tout »,
 * the group editor's « Figer les lyres de ce groupe » / « Défiger »): `levels` are the target's own (planLock), the
 * level `checked` is shown chosen; loosening a hard lock asks a second press; a level the role may not choose is
 * greyed with its reason.
 */
export function LockChoice({ label, names, levels, checked, target, onDone, onError }: { label: string; names: Record<LockLevel, string>; levels: { base: LockLevel; top: LockLevel }; checked: LockLevel | null; target: { fixtures: string[] } | { group: string }; onDone?: () => void; onError: (message: string) => void }): ReactElement {
  const t = useT();
  const rights = useLockRights();
  const [armed, setArmed] = useState<LockLevel | null>(null);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => setArmed(null), [levels.base, levels.top]);
  const choose = (level: LockLevel) => {
    const plan = planLock(levels, level, rights);
    if (!plan.calls) return;
    window.clearTimeout(timer.current);
    if (plan.confirm && armed !== level) {
      setArmed(level);
      timer.current = window.setTimeout(() => setArmed(null), CONFIRM_MS);
      return;
    }
    setArmed(null);
    runLockPlan(plan, target).then(onDone, (e: Error) => onError(e.message));
  };
  return (
    <div className="lock-choice" role="radiogroup" aria-label={label}>
      {LEVELS.map((level) => {
        const plan = planLock(levels, level, rights);
        const why = plan.calls ? undefined : plan.blocked === "freeze" ? t.motionLock.needFreeze : plan.blocked === "position" ? t.motionLock.needPosition : undefined;
        return (
          <button key={level} role="radio" aria-checked={checked === level} className={armed === level ? "armed" : undefined} disabled={Boolean(why)} title={why} data-level={level} onClick={() => choose(level)}>
            {armed === level ? t.motionLock.pressAgain : `${level === "hard" ? "🔒🔒 " : level === "soft" ? "🔒 " : ""}${names[level]}`}
          </button>
        );
      })}
    </div>
  );
}
