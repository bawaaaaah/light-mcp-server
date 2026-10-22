import { expect } from "chai";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";
import { dmxCandidates, DmxUsbDevice, encodeUsbPro, openDmxFrame } from "../../../src/plugins/light/output/dmx-usb.js";
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
    expect(serial.calls.slice(1, 4).map((c) => c.op + (c.on === undefined ? "" : c.on ? "+" : "-"))).to.deep.equal(["brk+", "brk-", "write"]);
    expect(serial.writes(PORT)[0]![3]).to.equal(128);
    expect(serial.calls.at(-1)!.op).to.equal("close");
  });

  it("USB Pro: a message when the universe changes, and every second", async () => {
    const serial = new FakeSerial();
    let now = 0;
    const d = new DmxUsbDevice(PORT, "pro", serial, fast, () => now);
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

  describe("in the output", function () {
    this.timeout(10_000);
    let plugin: LightPlugin;
    let serial: FakeSerial;
    const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());

    beforeEach(async () => {
      serial = new FakeSerial();
      const cfg = { discovery: false, output: { routes: [{ universe: 1, artnet: { portAddress: 0, targets: ["127.0.0.2"] } }] }, osc: { enabled: false }, os2l: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
      plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot: join(mkdtempSync(join(tmpdir(), "light-usb-")), "data"), midiNative: null, serial });
      await plugin.start();
    });
    afterEach(async () => {
      await plugin.stop();
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
