import { expect } from "chai";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";
import { autoBackupDue, autoBackupsOf, autoBackupsToPrune, autoBackupTime, historyToPrune } from "../../../src/plugins/light/data/retention.js";

describe("automatic backups and history retention", () => {
  it("finds a show's automatic backups only, newest first, with their time", () => {
    const files = ["default-2026-10-14_08-00-00-auto.lightshow", "default-2-2026-10-15_08-00-00-auto.lightshow", "default-2026-10-15_09-30-00-auto.lightshow", "default-2026-10-15_10-00-00-avant.lightshow", "default-2026-10-15_11-00-00-auto-manuel.lightshow"];
    expect(autoBackupsOf(files, "default")).to.deep.equal(["default-2026-10-15_09-30-00-auto.lightshow", "default-2026-10-14_08-00-00-auto.lightshow"]);
    expect(autoBackupTime("default-2026-10-15_09-30-00-auto.lightshow", "default")?.getHours()).to.equal(9);
    expect(autoBackupsToPrune(files, "default", 1)).to.deep.equal(["default-2026-10-14_08-00-00-auto.lightshow"]);
  });

  it("is due once a day, when the show changed, or when there is none yet", () => {
    const morning = new Date(2026, 9, 16, 9, 0);
    expect(autoBackupDue(morning, undefined, false)).to.equal(true);
    expect(autoBackupDue(morning, new Date(2026, 9, 16, 8, 0), true)).to.equal(false); // already today
    expect(autoBackupDue(morning, new Date(2026, 9, 15, 23, 0), false)).to.equal(false); // nothing changed
    expect(autoBackupDue(morning, new Date(2026, 9, 15, 23, 0), true)).to.equal(true);
  });

  it("prunes history only when both old and beyond the newest ones kept", () => {
    const now = new Date("2026-10-16T12:00:00Z");
    const stamps = ["2026-01-01T10-00-00-000Z-aaaaaa", "2026-02-01T10-00-00-000Z-bbbbbb", "2026-10-15T10-00-00-000Z-cccccc", "not-a-stamp"];
    expect(historyToPrune(stamps, now, 90, 1)).to.deep.equal(["2026-02-01T10-00-00-000Z-bbbbbb", "2026-01-01T10-00-00-000Z-aaaaaa"]);
    expect(historyToPrune(stamps, now, 90, 3)).to.deep.equal([]); // the 3 newest are kept, however old
    expect(historyToPrune(stamps, now, 365, 1)).to.deep.equal([]); // nothing older than a year
  });

  describe("on the server's data", () => {
    let plugin: LightPlugin;
    let dataRoot: string;
    const run = (name: string, args: unknown = {}) => plugin.commands.invoke(name, args, systemContext());
    const backups = () => readdirSync(join(dataRoot, "backups")).filter((f) => f.endsWith(".lightshow")).sort();

    beforeEach(async () => {
      dataRoot = join(mkdtempSync(join(tmpdir(), "light-auto-")), "data");
      mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
      copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(dataRoot, "fixtures", "bar4.qxf"));
      const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
      plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
      await run("import.qxw", { xml: readFileSync(new URL("../../fixtures/synthetic.qxw", import.meta.url), "utf8"), apply: true });
    });

    it("writes one a day when the show changed, keeps 14, never touches the others", async () => {
      const first = plugin.autoBackup(new Date(2026, 9, 1, 9, 0))!;
      expect(first).to.equal("default-2026-10-01_09-00-00-auto.lightshow");
      expect(plugin.autoBackup(new Date(2026, 9, 1, 10, 0))).to.equal(undefined); // same day
      expect(plugin.autoBackup(new Date(2026, 9, 2, 10, 0))).to.equal(undefined); // nothing changed
      await run("backup.create", { label: "auto" }); // by hand: kept whatever its label
      for (let day = 2; day <= 20; day++) {
        await run("group.level", { id: "master", level: day / 100 });
        plugin.autoBackup(new Date(2026, 9, day, 9, 0));
      }
      const autos = backups().filter((f) => f.endsWith("-auto.lightshow"));
      expect(autos).to.have.length(14);
      expect(autos[0]).to.equal("default-2026-10-07_09-00-00-auto.lightshow"); // the 14 newest: 7th to 20th
      expect(backups().some((f) => f.endsWith("-auto-manuel.lightshow"))).to.equal(true);
    });

    it("prunes object history older than 90 days beyond the 500 newest", () => {
      const dir = join(dataRoot, "backups", "shows", "default");
      mkdirSync(dir, { recursive: true });
      const old = Array.from({ length: 510 }, (_, i) => `2026-01-01T10-00-${String(i % 60).padStart(2, "0")}-${String(i).padStart(3, "0")}Z-${i.toString(16).padStart(6, "0")}`);
      for (const s of old) {
        mkdirSync(join(dir, s));
        writeFileSync(join(dir, s, "x.json"), "{}");
      }
      plugin.autoBackup(new Date(2026, 9, 16, 9, 0));
      const left = readdirSync(dir).filter((s) => s.startsWith("2026-01-01"));
      expect(left).to.have.length(500);
      expect(existsSync(join(dataRoot, "backups", "default-2026-10-16_09-00-00-auto.lightshow"))).to.equal(true);
    });
  });
});
