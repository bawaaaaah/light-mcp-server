import { expect } from "chai";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";
import { dmxCandidates, DmxUsbDevice, DmxUsbOutputs, encodeUsbPro, openDmxFrame, portPath } from "../../../src/plugins/light/output/dmx-usb.js";
import { FakeSerial } from "../../fakes/serial.js";

const PORT = "/dev/cu.usbserial-TEST1";
const until = async (ok: () => boolean, tries = 200) => {
  for (let i = 0; i < tries && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(ok()).to.equal(true);
};
const fast = () => new Promise<void>((r) => setImmediate(r));

describe("DMX USB", () => {
  it("frames a universe for both kinds of interface", () => {
    const data = new Uint8Array(512);
    data[0] = 255;
    data[511] = 7;
    const pro = encodeUsbPro(data);
    expect([...pro.subarray(0, 6)]).to.deep.equal([0x7e, 6, 0x01, 0x02, 0, 255]); // label 6, 513 bytes: the start code and 512 channels
    expect(pro.length).to.equal(518);
    expect([...pro.subarray(-2)]).to.deep.equal([7, 0xe7]);
    expect([...openDmxFrame(data).subarray(0, 2)]).to.deep.equal([0, 255]);
    expect(openDmxFrame(data).length).to.equal(513);
  });

  it("lists the ports an interface may be on, FTDI chips first, as the Mac opens them", () => {
    const ports = dmxCandidates(
      [
        { path: "/dev/tty.Bluetooth-Incoming-Port" },
        { path: "/dev/tty.VirtualAudioPort" }, // an app's, not a device
        { path: "/dev/tty.usbmodem1" },
        { path: "/dev/tty.usbserial-TEST1", vendorId: "0403", productId: "6001" },
      ],
      "darwin",
    );
    expect(ports.map((p) => [p.path, p.ftdi])).to.deep.equal([
      [PORT, true],
      ["/dev/cu.usbmodem1", false],
    ]);
    expect(dmxCandidates([{ path: "/dev/ttyUSB0", vendorId: "0403" }], "linux")[0]!.path).to.equal("/dev/ttyUSB0");
  });

  it("Open DMX: makes the signal itself, a break before every frame, again and again", async () => {
    const serial = new FakeSerial();
    const d = new DmxUsbDevice(PORT, "open", serial, fast);
    const data = new Uint8Array(512);
    data[2] = 128;
    d.frame(data);
    d.start();
    await until(() => serial.writes(PORT).length >= 3);
    await d.stop();
    expect(serial.calls[0]).to.deep.include({ op: "open", baudRate: 250_000, stopBits: 2 });
    expect(serial.calls.filter((c) => c.op !== "line").slice(1, 4).map((c) => c.op + (c.on === undefined ? "" : c.on ? "+" : "-"))).to.deep.equal(["brk+", "brk-", "write"]);
    expect(serial.writes(PORT)[0]![3]).to.equal(128);
    expect(serial.calls.at(-1)!.op).to.equal("close");
  });

  it("USB Pro: a message when the universe changes, and every second", async () => {
    const serial = new FakeSerial();
    let now = 0;
    const d = new DmxUsbDevice(PORT, "pro", serial, fast, () => now);
    d.frame(new Uint8Array(512)); // nothing goes out before a real frame has come in
    d.start();
    await until(() => serial.writes(PORT).length === 1);
    for (let i = 0; i < 20; i++) await fast();
    expect(serial.writes(PORT)).to.have.length(1); // nothing changed: the interface repeats the frame by itself
    const data = new Uint8Array(512);
    data[0] = 9;
    d.frame(data);
    await until(() => serial.writes(PORT).length === 2);
    expect(serial.writes(PORT)[1]![5]).to.equal(9);
    now = 1500;
    await until(() => serial.writes(PORT).length === 3);
    await d.stop();
    expect(serial.calls.filter((c) => c.op === "brk")).to.deep.equal([]);
  });

  it("unplugged, says why and opens the interface again when it comes back", async () => {
    const serial = new FakeSerial();
    const d = new DmxUsbDevice(PORT, "open", serial, fast);
    d.frame(new Uint8Array(512));
    d.start();
    await until(() => d.status().open);
    serial.unplugged.add(PORT);
    await until(() => !d.status().open && d.status().error !== undefined);
    expect(d.status().error).to.match(/not configured|no such device/);
    serial.unplugged.delete(PORT);
    await until(() => d.status().open && d.status().error === undefined);
    const writes = serial.writes(PORT).length;
    await until(() => serial.writes(PORT).length > writes);
    await d.stop();
  });

  describe("a steady signal, and what is left when it is not", () => {
    const quiet = () => undefined;
    const zeros = () => new Uint8Array(512);

    it("names a port once: the Mac's tty and cu paths are one device, with two routes to it the first wins", () => {
      expect(portPath("/dev/tty.usbserial-TEST1", "darwin")).to.equal(PORT);
      expect(portPath(PORT, "darwin")).to.equal(PORT);
      expect(portPath("/dev/ttyUSB0", "linux")).to.equal("/dev/ttyUSB0");
      const outputs = new DmxUsbOutputs(new FakeSerial(), fast, "darwin"); // the platform is given: this holds on Linux too
      outputs.use([
        { path: "/dev/tty.usbserial-TEST1", kind: "open" },
        { path: PORT, kind: "pro" },
      ]);
      expect(outputs.status().map((d) => [d.path, d.kind])).to.deep.equal([[PORT, "open"]]);
    });

    it("sends nothing before a real frame has come in, and after a stop starts again from a real one, never from the old buffer", async () => {
      const serial = new FakeSerial();
      const d = new DmxUsbDevice(PORT, "open", serial, fast, undefined, quiet);
      d.start();
      await until(() => d.status().open);
      for (let i = 0; i < 20; i++) await fast();
      expect(serial.writes(PORT)).to.have.length(0); // only zeros so far: not worth a flash of black
      const lit = zeros();
      lit[0] = 200;
      d.frame(lit);
      await until(() => serial.writes(PORT).length >= 2);
      await d.stop();
      const written = serial.writes(PORT).length;
      d.start();
      for (let i = 0; i < 20; i++) await fast();
      expect(serial.writes(PORT)).to.have.length(written); // the old frame is not sent again
      const other = zeros();
      other[0] = 77;
      d.frame(other);
      await until(() => serial.writes(PORT).length > written);
      expect(serial.writes(PORT).at(-1)![1]).to.equal(77);
      await d.stop();
    });

    it("on standby sends one last all-zero frame, then lets the line go", async () => {
      const serial = new FakeSerial();
      const d = new DmxUsbDevice(PORT, "open", serial, fast, undefined, quiet);
      const lit = zeros();
      lit[0] = 200;
      d.frame(lit);
      d.start();
      await until(() => serial.writes(PORT).length >= 2);
      await d.stop(true);
      expect(serial.writes(PORT).at(-1)![1]).to.equal(0); // the last thing on the line is black
      expect(serial.calls.at(-1)!.op).to.equal("close");
    });

    it("opens the interface again soon, then less and less often, and keeps the last error after it is back", async () => {
      const serial = new FakeSerial();
      serial.unplugged.add(PORT);
      const waits: number[] = [];
      let t = 0;
      const d = new DmxUsbDevice(PORT, "open", serial, async (ms) => void (waits.push(ms), (t += ms), await fast()), () => t, quiet, undefined, () => 5000); // the time of day comes from the wall clock
      d.frame(zeros());
      d.start();
      await until(() => waits.filter((w) => w >= 250).length >= 6);
      expect(waits.filter((w) => w >= 250).slice(0, 6)).to.deep.equal([250, 500, 1000, 2000, 2000, 2000]);
      serial.unplugged.delete(PORT);
      await until(() => d.status().open);
      expect(d.status().error).to.equal(undefined);
      expect(d.status().lastError).to.match(/no such device/);
      expect(d.status().lastErrorAt).to.equal(5000);
      await d.stop();
    });

    it("a hiccup on the line does not cut it for two seconds: closed, opened again at the first delay, counted", async () => {
      const serial = new FakeSerial();
      const waits: number[] = [];
      const d = new DmxUsbDevice(PORT, "open", serial, async (ms) => void (waits.push(ms), await fast()), undefined, quiet);
      d.frame(zeros());
      d.start();
      await until(() => serial.writes(PORT).length >= 2);
      serial.fail = { op: "write", times: 1 };
      await until(() => d.status().reopens === 1);
      const writes = serial.writes(PORT).length;
      await until(() => serial.writes(PORT).length > writes);
      expect(waits).to.include(250);
      expect(waits).to.not.include(2000);
      expect(d.status().lastError).to.match(/input\/output error/);
      expect(d.status().error).to.equal(undefined);
      await d.stop();
    });

    it("tells the log about an error once in a while, not on every try", async () => {
      const serial = new FakeSerial();
      serial.unplugged.add(PORT);
      const lines: string[] = [];
      let t = 0;
      const d = new DmxUsbDevice(PORT, "open", serial, async () => void (t < 70_000 && (t += 1000), await fast()), () => t, (m) => lines.push(m)); // the clock stops at 70 s
      d.frame(zeros());
      d.start();
      await until(() => t >= 70_000);
      await d.stop();
      expect(lines.length).to.be.within(2, 4); // at 0, 30 and 60 s of the same message
      expect(lines[0]).to.match(/DMX USB .*usbserial-TEST1.*no such device/);
    });

    it("keeps the break from cutting a frame that drain() said was out too early", async () => {
      const serial = new FakeSerial();
      let t = 0;
      serial.before = (op) => void (op === "set" && (t += 2)); // a break signal takes 2 ms to reach the line
      const waits: number[] = [];
      const d = new DmxUsbDevice(PORT, "open", serial, async (ms) => void (waits.push(ms), (t += ms), await fast()), () => t, quiet);
      d.frame(zeros());
      d.start();
      await until(() => d.status().framesSent >= 1);
      await d.stop();
      // the frame starts 6 ms after the loop began (2 + the 2 ms break + 2) and takes 22.6 ms: the next break not before
      // 22.6 + 8 ms after the write began (8 ms of margin), more than the 33 ms period alone, although drain() returned at once
      const wait = waits.find((w) => w > 20)!;
      expect(wait).to.be.closeTo(22.572 + 8, 0.01);
      expect(d.status().drainMs).to.equal(0);
      expect(d.status().breakMs).to.be.at.least(2 + 1 + 2); // both calls to set() and the break itself
    });

    it("sets DTR and RTS low as soon as the port is open, not at the first break: the OS raises them at open", async () => {
      const serial = new FakeSerial();
      const d = new DmxUsbDevice(PORT, "open", serial, fast, undefined, quiet);
      d.start();
      await until(() => d.status().open);
      await d.stop();
      const line = serial.calls.find((c) => c.op === "line")!;
      expect([line.dtr, line.rts]).to.deep.equal([false, false]);
    });

    it("on standby the last frame, all zeros, is written before the port is closed, and nothing after the close", async () => {
      const serial = new FakeSerial(); // refuses anything after close(), as the real binding does
      const d = new DmxUsbDevice(PORT, "open", serial, fast, undefined, quiet);
      const lit = zeros();
      lit[0] = 200;
      d.frame(lit);
      d.start();
      await until(() => serial.writes(PORT).length >= 2);
      await d.stop(true);
      const ops = serial.calls.filter((c) => c.op !== "line").map((c) => c.op + (c.on === undefined ? "" : c.on ? "+" : "-"));
      expect(ops.slice(-5)).to.deep.equal(["brk+", "brk-", "write", "drain", "close"]); // the break is let go before the close
      expect(serial.writes(PORT).at(-1)![1]).to.equal(0);
      expect(d.status().lastError).to.equal(undefined); // and no write was refused
    });

    it("a stop that is followed at once by a start does not open the port while the old loop still holds it", async () => {
      const serial = new FakeSerial(); // an open that finds the port held fails, as flock does
      const d = new DmxUsbDevice(PORT, "open", serial, fast, undefined, quiet);
      const lit = zeros();
      lit[0] = 200;
      d.frame(lit);
      d.start();
      await until(() => serial.writes(PORT).length >= 2);
      const stopping = d.stop(true);
      d.start();
      d.frame(lit);
      await stopping;
      await until(() => d.status().open && serial.calls.filter((c) => c.op === "open").length === 2);
      expect(d.status().lastError).to.equal(undefined);
      expect(d.status().reopens).to.equal(0);
      const before = serial.writes(PORT).length;
      await until(() => serial.writes(PORT).length > before);
      await d.stop();
    });

    it("a driver that hangs does not hold a stop, and the port is closed", async () => {
      const serial = new FakeSerial();
      const d = new DmxUsbDevice(PORT, "open", serial, fast, undefined, quiet);
      d.frame(zeros());
      d.start();
      await until(() => serial.writes(PORT).length >= 2);
      serial.hang = "drain";
      for (let i = 0; i < 10; i++) await fast(); // the next frame hangs in drain()
      await d.stop(true);
      expect(serial.calls.at(-1)!.op).to.equal("close");
    }).timeout(5000);

    it("counts the longest gap since the interface was opened, not since the object was made", async () => {
      const serial = new FakeSerial();
      let t = 0;
      const d = new DmxUsbDevice(PORT, "open", serial, async (ms) => void ((t += ms), await fast()), () => t, quiet);
      d.frame(zeros());
      d.start();
      await until(() => d.status().framesSent >= 3);
      serial.fail = { op: "write", times: 1 };
      t += 60_000; // a long hiccup: the gap across it is not between two frames
      await until(() => d.status().reopens === 1);
      const frames = d.status().framesSent;
      await until(() => d.status().framesSent >= frames + 3);
      await d.stop();
      expect(d.status().maxGapMs).to.be.lessThan(100);
    });

    it("after a driver that hung and a stop, a new start sends again once the old loop is given up on", async () => {
      const serial = new FakeSerial();
      const d = new DmxUsbDevice(PORT, "open", serial, fast, undefined, quiet);
      d.frame(zeros());
      d.start();
      await until(() => serial.writes(PORT).length >= 2);
      serial.hang = "drain";
      for (let i = 0; i < 10; i++) await fast();
      await d.stop(true); // the port is closed here, the old loop stays stuck in drain()
      serial.hang = undefined;
      d.start();
      d.frame(zeros());
      const written = serial.writes(PORT).length;
      await until(() => serial.writes(PORT).length > written + 2, 600); // after the 2 s the start waits for the old loop at most
      expect(d.status().open).to.equal(true);
      await d.stop();
    }).timeout(10_000);

    it("a second stop before the loop has ended does not cancel the last all-zero frame of the first", async () => {
      const serial = new FakeSerial();
      const d = new DmxUsbDevice(PORT, "open", serial, fast, undefined, quiet);
      const lit = zeros();
      lit[0] = 200;
      d.frame(lit);
      d.start();
      await until(() => serial.writes(PORT).length >= 2);
      const first = d.stop(true);
      const second = d.stop();
      await Promise.all([first, second]);
      expect(serial.writes(PORT).at(-1)![1]).to.equal(0);
    });

    it("a standby before any frame writes nothing at all", async () => {
      const serial = new FakeSerial();
      const d = new DmxUsbDevice(PORT, "open", serial, fast, undefined, quiet);
      d.start();
      await until(() => d.status().open);
      await d.stop(true);
      expect(serial.writes(PORT)).to.have.length(0);
    });

    it("waits for the last frame to leave the line before closing, and drains a Pro interface", async () => {
      const open = new FakeSerial();
      let t = 0;
      const waits: number[] = [];
      open.before = (op) => void (op === "set" && (t += 2));
      const d = new DmxUsbDevice(PORT, "open", open, async (ms) => void (waits.push(ms), (t += ms), await fast()), () => t, quiet);
      d.frame(zeros());
      d.start();
      await until(() => d.status().framesSent >= 2);
      waits.length = 0;
      await d.stop(true);
      expect(waits.some((w) => w > 20)).to.equal(true); // the 22.6 ms of the frame, not an instant
      const pro = new FakeSerial();
      const p = new DmxUsbDevice(PORT, "pro", pro, fast, undefined, quiet);
      const lit = zeros();
      lit[0] = 9;
      p.frame(lit);
      p.start();
      await until(() => pro.writes(PORT).length >= 1);
      await p.stop(true);
      expect(pro.calls.filter((c) => c.op !== "open").slice(-3).map((c) => c.op)).to.deep.equal(["write", "drain", "close"]);
      expect(pro.writes(PORT).at(-1)![5]).to.equal(0);
    });

    it("a stop while the port is still opening leaves it closed and sends nothing", async () => {
      const serial = new FakeSerial();
      let opened!: () => void;
      serial.slowOpen = new Promise<void>((r) => (opened = r));
      const d = new DmxUsbDevice(PORT, "open", serial, fast, undefined, quiet);
      d.frame(zeros());
      d.start();
      for (let i = 0; i < 5; i++) await fast();
      const stopping = d.stop(true);
      opened();
      await stopping;
      await until(() => serial.calls.some((c) => c.op === "close"));
      expect(serial.writes(PORT)).to.have.length(0);
      expect(d.status().open).to.equal(false);
    });

    it("changing the kind of an interface opens it again only after the old device has let go", async () => {
      const serial = new FakeSerial();
      const outputs = new DmxUsbOutputs(serial, undefined, "darwin");
      outputs.setActive(true);
      outputs.use([{ path: PORT, kind: "open" }]);
      const lit = zeros();
      lit[0] = 1;
      outputs.send(PORT, lit);
      await until(() => serial.writes(PORT).length >= 2);
      outputs.use([{ path: PORT, kind: "pro" }]);
      outputs.send(PORT, lit);
      await until(() => outputs.status()[0]!.open && outputs.status()[0]!.framesSent >= 1);
      expect(outputs.status()[0]).to.deep.include({ kind: "pro" });
      expect(outputs.status()[0]!.lastError).to.equal(undefined); // no « Cannot lock port »
      await outputs.stop();
    }).timeout(8000);

    it("an old config with two routes to one port can still be edited, unless the interface is the one given", async () => {
      const serial = new FakeSerial();
      const cfg = { discovery: false, output: { bindAddress: "127.0.0.1", artnetPort: 16454, routes: [] }, osc: { enabled: false }, os2l: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
      const plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot: join(mkdtempSync(join(tmpdir(), "light-usb-")), "data"), midiNative: null, serial });
      await plugin.start();
      try {
        const run = (name: string, args: unknown) => plugin.commands.invoke(name, args, systemContext());
        plugin.router.setRoutes([
          { universe: 1, usb: { path: PORT, kind: "open" } },
          { universe: 2, usb: { path: PORT, kind: "open" } },
        ]);
        await run("output.route", { universe: 2, artnet: { portAddress: 1, targets: ["127.0.0.2"] } }); // Art-Net alone: fine
        await run("output.route", { universe: 3, usb: { path: PORT } }).then(
          () => expect.fail("the port is taken"),
          (e: Error) => expect(e.message).to.match(/sort déjà l'univers|already outputs universe/),
        );
      } finally {
        await plugin.stop();
      }
    });

    it("a refused DTR/RTS at open leaves the interface open, and leaves a trace", async () => {
      const serial = new FakeSerial();
      serial.fail = { op: "set", times: 1, message: "set refused" };
      const d = new DmxUsbDevice(PORT, "open", serial, fast, undefined, quiet);
      d.frame(zeros());
      d.start();
      await until(() => d.status().framesSent >= 2);
      expect(d.status().open).to.equal(true);
      expect(d.status().error).to.equal(undefined);
      expect(d.status().lastError).to.equal("set refused");
      await d.stop();
    });

    it("a route given with the Mac's tty name is kept under its cu name", async () => {
      const serial = new FakeSerial();
      const cfg = { discovery: false, output: { bindAddress: "127.0.0.1", artnetPort: 16454, routes: [] }, osc: { enabled: false }, os2l: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
      const plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot: join(mkdtempSync(join(tmpdir(), "light-usb-")), "data"), midiNative: null, serial });
      await plugin.start();
      try {
        await plugin.commands.invoke("output.route", { universe: 2, usb: { path: "/dev/tty.usbserial-TEST1" } }, systemContext());
        expect(plugin.router.getConfig().routes[0]!.usb!.path).to.equal(portPath("/dev/tty.usbserial-TEST1"));
      } finally {
        await plugin.stop();
      }
    });

    it("names DTR and RTS with every break, at 0 as they have always been left", async () => {
      const serial = new FakeSerial();
      const d = new DmxUsbDevice(PORT, "open", serial, fast, undefined, quiet);
      d.frame(zeros());
      d.start();
      await until(() => serial.calls.filter((c) => c.op === "brk").length >= 4);
      await d.stop();
      for (const c of serial.calls.filter((x) => x.op === "brk")) expect([c.dtr, c.rts]).to.deep.equal([false, false]);
    });

    /** The time of every call on the port (set, write, drain), next to what it was, from a clock the test moves. */
    const timed = (serial: FakeSerial, clock: () => number) => {
      const at: number[] = [];
      serial.before = () => void at.push(clock());
      return () => {
        const ops = serial.calls.filter((c) => c.op !== "open" && c.op !== "close");
        return ops.map((c, i) => ({ op: c.op === "brk" ? (c.on ? "brk+" : "brk-") : c.op, t: at[i]! }));
      };
    };
    /** Per frame: when its break began and ended, when its write began. */
    const frameTimes = (calls: { op: string; t: number }[]) => {
      const out: { brk: number; brkOff: number; write: number }[] = [];
      for (let i = 0; i + 2 < calls.length; i++) {
        if (calls[i]!.op === "brk+" && calls[i + 1]!.op === "brk-" && calls[i + 2]!.op === "write") out.push({ brk: calls[i]!.t, brkOff: calls[i + 1]!.t, write: calls[i + 2]!.t });
      }
      return out;
    };
    const FRAME = (513 * 11) / 250; // ms on the line

    it("Open DMX at about 30 frames a second, with 8 ms between the end of a frame and the next break", async () => {
      const serial = new FakeSerial();
      let t = 0;
      const calls = timed(serial, () => t);
      const inner = serial.before!;
      serial.before = (op) => (inner(op), void (t += 0.3)); // every call on the driver takes a little time
      const d = new DmxUsbDevice(PORT, "open", serial, async (ms) => void ((t += ms), await fast()), () => t, quiet);
      d.frame(zeros());
      d.start();
      await until(() => d.status().framesSent >= 31);
      await d.stop();
      const f = frameTimes(calls()).slice(0, 31);
      const rate = (1000 * (f.length - 1)) / (f.at(-1)!.brk - f[0]!.brk);
      expect(rate).to.be.within(29, 30.5);
      for (let i = 1; i < f.length; i++) {
        expect(f[i]!.brk - f[i - 1]!.brk).to.be.at.least(33 - 1e-9);
        expect(f[i]!.brk - (f[i - 1]!.write + FRAME)).to.be.at.least(8 - 1e-9);
      }
      for (const x of f) expect(x.brkOff - x.brk).to.be.at.least(2 - 1e-9);
    });

    it("a drain() that comes back late still leaves the whole guard before the next break", async () => {
      const serial = new FakeSerial();
      let t = 0;
      const calls = timed(serial, () => t);
      const inner = serial.before!;
      serial.before = (op) => (inner(op), void (op === "drain" && (t += 40))); // the driver holds drain() for 40 ms, past the frame's end
      const d = new DmxUsbDevice(PORT, "open", serial, async (ms) => void ((t += ms), await fast()), () => t, quiet);
      d.frame(zeros());
      d.start();
      await until(() => d.status().framesSent >= 3);
      await d.stop();
      const all = calls();
      const drained = all.filter((c) => c.op === "drain").map((c) => c.t + 40);
      const breaks = frameTimes(all).map((x) => x.brk);
      expect(breaks.length).to.be.at.least(3);
      for (let i = 1; i < breaks.length; i++) expect(breaks[i]! - drained[i - 1]!).to.be.at.least(8 - 1e-9);
    });

    it("a timer that fires early cuts short neither the break nor the guard: the clock is read again on waking", async () => {
      const serial = new FakeSerial();
      let t = 0;
      const calls = timed(serial, () => t);
      const asked: number[] = [];
      // every timer fires 1 ms early (as Node's may, counting from the start of the loop's turn), down to half its time
      const early = async (ms: number) => void (asked.push(ms), (t += Math.max(ms / 2, ms - 1)), await fast());
      const d = new DmxUsbDevice(PORT, "open", serial, early, () => t, quiet);
      d.frame(zeros());
      d.start();
      await until(() => d.status().framesSent >= 5);
      await d.stop();
      const f = frameTimes(calls());
      expect(f.length).to.be.at.least(5);
      for (const x of f) expect(x.brkOff - x.brk).to.be.at.least(2 - 1e-9);
      for (let i = 1; i < f.length; i++) expect(f[i]!.brk - (f[i - 1]!.write + FRAME)).to.be.at.least(8 - 1e-9);
      expect(asked.length).to.be.greaterThan(2 * f.length); // it did go back to sleep
    });

    it("setting the system clock forward or back moves neither a break nor the guard (the rhythm is on a monotonic clock)", async () => {
      const serial = new FakeSerial();
      const calls = timed(serial, () => performance.now());
      const realNow = Date.now;
      const d = new DmxUsbDevice(PORT, "open", serial, fast, undefined, quiet); // the real clocks, as in the server
      try {
        d.frame(zeros());
        d.start();
        await until(() => d.status().framesSent >= 2);
        Date.now = () => realNow() + 3_600_000; // an hour forward
        await until(() => d.status().framesSent >= 4);
        Date.now = () => realNow() - 3_600_000; // and back
        await until(() => d.status().framesSent >= 6);
      } finally {
        Date.now = realNow;
        await d.stop();
      }
      const f = frameTimes(calls());
      expect(f.length).to.be.at.least(6);
      for (let i = 1; i < f.length; i++) {
        // no break early (a late one is the machine's business, not the clock's: no upper bound on a real clock)
        expect(f[i]!.brk - f[i - 1]!.brk).to.be.at.least(33 - 0.05);
        expect(f[i]!.brk - (f[i - 1]!.write + FRAME)).to.be.at.least(8 - 0.05);
      }
    });

    it("measures the longest gap between two frames", async () => {
      const serial = new FakeSerial();
      let t = 0;
      const d = new DmxUsbDevice(PORT, "open", serial, async (ms) => void ((t += ms), await fast()), () => t, quiet);
      d.frame(zeros());
      d.start();
      await until(() => d.status().framesSent >= 5);
      await d.stop();
      expect(d.status().maxGapMs).to.be.within(33, 36);
    });
  });

  describe("in the output", function () {
    this.timeout(10_000);
    let plugin: LightPlugin;
    let serial: FakeSerial;
    const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());

    beforeEach(async () => {
      serial = new FakeSerial();
      const cfg = { discovery: false, output: { bindAddress: "127.0.0.1", artnetPort: 16454, routes: [{ universe: 1, artnet: { portAddress: 0, targets: ["127.0.0.2"] } }] }, osc: { enabled: false }, os2l: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
      plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot: join(mkdtempSync(join(tmpdir(), "light-usb-")), "data"), midiNative: null, serial });
      await plugin.start();
    });
    afterEach(async () => {
      await plugin.stop();
    });

    it("sends a port named by two routes once, the first one's universe, not the two in turn", async () => {
      const path = ((await run("output.usb.list")) as { ports: { path: string }[] }).ports[0]!.path;
      plugin.router.setRoutes([
        { universe: 1, usb: { path: "/dev/tty.usbserial-TEST1", kind: "open" } },
        { universe: 2, usb: { path, kind: "open" } },
      ]);
      const first = new Uint8Array(512).fill(11);
      const second = new Uint8Array(512).fill(22);
      for (let i = 0; i < 40; i++) plugin.router.sendFrame([first, second], Date.now() + i, true);
      await until(() => serial.writes(path).length >= 3);
      const seen = new Set(serial.writes(path).map((w) => w[1]));
      expect(seen.has(11)).to.equal(true);
      expect(seen.has(22)).to.equal(false); // the second route's universe never reaches the interface (the engine's own frames are zeros)
    });

    it("routes a universe to an interface, alone or with Art-Net, one universe per interface", async () => {
      const { ports } = (await run("output.usb.list")) as { ports: { path: string; ftdi: boolean }[] };
      expect(ports[0]).to.deep.include({ ftdi: true });
      const path = ports[0]!.path;
      await run("output.route", { universe: 2, usb: { path } }); // alone: Open DMX by default
      await run("output.route", { universe: 1, usb: null });
      await run("dmx.set", { universe: 2, channel: 1, value: 200 });
      await until(() => serial.writes(path).some((w) => w[1] === 200));
      const status = (await run("output.status")) as { config: { routes: unknown[] }; usb: { available: boolean; devices: { path: string; open: boolean }[] } };
      expect(status.config.routes).to.deep.equal([{ universe: 1, artnet: { portAddress: 0, targets: ["127.0.0.2"] } }, { universe: 2, usb: { path, kind: "open" } }]);
      expect(status.usb.available).to.equal(true);
      expect(status.usb.devices[0]).to.deep.include({ path, open: true });
      await run("output.route", { universe: 1, usb: { path, kind: "pro" } }).then(
        () => expect.fail("one interface, one universe"),
        (e: Error) => expect(e.message).to.match(/sort déjà l'univers 2/),
      );
      // standby lets the interface go (QLC+ may open it), taking over opens it again
      await run("output.standby", { on: true });
      await until(() => serial.calls.at(-1)!.op === "close");
      const opened = serial.calls.filter((c) => c.op === "open").length;
      await run("output.standby", { on: false });
      await until(() => serial.calls.filter((c) => c.op === "open").length === opened + 1);
      // removed: the interface is let go, the universe no longer sent
      await run("output.route", { universe: 2, usb: null });
      await until(() => serial.calls.at(-1)!.op === "close" && ((plugin.router.getConfig().routes.length as number) === 1));
    });
  });
});
