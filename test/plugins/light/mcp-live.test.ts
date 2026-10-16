import { expect } from "chai";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { EventBus } from "../../../src/core/event-bus.js";
import { createMcpServer } from "../../../src/core/mcp-server-factory.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";
import { systemContext } from "../../../src/plugins/light/commands/registry.js";

describe("MCP resources: live state, songs, setlist", () => {
  it("says when channels are forced from the DMX console", async () => {
    const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    const plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot: join(mkdtempSync(join(tmpdir(), "light-live-")), "data"), midiNative: null });
    const { mcpServer } = createMcpServer([plugin]);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverSide);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientSide);
    const live = async () => ((await client.readResource({ uri: "light://live" })).contents[0] as { text: string }).text;
    expect(await live()).to.not.contain("FORCÉ");
    await client.callTool({ name: "light_dmx_set", arguments: { universe: 1, values: { "500": 10, "501": 20 } } });
    expect(await live()).to.contain("2 canal(aux) FORCÉ(S)");
    await client.callTool({ name: "light_dmx_release", arguments: {} });
    expect(await live()).to.not.contain("FORCÉ");
    await client.close();
  });

  it("lists the songs as resources, and gives the setlist in use with its titles", async () => {
    const cfg = { discovery: false, output: { routes: [] }, osc: { enabled: false }, midi: { active: "x", profiles: { x: { inputs: [], rtp: { enabled: false } } } } };
    const dataRoot = join(mkdtempSync(join(tmpdir(), "light-songs-")), "data");
    mkdirSync(join(dataRoot, "fixtures"), { recursive: true });
    copyFileSync(new URL("../../fixtures/bar4.qxf", import.meta.url), join(dataRoot, "fixtures", "bar4.qxf"));
    const plugin = new LightPlugin({ eventBus: new EventBus(), config: { get: () => cfg, set: async () => undefined }, dataRoot, midiNative: null });
    await plugin.commands.invoke("import.qxw", { xml: readFileSync(new URL("../../fixtures/synthetic.qxw", import.meta.url), "utf8"), apply: true }, systemContext());
    const { mcpServer } = createMcpServer([plugin]);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverSide);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientSide);
    await client.callTool({ name: "light_song_put", arguments: { song: { id: "a", title: "Chant A", bpm: 90, mood: ["joie"], sections: [{ id: "intro", name: "Intro", look: "checker" }] } } });
    await client.callTool({ name: "light_setlist_put", arguments: { setlist: { id: "s", name: "Service", songs: ["a"] } } });
    await client.callTool({ name: "light_setlist_select", arguments: { id: "s" } });
    const listed = (await client.listResources()).resources;
    expect(listed.find((r) => r.uri === "light://song/a")?.name).to.equal("Chant A");
    const song = JSON.parse(((await client.readResource({ uri: "light://song/a" })).contents[0] as { text: string }).text) as { sections: { lookName?: string }[] };
    expect(song.sections[0]!.lookName).to.equal("checker");
    const setlist = JSON.parse(((await client.readResource({ uri: "light://setlist" })).contents[0] as { text: string }).text) as { current: { songs: { title: string }[] } };
    expect(setlist.current.songs.map((x) => x.title)).to.deep.equal(["Chant A"]);
    await client.close();
  });
});
