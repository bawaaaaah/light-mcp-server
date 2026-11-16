/**
 * Snapshots (the whole live state, saved ahead) and « Panic neutre ».
 * Part of the show commands (show-commands.ts registers them all, with the scope they share: show-command-scope.ts).
 */
import { z } from "zod";
import type { CommandContext } from "./registry.js";
import type { DmxEngine } from "../engine/dmx-engine.js";
import type { Snapshot } from "../show/model.js";
import { slugify } from "../data/store.js";
import type { ShowRuntime, SnapshotLockMode } from "../show/runtime.js";
import { say } from "../../../core/lang.js";
import { UNFREEZE_ORIGINS } from "./move-commands.js";
import type { ShowCommandScope } from "./show-command-scope.js";

/**
 * How a snapshot recalled by a command puts the motion lock back (decision U3 of 2026-11-14): exactly from an origin that
 * may unfreeze, hardened only from an automatic one (OSC, OS2L, AbleSet, a song), which may freeze but never unfreeze.
 */
const lockModeFor = (origin: CommandContext["origin"]): SnapshotLockMode => (UNFREEZE_ORIGINS.includes(origin) ? "exact" : "harden");

/**
 * Puts a snapshot back the way `snapshot.recall` does: the runtime applies it, then the Blackout is set. `lock`: its
 * motion lock exactly (snapshot.recall), or only what hardens the lock now (the Panic's safe snapshot, the startup
 * snapshot: decisions D1, D2 of T26).
 */
export function recallSnapshot(engine: DmxEngine, show: ShowRuntime, snap: Snapshot, lock: SnapshotLockMode = "exact"): { looks: string[]; skipped: string[] } {
  try {
    return show.applySnapshot(snap, lock);
  } finally {
    engine.setBlackout(snap.blackout);
  }
}

/** Recalls the open show's startup snapshot, if it names one that exists; the output standby is not touched. */
export function recallStartupSnapshot(engine: DmxEngine, show: ShowRuntime): { id: string; name: string } | { missing: string } | undefined {
  const id = show.settings.startupSnapshot;
  if (!id) return undefined;
  const snap = show.snapshots.get(id);
  if (!snap) return { missing: id };
  // replayed at launch and on show.open: it can freeze heads, never unfreeze them (decision D2)
  recallSnapshot(engine, show, snap, "harden");
  return { id: snap.id, name: snap.name };
}

export function registerSnapshotCommands(common: ShowCommandScope): void {
  const { reg, engine, show, idSchema } = common;
  // ---- snapshots: the whole live state, saved ahead (the safe state of « Panic neutre »)
  reg.register({ name: "snapshot.list", title: "Instantanés", description: "Snapshots of the show: the whole live state saved ahead (looks playing, DCA levels and mutes, channel faders, grand master, rule program, Blackout).", right: "dashboards:view", readOnly: true, profiles: ["setup", "design", "live"], schema: z.object({}), run: () => show.snapshots.list() });
  reg.register({
    name: "snapshot.save",
    title: "Enregistrer un instantané",
    description: "Saves what plays now and every level as a snapshot (a new one, or over `id`).",
    right: "show:write",
    profiles: ["design", "live"],
    schema: z.object({ name: z.string().min(1), id: z.string().optional(), notes: z.string().optional() }),
    run: ({ name, id: given, notes }) => {
      let target = given ?? slugify(name);
      for (let i = 2; !given && show.snapshots.get(target); i++) target = `${slugify(name)}-${i}`;
      return show.snapshots.put({ id: target, name, notes, ...show.captureSnapshot(engine.isBlackout()) });
    },
  });
  reg.register({
    name: "snapshot.recall",
    title: "Rappeler un instantané",
    description: "Puts a snapshot back at once: only its looks play, its DCA, faders, grand master, program and Blackout are set. Objects deleted since are skipped and listed.",
    right: "commands:snapshot",
    profiles: ["live", "design"],
    schema: idSchema,
    run: ({ id: i }, ctx) => {
      const snap = show.snapshots.get(i);
      if (!snap) throw new Error(say(`instantané inconnu : ${i}`, `unknown snapshot: ${i}`));
      // decision U3: an automatic origin (OSC, OS2L, AbleSet, a song) may freeze, never unfreeze — the lock only hardens
      return { id: i, ...recallSnapshot(engine, show, snap, lockModeFor(ctx.origin)) };
    },
  });
  reg.register({
    name: "snapshot.delete",
    title: "Supprimer un instantané",
    description: "Deletes a snapshot (and unsets it as the safe or startup snapshot).",
    right: "show:write",
    profiles: ["design"],
    schema: idSchema,
    run: ({ id: i }) => {
      if (show.settings.safeSnapshot === i) show.saveSettings({ safeSnapshot: undefined });
      if (show.settings.startupSnapshot === i) show.saveSettings({ startupSnapshot: undefined });
      return { deleted: show.snapshots.delete(i) };
    },
  });

  /** Panic's second half: everything stopped, then the show's safe state. */
  const safeState = () => {
    // no head moves by itself (T25, question 4): they hold where they are until the safe state claims them, gliding
    show.holdPositions();
    // and no target keeps them (T24, decision Q2): every target disengaged, the heads stay where they are
    show.disengageTargets();
    show.stopAll();
    show.clearColours(); // the colours applied by hand go too (T41)
    show.releasePositions();
    engine.release();
    const snap = show.settings.safeSnapshot ? show.snapshots.get(show.settings.safeSnapshot) : undefined;
    if (snap) {
      // the safe snapshot can freeze or harden the lock, never lift it (decision D1)
      const done = recallSnapshot(engine, show, snap, "harden");
      return { action: "safe-snapshot", snapshot: snap.id, ...done };
    }
    const safe = show.settings.safeLook;
    if (safe && show.looks.get(safe)) {
      engine.setBlackout(false);
      show.go(safe);
      return { action: "safe-look", look: safe };
    }
    engine.setBlackout(true);
    return { action: "blackout", reason: say("aucun look de secours défini", "no fallback look set") };
  };
  reg.register({
    name: "panic",
    title: "Panic neutre",
    description:
      "Safety: stops every look and the colours applied by hand (colour.apply), a voluntary reset under way (fixture.reset), the DMX console parks and the manual head positions, disengages every target, then recalls the show's safe state: its safe snapshot (the whole state saved ahead), else its safe look, else a Blackout. No moving head moves by itself: they hold where they really are (position.release or position.releaseTop lets them go) until a claim takes them; a safe snapshot or look that carries a move takes them, gliding. A safe snapshot's motion lock only freezes or hardens heads, never lifts the lock.",
    right: "commands:panic",
    profiles: ["setup", "design", "live"],
    schema: z.object({}),
    run: () => {
      show.rememberBeforePanic(engine.isBlackout()); // a Panic pressed by mistake is undone for a minute (panic.undo)
      show.cancelResets(); // a voluntary reset under way stops: the Reset channels go back to rest
      const result = safeState();
      show.notePanicDone(engine.isBlackout());
      return result;
    },
  });
  reg.register({
    name: "panic.undo",
    title: "Annuler le Panic",
    description: "Within a minute of a Panic, puts back what played just before it (looks, DCA, channel faders, grand master, program, Blackout, the motion lock as it was, the targets' points and engagement, the colours applied by hand, at once); the DMX console forcing and hand-aimed heads it released stay released.",
    right: "commands:panic",
    profiles: ["live"],
    schema: z.object({}),
    run: (_args, ctx) => {
      const before = show.takeBeforePanic();
      if (!before) throw new Error(say("rien à annuler : pas de Panic dans la dernière minute", "nothing to undo: no Panic in the last minute"));
      // decision U3: from an automatic origin the lock before the Panic comes back only where it is stricter than now
      const { colours, ...snap } = before;
      const done = show.applySnapshot(snap, lockModeFor(ctx.origin));
      engine.setBlackout(before.blackout);
      // the colours held by hand come back once their looks play again (T41, decision C3)
      const recoloured = show.restoreColours(colours);
      return { undone: true, ...done, ...(recoloured.length ? { colours: recoloured } : {}) };
    },
  });
}
