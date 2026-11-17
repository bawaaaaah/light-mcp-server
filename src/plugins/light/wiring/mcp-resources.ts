/** What the light plugin gives an AI client besides its tools (docs/specs/mcp.md): the instructions and the resources. */
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthMiddleware } from "../../../core/auth.js";
import { say } from "../../../core/lang.js";
import type { CommandRegistry } from "../commands/registry.js";
import type { DmxEngine } from "../engine/dmx-engine.js";
import type { OutputRouter } from "../output/output-router.js";
import type { ShowRuntime } from "../show/runtime.js";
import type { TempoClock } from "../timing/tempo.js";
import type { Venue } from "../venue/venue.js";
import { liveLockLine } from "./motion-summary.js";

/** What a model needs before its first call: safety, cheap reads, safe edits, where to look (docs/specs/mcp.md). */
export const LIGHT_INSTRUCTIONS = [
  "light-mcp-server drives DMX lighting (Art-Net/sACN). Every tool maps to one server command, the same ones the web UI, MIDI and OSC use; you only see the tools your role may call, and rules (UV max, forbidden modes…) are applied last to whatever you do.",
  "Safety: light_panic recalls the safe snapshot (else the safe look, else a Blackout); light_blackout cuts everything. light_output_status says whether the output is in standby (then nothing reaches the rig). Looks marked manualOnly are for a human finger, not for you.",
  "Reading: light_look_list is brief (name, playing, colour, technique kind); read one look whole with light_look_get before changing it with light_look_put (a brief look is refused). light_stage_describe and the light://show, light://venue and light://knowledge resources give the context.",
  "Changing safely: propose before you write — light_show_diff says what a put would change, field by field, without writing; for several changes, light_show_propose holds them as one proposal that the user applies on the Show page (or you, on their yes, with light_show_apply; light_show_revert takes it back as a whole). Show what it does and write on the user's yes. light_show_references says where a look, group or channel fader is used; deletes are refused while something uses it unless force. light_history_undo takes back a change from its light_activity_list line (say first what was changed on that object since); light_history_list / light_history_restore put an earlier version back, light_history_deleted lists what can come back.",
  "Checking: light_show_lint (references, patch overlaps, missing definitions, ambiguous names), light_venue_patch_check, light_selftest_run. light_activity_list says who did what and from where.",
  "Building a show: patch fixtures, make a canvas, create looks (light_look_from_intent, light_show_autopresets), then light_dashboard_generate.",
  "Venues: several shows may play on one venue (light_venue_list), and a patch change then changes all of them; light_show_venue_detach gives the open show its own copy first. Gear not installed for this show is marked with light_venue_fixture_presence (dark, silent, kept in the patch), not deleted; light_venue_positions_import copies placement from another venue (preview, then apply).",
  "During a service (profile live), only if the desk switched « IA en live » on (show settings, liveAi): light_live_adjust makes small touch-ups — a DCA by up to 25 % at a time, a look started or stopped — within the rules, without asking each time. Never a manual-only or danger look; Panic and Blackout remain for emergencies.",
].join("\n");

export interface McpResourceDeps {
  commands: CommandRegistry;
  runtime: ShowRuntime;
  venue: Venue;
  engine: DmxEngine;
  router: OutputRouter;
  tempo: TempoClock;
  auth: AuthMiddleware | undefined;
}

/** MCP resources: readable snapshots for the AI (docs/specs/mcp.md, « Ressources »). */
export function registerMcpResources(server: McpServer, { commands, runtime, venue, engine, router, tempo, auth }: McpResourceDeps): void {
  const json = (uri: URL, value: unknown) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(value, null, 2) }] });
  const sys = { origin: "mcp" as const, can: () => true };
  server.registerResource("show", "light://show", { title: "Show", description: "Looks, palettes, groups, songs, setlists and settings of the current show.", mimeType: "application/json" }, async (uri) =>
    json(uri, {
      settings: runtime.settings,
      palettes: runtime.palettes.list(),
      looks: runtime.looks.list().map(({ technique, ...l }) => ({ ...l, technique: technique.kind })),
      groups: runtime.groups.list(),
      songs: await commands.invoke("song.list", {}, sys),
      setlists: await commands.invoke("setlist.list", {}, sys),
    }),
  );
  server.registerResource("venue", "light://venue", { title: "Lieu", description: "Patch, canvases and rules of the venue.", mimeType: "application/json" }, (uri) =>
    json(uri, { fixtures: venue.fixtures.list().map((f) => (venue.absent.has(f.id) ? { ...f, absent: true } : f)), canvases: venue.canvases.list().map(({ render, ...c }) => ({ ...c, renderedRanges: render.length })), rules: runtime.venueRules.list() }),
  );
  server.registerResource("live", "light://live", { title: "En direct", description: "What is playing now, in plain French: standby, forced channels, looks, masters, blackout, tempo, song and section.", mimeType: "text/plain" }, async (uri) => {
    const t = tempo.state();
    const looks = runtime.activeLooks().map((id) => runtime.looks.get(id)?.name ?? id);
    const masters = runtime.groups.list().filter((g) => g.master).map((g) => `${g.name} ${Math.round((g.master!.mute ? 0 : g.master!.level) * 100)} % (effectif ${Math.round(runtime.effectiveLevel(g.id) * 100)} %)`);
    const song = (await commands.invoke("song.state", {}, sys)) as { song?: string; section?: string };
    const parked = engine.parkedCount();
    const text = [
      router.isStandby() ? "Sortie EN VEILLE : rien n'atteint les projecteurs (une autre console tient peut-être la lumière)." : "",
      parked ? `${parked} canal(aux) FORCÉ(S) depuis la console DMX, par-dessus le show tant qu'ils ne sont pas relâchés.` : "",
      engine.isBlackout() ? "BLACKOUT actif." : "",
      liveLockLine(runtime, venue),
      `Looks en cours : ${looks.length ? looks.join(", ") : "aucun"}.`,
      masters.length ? `Masters : ${masters.join(" ; ")}.` : "",
      `Tempo : ${t.bpm.toFixed(1)} BPM (${t.source}${t.clockMissing ? ", horloge absente" : ""}).`,
      song.song ? `Chant : ${song.song}, section ${song.section ?? "—"}.` : "",
      runtime.lastClamps.length ? `Règles appliquées : ${runtime.lastClamps.length} valeur(s) bornée(s).` : "",
    ].filter(Boolean).join("\n");
    return { contents: [{ uri: uri.href, mimeType: "text/plain", text }] };
  });
  server.registerResource("stage", "light://stage", { title: "Scène", description: "The stage in plain French: zones (protected ones flagged), fixtures in them and fixtures lighting them.", mimeType: "text/plain" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/plain", text: String(await commands.invoke("stage.describe", {}, sys)) }],
  }));
  server.registerResource("knowledge", "light://knowledge", { title: "Base de connaissances couleur", description: "Mood → colours and design rules.", mimeType: "application/json" }, async (uri) => json(uri, await commands.invoke("knowledge.get", {}, sys)));

  // Read with the caller's own rights: a resource gives nothing its tools would refuse (the log needs show:write).
  const as = (extra: { authInfo?: { token: string } } | undefined) => {
    const token = extra?.authInfo?.token;
    return { origin: "mcp" as const, can: (right: string) => token === undefined || !auth || auth.can(token, right) };
  };
  server.registerResource("rules", "light://rules", { title: "Règles", description: "Rules of the venue and the show, the rule programs and the active one.", mimeType: "application/json" }, async (uri, extra) =>
    json(uri, { rules: await commands.invoke("rule.list", {}, as(extra)), programs: await commands.invoke("program.list", {}, as(extra)), activeProgram: runtime.activeProgram ?? null }),
  );
  server.registerResource("midi-map", "light://midi/map", { title: "Table MIDI", description: "MIDI mappings as a Markdown table: input, mode, action, label.", mimeType: "text/markdown" }, async (uri, extra) => ({
    contents: [{ uri: uri.href, mimeType: "text/markdown", text: String(await commands.invoke("export.notes", {}, as(extra))) }],
  }));
  server.registerResource("osc-map", "light://osc/map", { title: "Table OSC", description: "OSC addresses, their parameters and the command each one runs.", mimeType: "application/json" }, async (uri, extra) => json(uri, await commands.invoke("osc.table", {}, as(extra))));
  server.registerResource("notes", "light://notes", { title: "Notes", description: "Every note of the show and the venue (looks, groups, fixtures, songs…).", mimeType: "application/json" }, async (uri, extra) => json(uri, await commands.invoke("notes.search", { query: "" }, as(extra))));
  type SongRow = { id: string; title: string; sections: { look?: string }[] };
  const lookName = (id?: string) => (id ? (runtime.looks.get(id)?.name ?? id) : undefined);
  // one song, its sections with their looks by name; listed so a client can browse the songs
  server.registerResource(
    "song",
    new ResourceTemplate("light://song/{id}", {
      list: async (extra) => ({ resources: ((await commands.invoke("song.list", {}, as(extra))) as SongRow[]).map((s) => ({ uri: `light://song/${s.id}`, name: s.title })) }),
    }),
    { title: "Chant", description: "One song: sections with their looks (by name), cues, tempo and mood.", mimeType: "application/json" },
    async (uri, vars, extra) => {
      const song = ((await commands.invoke("song.list", {}, as(extra))) as SongRow[]).find((x) => x.id === String(vars.id));
      if (!song) throw new Error(say(`chant inconnu : ${String(vars.id)}`, `unknown song: ${String(vars.id)}`));
      return json(uri, { ...song, sections: song.sections.map((x) => ({ ...x, lookName: lookName(x.look) })) });
    },
  );
  server.registerResource("setlist", "light://setlist", { title: "Setlist", description: "The setlist in use with its songs in order, where the service is (song, section), and the other setlists.", mimeType: "application/json" }, async (uri, extra) => {
    const state = (await commands.invoke("song.state", {}, as(extra))) as { setlist?: string; song?: string; section?: string };
    const setlists = (await commands.invoke("setlist.list", {}, as(extra))) as { id: string; name: string; songs: string[] }[];
    const songs = (await commands.invoke("song.list", {}, as(extra))) as SongRow[];
    const current = setlists.find((x) => x.id === state.setlist);
    return json(uri, {
      current: current ? { ...current, songs: current.songs.map((id) => ({ id, title: songs.find((x) => x.id === id)?.title ?? id })) } : null,
      position: { song: state.song ?? null, section: state.section ?? null },
      setlists: setlists.map(({ id, name }) => ({ id, name })),
    });
  });
  server.registerResource("log", "light://log", { title: "Journal d'activité", description: "Who did what, from where, on which object, over the last week (needs the show:write right).", mimeType: "application/json" }, async (uri, extra) =>
    json(uri, await commands.invoke("activity.list", { limit: 500 }, as(extra))),
  );
}
