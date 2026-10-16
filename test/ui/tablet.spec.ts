import { expect, test } from "@playwright/test";

/** Every page on a tablet, portrait and landscape: nothing wider than the screen (no sideways scroll). */
for (const [label, viewport] of [
  ["portrait", { width: 820, height: 1180 }],
  ["landscape", { width: 1180, height: 820 }],
] as const) {
  test(`tablet ${label}: no page is wider than the screen`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await page.locator("form.pin-login select").selectOption("admin");
    await page.getByPlaceholder(/PIN/).fill("9999");
    await page.locator("form.pin-login button").click();
    await expect(page.locator("header.top")).toBeVisible();
    const wide: string[] = [];
    for (const name of ["Live", "Show", "Lieu", "Chants", "MIDI", "OSC", "Import", "Notes", "Fichiers", "Connexion IA", "Réglages", "Console DMX"]) {
      await page.locator("nav.pages button", { hasText: name }).first().click();
      await page.waitForTimeout(150);
      const width = await page.evaluate<number>("document.documentElement.scrollWidth");
      if (width > viewport.width) wide.push(`${name}: ${width}px`);
      await page.screenshot({ path: `test-results/tablet-${label}-${name.replace(/\s/g, "-")}.png`, fullPage: true });
    }
    expect(wide).toEqual([]);
  });
}
