import { expect } from "chai";
import { MotionLockSchema, MotionLockStateSchema, hardenLock, heldOf, lockOf, lockState, sameLock, stricter } from "../../../src/plugins/light/show/motion-lock.js";
import { ShowSettingsSchema, SnapshotSchema } from "../../../src/plugins/light/show/model.js";

describe("T26 lot 1: the motion lock schema and each head's effective level", () => {
  it("a show without `motionLock` locks nothing, and an empty one parses with its defaults", () => {
    const s = ShowSettingsSchema.parse({});
    expect(s.motionLock).to.equal(undefined);
    expect(lockOf(s.motionLock, "spot")).to.equal("off");
    expect(ShowSettingsSchema.parse({ motionLock: {} }).motionLock).to.deep.equal({ level: "off", heads: {}, held: {} });
  });

  it("keeps the global level, the heads locked on their own and where they were frozen", () => {
    const lock = MotionLockSchema.parse({ level: "soft", heads: { a: "hard" }, held: { a: { pan: 0.2, tilt: 0.7 } } });
    expect(ShowSettingsSchema.parse({ motionLock: lock }).motionLock).to.deep.equal(lock);
    expect(heldOf(lock)).to.deep.equal(new Map([["a", { pan: 0.2, tilt: 0.7 }]]));
    expect(heldOf(undefined).size).to.equal(0);
  });

  it("refuses a level that is not off, soft or hard, a head « off » (absent means free), and a position off the travel", () => {
    expect(MotionLockSchema.safeParse({ level: "frozen" }).success).to.equal(false);
    expect(MotionLockSchema.safeParse({ heads: { a: "off" } }).success).to.equal(false);
    expect(MotionLockSchema.safeParse({ held: { a: { pan: 1.2, tilt: 0.5 } } }).success).to.equal(false);
    expect(MotionLockSchema.safeParse({ held: { a: { pan: 0.5 } } }).success).to.equal(false);
  });

  it("a head's effective level is the stricter of the global lock and its own", () => {
    const lock = MotionLockStateSchema.parse({ level: "soft", heads: { a: "hard", b: "soft" } });
    expect(lockOf(lock, "a")).to.equal("hard");
    expect(lockOf(lock, "b")).to.equal("soft");
    expect(lockOf(lock, "c")).to.equal("soft"); // the global lock
    const hardAll = MotionLockStateSchema.parse({ level: "hard", heads: { b: "soft" } });
    expect(lockOf(hardAll, "b")).to.equal("hard"); // a head soft under a global hard lock is hard
    const free = MotionLockStateSchema.parse({ heads: { a: "soft" } });
    expect(lockOf(free, "a")).to.equal("soft");
    expect(lockOf(free, "b")).to.equal("off");
    expect(lockOf(free, "constructor")).to.equal("off"); // ids are looked up as own keys only
  });

  it("orders the levels hard > soft > off", () => {
    expect(stricter("off", "soft")).to.equal("soft");
    expect(stricter("hard", "soft")).to.equal("hard");
    expect(stricter("soft", "soft")).to.equal("soft");
  });

  it("hardening a lock never loosens it: the stricter global level, the stricter per head, no head dropped (D1, D2)", () => {
    const current = MotionLockStateSchema.parse({ level: "soft", heads: { a: "hard", b: "soft" } });
    expect(hardenLock(current, { level: "off", heads: {} })).to.deep.equal(current);
    expect(hardenLock(current, { level: "hard", heads: { a: "soft", b: "hard", c: "soft" } })).to.deep.equal({ level: "hard", heads: { a: "hard", b: "hard", c: "soft" } });
    expect(hardenLock({ level: "off", heads: {} }, { level: "soft", heads: { a: "hard" } })).to.deep.equal({ level: "soft", heads: { a: "hard" } });
    // a copy: the current lock is left as it is
    expect(current).to.deep.equal({ level: "soft", heads: { a: "hard", b: "soft" } });
  });

  it("compares two locks by their levels, global and per head", () => {
    expect(sameLock({ level: "off", heads: {} }, lockState(undefined))).to.equal(true);
    expect(sameLock({ level: "soft", heads: { a: "hard" } }, { level: "soft", heads: { a: "hard" } })).to.equal(true);
    expect(sameLock({ level: "soft", heads: { a: "hard" } }, { level: "soft", heads: { a: "soft" } })).to.equal(false);
    expect(sameLock({ level: "soft", heads: { a: "hard" } }, { level: "soft", heads: { b: "hard" } })).to.equal(false);
    expect(sameLock({ level: "soft", heads: {} }, { level: "hard", heads: {} })).to.equal(false);
  });

  it("a snapshot records the levels without `held`; an older snapshot has none", () => {
    expect(SnapshotSchema.parse({ id: "s", name: "S" }).motionLock).to.equal(undefined);
    const lock = MotionLockSchema.parse({ level: "hard", heads: { a: "soft" }, held: { a: { pan: 0.1, tilt: 0.1 } } });
    const state = lockState(lock);
    expect(state).to.deep.equal({ level: "hard", heads: { a: "soft" } });
    expect(SnapshotSchema.parse({ id: "s", name: "S", motionLock: state }).motionLock).to.deep.equal(state);
    expect(lockState(undefined)).to.deep.equal({ level: "off", heads: {} });
    // a copy: editing the snapshot's heads leaves the show's lock alone
    state.heads.b = "hard";
    expect(lock.heads).to.deep.equal({ a: "soft" });
  });
});
