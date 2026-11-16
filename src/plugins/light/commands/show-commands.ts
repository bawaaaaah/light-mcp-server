/**
 * Venue and show commands: fixture library, patch, canvases, palettes, looks (go/stop), unified
 * groups (level, mute, flash), show settings, and « Panic neutre ». One file per domain (venue-commands.ts,
 * look-commands.ts…), sharing the scope built by show-command-scope.ts; this file registers them all. The registry lists
 * commands by name, so the order they are registered in shows nowhere.
 */
import type { CommandRegistry } from "./registry.js";
import type { DmxEngine } from "../engine/dmx-engine.js";
import type { ShowRuntime } from "../show/runtime.js";
import { createShowCommandScope, type ShowCommandOptions, type ShowCommandsApi } from "./show-command-scope.js";
import { registerVenueCommands } from "./venue-commands.js";
import { registerFixtureOverrideCommands } from "./fixture-override-commands.js";
import { registerLookCommands } from "./look-commands.js";
import { registerCanvasCommands } from "./canvas-commands.js";
import { registerStageCommands } from "./stage-commands.js";
import { registerFolderCommands } from "./folder-commands.js";
import { registerGroupCommands } from "./group-commands.js";
import { registerFaderCommands } from "./fader-commands.js";
import { registerRuleCommands } from "./rule-commands.js";
import { registerDashboardCommands } from "./dashboard-commands.js";
import { registerHistoryCommands } from "./history-commands.js";
import { registerProposalCommands } from "./proposal-commands.js";
import { registerNoteCommands } from "./note-commands.js";
import { registerSettingsCommands } from "./settings-commands.js";
import { registerSnapshotCommands } from "./snapshot-commands.js";

export type { ProposalHooks, ShowCommandOptions, ShowCommandsApi } from "./show-command-scope.js";
export { recallSnapshot, recallStartupSnapshot } from "./snapshot-commands.js";

export function registerShowCommands(reg: CommandRegistry, engine: DmxEngine, show: ShowRuntime, options: ShowCommandOptions = {}): ShowCommandsApi {
  const common = createShowCommandScope(reg, engine, show, options);
  registerVenueCommands(common);
  registerFixtureOverrideCommands(common);
  const look = registerLookCommands(common);
  const canvas = registerCanvasCommands(common, look);
  const stage = registerStageCommands(common, canvas);
  registerFolderCommands(common, look);
  registerGroupCommands(common);
  registerFaderCommands(common);
  registerRuleCommands(common);
  registerDashboardCommands(common);
  const history = registerHistoryCommands(common, canvas);
  const api = registerProposalCommands(common, canvas, stage, history);
  registerNoteCommands(common);
  registerSettingsCommands(common);
  registerSnapshotCommands(common);
  return api;
}
