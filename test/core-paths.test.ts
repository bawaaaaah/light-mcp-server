import { expect } from "chai";
import path from "node:path";
import { configPath, dataRoot } from "../src/core/paths.js";

describe("data location", () => {
  it("never puts the data inside node_modules: an npm install uses ./data of the current directory", () => {
    const installed = path.join("/srv", "app", "node_modules", "@bawaaaaah", "light-mcp-server");
    expect(dataRoot({}, "/home/regie/lumiere", installed)).to.equal(path.join("/home/regie/lumiere", "data"));
    expect(configPath({}, "/home/regie/lumiere", installed)).to.equal(path.join("/home/regie/lumiere", "data", "machine", "config.json"));
  });

  it("uses the package's data/ in a source checkout or the Docker image, and LIGHT_DATA_ROOT first", () => {
    expect(dataRoot({}, "/tmp", "/app")).to.equal(path.join("/app", "data"));
    expect(dataRoot({ LIGHT_DATA_ROOT: "show-data" }, "/home/regie", "/app")).to.equal(path.join("/home/regie", "show-data"));
    expect(configPath({ LIGHT_DATA_ROOT: "/d" }, "/x", "/app")).to.equal(path.join("/d", "machine", "config.json"));
    expect(configPath({ LIGHT_CONFIG_PATH: "/etc/light.json" }, "/x", "/app")).to.equal("/etc/light.json");
  });
});
