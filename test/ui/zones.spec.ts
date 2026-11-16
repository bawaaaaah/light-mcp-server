import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * T27, aiming zones drawn on the plan (docs/specs/venue-fixtures-stage.md, « Zones »): a rectangle, an ellipse and a
 * polygon drawn with the mouse, a finger and the keyboard become zones; the menu edits an ellipse by its axes and makes
 * a zone an aiming one; in « Viser », a click in an aiming zone aims at its aiming point (Alt: the exact point); a zone a
 * rule uses is deleted only once the question says so. Every zone made here is deleted at the end (other specs count them).
 */
const PORT = Number(process.env.UI_PORT ?? 8799);

type Zone = { id: string; name: string; polygon: [number, number][]; aim?: { height: number; point?: [number, number]; color?: string }; outline?: { kind: string; cx?: number; cy?: number; rx?: number; ry?: number } };

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

async function api(page: Page, name: string, args: unknown = {}): Promise<unknown> {
  return page.evaluate(
    async ([n, a]) => {
      const res = await fetch(`/api/plugins/light/commands/${n}`, { method: "POST", headers: { authorization: `Bearer ${sessionStorage.getItem("token")}`, "content-type": "application/json" }, body: JSON.stringify(a) });
      return ((await res.json()) as { result: unknown }).result;
    },
    [name, args] as const,
  );
}

const zones = async (page: Page) => (await api(page, "stage.zone.list")) as Zone[];
const zoneNamed = async (page: Page, name: string) => (await zones(page)).find((z) => z.name === name);

/** The reference zone the tests measure the plan with: 8 × 5 m, X −4..4, Y 0..5. */
const REF = { id: "t27-ref", name: "Repère T27", type: "stage", polygon: [[-4, 0], [4, 0], [4, 5], [-4, 5]] };

/** Metres → screen pixels, read from where the reference zone is drawn (never fixed pixels). */
async function frame(page: Page): Promise<(x: number, y: number) => { x: number; y: number }> {
  const ref = page.locator(`.stage-plan g.zone[data-zone="${REF.id}"] polygon`).first();
  await ref.scrollIntoViewIfNeeded();
  const b = (await ref.boundingBox())!;
  return (x, y) => ({ x: b.x + ((x + 4) / 8) * b.width, y: b.y + b.height - (y / 5) * b.height });
}

/** Deletes the zones a test made (forced: a rule may still name one), the reference last. */
async function cleanUp(page: Page): Promise<void> {
  for (const z of await zones(page)) if (z.id.startsWith("t27") || z.name.startsWith("T27")) await api(page, "stage.zone.delete", { id: z.id, force: true });
}

async function openVenue(page: Page): Promise<void> {
  await page.locator("nav.pages").getByRole("button", { name: "Lieu" }).click();
  await expect(page.locator(`.stage-plan g.zone[data-zone="${REF.id}"]`)).toHaveCount(1);
}

/** Names the zone in the creation form and creates it. */
async function create(page: Page, name: string): Promise<void> {
  const form = page.getByRole("dialog", { name: "Nouvelle zone" });
  await expect(form).toBeVisible();
  await form.getByLabel("Nom de la zone").fill(name);
  await form.getByRole("button", { name: "Créer la zone" }).click();
  await expect(form).toHaveCount(0);
  await expect.poll(async () => (await zoneNamed(page, name)) !== undefined).toBe(true);
}

const near = (a: number, b: number, tolerance = 0.11) => Math.abs(a - b) <= tolerance;

test("T27: a rectangle, an ellipse and a polygon drawn with the mouse become zones; Escape cancels", async ({ page }) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 1400, height: 1000 });
  await login(page);
  await api(page, "stage.zone.put", { zone: REF });
  try {
    await openVenue(page);
    await page.getByLabel("Dessiner une zone").check();
    const tools = page.getByRole("group", { name: "Forme à dessiner" });
    await expect(tools.getByRole("button", { name: "Rectangle" })).toHaveAttribute("aria-pressed", "true");
    let at = await frame(page);
    // a rectangle: dragged from one corner to the other
    const a = at(-3, 1);
    const b = at(-1, 3);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 6 });
    await expect(page.locator(".stage-plan .draw-shape")).toHaveCount(1);
    await page.mouse.up();
    // the form asks its name; an aiming zone by default
    const form = page.getByRole("dialog", { name: "Nouvelle zone" });
    await expect(form.getByLabel("Zone de visée", { exact: true })).toBeChecked();
    await create(page, "T27 rectangle");
    const rect = (await zoneNamed(page, "T27 rectangle"))!;
    expect(rect.outline).toEqual({ kind: "rect" });
    expect(rect.aim).toEqual({ height: 1.5 });
    const xs = rect.polygon.map((p) => p[0]);
    const ys = rect.polygon.map((p) => p[1]);
    expect(near(Math.min(...xs), -3) && near(Math.max(...xs), -1) && near(Math.min(...ys), 1) && near(Math.max(...ys), 3)).toBe(true);
    // its aiming point on the plan, in its colour
    await expect(page.locator(`.stage-plan g.zone[data-zone="${rect.id}"] .zone-aim`)).toHaveCount(1);
    await expect(page.locator("#venue-patch li", { hasText: "T27 rectangle" })).toContainText("visée");

    // an ellipse: dragged by its box
    await tools.getByRole("button", { name: "Ellipse" }).click();
    at = await frame(page);
    const c = at(0, 1);
    const d = at(2, 2);
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.move(d.x, d.y, { steps: 6 });
    await page.mouse.up();
    await create(page, "T27 ellipse");
    const ellipse = (await zoneNamed(page, "T27 ellipse"))!;
    expect(ellipse.polygon).toHaveLength(32);
    expect(ellipse.outline?.kind).toBe("ellipse");
    expect(near(ellipse.outline!.rx!, 1) && near(ellipse.outline!.ry!, 0.5) && near(ellipse.outline!.cx!, 1) && near(ellipse.outline!.cy!, 1.5)).toBe(true);

    // a polygon: two corners then Escape draws nothing; three corners, then the first one, closes it
    await tools.getByRole("button", { name: "Polygone" }).click();
    at = await frame(page);
    for (const [x, y] of [[1, 3], [3, 3]] as const) await page.mouse.click(at(x, y).x, at(x, y).y);
    await expect(page.locator(".stage-plan .draw-corner")).toHaveCount(2);
    await page.keyboard.press("Escape");
    await expect(page.locator(".stage-plan .draw-corner")).toHaveCount(0);
    for (const [x, y] of [[1, 3], [3, 3], [3.5, 4.5], [2, 4.5]] as const) await page.mouse.click(at(x, y).x, at(x, y).y);
    // Backspace takes the last corner back
    await page.keyboard.press("Backspace");
    await expect(page.locator(".stage-plan .draw-corner")).toHaveCount(3);
    await expect(page.locator(".stage-plan .draw-corner.first")).toHaveCount(1);
    await page.screenshot({ path: "test-results/t27-polygon-drawing.png" });
    await page.mouse.click(at(1, 3).x, at(1, 3).y);
    await create(page, "T27 polygone");
    const polygon = (await zoneNamed(page, "T27 polygone"))!;
    expect(polygon.outline).toEqual({ kind: "polygon" });
    expect(polygon.polygon).toHaveLength(3);
    // a crossed outline is refused before it is sent
    for (const [x, y] of [[-3, 3.5], [-1, 4.5], [-1, 3.5], [-3, 4.5]] as const) await page.mouse.click(at(x, y).x, at(x, y).y);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Nouvelle zone" })).toHaveCount(0);
    await expect(page.locator(".stage-plan .draw-corner")).toHaveCount(4);
    await page.getByRole("button", { name: "Annuler le dessin" }).click();
    await page.screenshot({ path: "test-results/t27-desktop.png", fullPage: true });

    // the menu edits the ellipse by its axes
    await page.getByLabel("Dessiner une zone").uncheck();
    at = await frame(page);
    await page.mouse.click(at(1, 1.5).x, at(1, 1.5).y, { button: "right" });
    const menu = page.getByRole("dialog", { name: "Zone" });
    await expect(menu.getByLabel("Largeur", { exact: true })).toHaveValue("2");
    await menu.getByLabel("Largeur", { exact: true }).fill("3");
    await menu.getByLabel("Point placé").check();
    await menu.getByLabel("X du point de visée").fill("0.5");
    await menu.getByRole("radio", { name: "Bleu" }).click();
    await page.screenshot({ path: "test-results/t27-zone-menu.png" });
    await menu.getByRole("button", { name: "Enregistrer" }).click();
    await expect.poll(async () => (await zoneNamed(page, "T27 ellipse"))?.outline?.rx).toBe(1.5);
    const edited = (await zoneNamed(page, "T27 ellipse"))!;
    expect(edited.polygon).toHaveLength(32);
    expect(edited.aim?.point?.[0]).toBe(0.5);
    expect(edited.aim?.color).toBe("#3b82f6");
  } finally {
    await cleanUp(page);
  }
  expect(errors).toEqual([]);
});

test("T27: a zone drawn with the keyboard alone", async ({ page }) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 1400, height: 1000 });
  await login(page);
  await api(page, "stage.zone.put", { zone: REF });
  try {
    await openVenue(page);
    await page.getByLabel("Dessiner une zone").check();
    await page.keyboard.press("ArrowRight"); // the cursor shows
    await expect(page.locator(".stage-plan .draw-cursor")).toHaveCount(1);
    await page.keyboard.press("Space"); // the first corner
    for (let i = 0; i < 2; i++) await page.keyboard.press("Shift+ArrowRight"); // 2 m
    await page.keyboard.press("Shift+ArrowUp"); // 1 m
    await page.keyboard.press("Space");
    await create(page, "T27 clavier");
    const zone = (await zoneNamed(page, "T27 clavier"))!;
    const xs = zone.polygon.map((p) => p[0]);
    const ys = zone.polygon.map((p) => p[1]);
    expect(Math.round((Math.max(...xs) - Math.min(...xs)) * 100)).toBe(200);
    expect(Math.round((Math.max(...ys) - Math.min(...ys)) * 100)).toBe(100);
    // Escape with nothing drawn leaves the mode
    await page.keyboard.press("Escape");
    await expect(page.getByLabel("Dessiner une zone")).not.toBeChecked();
  } finally {
    await cleanUp(page);
  }
  expect(errors).toEqual([]);
});

test("T27: « Viser » aims at an aiming zone's point, Alt at the exact point; a zone a rule uses is deleted once forced", async ({ page }) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 1400, height: 1000 });
  await login(page);
  const spot = ((await api(page, "venue.fixture.list")) as { id: string; position?: unknown; mount?: string }[]).find((f) => f.id === "spot")!;
  await api(page, "stage.zone.put", { zone: REF });
  await api(page, "stage.zone.put", { zone: { id: "t27-aim", name: "T27 visée", type: "riser", polygon: [[1, 1], [3, 1], [3, 3], [1, 3]], floorHeight: 0.2, aim: { height: 1, point: [2.5, 2] } } });
  await api(page, "venue.fixture.put", { fixture: { ...spot, position: { x: 0, y: -1, z: 4 }, mount: "hung" } });
  try {
    await openVenue(page);
    await page.getByLabel("Viser avec les lyres").check();
    await expect(page.getByText("Clic dans une zone de visée : les lyres visent son point de visée.")).toBeVisible();
    const at = await frame(page);
    const aimBody = async (click: () => Promise<void>) => {
      const request = page.waitForRequest((r) => r.url().endsWith("/commands/position.aim"));
      await click();
      return (await request).postDataJSON() as Record<string, unknown>;
    };
    const inside = at(1.5, 1.5);
    expect(await aimBody(() => page.mouse.click(inside.x, inside.y))).toEqual({ zone: "t27-aim" });
    const exact = (await aimBody(async () => {
      await page.keyboard.down("Alt");
      await page.mouse.click(inside.x, inside.y);
      await page.keyboard.up("Alt");
    })) as { point: { x: number; y: number; z: number } };
    expect(near(exact.point.x, 1.5, 0.2) && near(exact.point.y, 1.5, 0.2)).toBe(true);
    expect(exact.point.z).toBeCloseTo(1.2, 5); // the zone's floor and aiming height
    await api(page, "position.release");
    await page.getByLabel("Viser avec les lyres").uncheck();

    // a rule scoped to the zone: deleting it says so, and deletes only on that yes
    await api(page, "rule.put", { where: "show", rule: { id: "t27-rule", name: "T27 règle", scope: { zone: "t27-aim" }, target: { attribute: "intensity" }, max: 200 } });
    let question = "";
    page.once("dialog", (dialog) => {
      question = dialog.message();
      void dialog.dismiss();
    });
    await page.getByRole("button", { name: "Supprimer T27 visée" }).click();
    await expect.poll(() => question).toContain("règle du show « T27 règle »");
    expect((await zones(page)).some((z) => z.id === "t27-aim")).toBe(true);
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Supprimer T27 visée" }).click();
    await expect.poll(async () => (await zones(page)).some((z) => z.id === "t27-aim")).toBe(false);
  } finally {
    await api(page, "rule.delete", { id: "t27-rule" });
    await api(page, "venue.fixture.put", { fixture: spot });
    await cleanUp(page);
  }
  expect(errors).toEqual([]);
});

/** A touch screen of this size, signed in, on the Lieu page with the reference zone. */
async function touchPage(browser: Browser, viewport: { width: number; height: number }, mobile = false) {
  const ctx = await browser.newContext({ hasTouch: true, isMobile: mobile, viewport, baseURL: `http://127.0.0.1:${PORT}`, locale: "fr-FR" });
  const page = await ctx.newPage();
  return { ctx, page };
}

test("T27: on a touch tablet, a rectangle dragged and a polygon tapped become zones", async ({ browser }) => {
  const { ctx, page } = await touchPage(browser, { width: 1180, height: 820 });
  const errors = watchErrors(page);
  await login(page);
  await api(page, "stage.zone.put", { zone: REF });
  try {
    await openVenue(page);
    await page.getByLabel("Dessiner une zone").check();
    // the tools are big enough for a finger
    const rectTool = page.getByRole("group", { name: "Forme à dessiner" }).getByRole("button", { name: "Rectangle" });
    expect((await rectTool.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate<string>("getComputedStyle(document.querySelector('.stage-plan svg')).touchAction")).toBe("none");
    let at = await frame(page);
    const cdp = await ctx.newCDPSession(page);
    const from = at(-3, 1);
    const to = at(-1, 2);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: Math.round(from.x), y: Math.round(from.y) }] });
    for (let i = 1; i <= 8; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: Math.round(from.x + ((to.x - from.x) * i) / 8), y: Math.round(from.y + ((to.y - from.y) * i) / 8) }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await create(page, "T27 doigt");
    const rect = (await zoneNamed(page, "T27 doigt"))!;
    expect(rect.outline).toEqual({ kind: "rect" });
    // a polygon: a tap per corner, a tap on the first one closes it (a finger has a bigger ring)
    await page.getByRole("group", { name: "Forme à dessiner" }).getByRole("button", { name: "Polygone" }).click();
    at = await frame(page);
    for (const [x, y] of [[1, 1], [3, 1], [2, 3]] as const) await page.touchscreen.tap(at(x, y).x, at(x, y).y);
    await expect(page.locator(".stage-plan .draw-corner")).toHaveCount(3);
    await page.screenshot({ path: "test-results/t27-tablet-drawing.png" });
    await page.touchscreen.tap(at(1, 1).x + 10, at(1, 1).y - 8); // close to the first corner, not on it
    await expect(page.getByRole("dialog", { name: "Nouvelle zone" })).toBeVisible();
    await page.screenshot({ path: "test-results/t27-tablet-form.png" });
    await create(page, "T27 tablette");
    expect((await zoneNamed(page, "T27 tablette"))!.polygon).toHaveLength(3);
    await page.screenshot({ path: "test-results/t27-tablet.png", fullPage: true });
  } finally {
    await cleanUp(page);
    await ctx.close();
  }
  expect(errors).toEqual([]);
});

test("T27: on a phone, the drawing tools and the form fit the screen", async ({ browser }) => {
  const { ctx, page } = await touchPage(browser, { width: 390, height: 844 }, true);
  const errors = watchErrors(page);
  await login(page);
  await api(page, "stage.zone.put", { zone: REF });
  try {
    await openVenue(page);
    await page.getByLabel("Dessiner une zone").check();
    await page.getByRole("group", { name: "Forme à dessiner" }).getByRole("button", { name: "Polygone" }).click();
    const at = await frame(page);
    for (const [x, y] of [[-3, 1], [3, 1], [0, 4]] as const) await page.touchscreen.tap(at(x, y).x, at(x, y).y);
    await page.getByRole("button", { name: "Terminer" }).click();
    const form = page.getByRole("dialog", { name: "Nouvelle zone" });
    await expect(form).toBeVisible();
    const box = (await form.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: "test-results/t27-phone-form.png" });
    await create(page, "T27 téléphone");
    expect(await page.evaluate<number>("document.documentElement.scrollWidth")).toBeLessThanOrEqual(390);
    await page.locator(".draw-panel").scrollIntoViewIfNeeded();
    await page.screenshot({ path: "test-results/t27-phone.png" });
  } finally {
    await cleanUp(page);
    await ctx.close();
  }
  expect(errors).toEqual([]);
});
