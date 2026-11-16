/**
 * Proposals before a write: diff, propose, list, apply, revert, discard.
 * Part of the show commands (show-commands.ts registers them all, with the scope they share: show-command-scope.ts).
 */
import { z } from "zod";
import { CommandError } from "./registry.js";
import { CanvasOpSchema, type Impact } from "../venue/canvas-edit.js";
import { clampPoint } from "../venue/target-aim.js";
import { StagePointSchema, TargetSchema } from "../show/model.js";
import { stableStringify } from "../data/store.js";
import { fillBasis } from "../show/position-presets.js";
import { newIntentionId } from "../knowledge/intentions.js";
import { normalizeMood } from "../knowledge/knowledge.js";
import { ZoneSchema } from "../venue/stage.js";
import { diff } from "../data/diff.js";
import { say } from "../../../core/lang.js";
import type { ProposalHooks, ShowCommandsApi, ShowCommandScope } from "./show-command-scope.js";
import type { CanvasCommands } from "./canvas-commands.js";
import type { HistoryCommands } from "./history-commands.js";
import type { Passes } from "./canvas-commands.js";
import type { StageCommands } from "./stage-commands.js";

export function registerProposalCommands(common: ShowCommandScope, { checkCanvasPut, planEdit, putCanvas, refuseUnlessPassed, revisionOf, sameRevision, sharedFlag, unknownCanvas }: Pick<CanvasCommands, "checkCanvasPut" | "planEdit" | "putCanvas" | "refuseUnlessPassed" | "revisionOf" | "sameRevision" | "sharedFlag" | "unknownCanvas">, { zonePutError }: Pick<StageCommands, "zonePutError">, { keepLive, liveOfTarget }: Pick<HistoryCommands, "keepLive" | "liveOfTarget">): ShowCommandsApi {
  const { reg, show, freshIntentionId, venue, dashboards, intentions } = common;
  // A proposal before a write: what a put would change, validated by the same schema, nothing written.
  const DIFFABLE = {
    looks: show.looks,
    groups: show.groups,
    faders: show.faders,
    dashboards,
    palettes: show.palettes,
    zones: show.zones,
    rules: show.rules,
    venueRules: show.venueRules,
    fixtures: venue.fixtures,
    canvases: venue.canvases,
    // a target's point and engagement are live (T24): a design edit keeps them, as target.put does
    targets: {
      validate: (v: unknown) => {
        const o = (v && typeof v === "object" ? v : {}) as { id?: unknown; point?: unknown; bounds?: unknown };
        const cur = typeof o.id === "string" ? show.targets.get(o.id) : undefined;
        if (cur) return show.targets.validate({ ...o, ...liveOfTarget(cur) });
        // a new one: where target.put would put it, not engaged
        const { point: _p, engaged: _e, engagedAt: _a, ...design } = o as Record<string, unknown>;
        const bounds = TargetSchema.shape.bounds.safeParse(o.bounds).data;
        // bounded as target.put bounds it (a point that is not one is left for the schema to refuse)
        const given = StagePointSchema.safeParse(o.point);
        const point = given.success ? clampPoint(given.data, show.targetBounds(bounds ? { bounds } : {})) : (o.point ?? show.newTargetPoint(bounds));
        return show.targets.validate({ ...design, point });
      },
      get: (i: string) => show.targets.get(i),
      delete: (i: string) => show.targets.delete(i),
      put: (v: unknown) => show.targets.put(v),
    },
    // a named position (T32): its basis filled as position.preset.put fills it, so that a diff shows no basis noise
    positions: {
      validate: (v: unknown) => {
        const o = (v && typeof v === "object" ? v : {}) as { id?: unknown };
        const parsed = show.positionPresets.validate(v);
        return show.positionPresets.validate({ ...parsed, basis: fillBasis(parsed, typeof o.id === "string" ? show.positionPresets.get(o.id) : undefined, (f) => show.positionBasis(f)) });
      },
      get: (i: string) => show.positionPresets.get(i),
      delete: (i: string) => show.deletePositionPreset(i),
      put: (v: unknown) => show.positionPresets.put(v),
    },
    // a creation of intention.put (no id) gets its generated id when proposed (show.propose pins it, T15b); a
    // lone show.diff reads it as new. A label without a letter or a digit is refused, as the command does
    intentions: {
      validate: (v: unknown) => {
        const o = (v && typeof v === "object" ? v : {}) as { id?: unknown; label?: unknown };
        return intentions.validate({ ...o, id: o.id ?? (normalizeMood(typeof o.label === "string" ? o.label : "") ? newIntentionId(0) : "") });
      },
      get: (i: string) => intentions.get(i),
      delete: (i: string) => intentions.delete(i),
      put: (v: unknown) => intentions.put(v),
    },
  } as const;
  type Diffable = keyof typeof DIFFABLE;
  type Store = { validate(v: unknown): { id: string }; get(id: string): unknown; delete(id: string): boolean; put(v: unknown): unknown };
  /**
   * The write commands a proposal can hold (and light call … --check): their collection, the argument carrying the object, the arguments kept beside it.
   * An edit (venue.canvas.edit) carries operations, not the object: `plan` computes what it would write (and what it does to the looks, or why
   * it cannot be proposed), and `restore` is the put that takes it back.
   */
  const PUT_COMMANDS: Record<string, { collection: (a: Record<string, unknown>) => Diffable; key: string; keep?: string[]; plan?: (a: Record<string, unknown>) => { object: unknown; impact?: Impact }; restore?: string }> = {
    "look.put": { collection: () => "looks", key: "look" },
    "group.put": { collection: () => "groups", key: "group" },
    "fader.put": { collection: () => "faders", key: "fader" },
    "dashboard.put": { collection: () => "dashboards", key: "dashboard" },
    "palette.put": { collection: () => "palettes", key: "palette" },
    // the zone's outline as stage.zone.put checks it: a crossed one is said with the proposal, not at apply
    "stage.zone.put": {
      collection: () => "zones",
      key: "zone",
      plan: (a) => {
        const zone = ZoneSchema.safeParse(a.zone);
        const wrong = zone.success ? zonePutError(zone.data) : undefined;
        if (wrong) throw new CommandError("invalid", wrong);
        return { object: a.zone };
      },
    },
    "rule.put": { collection: (a) => (a.where === "venue" ? "venueRules" : "rules"), key: "rule", keep: ["where"] },
    "venue.fixture.put": { collection: () => "fixtures", key: "fixture" },
    "target.put": { collection: () => "targets", key: "target" },
    "position.preset.put": { collection: () => "positions", key: "position" },
    "venue.canvas.put": {
      collection: () => "canvases",
      key: "canvas",
      // looks' steps written with the canvas would show in no preview, and no take-back would put them back
      plan: (a) => {
        if (a.steps && typeof a.steps === "object" && Object.keys(a.steps).length) throw new Error(say("les pas donnés avec le canevas (steps) ne se prévisualisent pas : passer les looks par look.put", "steps given with the canvas (steps) cannot be previewed: give the looks with look.put"));
        return { object: a.canvas };
      },
    },
    "venue.canvas.edit": {
      collection: () => "canvases",
      key: "canvas",
      restore: "venue.canvas.put",
      plan: (a) => {
        if (a.adapt) throw new Error(say("une proposition n'adapte pas les pas des looks : l'enlever (adapt) et éditer le canevas directement", "a proposal does not adapt the steps of looks: drop adapt and edit the canvas directly"));
        if (a.dryRun) throw new Error(say("une proposition n'est pas un essai : enlever dryRun", "a proposal is not a dry run: drop dryRun"));
        const current = venue.canvases.get(String(a.id));
        if (!current) throw unknownCanvas(String(a.id));
        // the revision the proposal was made on (show.propose pins it): a canvas changed since is not the one that was shown
        sameRevision(current.id, current, typeof a.revision === "string" ? a.revision : undefined);
        const { canvas, impact, broken, adaptable } = planEdit(current, z.array(CanvasOpSchema).parse(a.ops ?? []));
        // what apply would refuse is said now, with the proposal: a forced one carries its impact in the preview
        refuseUnlessPassed(canvas.name, impact, broken, { force: a.force === true, shared: a.shared === true }, "edit", adaptable);
        return { object: canvas, impact };
      },
    },
    // the show's intentions only: the personal library is not the show's to propose
    "intention.put": {
      collection: (a) => {
        if (a.scope === "personal") throw new CommandError("invalid", say("pas de proposition pour une intention de la bibliothèque personnelle : seulement celles du show", "no proposal for an intention of the personal library: only the show's"));
        return "intentions";
      },
      key: "intention",
      keep: ["scope"],
    },
  };
  const putOf = (command: string) => {
    const p = PUT_COMMANDS[command];
    if (!p) throw new Error(say(`pas de proposition pour ${command} : ${Object.keys(PUT_COMMANDS).join(", ")}`, `no proposal for ${command}: ${Object.keys(PUT_COMMANDS).join(", ")}`));
    return p;
  };
  const targetOf = (command: string, args: Record<string, unknown>) => {
    const p = putOf(command);
    return { collection: p.collection(args), ...(p.plan ? p.plan(args) : { object: args[p.key] }) };
  };
  /** What putting `object` in `collection` would change, or why it is invalid. */
  const diffOf = (collection: Diffable, object: unknown) => {
    const coll = DIFFABLE[collection] as Store;
    let parsed: { id: string };
    try {
      parsed = coll.validate(object);
    } catch (err) {
      const issues = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".") || "(objet)"}${say(" : ", ": ")}${i.message}`) : [String(err)];
      return { valid: false as const, collection, issues };
    }
    // a zone's outline as stage.zone.put checks it, the collection named or the command (whose plan says it first)
    const wrong = collection === "zones" ? zonePutError(parsed as z.infer<typeof ZoneSchema>) : undefined;
    if (wrong) throw new CommandError("invalid", wrong);
    const current = coll.get(parsed.id);
    return { valid: true as const, collection, id: parsed.id, new: current === undefined, changes: current === undefined ? [] : diff(current, parsed) };
  };
  reg.register({
    name: "show.diff",
    title: "Ce que changerait un enregistrement",
    titleEn: "What a save would change",
    description:
      "Proposal before a write: what putting this object would change, field by field (path, before, after), checked by the same schema as the put command (defaults filled in), nothing written. new = it does not exist yet. Show it to the user and write only on their yes; the put command may still refuse it for its own reasons (a cycle, a partial look). Give a collection (looks, groups, faders, dashboards, palettes, zones, rules (show), venueRules, fixtures, canvases, targets, positions) and the object, or the put command and its arguments (look.put, group.put, fader.put, dashboard.put, palette.put, stage.zone.put, rule.put, venue.fixture.put, target.put, position.preset.put, venue.canvas.put, venue.canvas.edit: the canvas its operations would write, without adapting steps). A target's point and engagement are live state: kept as they are. Several changes to apply together: show.propose.",
    right: "show:propose",
    readOnly: true,
    profiles: ["setup", "design"],
    schema: z
      .object({
        collection: z.enum(Object.keys(DIFFABLE) as [Diffable, ...Diffable[]]).optional(),
        object: z.record(z.string(), z.unknown()).optional(),
        command: z.string().optional(),
        args: z.record(z.string(), z.unknown()).optional(),
      })
      .refine((a) => (a.collection && a.object) || (a.command && a.args), { message: "collection et object, ou command et args" }),
    run: (a) => {
      const { collection, object } = a.command ? targetOf(a.command, a.args!) : { collection: a.collection!, object: a.object };
      return diffOf(collection, object);
    },
  });

  // Proposals (docs/specs/mcp.md, « Proposer puis appliquer »): several changes held together, shown
  // field by field, applied all or nothing by someone who may write, taken back together. In
  // memory: a proposal is for the session at hand, not for the show.
  type Change = { command: string; args: Record<string, unknown> };
  /** `wrote`: a fingerprint of what the apply left (live levels aside), to tell a later edit before taking it back. */
  type Applied = Change & { collection: Diffable; id: string; before?: unknown; wrote?: string };
  /** An object as an undo compares it: a fader's level, a group's master and a target's point and engagement move live, they are no edit. */
  const fingerprint = (collection: string, obj: unknown): string => {
    if (obj === undefined) return "";
    const o = obj as Record<string, unknown>;
    const { level: _l, ...noLevel } = o;
    const { master: _m, ...noMaster } = o;
    const { point: _p, engaged: _e, engagedAt: _a, ...noLive } = o;
    return stableStringify(collection === "faders" ? noLevel : collection === "groups" ? noMaster : collection === "targets" ? noLive : o);
  };
  interface Proposal {
    id: string;
    title?: string;
    who?: string;
    origin: string;
    at: number;
    status: "pending" | "applied" | "reverted" | "discarded";
    changes: Change[];
    applied?: Applied[];
    appliedAt?: number;
    appliedBy?: string;
    /** Order of the applies (two can share a millisecond): which of two proposals came last. */
    appliedSeq?: number;
    /** Writes made with it outside the put commands (another show's looks, a fader emptied): done once it applies, taken back once it is reverted. */
    hooks?: ProposalHooks;
  }
  const proposals = new Map<string, Proposal>();
  let applySeq = 0;
  const PROPOSAL_KEEP_MS = 24 * 3600_000;
  const proposalOf = (id: string) => {
    const p = proposals.get(id);
    // `gone`: nothing to act on any more (a screen may forget it), unlike a refusal it could pass
    if (!p) throw new CommandError("failed", say(`proposition inconnue : ${id}`, `unknown proposal: ${id}`), { gone: true });
    return p;
  };
  const previewOf = (c: Change) => {
    let target: { collection: Diffable; object: unknown; impact?: Impact };
    try {
      target = targetOf(c.command, c.args);
    } catch (err) {
      // an edit whose operations cannot apply: invalid, as a put the schema refuses
      return { command: c.command, valid: false as const, collection: putOf(c.command).collection(c.args), issues: [err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : (err as Error).message] };
    }
    return { command: c.command, ...diffOf(target.collection, target.object), ...(target.impact?.looksAffected.length ? { impact: target.impact } : {}) };
  };
  /**
   * Puts the objects back as they were before (newest first): the ones created go. A canvas is put back
   * like any canvas put (looks of exact steps checked) unless `force`: the rollback of a failed apply puts
   * back what was there a moment ago, and forces.
   *
   * Every canvas is checked before the first object goes back, so a refusal leaves the proposal whole. The
   * check is the cautious one: it reads the looks as they are now, not as the take-back will leave them, so a
   * proposal that changed a canvas and the steps of its looks together is refused though it would line up
   * again; `force` takes it back.
   */
  const takeBack = async (done: Applied[], ctx: Parameters<Parameters<typeof reg.register>[0]["run"]>[1], pass: Passes = { force: false, shared: false }) => {
    for (const a of done) if (a.collection === "canvases" && a.before !== undefined) checkCanvasPut(venue.canvases.parse(a.before), new Map(), pass, "restore");
    // newest first, the fixtures before anything else: looks, faders and canvases are checked against a fixture's
    // mode (checkChannels, its heads), so a mode change (venue.fixture.mode) must be undone before what it carried
    const newestFirst = [...done].reverse();
    // what each object was just before it went back: a put refused midway (a look whose channels the restored mode
    // no longer has) puts these back as they were, written directly, so the take-back is all or nothing too
    const touched: { a: Applied; was: unknown }[] = [];
    try {
      for (const a of [...newestFirst.filter((x) => x.collection === "fixtures"), ...newestFirst.filter((x) => x.collection !== "fixtures")]) {
        const coll = DIFFABLE[a.collection] as Store;
        touched.push({ a, was: coll.get(a.id) });
        if (a.before === undefined) coll.delete(a.id);
        else if (a.collection === "canvases") await putCanvas(a.before, { ...pass, how: "restore" });
        else {
          const p = putOf(a.command);
          await reg.invoke(p.restore ?? a.command, { ...Object.fromEntries((p.keep ?? []).map((k) => [k, a.args[k]])), [p.key]: keepLive(a.collection, a.before, coll.get(a.id)) }, ctx);
        }
      }
    } catch (err) {
      for (const { a, was } of touched.reverse()) {
        const coll = DIFFABLE[a.collection] as Store;
        if (was === undefined) coll.delete(a.id);
        else coll.put(was);
      }
      throw err;
    }
  };
  const ChangeSchema = z.object({ command: z.enum(Object.keys(PUT_COMMANDS) as [string, ...string[]]), args: z.record(z.string(), z.unknown()) });
  reg.register({
    name: "show.propose",
    title: "Proposer des changements",
    titleEn: "Propose changes",
    hints: "",
    description:
      "Holds several changes (put commands and their arguments, as show.diff takes them) as one proposal, nothing written: each is checked and described field by field. One change per canvas (a whole put, or one venue.canvas.edit with several operations). Someone who may write applies it all or nothing (show.apply, or the Show page), show.revert takes it back together. For an AI client: propose, show the user what it does, apply on their yes — or leave it for them in the interface.",
    right: "show:propose",
    profiles: ["setup", "design"],
    schema: z.object({ changes: z.array(ChangeSchema).min(1).max(50), title: z.string().max(200).optional() }),
    run: ({ changes, title }, ctx) => {
      // a new intention gets its id now (T15b): applied, taken back and applied again, it is that one
      changes = changes.map((c) => {
        const i = c.command === "intention.put" ? (c.args.intention as { id?: unknown; label?: unknown } | undefined) : undefined;
        // an empty label stays without id: refused below as the command refuses it
        return i && typeof i === "object" && i.id === undefined && normalizeMood(typeof i.label === "string" ? i.label : "") ? { ...c, args: { ...c.args, intention: { ...i, id: freshIntentionId() } } } : c;
      });
      const preview: ReturnType<typeof previewOf>[] = changes.map(previewOf);
      // one change per canvas: a second one would be read on a canvas the first has already changed (cell indices, the revision pinned below)
      const canvasesSeen = new Set<string>();
      changes.forEach((c, k) => {
        const p = preview[k]!;
        if (!p.valid || p.collection !== "canvases") return;
        if (canvasesSeen.has(p.id)) preview[k] = { command: c.command, valid: false, collection: "canvases", issues: [say(`un seul changement par canevas (${p.id} est déjà changé par cette proposition) : un put complet ou une édition à plusieurs opérations`, `one change per canvas (${p.id} is already changed by this proposal): a whole put or one edit with several operations`)] };
        canvasesSeen.add(p.id);
      });
      const invalid = preview.filter((x) => !x.valid);
      if (invalid.length) return { valid: false, preview };
      // an edit is a list of cell indices: it is applied to the canvas that was shown, or not at all
      changes = changes.map((c) => {
        const current = c.command === "venue.canvas.edit" && c.args.revision === undefined ? venue.canvases.get(String(c.args.id)) : undefined;
        return current ? { ...c, args: { ...c.args, revision: revisionOf(current) } } : c;
      });
      const now = Date.now();
      for (const [k, p] of proposals) if (now - p.at > PROPOSAL_KEEP_MS) proposals.delete(k);
      const id = `p-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      proposals.set(id, { id, ...(title ? { title } : {}), ...(ctx.who ? { who: ctx.who } : {}), origin: ctx.origin, at: now, status: "pending", changes });
      return { valid: true, id, preview };
    },
  });
  reg.register({
    name: "show.proposals",
    title: "Propositions",
    titleEn: "Proposals",
    description: "Proposals of the last day, newest first: who made them, from where, their status (pending, applied, reverted, discarded) and, for one not applied, what applying it now would change.",
    right: "show:propose",
    readOnly: true,
    profiles: ["setup", "design"],
    schema: z.object({}),
    run: () =>
      [...proposals.values()]
        .filter((p) => Date.now() - p.at <= PROPOSAL_KEEP_MS)
        .sort((a, b) => b.at - a.at)
        .map((p) => ({
          id: p.id,
          title: p.title,
          who: p.who,
          origin: p.origin,
          at: p.at,
          status: p.status,
          appliedAt: p.appliedAt,
          appliedBy: p.appliedBy,
          preview: p.status === "applied" ? p.applied!.map((a) => ({ command: a.command, valid: true, collection: a.collection, id: a.id, new: a.before === undefined, changes: [] })) : p.changes.map(previewOf),
        })),
  });
  reg.register({
    name: "show.apply",
    title: "Appliquer une proposition",
    titleEn: "Apply a proposal",
    hints: "",
    description: "Applies a pending (or reverted) proposal through the usual put commands and their checks, all or nothing: if one is refused, those already made are taken back and nothing has changed.",
    right: "show:write",
    profiles: ["setup", "design"],
    schema: z.object({ id: z.string() }),
    run: async ({ id }, ctx) => {
      const p = proposalOf(id);
      if (p.status !== "pending" && p.status !== "reverted") throw new Error(say(`proposition déjà ${p.status === "applied" ? "appliquée" : "écartée"}`, `proposal already ${p.status}`));
      // writes made beside the puts were planned on what was there then: they are not replayed later
      if (p.status === "reverted" && p.hooks) throw new CommandError("invalid", say(`« ${p.title ?? id} » ne se refait pas : le relancer (son plan est relu sur ce qui est là maintenant)`, `“${p.title ?? id}” cannot be redone: run it again (its plan is read again on what is there now)`));
      const done: Applied[] = [];
      try {
        for (const c of p.changes) {
          const { collection, object } = targetOf(c.command, c.args);
          const coll = DIFFABLE[collection] as Store;
          const target = coll.validate(object).id;
          const before = coll.get(target);
          await reg.invoke(c.command, c.args, ctx);
          done.push({ ...c, collection, id: target, ...(before !== undefined ? { before } : {}), ...(p.hooks ? { wrote: fingerprint(collection, coll.get(target)) } : {}) });
        }
        // the writes beside the puts belong to the all or nothing: on their failure everything goes back
        if (p.hooks) {
          try {
            await p.hooks.apply();
          } catch (err) {
            await p.hooks.revert();
            throw err;
          }
        }
      } catch (err) {
        try {
          await takeBack(done, ctx, { force: true, shared: true });
        } catch (back) {
          // the take-back itself failed: what it could not put back is said, never a bare error (the state is partial)
          const left = done.map((a) => `${a.collection}/${a.id}`).join(", ");
          throw new CommandError(
            "failed",
            say(
              `proposition non appliquée, et la remise en état a échoué : l'état est PARTIEL. Écrit et peut-être pas remis : ${left}. Cause : ${(err as Error).message} ; remise : ${(back as Error).message}`,
              `proposal not applied, and putting things back failed: the state is PARTIAL. Written and maybe not put back: ${left}. Cause: ${(err as Error).message}; take-back: ${(back as Error).message}`,
            ),
            { proposal: id, partial: done.map((a) => ({ collection: a.collection, id: a.id })) },
          );
        }
        throw new CommandError("failed", say(`proposition non appliquée, rien n'a changé : ${(err as Error).message}`, `proposal not applied, nothing changed: ${(err as Error).message}`), { proposal: id });
      }
      Object.assign(p, { status: "applied", applied: done, appliedAt: Date.now(), appliedSeq: ++applySeq, ...(ctx.who ? { appliedBy: ctx.who } : {}) });
      return { id, applied: done.length };
    },
  });
  reg.register({
    name: "show.revert",
    title: "Défaire une proposition",
    titleEn: "Revert a proposal",
    hints: "D",
    description:
      "Takes an applied proposal back as a whole: the objects it changed return to what they were just before it (later changes to them go too), the ones it created are removed; a put refused midway puts everything back as it was (nothing half undone). show.apply applies it again (redo), except a mode change (venue.fixture.mode), which is run again instead. A canvas is put back as venue.canvas.put does it, every canvas checked before the first object goes back, on the looks as they are now (force; shared for a venue shared with other shows). A mode change is taken back only over objects unchanged since (`detail.changed` lists the others; overwrite: true takes it back over them), and never while a later mode change still applied wrote the same objects (`detail.blockedBy`: take that one back first).",
    right: "show:write",
    profiles: ["setup", "design"],
    schema: z.object({
      id: z.string(),
      force: z.boolean().default(false).describe("put a canvas back even if looks of exact steps no longer line up with its cells"),
      overwrite: z.boolean().default(false).describe("take a mode change back over objects edited since it"),
      shared: sharedFlag,
    }),
    run: async ({ id, force, overwrite, shared }, ctx) => {
      const p = proposalOf(id);
      if (p.status !== "applied") throw new CommandError("failed", say("proposition non appliquée : rien à défaire", "proposal not applied: nothing to take back"), { gone: true });
      p.hooks?.guard?.(); // made on another show or venue than the one open now: refused before anything moves
      if (p.hooks) {
        const storeOf = (a: Applied) => DIFFABLE[a.collection] as Store;
        const changed = p.applied!.filter((a) => a.wrote !== undefined && fingerprint(a.collection, storeOf(a).get(a.id)) !== a.wrote);
        const same = (a: Applied, b: Applied) => a.collection === b.collection && a.id === b.id;
        // a later mode change still applied wrote these objects: taking this one back first would put back offsets of a
        // mode the other fixture no longer has. Never forced: the later one goes back first
        const later = [...proposals.values()].filter((q) => q !== p && q.status === "applied" && q.hooks && (q.appliedSeq ?? 0) > (p.appliedSeq ?? 0) && q.applied!.some((b) => changed.some((a) => same(a, b))));
        if (later.length) {
          const titles = later.map((q) => say(`« ${q.title ?? q.id} »`, `“${q.title ?? q.id}”`)).join(", ");
          throw new CommandError("invalid", say(`défaire d'abord ${titles} : il a réécrit les mêmes objets depuis`, `take back ${titles} first: it rewrote the same objects since`), { blockedBy: later.map((q) => ({ id: q.id, title: q.title ?? q.id })) });
        }
        if (changed.length && !overwrite) {
          const kind: Record<string, string> = { fixtures: say("appareil", "fixture"), looks: "look", faders: "fader", canvases: say("canevas", "canvas"), groups: say("groupe", "group") };
          const list = changed.map((a) => ({ collection: a.collection, id: a.id, name: (storeOf(a).get(a.id) as { name?: string } | undefined)?.name ?? a.id }));
          const said = list.map((c) => `${kind[c.collection] ?? c.collection} ${say(`« ${c.name} »`, `“${c.name}”`)}`).join(", ");
          throw new CommandError("invalid", say(`changé depuis : ${said}. Le défaire remettrait leur état d'avant et perdrait ces modifications : overwrite: true`, `changed since: ${said}. Taking it back would put their earlier state back and lose these edits: overwrite: true`), { changed: list, overwrite: true });
        }
      }
      await takeBack(p.applied!, ctx, { force, shared });
      const warnings = (await p.hooks?.revert()) ?? [];
      p.status = "reverted";
      return { id, reverted: p.applied!.length, ...(warnings.length ? { warnings } : {}) };
    },
  });
  reg.register({
    name: "show.discard",
    title: "Écarter une proposition",
    titleEn: "Discard a proposal",
    hints: "DI",
    description: "Drops a pending proposal without applying it.",
    right: "show:propose",
    profiles: ["setup", "design"],
    schema: z.object({ id: z.string() }),
    run: ({ id }) => {
      const p = proposalOf(id);
      if (p.status === "applied") throw new Error(say("proposition appliquée : la défaire d'abord (show.revert)", "proposal applied: take it back first (show.revert)"));
      p.status = "discarded";
      return { id, discarded: true };
    },
  });
  return {
    hookProposal(id, hooks) {
      const p = proposalOf(id);
      if (p.status !== "pending") throw new Error(say(`proposition déjà ${p.status}`, `proposal already ${p.status}`));
      p.hooks = hooks;
    },
  };
}
