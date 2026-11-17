import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { can, cmd } from "../api";
import { useMe } from "../app-context";
import { useT } from "../i18n-context";
import type { Texts } from "../i18n";
import { useMotionHeads } from "../hooks/useMotionHeads";
import { useMotionLock, type MotionLockView } from "../hooks/useMotionLock";
import { noKeyRepeat, useArm } from "../hooks/useArm";
import { groupLevels, planGlobalPress, planLock, stricter, tapTarget, type LockLevel, type LockPlan, type LockRights } from "../motionLock";
import { useFloatingMenu } from "./menu";

/** How long a press held still opens the level menu (decision Q1: a long press or the chevron), as elsewhere. */
const LONG_PRESS_MS = 600;
/** How long a lock control's message stays up. */
const NOTICE_MS = 4000;
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
  /** A group that no longer exists, or that has no moving head: nothing to freeze, said why. */
  empty?: "deleted" | "noHeads";
  /**
   * Every head (decision R4 of the second review): heads whose own lock is stricter than the global level, by level —
   * the bar says the global level and adds « · 1 en dur », the menu names them « à part ».
   */
  apart?: { soft: number; hard: number };
  /** Every head (decision W1): whether all the installed heads are frozen, which makes the press « défiger tout ». */
  allFrozen?: boolean;
}

/**
 * Every head: the top bar, a widget without group (the global lock; its « Défiger » lifts everything, decision U2). It
 * shows the global level, not the strictest: one head frozen hard on its own under a soft global lock is « 🔒 Figées ·
 * 1 en dur », not « Figées — tout ». Decision W1: once every installed head is frozen, by the global or their own
 * locks, it shows them frozen (« Figées — tout » when all are hard), and the press is then « défiger tout ».
 */
function globalScope(view: MotionLockView): LockScope {
  const { lock, movingHeads } = view;
  // the installed heads only (an absent head or an id out of the patch is not counted), as the server counts them
  const { total, frozen } = movingHeads;
  const allFrozen = total > 0 ? frozen === total : lock.level !== "off";
  const shown: LockLevel = total > 0 && frozen === total ? (movingHeads.hard === total ? "hard" : "soft") : lock.level;
  const hard = shown === "hard" ? 0 : movingHeads.hard;
  const apart = { soft: lock.level === "off" ? frozen - movingHeads.hard : 0, hard };
  return { shown, base: lock.level, top: lock.effective, total, frozen, target: {}, globalHolds: false, apart, allFrozen };
}

/** A group's heads (members resolved by the server: selectors, sub-groups), from their own and the global levels. */
function groupScope(view: MotionLockView, group: string, ids: readonly string[], deleted: boolean): LockScope {
  const own = ids.map((id) => view.lock.heads[id] ?? "off");
  const effective = own.map((level) => stricter(level, view.lock.level));
  const { base, top } = groupLevels(own);
  const empty = deleted ? "deleted" : ids.length === 0 ? "noHeads" : undefined;
  return { shown: effective.reduce<LockLevel>(stricter, "off"), base, top, total: ids.length, frozen: effective.filter((l) => l !== "off").length, target: { group }, globalHolds: view.lock.level !== "off", ...(empty ? { empty } : {}) };
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

/** Why a choice is greyed, in the operator's words: the right's own name (the Roles page's), never its key. */
export function needRight(t: Texts, right: "commands:freeze" | "commands:position"): string {
  return (right === "commands:freeze" ? t.motionLock.needFreeze : t.motionLock.needPosition).replace("{right}", () => t.rightNames[right] ?? right);
}

/** Why a plan sends nothing, when a right is missing. */
const reasonOf = (t: Texts, plan: LockPlan): string | undefined => (plan.calls ? undefined : plan.blocked === "freeze" ? needRight(t, "commands:freeze") : plan.blocked === "position" ? needRight(t, "commands:position") : undefined);

/**
 * What the state adds after the level: on every head, the heads frozen harder on their own (« · 1 en dur »; with the
 * global lock off, « 1 sur 4 » too when some are frozen soft); on a group, « 1 sur 4 » when only some are frozen.
 */
function suffixOf(t: Texts, scope: LockScope, partial: boolean): string {
  const ofTotal = (n: number) => t.motionLock.some.replace("{n}", String(n)).replace("{total}", String(scope.total));
  const hard = (n: number) => t.motionLock.hardApart.replace("{n}", String(n));
  if (!scope.apart) return partial ? ofTotal(scope.frozen) : "";
  const { soft, hard: hardCount } = scope.apart;
  if (scope.shown === "off" && soft > 0) return [ofTotal(scope.frozen), hardCount ? hard(hardCount) : ""].filter(Boolean).join(" · ");
  return hardCount ? hard(hardCount) : "";
}

/** The menu's word on heads frozen apart from the global level (every head only): « 1 lyre figée en dur à part ». */
function apartNotes(t: Texts, scope: LockScope): string[] {
  if (!scope.apart) return [];
  const say = (n: number, one: string, many: string) => (n === 1 ? one : many.replace("{n}", String(n)));
  return [
    scope.apart.hard ? say(scope.apart.hard, t.motionLock.apartHardOne, t.motionLock.apartHardMany) : "",
    scope.apart.soft ? say(scope.apart.soft, t.motionLock.apartSoftOne, t.motionLock.apartSoftMany) : "",
  ].filter(Boolean);
}

/** « Appuyer encore » said for what the second press does: free the heads, or free the pad (hard → soft). */
const pressAgainFor = (t: Texts, level: LockLevel): string => (level === "soft" ? t.motionLock.pressAgainSoft : t.motionLock.pressAgain);

/** « alert »: something was refused or left out (the lock's warning border); « neutral »: a success, said quietly. */
export type ToastTone = "alert" | "neutral";
type ToastMessage = { text: string; seq: number; tone?: ToastTone };
const toastListeners = new Set<(message: ToastMessage) => void>();
let toastSeq = 0;

/** Says a lock control's message: the latest replaces the one shown (one at a time, never stacked), for NOTICE_MS. */
export function showLockToast(text: string, tone: ToastTone = "alert"): void {
  const message = { text, seq: ++toastSeq, tone };
  for (const listener of toastListeners) listener(message);
}

/**
 * The one host of the lock controls' messages, mounted once by the app: over everything at the bottom of the window (a
 * portal), so a Live cell's overflow, the Live's sticky bar or the header's buttons never hide it, on a phone as on a
 * desktop. The `role="status"` region stays mounted, empty between messages: only its text changes, which screen
 * readers announce. Its timer depends on the message alone: a page that re-renders often (the Live, every 250 ms)
 * never keeps it up.
 */
export function LockToastHost(): ReactElement {
  const [message, setMessage] = useState<ToastMessage>({ text: "", seq: 0 });
  useEffect(() => {
    // the region is emptied, then the text set on the next frame: the same message said twice in a row is announced
    // again (a text that does not change is not), and shown afresh
    let frame = 0;
    const listener = (next: ToastMessage) => {
      window.cancelAnimationFrame(frame);
      setMessage({ text: "", seq: next.seq });
      frame = window.requestAnimationFrame(() => setMessage((m) => (m.seq === next.seq ? next : m)));
    };
    toastListeners.add(listener);
    return () => {
      window.cancelAnimationFrame(frame);
      toastListeners.delete(listener);
    };
  }, []);
  useEffect(() => {
    if (!message.text) return;
    const timer = window.setTimeout(() => setMessage((m) => (m.seq === message.seq ? { text: "", seq: m.seq } : m)), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [message]);
  return createPortal(
    <div className="lock-toast-host" role="status">
      {message.text && (
        <div className={message.tone === "neutral" ? "lock-toast neutral" : "lock-toast"} data-testid="lock-toast">
          {message.text}
        </div>
      )}
    </div>,
    document.body,
  );
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

type LockButtonProps = { variant: "bar" | "widget"; group?: string; label?: string; inert?: boolean; onError?: (message: string) => void; groupDeleted?: boolean };

function GlobalLockButton(props: LockButtonProps): ReactElement | null {
  const view = useMotionLock();
  return view ? <LockControl {...props} scope={globalScope(view)} /> : null;
}

function GroupLockButton(props: LockButtonProps & { group: string }): ReactElement | null {
  const view = useMotionLock();
  const { heads, loaded } = useMotionHeads({ group: props.group });
  return view && (loaded || props.groupDeleted) ? <LockControl {...props} scope={groupScope(view, props.group, heads.map((h) => h.id), Boolean(props.groupDeleted))} /> : null;
}

function LockControl({ variant, label, inert = false, onError, scope }: LockButtonProps & { scope: LockScope }): ReactElement | null {
  const t = useT();
  const rights = useLockRights();
  const { armed, press: armPress, disarm } = useArm<LockPlan>();
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [announced, setAnnounced] = useState("");
  const main = useRef<HTMLButtonElement>(null);
  const chevron = useRef<HTMLButtonElement>(null);
  const press = useRef<{ timer: number; x: number; y: number; fired: boolean } | null>(null);
  const lastShown = useRef<LockLevel | null>(null);
  // a long press under way when the control goes (a page change, the cell removed) must not open a menu afterwards
  useEffect(() => () => window.clearTimeout(press.current?.timer), []);
  // a change of level is said to screen readers (aria-live), never the first state the page shows
  const shownNow = scope.shown;
  useEffect(() => {
    if (lastShown.current !== null && lastShown.current !== shownNow) setAnnounced(t.motionLock.announce[shownNow]);
    lastShown.current = shownNow;
    disarm();
  }, [shownNow, t, disarm]);

  if (variant === "bar" && scope.total === 0) return null;
  const say = showLockToast;
  const fail = (message: string) => (onError ? onError(message) : say(message));
  const planFor = (wanted: LockLevel): LockPlan => planLock({ base: scope.base, top: scope.top }, wanted, rights);
  const reason = (plan: LockPlan): string | undefined => (scope.empty ? (scope.empty === "deleted" ? t.motionLock.groupDeleted : t.motionLock.groupNoHeads) : reasonOf(t, plan));
  const stillGlobal = () => say((scope.total > 1 ? t.motionLock.stillGlobalMany : t.motionLock.stillGlobalOne).replace("{names}", () => label ?? t.heads));

  /** Sends `wanted` (by `plan`), or arms it first when it loosens a hard lock; returns whether it was sent. */
  const choose = (wanted: LockLevel, plan: LockPlan = planFor(wanted)): boolean => {
    if (scope.empty) return false;
    if (!plan.calls) {
      // a group frozen by the global lock: its own commands cannot free it, say so rather than nothing
      if (plan.blocked === "same" && scope.globalHolds && wanted !== scope.shown) stillGlobal();
      return false;
    }
    let toRun: LockPlan = plan;
    if (plan.confirm) {
      // a second press, not sooner than CONFIRM_MIN_MS (a double click, a held key), runs the plan armed
      const fire = armPress(wanted, plan);
      if (!fire) return false;
      toRun = fire.payload;
    } else disarm();
    runLockPlan(toRun, scope.target).catch((e: Error) => fail(e.message));
    return true;
  };

  const partial = scope.frozen > 0 && scope.frozen < scope.total;
  // every head (decision W1): freeze while a head is free, free everything once all are frozen; a group (decision V2):
  // a role that may not unfreeze freezes soft what is still free
  const tap: LockLevel = scope.allFrozen === undefined ? tapTarget(scope.shown, scope.frozen < scope.total, rights.position) : scope.allFrozen ? "off" : "soft";
  const tapPlan = scope.allFrozen === undefined ? planFor(tap) : planGlobalPress({ base: scope.base, top: scope.top }, scope.allFrozen, rights);
  const tapReason = reason(tapPlan);
  const stateText = scope.empty ? (scope.empty === "deleted" ? t.motionLock.groupDeletedShort : t.motionLock.groupNoHeadsShort) : scope.shown === "off" ? t.motionLock.free : scope.shown === "soft" ? t.motionLock.soft : t.motionLock.hard;
  const icon = scope.empty || scope.shown === "off" ? "" : scope.shown === "soft" ? "🔒 " : "🔒🔒 ";
  const help = scope.shown === "off" ? t.motionLock.helpFree : scope.shown === "soft" ? t.motionLock.helpSoft : t.motionLock.helpHard;
  const some = suffixOf(t, scope, partial);
  const noRights = !rights.freeze && !rights.position;
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
  const closeMenu = () => {
    setMenuAt(null);
    disarm();
    chevron.current?.focus({ preventScroll: true });
  };

  return (
    <span className={`motion-lock ${variant}`} data-level={scope.shown} data-testid={variant === "bar" ? "motion-lock-bar" : "motion-lock-widget"}>
      <button
        ref={main}
        className={`motion-lock-main lock-${scope.shown}${armed ? " armed" : ""}`}
        aria-pressed={scope.shown !== "off"}
        // never `disabled` (in edit mode a disabled button swallows the press that drags or selects the widget): a
        // press the role may not make says why, and the state stays readable
        aria-disabled={inert || tapReason ? true : undefined}
        title={[label, stateText + (some ? ` (${some})` : ""), help, tapReason].filter(Boolean).join(" · ")}
        {...noKeyRepeat}
        onClickCapture={(e) => {
          if (!press.current?.fired) return;
          // the click that ends a long press only opened the menu
          press.current = null;
          e.stopPropagation();
          e.preventDefault();
        }}
        onClick={() => {
          if (inert) return;
          if (tapReason) say(tapReason);
          else choose(tap, tapPlan);
        }}
        onContextMenu={(e) => {
          cancelPress();
          if (variant !== "bar") return; // on the Live, a right-click is the widget's own menu
          e.preventDefault();
          setMenuAt({ x: e.clientX, y: e.clientY });
        }}
        onPointerDown={(e) => {
          if (inert || e.button !== 0 || scope.empty) return;
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
        onPointerLeave={cancelPress}
      >
        {variant === "widget" && label && <span className="motion-lock-label">{label}</span>}
        <span className="motion-lock-state">{armed ? pressAgainFor(t, armed as LockLevel) : `${icon}${stateText}`}</span>
        {some && !armed && <small className="motion-lock-some">{variant === "bar" ? `· ${some}` : some}</small>}
      </button>
      <button
        ref={chevron}
        className={`motion-lock-more lock-${scope.shown}`}
        aria-haspopup="menu"
        aria-expanded={menuAt !== null}
        aria-label={t.motionLock.choose}
        title={noRights ? needRight(t, "commands:freeze") : t.motionLock.choose}
        aria-disabled={inert || noRights || scope.empty ? true : undefined}
        {...noKeyRepeat}
        // open: this press closes it here, not also through the menu's « press outside » (which would reopen it)
        onPointerDown={(e) => menuAt && e.stopPropagation()}
        onClick={() => {
          if (inert || scope.empty) return;
          if (noRights) return say(needRight(t, "commands:freeze"));
          if (menuAt) closeMenu();
          else openMenu();
        }}
      >
        ▾
      </button>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {announced}
      </span>
      {menuAt && (
        <LockMenu
          at={menuAt}
          shown={scope.shown}
          partial={partial}
          notes={apartNotes(t, scope)}
          armed={armed as LockLevel | null}
          planFor={planFor}
          reason={reason}
          onChoose={(level) => {
            // after a choice, the focus goes back to the chevron (the menu is gone)
            if (choose(level)) closeMenu();
          }}
          onClose={closeMenu}
        />
      )}
    </span>
  );
}

/** The three levels, the current one checked; a level the role may not choose is greyed with its reason. */
function LockMenu({ at, shown, partial, notes, armed, planFor, reason, onChoose, onClose }: { at: { x: number; y: number }; shown: LockLevel; partial: boolean; notes: readonly string[]; armed: LockLevel | null; planFor: (level: LockLevel) => LockPlan; reason: (plan: LockPlan) => string | undefined; onChoose: (level: LockLevel) => void; onClose: () => void }): ReactElement {
  const t = useT();
  const { box, style } = useFloatingMenu(at, onClose);
  const reasonId = useId();
  useEffect(() => {
    // the level checked takes the focus, not « Libres »: an Enter held on the chevron must not land on « Défiger »
    const items = box.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
    const checked = box.current?.querySelector<HTMLButtonElement>('button[aria-checked="true"]:not(:disabled)');
    (checked ?? items?.[0])?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when it opens; `box` is a stable ref
  }, []);
  const names: Record<LockLevel, string> = { off: t.motionLock.menuFree, soft: `🔒 ${t.motionLock.menuSoft}`, hard: `🔒🔒 ${t.motionLock.menuHard}` };
  const whys = LEVELS.map((level) => reason(planFor(level)));
  // a greyed level's reason, said once under the levels (a long reason beside each one crushed its name)
  const reasons = [...new Set(whys.filter((why): why is string => Boolean(why)))];
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.repeat && (e.key === "Enter" || e.key === " ")) return e.preventDefault();
    if (e.key === "Tab") {
      // leaving the menu closes it, the focus back on the chevron
      e.preventDefault();
      return onClose();
    }
    const items = [...(box.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "ArrowDown" ? (i + 1) % items.length : e.key === "ArrowUp" ? (i - 1 + items.length) % items.length : e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    items[next]?.focus();
  };
  // in a portal: the sticky header's stacking context would put the Live's sticky bar over it
  return createPortal(
    <div ref={box} className="widget-menu motion-lock-menu" role="menu" aria-label={t.motionLock.choose} style={style} onKeyDown={onKey} onContextMenu={(e) => e.preventDefault()}>
      {LEVELS.map((level, i) => {
        const why = whys[i];
        const checked = level === shown && !partial;
        return (
          <button key={level} role="menuitemradio" aria-checked={checked} data-level={level} className={`${armed === level ? "armed" : ""}${checked ? " chosen" : ""}`.trim() || undefined} disabled={Boolean(why)} title={why} aria-describedby={why ? reasonId : undefined} onClick={() => onChoose(level)}>
            <span className="check" aria-hidden="true">{checked ? "●" : "○"}</span>
            {armed === level ? pressAgainFor(t, level) : names[level]}
          </button>
        );
      })}
      {notes.map((note) => (
        <small key={note} className="hint motion-lock-note" data-testid="motion-lock-note">
          {note}
        </small>
      ))}
      {reasons.length > 0 && (
        <small id={reasonId} className="hint motion-lock-note" data-testid="motion-lock-reason">
          {reasons.join(" · ")}
        </small>
      )}
    </div>,
    document.body,
  );
}

/**
 * The three levels side by side for a head or a group (the fixture menu's « Mouvement : libre / figé / figé — tout »,
 * the group editor's « Figer les lyres de ce groupe » / « Défiger »): `levels` are the target's own (planLock), the
 * level `checked` is shown chosen; loosening a hard lock asks a second press; a level the role may not choose is
 * greyed with its reason. A radio group: one tab stop (roving tabindex), the arrows move the focus and Enter or Space chooses (a lock never changes by moving through it). `globalHolds`:
 * the message said when a choice changes nothing because the lock on every head holds the target.
 */
export function LockChoice({ label, names, levels, checked, target, globalHolds, onDone, onError }: { label: string; names: Record<LockLevel, string>; levels: { base: LockLevel; top: LockLevel }; checked: LockLevel | null; target: { fixtures: string[] } | { group: string }; globalHolds?: string; onDone?: () => void; onError: (message: string) => void }): ReactElement {
  const t = useT();
  const rights = useLockRights();
  const { armed, press: armPress, disarm } = useArm<LockPlan>();
  const group = useRef<HTMLDivElement>(null);
  useEffect(() => disarm(), [levels.base, levels.top, disarm]);
  const choose = (level: LockLevel) => {
    const plan = planLock(levels, level, rights);
    if (!plan.calls) {
      // said where it is seen, whatever holds the control (a fixture's context menu shows its own errors out of sight)
      if (plan.blocked === "same" && globalHolds && level !== checked) showLockToast(globalHolds);
      return;
    }
    let toRun: LockPlan = plan;
    if (plan.confirm) {
      const fire = armPress(level, plan);
      if (!fire) return;
      toRun = fire.payload;
    } else disarm();
    runLockPlan(toRun, target).then(onDone, (e: Error) => onError(e.message));
  };
  const enabled = LEVELS.filter((level) => !reasonOf(t, planLock(levels, level, rights)));
  // the tab stop: the level checked, else the first one that may be chosen
  const stop = checked && enabled.includes(checked) ? checked : enabled[0];
  const onKey = (e: ReactKeyboardEvent, level: LockLevel) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step || !enabled.length) return;
    e.preventDefault();
    const i = enabled.indexOf(level);
    const next = enabled[(i + step + enabled.length) % enabled.length]!;
    group.current?.querySelector<HTMLButtonElement>(`button[data-level="${next}"]`)?.focus();
  };
  return (
    <div ref={group} className="lock-choice" role="radiogroup" aria-label={label}>
      {LEVELS.map((level) => {
        const why = reasonOf(t, planLock(levels, level, rights));
        return (
          <button
            key={level}
            role="radio"
            aria-checked={checked === level}
            tabIndex={level === stop ? 0 : -1}
            className={armed === level ? "armed" : undefined}
            disabled={Boolean(why)}
            title={why}
            data-level={level}
            onKeyDown={(e) => {
              noKeyRepeat.onKeyDown(e);
              onKey(e, level);
            }}
            onClick={() => choose(level)}
          >
            {armed === level ? pressAgainFor(t, level) : `${level === "hard" ? "🔒🔒 " : level === "soft" ? "🔒 " : ""}${names[level]}`}
          </button>
        );
      })}
    </div>
  );
}
