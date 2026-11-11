/**
 * DMX over USB (docs/specs/output-artnet-sacn.md, « DMX USB ») : an interface plugged into the
 * computer, with its own DMX line, no network. Two kinds, as in QLC+'s « DMX USB » :
 * - « open » (Enttec Open DMX USB and the FTDI FT232R cables like it): the computer makes the DMX
 *   signal itself, 250 kbaud, 8 bits, 2 stop bits: a break, then the start code and 512 channels,
 *   again and again, since fixtures expect a steady signal (about 30 frames a second, with room to spare).
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
  set(options: { brk?: boolean; dtr?: boolean; rts?: boolean }): Promise<void>;
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

/**
 * A serial port by its one name: the Mac lists the same device as /dev/tty.* and /dev/cu.*, and opening both would
 * run two writers on one line. The single place that names a port: routes, the outputs and the port list use it.
 */
export function portPath(path: string, platform = process.platform): string {
  return platform === "darwin" ? path.replace(/^\/dev\/tty\./, "/dev/cu.") : path;
}

/** The ports a DMX interface may be on: USB devices only (not Bluetooth nor an app's virtual port), FTDI chips first (both kinds use one). */
export function dmxCandidates(ports: SerialPortInfo[], platform = process.platform): (SerialPortInfo & { ftdi: boolean })[] {
  return ports
    .map((p) => ({ ...p, path: portPath(p.path, platform), ftdi: p.vendorId?.toLowerCase() === FTDI_VENDOR }))
    .filter((p) => (p.vendorId !== undefined || /usb/i.test(p.path)) && !/Bluetooth|debug-console/i.test(p.path))
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

/**
 * Open DMX: at most one frame every 33 ms, about 30 a second (QLC+'s rate for these interfaces). A frame takes 22.6 ms
 * on the line, so the line could take 44 a second, but the computer times the break itself and the margin between the
 * end of a frame and the next break is what keeps a late byte from shifting a frame (a flash on every fixture).
 */
const OPEN_PERIOD_MS = 33;
/** USB Pro: how often the loop looks for a new frame (the interface makes the signal itself). */
const PRO_PERIOD_MS = 25;
/**
 * The break, held at least this long (DMX512-A: 92 µs to 1 s). The mark after it (MAB, at least 8 µs) is the time from
 * letting the break go to the first byte: a call to the driver and the USB, tens of microseconds at the very least.
 */
const BREAK_MS = 2;
/** The start code and 512 channels, 11 bits each (start, 8 data, 2 stop) at 250 kbaud: what a frame takes on the line. */
const FRAME_MS = (513 * 11 * 1000) / 250_000;
/**
 * The next break comes at least this long after the end of a frame: its end in theory (the call to write() plus the
 * 22.6 ms it takes on the line) or the return of drain(), whichever is later. drain() may return when the OS buffer is
 * empty, not the chip's, and the call to write() is not when the chip starts: the guard is room for a late start (USB,
 * a busy libuv thread). With the break and the frame, it sets the period: about 2 + 22.6 + 8 ≈ 33 ms.
 */
const FRAME_GUARD_MS = 8;
const PRO_KEEPALIVE_MS = 1000;
/** After an error the interface is opened again: soon the first time, then less and less often. */
const RETRY_MIN_MS = 250;
const RETRY_MAX_MS = 2000;
/** Before the first frame has come in, the loop only waits. */
const IDLE_MS = 5;
/** Safety nets in real time (they only matter when the line hangs): a stop waits this long at most for the loop to end, a start for the loop it follows. */
const STOP_WAIT_MS = 500;
const START_WAIT_MS = 2000;
/** The same error is written to the log at most this often. */
const WARN_EVERY_MS = 30_000;

export interface DmxUsbStatus {
  path: string;
  kind: DmxUsbKind;
  open: boolean;
  framesSent: number;
  /** The current error: cleared when the interface comes back. */
  error?: string;
  /** Times the interface was closed after an error to be opened again. */
  reopens: number;
  /** The last error and when (ms since the epoch, the wall clock of the server): kept after the interface comes back, so that a glitch leaves a trace. */
  lastError?: string;
  lastErrorAt?: number;
  /** Open DMX: the longest time between two frames since the interface was opened, the last break and the last time from writing a frame to drain() returning (about 22.6 ms if drain waits for the line). */
  maxGapMs?: number;
  breakMs?: number;
  drainMs?: number;
}

/** What a device takes from outside, injectable for tests. */
export interface DmxUsbDeviceOptions {
  /** Waits about this long (a timer; may fire early, the device reads the clock again). */
  sleep?: (ms: number) => Promise<void>;
  /** Paces the frames: a monotonic clock in ms (setting the system time must not move a break). Default performance.now. */
  now?: () => number;
  /** The time of day, for lastErrorAt only. Default Date.now. */
  wallClock?: () => number;
  log?: (message: string) => void;
  /** What must have ended before this device opens the port: the device it replaces on the same port (another kind). */
  after?: Promise<void>;
}

/** One interface: opens it, sends the latest frame in its own rhythm, opens it again when it comes back. */
export class DmxUsbDevice {
  private port: SerialPortHandle | undefined;
  private data = new Uint8Array(512);
  private changed = true;
  private running = false;
  private generation = 0;
  private lastWrite = 0;
  /** A frame has come in since the last stop: before that the buffer is only zeros, which are not worth a signal (a flash of black). */
  private haveFrame = false;
  /** The end of the loop that runs (or ran last): a stop waits for it, and the next loop does not open the port before it. */
  private loopDone: Promise<void>;
  /** Set by a stop for the loop that is ending: it owns the port, so it sends the last frame and closes it. */
  private blackoutOnExit = false;
  private retryMs = RETRY_MIN_MS;
  private lastFrameAt: number | undefined;
  /** When the frame being sent ends on the line, for the guard before the next break. */
  private frameEnd = 0;
  private readonly warned = new Map<string, number>();
  framesSent = 0;
  error: string | undefined;
  reopens = 0;
  lastError: string | undefined;
  lastErrorAt: number | undefined;
  maxGapMs = 0;
  breakMs: number | undefined;
  drainMs: number | undefined;

  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly wallClock: () => number;
  private readonly log: (message: string) => void;

  constructor(
    readonly path: string,
    readonly kind: DmxUsbKind,
    private readonly binding: SerialBinding,
    options: DmxUsbDeviceOptions = {},
  ) {
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms).unref()));
    this.now = options.now ?? (() => performance.now());
    this.wallClock = options.wallClock ?? Date.now;
    this.log = options.log ?? ((message) => console.warn(message));
    this.loopDone = options.after ?? Promise.resolve();
  }

  /** The universe to send: taken at the next frame. */
  frame(data: Uint8Array): void {
    this.haveFrame = true;
    if (data.length !== this.data.length || data.some((v, i) => v !== this.data[i])) {
      this.data = data.slice();
      this.changed = true;
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopDone = this.loop(++this.generation, this.loopDone);
  }

  /** An error that leaves the interface as it is: kept in lastError, and in the log. */
  private note(err: unknown): void {
    const message = (err as Error).message;
    const at = this.now();
    this.lastError = message;
    this.lastErrorAt = this.wallClock();
    const before = this.warned.get(message);
    if (before === undefined || at - before >= WARN_EVERY_MS) {
      this.warned.set(message, at);
      this.log(`DMX USB ${this.path}: ${message}`);
    }
  }

  /** An error that stops the interface: shown as its current error until it comes back. */
  private fail(err: unknown): void {
    this.error = (err as Error).message;
    this.note(err);
  }

  /**
   * Sleeps until the clock reaches `deadline`, reading it again on waking: a timer that fires early (Node's timers start
   * from the loop's time, taken at the start of its turn, and count whole milliseconds) does not cut the wait short.
   * A clock that did not move at all across a sleep (an injected one, frozen) ends the wait: it cannot hold the loop forever.
   */
  private async sleepUntil(deadline: number): Promise<void> {
    for (let at = this.now(); at < deadline; ) {
      await this.sleep(deadline - at);
      const later = this.now();
      if (later === at) return;
      at = later;
    }
  }

  /** One frame on the line. DTR and RTS are named, at 0 as set() has always left them: the lines do not move with the break. */
  private async emit(port: SerialPortHandle, data: Uint8Array): Promise<void> {
    if (this.kind === "pro") {
      await port.write(encodeUsbPro(data));
      return;
    }
    const began = this.now();
    await port.set({ brk: true, dtr: false, rts: false });
    await this.sleepUntil(this.now() + BREAK_MS);
    await port.set({ brk: false, dtr: false, rts: false });
    const writing = this.now();
    this.breakMs = writing - began;
    await port.write(openDmxFrame(data));
    await port.drain(); // the next break must not cut this frame
    const drained = this.now();
    this.drainMs = drained - writing;
    this.frameEnd = Math.max(writing + FRAME_MS, drained) + FRAME_GUARD_MS; // a drain() that came back late still leaves the whole guard
  }

  /** Runs until stopped; a loop from before a stop and a start ends by itself, closing only its own port. */
  private async loop(generation: number, previous: Promise<void>): Promise<void> {
    // a port is held by one opener at a time: after a stop, the loop that ended has closed it before this one opens it
    await Promise.race([previous, new Promise((r) => setTimeout(r, START_WAIT_MS).unref())]);
    const alive = () => this.running && this.generation === generation;
    let port: SerialPortHandle | undefined;
    let sent = false; // this loop has put a frame on the line: only then is there something to blank
    const release = async () => {
      if (!port) return;
      const p = port;
      port = undefined;
      if (this.port === p) this.port = undefined;
      await p.close().catch(() => undefined);
    };
    const retry = async () => {
      await this.sleep(this.retryMs);
      this.retryMs = Math.min(RETRY_MAX_MS, this.retryMs * 2);
    };
    while (alive()) {
      if (!port) {
        try {
          port = await this.binding.open({ path: this.path, baudRate: this.kind === "open" ? 250_000 : 57_600, dataBits: 8, stopBits: this.kind === "open" ? 2 : 1, parity: "none" });
          if (!alive()) break;
          this.port = port;
          this.error = undefined;
          this.changed = true;
          this.lastFrameAt = undefined; // a gap across a reopening is not a gap between frames
          this.maxGapMs = 0; // since the interface was opened
          // the lines low from the start, as every break leaves them (the OS raises them at open)
          if (this.kind === "open") await port.set({ dtr: false, rts: false }).catch((err) => this.note(err)); // not worth closing for: the first break puts them there
        } catch (err) {
          this.fail(err);
          await retry();
          continue;
        }
      }
      if (!this.haveFrame) {
        await this.sleep(IDLE_MS);
        continue;
      }
      const began = this.now();
      try {
        const open = port;
        if (this.kind === "open") {
          if (this.lastFrameAt !== undefined) this.maxGapMs = Math.max(this.maxGapMs, began - this.lastFrameAt);
          this.lastFrameAt = began;
          await this.emit(open, this.data);
          this.framesSent++;
        } else if (this.changed || began - this.lastWrite >= PRO_KEEPALIVE_MS) {
          this.changed = false;
          this.lastWrite = began;
          await this.emit(open, this.data);
          this.framesSent++;
        }
        sent = true;
        this.retryMs = RETRY_MIN_MS;
      } catch (err) {
        // unplugged, or a hiccup: let go, and try again soon, then less and less often, until it is back
        if (alive()) {
          this.fail(err);
          this.reopens++;
        }
        await release();
        await retry();
        continue;
      }
      if (this.kind === "pro") await this.sleep(Math.max(1, PRO_PERIOD_MS - (this.now() - began)));
      else await this.sleepUntil(Math.max(began + OPEN_PERIOD_MS, this.frameEnd));
    }
    if (port && sent && this.blackoutOnExit) {
      this.blackoutOnExit = false;
      await this.farewell(port);
    }
    await release();
  }

  /** The last frame of a stop: all zeros, out on the line (not only handed to the OS) before the port is closed. */
  private async farewell(port: SerialPortHandle): Promise<void> {
    try {
      await this.emit(port, new Uint8Array(512));
      if (this.kind === "pro") await port.drain();
      else await this.sleepUntil(this.frameEnd);
    } catch {
      // the line is going away anyway
    }
  }

  /**
   * `blackout`: one last all-zero frame goes out before the line is let go (standby: QLC+ may take the interface, and a
   * line left silent keeps what the fixtures last showed). What comes after a stop starts from a real frame, never from
   * what was here before. The loop that ends owns the port: it sends that frame and closes it; if it does not end in
   * time (a line that hangs), the port is closed here.
   */
  async stop(blackout = false): Promise<void> {
    const hadFrame = this.haveFrame;
    this.running = false;
    const generation = ++this.generation;
    this.haveFrame = false;
    this.blackoutOnExit ||= blackout && hadFrame; // a second stop before the loop has ended does not cancel the first one's last frame
    await Promise.race([this.loopDone, new Promise((r) => setTimeout(r, STOP_WAIT_MS).unref())]);
    if (this.generation === generation) this.blackoutOnExit = false;
    const p = this.port;
    this.port = undefined;
    if (p) await p.close().catch(() => undefined);
  }

  status(): DmxUsbStatus {
    return {
      path: this.path,
      kind: this.kind,
      open: this.port !== undefined,
      framesSent: this.framesSent,
      reopens: this.reopens,
      ...(this.error ? { error: this.error } : {}),
      ...(this.lastError !== undefined ? { lastError: this.lastError, lastErrorAt: this.lastErrorAt } : {}),
      ...(this.kind === "open" ? { maxGapMs: this.maxGapMs, ...(this.breakMs !== undefined ? { breakMs: this.breakMs } : {}), ...(this.drainMs !== undefined ? { drainMs: this.drainMs } : {}) } : {}),
    };
  }
}

/** The interfaces the routes name: opened while the output sends, let go on standby. */
export class DmxUsbOutputs {
  private readonly devices = new Map<string, DmxUsbDevice>();
  /** Devices being stopped to be replaced on their port (another kind). */
  private readonly stopping = new Map<string, Promise<void>>();
  /** Sending (the output started, not on standby). */
  private active = false;
  readonly binding: SerialBinding | undefined;
  readonly error: string | undefined;

  constructor(binding?: SerialBinding | null, private readonly sleep?: (ms: number) => Promise<void>, private readonly platform = process.platform) {
    if (binding === null) this.error = "DMX USB désactivé";
    else if (binding) this.binding = binding;
    else ({ binding: this.binding, error: this.error } = loadSerial());
  }

  /** The interfaces wanted now (path → kind): new ones opened, the others let go. */
  use(wanted: { path: string; kind: DmxUsbKind }[]): void {
    // one name per port, and the first of two routes to the same one wins (the router sends that one only)
    const keep = new Map<string, DmxUsbKind>();
    for (const w of wanted) if (!keep.has(portPath(w.path, this.platform))) keep.set(portPath(w.path, this.platform), w.kind);
    for (const [path, d] of this.devices) {
      if (keep.get(path) !== d.kind) {
        this.stopping.set(path, d.stop()); // another kind on the same port: the new device opens it once this one has let go
        this.devices.delete(path);
      }
    }
    if (!this.binding) return;
    for (const [path, kind] of keep) {
      if (this.devices.has(path)) continue;
      const after = this.stopping.get(path);
      const d = new DmxUsbDevice(path, kind, this.binding, { ...(this.sleep ? { sleep: this.sleep } : {}), ...(after ? { after } : {}) });
      this.stopping.delete(path);
      this.devices.set(path, d);
      if (this.active) d.start();
    }
  }

  send(path: string, data: Uint8Array): void {
    this.devices.get(portPath(path, this.platform))?.frame(data);
  }

  /** Standby lets the interfaces go (QLC+ may open them); back, they are opened again. */
  setActive(on: boolean): void {
    this.active = on;
    for (const d of this.devices.values()) {
      if (on) d.start();
      else void d.stop(true);
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
