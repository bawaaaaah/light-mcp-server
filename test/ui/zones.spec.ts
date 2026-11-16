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
    expect(near(Math.min(...xs), -3)).toBe(true);
    expect(near(Math.max(...xs), -1)).toBe(true);
    expect(near(Math.min(...ys), 1)).toBe(true);
    expect(near(Math.max(...ys), 3)).toBe(true);
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
    expect(near(ellipse.outline!.rx!, 1)).toBe(true);
    expect(near(ellipse.outline!.ry!, 0.5)).toBe(true);
    expect(near(ellipse.outline!.cx!, 1)).toBe(true);
    expect(near(ellipse.outline!.cy!, 1.5)).toBe(true);

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
    // a crossed outline is refused before it is sent, said by the drawing tools (not at the top of the page)
    for (const [x, y] of [[-3, 3.5], [-1, 4.5], [-1, 3.5], [-3, 4.5]] as const) await page.mouse.click(at(x, y).x, at(x, y).y);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Nouvelle zone" })).toHaveCount(0);
    await expect(page.locator(".stage-plan .draw-corner")).toHaveCount(4);
    await expect(page.locator(".draw-panel .draw-error")).toContainText("ne peut pas être une zone");
    await expect(page.locator(".venue > p.error")).toHaveCount(0);
    await page.screenshot({ path: "test-results/t27-crossed.png" });
    await page.getByRole("button", { name: "Annuler le dessin" }).click();
    await page.screenshot({ path: "test-results/t27-desktop.png", fullPage: true });

    // the menu edits the ellipse by its axes
    await page.getByLabel("Dessiner une zone").uncheck();
    at = await frame(page);
    await page.mouse.click(at(1, 1.5).x, at(1, 1.5).y, { button: "right" });
    const menu = page.getByRole("dialog", { name: "Zone" });
    await expect(menu.getByLabel("largeur (m)", { exact: true })).toHaveValue("2");
    await menu.getByLabel("largeur (m)", { exact: true }).fill("3");
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
    // the cursor's place is said
    await expect(page.locator(".draw-panel .sr-only")).toContainText("Curseur : X");
    await page.keyboard.press("Space"); // the first corner
    for (let i = 0; i < 2; i++) await page.keyboard.press("Shift+ArrowRight"); // 2 m, kept square while Shift is held
    for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowUp"); // 1 m, no longer square
    await page.keyboard.press("Space");
    // Enter in the name field creates the zone (a form)
    const form = page.getByRole("dialog", { name: "Nouvelle zone" });
    await expect(form.getByLabel("Nom de la zone")).toBeFocused();
    await form.getByLabel("Nom de la zone").fill("T27 clavier");
    await page.keyboard.press("Enter");
    await expect(form).toHaveCount(0);
    await expect.poll(async () => (await zoneNamed(page, "T27 clavier")) !== undefined).toBe(true);
    const zone = (await zoneNamed(page, "T27 clavier"))!;
    const xs = zone.polygon.map((p) => p[0]);
    const ys = zone.polygon.map((p) => p[1]);
    expect(Math.round((Math.max(...xs) - Math.min(...xs)) * 100)).toBe(200);
    expect(Math.round((Math.max(...ys) - Math.min(...ys)) * 100)).toBe(100);
    // the focus came back to the plan: Shift+arrows alone give a square
    await expect(page.locator(".stage-plan svg.drawing")).toBeFocused();
    // the cursor went away with the zone created: the first key brings it back
    await expect(page.locator(".stage-plan .draw-cursor")).toHaveCount(0);
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Space");
    for (let i = 0; i < 2; i++) await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Space");
    await create(page, "T27 carré");
    const square = (await zoneNamed(page, "T27 carré"))!;
    const sxs = square.polygon.map((p) => p[0]);
    const sys = square.polygon.map((p) => p[1]);
    expect(Math.round((Math.max(...sxs) - Math.min(...sxs)) * 100)).toBe(200);
    expect(Math.round((Math.max(...sys) - Math.min(...sys)) * 100)).toBe(200);
    // a polygon, keys alone: arrows and Space per corner, Enter closes
    await page.locator(".stage-plan svg.drawing").focus();
    await page.getByRole("group", { name: "Forme à dessiner" }).getByRole("button", { name: "Polygone" }).click();
    await expect(page.locator(".stage-plan svg.drawing")).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Space");
    await page.keyboard.press("Shift+ArrowLeft");
    await page.keyboard.press("Space");
    await page.keyboard.press("Shift+ArrowUp");
    await page.keyboard.press("Space");
    await page.keyboard.press("Enter");
    await create(page, "T27 polygone clavier");
    expect((await zoneNamed(page, "T27 polygone clavier"))!.polygon).toHaveLength(3);
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
    // what named it is said to name a missing zone now
    await expect(page.locator(".venue > p.warn", { hasText: "n'existe plus" })).toContainText("règle du show « T27 règle »");
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

test("T27: a double-click on the first point closes the polygon once; the form keeps it, Cancel reopens it", async ({ page }) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 1400, height: 1000 });
  await login(page);
  await api(page, "stage.zone.put", { zone: REF });
  try {
    await openVenue(page);
    await page.getByLabel("Dessiner une zone").check();
    await page.getByRole("group", { name: "Forme à dessiner" }).getByRole("button", { name: "Polygone" }).click();
    const at = await frame(page);
    for (const [x, y] of [[1, 1], [3, 1], [2, 3]] as const) await page.mouse.click(at(x, y).x, at(x, y).y);
    // a double-click on the first corner: its first click closes, the second must not lose the shape
    await page.mouse.dblclick(at(1, 1).x, at(1, 1).y);
    const form = page.getByRole("dialog", { name: "Nouvelle zone" });
    await expect(form).toBeVisible();
    // the shape stays drawn, dashed, while it is named; a click beside the form does not close it
    await expect(page.locator(".stage-plan .draw-preview.pending polygon")).toHaveCount(1);
    await page.mouse.click(at(-3, 4).x, at(-3, 4).y);
    await expect(form).toBeVisible();
    await expect(page.locator(".stage-plan .draw-corner")).toHaveCount(0);
    await page.screenshot({ path: "test-results/t27-pending.png" });
    // Tab stays inside the form
    for (let i = 0; i < 30; i++) await page.keyboard.press("Tab");
    expect(await page.evaluate<boolean>("Boolean(document.activeElement?.closest('[role=dialog]'))")).toBe(true);
    // Cancel: the polygon is open again, its three corners back, to be fixed
    await form.getByRole("button", { name: "Annuler" }).click();
    await expect(form).toHaveCount(0);
    await expect(page.locator(".stage-plan .draw-corner")).toHaveCount(3);
    await page.getByRole("button", { name: "Terminer" }).click();
    await create(page, "T27 double");
    expect((await zoneNamed(page, "T27 double"))!.polygon).toHaveLength(3);
    // one zone, not two
    expect((await zones(page)).filter((z) => z.name.startsWith("T27")).length).toBe(1);
  } finally {
    await cleanUp(page);
  }
  expect(errors).toEqual([]);
});

test("T27: a zone opens its menu from the keyboard; « Point exact » aims at the point; the topmost zone decides", async ({ page }) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 1400, height: 1000 });
  await login(page);
  const spot = ((await api(page, "venue.fixture.list")) as { id: string; position?: unknown; mount?: string }[]).find((f) => f.id === "spot")!;
  await api(page, "stage.zone.put", { zone: REF });
  await api(page, "stage.zone.put", { zone: { id: "t27-aim", name: "T27 visée", type: "riser", polygon: [[1, 1], [3, 1], [3, 3], [1, 3]], floorHeight: 0.2, aim: { height: 1, color: "#1e3a8a" } } });
  // a plain zone over a corner of the aiming one: a click there is not an aiming click
  await api(page, "stage.zone.put", { zone: { id: "t27-over", name: "T27 dessus", type: "stage", polygon: [[2.5, 2.5], [3.5, 2.5], [3.5, 3.5], [2.5, 3.5]] } });
  await api(page, "venue.fixture.put", { fixture: { ...spot, position: { x: 0, y: -1, z: 4 }, mount: "hung" } });
  try {
    await openVenue(page);
    // Shift+F10 on a focused zone: its menu, which takes the focus and gives it back on Escape
    const zone = page.locator('.stage-plan g.zone[data-zone="t27-aim"]');
    await zone.focus();
    await page.keyboard.press("Shift+F10");
    const menu = page.getByRole("dialog", { name: "Zone" });
    await expect(menu).toBeVisible();
    // the form takes the focus, not its name (a key typed would not rename the zone); Tab reaches the name
    await expect(menu).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(menu.getByLabel("Nom de la zone")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(zone).toBeFocused();
    // a dark colour of its own keeps a light rim
    await expect(page.locator('.stage-plan g.zone[data-zone="t27-aim"] .zone-halo')).toHaveCount(1);
    // its centre moved in the menu: the placed point goes with it, as when dragged; ticking « interdite aux lyres » on an
    // aiming zone is warned
    await api(page, "stage.zone.put", { zone: { id: "t27-move", name: "T27 bouge", type: "stage", polygon: [[-3, 1], [-1, 1], [-1, 2], [-3, 2]], aim: { height: 1.5, point: [-2.5, 1.5] } } });
    await page.locator('.stage-plan g.zone[data-zone="t27-move"]').focus();
    await page.keyboard.press("Shift+F10");
    await menu.getByLabel("centre X (m)").fill("-1");
    await menu.getByLabel("interdite aux lyres").check();
    await expect(menu.getByRole("status")).toContainText("Interdite aux lyres et zone de visée");
    await menu.getByLabel("interdite aux lyres").uncheck();
    await menu.getByRole("button", { name: "Enregistrer" }).click();
    await expect.poll(async () => (await zoneNamed(page, "T27 bouge"))?.aim?.point).toEqual([-1.5, 1.5]);

    await page.getByLabel("Viser avec les lyres").check();
    const exact = page.getByRole("button", { name: "Point exact" });
    await expect(exact).toHaveAttribute("aria-pressed", "false");
    const at = await frame(page);
    const aimBody = async (x: number, y: number) => {
      const request = page.waitForRequest((r) => r.url().endsWith("/commands/position.aim"));
      await page.mouse.click(at(x, y).x, at(x, y).y);
      return (await request).postDataJSON() as { zone?: string; point?: { x: number; y: number; z: number } };
    };
    expect(await aimBody(1.5, 1.5)).toEqual({ zone: "t27-aim" });
    // under the plain zone on top: the exact point, at that zone's floor and 1.5 m
    const under = await aimBody(3.2, 3.2);
    expect(under.zone).toBeUndefined();
    expect(under.point!.z).toBeCloseTo(1.5, 5);
    await exact.click();
    await expect(exact).toHaveAttribute("aria-pressed", "true");
    const pointed = await aimBody(1.5, 1.5);
    expect(pointed.zone).toBeUndefined();
    expect(near(pointed.point!.x, 1.5, 0.2)).toBe(true);
    expect(pointed.point!.z).toBeCloseTo(1.2, 5);
    await api(page, "position.release");
  } finally {
    await api(page, "venue.fixture.put", { fixture: spot });
    await cleanUp(page);
  }
  expect(errors).toEqual([]);
});

test("T27: on a touch tablet, an ellipse dragged becomes a zone", async ({ browser }) => {
  const { ctx, page } = await touchPage(browser, { width: 1180, height: 820 });
  const errors = watchErrors(page);
  await login(page);
  await api(page, "stage.zone.put", { zone: REF });
  try {
    await openVenue(page);
    await page.getByLabel("Dessiner une zone").check();
    await page.getByRole("group", { name: "Forme à dessiner" }).getByRole("button", { name: "Ellipse" }).click();
    // a finger: the keyboard's help is left out
    await expect(page.locator(".draw-panel .keyboard-help")).toBeHidden();
    const at = await frame(page);
    const cdp = await ctx.newCDPSession(page);
    const [from, to] = [at(0, 1), at(2, 2)];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: Math.round(from.x), y: Math.round(from.y) }] });
    for (let i = 1; i <= 8; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: Math.round(from.x + ((to.x - from.x) * i) / 8), y: Math.round(from.y + ((to.y - from.y) * i) / 8) }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const form = page.getByRole("dialog", { name: "Nouvelle zone" });
    await expect(form).toBeVisible();
    // its buttons in sight without scrolling
    const createButton = form.getByRole("button", { name: "Créer la zone" });
    const box = (await createButton.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(820);
    await form.getByLabel("Nom de la zone").fill("T27 ellipse doigt");
    await createButton.click();
    await expect.poll(async () => (await zoneNamed(page, "T27 ellipse doigt"))?.outline?.kind).toBe("ellipse");
    // no cursor left behind by the finger
    await expect(page.locator(".stage-plan .draw-cursor")).toHaveCount(0);
  } finally {
    await cleanUp(page);
    await ctx.close();
  }
  expect(errors).toEqual([]);
});

test("T27 lot Z4: « Déplacer les zones » drags a corner and the aiming point (mouse, keyboard), a crossing refused", async ({ page }) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 1400, height: 1000 });
  await login(page);
  await api(page, "stage.zone.put", { zone: REF });
  await api(page, "stage.zone.put", { zone: { id: "t27-poly", name: "T27 forme", type: "stage", polygon: [[1, 1], [3, 1], [3, 3], [1, 3]], outline: { kind: "polygon" }, aim: { height: 1.5, point: [2, 2] } } });
  try {
    await openVenue(page);
    await page.getByLabel("Déplacer les zones").check();
    const handles = page.locator('.stage-plan g[data-handles="t27-poly"]');
    await expect(handles.locator(".zone-handle")).toHaveCount(5); // four corners and the aiming point
    let at = await frame(page);
    // a corner dragged with the mouse: only that corner moves
    const from = at(3, 3);
    const to = at(3.5, 4);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => (await zoneNamed(page, "T27 forme"))?.polygon[2]).toEqual([3.5, 4]);
    expect((await zoneNamed(page, "T27 forme"))!.polygon[0]).toEqual([1, 1]);
    // the aiming point dragged: placed where it was let go
    at = await frame(page);
    const aim = at(2, 2);
    const there = at(1.5, 1.5);
    await page.mouse.move(aim.x, aim.y);
    await page.mouse.down();
    await page.mouse.move(there.x, there.y, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => (await zoneNamed(page, "T27 forme"))?.aim?.point).toEqual([1.5, 1.5]);
    // by the keyboard: a corner focused, an arrow moves it by a grid step
    const corner = handles.locator('[data-handle="0"]');
    await corner.focus();
    await page.keyboard.press("ArrowLeft");
    await expect.poll(async () => (await zoneNamed(page, "T27 forme"))?.polygon[0]).toEqual([0.9, 1]);
    // a corner pulled across the zone: refused before it is sent, said by the plan
    at = await frame(page);
    const c1 = at(3, 1);
    const across = at(0.5, 2.5);
    await page.mouse.move(c1.x, c1.y);
    await page.mouse.down();
    await page.mouse.move(across.x, across.y, { steps: 6 });
    await page.mouse.up();
    await expect(page.locator(".stage-plan .move-error")).toContainText("ne peut pas être une zone");
    expect((await zoneNamed(page, "T27 forme"))!.polygon[1]).toEqual([3, 1]);
    await page.screenshot({ path: "test-results/t27-z4-handles.png" });
  } finally {
    await cleanUp(page);
  }
  expect(errors).toEqual([]);
});

test("T27 lot Z4: a click on a handle writes nothing; a rectangle's corner keeps its handle step after step", async ({ page }) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 1400, height: 1000 });
  await login(page);
  await api(page, "stage.zone.put", { zone: REF });
  // aimed at its centre (no placed point), one corner off the grid
  await api(page, "stage.zone.put", { zone: { id: "t27-click", name: "T27 clic", type: "stage", polygon: [[1, 1], [3.03, 1], [3, 3], [1, 3]], outline: { kind: "polygon" }, aim: { height: 1.5 } } });
  // a rectangle whose corners do not come in the order the plan draws them
  await api(page, "stage.zone.put", { zone: { id: "t27-order", name: "T27 ordre", type: "stage", polygon: [[-1, 3], [-1, 1], [-3, 1], [-3, 3]], outline: { kind: "rect" } } });
  const puts: unknown[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/commands/stage.zone.put")) puts.push(r.postDataJSON());
  });
  try {
    await openVenue(page);
    await page.getByLabel("Déplacer les zones").check();
    const handles = page.locator('.stage-plan g[data-handles="t27-click"]');
    for (const handle of [handles.locator(".zone-handle.aim"), handles.locator('[data-handle="1"]')]) {
      const box = (await handle.boundingBox())!;
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    }
    // the rectangle's back right corner, twice to the right: the same corner both times
    const corner = page.locator('.stage-plan g[data-handles="t27-order"] [data-handle="0"]');
    await corner.focus();
    await page.keyboard.press("ArrowRight");
    await expect.poll(async () => (await zoneNamed(page, "T27 ordre"))?.polygon[0]).toEqual([-0.9, 3]);
    await page.keyboard.press("ArrowRight");
    await expect.poll(async () => (await zoneNamed(page, "T27 ordre"))?.polygon).toEqual([[-0.8, 3], [-0.8, 1], [-3, 1], [-3, 3]]);
    // the clicks wrote nothing: the zone still aims at its centre, its corner where it was
    const clicked = (await zoneNamed(page, "T27 clic"))!;
    expect(clicked.aim?.point).toBeUndefined();
    expect(clicked.polygon[1]).toEqual([3.03, 1]);
    expect(puts.every((p) => (p as { zone: { id: string } }).zone.id === "t27-order")).toBe(true);
  } finally {
    await cleanUp(page);
  }
  expect(errors).toEqual([]);
});

test("T27 lot Z4: on a touch tablet, the aiming point is dragged with a finger", async ({ browser }) => {
  const { ctx, page } = await touchPage(browser, { width: 1180, height: 820 });
  const errors = watchErrors(page);
  await login(page);
  await api(page, "stage.zone.put", { zone: REF });
  await api(page, "stage.zone.put", { zone: { id: "t27-touch", name: "T27 doigt visée", type: "stage", polygon: [[1, 1], [3, 1], [3, 3], [1, 3]], aim: { height: 1.5 } } });
  try {
    await openVenue(page);
    await page.getByLabel("Déplacer les zones").check();
    const aimHandle = page.locator('.stage-plan g[data-handles="t27-touch"] .zone-handle.aim');
    // a finger's size
    expect((await aimHandle.boundingBox())!.width).toBeGreaterThanOrEqual(24);
    const at = await frame(page);
    const cdp = await ctx.newCDPSession(page);
    const [from, to] = [at(2, 2), at(2.5, 1.5)];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: Math.round(from.x), y: Math.round(from.y) }] });
    for (let i = 1; i <= 8; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: Math.round(from.x + ((to.x - from.x) * i) / 8), y: Math.round(from.y + ((to.y - from.y) * i) / 8) }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(async () => (await zoneNamed(page, "T27 doigt visée"))?.aim?.point).toEqual([2.5, 1.5]);
    await page.screenshot({ path: "test-results/t27-z4-tablet.png" });
  } finally {
    await cleanUp(page);
    await ctx.close();
  }
  expect(errors).toEqual([]);
});
