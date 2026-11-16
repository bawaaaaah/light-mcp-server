/**
 * What a command that writes changes (T45; docs/specs/ui-dashboards.md, « Rafraîchissement des écrans »): each one says
 * it in its definition (`CommandDef.changes`), the registry copies it into its event (topic light:command), and a screen
 * reads again when an event changes a domain it shows (web `useDomainEvents`), instead of listing command prefixes.
 * Pure (no import): the web app imports it as it is.
 */
export const DOMAINS = [
  /** Backups of the shows (backup.create, backup.restore). */
  "backups",
  /** A moving head's calibration marks. */
  "calibration",
  /** The venue's canvases. */
  "canvases",
  /** The colour presets and their favourites. */
  "colour-presets",
  /** The colours applied by hand now (colour.apply). */
  "colours",
  "dashboards",
  /** The fixture definition library (.qxf). */
  "definitions",
  /** Channel faders, their channels and levels. */
  "faders",
  /** Groups, DCAs, their levels, exclusive groups. */
  "groups",
  "intentions",
  /** Looks, palettes and look folders. */
  "looks",
  /** The machine's settings: outputs, standby, MIDI profiles and RTP sessions, AbleSet. */
  "machine",
  /** MIDI mappings and MIDI received. */
  "midi",
  /** Where the moving heads point now and their lock: the pad, aiming, a recalled position, the rest, a freeze. */
  "motion",
  /** The notes on any object. */
  "notes",
  /** What the output sends besides the show: DMX console parks, Blackout, a fixture reset, a channel's working mode. */
  "output",
  /** The venue's fixtures: patch, place, orientation, heads, travel, wheel, tracks, mode, presence. */
  "patch",
  /** What plays: looks launched or stopped, Panic, a recalled snapshot, songs and setlists played, the tempo. */
  "playback",
  /** Named positions of the moving heads (position.preset.*). */
  "positions",
  /** Proposals waiting to be applied (show.propose). */
  "proposals",
  /** Rules and rule programs. */
  "rules",
  /** The show's settings (show.settings.set, the grand master, rest positions, its name). */
  "settings",
  /** The open show or its venue replaced as a whole (opened, created, reset, imported, restored, a proposal applied or reverted): read everything again. */
  "show",
  /** The list of the machine's shows (created, renamed, deleted). */
  "shows",
  /** Snapshots saved or deleted. */
  "snapshots",
  /** Songs and setlists as written. */
  "songs",
  /** Targets of the moving heads. */
  "targets",
  /** The stage's zones. */
  "zones",
] as const;

export type Domain = (typeof DOMAINS)[number];

/** Whether an event's changed domains meet those a screen shows. */
export const changesAny = (changes: readonly Domain[] | undefined, domains: readonly Domain[]): boolean => changes !== undefined && changes.some((d) => domains.includes(d));
