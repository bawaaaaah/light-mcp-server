import type { CommandDef } from "./registry.js";

/**
 * The four MCP tool annotations of every command (docs/specs/mcp.md, « Annotations des outils »).
 * Directories that list MCP tools (OpenAI's among them) refuse a tool that leaves one of them out,
 * and clients use them to decide what to run without asking: they must say what the handler does.
 *
 * - readOnlyHint: the command changes nothing (`CommandDef.readOnly`).
 * - destructiveHint: it deletes stored data, empties or replaces a whole show or venue, discards a
 *   pending proposal, or overwrites an object that no version can bring back. Looks, groups, faders,
 *   dashboards and canvases keep their versions (`history.restore`): updating them by id (`*.put`,
 *   `venue.canvas.edit`, `venue.canvas.auto`) is not destructive; updating a fixture, zone, rule, palette,
 *   program, mapping, song or setlist replaces it, and is.
 *   Panic is not: `panic.undo` puts back what played. Setting a value of the live state (a level, a
 *   position, the tempo) is not either.
 * - idempotentHint: calling it again with the same arguments leaves things as the first call did.
 *   Steps (`next`, `tap`), relative changes (`turn`, `delta`), restarts that rewind, and commands that add a
 *   new thing or stamp a new time each call are not.
 * - openWorldHint: the command itself talks to what is outside this server: the network, MIDI or DMX
 *   devices and ports, another program (AbleSet, Live, Ableton Link). Changing the show's own state is not,
 *   even though the output then sends it to the lights. `selftest.run` replays every mapping, which may
 *   call any command: it is open world and not read-only.
 *
 * Each command says them in its own definition (`CommandDef.hints`, codes D destructive, I idempotent, O open world);
 * every command that writes must (a test fails otherwise): a writer without them is declared destructive and not
 * idempotent, the cautious reading. A read-only command is never destructive and always idempotent; it gives "O" when it
 * looks at the network, the hardware or another program.
 */
export interface ToolHints {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/** The four hints of a command, all explicit booleans. */
export function toolHints(def: Pick<CommandDef, "readOnly" | "hints">): ToolHints {
  const readOnly = Boolean(def.readOnly);
  const code = def.hints;
  if (readOnly) return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: Boolean(code?.includes("O")) };
  if (code === undefined) return { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
  return { readOnlyHint: false, destructiveHint: code.includes("D"), idempotentHint: code.includes("I"), openWorldHint: code.includes("O") };
}
