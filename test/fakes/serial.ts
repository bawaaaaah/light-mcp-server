import type { SerialBinding, SerialPortHandle, SerialPortInfo } from "../../src/plugins/light/output/dmx-usb.js";

type Op = "open" | "brk" | "line" | "write" | "drain" | "close";

/** Serial ports without hardware: what is opened, written and signalled, an unplug, and failures made on purpose. */
export class FakeSerial implements SerialBinding {
  readonly calls: { path: string; op: Op; bytes?: Buffer; on?: boolean; dtr?: boolean; rts?: boolean; baudRate?: number; stopBits?: number }[] = [];
  /** Paths whose interface is unplugged: opening fails, an open port fails its next write. */
  readonly unplugged = new Set<string>();
  /** The next `times` calls of `op` on any port fail, then it works again (a hiccup, not an unplug). */
  fail: { op: "set" | "write" | "drain"; times: number; message?: string } | undefined;
  /** Called before each call on a port: a test moves its clock here (a break takes time on a real line). */
  before: ((op: "set" | "write" | "drain") => void) | undefined;
  /** `op` never comes back on any port (a driver that hangs). */
  hang: "set" | "write" | "drain" | undefined;
  /** An open that waits for this to settle (a port that is slow to open). */
  slowOpen: Promise<void> | undefined;
  /** Paths held open now: a port is held by one opener at a time (flock), and an open that finds it held fails. */
  private readonly held = new Set<string>();

  constructor(readonly ports: SerialPortInfo[] = [{ path: "/dev/tty.usbserial-TEST1", manufacturer: "FTDI", vendorId: "0403", productId: "6001", serialNumber: "TEST1" }]) {}

  async list(): Promise<SerialPortInfo[]> {
    return this.ports;
  }

  async open(o: { path: string; baudRate: number; stopBits: 1 | 2 }): Promise<SerialPortHandle> {
    if (this.unplugged.has(o.path)) throw new Error(`${o.path}: no such device`);
    if (this.held.has(o.path)) throw new Error(`${o.path}: Cannot lock port`);
    this.held.add(o.path);
    await this.slowOpen;
    this.calls.push({ path: o.path, op: "open", baudRate: o.baudRate, stopBits: o.stopBits });
    let closed = false;
    const check = (op: "set" | "write" | "drain") => {
      if (closed) throw new Error("Port is not open"); // as the real binding refuses anything after close()
      this.before?.(op);
      if (this.unplugged.has(o.path)) throw new Error(`${o.path}: device not configured`);
      if (this.fail && this.fail.op === op && this.fail.times > 0) {
        this.fail.times--;
        throw new Error(this.fail.message ?? `${o.path}: input/output error`);
      }
    };
    const stuck = (op: "set" | "write" | "drain") => (this.hang === op ? new Promise<void>(() => undefined) : undefined);
    return {
      write: async (bytes) => (check("write"), await stuck("write"), void this.calls.push({ path: o.path, op: "write", bytes })),
      drain: async () => (check("drain"), await stuck("drain"), void this.calls.push({ path: o.path, op: "drain" })),
      set: async ({ brk, dtr, rts }) => (check("set"), await stuck("set"), void this.calls.push({ path: o.path, op: brk === undefined ? "line" : "brk", on: brk, dtr, rts })),
      close: async () => {
        closed = true;
        this.held.delete(o.path);
        this.calls.push({ path: o.path, op: "close" });
      },
    };
  }

  writes(path: string): Buffer[] {
    return this.calls.filter((c) => c.path === path && c.op === "write").map((c) => c.bytes!);
  }
}
