import { expect, test, type Page } from "@playwright/test";

/** Collects page errors and console errors; every test asserts there are none. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  return errors;
}

async function login(page: Page, pin = "1234"): Promise<void> {
  await page.goto("/");
  await page.getByPlaceholder(/PIN/).fill(pin);
  await page.getByRole("button", { name: /Entrer|Enter/ }).click();
  await expect(page.locator("header.top")).toBeVisible();
}

/** Reads a universe through the API with the session token of the page. */
async function dmx(page: Page, universe = 1): Promise<number[]> {
  return page.evaluate(async (u) => {
    const token = sessionStorage.getItem("token");
    const res = await fetch("/api/plugins/light/commands/dmx.get", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ universe: u }) });
    return ((await res.json()) as { result: { values: number[] } }).result.values;
  }, universe);
}

/** Runs a command with the session token of the page. */
async function api(page: Page, name: string, args: unknown = {}): Promise<unknown> {
  return page.evaluate(
    async ([n, a]) => {
      const res = await fetch(`/api/plugins/light/commands/${n}`, { method: "POST", headers: { authorization: `Bearer ${sessionStorage.getItem("token")}`, "content-type": "application/json" }, body: JSON.stringify(a) });
      return ((await res.json()) as { result: unknown }).result;
    },
    [name, args] as const,
  );
}

test("refuses a wrong PIN, then logs in", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/");
  await page.getByPlaceholder(/PIN/).fill("0000");
  await page.getByRole("button", { name: /Entrer|Enter/ }).click();
  await expect(page.getByText(/PIN incorrect|Wrong PIN/)).toBeVisible();
  await page.getByPlaceholder(/PIN/).fill("1234");
  await page.getByRole("button", { name: /Entrer|Enter/ }).click();
  await expect(page.locator(".role")).toHaveText("Régisseur");
  await expect(page.locator(".dot.ok")).toBeVisible(); // WebSocket connected
  expect(errors.filter((e) => !e.includes("401"))).toEqual([]);
});

test("live dashboard: a look button lights the fixtures, panic blacks out", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const checker = page.locator("button.look", { hasText: "Checker" });
  await expect(checker).toBeVisible();
  await checker.click();
  await expect(checker).toHaveClass(/on/);
  await expect.poll(async () => (await dmx(page)).slice(0, 30).some((v) => v > 0)).toBe(true);
  // exclusive group: Palette releases Checker
  await page.locator("button.look", { hasText: "Palette" }).click();
  await expect(checker).not.toHaveClass(/on/);
  await page.getByRole("button", { name: "Panic neutre" }).first().click();
  await expect(page.locator("button.blackout")).toHaveText("Blackout actif");
  await expect.poll(async () => (await dmx(page)).every((v) => v === 0)).toBe(true);
  await page.locator("button.blackout").click();
  await expect(page.locator("button.blackout")).toHaveText("Blackout");
  await page.screenshot({ path: "test-results/live.png", fullPage: true });
  expect(errors).toEqual([]);
});

test("group fader drives the master and the dimmer", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const fader = page.locator(".cell .fader input[type=range]").first();
  await expect(fader).toBeVisible();
  await fader.fill("500"); // 50 %
  await expect(page.locator(".cell .fader .value").first()).toContainText("50%");
  await expect.poll(async () => (await dmx(page))[0]).toBe(128); // bar dimmer channel
  await fader.fill("1000");
  expect(errors).toEqual([]);
});

test("DMX console: shows live values and parks a channel", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.getByRole("button", { name: "Console DMX" }).click();
  await expect(page.locator(".ch")).toHaveCount(512);
  const ch10 = page.locator(".ch").nth(9);
  await ch10.locator("input").fill("200");
  await expect(ch10).toHaveClass(/parked/);
  await expect(ch10.locator(".val")).toHaveText("200");
  await page.getByRole("button", { name: "Tout relâcher" }).click();
  await expect(ch10).not.toHaveClass(/parked/);
  expect(errors).toEqual([]);
});

test("songs page: sections start their looks", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.getByRole("button", { name: "Chants" }).click();
  await expect(page.getByText("Chant test")).toBeVisible();
  await page.locator("button.look", { hasText: "Refrain" }).click();
  await expect(page.locator("button.look", { hasText: "Refrain" })).toHaveClass(/on/);
  await page.getByRole("button", { name: "Feuille de conduite" }).click();
  await expect(page.locator("pre.monitor")).toContainText("Chant test");
  expect(errors).toEqual([]);
});

test("every page loads without errors, in French and English", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page, "9999"); // admin: Settings shows the roles
  for (const name of ["Show", "Lieu", "MIDI", "OSC", "Import", "Notes", "Réglages", "Chants", "Console DMX", "Live"]) {
    await page.locator("header nav button", { hasText: name }).first().click();
    await page.waitForTimeout(150);
    await page.screenshot({ path: `test-results/page-${name.replace(/\s/g, "-")}.png`, fullPage: true });
  }
  await page.locator("header nav button", { hasText: "Réglages" }).click();
  await expect(page.locator(".settings table").getByText("Régisseur")).toBeVisible();
  await page.locator("header nav button", { hasText: "Notes" }).click();
  await expect(page.getByText("note de test")).toBeVisible();
  await page.locator("header nav button", { hasText: "Import" }).click();
  await expect(page.getByText("Choisir un fichier .qxw")).toBeVisible();
  await page.locator("header nav button", { hasText: "OSC" }).click();
  await expect(page.getByText("/light/panic")).toBeVisible();
  await page.locator("header select").selectOption("en");
  await expect(page.locator("header nav button", { hasText: "Settings" })).toBeVisible();
  await page.locator("header select").selectOption("fr");
  expect(errors).toEqual([]);
});

test("XY pad moves the heads, ⟲ gives them back to the looks", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const pad = page.locator(".xy .pad");
  await expect(pad).toBeVisible();
  const box = (await pad.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.75, box.y + box.height * 0.25);
  await expect(page.locator(".xy small")).toHaveText("75 / 75");
  await expect.poll(async () => (await dmx(page, 2)).slice(0, 3)).toEqual([191, expect.any(Number), 191]); // pan, pan fine, tilt
  await page.locator(".xy button").click();
  await expect.poll(async () => (await dmx(page, 2))[0]).toBe(128); // back to the centre
  await page.screenshot({ path: "test-results/xy.png", fullPage: true });
  expect(errors).toEqual([]);
});

test("look editor: create with a live preview, then paint steps", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await api(page, "look.stopall");
  await page.locator("header nav button", { hasText: "Show" }).click();
  await page.getByRole("button", { name: "+ Nouveau look" }).click();
  const editor = page.locator(".look-editor");
  await editor.getByLabel("Nom", { exact: true }).fill("Mon damier");
  await editor.getByLabel("Technique").selectOption("damier");
  await expect(editor.locator(".fields .colors input.swatch")).toHaveCount(2);
  await expect(editor.locator(".preview .cell")).toHaveCount(8); // server preview on the 8-cell canvas
  await expect(editor.locator(".preview .cell.free")).toHaveCount(0);
  await page.screenshot({ path: "test-results/look-editor.png", fullPage: true });
  await editor.getByRole("button", { name: "Enregistrer et lancer" }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.locator("button.look", { hasText: "Mon damier" })).toHaveClass(/on/);
  await expect.poll(async () => (await dmx(page)).slice(3, 15).some((v) => v > 0)).toBe(true);

  // edit: raw steps, first cell painted « éteint »
  await page.getByRole("button", { name: "Modifier Mon damier" }).click();
  await editor.getByLabel("Technique").selectOption("pas");
  await expect(editor.locator(".steps-editor .step-row .cell")).toHaveCount(8);
  await editor.getByLabel("éteint").check();
  await editor.locator(".steps-editor .step-row .cell").first().dispatchEvent("pointerdown");
  await editor.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(editor).toHaveCount(0);
  const look = (await api(page, "look.list")) as { id: string; technique: { kind: string; steps: string[][] } }[];
  const mine = look.find((l) => l.id === "mon-damier")!;
  expect(mine.technique.kind).toBe("pas");
  expect(mine.technique.steps[0]![0]).toBe("-");
  await expect.poll(async () => (await dmx(page)).slice(3, 9)).toEqual([0, 0, 0, 255, 255, 255]); // head 1 off, head 2 white
  await api(page, "look.stopall");
  expect(errors).toEqual([]);
});

test("automatic presets light a venue in one click", async ({ page }) => {
  const errors = watchErrors(page);
  page.on("dialog", (d) => void d.accept());
  await login(page);
  await page.locator("header nav button", { hasText: "Show" }).click();
  await page.getByRole("button", { name: "★ Presets automatiques" }).click();
  const auto = page.locator("button.look", { hasText: "Blanc chaud" });
  await expect(auto).toBeVisible();
  await auto.click();
  await expect(auto).toHaveClass(/on/);
  await expect.poll(async () => (await dmx(page)).slice(3, 15).some((v) => v > 0)).toBe(true);
  await api(page, "look.stopall");
  expect(errors).toEqual([]);
});

test("song editor: sections, timeline, grid fill, then a setlist", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.locator("header nav button", { hasText: "Chants" }).click();
  await page.getByRole("button", { name: "+ Nouveau chant" }).click();
  const editor = page.locator(".song-editor");
  await editor.getByLabel("Titre").fill("Mon chant");
  await editor.getByLabel("Ambiances").fill("joie, louange");
  await editor.getByLabel("Ambiances").blur();
  await editor.getByLabel("look 1").selectOption("checker");
  await editor.getByRole("button", { name: "+ Section" }).click();
  await editor.getByLabel("Section 2", { exact: true }).fill("Refrain");
  await editor.locator("table.sections tbody tr").nth(1).locator("input[type=number]").first().fill("16");
  await expect(editor.locator(".timeline .block")).toHaveCount(2);
  await expect(editor.locator(".timeline .block.empty")).toHaveText("Refrain"); // no look yet
  await page.screenshot({ path: "test-results/song-editor.png", fullPage: true });
  await editor.getByRole("button", { name: "Remplir la grille" }).click();
  await expect(editor.locator(".timeline .block.empty")).toHaveCount(0); // the grid proposed a look
  await editor.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(editor).toHaveCount(0);
  const songs = (await api(page, "song.list")) as { id: string; sections: { name: string; look?: string; bars: number }[] }[];
  const mine = songs.find((x) => x.id === "mon-chant")!;
  expect(mine.sections.map((x) => [x.name, x.bars])).toEqual([["Intro", 8], ["Refrain", 16]]);
  expect(mine.sections[0]!.look).toBe("checker");
  expect(mine.sections[1]!.look).toBeTruthy();
  await expect(page.locator("section.song", { hasText: "Mon chant" }).locator("button.look")).toHaveCount(2);

  await page.getByRole("button", { name: "+ Nouvelle setlist" }).click();
  const sl = page.locator(".setlist-editor");
  await sl.getByLabel("Nom").fill("Ma setlist");
  await sl.getByLabel("Ajouter un chant").selectOption("mon-chant");
  await sl.getByLabel("Ajouter un chant").selectOption("chant");
  await sl.locator(".setlist-songs li").nth(1).getByRole("button", { name: "↑" }).click();
  await sl.getByRole("button", { name: "Enregistrer" }).click();
  await expect(sl).toHaveCount(0);
  const lists = (await api(page, "setlist.list")) as { id: string; songs: string[] }[];
  expect(lists.find((l) => l.id === "ma-setlist")!.songs).toEqual(["chant", "mon-chant"]);
  expect(errors).toEqual([]);
});

test("timeline action: placed in the song editor, fired by ▶ playback", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.locator("header nav button", { hasText: "Chants" }).click();
  await page.getByRole("button", { name: "Modifier Chant test" }).click();
  const editor = page.locator(".song-editor");
  await editor.getByRole("button", { name: "+ Action" }).click();
  await editor.getByLabel("Action 1").selectOption("group.level");
  await editor.getByLabel("Cible 1").selectOption("master");
  await editor.getByLabel("Valeur 1").fill("50");
  await editor.locator("table.cues tbody tr").first().locator("input[type=number]").nth(1).fill("2"); // beat 2 of bar 1
  await expect(editor.locator(".timeline .cue-mark")).toHaveCount(1);
  await page.screenshot({ path: "test-results/song-cues.png", fullPage: true });
  await editor.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await page.getByRole("button", { name: "Lecture Chant test" }).click();
  await expect(page.locator("section.song.current .position")).toContainText("mesure 1.");
  await expect.poll(async () => ((await api(page, "group.list")) as { id: string; master?: { level: number } }[]).find((g) => g.id === "master")?.master?.level).toBe(0.5);
  await page.getByRole("button", { name: "Arrêt Chant test" }).click();
  await api(page, "group.level", { id: "master", level: 1 });
  expect(errors).toEqual([]);
});

test("storyboard of a song, shown and downloadable", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.locator("header nav button", { hasText: "Chants" }).click();
  await page.getByRole("button", { name: "Planche Chant test" }).click();
  const board = page.locator(".board-view svg");
  await expect(board).toBeVisible();
  await expect(board.locator("g.section")).toHaveCount(2);
  await expect(board).toContainText("« début »");
  await expect(page.locator(".board a", { hasText: "SVG" })).toHaveAttribute("download", "Chant test.svg");
  await page.screenshot({ path: "test-results/board.png", fullPage: true });
  expect(errors).toEqual([]);
});

test("live 2D stage preview follows the output", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await api(page, "look.stopall");
  await page.locator("header nav button", { hasText: "Lieu" }).click();
  const plan = page.locator(".stage-plan svg");
  await expect(plan).toBeVisible();
  await expect(plan.locator("g.fixture")).toHaveCount(3);
  await expect(page.locator(".stage-plan .hint")).toContainText("3 projecteur(s) sans position");
  const bar = plan.locator('g.fixture[data-fixture="bar-0"] rect');
  await expect(bar.first()).toHaveAttribute("fill", "#000000");
  await api(page, "look.go", { id: "masks" });
  await expect.poll(async () => (await bar.evaluateAll((rs) => rs.map((r) => r.getAttribute("fill")))).some((f) => f !== "#000000")).toBe(true); // lit, live
  await page.screenshot({ path: "test-results/stage-preview.png", fullPage: true });
  // a modelled stage: zones and positions
  await api(page, "stage.zone.put", { zone: { id: "scene", name: "Scène", type: "stage", polygon: [[-4, 0], [4, 0], [4, 5], [-4, 5]] } });
  await api(page, "stage.zone.put", { zone: { id: "pupitre", name: "Pupitre", type: "riser", polygon: [[2.5, 0.5], [3.5, 0.5], [3.5, 1.5], [2.5, 1.5]], protected: true } });
  const fixtures = (await api(page, "venue.fixture.list")) as { id: string }[];
  for (const f of fixtures.filter((x) => x.id.startsWith("bar-"))) {
    await api(page, "venue.fixture.put", { fixture: { ...f, position: { x: f.id === "bar-0" ? -2 : 2, y: 4.5, z: 0.2 } } });
  }
  await page.reload();
  await expect(page.locator(".stage-plan svg g.zone")).toHaveCount(2);
  await expect(page.locator(".stage-plan .hint")).toContainText("1 projecteur(s) sans position");
  await page.screenshot({ path: "test-results/stage-preview-placed.png", fullPage: true });
  await page.getByLabel("Viser avec les lyres").check();
  await plan.click({ position: { x: 300, y: 60 } });
  await expect(page.locator(".venue > .error")).toContainText("position sur la scène inconnue"); // the spot has no position yet
  await api(page, "look.stopall");
  expect(errors).toEqual([]);
});

test("dashboard editor: add a label widget and save", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.getByRole("button", { name: "✎" }).click();
  await page.locator(".dashboards .bar select").selectOption("label");
  await page.locator(".editor input[placeholder=label]").fill("Mon repère");
  await page.getByRole("button", { name: "✔" }).click();
  await expect(page.locator(".w-label", { hasText: "Mon repère" })).toBeVisible();
  await page.reload();
  await expect(page.locator(".w-label", { hasText: "Mon repère" })).toBeVisible(); // saved on the server
  expect(errors).toEqual([]);
});

test("output standby: visible everywhere, then take over", async ({ page }) => {
  const errors = watchErrors(page);
  page.on("dialog", (d) => void d.accept());
  await login(page, "9999");
  await page.locator("header nav button", { hasText: "Réglages" }).click();
  await page.getByRole("button", { name: "⏸ Mettre en veille" }).click();
  await expect(page.locator("header .badge.standby")).toContainText("Veille");
  await page.locator("header nav button", { hasText: "Live" }).click();
  await expect(page.locator("header .badge.standby")).toBeVisible(); // on every page
  await page.screenshot({ path: "test-results/standby.png" });
  await page.locator("header nav button", { hasText: "Réglages" }).click();
  await page.getByRole("button", { name: "▶ Reprendre la main" }).click();
  await expect(page.locator("header .badge.standby")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("self-test with the real-time cadence of every look", async ({ page }) => {
  test.setTimeout(60_000);
  const errors = watchErrors(page);
  await login(page);
  await page.locator("header nav button", { hasText: "Import" }).click();
  await page.getByLabel("Mesurer aussi la cadence").check();
  await page.getByRole("button", { name: "Lancer l'auto-test" }).click();
  const table = page.locator("table.cadence");
  await expect(table).toBeVisible({ timeout: 40_000 });
  await expect(table.locator("caption")).toContainText("120 BPM");
  expect(await table.locator("tr").count()).toBeGreaterThanOrEqual(4);
  await expect(table.locator("tr.error")).toHaveCount(0);
  await page.screenshot({ path: "test-results/selftest-cadence.png", fullPage: true });
  expect(errors).toEqual([]);
});

test("a volunteer cannot write the show", async ({ page }) => {
  await login(page, "5678");
  await page.getByRole("button", { name: "Console DMX" }).click();
  await page.locator(".ch").nth(3).locator("input").fill("90");
  await expect(page.locator(".console .error")).toContainText("droit requis"); // refusal is shown
  await expect(page.locator(".ch").nth(3)).not.toHaveClass(/parked/); // and rolled back
  const parked = await page.evaluate(async () => {
    const res = await fetch("/api/plugins/light/commands/dmx.get", { method: "POST", headers: { authorization: `Bearer ${sessionStorage.getItem("token")}`, "content-type": "application/json" }, body: JSON.stringify({ universe: 1 }) });
    return ((await res.json()) as { result: { parked: Record<string, number> } }).result.parked;
  });
  expect(parked["4"]).toBeUndefined();
});
