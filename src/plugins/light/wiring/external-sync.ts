/**
 * What the light follows from the other software of the stage (docs/specs/midi.md): the DJ over OS2L (its beats
 * and its pad), AbleSet over OSC (its songs and sections) and Ableton Link (its tempo), with their commands.
 */
import { z } from "zod";
import { CommandError, type CommandRegistry } from "../commands/registry.js";
import type { SongServices } from "../commands/song-commands.js";
import { AbleSetClient } from "../ableset/ableset.js";
import type { LinkListener } from "../link/link.js";
import type { MidiHub } from "../midi/hub.js";
import { OS2L_PORT } from "../midi/mapping.js";
import type { Os2lEvent } from "../os2l/codec.js";
import { Os2lServer } from "../os2l/server.js";
import type { ShowRuntime } from "../show/runtime.js";
import type { TempoClock } from "../timing/tempo.js";
import { say } from "../../../core/lang.js";
import { advertise, localHost } from "../../../core/mdns.js";
import type { ConfigSection } from "../light-config.js";

export interface ExternalSyncDeps {
  commands: CommandRegistry;
  runtime: ShowRuntime;
  songs: SongServices;
  tempo: TempoClock;
  link: LinkListener;
  hub: MidiHub;
  /** The DJ server's port, its allow list and its announce. */
  os2l: ConfigSection<"os2l">;
  /** Whether AbleSet is followed, and where it runs. */
  ableset: ConfigSection<"ableset">;
}

/**
 * Opens the OS2L server and the AbleSet client (not started: start() does), then registers the link, ableset and
 * os2l commands and subscribes the tempo follower (third of the plugin's command subscribers, after the activity log).
 */
export class ExternalSync {
  readonly os2l: Os2lServer;
  readonly ableset: AbleSetClient;
  /** The DJ pad's buttons met so far, with the look each plays and the state its pad shows. */
  private readonly os2lButtons = new Map<string, { name: string; page?: string; look: string; on: boolean }>();
  /** The DJ leads while the MIDI clock, the chosen source, is silent: it leads again when it comes back. */
  private djOverMidi = false;
  private os2lAnnounce: { stop: () => Promise<void> } | undefined;

  constructor(private readonly deps: ExternalSyncDeps) {
    const { commands, ableset, link, tempo } = deps;
    this.os2l = new Os2lServer(deps.os2l.get(), (event) => this.onOs2l(event));
    this.ableset = new AbleSetClient(ableset.get(), (song, section) => this.followAbleSet(song, section));
    commands.register({
      name: "link.status",
      title: "Ableton Link",
      titleEn: "Ableton Link",
      hints: "O",
      description: "The Ableton Link session heard on the network (listening only, while the tempo source is « link »): peers, sessions, the tempo of the session with the most peers, and whether its beats are placed (`phase`: its time measured from a peer, the light's beats fall on the session's).",
      right: "dashboards:view",
      readOnly: true,
      profiles: ["setup", "live"],
      schema: z.object({}),
      run: () => link.status(),
    });
    commands.register({
      name: "ableset.status",
      title: "AbleSet",
      titleEn: "AbleSet",
      hints: "O",
      description: "AbleSet (setlist for Ableton Live) followed over OSC: on or off, where it is, connected (its heartbeat), the song and section it plays, and whether the show had the last one asked.",
      right: "dashboards:view",
      readOnly: true,
      profiles: ["setup", "live"],
      schema: z.object({}),
      run: () => this.ableset.status(),
    });
    commands.register({
      name: "ableset.jump",
      title: "Aller dans AbleSet",
      titleEn: "Jump in AbleSet",
      hints: "O",
      changes: ["playback", "rules"],
      description: "Moves AbleSet to a song of the show (id or title) and, optionally, one of its sections (id or name): AbleSet receives the song's title and the section's name. While the follower is on, the light then follows AbleSet there as it plays.",
      right: "commands:trigger",
      profiles: ["live"],
      schema: z.object({ song: z.string(), section: z.string().optional() }),
      run: ({ song: wanted, section: part }) => {
        if (!ableset.get().enabled) throw new CommandError("failed", say("le suivi d'AbleSet est éteint (page MIDI)", "the AbleSet follower is off (MIDI page)"));
        const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
        const song = deps.songs.songs.list().find((s) => s.id === wanted || same(s.title, wanted));
        if (!song) throw new CommandError("invalid", say(`chant inconnu : ${wanted}`, `unknown song: ${wanted}`));
        const section = part === undefined ? undefined : song.sections.find((x) => x.id === part || same(x.name, part));
        if (part !== undefined && !section) throw new CommandError("invalid", say(`section inconnue : ${part}`, `unknown section: ${part}`));
        this.ableset.jump(song.title, section?.name);
        return { song: song.title, ...(section ? { section: section.name } : {}), connected: this.ableset.connected };
      },
    });
    commands.register({
      name: "ableset.configure",
      title: "Suivre AbleSet",
      titleEn: "Follow AbleSet",
      hints: "IO",
      changes: ["machine"],
      description: "Turns the AbleSet follower on or off and says where AbleSet runs (host, default this machine; port 39051). While AbleSet plays, the section of the same name in the song of the same title starts (as a song's timeline would: never a manual-only look). Kept in the machine config.",
      right: "midi:configure",
      profiles: ["setup"],
      schema: z.object({ enabled: z.boolean().optional(), host: z.string().min(1).optional(), port: z.number().int().min(1).max(65535).optional() }),
      run: async (patch) => {
        ableset.put({ ...ableset.get(), ...patch });
        await this.ableset.setConfig(ableset.get());
        await ableset.save();
        return this.ableset.status();
      },
    });
    commands.onCommand((e) => {
      if (!e.ok) return;
      if (e.name === "tempo.set" || e.name === "tempo.tap") {
        this.djOverMidi = false; // the desk chose
        // Link listened to only while it leads; its tempo taken at once when chosen
        if (tempo.state().source === "link") {
          void link.start().then(() => {
            const bpm = link.status().bpm;
            if (bpm !== undefined && tempo.state().source === "link") tempo.follow(bpm, undefined, "link");
          });
        } else void link.stop();
      }
      this.syncOs2lFeedback();
    });
    commands.register({
      name: "os2l.status",
      title: "DJ (OS2L)",
      titleEn: "DJ (OS2L)",
      description: "DJ software connected over OS2L (VirtualDJ…): port, DJ computers with their tempo and beats received, the last buttons pressed. Their beats lead the tempo unless the MIDI clock plays; a button plays the look (or recalls the snapshot) of its name.",
      right: "dashboards:view",
      readOnly: true,
      profiles: ["setup", "live"],
      schema: z.object({}),
      run: () => this.os2l.status(),
    });
  }

  /** Starts the OS2L server (a taken port is only said) and announces it on the network (mDNS) when asked. */
  async startOs2l(): Promise<void> {
    const config = this.deps.os2l;
    await this.os2l.start().catch((err: Error) => console.warn(`OS2L indisponible sur le port ${config.get().port} : ${err.message}`));
    const os2lPort = this.os2l.port;
    if (os2lPort && config.get().advertise) this.os2lAnnounce = await advertise({ instance: "Lumière", type: "_os2l._tcp", port: os2lPort, ...localHost() });
  }

  async stopOs2l(): Promise<void> {
    await this.os2lAnnounce?.stop();
    this.os2lAnnounce = undefined;
    await this.os2l.stop();
  }

  /** The MIDI clock, the chosen source, plays again while the DJ led in its absence: Ableton leads again. */
  handBackToMidi(): void {
    if (this.djOverMidi && this.deps.tempo.midiReceiving()) {
      this.djOverMidi = false;
      this.deps.tempo.setSource("midi"); // Ableton plays again: it leads
    }
  }

  /**
   * OS2L (docs/specs/midi.md, « OS2L ») : the DJ's beats lead the tempo, catching up their phase,
   * unless the MIDI clock plays (Ableton leads, and takes it back when it returns) or the desk's
   * microphone listens; a pad button plays the look of its name (by name or id, any case) while
   * « on », or recalls the snapshot of its name.
   */
  private onOs2l(event: Os2lEvent): void {
    const { tempo, hub, runtime, commands } = this.deps;
    if (event.evt === "beat") {
      const s = tempo.state();
      if (s.source === "audio") return; // the microphone the desk switched on leads
      if (s.source === "midi") {
        if (tempo.midiReceiving()) return; // Ableton plays: it leads
        this.djOverMidi = true;
      }
      if (event.bpm >= 20 && event.bpm <= 400) tempo.follow(event.bpm, 0, "os2l");
      return;
    }
    if (event.evt === "cmd") {
      // a numbered command (a VirtualDJ slider): a CC on the « OS2L » port, for the MIDI mappings
      if (Number.isInteger(event.id) && event.id >= 0 && event.id <= 127) hub.dispatch("os2l", OS2L_PORT, [0xb0, event.id, Math.round(event.param * 127)]);
      return;
    }
    if (event.evt !== "btn") return;
    const wanted = event.name.toLowerCase();
    const named = <T extends { id: string; name: string }>(list: T[]) => list.find((x) => x.id.toLowerCase() === wanted || x.name.trim().toLowerCase() === wanted);
    const ctx = { origin: "os2l" as const, can: () => true };
    const look = named(runtime.looks.list());
    if (look) {
      this.os2lButtons.set(wanted, { name: event.name, page: event.page, look: look.id, on: event.state === "on" });
      void commands.invoke(event.state === "on" ? "look.go" : "look.stop", { id: look.id }, ctx).catch(() => undefined);
      return;
    }
    const snapshot = event.state === "on" ? named(runtime.snapshots.list()) : undefined;
    if (snapshot) void commands.invoke("snapshot.recall", { id: snapshot.id }, ctx).catch(() => undefined);
  }

  /** AbleSet reached a section: the song of that title (or id), its section of that name (or id), any case. */
  private followAbleSet(songName: string, sectionName: string): boolean {
    const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
    const song = this.deps.songs.songs.list().find((s) => same(s.title, songName) || same(s.id, songName));
    const section = song?.sections.find((x) => same(x.name, sectionName) || same(x.id, sectionName));
    if (!song || !section) return false;
    void this.deps.commands.invoke("song.section.go", { song: song.id, section: section.id }, { origin: "ableset", can: () => true }).catch(() => undefined);
    return true;
  }

  /** The DJ's pad shows what plays: a look started or stopped elsewhere lights or darkens its button. */
  private syncOs2lFeedback(): void {
    for (const b of this.os2lButtons.values()) {
      const on = this.deps.runtime.isActive(b.look);
      if (on === b.on) continue;
      b.on = on;
      this.os2l.feedback(b.name, on, b.page);
    }
  }
}
