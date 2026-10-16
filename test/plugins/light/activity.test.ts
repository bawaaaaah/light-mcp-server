import { expect } from "chai";
import { ActivityLog, ACTIVITY_MAX, targetOf } from "../../../src/plugins/light/activity.js";
import type { CommandEvent } from "../../../src/plugins/light/commands/registry.js";
import { AuthService } from "../../../src/core/auth.js";

const event = (at: number, name: string, args: unknown, who?: string, origin: CommandEvent["origin"] = "ui"): CommandEvent => ({ name, origin, args, ok: true, at, ...(who ? { who } : {}) });

describe("activity log", () => {
  it("names the object a command acts on", () => {
    expect(targetOf({ id: "hole" })).to.equal("hole");
    expect(targetOf({ look: { id: "warm", name: "Chaud" } })).to.equal("warm");
    expect(targetOf({ on: true })).to.equal(undefined);
    expect(targetOf(undefined)).to.equal(undefined);
  });

  it("merges a burst on one object into one line, even interleaved with another, and keeps the rest apart", () => {
    const log = new ActivityLog();
    log.record(event(0, "group.level", { id: "a", level: 0.1 }, "Régie"), "Niveau de groupe");
    log.record(event(100, "group.level", { id: "b", level: 0.1 }, "Régie"), "Niveau de groupe");
    log.record(event(200, "group.level", { id: "a", level: 0.2 }, "Régie"), "Niveau de groupe");
    log.record(event(300, "group.level", { id: "b", level: 0.3 }, "Régie"), "Niveau de groupe");
    log.record(event(400, "group.level", { id: "a", level: 0.4 }, "Bénévole"), "Niveau de groupe"); // someone else
    log.record(event(5000, "group.level", { id: "a", level: 0.5 }, "Régie"), "Niveau de groupe"); // later: a new line
    const lines = log.list();
    expect(lines.map((l) => [l.target, l.who, l.count])).to.deep.equal([
      ["a", "Régie", 1],
      ["a", "Bénévole", 1],
      ["b", "Régie", 2],
      ["a", "Régie", 2],
    ]);
    expect(lines[3]).to.deep.include({ at: 0, until: 200, title: "Niveau de groupe", origin: "ui" });
  });

  it("keeps the newest lines only", () => {
    const log = new ActivityLog();
    for (let i = 0; i < ACTIVITY_MAX + 20; i++) log.record(event(i * 10_000, "look.go", { id: `l${i}` }), "Lancer un look");
    expect(log.list(1000)).to.have.length(ACTIVITY_MAX);
    expect(log.list(1)[0]!.target).to.equal(`l${ACTIVITY_MAX + 19}`);
  });

  it("says who a credential is", async () => {
    const auth = new AuthService("master");
    await auth.setPin("regisseur", "1234");
    const { token } = auth.login("1234", "regisseur");
    expect(auth.nameOf(token)).to.equal("Régisseur");
    expect(auth.nameOf("master")).to.equal("jeton maître");
    expect(auth.nameOf("nobody")).to.equal(undefined);
  });
});
