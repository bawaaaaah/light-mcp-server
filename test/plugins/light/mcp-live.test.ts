import { expect } from "chai";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { EventBus } from "../../../src/core/event-bus.js";
import { createMcpServer } from "../../../src/core/mcp-server-factory.js";
import { LightPlugin } from "../../../src/plugins/light/light-plugin.js";

describe("MCP resource light://live", () => {
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
});
