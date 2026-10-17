import { expect } from "chai";
import { mkdtempSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inLang, lang, langOf, say } from "../src/core/lang.js";
import { CommandRegistry, systemContext } from "../src/plugins/light/commands/registry.js";
import { FolderStore } from "../src/plugins/light/data/store.js";
import { Venue } from "../src/plugins/light/venue/venue.js";

describe("the language the server answers in", () => {
  it("is French unless the request asks for English, awaited work included", async () => {
    expect(say("bonjour", "hello")).to.equal("bonjour");
    expect(inLang("en", () => say("bonjour", "hello"))).to.equal("hello");
    expect(await inLang("en", async () => (await new Promise((r) => setTimeout(r, 1)), lang()))).to.equal("en");
    expect(inLang(undefined, lang)).to.equal("fr");
    expect([langOf("en"), langOf(["fr"]), langOf("de"), langOf(undefined)]).to.deep.equal(["en", "fr", undefined, undefined]);
  });

  it("words a command's refusal in it", async () => {
    const reg = new CommandRegistry();
    let refused = "";
    await inLang("en", () => reg.invoke("nope", {}, systemContext())).catch((e: Error) => (refused = e.message));
    expect(refused).to.equal("unknown command: nope");
  });

  it("words a cached fixture error when it is read, not when it was found", () => {
    const dir = mkdtempSync(join(tmpdir(), "light-lang-"));
    mkdirSync(join(dir, "fixtures"));
    copyFileSync(new URL("./fixtures/bar4.qxf", import.meta.url), join(dir, "fixtures", "bar4.qxf"));
    const venue = new Venue(new FolderStore(join(dir, "venue")), [join(dir, "fixtures")]);
    venue.fixtures.put({ id: "x", name: "X", manufacturer: "Nobody", model: "Nothing", mode: "1", universe: 1, address: 1 });
    const fr = venue.resolve("x") as { error: string };
    expect(fr.error).to.contain("définition manquante");
    expect(inLang("en", () => (venue.resolve("x") as { error: string }).error)).to.contain("missing definition");
  });
});
