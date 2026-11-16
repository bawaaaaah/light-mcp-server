import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * T27, lots 4 and 5 (docs/specs/venue-fixtures-stage.md, « Zones » ; docs/specs/ui-dashboards.md): the aiming zones on
 * the pads. On the target pad (top view) they are drawn in their colour and a tap in one puts the target on its aiming
 * point (`target.zone`), a drag stays free; under a group's XY pad, one chip per aiming zone sends the heads there
 * (`position.aim {zone}`), what is left out said in the toast; on a single head's pad (its panel), the zones' outlines
 * projected in pan/tilt (`stage.zone.project`). Everything made here is put back at the end (other specs count it).
 */

type Dashboard = { id: string; widgets: { id: string; kind: string; x: number; y: number; w: number; h: number; target?: string; label?: string }[] };
type Fixture = { id: string; name: string; position?: { x: number; y: number; z: number }; mount?: string; orientation?: Record<string, unknown> };
type Point3 = { x: number; y: number; z: number };

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

/** A command as the desk (the master token): the set-up of a test, never what the page under test does. */
async function desk(page: Page, name: string, args: unknown = {}): Promise<unknown> {
  const res = await page.request.post(`/api/plugins/light/commands/${name}`, { headers: { authorization: "Bearer ui-test-token" }, data: args });
  return ((await res.json()) as { result: unknown }).result;
}

/** An aiming zone left of centre, 2 × 2 m (X −3..−1, Y 2..4): its aiming point is (−2, 3), 1.5 m above its floor. */
const ZONE = { id: "t27p-zone", name: "T27 estrade", type: "riser", polygon: [[-3, 2], [-1, 2], [-1, 4], [-3, 4]], floorHeight: 0, aim: { height: 1.5, color: "#22c55e" } };
/** A plain zone (not an aiming one), right of centre: a tap in it is a free move. */
const PLAIN = { id: "t27p-plain", name: "T27 plancher", type: "stage", polygon: [[1, 2], [3, 2], [3, 4], [1, 4]] };
const BOUNDS = { min: { x: -4, y: 0, z: 0 }, max: { x: 4, y: 6, z: 4 } };

/** The moving head hung over the stage, the two zones, then `body`; everything put back after. */
async function withZones(page: Page, body: (spot: Fixture) => Promise<void>): Promise<void> {
  const spot = ((await desk(page, "venue.fixture.list")) as Fixture[]).find((f) => f.id === "spot")!;
  await desk(page, "venue.fixture.put", { fixture: { ...spot, position: { x: 0, y: 1, z: 5 }, mount: "hung" } });
  await desk(page, "stage.zone.put", { zone: ZONE });
  await desk(page, "stage.zone.put", { zone: PLAIN });
  try {
    await body(spot);
  } finally {
    await desk(page, "motion.unfreeze");
    await desk(page, "position.home", {});
    await desk(page, "stage.zone.delete", { id: ZONE.id, force: true });
    await desk(page, "stage.zone.delete", { id: PLAIN.id, force: true });
    await desk(page, "venue.fixture.put", { fixture: spot });
  }
}

/** A widget added at the bottom of the first dashboard for `body`, the dashboard put back after. */
async function withWidget(page: Page, widget: { kind: string; target?: string; w: number; h: number }, body: () => Promise<void>): Promise<void> {
  const dash = ((await desk(page, "dashboard.list")) as Dashboard[])[0]!;
  const bottom = dash.widgets.reduce((m, w) => Math.max(m, w.y + w.h), 0);
  await desk(page, "dashboard.put", { dashboard: { ...dash, widgets: [...dash.widgets, { id: "t27p-widget", x: 0, y: bottom, ...widget }] } });
  try {
    await page.reload();
    await body();
  } finally {
    await desk(page, "dashboard.put", { dashboard: dash });
  }
}

const targetPoint = async (page: Page): Promise<Point3> => ((await desk(page, "target.list")) as { id: string; point: Point3 }[]).find((t) => t.id === "t27p")!.point;
const manualOf = async (page: Page) => ((await desk(page, "position.list")) as { id: string; manual?: { pan: number; tilt: number } }[]).find((h) => h.id === "spot")?.manual ?? undefined;

async function withTarget(page: Page, body: (pad: Locator) => Promise<void>): Promise<void> {
  await desk(page, "target.put", { target: { id: "t27p", name: "Cible zones", fixtures: ["spot"], bounds: BOUNDS, point: { x: 2, y: 1, z: 1 } } });
  try {
    await withWidget(page, { kind: "target", target: "t27p", w: 6, h: 6 }, async () => {
      const pad = page.getByTestId("target-pad");
      await pad.scrollIntoViewIfNeeded();
      await body(pad);
    });
  } finally {
    await desk(page, "target.delete", { id: "t27p", force: true });
  }
}

const centre = (b: { x: number; y: number; width: number; height: number }) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

test("T27 lot 4: the target pad draws the aiming zones; a tap in one puts the target on its aiming point, a drag stays free", async ({ page }) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await login(page);
  await withZones(page, async () => {
    await withTarget(page, async (pad) => {
      const zone = pad.locator(`polygon.tp-zone.aim[data-zone="${ZONE.id}"]`);
      await expect(zone).toHaveCount(1);
      await expect(pad.locator(`polygon.tp-zone[data-zone="${PLAIN.id}"]`)).not.toHaveClass(/aim/);
      // in its own colour, its aiming point marked, its name written
      expect(await zone.evaluate((el) => (globalThis as unknown as { getComputedStyle(e: unknown): { stroke: string } }).getComputedStyle(el).stroke)).toBe("rgb(34, 197, 94)");
      await expect(pad.locator(`g.tp-zone-aim[data-aim="${ZONE.id}"]`)).toHaveCount(1);
      await expect(pad.locator(`text[data-zone-name="${ZONE.id}"]`)).toHaveText(ZONE.name);
      // a tap anywhere in it: the target goes to its aiming point, at its aiming height
      const box = (await zone.boundingBox())!;
      const writes: string[] = [];
      page.on("request", (r) => {
        if (/\/commands\/target\.(set|zone)$/.test(r.url())) writes.push(r.url().split("/").at(-1)!);
      });
      await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.8);
      await expect.poll(async () => targetPoint(page)).toEqual({ x: -2, y: 3, z: 1.5 });
      expect(writes).toEqual(["target.zone"]); // a tap sends nothing else
      // a tap in a plain zone is a free move, as anywhere else
      const plain = (await pad.locator(`polygon.tp-zone[data-zone="${PLAIN.id}"]`).boundingBox())!;
      await page.mouse.click(plain.x + plain.width / 2, plain.y + plain.height / 2);
      await expect.poll(async () => (await targetPoint(page)).x).toBeCloseTo(2, 0);
      expect((await targetPoint(page)).z).toBe(1.5); // the height stays
      // a drag that starts in the aiming zone is a free move: the target ends where the pointer stops
      const c = centre(box);
      await page.mouse.move(c.x + box.width * 0.3, c.y);
      await page.mouse.down();
      for (let i = 1; i <= 6; i++) await page.mouse.move(c.x + box.width * 0.3, c.y + i * 6);
      await page.mouse.up();
      await expect.poll(async () => (await targetPoint(page)).y).toBeLessThan(2.9);
      expect((await targetPoint(page)).x).toBeGreaterThan(-2);
      // Alt + tap: the exact point, not the aiming point
      await page.keyboard.down("Alt");
      await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.2);
      await page.keyboard.up("Alt");
      await expect.poll(async () => (await targetPoint(page)).x).toBeCloseTo(-2.6, 0);
      // the keyboard: Enter in the zone puts the target on its aiming point
      const plan = pad.getByRole("slider", { name: "Cible zones, vue de dessus" });
      await plan.focus();
      await page.keyboard.press("Enter");
      await expect.poll(async () => targetPoint(page)).toEqual({ x: -2, y: 3, z: 1.5 });
      await pad.screenshot({ path: "test-results/t27-target-pad-desktop.png" });
    });
  });
  expect(errors).toEqual([]);
});

test("T27 lot 4: on a touch tablet, a tap in an aiming zone of the target pad puts the target there", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true, isMobile: true, locale: "fr-FR" });
  const page = await context.newPage();
  const errors = watchErrors(page);
  try {
    await login(page);
    await withZones(page, async () => {
      await withTarget(page, async (pad) => {
        const box = (await pad.locator(`polygon.tp-zone.aim[data-zone="${ZONE.id}"]`).boundingBox())!;
        await page.touchscreen.tap(box.x + box.width * 0.75, box.y + box.height * 0.3);
        await expect.poll(async () => targetPoint(page)).toEqual({ x: -2, y: 3, z: 1.5 });
        await pad.screenshot({ path: "test-results/t27-target-pad-tablet.png" });
      });
    });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test("T27 lot 4: a zone chip under a group's pad sends its heads to the zone; out of reach said in the toast; frozen, the chips are off", async ({ page }) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await login(page);
  await withZones(page, async (spot) => {
    await desk(page, "group.put", { group: { id: "t27p-lyres", name: "T27 lyres", members: { fixtures: ["spot"], looks: [], groups: [] } } });
    try {
      await withWidget(page, { kind: "xy", target: "t27p-lyres", w: 3, h: 4 }, async () => {
        const chips = page.getByTestId("xy-zone-chips").last(); // the dashboard has its own XY pad: ours is at the bottom
        await chips.scrollIntoViewIfNeeded();
        // aiming zones only: the plain zone has no chip
        await expect(chips.getByRole("button")).toHaveText([ZONE.name]);
        await expect(chips).toHaveAttribute("aria-label", "Envoyer les lyres sur une zone de visée");
        const chip = chips.getByRole("button", { name: ZONE.name });
        const aimed = ((await desk(page, "position.aim", { fixtures: ["spot"], zone: ZONE.id })) as { results: { pan: number; tilt: number }[] }).results[0]!;
        await desk(page, "position.home", {});
        await expect.poll(async () => manualOf(page)).toBeUndefined();
        await chip.click();
        await expect.poll(async () => (await manualOf(page))?.pan).toBeCloseTo(aimed.pan, 4);
        expect((await manualOf(page))!.tilt).toBeCloseTo(aimed.tilt, 4);
        await chips.screenshot({ path: "test-results/t27-zone-chips-desktop.png" });
        // a head that cannot reach the zone (its stops, T8): said in the toast, by name
        await desk(page, "venue.fixture.put", { fixture: { ...spot, position: { x: 0, y: 1, z: 5 }, mount: "hung", orientation: { limits: { tilt: [-5, 5] } } } });
        await chip.click();
        await expect(page.getByTestId("lock-toast")).toContainText("Hors de portée : Lyre");
        // frozen hard: the pad is off, its chips too
        await desk(page, "venue.fixture.put", { fixture: { ...spot, position: { x: 0, y: 1, z: 5 }, mount: "hung" } });
        await desk(page, "motion.freeze", { fixtures: ["spot"], level: "hard" });
        await expect(chip).toBeDisabled();
      });
    } finally {
      await desk(page, "group.delete", { id: "t27p-lyres", force: true });
    }
  });
  expect(errors).toEqual([]);
});

test("T27 lot 4: on a phone, the zone chips are 44 px high and scroll sideways in their cell", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: "fr-FR" });
  const page = await context.newPage();
  const errors = watchErrors(page);
  try {
    await login(page);
    await withZones(page, async () => {
      await withWidget(page, { kind: "xy", w: 3, h: 4 }, async () => {
        const chips = page.getByTestId("xy-zone-chips").last(); // the dashboard has its own XY pad: ours is at the bottom
        await chips.scrollIntoViewIfNeeded();
        const chip = chips.getByRole("button", { name: ZONE.name });
        expect((await chip.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        await chip.tap();
        await expect.poll(async () => (await manualOf(page)) !== undefined).toBe(true);
        await page.screenshot({ path: "test-results/t27-zone-chips-phone.png" });
      });
    });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

/** The panel of the moving head, opened from the venue's plan (a click on its body). */
async function openSpotPanel(page: Page): Promise<Locator> {
  await page.locator("nav.pages button", { hasText: "Lieu" }).click();
  await page.evaluate('document.querySelector(".stage-plan")?.scrollIntoView({ block: "center" })');
  const body = page.locator('.stage-plan g.fixture[data-fixture="spot"]').first();
  const box = (await body.boundingBox())!;
  for (const [fx, fy] of [[0.5, 0.5], [0.85, 0.85], [0.15, 0.15]]) {
    await body.click({ position: { x: box.width * fx!, y: box.height * fy! }, timeout: 1500 }).catch(() => undefined);
    if (await page.locator(".fixture-panel").isVisible()) break;
  }
  const panel = page.locator(".fixture-panel");
  await expect(panel).toBeVisible();
  return panel;
}

test("T27 lot 5: a head's pad shows the aiming zones as it sees them, follows a zone moved and its stops, read-only", async ({ page }) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await login(page);
  await withZones(page, async (spot) => {
    const panel = await openSpotPanel(page);
    const zones = panel.getByTestId("xy-zones");
    const outline = zones.locator(`g[data-zone="${ZONE.id}"]`);
    await expect(outline).toHaveAttribute("data-reach", "full");
    await expect(outline.locator("polygon")).toHaveCount(1);
    await expect(zones.locator(`g[data-zone="${PLAIN.id}"]`)).toHaveCount(0); // not an aiming zone
    await expect(panel.locator(`.xy-zone[data-zone="${ZONE.id}"] .xy-zone-name`)).toHaveText(ZONE.name);
    await expect(panel.getByTestId("xy-zones-text")).toContainText(`Zones de visée vues par Lyre : ${ZONE.name}`);
    // its aiming point is where position.aim {zone} sends the head: the head's dot lands on it
    await desk(page, "position.aim", { fixtures: ["spot"], zone: ZONE.id });
    const mark = panel.locator(`.xy-zone[data-zone="${ZONE.id}"] .xy-zone-aim`);
    const dot = panel.getByTestId("xy-sent-dot");
    await expect
      .poll(async () => {
        const [a, b] = [(await mark.boundingBox())!, (await dot.boundingBox())!];
        return Math.hypot(a.x + a.width / 2 - (b.x + b.width / 2), a.y + a.height / 2 - (b.y + b.height / 2));
      })
      .toBeLessThan(3);
    // read-only: a press on the outline is the pad's own gesture (the overlay takes no pointer)
    expect(await zones.evaluate((el) => (globalThis as unknown as { getComputedStyle(e: unknown): { pointerEvents: string } }).getComputedStyle(el).pointerEvents)).toBe("none");
    await panel.screenshot({ path: "test-results/t27-projected-desktop.png" });
    // the zone moved: the outline follows without reopening the panel
    const before = await outline.locator("polygon").getAttribute("points");
    await desk(page, "stage.zone.put", { zone: { ...ZONE, polygon: [[-2, 2], [0, 2], [0, 4], [-2, 4]] } });
    await expect.poll(() => outline.locator("polygon").getAttribute("points")).not.toBe(before);
    // its stops (T8): the part beyond them is left out, the rest dashed
    await desk(page, "venue.fixture.put", { fixture: { ...spot, position: { x: 0, y: 1, z: 5 }, mount: "hung", orientation: { limits: { tilt: [-30, 30] } } } });
    await expect(outline).toHaveAttribute("data-reach", "partial");
    await expect(outline.locator("polyline").first()).toBeAttached();
    await expect(panel.getByTestId("xy-zones-text")).toContainText("en partie hors de portée");
    await panel.screenshot({ path: "test-results/t27-projected-partial.png" });
  });
  expect(errors).toEqual([]);
});

for (const [name, viewport] of [["tablet", { width: 1180, height: 820 }], ["phone", { width: 390, height: 844 }]] as const) {
  test(`T27 lot 5: the projected zones on a head's pad, ${name}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, locale: "fr-FR" });
    const page = await context.newPage();
    const errors = watchErrors(page);
    try {
      await login(page);
      await withZones(page, async () => {
        const panel = await openSpotPanel(page);
        const pad = panel.locator(".xy .pad");
        await expect(pad.getByTestId("xy-zones").locator(`g[data-zone="${ZONE.id}"] polygon`)).toHaveCount(1);
        await pad.scrollIntoViewIfNeeded();
        // the name stays inside the pad
        const [n, p] = [(await pad.locator(".xy-zone-name").first().boundingBox())!, (await pad.boundingBox())!];
        expect(n.x).toBeGreaterThanOrEqual(p.x - 1);
        expect(n.x + n.width).toBeLessThanOrEqual(p.x + p.width + 1);
        await panel.screenshot({ path: `test-results/t27-projected-${name}.png` });
      });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
}
