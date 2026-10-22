import { expect } from "chai";
import { announcement, answer, decodeName, encodeQuery, questionsOf, recordsIn, ServiceTable, type ServiceInfo } from "../src/core/mdns.js";

const service: ServiceInfo = { instance: "Lumière", type: "_os2l._tcp", port: 7272, host: "regie", addresses: ["10.0.0.9"] };

/** A query as DJ software sends it: one question, the second one's name compressed onto the first. */
function query(questions: [string, number][]): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(questions.length, 4);
  const parts: Buffer[] = [header];
  for (const [name, type] of questions) {
    const labels = name.split(".").map((l) => Buffer.concat([Buffer.from([Buffer.byteLength(l)]), Buffer.from(l)]));
    const tail = Buffer.alloc(4);
    tail.writeUInt16BE(type, 0);
    tail.writeUInt16BE(1, 2);
    parts.push(...labels, Buffer.from([0]), tail);
  }
  return Buffer.concat(parts);
}

/** The records of a response: name, type, TTL and the data as text where it is a name. */
function records(buf: Buffer) {
  const count = buf.readUInt16BE(6) + buf.readUInt16BE(10);
  const out: { name: string; type: number; ttl: number; data: Buffer; at: number }[] = [];
  let at = 12;
  for (let i = 0; i < count; i++) {
    const { name, next } = decodeName(buf, at);
    const type = buf.readUInt16BE(next);
    const ttl = buf.readUInt32BE(next + 4);
    const len = buf.readUInt16BE(next + 8);
    out.push({ name, type, ttl, data: buf.subarray(next + 10, next + 10 + len), at: next + 10 });
    at = next + 10 + len;
  }
  return out;
}

describe("mDNS: the OS2L service found on the network", () => {
  it("answers DJ software asking for _os2l._tcp with the instance, its port and the host's address", () => {
    const reply = answer(query([["_os2l._tcp.local", 12]]), service)!;
    expect(reply.readUInt16BE(2)).to.equal(0x8400); // an authoritative response
    const rs = records(reply);
    const ptr = rs.find((r) => r.type === 12)!;
    expect(ptr.name).to.equal("_os2l._tcp.local");
    expect(decodeName(reply, ptr.at).name).to.equal("Lumière._os2l._tcp.local");
    const srv = rs.find((r) => r.type === 33)!;
    expect(srv.data.readUInt16BE(4)).to.equal(7272);
    expect(decodeName(reply, srv.at + 6).name).to.equal("regie.local");
    expect([...rs.find((r) => r.type === 1)!.data]).to.deep.equal([10, 0, 0, 9]);
  });

  it("reads compressed names, ignores responses and questions about other services", () => {
    const q = query([["_os2l._tcp.local", 12]]);
    // a second question pointing back at « _tcp.local » in the first one
    const second = Buffer.concat([Buffer.from([5]), Buffer.from("_http"), Buffer.from([0xc0, 12 + 6]), Buffer.from([0, 12, 0, 1])]);
    const both = Buffer.concat([q, second]);
    both.writeUInt16BE(2, 4);
    expect(questionsOf(both)).to.deep.equal([
      { name: "_os2l._tcp.local", type: 12 },
      { name: "_http._tcp.local", type: 12 },
    ]);
    expect(answer(query([["_http._tcp.local", 12]]), service)).to.equal(undefined);
    expect(questionsOf(answer(q, service)!)).to.deep.equal([]); // a response asks nothing
  });

  it("announces itself, and says goodbye with a zero lifetime", () => {
    expect(records(announcement(service)).map((r) => r.type)).to.include.members([12, 33, 16, 1]);
    expect(records(announcement(service, true)).every((r) => r.ttl === 0 && r.type === 12)).to.equal(true);
  });
});

describe("mDNS: the RTP-MIDI sessions of the network", () => {
  const ipad: ServiceInfo = { instance: "iPad de scène", type: "_apple-midi._udp", port: 5004, host: "ipad-scene", addresses: ["192.0.2.21"] };

  it("asks for a type, and reads the instance, its port and its host's address from the answer", () => {
    expect(questionsOf(encodeQuery([{ name: "_apple-midi._udp.local", type: "PTR" }]))).to.deep.equal([{ name: "_apple-midi._udp.local", type: 12 }]);
    const reply = answer(encodeQuery([{ name: "_apple-midi._udp.local", type: "PTR" }]), ipad)!;
    const table = new ServiceTable("_apple-midi._udp");
    table.receive(recordsIn(reply), 0);
    expect(table.list(1000)).to.deep.equal({ found: [{ name: "iPad de scène", host: "ipad-scene", port: 5004, addresses: ["192.0.2.21"] }], missing: [] });
    expect(recordsIn(encodeQuery([{ name: "_apple-midi._udp.local", type: "PTR" }]))).to.deep.equal([]); // a question is not an answer
  });

  it("asks for what a responder left out, forgets the gone and the silent", () => {
    const table = new ServiceTable("_apple-midi._udp");
    const all = recordsIn(announcement(ipad));
    table.receive(all.filter((r) => r.kind === "ptr"), 0); // the instance only
    expect(table.list(0)).to.deep.equal({ found: [], missing: [{ name: "ipad de scène._apple-midi._udp.local", type: "SRV" }] });
    table.receive(all.filter((r) => r.kind === "srv"), 0);
    expect(table.list(0).missing).to.deep.equal([{ name: "ipad-scene.local", type: "A" }]);
    table.receive(all, 0);
    expect(table.list(0).found).to.have.length(1);
    table.receive(recordsIn(announcement(ipad, true)), 10); // goodbye: TTL 0
    expect(table.list(10).found).to.deep.equal([]);
    table.receive(all, 20);
    expect(table.list(4500 * 1000 + 21).found).to.deep.equal([]); // its time to live is over
  });
});

