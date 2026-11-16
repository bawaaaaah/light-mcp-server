import { expect, test, type Page } from "@playwright/test";

/**
 * T41, colour presets with favourites (docs/specs/presets-songs-notes.md, « Presets de couleur »): created on the Show
 * page in the show or the personal library, origin said, favourites ordered; picked in the look editor beside a colour
 * field; applied by hand from a fixture's panel, the Live's « Couleurs favorites » widget and a group fader; 44 px to the
 * finger on a tablet and a phone. Everything made here is removed at the end (other specs count faders and widgets).
 */
const PORT = Number(process.env.UI_PORT ?? 8799);

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}${/Failed to load resource/.test(m.text()) ? ` (${m.location().url})` : ""}`);
  });
  return errors;
}

async function login(page: Page): Promise<void> {
  await page.goto("/");
  await page.locator("form.pin-login select").selectOption("regisseur");
  await page.getByPlaceholder(/PIN/).fill("1234");
  await page.locator("form.pin-login button").click();
  await expect(page.locator("header.top")).toBeVisible();
}

/** A command with the master token (the desk), whatever the page's user may do. */
async function asDesk(page: Page, name: string, args: unknown = {}): Promise<unknown> {
  const res = await page.request.post(`/api/plugins/light/commands/${name}`, { headers: { authorization: "Bearer ui-test-token" }, data: args });
  return ((await res.json()) as { result: unknown }).result;
}

type Listed = { presets: { id: string; name: string; color: string; origin: string; favorite?: number }[]; favorites: string[] };
type Fader = { id: string; level: number; channels: { fixture: string; offset: number }[] };
type Dash = { id: string; widgets: { id: string; kind: string; x: number; y: number; w: number; h: number; target?: string }[] };
const listed = async (page: Page) => (await asDesk(page, "colour.preset.list")) as Listed;
const faders = async (page: Page) => (await asDesk(page, "fader.list")) as Fader[];

/** The two first RGB bars of the test show, grouped, and what to put back afterwards. */
async function setUp(page: Page): Promise<{ bars: string[]; done: () => Promise<void> }> {
  const fixtures = (await asDesk(page, "venue.fixture.list")) as { id: string; model: string }[];
  const bars = fixtures.filter((f) => /Bar 4/.test(f.model)).slice(0, 2).map((f) => f.id);
  expect(bars).toHaveLength(2);
  await asDesk(page, "group.put", { group: { id: "t41-face", name: "Face T41", members: { fixtures: bars } } });
  return {
    bars,
    done: async () => {
      await asDesk(page, "colour.release", { fade: 0 });
      // the manual colour layer creates no channel fader (decision of 2026-11-16)
      expect((await faders(page)).filter((f) => f.id.startsWith("panel-") && f.channels.some((c) => bars.includes(c.fixture)))).toEqual([]);
      for (const p of (await listed(page)).presets) if (p.name.endsWith("T41")) await asDesk(page, "colour.preset.delete", { id: p.id, scope: p.origin, force: true });
      // a personal one covered by a show copy: the copy went first, the library's now
      for (const p of (await listed(page)).presets) if (p.name.endsWith("T41")) await asDesk(page, "colour.preset.delete", { id: p.id, force: true });
      await asDesk(page, "group.delete", { id: "t41-face", force: true });
    },
  };
}

test("colour presets: the Show page creates them in the show or the library, says where, orders the favourites, edits and deletes (T41)", async ({ page }) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await login(page);
  const { done } = await setUp(page);
  try {
    await page.locator("nav.pages button", { hasText: "Show" }).click();
    const section = page.locator("section.colours");
    await section.scrollIntoViewIfNeeded();
    const form = section.getByRole("form", { name: "Nouveau preset de couleur" });
    // no name: said, nothing saved
    await form.getByRole("button", { name: "Créer" }).click();
    await expect(form.getByRole("alert")).toHaveText("Donner un nom à la couleur");
    await form.getByRole("textbox", { name: "Nom" }).fill("Ambre T41");
    await form.locator('input[type="color"]').fill("#ffaa00");
    await form.getByRole("button", { name: "Créer" }).click();
    await expect.poll(async () => (await listed(page)).presets.find((p) => p.name === "Ambre T41")?.origin).toBe("show");
    await expect(form.getByRole("textbox", { name: "Nom" })).toHaveValue("");
    await form.getByRole("textbox", { name: "Nom" }).fill("Bleu T41");
    await form.locator('input[type="color"]').fill("#2050ff");
    await form.getByRole("radio", { name: "Bibliothèque personnelle" }).check();
    await form.getByRole("button", { name: "Créer" }).click();
    await expect.poll(async () => (await listed(page)).presets.find((p) => p.name === "Bleu T41")?.origin).toBe("personal");
    const ambre = (await listed(page)).presets.find((p) => p.name === "Ambre T41")!;
    const bleu = (await listed(page)).presets.find((p) => p.name === "Bleu T41")!;
    // both favourites, in their order of creation; the origin said on each row
    const order = section.locator(".colour-favorites-order .colour-row");
    await expect(order).toHaveCount(2);
    await expect(order.nth(0)).toContainText("Ambre T41");
    await expect(section.locator(`.colour-list:not(.colour-favorites-order) [data-colour="${bleu.id}"]`)).toContainText("bibliothèque");
    await expect(section.locator(`.colour-list:not(.colour-favorites-order) [data-colour="${ambre.id}"]`)).toContainText("show");
    // moved up: Bleu first
    await section.getByRole("button", { name: "Monter Bleu T41 dans les favoris" }).click();
    await expect.poll(async () => (await listed(page)).favorites.filter((id) => id === ambre.id || id === bleu.id)).toEqual([bleu.id, ambre.id]);
    await expect(order.nth(0)).toContainText("Bleu T41");
    await page.screenshot({ path: "test-results/t41-show-desktop.png", fullPage: false });
    // renamed and recoloured where it is
    await section.getByRole("button", { name: "Modifier la couleur Ambre T41" }).click();
    const edit = section.getByRole("form", { name: "Modifier la couleur « Ambre T41 »" });
    await expect(edit.getByRole("textbox", { name: "Nom" })).toBeFocused();
    await edit.getByRole("textbox", { name: "Nom" }).fill("Orange T41");
    await edit.locator('input[type="color"]').fill("#ff7700");
    await edit.getByRole("button", { name: "Enregistrer" }).click();
    await expect.poll(async () => (await listed(page)).presets.find((p) => p.id === ambre.id)).toMatchObject({ name: "Orange T41", color: "#ff7700", origin: "show" });
    // taken out of the favourites, then deleted (asked first)
    await section.getByRole("button", { name: "Retirer Orange T41 des favoris" }).first().click();
    await expect.poll(async () => (await listed(page)).favorites.includes(ambre.id)).toBe(false);
    page.once("dialog", (d) => void d.accept());
    await section.getByRole("button", { name: "Supprimer la couleur Orange T41" }).click();
    await expect.poll(async () => (await listed(page)).presets.some((p) => p.id === ambre.id)).toBe(false);
    // on a phone: finger-sized and nothing spills sideways
    await page.setViewportSize({ width: 390, height: 844 });
    await section.scrollIntoViewIfNeeded();
    for (const b of await section.locator(".colour-row button").all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate<boolean>("document.documentElement.scrollWidth <= window.innerWidth + 1")).toBe(true);
    await page.screenshot({ path: "test-results/t41-show-phone.png", fullPage: false });
  } finally {
    await done();
  }
  expect(errors).toEqual([]);
});

test("colour presets: the look editor picks a saved colour beside a colour field (T41)", async ({ page }) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await login(page);
  const { done } = await setUp(page);
  const canvas = ((await asDesk(page, "look.get", { id: "checker" })) as { canvas: string }).canvas;
  await asDesk(page, "colour.preset.put", { preset: { name: "Rose T41", color: "#ff66aa" }, favorite: true });
  await asDesk(page, "look.put", { look: { id: "t41-plat", name: "T41 plat", canvas, technique: { kind: "plat", color: "#00ff00" } } });
  try {
    await page.locator("nav.pages button", { hasText: "Show" }).click();
    await page.getByRole("button", { name: "Modifier T41 plat" }).click();
    const editor = page.locator(".look-editor");
    const picker = editor.locator(".colour-with-presets").first().getByRole("button");
    await expect(picker).toHaveAttribute("aria-haspopup", "dialog");
    await picker.click();
    const menu = page.locator(".colour-menu");
    await expect(menu).toBeVisible();
    // the focus goes to the first favourite, and Tab out of the menu closes it
    await expect(menu.locator(".colour-favorites button").first()).toBeFocused();
    await page.screenshot({ path: "test-results/t41-look-editor-desktop.png" });
    await menu.locator(".colour-favorites").getByRole("button", { name: "Rose T41" }).click();
    await expect(menu).toHaveCount(0);
    await expect(picker).toBeFocused();
    await expect(editor.locator(".colour-with-presets input[type=color]").first()).toHaveValue("#ff66aa");
    // on a phone, the star is finger-sized
    await page.setViewportSize({ width: 390, height: 844 });
    expect((await picker.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await picker.boundingBox())!.width).toBeGreaterThanOrEqual(44);
  } finally {
    await page.keyboard.press("Escape");
    await asDesk(page, "look.delete", { id: "t41-plat", force: true });
    await done();
  }
  expect(errors).toEqual([]);
});

test("colour presets: applied by hand from a fixture's panel, the Live widget and a group fader; 44 px to the finger (T41)", async ({ page, browser }) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await login(page);
  const { bars, done } = await setUp(page);
  const dash = ((await asDesk(page, "dashboard.list")) as Dash[])[0]!;
  const bottom = dash.widgets.reduce((m, w) => Math.max(m, w.y + w.h), 0);
  await asDesk(page, "colour.preset.put", { preset: { name: "Rouge T41", color: "#ff0000" }, favorite: true });
  await asDesk(page, "colour.preset.put", { preset: { name: "Vert T41", color: "#00ff00" }, favorite: true });
  // the first bar as patched (what the list adds dropped): placed on the plan for its panel, put back at the end
  const { channels: _c, movable: _m, facing: _f, absent: _a, ...barPatch } = ((await asDesk(page, "venue.fixture.list")) as Record<string, unknown>[]).find((f) => f.id === bars[0])!;
  // the colour a fixture holds by hand (colour.applied), if any
  const colourOf = async (fixture: string) => ((await asDesk(page, "colour.applied")) as { fixtures: Record<string, string> }).fixtures[fixture];
  await asDesk(page, "dashboard.put", { dashboard: { ...dash, widgets: [...dash.widgets, { id: "t41-colours", kind: "colours", target: "t41-face", x: 0, y: bottom, w: 6, h: 2 }, { id: "t41-fader", kind: "group-fader", target: "t41-face", x: 6, y: bottom, w: 1, h: 4 }] } });
  try {
    await page.reload();
    const widget = page.getByTestId("colours-widget");
    await widget.scrollIntoViewIfNeeded();
    await expect(widget).toContainText("Face T41");
    await expect(widget.getByRole("button", { name: "Rendre la couleur · Face T41" })).toBeDisabled();
    await widget.getByRole("button", { name: "Appliquer Vert T41" }).click();
    await expect(page.getByTestId("lock-toast")).toContainText("« Vert T41 » : 2 appareils");
    // the colour held is marked (pressed, check mark), and « Rendre la couleur » is active only now
    await expect(widget.getByRole("button", { name: /Appliquer Vert T41/ })).toHaveAttribute("aria-pressed", "true");
    await expect(widget.getByRole("button", { name: /Appliquer Vert T41/ })).toContainText("✓");
    await expect(widget.getByRole("button", { name: "Rendre la couleur · Face T41" })).toBeEnabled();
    // no look lights them: said (decision C1)
    await expect(page.getByTestId("lock-toast")).toContainText("Aucun look n'éclaire");
    await expect.poll(() => colourOf(bars[1]!)).toBe("#00ff00");
    await page.screenshot({ path: "test-results/t41-widget-desktop.png" });
    // the group fader's colour button: every saved colour, the group coloured
    await page.getByRole("button", { name: "Couleur du groupe Face T41" }).click();
    await page.locator(".colour-menu .colour-favorites").getByRole("button", { name: "Rouge T41" }).click();
    await expect.poll(() => colourOf(bars[0]!)).toBe("#ff0000");
    // the group's menu marks it and gives it back
    await page.getByRole("button", { name: "Couleur du groupe Face T41" }).click();
    await expect(page.locator(".colour-menu .colour-favorites").getByRole("button", { name: /Rouge T41/ })).toHaveAttribute("aria-pressed", "true");
    await page.locator(".colour-menu").getByRole("button", { name: "Rendre la couleur" }).click();
    await expect.poll(() => colourOf(bars[0]!)).toBe(undefined);
    await widget.getByRole("button", { name: "Appliquer Rouge T41" }).click();
    await expect.poll(() => colourOf(bars[0]!)).toBe("#ff0000");
    // given back: the looks show again
    await widget.getByRole("button", { name: "Rendre la couleur · Face T41" }).click();
    await expect.poll(() => colourOf(bars[0]!)).toBe(undefined);
    for (const [name, viewport] of [
      ["tablet", { width: 1180, height: 820 }],
      ["phone", { width: 390, height: 844 }],
    ] as const) {
      const ctx = await browser.newContext({ hasTouch: true, isMobile: name === "phone", viewport, baseURL: `http://127.0.0.1:${PORT}`, locale: "fr-FR" });
      const touch = await ctx.newPage();
      const touchErrors = watchErrors(touch);
      await login(touch);
      const w = touch.getByTestId("colours-widget");
      await w.scrollIntoViewIfNeeded();
      for (const b of await w.getByRole("button").all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      const dot = touch.getByRole("button", { name: "Couleur du groupe Face T41" });
      await dot.scrollIntoViewIfNeeded();
      expect((await dot.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect((await dot.boundingBox())!.width).toBeGreaterThanOrEqual(44);
      await w.getByRole("button", { name: "Appliquer Rouge T41" }).tap();
      await expect.poll(() => colourOf(bars[1]!)).toBe("#ff0000");
      expect(await touch.evaluate<boolean>("document.documentElement.scrollWidth <= window.innerWidth + 1")).toBe(true);
      await touch.screenshot({ path: `test-results/t41-widget-${name}.png` });
      await asDesk(touch, "colour.release", { group: "t41-face" });
      expect(touchErrors).toEqual([]);
      await ctx.close();
    }
    // a fixture's panel (Venue page): its colour section applies to that fixture only
    await asDesk(page, "colour.release", { group: "t41-face" });
    await asDesk(page, "venue.fixture.put", { fixture: { ...barPatch, position: { x: 0, y: 1, z: 3 } } });
    await page.locator("nav.pages button", { hasText: "Lieu" }).click();
    const body = page.locator(`.stage-plan g.fixture[data-fixture="${bars[0]}"]`).first();
    await body.scrollIntoViewIfNeeded();
    await body.click();
    const panel = page.locator(".fixture-panel");
    await expect(panel).toBeVisible();
    const colours = panel.locator(".panel-colours");
    await colours.scrollIntoViewIfNeeded();
    await colours.getByRole("button", { name: "Appliquer Vert T41" }).click();
    await expect.poll(() => colourOf(bars[0]!)).toBe("#00ff00");
    expect(await colourOf(bars[1]!)).toBe(undefined);
    // marked held in the panel, its « Rendre la couleur » active
    await expect(colours.getByRole("button", { name: /Appliquer Vert T41/ })).toHaveAttribute("aria-pressed", "true");
    await expect(colours.getByRole("button", { name: "Rendre la couleur" })).toBeEnabled();
    await page.screenshot({ path: "test-results/t41-panel-desktop.png" });
  } finally {
    await asDesk(page, "dashboard.put", { dashboard: dash });
    await asDesk(page, "venue.fixture.put", { fixture: barPatch });
    await done();
  }
  expect(errors).toEqual([]);
});
