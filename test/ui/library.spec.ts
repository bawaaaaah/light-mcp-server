import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

/** The UI test server's port (playwright.config.ts). */
const PORT = Number(process.env.UI_PORT ?? 8799);

async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.locator("form.pin-login select").selectOption("admin");
  await page.getByPlaceholder(/PIN/).fill("9999");
  await page.locator("form.pin-login button").click();
  await expect(page.locator("header.top")).toBeVisible();
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => void (m.type() === "error" && errors.push(`console: ${m.text()}`)));
  return errors;
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

const row = (page: Page, model: string) => page.locator("table.library-table tbody tr", { has: page.locator(".model", { hasText: new RegExp(`^${model.replace(/[()]/g, "\\$&")}$`) }) });

test("library: list and filters, duplicate, forward to another (alias), delete to the trash, restore, empty", async ({ page }) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await signIn(page);
  await page.locator("nav.pages button", { hasText: "Bibliothèque" }).click();
  const table = page.locator("table.library-table");
  await expect(row(page, "Mode Par")).toHaveCount(1);
  // the patched spot is used here; the filter keeps only what this venue uses
  await expect(row(page, "Spot 7")).toContainText("ici : 1 appareil");
  await page.getByLabel("Utilisées dans ce lieu").check();
  await expect(row(page, "Mode Par")).toHaveCount(0);
  await page.getByLabel("Utilisées dans ce lieu").uncheck();
  await page.getByRole("searchbox", { name: "Rechercher" }).fill("mode par");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await page.screenshot({ path: "test-results/library-desktop.png", fullPage: true });

  // duplicate under another name, from the row's ⋯ button
  await page.getByRole("button", { name: "Actions sur Test Mode Par" }).click();
  await page.getByRole("dialog", { name: "Actions sur Test Mode Par" }).getByRole("button", { name: /Dupliquer/ }).click();
  const dup = page.getByRole("dialog", { name: "Dupliquer Test Mode Par" });
  await expect(dup.getByLabel("Modèle")).toHaveValue("Mode Par (copie)");
  await dup.getByRole("button", { name: "Dupliquer", exact: true }).click();
  await expect(page.locator(".library-toast")).toContainText("Mode Par (copie)");
  await expect(row(page, "Mode Par (copie)")).toContainText("Ce lieu");

  // the copy forwarded to the original: an alias, with its mode table
  await row(page, "Mode Par (copie)").click({ button: "right" });
  await page.getByRole("dialog", { name: /Actions sur Test Mode Par \(copie\)/ }).getByRole("button", { name: /Faire suivre/ }).click();
  const fwd = page.getByRole("dialog", { name: /Faire suivre Test Mode Par \(copie\)/ });
  await fwd.getByLabel("Définition cible", { exact: true }).selectOption({ label: "Test Mode Par (4 modes)" });
  await expect(fwd.locator(".mode-table tbody tr")).toHaveCount(4);
  await page.screenshot({ path: "test-results/library-alias-dialog.png" });
  await fwd.getByRole("button", { name: "Faire suivre", exact: true }).click();
  await expect(page.getByRole("region", { name: "Alias de ce lieu" })).toContainText("Test Mode Par (copie) → Test Mode Par");
  await expect(row(page, "Mode Par (copie)")).toContainText("suit Test Mode Par");
  await page.getByRole("button", { name: "Retirer l'alias Test Mode Par (copie)" }).click();
  const unalias = page.getByRole("dialog", { name: /Retirer l'alias Test Mode Par \(copie\)/ });
  await expect(unalias).toContainText("Aucun appareil");
  await unalias.getByRole("button", { name: "Retirer l'alias", exact: true }).click();
  await expect(page.getByText("Aucun alias dans ce lieu.")).toBeVisible();

  // delete (unused: no force asked), restore, delete again and empty the trash
  await page.getByRole("button", { name: "Actions sur Test Mode Par (copie)" }).focus(); // one stop per row: its ⋯ button
  await page.keyboard.press("Shift+F10"); // the keyboard opens the same menu
  await page.getByRole("dialog", { name: /Actions sur Test Mode Par \(copie\)/ }).getByRole("button", { name: /Supprimer/ }).click();
  const del = page.getByRole("dialog", { name: /Supprimer Test Mode Par \(copie\)/ });
  await del.getByRole("button", { name: "Mettre à la corbeille" }).click();
  await expect(row(page, "Mode Par (copie)")).toHaveCount(0);
  // the trash may hold other definitions (an earlier « Remplacer » keeps the old version there)
  await expect(page.getByRole("region", { name: /^Corbeille/ })).toContainText("Test Mode Par (copie)");
  await page.getByRole("button", { name: "Restaurer Test Mode Par (copie)" }).click();
  const restore = page.getByRole("dialog", { name: /^Restaurer Test-Mode-Par-copie/ });
  await restore.getByRole("button", { name: "Restaurer", exact: true }).click();
  await expect(restore).toHaveCount(0);
  await expect(row(page, "Mode Par (copie)")).toHaveCount(1);
  await row(page, "Mode Par (copie)").click({ button: "right" });
  await page.getByRole("dialog", { name: /Actions sur/ }).getByRole("button", { name: /Supprimer/ }).click();
  await page.getByRole("dialog", { name: /Supprimer Test Mode Par/ }).getByRole("button", { name: "Mettre à la corbeille" }).click();
  await page.getByRole("button", { name: "Vider la corbeille" }).click();
  const empty = page.getByRole("dialog", { name: "Vider la corbeille" });
  await expect(empty).toContainText("Test Mode Par (copie)");
  await empty.getByRole("button", { name: "Vider définitivement" }).click();
  await expect(page.getByText("La corbeille est vide.")).toBeVisible();
  expect(errors).toEqual([]);
});

test("library: a definition in use asks before going, and two files of one model are merged by keeping one", async ({ page }) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await signIn(page);
  await page.locator("nav.pages button", { hasText: "Bibliothèque" }).click();
  // in use: the plan names the fixture, the button waits for « Le faire quand même »
  await page.getByRole("button", { name: "Actions sur Test Spot 7" }).click();
  await page.getByRole("dialog", { name: "Actions sur Test Spot 7" }).getByRole("button", { name: /Supprimer/ }).click();
  const del = page.getByRole("dialog", { name: "Supprimer Test Spot 7" });
  await expect(del).toContainText("Lyre");
  await expect(del.getByRole("button", { name: "Mettre à la corbeille" })).toBeDisabled();
  await del.getByLabel("Le faire quand même").check();
  await expect(del.getByRole("button", { name: "Mettre à la corbeille" })).toBeEnabled();
  await del.getByRole("button", { name: "Annuler" }).click();
  await expect(del).toHaveCount(0);
  // a copy of the shared spot for this venue: it wins (decision Q1), the shared one is ignored
  await api(page, "library.duplicate", { id: "shared/spot.qxf", sameName: true });
  await page.reload();
  await expect(row(page, "Spot 7").first()).toContainText("utilisée");
  await expect(page.locator(".library-table tr.ignored")).toHaveCount(1);
  const card = page.locator(".dup-card", { hasText: "2 fichiers pour Test Spot 7" });
  await expect(card).toBeVisible();
  await page.screenshot({ path: "test-results/library-duplicates.png", fullPage: true });
  // keep the shared one: the venue's copy goes to the trash
  await card.getByRole("button", { name: "Garder celle-ci : spot.qxf (Partagée)" }).click();
  const pick = page.getByRole("dialog", { name: "Garder spot.qxf (Partagée)" });
  await pick.getByRole("button", { name: "Garder celle-ci" }).click();
  await expect(card).toHaveCount(0);
  await expect(row(page, "Spot 7")).toHaveCount(1);
  await api(page, "library.trash.empty");
  expect(errors).toEqual([]);
});

for (const [label, viewport, mobile] of [
  ["tablet", { width: 1180, height: 820 }, false],
  ["phone", { width: 390, height: 844 }, true],
] as const) {
  test(`library on a ${label} by touch: 44 px controls, a long press opens the menu, nothing wider than the screen`, async ({ browser }) => {
    const ctx = await browser.newContext({ hasTouch: true, isMobile: mobile, viewport, baseURL: `http://127.0.0.1:${PORT}`, locale: "fr-FR" });
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await signIn(page);
    // a long model and file name must wrap or scroll inside the table, never widen the page
    const long = (await api(page, "library.duplicate", { id: "shared/mode-par.qxf", model: "Projecteur-a-tres-long-nom-sans-espace-pour-le-test" })) as { id: string };
    await page.locator("nav.pages button", { hasText: "Bibliothèque" }).first().click();
    await expect(row(page, "Mode Par")).toHaveCount(1);
    await expect(page.locator(".library-table .model", { hasText: "Projecteur-a-tres-long" })).toHaveCount(1);
    expect(await page.evaluate<number>("document.documentElement.scrollWidth")).toBeLessThanOrEqual(viewport.width);
    // every row's ⋯ is on screen, whatever the names and chips
    const outside = await page.locator(".library-table .row-actions").evaluateAll((els, w) => els.filter((e) => e.getBoundingClientRect().right > w).length, viewport.width);
    expect(outside).toBe(0);
    const small = await page.locator(".library-page button:visible, .library-page select:visible, .library-page input[type=search]:visible, .library-page label.inline:visible").evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().height < 44).map((e) => e.outerHTML.slice(0, 80)));
    expect(small).toEqual([]);
    // a finger held on a row opens its menu
    const box = (await row(page, "Mode Par").boundingBox())!;
    await page.touchscreen.tap(box.x + 10, box.y + 10); // focus, no menu
    const target = row(page, "Mode Par");
    await target.dispatchEvent("pointerdown", { pointerType: "touch", clientX: box.x + 10, clientY: box.y + 10, isPrimary: true, button: 0 });
    await page.waitForTimeout(700);
    await target.dispatchEvent("pointerup", { pointerType: "touch", clientX: box.x + 10, clientY: box.y + 10, isPrimary: true, button: 0 });
    const menu = page.getByRole("dialog", { name: "Actions sur Test Mode Par" });
    await expect(menu).toBeVisible();
    await page.screenshot({ path: `test-results/library-${label}.png`, fullPage: true });
    // its dialogs are as easy to hit with a finger
    await menu.getByRole("button", { name: /Dupliquer/ }).click();
    const dup = page.getByRole("dialog", { name: "Dupliquer Test Mode Par" });
    const tiny = await dup.locator("button:visible, input:not([type=radio]):visible, label.inline:visible").evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().height < 44).map((e) => e.outerHTML.slice(0, 80)));
    expect(tiny).toEqual([]);
    await page.screenshot({ path: `test-results/library-${label}-dialog.png` });
    await dup.getByRole("button", { name: "Annuler" }).click();
    await expect(dup).toHaveCount(0);
    await api(page, "library.delete", { id: long.id });
    await api(page, "library.trash.empty");
    expect(errors).toEqual([]);
    await ctx.close();
  });
}

test("library in English", async ({ page }) => {
  await signIn(page);
  await page.evaluate(() => localStorage.setItem("lang", "en"));
  await page.reload();
  await page.locator("nav.pages button", { hasText: "Library" }).click();
  await expect(page.getByRole("heading", { name: /^Library/ })).toBeVisible();
  await expect(page.getByLabel("Used in this venue")).toBeVisible();
  await page.evaluate(() => localStorage.setItem("lang", "fr"));
});

test("library by keyboard: the menu's arrows, the dialog takes the focus and gives it back to the row's ⋯", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await signIn(page);
  await page.locator("nav.pages button", { hasText: "Bibliothèque" }).click();
  const actions = page.getByRole("button", { name: "Actions sur Test Mode Par" });
  await actions.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("dialog", { name: "Actions sur Test Mode Par" });
  await expect(menu.getByRole("button", { name: /Dupliquer/ })).toBeFocused();
  await page.keyboard.press("End");
  await expect(menu.getByRole("button", { name: /Supprimer/ })).toBeFocused();
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  const dup = page.getByRole("dialog", { name: "Dupliquer Test Mode Par" });
  await expect(dup).toBeVisible();
  // the focus is inside the dialog, not lost on the page
  await expect(dup.locator(":focus")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(dup).toHaveCount(0);
  await expect(actions).toBeFocused();
});

test("library: a Latin-1 .qxf imported from the Import page is kept byte for byte", async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page);
  await page.locator("nav.pages button", { hasText: "Import" }).click();
  const latin = readFileSync(new URL("../fixtures/latin1-eclat.qxf", import.meta.url));
  await page.locator('input[type=file][accept=".qxf"]').setInputFiles({ name: "eclat-latin1.qxf", mimeType: "text/xml", buffer: latin });
  await expect(page.locator(".added-definitions")).toContainText("✔ eclat-latin1.qxf");
  await expect(page.locator(".added-definitions")).toContainText("Société Fictive Projecteur Éclat");
  const got = (await api(page, "library.get", { id: "shared/eclat-latin1.qxf" })) as { base64?: string; modes: { name: string }[] };
  expect(Buffer.from(got.base64!, "base64").equals(latin)).toBe(true);
  expect(got.modes.map((m) => m.name)).toEqual(["Défaut", "Réduit"]);
  await api(page, "library.delete", { id: "shared/eclat-latin1.qxf" });
  await api(page, "library.trash.empty");
  expect(errors).toEqual([]);
});

test("library: a dialog opened from the trash gives the keyboard back to its button, not to an old row", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await signIn(page);
  const copy = (await api(page, "library.duplicate", { id: "shared/mode-par.qxf", model: "Focus Probe" })) as { id: string };
  await api(page, "library.delete", { id: copy.id });
  await page.locator("nav.pages button", { hasText: "Bibliothèque" }).click();
  // a row's menu used first: its ⋯ must not take the focus back later
  await page.getByRole("button", { name: "Actions sur Test Mode Par" }).click();
  await page.getByRole("dialog", { name: "Actions sur Test Mode Par" }).getByRole("button", { name: /Dupliquer/ }).click();
  await page.getByRole("dialog", { name: "Dupliquer Test Mode Par" }).getByRole("button", { name: "Annuler" }).click();
  const empty = page.getByRole("button", { name: "Vider la corbeille" });
  await empty.click();
  await page.getByRole("dialog", { name: "Vider la corbeille" }).getByRole("button", { name: "Annuler" }).click();
  await expect(empty).toBeFocused();
  // restored: its button is gone with the entry, the trash's title takes the focus (never the page's body)
  await page.getByRole("button", { name: "Restaurer Test Focus Probe" }).click();
  await page.getByRole("dialog", { name: /^Restaurer/ }).getByRole("button", { name: "Restaurer", exact: true }).click();
  await expect(page.locator("#library-trash")).toBeFocused();
  await api(page, "library.delete", { id: copy.id });
  await api(page, "library.trash.empty");
});
