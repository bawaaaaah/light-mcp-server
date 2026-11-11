/**
 * The four MCP tool annotations of every command (docs/specs/mcp.md, « Annotations des outils »).
 * Directories that list MCP tools (OpenAI's among them) refuse a tool that leaves one of them out,
 * and clients use them to decide what to run without asking: they must say what the handler does.
 *
 * - readOnlyHint: the command changes nothing (`CommandDef.readOnly`).
 * - destructiveHint: it deletes stored data, empties or replaces a whole show or venue, discards a
 *   pending proposal, or overwrites an object that no version can bring back. Looks, groups, faders and
 *   dashboards keep their versions (`history.restore`): updating them by id (`*.put`) is not destructive;
 *   updating a fixture, canvas, zone, rule, palette, program, mapping, song or setlist replaces it, and is.
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
 * Every command that writes must be listed here (a test fails otherwise); a writer left out is
 * declared destructive and not idempotent, the cautious reading. Codes: D destructive, I idempotent,
 * O open world. A read-only command is never destructive and always idempotent.
 */
export interface ToolHints {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export const HINTS: Record<string, string> = {
  // commands that write
  "ableset.configure": "IO",
  "ableset.jump": "O",
  "backup.create": "",
  "backup.restore": "DI",
  blackout: "I",
  "calibration.clear": "DI",
  "calibration.record": "",
  "calibration.solve": "DI",
  "dashboard.delete": "DI",
  "dashboard.generate": "I",
  "dashboard.put": "I",
  "dmx.release": "I",
  "dmx.set": "I",
  "export.ableton.programs": "I",
  "export.ableton.rack": "I",
  "export.liveset": "I",
  "export.mid": "I",
  "fader.channel": "I",
  "fader.delete": "DI",
  "fader.level": "I",
  "fader.put": "I",
  "fixture.definition.add": "DI",
  "fixture.reset": "",
  "grandmaster.set": "I",
  "group.delete": "DI",
  "group.flash": "I",
  "group.level": "I",
  "group.mute": "I",
  "group.put": "I",
  "history.restore": "I",
  "history.undo": "",
  "import.qxw": "DI",
  "live.adjust": "",
  "look.delete": "DI",
  "look.exclusive": "",
  "look.from_intent": "I",
  "look.go": "I",
  "look.put": "I",
  "look.rebuild": "I",
  "look.stop": "I",
  "look.stopall": "I",
  "midi.in": "",
  "midi.mapping.delete": "DI",
  "midi.mapping.put": "DI",
  "midi.profile.save": "DIO",
  "midi.profile.select": "IO",
  "midi.rtp.connect": "IO",
  "midi.rtp.disconnect": "IO",
  "midi.rtp.keep": "IO",
  "notes.set": "D",
  "output.route": "IO",
  "output.standby": "IO",
  "palette.put": "DI",
  panic: "I",
  "panic.undo": "I",
  "position.aim": "I",
  "position.release": "I",
  "position.set": "I",
  "program.delete": "DI",
  "program.put": "DI",
  "program.select": "I",
  "rule.delete": "DI",
  "rule.put": "DI",
  "selftest.run": "O",
  "setlist.next": "",
  "setlist.prev": "",
  "setlist.put": "DI",
  "setlist.select": "I",
  "show.apply": "",
  "show.autopresets": "I",
  "show.create": "",
  "show.delete": "D",
  "show.discard": "DI",
  "show.folder.create": "I",
  "show.folder.delete": "DI",
  "show.folder.move": "I",
  "show.folder.nest": "I",
  "show.folder.rename": "I",
  "show.open": "I",
  "show.propose": "",
  "show.rename": "I",
  "show.reset": "DI",
  "show.revert": "D",
  "show.settings.set": "I",
  "show.venue.detach": "I",
  "show.venue.set": "I",
  "snapshot.delete": "DI",
  "snapshot.recall": "I",
  "snapshot.save": "D",
  "song.delete": "DI",
  "song.follow": "I",
  "song.grid_fill": "I",
  "song.next": "",
  "song.play": "",
  "song.prev": "",
  "song.put": "DI",
  "song.section.go": "I",
  "song.select": "I",
  "song.stop": "I",
  "stage.zone.delete": "DI",
  "stage.zone.put": "DI",
  "tempo.set": "IO",
  "tempo.tap": "",
  "venue.canvas.auto": "DI",
  "venue.canvas.delete": "DI",
  "venue.canvas.put": "DI",
  "venue.fixture.arrange": "I",
  "venue.fixture.delete": "DI",
  "venue.fixture.heads.clear": "DI",
  "venue.fixture.heads.set": "I",
  "venue.fixture.mark": "I",
  "venue.fixture.orient": "",
  "venue.fixture.presence": "I",
  "venue.fixture.put": "DI",
  "venue.grouping.apply": "I",
  "venue.positions.import": "DI",
  "venue.wheel.clear": "DI",
  "venue.wheel.put": "DI",
  // read-only commands that look at the network, the hardware or another program
  "ableset.status": "O",
  "link.status": "O",
  "midi.learn": "O",
  "midi.rtp.sessions": "O",
  "nodes.discover": "O",
  "nodes.list": "O",
  "output.usb.list": "O",
};

/** The four hints of a command, all explicit booleans. */
export function toolHints(def: { name: string; readOnly?: boolean }): ToolHints {
  const readOnly = Boolean(def.readOnly);
  const code = HINTS[def.name];
  if (readOnly) return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: Boolean(code?.includes("O")) };
  if (code === undefined) return { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
  return { readOnlyHint: false, destructiveHint: code.includes("D"), idempotentHint: code.includes("I"), openWorldHint: code.includes("O") };
}
