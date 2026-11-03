import { expect } from "chai";
import { createStoredBus } from "../web/src/stored-bus.js";

describe("stored bus", () => {
  it("a subscriber of a key receives what is published to that key", () => {
    const bus = createStoredBus();
    const received: unknown[] = [];
    bus.subscribe("k", (v) => received.push(v));
    bus.publish("k", 42);
    expect(received).to.deep.equal([42]);
  });
  it("a subscriber of another key does not receive", () => {
    const bus = createStoredBus();
    const received: unknown[] = [];
    bus.subscribe("a", (v) => received.push(v));
    bus.publish("b", 7);
    expect(received).to.deep.equal([]);
  });
  it("two subscribers of the same key both receive it, in subscription order", () => {
    const bus = createStoredBus();
    const order: string[] = [];
    bus.subscribe("k", () => order.push("first"));
    bus.subscribe("k", () => order.push("second"));
    bus.publish("k", "x");
    expect(order).to.deep.equal(["first", "second"]);
  });
  it("the returned function stops that subscriber and not the other", () => {
    const bus = createStoredBus();
    const got: string[] = [];
    const off = bus.subscribe("k", () => got.push("a"));
    bus.subscribe("k", () => got.push("b"));
    off();
    bus.publish("k", 1);
    expect(got).to.deep.equal(["b"]);
  });
  it("calling the unsubscribe function twice does not throw", () => {
    const bus = createStoredBus();
    const off = bus.subscribe("k", () => {});
    off();
    expect(() => off()).to.not.throw();
  });
  it("publishing to a key nobody listens to does not throw", () => {
    const bus = createStoredBus();
    expect(() => bus.publish("nobody", 1)).to.not.throw();
  });
  it("a listener unsubscribing itself while called does not stop the others", () => {
    const bus = createStoredBus();
    const got: string[] = [];
    let offSelf: () => void = () => {};
    offSelf = bus.subscribe("k", () => { got.push("self"); offSelf(); });
    bus.subscribe("k", () => got.push("other"));
    bus.publish("k", 1);
    expect(got).to.deep.equal(["self", "other"]);
  });
  it("two buses are independent", () => {
    const a = createStoredBus();
    const b = createStoredBus();
    const ra: unknown[] = [];
    const rb: unknown[] = [];
    a.subscribe("k", (v) => ra.push(v));
    b.subscribe("k", (v) => rb.push(v));
    a.publish("k", "from-a");
    expect(ra).to.deep.equal(["from-a"]);
    expect(rb).to.deep.equal([]);
  });
  it("remembers the last value of each key for what mounts later", () => {
    const bus = createStoredBus();
    expect(bus.get("k")).to.equal(undefined);
    bus.publish("k", 1);
    bus.publish("k", 2);
    bus.publish("other", "x");
    expect(bus.get("k")).to.equal(2);
    expect(bus.get("other")).to.equal("x");
    expect(createStoredBus().get("k")).to.equal(undefined); // a bus of its own
  });
});
