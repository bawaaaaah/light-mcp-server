import { expect } from "chai";
import { Channel, type ChannelDeps, type SocketLike } from "../web/src/ws-channel.js";

class FakeSocket implements SocketLike {
  binaryType = "blob";
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  /** The connection it said it replaces. */
  previous: string | undefined;
  closed = false;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  send(data: string | Uint8Array): void {
    this.sent.push(JSON.parse(String(data)) as Record<string, unknown>);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
  /** The hub's side. */
  hear(msg: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

/** A hub, a ticket desk and a clock run by hand: nothing happens until the test says so. */
function harness() {
  const sockets: FakeSocket[] = [];
  const tickets: { resolve: (t: string) => void; reject: (e: Error) => void }[] = [];
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const deps: ChannelDeps = {
    ticket: () => new Promise<string>((resolve, reject) => tickets.push({ resolve, reject })),
    socket: (_ticket, _protocol, previous) => {
      const s = new FakeSocket();
      s.previous = previous;
      sockets.push(s);
      return s;
    },
    later: (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return t;
    },
    cancel: (handle) => {
      if (handle) (handle as { cancelled: boolean }).cancelled = true;
    },
  };
  const channel = new Channel("control", "json", deps);
  const status: boolean[] = [];
  channel.onStatus((up) => status.push(up));
  /** Runs the timers due now (each once), then lets the promises they start settle. */
  const tick = async () => {
    for (const t of timers.splice(0)) if (!t.cancelled) t.fn();
    await settle();
  };
  return { channel, sockets, tickets, timers, status, tick };
}
const settle = () => new Promise<void>((r) => setImmediate(r));
const open = (sockets: FakeSocket[]) => sockets.filter((s) => !s.closed);

describe("web live link (ws-channel): one socket per connection, whatever the order of close and connect", () => {
  it("says up once the hub has taken every subscription again, not on « hello » alone", async () => {
    const { channel, sockets, tickets, status } = harness();
    channel.subscribe("light:command", () => undefined);
    void channel.connect();
    tickets[0]!.resolve("t1");
    await settle();
    sockets[0]!.hear({ t: "hello" });
    const sub = sockets[0]!.sent.find((m) => m.t === "sub")!;
    expect(status).to.deep.equal([]);
    sockets[0]!.hear({ t: "ack", id: sub.id, topic: "light:command" });
    expect(status).to.deep.equal([true]);
  });

  it("opens no socket for a ticket that lands after close()", async () => {
    const { channel, sockets, tickets, status } = harness();
    void channel.connect();
    channel.close();
    tickets[0]!.resolve("late");
    await settle();
    expect(sockets).to.have.length(0);
    expect(status).to.deep.equal([false]);
  });

  it("close() then connect() while the first ticket is on its way: one socket, the second connection's", async () => {
    const { channel, sockets, tickets } = harness();
    void channel.connect();
    channel.close();
    void channel.connect();
    tickets[1]!.resolve("new");
    tickets[0]!.resolve("old");
    await settle();
    expect(sockets).to.have.length(1);
  });

  it("a ticket retry of an older connection stops there after close() and connect()", async () => {
    const { channel, sockets, tickets, tick } = harness();
    void channel.connect();
    tickets[0]!.reject(new Error("server restarting"));
    await settle(); // the retry is armed (2 s)
    channel.close();
    void channel.connect();
    tickets[1]!.resolve("new");
    await settle();
    await tick(); // the old retry fires: it must not ask for another ticket nor open a socket
    expect(tickets).to.have.length(2);
    expect(open(sockets)).to.have.length(1);
  });

  it("the close of an older connection's socket neither says offline nor reconnects", async () => {
    const { channel, sockets, tickets, timers, status, tick } = harness();
    void channel.connect();
    tickets[0]!.resolve("a");
    await settle();
    sockets[0]!.hear({ t: "hello" });
    channel.close(); // the session refused: signed out
    void channel.connect(); // signed in again within the reconnection delay
    tickets[1]!.resolve("b");
    await settle();
    sockets[1]!.hear({ t: "hello" });
    status.length = 0;
    sockets[0]!.drop(); // the old socket's close comes in late
    expect(status).to.deep.equal([]);
    expect(timers.filter((t) => !t.cancelled)).to.have.length(0);
    await tick();
    expect(tickets).to.have.length(2);
    expect(open(sockets)).to.deep.equal([sockets[1]]);
  });

  it("the current socket dropping says offline and reconnects with a fresh ticket, once", async () => {
    const { channel, sockets, tickets, timers, status, tick } = harness();
    void channel.connect();
    tickets[0]!.resolve("a");
    await settle();
    sockets[0]!.hear({ t: "hello" });
    sockets[0]!.drop();
    expect(status).to.deep.equal([true, false]);
    expect(timers.map((t) => t.ms)).to.deep.equal([1500]);
    await tick();
    tickets[1]!.resolve("b");
    await settle();
    expect(sockets).to.have.length(2);
  });
  it("the ack fallback of a connection closed since does not say up", async () => {
    const { channel, sockets, tickets, status, tick } = harness();
    channel.subscribe("light:command", () => undefined);
    void channel.connect();
    tickets[0]!.resolve("a");
    await settle();
    sockets[0]!.hear({ t: "hello" }); // the hub, busy, does not answer the « sub »
    channel.close(); // the old socket's close has not come in yet
    await tick(); // the 5 s fallback fires
    expect(status).to.deep.equal([false]);
  });

  it("an older connection's socket still talking after close() and connect() is not heard", async () => {
    const { channel, sockets, tickets, status } = harness();
    const heard: unknown[] = [];
    channel.subscribe("light:command", (d) => heard.push(d));
    void channel.connect();
    tickets[0]!.resolve("a");
    await settle();
    channel.close();
    void channel.connect();
    tickets[1]!.resolve("b");
    await settle();
    status.length = 0;
    sockets[0]!.hear({ t: "hello" });
    sockets[0]!.hear({ t: "evt", topic: "light:command", data: 1 });
    expect(heard).to.deep.equal([]);
    expect(status).to.deep.equal([]);
    expect(sockets[1]!.sent).to.deep.equal([]);
  });
});

describe("web live link: its connection id, and what is relayed over it", () => {
  /** Connected and online: « hello » heard (no subscription to wait for). */
  const online = async (h: ReturnType<typeof harness>, n: number, id: string) => {
    if (n === 0) void h.channel.connect();
    h.tickets[n]!.resolve(`t${n}`);
    await settle();
    h.sockets[n]!.hear({ t: "hello", connection: id });
  };

  it("sets the id at « hello », clears it at close(), and names the lost one when it reconnects", async () => {
    const h = harness();
    await online(h, 0, "c1");
    expect(h.channel.connectionId).to.equal("c1");
    h.sockets[0]!.drop(); // the network went
    expect(h.channel.connectionId).to.equal(undefined);
    await h.tick(); // the reconnection
    h.tickets[1]!.resolve("t1");
    await settle();
    expect(h.sockets[1]!.previous).to.equal("c1"); // the hub lets c1 go at once
    h.sockets[1]!.hear({ t: "hello", connection: "c2" });
    expect(h.channel.connectionId).to.equal("c2");
    h.channel.close();
    expect(h.channel.connectionId).to.equal(undefined);
  });

  it("relays a request over the socket while online; refuses it at once while reconnecting, never later", async () => {
    const h = harness();
    await online(h, 0, "c1");
    const answer = h.channel.request("POST", "/api/plugins/light/commands/midi.in", { port: "Web MIDI · Pad", bytes: [0xe0, 0, 127] });
    const req = h.sockets[0]!.sent.find((m) => m.t === "req")!;
    expect(req).to.deep.include({ method: "POST", path: "/api/plugins/light/commands/midi.in" });
    h.sockets[0]!.hear({ t: "res", id: req.id, status: 200, body: { ok: true } });
    expect(await answer).to.deep.equal({ status: 200, body: { ok: true } });
    h.sockets[0]!.drop();
    let refused = "";
    await h.channel.request("POST", "/x", {}).catch((e: Error) => (refused = e.message));
    expect(refused).to.equal("offline");
    await h.tick();
    h.tickets[1]!.resolve("t1");
    await settle();
    h.sockets[1]!.hear({ t: "hello", connection: "c2" });
    expect(h.sockets[1]!.sent.filter((m) => m.t === "req")).to.deep.equal([]); // nothing kept for later
  });
});
