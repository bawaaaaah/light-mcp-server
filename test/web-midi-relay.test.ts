import { expect } from "chai";
import { relayOver } from "../web/src/web-midi-relay.js";

/** The Web MIDI relay (docs/specs/midi.md, « Web MIDI »): over the live connection, only while online, a refusal said. */
describe("Web MIDI relay", () => {
  const fake = (online: boolean, answer: () => Promise<{ status: number; body: unknown }>) => {
    const sent: unknown[] = [];
    let reconnects = 0;
    return {
      channel: { online, request: (_m: "POST", path: string, body: unknown) => (sent.push({ path, body }), answer()), reconnect: () => void reconnects++ },
      sent,
      reconnects: () => reconnects,
    };
  };
  const settle = () => new Promise<void>((r) => setImmediate(r));

  it("a wheel pushed while reconnecting: nothing relayed, nothing kept for later", async () => {
    const f = fake(false, async () => ({ status: 200, body: {} }));
    const refused: string[] = [];
    relayOver(f.channel, "midi.in", { port: "Web MIDI · Pad", bytes: [0xe0, 0, 127] }, (why) => refused.push(why));
    await settle();
    expect(f.sent).to.deep.equal([]);
    expect(refused).to.deep.equal([]);
  });

  it("online: sent over the connection as the command's route", async () => {
    const f = fake(true, async () => ({ status: 200, body: { ok: true } }));
    relayOver(f.channel, "midi.in", { port: "Web MIDI · Pad", bytes: [0x90, 40, 100] }, () => undefined);
    await settle();
    expect(f.sent).to.deep.equal([{ path: "/api/plugins/light/commands/midi.in", body: { port: "Web MIDI · Pad", bytes: [0x90, 40, 100] } }]);
    expect(f.reconnects()).to.equal(0);
  });

  it("refused by the server: said, and the connection opened again", async () => {
    const f = fake(true, async () => ({ status: 422, body: { error: "connexion fermée" } }));
    const refused: string[] = [];
    relayOver(f.channel, "midi.in", { port: "Web MIDI · Pad", bytes: [0x90, 40, 100] }, (why) => refused.push(why));
    await settle();
    expect(refused).to.deep.equal(["connexion fermée"]);
    expect(f.reconnects()).to.equal(1);
  });

  it("the connection gone while it was on its way: dropped quietly (the server lets go of what it held)", async () => {
    const f = fake(true, async () => Promise.reject(new Error("offline")));
    const refused: string[] = [];
    relayOver(f.channel, "midi.in", { port: "Web MIDI · Pad", bytes: [0x90, 40, 100] }, (why) => refused.push(why));
    await settle();
    expect(refused).to.deep.equal([]);
    expect(f.reconnects()).to.equal(0);
  });
});
