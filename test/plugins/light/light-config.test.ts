import { expect } from "chai";
import type { ScopedConfigStore } from "../../../src/core/config-store.js";
import { ConfigCell, LightConfigSchema } from "../../../src/plugins/light/light-config.js";

describe("ConfigCell (T55)", () => {
  const base = () => LightConfigSchema.parse({});

  it("a section reads the config put whole after it was opened", () => {
    const cell = new ConfigCell(base(), () => undefined);
    const midi = cell.section("midi");
    cell.put({ ...cell.get(), midi: { ...cell.get().midi, active: "scène" } });
    expect(midi.get().active).to.equal("scène");
  });

  it("a section put keeps the other sections", () => {
    const cell = new ConfigCell(base(), () => undefined);
    const before = cell.get();
    cell.section("ableset").put({ ...before.ableset, enabled: true, port: 40000 });
    const after = cell.get();
    expect(after.ableset).to.deep.equal({ ...before.ableset, enabled: true, port: 40000 });
    expect({ ...after, ableset: before.ableset }).to.deep.equal(before);
  });

  it("save writes the value of the moment", async () => {
    const saved: unknown[] = [];
    const store = { get: () => ({}), set: async (c: unknown) => void saved.push(c) } as unknown as ScopedConfigStore;
    const cell = new ConfigCell(base(), () => store);
    cell.put({ ...cell.get(), show: "premier" });
    cell.section("osc").put({ ...cell.get().osc, port: 9100 });
    await cell.save();
    expect(saved).to.have.length(1);
    expect(saved[0]).to.deep.equal(cell.get());
    expect(saved[0]).to.include({ show: "premier" });
    expect((saved[0] as { osc: { port: number } }).osc.port).to.equal(9100);
  });
});
