import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";

/**
 * T28 (docs/specs/ui-dashboards.md, « Éditeur d'effets » and « Zones »): looks by zone. In the look editor's move, the
 * « Zone » mode is one button per aiming zone (`move.at.zone`); the « Parcours » mode builds a path of stops (zone
 * buttons, a click on the small plan, « + Point »), reordered by ↑ / ↓ (keyboard, finger) and by dragging, with its
 * order, travel and heads; what look.put says (a trip across a no-aim zone) is shown before the editor closes. On the
 * Live, the « Zones » widget aims the heads at a zone by hand and « Rendre la main » releases them. Desktop, touch
 * tablet and phone; 44 px targets. Everything made here is put back at the end.
 */
const PORT = Number(process.env.UI_PORT ?? 8799);

type Dashboard = { id: string; widgets: { id: string; kind: string; x: number; y: number; w: number; h: number; target?: string }[] };
type Fixture = { id: string; name: string; position?: { x: number; y: number; z: number }; mount?: string };
type Stop = { zone?: string; point?: { x: number; y: number; z: number }; position?: string; target?: string; weight?: number };
type SavedPath = { stops: Stop[]; order: string; travel: number; heads: string };

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
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

async function desk(page: Page, name: string, args: unknown = {}): Promise<unknown> {
  const res = await page.request.post(`http://127.0.0.1:${PORT}/api/plugins/light/commands/${name}`, { headers: { authorization: "Bearer ui-test-token" }, data: args });
  return ((await res.json()) as { result: unknown }).result;
}

const JARDIN = { id: "t28-jardin", name: "T28 estrade gauche", type: "riser", polygon: [[-3, 3], [-2, 3], [-2, 4], [-3, 4]], aim: { height: 1, color: "#22c55e" } };
const COUR = { id: "t28-cour", name: "T28 estrade droite", type: "riser", polygon: [[2, 3], [3, 3], [3, 4], [2, 4]], aim: { color: "#3b82f6" } };
const FOND = { id: "t28-fond", name: "T28 fond", type: "stage", polygon: [[-0.5, 5], [0.5, 5], [0.5, 6], [-0.5, 6]], aim: { color: "#e879f9" } };
/** A lectern between the two risers: a trip from one to the other crosses it. */
const PUPITRE = { id: "t28-pupitre", name: "T28 pupitre", type: "stage", polygon: [[-1.5, 3], [1.5, 3], [1.5, 4], [-1.5, 4]], noAim: true };
const ZONES = [JARDIN, COUR, FOND];
const LOOK = "t28-look";

/** The moving head hung over the stage, a canvas on it, the zones and a look; everything put back after. */
async function withStage(page: Page, body: () => Promise<void>, lectern = false): Promise<void> {
  const spot = ((await desk(page, "venue.fixture.list")) as Fixture[]).find((f) => f.id === "spot")!;
  await desk(page, "venue.fixture.put", { fixture: { ...spot, position: { x: 0, y: 1, z: 5 }, mount: "hung" } });
  await desk(page, "venue.canvas.put", { canvas: { id: "t28-canvas", name: "T28 lyre", topology: "line", cells: 1, render: [{ from: 0, to: 0, targets: [{ fixture: "spot", head: -1 }] }] } });
  for (const z of [...ZONES, ...(lectern ? [PUPITRE] : [])]) await desk(page, "stage.zone.put", { zone: z });
  await desk(page, "look.put", { look: { id: LOOK, name: "T28 lyres", canvas: "t28-canvas", technique: { kind: "plat", color: "#ffffff" }, move: { shape: "cercle" } } });
  try {
    await body();
  } finally {
    await desk(page, "look.stop", { id: LOOK });
    await desk(page, "look.delete", { id: LOOK, force: true });
    await desk(page, "position.home", {});
    for (const z of [...ZONES, PUPITRE]) await desk(page, "stage.zone.delete", { id: z.id, force: true });
    await desk(page, "venue.canvas.delete", { id: "t28-canvas", force: true });
    await desk(page, "venue.fixture.put", { fixture: spot });
  }
}

const savedMove = async (page: Page) => ((await desk(page, "look.get", { id: LOOK })) as { move: { shape: string; at?: { zone?: string; path?: SavedPath } } }).move;

async function openEditor(page: Page): Promise<Locator> {
  await page.locator("nav.pages button", { hasText: "Show" }).click();
  await page.getByRole("button", { name: "Modifier T28 lyres" }).click();
  const editor = page.locator(".look-editor");
  await expect(editor).toBeVisible();
  return editor;
}

const stopNames = (editor: Locator) => editor.getByTestId("path-stop").locator(".path-stop-name > span:first-child").allTextContents();

async function minTarget(loc: Locator): Promise<number> {
  const boxes = await Promise.all((await loc.all()).map((l) => l.boundingBox()));
  return Math.min(...boxes.map((b) => Math.min(b!.width, b!.height)));
}

test("T28 editor: « Zone » aims the look at a zone, one pressed button per aiming zone", async ({ page }) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await login(page);
  await withStage(page, async () => {
    const editor = await openEditor(page);
    await editor.getByTestId("move-aim-zone").click();
    await expect(editor.getByTestId("move-aim-zone")).toHaveAttribute("aria-checked", "true");
    const buttons = editor.getByTestId("look-zone-buttons");
    // Save before a zone is picked: refused, said, the focus on the buttons
    await editor.getByRole("button", { name: "Enregistrer", exact: true }).click();
    await expect(editor.locator(".error")).toContainText("Choisir la zone visée");
    await buttons.getByRole("button", { name: /T28 estrade droite/ }).click();
    await expect(buttons.getByRole("button", { name: /T28 estrade droite/ })).toHaveAttribute("aria-pressed", "true");
    await expect(buttons.getByRole("button", { name: /T28 fond/ })).toHaveAttribute("aria-pressed", "false");
    await editor.getByTestId("look-zone-height").fill("0.5");
    await page.screenshot({ path: "test-results/t28-look-zone.png" });
    await editor.getByRole("button", { name: "Enregistrer", exact: true }).click();
    await expect(editor).toHaveCount(0);
    expect((await savedMove(page)).at).toEqual({ zone: COUR.id, height: 0.5 });
    // reopened: the mode and the zone come back
    const again = await openEditor(page);
    await expect(again.getByTestId("move-aim-zone")).toHaveAttribute("aria-checked", "true");
    await expect(again.getByTestId("look-zone-buttons").getByRole("button", { name: /T28 estrade droite/ })).toHaveAttribute("aria-pressed", "true");
    await again.getByRole("button", { name: "Fermer", exact: true }).click();
  });
  expect(errors).toEqual([]);
});

test("T28 editor: « Parcours » builds stops, reorders them (↑ / ↓, keyboard, drag), saves and reopens them", async ({ page }) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await login(page);
  await withStage(page, async () => {
    const editor = await openEditor(page);
    await editor.getByTestId("move-aim-path").click();
    await expect(editor.getByTestId("path-stops-none")).toBeVisible();
    // the shape is fixed along a path
    await expect(editor.locator("select").filter({ has: page.locator('option[value="cercle"]') })).toBeDisabled();
    const add = editor.getByTestId("path-zone-add");
    await add.getByRole("button", { name: "Ajouter l'arrêt T28 estrade gauche" }).click();
    await add.getByRole("button", { name: "Ajouter l'arrêt T28 estrade droite" }).click();
    // a point by its metres
    await editor.getByTestId("path-add-point").click();
    await editor.getByTestId("path-point-x").fill("1");
    await editor.getByTestId("path-point-y").fill("2");
    await editor.getByTestId("path-point-add").click();
    // a click on the plan, in an aiming zone: that zone
    const plan = editor.getByTestId("path-plan");
    await plan.scrollIntoViewIfNeeded();
    const box = (await plan.boundingBox())!;
    const spot = await plan.evaluate((svg) => {
      const g = [...svg.querySelectorAll("g.path-plan-zone")].find((x) => x.querySelector("text")?.textContent === "T28 fond")!;
      const r = g.querySelector("polygon")!.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    expect(spot.x).toBeGreaterThan(box.x);
    await page.mouse.click(spot.x, spot.y);
    expect(await stopNames(editor)).toEqual(["Zone « T28 estrade gauche »", "Zone « T28 estrade droite »", "Point (1 ; 2 ; 0)", "Zone « T28 fond »"]);
    // ↑ with the mouse
    await editor.getByRole("button", { name: "Monter l'arrêt 4" }).click();
    expect((await stopNames(editor))[2]).toBe("Zone « T28 fond »");
    // the focus follows the stop moved (its ↑ in its new row)
    await expect(editor.getByRole("button", { name: "Monter l'arrêt 3" })).toBeFocused();
    // ↓ from the keyboard: the focus follows the stop
    await editor.getByRole("button", { name: "Descendre l'arrêt 1" }).focus();
    await page.keyboard.press("Enter");
    expect((await stopNames(editor)).slice(0, 2)).toEqual(["Zone « T28 estrade droite »", "Zone « T28 estrade gauche »"]);
    await expect(editor.getByRole("button", { name: "Descendre l'arrêt 2" })).toBeFocused();
    // dragging a row onto another
    const rows = editor.getByTestId("path-stop");
    await rows.nth(3).dragTo(rows.nth(0));
    expect((await stopNames(editor))[0]).toBe("Point (1 ; 2 ; 0)");
    // remove one
    await editor.getByRole("button", { name: "Retirer l'arrêt 4" }).click();
    await expect(rows).toHaveCount(3);
    // order and heads: « chacune » only in a drawn order
    await expect(editor.getByTestId("path-heads-chacune")).toHaveAttribute("aria-disabled", "true");
    await editor.getByTestId("path-order").selectOption("random");
    await expect(editor.getByTestId("path-heads-chacune")).not.toHaveAttribute("aria-disabled", "true");
    await editor.getByTestId("path-heads-chacune").click();
    await expect(editor.getByTestId("path-heads-chacune")).toHaveAttribute("aria-checked", "true");
    await editor.getByTestId("path-travel").fill("0.7");
    await editor.getByTestId("path-plan").scrollIntoViewIfNeeded();
    await page.screenshot({ path: "test-results/t28-look-path.png" });
    await editor.getByRole("button", { name: "Enregistrer", exact: true }).click();
    await expect(editor).toHaveCount(0);
    const move = await savedMove(page);
    expect(move.shape).toBe("fixe");
    expect(move.at?.path).toEqual({ stops: [{ point: { x: 1, y: 2, z: 0 } }, { zone: COUR.id }, { zone: JARDIN.id }], order: "random", travel: 0.7, heads: "chacune" });
    const again = await openEditor(page);
    await expect(again.getByTestId("move-aim-path")).toHaveAttribute("aria-checked", "true");
    expect(await stopNames(again)).toEqual(["Point (1 ; 2 ; 0)", "Zone « T28 estrade droite »", "Zone « T28 estrade gauche »"]);
    await again.getByRole("button", { name: "Fermer", exact: true }).click();
  });
  expect(errors).toEqual([]);
});

test("T28 editor: a trip crossing a no-aim zone is said in the editor and again at save, before closing", async ({ page }) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await login(page);
  await withStage(
    page,
    async () => {
      const editor = await openEditor(page);
      await editor.getByTestId("move-aim-path").click();
      const add = editor.getByTestId("path-zone-add");
      await add.getByRole("button", { name: "Ajouter l'arrêt T28 estrade gauche" }).click();
      await add.getByRole("button", { name: "Ajouter l'arrêt T28 estrade droite" }).click();
      await expect(editor.getByTestId("path-warnings")).toContainText("T28 pupitre");
      await editor.getByRole("button", { name: "Enregistrer", exact: true }).click();
      const saved = editor.getByTestId("look-saved-warnings");
      await expect(saved).toContainText("Look enregistré");
      await expect(saved).toContainText("T28 pupitre");
      await expect(editor.getByTestId("look-saved-close")).toBeFocused();
      await page.screenshot({ path: "test-results/t28-look-warnings.png" });
      await page.keyboard.press("Enter");
      await expect(editor).toHaveCount(0);
      expect((await savedMove(page)).at?.path?.stops).toHaveLength(2);
    },
    true,
  );
  expect(errors).toEqual([]);
});

/** A widget added at the bottom of the first dashboard for `body`, the dashboard put back after. */
async function withZonesWidget(page: Page, body: (widget: Locator) => Promise<void>): Promise<void> {
  const dash = ((await desk(page, "dashboard.list")) as Dashboard[])[0]!;
  const bottom = dash.widgets.reduce((m, w) => Math.max(m, w.y + w.h), 0);
  await desk(page, "dashboard.put", { dashboard: { ...dash, widgets: [...dash.widgets, { id: "t28-zones", kind: "zones", x: 0, y: bottom, w: 6, h: 2 }] } });
  try {
    await page.reload();
    const widget = page.getByTestId("zones-widget");
    await widget.scrollIntoViewIfNeeded();
    await body(widget);
  } finally {
    await desk(page, "dashboard.put", { dashboard: dash });
  }
}

const aimedOf = async (page: Page) => ((await desk(page, "position.list")) as { id: string; aimed?: string; manual: unknown }[]).find((h) => h.id === "spot");

test("T28 Live « Zones »: a press aims the heads by hand (pressed), « Rendre la main » releases them", async ({ page }) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await login(page);
  await withStage(page, async () => {
    await withZonesWidget(page, async (widget) => {
      const cour = widget.getByRole("button", { name: /Viser T28 estrade droite/ });
      await expect(cour).toHaveAttribute("aria-pressed", "false");
      await expect(widget.getByTestId("zones-release")).toBeDisabled();
      await cour.click();
      await expect(cour).toHaveAttribute("aria-pressed", "true");
      expect((await aimedOf(page))?.aimed).toBe(COUR.id);
      await widget.screenshot({ path: "test-results/t28-zones-widget.png" });
      // another zone: it is the one pressed now
      await widget.getByRole("button", { name: /Viser T28 fond/ }).click();
      await expect(widget.getByRole("button", { name: /Viser T28 fond/ })).toHaveAttribute("aria-pressed", "true");
      await expect(cour).toHaveAttribute("aria-pressed", "false");
      await widget.getByTestId("zones-release").click();
      await expect(widget.getByRole("button", { name: /Viser T28 fond/ })).toHaveAttribute("aria-pressed", "false");
      expect((await aimedOf(page))?.manual).toBeNull();
      expect(await minTarget(widget.getByRole("button"))).toBeGreaterThanOrEqual(44);
    });
  });
  expect(errors).toEqual([]);
});

async function touchPage(browser: Browser, viewport: { width: number; height: number }, mobile: boolean) {
  const ctx = await browser.newContext({ hasTouch: true, isMobile: mobile, viewport, baseURL: `http://127.0.0.1:${PORT}`, locale: "fr-FR" });
  return { ctx, page: await ctx.newPage() };
}

for (const [name, viewport, mobile] of [
  ["tablet", { width: 1180, height: 820 }, false],
  ["phone", { width: 390, height: 844 }, true],
] as const) {
  test(`T28 editor on a ${name}: stops tapped and reordered by finger, 44 px targets, nothing wider than the screen`, async ({ browser }) => {
    const { ctx, page } = await touchPage(browser, viewport, mobile);
    const errors = watchErrors(page);
    try {
      await login(page);
      await withStage(page, async () => {
        const editor = await openEditor(page);
        await editor.getByTestId("move-aim-path").tap();
        const add = editor.getByTestId("path-zone-add");
        await add.getByRole("button", { name: "Ajouter l'arrêt T28 estrade gauche" }).tap();
        await add.getByRole("button", { name: "Ajouter l'arrêt T28 fond" }).tap();
        await editor.getByRole("button", { name: "Monter l'arrêt 2" }).tap();
        expect(await stopNames(editor)).toEqual(["Zone « T28 fond »", "Zone « T28 estrade gauche »"]);
        expect(await minTarget(editor.getByTestId("path-stop").getByRole("button"))).toBeGreaterThanOrEqual(44);
        expect(await minTarget(add.getByRole("button"))).toBeGreaterThanOrEqual(44);
        expect(await minTarget(editor.getByTestId("move-aim-path"))).toBeGreaterThanOrEqual(44);
        const pathBox = (await editor.getByTestId("path-editor").boundingBox())!;
        expect(pathBox.x + pathBox.width).toBeLessThanOrEqual(viewport.width + 1);
        await editor.getByTestId("path-stops").scrollIntoViewIfNeeded();
        await page.screenshot({ path: `test-results/t28-look-path-${name}.png` });
        await editor.getByRole("button", { name: "Enregistrer", exact: true }).tap();
        await expect(editor).toHaveCount(0);
        expect((await savedMove(page)).at?.path?.stops).toEqual([{ zone: FOND.id }, { zone: JARDIN.id }]);
      });
    } finally {
      await ctx.close();
    }
    expect(errors).toEqual([]);
  });
}
