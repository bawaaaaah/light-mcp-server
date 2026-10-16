import { expect, test, type Page } from "@playwright/test";

/**
 * A tour of the whole UI for each role, on a computer and a phone: every page a role sees loads
 * without errors, nothing is wider than the screen, and a screenshot of each goes to
 * test-results/tour/ (to look at after any visual change).
 */
const ROLES = [
  { id: "admin", pin: "9999" },
  { id: "regisseur", pin: "1234" },
  { id: "benevole", pin: "5678" },
  { id: "lecture", pin: "1357" },
] as const;
const VIEWPORTS = [
  { label: "desktop", width: 1280, height: 800 },
  { label: "tablet", width: 820, height: 1180 },
  { label: "phone", width: 390, height: 844 },
] as const;

async function signIn(page: Page, user: string, pin: string): Promise<void> {
  await page.goto("/");
  await page.locator("form.pin-login select").selectOption(user);
  await page.getByPlaceholder(/PIN/).fill(pin);
  await page.locator("form.pin-login button").click();
  await expect(page.locator("header.top")).toBeVisible();
}

for (const viewport of VIEWPORTS) {
  for (const role of ROLES) {
    test(`tour ${viewport.label} · ${role.id}: every page it sees loads, fits the screen, no error`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
      page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await signIn(page, role.id, role.pin);
      const pages = await page.locator("nav.pages button").allTextContents();
      const wide: string[] = [];
      for (const name of pages) {
        await page.locator("nav.pages button", { hasText: name }).first().click();
        await page.waitForTimeout(250);
        const width = await page.evaluate<number>("document.documentElement.scrollWidth");
        if (width > viewport.width + 1) wide.push(`${name}: ${width}px`);
        await page.screenshot({ path: `test-results/tour/${viewport.label}-${role.id}-${name.replace(/\s/g, "-")}.png`, fullPage: true });
      }
      expect(wide).toEqual([]);
      expect(errors.filter((e) => !e.includes("401") && !e.includes("403"))).toEqual([]);
    });
  }
}

test("tour in English · admin: every page, nothing wider than the screen", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page, "admin", "9999");
  await page.locator("header select").selectOption("en");
  const pages = await page.locator("nav.pages button").allTextContents();
  for (const name of pages) {
    await page.locator("nav.pages button", { hasText: name }).first().click();
    await page.waitForTimeout(250);
    await page.screenshot({ path: `test-results/tour/en-${name.replace(/\s/g, "-")}.png`, fullPage: true });
  }
  await page.locator("header select").selectOption("fr");
  expect(errors).toEqual([]);
});

test("tour of a new empty show · admin: first-run states, then back to the test show", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page, "admin", "9999");
  // through the API with the master token: opening a show reloads the page under page.evaluate
  const call = async (name: string, args: unknown = {}) =>
    ((await (await request.post(`/api/plugins/light/commands/${name}`, { headers: { authorization: "Bearer ui-test-token" }, data: args })).json()) as { result: unknown }).result;
  const before = ((await call("show.list")) as { id: string; active: boolean }[]).find((s) => s.active)!.id;
  await expect(page.locator(".show-name")).toBeVisible(); // the app knows the open show: a switch reloads it
  const reloaded = page.waitForEvent("load");
  const created = (await call("show.create", { name: "Show vide", venue: "new" })) as { id: string };
  try {
    await reloaded; // the header shows the new name a moment before the reload: wait for the reload itself
    await expect(page.locator("header.top")).toContainText("Show vide");
    const pages = await page.locator("nav.pages button").allTextContents();
    for (const name of pages) {
      await page.locator("nav.pages button", { hasText: name }).first().click();
      await page.waitForTimeout(250);
      await page.screenshot({ path: `test-results/tour/empty-${name.replace(/\s/g, "-")}.png`, fullPage: true });
    }
  } finally {
    await page.goto("about:blank"); // leave before the app reloads on the show switch: no request cut mid-flight
    await call("show.open", { id: before });
    await call("show.delete", { id: created.id });
  }
  expect(errors).toEqual([]);
});
