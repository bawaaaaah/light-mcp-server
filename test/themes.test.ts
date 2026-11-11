import { expect } from "chai";
import { addTheme, canAddFree, searchThemes, themeLabel, themesOf, toggleTheme } from "../web/src/themes.js";
import { searchBy } from "../web/src/search-text.js";

describe("themes (T14): searching and picking moods for a look by intention", () => {
  const themes = themesOf({
    moods: {
      intimite: { label: "Intimité", colors: ["#2a2f9e"], family: "froid" },
      fete: { label: "Fête", colors: ["#ff2fb3", "#18d4ff"], family: "festif" },
      majeste: { label: "Majesté", colors: ["#ffb000"], family: "chaud" },
      calme: { colors: ["#3a6ff7"] },
    },
  });

  it("lists the themes by label, the key standing in when there is none", () => {
    expect(themes.map((t) => t.key)).to.deep.equal(["calme", "fete", "intimite", "majeste"]);
    expect(themes.find((t) => t.key === "calme")).to.deep.include({ label: "calme", family: "" });
  });

  it("searches without case or accents, by label or key", () => {
    expect(searchThemes(themes, "intimite").map((t) => t.key)).to.deep.equal(["intimite"]);
    expect(searchThemes(themes, "FÊTE").map((t) => t.key)).to.deep.equal(["fete"]);
    expect(searchThemes(themes, "majest").map((t) => t.key)).to.deep.equal(["majeste"]);
    expect(searchThemes(themes, "  ")).to.have.length(4);
    expect(searchThemes(themes, "zzz")).to.deep.equal([]);
  });

  it("falls back to every word of the phrase when the whole phrase matches nothing", () => {
    const list = [{ n: "grand bleu" }, { n: "bleu nuit" }];
    expect(searchBy(list, "bleu grand", (x) => [x.n])).to.deep.equal([list[0]]);
  });

  it("toggles a theme by key, and a label typed counts as its key", () => {
    const one = toggleTheme(themes, [], "intimite");
    expect(one).to.deep.equal(["intimite"]);
    expect(toggleTheme(themes, one, "fete")).to.deep.equal(["intimite", "fete"]);
    expect(toggleTheme(themes, one, "Intimité")).to.deep.equal([]);
  });

  it("adds a free word once, keeping what was typed, and never duplicates a known theme", () => {
    const one = addTheme(themes, ["fete"], "Brume");
    expect(one).to.deep.equal(["fete", "Brume"]);
    expect(addTheme(themes, one, "brume")).to.deep.equal(one);
    expect(addTheme(themes, one, "Fête")).to.deep.equal(one);
    expect(addTheme(themes, one, "   ")).to.deep.equal(one);
  });

  it("offers the free word only when nothing known matches and it is not chosen yet", () => {
    expect(canAddFree(themes, [], "brume")).to.equal(true);
    expect(canAddFree(themes, [], "inti")).to.equal(false);
    expect(canAddFree(themes, [], "")).to.equal(false);
    expect(canAddFree(themes, ["brume"], "Brume")).to.equal(false);
  });

  it("shows a known theme by label and a free word as typed", () => {
    expect(themeLabel(themes, "majeste")).to.equal("Majesté");
    expect(themeLabel(themes, "Brume")).to.equal("Brume");
  });
});
