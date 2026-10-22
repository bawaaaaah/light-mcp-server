/**
 * DMX over USB (docs/specs/output-artnet-sacn.md, « DMX USB ») : an interface plugged into the
 * computer, with its own DMX line, no network. Two kinds, as in QLC+'s « DMX USB » :
 * - « open » (Enttec Open DMX USB and the FTDI FT232R cables like it): the computer makes the DMX
 *   signal itself, 250 kbaud, 8 bits, 2 stop bits: a break, then the start code and 512 channels,
 *   again and again, since fixtures expect a steady signal (about 40 frames a second).
 * - « pro » (Enttec DMX USB Pro and compatibles): a message to the interface (0x7E, label 6 « send
 *   DMX », the length, the start code and the channels, 0xE7), which makes the signal and repeats
 *   the last frame by itself; sent when it changes, and every second.
 * A serial port is held by one program at a time: on standby the interfaces are let go, so QLC+ can
 * take them. Unplugged, an interface is opened again as soon as it comes back.
 */
import { createRequire } from "node:module";

export type DmxUsbKind = "open" | "pro";

/** The part of a serial port this uses (@serialport/bindings-interface). */
export interface SerialPortHandle {
  write(buffer: Buffer): Promise<void>;
  drain(): Promise<void>;
  set(options: { brk?: boolean; rts?: boolean }): Promise<void>;
  close(): Promise<void>;
}

export interface SerialPortInfo {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
}

export interface SerialBinding {
  list(): Promise<SerialPortInfo[]>;
  open(options: { path: string; baudRate: number; dataBits: 8; stopBits: 1 | 2; parity: "none" }): Promise<SerialPortHandle>;
}

const PRO_START = 0x7e;
const PRO_END = 0xe7;
const PRO_SEND_DMX = 6;
const FTDI_VENDOR = "0403";

/** An Enttec USB Pro « send DMX » message: start code 0 then the channels. */
export function encodeUsbPro(data: Uint8Array): Buffer {
  const length = data.length + 1;
  return Buffer.concat([Buffer.from([PRO_START, PRO_SEND_DMX, length & 0xff, length >> 8, 0]), Buffer.from(data), Buffer.from([PRO_END])]);
}

/** An Open DMX frame, sent after the break: start code 0 then the channels. */
export function openDmxFrame(data: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from([0]), Buffer.from(data)]);
}

/** The ports a DMX interface may be on: FTDI chips first (both kinds use one). */
export function dmxCandidates(ports: SerialPortInfo[], platform = process.platform): (SerialPortInfo & { ftdi: boolean })[] {
  return ports
    .map((p) => ({ ...p, path: platform === "darwin" ? p.path.replace(/^\/dev\/tty\./, "/dev/cu.") : p.path, ftdi: p.vendorId?.toLowerCase() === FTDI_VENDOR }))
    .filter((p) => !/Bluetooth|debug-console/i.test(p.path))
    .sort((a, b) => Number(b.ftdi) - Number(a.ftdi) || a.path.localeCompare(b.path));
}

/** The serial ports of this machine, or why they cannot be reached. */
export function loadSerial(): { binding?: SerialBinding; error?: string } {
  try {
    const { autoDetect } = createRequire(import.meta.url)("@serialport/bindings-cpp") as { autoDetect: () => SerialBinding };
    return { binding: autoDetect() };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

const OPEN_PERIOD_MS = 25; // a full frame takes 23 ms at 250 kbaud
const BREAK_MS = 1;
const PRO_KEEPALIVE_MS = 1000;
const RETRY_MS = 2000;

export interface DmxUsbStatus {
  path: string;
  kind: DmxUsbKind;
  open: boolean;
  framesSent: number;
  error?: string;
}

/** One interface: opens it, sends the latest frame in its own rhythm, opens it again when it comes back. */
export class DmxUsbDevice {
  private port: SerialPortHandle | undefined;
  private data = new Uint8Array(512);
  private changed = true;
  private running = false;
  private generation = 0;
  private lastWrite = 0;
  framesSent = 0;
  error: string | undefined;

  constructor(
    readonly path: string,
    readonly kind: DmxUsbKind,
    private readonly binding: SerialBinding,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms).unref()),
    private readonly now: () => number = Date.now,
  ) {}

  /** The universe to send: taken at the next frame. */
  frame(data: Uint8Array): void {
    if (data.length !== this.data.length || data.some((v, i) => v !== this.data[i])) {
      this.data = data.slice();
      this.changed = true;
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop(++this.generation);
  }

  /** Runs until stopped; a loop from before a stop and a start ends by itself, closing only its own port. */
  private async loop(generation: number): Promise<void> {
    const alive = () => this.running && this.generation === generation;
    let port: SerialPortHandle | undefined;
    const release = async () => {
      if (!port) return;
      const p = port;
      port = undefined;
      if (this.port === p) this.port = undefined;
      await p.close().catch(() => undefined);
    };
    while (alive()) {
      if (!port) {
        try {
          port = await this.binding.open({ path: this.path, baudRate: this.kind === "open" ? 250_000 : 57_600, dataBits: 8, stopBits: this.kind === "open" ? 2 : 1, parity: "none" });
          if (!alive()) break;
          this.port = port;
          this.error = undefined;
          this.changed = true;
        } catch (err) {
          this.error = (err as Error).message;
          await this.sleep(RETRY_MS);
          continue;
        }
      }
      const began = this.now();
      try {
        if (this.kind === "open") {
          await port.set({ brk: true });
          await this.sleep(BREAK_MS);
          await port.set({ brk: false });
          await port.write(openDmxFrame(this.data));
          await port.drain(); // the next break must not cut this frame
          this.framesSent++;
        } else if (this.changed || began - this.lastWrite >= PRO_KEEPALIVE_MS) {
          this.changed = false;
          this.lastWrite = began;
          await port.write(encodeUsbPro(this.data));
          this.framesSent++;
        }
      } catch (err) {
        // unplugged: let go, and try again until it is back
        if (alive()) this.error = (err as Error).message;
        await release();
        await this.sleep(RETRY_MS);
        continue;
      }
      await this.sleep(Math.max(1, OPEN_PERIOD_MS - (this.now() - began)));
    }
    await release();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.generation++;
    const p = this.port;
    this.port = undefined;
    if (p) await p.close().catch(() => undefined);
  }

  status(): DmxUsbStatus {
    return { path: this.path, kind: this.kind, open: this.port !== undefined, framesSent: this.framesSent, ...(this.error ? { error: this.error } : {}) };
  }
}

/** The interfaces the routes name: opened while the output sends, let go on standby. */
export class DmxUsbOutputs {
  private readonly devices = new Map<string, DmxUsbDevice>();
  /** Sending (the output started, not on standby). */
  private active = false;
  readonly binding: SerialBinding | undefined;
  readonly error: string | undefined;

  constructor(binding?: SerialBinding | null, private readonly sleep?: (ms: number) => Promise<void>) {
    if (binding === null) this.error = "DMX USB désactivé";
    else if (binding) this.binding = binding;
    else ({ binding: this.binding, error: this.error } = loadSerial());
  }

  /** The interfaces wanted now (path → kind): new ones opened, the others let go. */
  use(wanted: { path: string; kind: DmxUsbKind }[]): void {
    const keep = new Map(wanted.map((w) => [w.path, w.kind]));
    for (const [path, d] of this.devices) {
      if (keep.get(path) !== d.kind) {
        void d.stop();
        this.devices.delete(path);
      }
    }
    if (!this.binding) return;
    for (const [path, kind] of keep) {
      if (this.devices.has(path)) continue;
      const d = new DmxUsbDevice(path, kind, this.binding, this.sleep);
      this.devices.set(path, d);
      if (this.active) d.start();
    }
  }

  send(path: string, data: Uint8Array): void {
    this.devices.get(path)?.frame(data);
  }

  /** Standby lets the interfaces go (QLC+ may open them); back, they are opened again. */
  setActive(on: boolean): void {
    this.active = on;
    for (const d of this.devices.values()) {
      if (on) d.start();
      else void d.stop();
    }
  }

  async list(): Promise<(SerialPortInfo & { ftdi: boolean })[]> {
    return this.binding ? dmxCandidates(await this.binding.list()) : [];
  }

  status(): DmxUsbStatus[] {
    return [...this.devices.values()].map((d) => d.status());
  }

  async stop(): Promise<void> {
    await Promise.all([...this.devices.values()].map((d) => d.stop()));
    this.devices.clear();
  }
}
