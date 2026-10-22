import type { SerialBinding, SerialPortHandle, SerialPortInfo } from "../../src/plugins/light/output/dmx-usb.js";

/** Serial ports without hardware: what is opened, written and signalled, and an unplug. */
export class FakeSerial implements SerialBinding {
  readonly calls: { path: string; op: "open" | "brk" | "write" | "close"; bytes?: Buffer; on?: boolean; baudRate?: number; stopBits?: number }[] = [];
  /** Paths whose interface is unplugged: opening fails, an open port fails its next write. */
  readonly unplugged = new Set<string>();

  constructor(readonly ports: SerialPortInfo[] = [{ path: "/dev/tty.usbserial-TEST1", manufacturer: "FTDI", vendorId: "0403", productId: "6001", serialNumber: "TEST1" }]) {}

  async list(): Promise<SerialPortInfo[]> {
    return this.ports;
  }

  async open(o: { path: string; baudRate: number; stopBits: 1 | 2 }): Promise<SerialPortHandle> {
    if (this.unplugged.has(o.path)) throw new Error(`${o.path}: no such device`);
    this.calls.push({ path: o.path, op: "open", baudRate: o.baudRate, stopBits: o.stopBits });
    const check = () => {
      if (this.unplugged.has(o.path)) throw new Error(`${o.path}: device not configured`);
    };
    return {
      write: async (bytes) => (check(), void this.calls.push({ path: o.path, op: "write", bytes })),
      drain: async () => check(),
      set: async ({ brk }) => (check(), void (brk !== undefined && this.calls.push({ path: o.path, op: "brk", on: brk }))),
      close: async () => void this.calls.push({ path: o.path, op: "close" }),
    };
  }

  writes(path: string): Buffer[] {
    return this.calls.filter((c) => c.path === path && c.op === "write").map((c) => c.bytes!);
  }
}
