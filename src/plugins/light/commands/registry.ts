/**
 * The single command layer (docs/architecture.md, "Principes" §2). Every action — web UI, MIDI,
 * OSC, MCP, song timeline, CLI — goes through `invoke()`, which:
 *   1. validates the arguments (zod),
 *   2. checks the caller's right,
 *   3. runs the command,
 *   4. publishes a "command" event (live topics, MIDI feedback, log) and asks the engine for a frame.
 *
 * MCP tools and HTTP routes are generated from this registry: no business logic lives in adapters.
 */
import { z, type ZodTypeAny } from "zod";

export type Origin = "ui" | "midi" | "osc" | "mcp" | "timeline" | "cli" | "system";

export interface CommandContext {
  origin: Origin;
  /** Right check for the current caller; system/cli callers pass everything. */
  can(right: string): boolean;
}

export interface CommandDef<S extends ZodTypeAny = ZodTypeAny, R = unknown> {
  name: string; // dotted, e.g. "dmx.set"
  title: string; // short French label for UIs
  description: string; // for MCP tool descriptions
  /** Right required, e.g. "commands:dmx". */
  right: string;
  schema: S;
  /** Read-only commands do not change state (no frame request, no undo). */
  readOnly?: boolean;
  /** MCP tool profile(s) this command belongs to. */
  profiles?: ("setup" | "design" | "live")[];
  run(args: z.infer<S>, ctx: CommandContext): R | Promise<R>;
}

export class CommandError extends Error {
  constructor(
    readonly code: "unknown" | "invalid" | "forbidden" | "failed",
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

export interface CommandEvent {
  name: string;
  origin: Origin;
  args: unknown;
  ok: boolean;
  error?: string;
  at: number;
}

export class CommandRegistry {
  private readonly commands = new Map<string, CommandDef>();
  private readonly listeners = new Set<(e: CommandEvent) => void>();

  /** Called after every successful state-changing command (the engine renders immediately). */
  onStateChange: () => void = () => undefined;

  register<S extends ZodTypeAny, R>(def: CommandDef<S, R>): void {
    if (this.commands.has(def.name)) throw new Error(`command ${def.name} registered twice`);
    this.commands.set(def.name, def as unknown as CommandDef);
  }

  list(): CommandDef[] {
    return [...this.commands.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): CommandDef | undefined {
    return this.commands.get(name);
  }

  onCommand(fn: (e: CommandEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async invoke(name: string, rawArgs: unknown, ctx: CommandContext): Promise<unknown> {
    const def = this.commands.get(name);
    if (!def) throw new CommandError("unknown", `commande inconnue : ${name}`);
    if (!ctx.can(def.right)) throw new CommandError("forbidden", `droit requis : ${def.right}`);
    const parsed = def.schema.safeParse(rawArgs ?? {});
    if (!parsed.success) throw new CommandError("invalid", `arguments invalides pour ${name}`, parsed.error.flatten());
    const event: CommandEvent = { name, origin: ctx.origin, args: parsed.data, ok: true, at: Date.now() };
    try {
      const result = await def.run(parsed.data, ctx);
      if (!def.readOnly) this.onStateChange();
      return result;
    } catch (err) {
      event.ok = false;
      event.error = err instanceof Error ? err.message : String(err);
      if (err instanceof CommandError) throw err;
      throw new CommandError("failed", event.error);
    } finally {
      if (!def.readOnly) for (const l of this.listeners) l(event);
    }
  }
}

/** Context for internal callers (engine, timeline, tests): every right granted. */
export const systemContext = (origin: Origin = "system"): CommandContext => ({ origin, can: () => true });
