import { expect } from "chai";
import { actionsOf, addColor, draftOf, draftProblems, familiesOf, fill, intentionKey, intentionsOf, moveColor, newDraft, normalizeHex, plural, putArgs, removeColor, replacedBy, searchIntentions, takenIn, type KnowledgeIntentions } from "../web/src/intentions.js";
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
    expect(of("lever-de-rideau")).to.deep.equal(["edit", "delete"]);
    expect(of("calme")).to.deep.equal(["edit", "revert"]);
    expect(of("douceur")).to.deep.equal(["edit", "copyToShow", "delete"]);
    expect(of("brume")).to.deep.equal(["touchUp", "copyToShow", "hide"]);
    expect(of("joie")).to.deep.equal(["touchUp", "hide"]);
    expect(of("paix")).to.deep.equal(["restore"]);
  });

  it("opens a row in its own place, and a shipped one as a touch-up of the show", () => {
    expect(draftOf(list.find((r) => r.key === "douceur")!)).to.deep.include({ id: "douceur", scope: "personal" });
    expect(draftOf(list.find((r) => r.key === "joie")!)).to.deep.include({ id: "joie", scope: "show", label: "Joie" });
  });

  it("checks a draft: a label with a letter, a key free in its place (creation only), 1 to 6 valid colours", () => {
    const taken = takenIn(list);
    expect(taken("lever-de-rideau", "show")).to.equal(true);
    expect(taken("lever-de-rideau", "personal")).to.equal(false);
    expect(taken("douceur", "personal")).to.equal(true);
    expect(taken("joie", "show")).to.equal(false); // a shipped key: the new one is a touch-up
    expect(draftProblems({ ...newDraft(), label: "Lever de rideau !" }, taken)).to.deep.equal(["taken"]);
    expect(draftProblems({ ...newDraft("personal"), label: "Lever de rideau" }, taken)).to.deep.equal([]);
    expect(draftProblems({ ...newDraft(), id: "lever-de-rideau", label: "Autre libellé" }, taken)).to.deep.equal([]);
    expect(draftProblems({ ...newDraft(), label: "?!" }, taken)).to.deep.equal(["label"]);
    expect(draftProblems({ ...newDraft(), label: "x", colors: ["rouge"] }, taken)).to.deep.equal(["colors"]);
    expect(draftProblems({ ...newDraft(), label: "x", colors: [] }, taken)).to.deep.equal(["colors"]);
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
    const taken = takenIn(list);
    expect(draftProblems({ ...newDraft(), label: "mot ".repeat(17) }, taken)).to.deep.equal(["long"]); // a key of 67 characters
    expect(draftProblems({ ...newDraft(), label: "é".repeat(81) }, taken)).to.deep.equal(["long"]); // a label over 80
    expect(draftProblems({ ...newDraft(), label: "mot ".repeat(15) }, taken)).to.deep.equal([]);
  });

  it("says what a new intention would replace: a shipped or private one, or what the show hides", () => {
    expect(replacedBy({ ...newDraft(), label: "Joie !" }, list)?.key).to.equal("joie");
    expect(replacedBy({ ...newDraft(), label: "Brume" }, list)?.origin).to.equal("private");
    expect(replacedBy({ ...newDraft(), label: "Paix" }, list)?.hidden).to.equal(true);
    expect(replacedBy({ ...newDraft(), label: "Douceur" }, list)).to.equal(undefined); // a personal one: « taken » in its place, or shadowed
    expect(replacedBy({ ...newDraft(), id: "joie", label: "Joie" }, list)).to.equal(undefined); // an edit replaces nothing
  });

  it("names the energies in English as the server's proposals do", async () => {
    const base = mergeKnowledge(loadKnowledgeLayers(), [], []);
    for (const [energy, mood] of [["pose", "calme"], ["dynamique", "joie"], ["survolte", "fete"]] as const) {
      const said = await inLang("en", async () => proposeLook(base, { mood: [mood] }).explanation[0]!);
      expect(said, energy).to.contain(`${TEXTS.en.energies[energy]} energy`);
    }
  });
});
