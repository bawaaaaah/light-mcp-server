/**
 * What doses each light channel on one frame (docs/specs/groups-masters.md, « DCA », T35), channel by
 * channel, each DCA once: the DCAs covering the fixture (its intensity), those of the channel faders
 * linked to a channel, and those including a look. Pure: built on a DcaIndex, the channel faders, the
 * light channels of each fixture and the grand master sent, all read at one instant; compose() builds
 * one per frame and drops it, dmx.explain builds one on demand — one rule, one code path.
 */
import type { DcaIndex } from "./dca.js";
import type { ChannelFader, Group } from "./model.js";

/** The light channels of a fixture: its dimmer(s) and the colour components of its heads (accent ones included). */
export interface LightOffsets {
  dimmers: readonly number[];
  colours: ReadonlySet<number>;
}

/** A light channel: a dimmer or a colour component. Machine channels (a wheel, a macro, a speed), pan/tilt and offsets off the definition are not. */
export const isLight = (light: LightOffsets, offset: number): boolean => light.dimmers.includes(offset) || light.colours.has(offset);

/**
 * The channel that carries a fixture's light, where the grand master and its DCAs land: its dimmer, or a
 * colour when it has none. A colour of a fixture with a dimmer is light, but dosing it too would dose twice.
 */
export const carriesLight = (light: LightOffsets, offset: number): boolean => (light.dimmers.length ? light.dimmers.includes(offset) : light.colours.has(offset));

export interface DosesSource {
  index: DcaIndex;
  faders: readonly ChannelFader[];
  /** The groups, to find those including a look (`presets.included`). */
  groups: readonly Group[];
  /** A fixture's light channels; undefined without a definition (nothing there is light). */
  light(fixtureId: string): LightOffsets | undefined;
  /** The master dimmer of a colour fixture, which a channel fader doses rather than raises (ShowRuntime.dosesDimmer). */
  dosesDimmer(fixtureId: string, offset: number): boolean;
  /** The grand master sent now. */
  grandMaster: number;
}

/** A channel fader's own value on one of its channels, and what doses it. */
export interface FaderValue {
  /** It doses the master dimmer of a colour fixture (×), rather than taking the highest. */
  doses: boolean;
  /** 0..1: its travel × each DCA of `dcas` once × the grand master when `grandMaster`. */
  level: number;
  dcas: string[];
  grandMaster: boolean;
}

export class Doses {
  private readonly lights = new Map<string, LightOffsets | undefined>();
  /** fixture → offset → the DCAs (existing groups) the channel faders there are linked to. */
  private readonly linkedDcas = new Map<string, Map<number, string[]>>();
  private readonly coveringSets = new Map<string, ReadonlySet<string>>();
  private readonly dimmerSets = new Map<string, ReadonlySet<string>>();
  private readonly includingByLook = new Map<string, ReadonlySet<string>>();

  constructor(private readonly source: DosesSource) {
    for (const f of source.faders) {
      if (!f.dca || !source.index.group(f.dca)) continue;
      for (const c of f.channels) {
        const byOffset = this.linkedDcas.get(c.fixture) ?? new Map<number, string[]>();
        this.linkedDcas.set(c.fixture, byOffset);
        const list = byOffset.get(c.offset);
        if (!list) byOffset.set(c.offset, [f.dca]);
        else if (!list.includes(f.dca)) list.push(f.dca);
      }
    }
  }

  get index(): DcaIndex {
    return this.source.index;
  }

  get grandMaster(): number {
    return this.source.grandMaster;
  }

  /** A fixture's light channels, read once per frame. */
  light(fixtureId: string): LightOffsets | undefined {
    if (!this.lights.has(fixtureId)) this.lights.set(fixtureId, this.source.light(fixtureId));
    return this.lights.get(fixtureId);
  }

  /** The DCAs covering a fixture, as a set (its intensity carries them). */
  covering(fixtureId: string): ReadonlySet<string> {
    let set = this.coveringSets.get(fixtureId);
    if (!set) this.coveringSets.set(fixtureId, (set = new Set(this.source.index.covering(fixtureId))));
    return set;
  }

  /** The DCAs the channel faders on one channel are linked to (without the groups above them). */
  linked(fixtureId: string, offset: number): readonly string[] {
    return this.linkedDcas.get(fixtureId)?.get(offset) ?? [];
  }

  /** The DCAs of the faders on a fixture's dimmer(s), with every group above them: they dose its whole light. */
  private dimmerLinked(fixtureId: string): ReadonlySet<string> {
    let set = this.dimmerSets.get(fixtureId);
    if (!set) {
      const light = this.light(fixtureId);
      set = this.source.index.above((light?.dimmers ?? []).flatMap((d) => this.linked(fixtureId, d)));
      this.dimmerSets.set(fixtureId, set);
    }
    return set;
  }

  /** The DCAs dosing what the show sends on a light channel a channel fader holds by « highest » (not a colour fixture's dimmer, which the fader doses itself). */
  showDcas(fixtureId: string, offset: number): string[] {
    const light = this.light(fixtureId);
    if (!light || !isLight(light, offset) || this.source.dosesDimmer(fixtureId, offset)) return [];
    const linked = this.linked(fixtureId, offset);
    if (!linked.length) return [];
    const covering = this.covering(fixtureId);
    const viaDimmer = light.dimmers.includes(offset) ? new Set<string>() : this.dimmerLinked(fixtureId);
    return [...this.source.index.above(linked)].filter((g) => !covering.has(g) && !viaDimmer.has(g));
  }

  /** The groups including a look (`presets.included`) and every group above them, each once; read once per look. */
  private including(lookId: string): ReadonlySet<string> {
    let including = this.includingByLook.get(lookId);
    if (!including) {
      const ids = this.source.groups.filter((g) => g.presets.included.includes(lookId)).map((g) => g.id);
      this.includingByLook.set(lookId, (including = this.source.index.above(ids)));
    }
    return including;
  }

  /** Some group includes the look: its level may be below 1 somewhere. */
  isIncluded(lookId: string): boolean {
    return this.including(lookId).size > 0;
  }

  /**
   * The level the groups including a look give it on one channel of a fixture (no channel: the fixture's light as
   * a whole): those groups and every group above them, each once, but those dosing that channel already — the DCAs
   * covering the fixture, those of the faders on its dimmer, and those of the faders on the channel itself.
   */
  lookLevel(lookId: string, fixtureId: string, offset?: number): number {
    const including = this.including(lookId);
    if (!including.size) return 1;
    const covering = this.covering(fixtureId);
    const viaDimmer = this.dimmerLinked(fixtureId);
    const viaChannel = offset === undefined ? new Set<string>() : this.source.index.above(this.linked(fixtureId, offset));
    return this.source.index.product([...including].filter((g) => !covering.has(g) && !viaDimmer.has(g) && !viaChannel.has(g)));
  }

  /**
   * A channel fader's own value on one of its channels (compose and dmx.explain read this one function). On the
   * channel carrying the fixture's light it follows the grand master and the DCAs covering the fixture, its own DCA
   * among them once; on another light channel (a colour of a fixture with a dimmer) its DCA but those the dimmer
   * already carries; on a machine channel its DCA alone. On a colour fixture's dimmer it doses: its DCA but those
   * covering the fixture, which the dimmer carries already.
   */
  faderValue(fader: ChannelFader, travel: number, fixtureId: string, offset: number): FaderValue {
    const { index } = this.source;
    const own = fader.dca && index.group(fader.dca) ? index.above([fader.dca]) : new Set<string>();
    const light = this.light(fixtureId);
    const covering = this.covering(fixtureId);
    let dcas: string[];
    let grandMaster = false;
    const doses = this.source.dosesDimmer(fixtureId, offset);
    if (doses) dcas = [...own].filter((g) => !covering.has(g));
    else if (light && carriesLight(light, offset)) {
      dcas = [...new Set([...own, ...covering])];
      grandMaster = true;
    } else if (light && isLight(light, offset)) {
      const viaDimmer = this.dimmerLinked(fixtureId);
      dcas = [...own].filter((g) => !covering.has(g) && !viaDimmer.has(g));
    } else dcas = [...own];
    return { doses, level: travel * index.product(dcas) * (grandMaster ? this.source.grandMaster : 1), dcas, grandMaster };
  }
}
