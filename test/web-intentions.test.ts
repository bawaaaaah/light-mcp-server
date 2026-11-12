import { expect } from "chai";
import { originsOf } from "../web/src/intentions.js";
import { actionsOf, addColor, draftOf, draftProblems, duplicatesOf, familiesOf, fill, intentionKey, intentionsOf, moveColor, newDraft, normalizeHex, plural, putArgs, removeColor, replacedBy, resolveWord, searchIntentions, tagsShown, tagsTyped, type KnowledgeIntentions } from "../web/src/intentions.js";
import { loadKnowledgeLayers, normalizeMood, proposeLook } from "../src/plugins/light/knowledge/knowledge.js";
import { mergeKnowledge } from "../src/plugins/light/knowledge/intentions.js";
import { inLang } from "../src/core/lang.js";
import { TEXTS } from "../web/src/i18n.js";
import { themeOf, themesOf } from "../web/src/themes.js";

describe("intentions (T15): the Show page's list and editor", () => {
  const kb: KnowledgeIntentions = {
    moods: {
      joie: { label: "Joie", colors: ["#ffcc1a"], energy: "dynamique", family: "chaud", origin: "generic", usedBy: ["chant « A »"] },
      "lever-de-rideau": { label: "Lever de rideau", colors: ["#112233", "#445566"], energy: "survolte", family: "festif", origin: "show" },
      douceur: { label: "Douceur", colors: ["#ffeedd"], energy: "pose", family: "chaud", origin: "personal" },
      calme: { label: "Calme", colors: ["#3a6ff7"], energy: "pose", family: "froid", origin: "show", over: "generic" },
      brume: { label: "Brume", colors: ["#cccccc"], origin: "private" },
      ancien: { colors: ["#000000"] }, // an older server: no origin, no energy
    },
    hidden: [{ id: "paix", label: "Paix", colors: ["#4a90e2"], energy: "pose", family: "froid", origin: "show", over: "generic" }],
  };
  const list = intentionsOf(kb);

  it("makes the key the server makes", () => {
    expect(intentionKey("Lever de rideau")).to.equal("lever-de-rideau");
    expect(intentionKey("Joie !")).to.equal("joie");
    expect(intentionKey("Intimité")).to.equal("intimite");
    expect(intentionKey(" ?! ")).to.equal("");
  });

  it("lists visible and masked intentions by label, with their origin and uses", () => {
    expect(list.map((r) => r.key)).to.deep.equal(["ancien", "brume", "calme", "douceur", "joie", "lever-de-rideau", "paix"]);
    expect(list.find((r) => r.key === "paix")).to.deep.include({ hidden: true, over: "generic" });
    expect(list.find((r) => r.key === "ancien")).to.deep.include({ origin: "generic", energy: "dynamique", label: "ancien", usedBy: [] });
    expect(list.find((r) => r.key === "joie")!.usedBy).to.deep.equal(["chant « A »"]);
    expect(familiesOf(list)).to.deep.equal(["chaud", "festif", "froid"]);
    expect(intentionsOf(null)).to.deep.equal([]);
  });

  it("searches by label, key, family or origin, without accents", () => {
    const word = (o: string) => ({ show: "ce show", personal: "personnelle", private: "fichier privé", generic: "livrée" })[o]!;
    expect(searchIntentions(list, "rideau", word).map((r) => r.key)).to.deep.equal(["lever-de-rideau"]);
    expect(searchIntentions(list, "FESTIF", word).map((r) => r.key)).to.deep.equal(["lever-de-rideau"]);
    expect(searchIntentions(list, "personnelle", word).map((r) => r.key)).to.deep.equal(["douceur"]);
    expect(searchIntentions(list, "fichier prive", word).map((r) => r.key)).to.deep.equal(["brume"]);
  });

  it("offers per origin: edit in place, touch up the shipped, copy a personal one into the show, revert, hide, restore", () => {
    const of = (k: string) => actionsOf(list.find((r) => r.key === k)!);
    expect(of("lever-de-rideau")).to.deep.equal(["edit", "toLibrary", "delete"]);
    expect(of("calme")).to.deep.equal(["edit", "toLibrary", "revert"]);
    expect(actionsOf(list.find((r) => r.key === "lever-de-rideau")!, true)).to.deep.equal(["edit", "delete"]); // the library section
    expect(actionsOf(list.find((r) => r.key === "calme")!, true)).to.deep.equal(["edit", "revert"]); // one over a shipped one gives it back
    expect(of("douceur")).to.deep.equal(["edit", "copyToShow", "delete"]);
    expect(of("brume")).to.deep.equal(["touchUp", "copyToShow", "hide"]);
    expect(of("joie")).to.deep.equal(["touchUp", "hide"]);
    expect(of("paix")).to.deep.equal(["restore"]);
  });

  it("opens a row in its own place, and a shipped one as a touch-up of the show", () => {
    expect(draftOf(list.find((r) => r.key === "douceur")!)).to.deep.include({ id: "douceur", scope: "personal" });
    expect(draftOf(list.find((r) => r.key === "joie")!)).to.deep.include({ id: "joie", scope: "show", label: "Joie" });
  });

  it("checks a draft: a label with a letter, 1 to 6 valid colours; a shared label is allowed and said (T15b)", () => {
    expect(draftProblems({ ...newDraft(), label: "Lever de rideau !" })).to.deep.equal([]);
    expect(duplicatesOf({ ...newDraft(), label: "Lever de rideau !" }, list).map((r) => r.key)).to.deep.equal(["lever-de-rideau"]);
    expect(duplicatesOf({ ...newDraft(), id: "lever-de-rideau", label: "Lever de rideau" }, list)).to.deep.equal([]); // itself
    expect(duplicatesOf({ ...newDraft(), label: "Paix" }, list)).to.deep.equal([]); // a masked one is no duplicate
    expect(draftProblems({ ...newDraft(), id: "lever-de-rideau", label: "Autre libellé" })).to.deep.equal([]);
    expect(draftProblems({ ...newDraft(), label: "?!" })).to.deep.equal(["label"]);
    expect(draftProblems({ ...newDraft(), label: "x", colors: ["rouge"] })).to.deep.equal(["colors"]);
    expect(draftProblems({ ...newDraft(), label: "x", colors: [] })).to.deep.equal(["colors"]);
  });

  it("reads a hexadecimal colour typed by hand", () => {
    expect(normalizeHex("#ABC")).to.equal("#aabbcc");
    expect(normalizeHex(" ff8800 ")).to.equal("#ff8800");
    expect(normalizeHex("#12345")).to.equal(undefined);
    expect(normalizeHex("rouge")).to.equal(undefined);
  });

  it("moves, removes and adds colours, the first one leading, six at most", () => {
    expect(moveColor(["#1", "#2", "#3"], 1, -1)).to.deep.equal(["#2", "#1", "#3"]);
    expect(moveColor(["#1", "#2"], 0, -1)).to.deep.equal(["#1", "#2"]);
    expect(removeColor(["#1", "#2"], 0)).to.deep.equal(["#2"]);
    expect(removeColor(["#1"], 0)).to.deep.equal(["#1"]);
    expect(addColor(["#ff0000"])).to.deep.equal(["#ff0000", "#ffffff"]);
    expect(addColor(["#ffffff"])).to.deep.equal(["#ffffff", "#000000"]);
    expect(addColor(["#1", "#2", "#3", "#4", "#5", "#6"])).to.have.length(6);
  });

  it("sends the key only when editing, colours normalised and blanks trimmed", () => {
    expect(putArgs({ ...newDraft(), label: " Brume ", colors: ["#ABC"], family: " froid ", notes: " " })).to.deep.equal({ scope: "show", intention: { label: "Brume", colors: ["#aabbcc"], energy: "pose", family: "froid" } });
    expect(putArgs({ ...newDraft("personal"), id: "brume", label: "Brume", notes: "matin" }).intention).to.deep.include({ id: "brume", notes: "matin" });
  });

  it("feeds the theme picker with the origins, and finds a key typed with spaces", () => {
    const themes = themesOf(kb);
    expect(themes.find((t) => t.key === "lever-de-rideau")!.origin).to.equal("show");
    expect(themes.some((t) => t.key === "paix")).to.equal(false); // a masked one is not offered
    expect(themeOf(themes, "lever de rideau")?.key).to.equal("lever-de-rideau");
  });

  it("makes exactly the key the server makes, word for word", () => {
    const words = ["Joie", "joie !", "Lever de rideau", "  LEVER--de__rideau  ", "Intimité", "Cœur", "ŒUVRE", "Ægir", "Straße", "Øre", "naïve façade", "À l'aube", "?!", "", "x2 / y3", "émotion—forte", "über"];
    for (const w of words) expect(intentionKey(w), w).to.equal(normalizeMood(w));
  });

  it("says one use or several, and stops a key too long before it is sent", () => {
    expect(plural(1, "1 usage", "{n} usages")).to.equal("1 usage");
    expect(plural(3, "1 usage", "{n} usages")).to.equal("3 usages");
    expect(fill("Couleur {n} de {name}", { n: 2, name: "x" })).to.equal("Couleur 2 de x");
    expect(draftProblems({ ...newDraft(), label: "mot ".repeat(17) })).to.deep.equal([]); // the id is generated: a long label's key is no limit
    expect(draftProblems({ ...newDraft(), label: "é".repeat(81) })).to.deep.equal(["long"]); // a label over 80
  });

  it("says what a touch-up replaces; a new intention replaces nothing (T15b)", () => {
    expect(replacedBy({ ...newDraft(), label: "Joie !" }, list)).to.equal(undefined);
    expect(replacedBy({ ...newDraft(), id: "joie", label: "Joie" }, list)).to.deep.include({ key: "joie", origin: "generic" });
    expect(replacedBy({ ...newDraft(), id: "brume", label: "Brume" }, list)?.origin).to.equal("private");
    expect(replacedBy({ ...newDraft(), id: "douceur", label: "Douceur" }, list)?.origin).to.equal("personal"); // copied into the show
    expect(replacedBy({ ...newDraft("personal"), id: "douceur", label: "Douceur" }, list)).to.equal(undefined); // the library's own
    expect(replacedBy({ ...newDraft(), id: "calme", label: "Calme" }, list)?.origin).to.equal("generic"); // the show's touch-up, edited
    expect(replacedBy({ ...newDraft(), id: "lever-de-rideau", label: "x" }, list)).to.equal(undefined);
  });

  it("finds a word as the server does: id, then label before former label, the most specific first (T15b)", () => {
    const two: KnowledgeIntentions = {
      moods: {
        joie: { label: "Joie", colors: ["#ffcc1a"], origin: "generic" },
        "i-a": { label: "Douceur", colors: ["#1"], origin: "personal" },
        "i-b": { label: "Douceur", colors: ["#2"], origin: "show" },
        "i-c": { label: "Tendresse", colors: ["#3"], origin: "show", aliases: ["Câlin"] },
      },
    };
    expect(resolveWord(two, "JOIE")).to.deep.include({ id: "joie", by: "id" });
    expect(resolveWord(two, "douceur")).to.deep.include({ id: "i-b", by: "label", candidates: 2, origin: "show" });
    expect(resolveWord(two, "calin")).to.deep.include({ id: "i-c", by: "alias" });
    expect(resolveWord(two, "i-a")).to.deep.include({ label: "Douceur", origin: "personal" });
    expect(resolveWord(two, "rien")).to.equal(undefined);
    // a look's tags shown by label, and given back their id (a shared label never moves the link)
    expect(tagsShown(two, ["ambiance:i-a", "dossier:x", "ambiance:libre"])).to.deep.equal(["ambiance:Douceur", "dossier:x", "ambiance:libre"]);
    expect(tagsTyped(two, ["ambiance:Douceur", "ambiance:nouveau", "dossier:x"], ["ambiance:i-a"])).to.deep.equal(["ambiance:i-a", "ambiance:nouveau", "dossier:x"]);
    // the picker: chosen by id, a shared label marked, typed by name to the most specific
    const themes = themesOf(two);
    expect(themes.filter((t) => t.duplicate).map((t) => t.key)).to.deep.equal(["i-b", "i-a"]);
    expect(themeOf(themes, "Douceur")?.key).to.equal("i-b");
    expect(themeOf(themes, "câlin")?.key).to.equal("i-c");
  });

  it("says where each word a song or a look names comes from, or that it is unknown here", () => {
    expect(originsOf(kb, ["Joie", "lever de rideau", "douceur", "paix", "brouillard", "joie"])).to.deep.equal([
      { word: "Joie", label: "Joie", origin: "generic", hidden: false },
      { word: "lever de rideau", label: "Lever de rideau", origin: "show", hidden: false },
      { word: "douceur", label: "Douceur", origin: "personal", hidden: false },
      { word: "paix", label: "Paix", origin: "generic", hidden: true },
      { word: "brouillard", label: "brouillard", origin: "unknown", hidden: false },
      { word: "joie", label: "Joie", origin: "generic", hidden: false },
    ]);
  });

  it("names the energies in English as the server's proposals do (« high-energy » for « high energy »)", async () => {
    const base = mergeKnowledge(loadKnowledgeLayers(), [], []);
    for (const [energy, mood] of [["pose", "calme"], ["dynamique", "joie"], ["survolte", "fete"]] as const) {
      const said = await inLang("en", async () => proposeLook(base, { mood: [mood] }).explanation[0]!);
      expect(said, energy).to.contain(`${TEXTS.en.energies[energy].replace(/-energy$/, "")} energy`);
    }
  });
});
