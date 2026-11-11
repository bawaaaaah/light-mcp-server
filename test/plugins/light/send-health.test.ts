import { expect } from "chai";
import { SendHealth, isFailing } from "../../../src/plugins/light/output/send-health.js";

describe("send health per host over a recent window", () => {
  it("calls a host failing only with enough sends and mostly errors", () => {
    expect(isFailing(4, 4)).to.equal(false); // too few sends to say
    expect(isFailing(10, 5)).to.equal(false); // half is not more than half
    expect(isFailing(10, 6)).to.equal(true);
  });

  it("counts per host and forgets what left the window", () => {
    const h = new SendHealth({ windowMs: 10_000 });
    for (let i = 0; i < 8; i++) h.record("192.0.2.10", false, i * 100);
    for (let i = 0; i < 8; i++) h.record("192.0.2.20", true, i * 100);
    h.record("192.0.2.20", false, 900);
    expect(h.hosts(1000)).to.deep.equal([
      { host: "192.0.2.10", sends: 8, errors: 8, failing: true },
      { host: "192.0.2.20", sends: 9, errors: 1, failing: false },
    ]);
    expect(h.hosts(10_450).map((x) => x.sends)).to.deep.equal([3, 4]); // events at 0..400 ms are out of the window
    expect(h.hosts(60_000)).to.deep.equal([]);
  });

  it("recovers: a host that answers again stops failing", () => {
    const h = new SendHealth({ windowMs: 1000 });
    for (let i = 0; i < 6; i++) h.record("198.51.100.5", false, i);
    expect(h.hosts(10)[0]!.failing).to.equal(true);
    for (let i = 0; i < 20; i++) h.record("198.51.100.5", true, 2000 + i);
    expect(h.hosts(2030)[0]).to.deep.include({ sends: 20, errors: 0, failing: false });
  });
});
