/**
 * DMX universe buffers (512 channels each). Universe numbers are 1-based for users; buffers are
 * indexed 0..count-1. Channels are 1-based (1..512) in every public API.
 */
export class UniverseStore {
  readonly buffers: Uint8Array[];

  constructor(readonly count: number) {
    this.buffers = Array.from({ length: count }, () => new Uint8Array(512));
  }

  check(universe: number, channel?: number): void {
    if (!Number.isInteger(universe) || universe < 1 || universe > this.count) throw new RangeError(`univers ${universe} hors de 1..${this.count}`);
    if (channel !== undefined && (!Number.isInteger(channel) || channel < 1 || channel > 512)) throw new RangeError(`canal ${channel} hors de 1..512`);
  }

  get(universe: number): Uint8Array {
    this.check(universe);
    return this.buffers[universe - 1]!;
  }
}
