import { readFileSync } from "node:fs";
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

/** PINs set by test/ui/server.ts, and the user each one belongs to. */
const PIN_USERS: Record<string, string> = { "1234": "regisseur", "9999": "admin", "5678": "benevole" };

async function login(page: Page, pin = "1234"): Promise<void> {
  await page.goto("/");
  await page.locator("form.pin-login select").selectOption(PIN_USERS[pin]!);
  await page.getByPlaceholder(/PIN/).fill(pin);
  await page.locator("form.pin-login button").click();
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

test("signs in with the token by default, and the menu bar's token link signs in at once", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/");
  await page.getByPlaceholder(/Jeton/).fill("ui-test-token");
  await page.locator("form.token-login button").click();
  await expect(page.locator(".role")).toHaveText("Administrateur du lieu");
  await page.screenshot({ path: "test-results/login-token.png" });
  await page.getByRole("button", { name: "Quitter" }).click();
  await expect(page.locator("form.token-login")).toBeVisible();
  await page.screenshot({ path: "test-results/login.png" });
  await page.goto("about:blank");
  await page.goto("/#token=ui-test-token");
  await expect(page.locator(".role")).toHaveText("Administrateur du lieu");
  expect(page.url()).not.toContain("ui-test-token");
  expect(errors.filter((e) => !e.includes("401"))).toEqual([]);
});

test("share link: Settings builds it from a user and a PIN, and it signs in as that user", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page, "9999");
  await page.locator("header nav button", { hasText: "Réglages" }).click();
  const share = page.locator(".share-link");
  await share.locator("select").selectOption("benevole");
  await share.getByPlaceholder("PIN").fill("5678");
  const link = (await share.locator("code.link").textContent())!;
  expect(link).toMatch(/\/#user=benevole&pin=5678$/);
  await page.screenshot({ path: "test-results/share-link.png", fullPage: true });
  await page.getByRole("button", { name: "Quitter" }).click();
  await expect(page.locator("form.token-login")).toBeVisible();
  await page.goto("about:blank");
  await page.goto(link);
  await expect(page.locator(".role")).toHaveText("Bénévole");
  expect(page.url()).not.toContain("pin=");
  await page.getByRole("button", { name: "Quitter" }).click();
  await expect(page.locator("form.token-login")).toBeVisible();
  await page.goto("about:blank");
  await page.goto(link.replace("5678", "0001"));
  await expect(page.getByText(/PIN incorrect/)).toBeVisible();
  expect(errors.filter((e) => !e.includes("401"))).toEqual([]);
});

test("AI connection page: the token holder gets ready-to-paste snippets, a volunteer has no such page", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/#token=ui-test-token");
  await page.locator("header nav button", { hasText: "Connexion IA" }).click();
  await expect(page.locator(".connect-fields")).toContainText("/mcp");
  await expect(page.locator(".code-block").first()).toContainText("claude mcp add --transport http light");
  await expect(page.locator(".code-block").first()).not.toContainText("ui-test-token");
  await page.getByRole("button", { name: "Afficher" }).click();
  await expect(page.locator(".connect-fields")).toContainText("ui-test-token");
  await page.screenshot({ path: "test-results/connect.png", fullPage: true });
  await page.getByRole("button", { name: "Quitter" }).click();
  await expect(page.locator("form.token-login")).toBeVisible();
  await login(page, "5678");
  await expect(page.locator("header nav button", { hasText: "Connexion IA" })).toHaveCount(0);
  expect(errors.filter((e) => !e.includes("401"))).toEqual([]);
});

test("files: a new show opens on every screen, keeps backups, resets, and the first show comes back", async ({ page }) => {
  const errors = watchErrors(page);
  page.on("dialog", (d) => void d.accept());
  await login(page, "9999");
  await page.locator("header nav button", { hasText: "Fichiers" }).click();
  const files = page.locator(".files");
  await files.getByPlaceholder("Nom du show", { exact: true }).fill("Essai");
  await files.getByRole("button", { name: "Créer et ouvrir" }).click();
  await expect(page.locator("header .show-name")).toHaveText("Essai"); // the app reloaded on the new show
  expect(((await api(page, "look.list")) as unknown[]).length).toBe(0);
  await files.getByPlaceholder("Libellé (facultatif)").fill("test");
  await files.getByRole("button", { name: "Enregistrer une sauvegarde" }).click();
  await expect(files.locator(".backups")).toContainText(/essai-.*-test\.lightshow/);
  await files.getByRole("button", { name: "Réinitialiser le show" }).click();
  await expect(files.getByText("Show réinitialisé")).toBeVisible();
  await page.screenshot({ path: "test-results/files.png", fullPage: true });
  await files.locator(".shows tr", { hasText: "Show" }).first().getByRole("button", { name: "Ouvrir" }).click();
  await expect(page.locator("header .show-name")).toHaveText("Show");
  expect(((await api(page, "look.list")) as unknown[]).length).toBeGreaterThan(0);
  await files.locator(".shows tr", { hasText: "Essai" }).getByRole("button", { name: "Supprimer" }).click();
  await expect(files.locator(".shows")).not.toContainText("Essai");
  expect(errors).toEqual([]);
});

test("snapshots: save the whole state, choose it as Panic's safe state, Panic brings it back", async ({ page }) => {
  const errors = watchErrors(page);
  page.on("dialog", (d) => void d.accept());
  await login(page);
  await api(page, "look.stopall");
  await api(page, "look.go", { id: "hole" });
  await api(page, "group.level", { id: "master", level: 0.6 });
  await page.locator("header nav button", { hasText: "Show" }).first().click();
  const box = page.locator(".snapshots");
  await box.getByPlaceholder("Nom de l'instantané").fill("Accueil");
  await box.getByRole("button", { name: "Enregistrer l'état actuel" }).click();
  await expect(box.locator("tr", { hasText: "Accueil" })).toContainText("1 look(s)");
  await page.getByLabel(/Secours \(Panic\)/).selectOption({ label: "Accueil" });
  await expect(box.locator("tr", { hasText: "Accueil" })).toContainText("secours");
  await page.screenshot({ path: "test-results/snapshots.png", fullPage: true });
  await api(page, "look.stopall");
  await api(page, "look.go", { id: "masks" });
  await api(page, "group.level", { id: "master", level: 1 });
  await api(page, "panic");
  const state = (await api(page, "look.list")) as { id: string; active?: boolean }[];
  expect(state.filter((l) => l.active).map((l) => l.id)).toEqual(["hole"]);
  expect(((await api(page, "group.list")) as { id: string; master?: { level: number } }[]).find((g) => g.id === "master")?.master?.level).toBe(0.6);
  await api(page, "show.settings.set", { safeSnapshot: undefined });
  await api(page, "snapshot.delete", { id: "accueil" });
  await api(page, "look.stopall");
  await api(page, "group.level", { id: "master", level: 1 });
  expect(errors).toEqual([]);
});

test("users: the administrator adds a user with a PIN and a security key, who then signs in with the key", async ({ page }) => {
  const errors = watchErrors(page);
  page.on("dialog", (d) => void d.accept());
  // a virtual FIDO2 key (Chromium's WebAuthn emulation), on localhost: keys need a hostname, not an IP
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "usb", hasResidentKey: true, hasUserVerification: true, isUserVerified: true } });
  const origin = "http://localhost:8799";
  await page.goto(`${origin}/#token=ui-test-token`);
  await page.locator("header nav button", { hasText: "Réglages" }).click();
  const users = page.locator(".users");
  await users.getByLabel("Nom de l'utilisateur").fill("Régie test");
  await users.getByLabel("Rôle", { exact: true }).selectOption("regisseur");
  await users.getByLabel("PIN (facultatif)").fill("2468");
  await users.getByRole("button", { name: "Ajouter l'utilisateur" }).click();
  const row = users.locator(".users-table tr", { hasText: "Régie test" });
  await expect(row).toContainText("PIN ✔");
  await row.getByRole("button", { name: "Ajouter une clé" }).click();
  await expect(users.getByText("Clé enregistrée")).toBeVisible();
  await expect(users.locator(".keys-table")).toContainText("Clé de Régie test");
  await page.screenshot({ path: "test-results/users.png", fullPage: true });
  await page.getByRole("button", { name: "Quitter" }).click();
  await page.getByRole("button", { name: "Entrer avec une clé de sécurité" }).click();
  await expect(page.locator(".role")).toHaveText("Régie test");
  expect(((await api(page, "show.settings")) as { grandMaster: number }).grandMaster).toBeGreaterThanOrEqual(0); // a régisseur session works
  // the PIN works too, for that user only
  await page.getByRole("button", { name: "Quitter" }).click();
  await page.locator("form.pin-login select").selectOption({ label: "Régie test" });
  await page.getByPlaceholder(/PIN/).fill("2468");
  await page.locator("form.pin-login button").click();
  await expect(page.locator(".role")).toHaveText("Régie test");
  // clean up as the administrator
  await page.getByRole("button", { name: "Quitter" }).click();
  await page.goto("about:blank");
  await page.goto(`${origin}/#token=ui-test-token`);
  await page.locator("header nav button", { hasText: "Réglages" }).click();
  await page.locator(".users-table tr", { hasText: "Régie test" }).getByRole("button", { name: "Supprimer" }).click();
  await expect(page.locator(".users-table")).not.toContainText("Régie test");
  expect(errors.filter((e) => !e.includes("401"))).toEqual([]);
});

test("guided import: a .qxf added from the browser, then a QLC+ workspace into a new show of its own", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page, "9999");
  await page.locator("header nav button", { hasText: "Import" }).click();
  const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url));
  await page.locator('input[type=file][accept=".qxf"]').setInputFiles({ name: "test-spot.qxf", mimeType: "text/xml", buffer: fixture("spot.qxf") });
  await expect(page.locator(".added-definitions")).toContainText("✔ test-spot.qxf");
  await page.locator('input[type=file][accept=".qxw"]').setInputFiles({ name: "Autre salle.qxw", mimeType: "text/xml", buffer: fixture("efx.qxw") });
  await expect(page.locator(".report")).toBeVisible();
  await page.getByLabel("un nouveau show").check();
  await expect(page.getByLabel("Nom du show", { exact: true })).toHaveValue("Autre salle");
  await page.screenshot({ path: "test-results/import-guided.png", fullPage: true });
  await page.getByRole("button", { name: "Créer le show et importer" }).click();
  await expect(page.locator("header .show-name")).toHaveText("Autre salle"); // opened on every screen
  await expect(page.locator(".import .report")).toContainText("✔"); // the report survived the reload
  // back to the first show, the new one removed
  await api(page, "show.open", { id: "default" });
  await expect(page.locator("header .show-name")).toHaveText("Show");
  await api(page, "show.delete", { id: "autre-salle" });
  expect(errors).toEqual([]);
});

test("refuses a wrong PIN, then logs in", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/");
  await page.locator("form.pin-login select").selectOption("regisseur");
  await page.getByPlaceholder(/PIN/).fill("0000");
  await page.locator("form.pin-login button").click();
  await expect(page.getByText(/PIN incorrect|Wrong PIN/)).toBeVisible();
  await page.getByPlaceholder(/PIN/).fill("1234");
  await page.locator("form.pin-login button").click();
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

test("DCA limits: a max set on the Show page stops the fader on the dashboard", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.locator("header nav button", { hasText: "Show" }).click();
  const max = page.getByLabel("max Master");
  await max.fill("50");
  await max.blur();
  await expect.poll(async () => ((await api(page, "group.list")) as { id: string; limits?: { max?: number } }[]).find((g) => g.id === "master")?.limits?.max).toBe(0.5);
  await page.locator("header nav button", { hasText: "Live" }).click();
  await expect(page.locator(".fader .mark.max")).toBeVisible();
  const fader = page.getByLabel("DCA Master");
  await fader.fill("1000"); // pushed to the top…
  await expect(page.locator(".cell .fader .value").first()).toHaveText(/^50%/); // …it stops at the max, and is shown there
  await expect.poll(async () => (await dmx(page))[0]).toBe(128);
  await page.screenshot({ path: "test-results/dca-limits.png", fullPage: true });
  await page.locator("header nav button", { hasText: "Show" }).click();
  await page.getByLabel("max Master").fill("");
  await page.getByLabel("max Master").blur();
  await expect.poll(async () => ((await api(page, "group.list")) as { id: string; limits?: { max?: number } }[]).find((g) => g.id === "master")?.limits?.max).toBeUndefined();
  await api(page, "group.level", { id: "master", level: 1 });
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
  await expect(page.locator(".users-table strong", { hasText: "Régisseur" })).toBeVisible();
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

test("machine button: a look with raw channels and no colour", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await api(page, "look.stopall");
  await page.locator("header nav button", { hasText: "Show" }).click();
  await page.getByRole("button", { name: "+ Nouveau look" }).click();
  const editor = page.locator(".look-editor");
  await editor.getByLabel("Nom", { exact: true }).fill("Machine");
  await editor.getByLabel("Technique").selectOption("aucune");
  await editor.getByLabel("Canaux bruts (machines, lampes)").check();
  await editor.getByLabel("projecteur").selectOption("bar-0");
  await editor.getByLabel("canal", { exact: true }).selectOption("2"); // « 3. Program »
  await editor.getByRole("button", { name: "+ Ajouter le canal" }).click();
  await editor.getByLabel("pas 1 · Bar 0 · Program").fill("200");
  await page.screenshot({ path: "test-results/look-raw-channels.png", fullPage: true });
  await editor.getByRole("button", { name: "Enregistrer et lancer" }).click();
  await expect(editor).toHaveCount(0);
  await expect.poll(async () => (await dmx(page))[2]).toBe(200);
  const mine = ((await api(page, "look.list")) as { id: string; channels?: unknown }[]).find((l) => l.id === "machine")!;
  expect(mine.channels).toEqual({ targets: [{ fixture: "bar-0", offset: 2 }], steps: [[200]] });
  await api(page, "look.stopall");
  await expect.poll(async () => (await dmx(page))[2]).toBe(0);
  await api(page, "look.delete", { id: "machine" });
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
  // drag the unplaced moving head onto the stage
  await page.getByLabel("Placer les projecteurs").check();
  const spot = page.locator('.stage-plan g.fixture[data-fixture="spot"] rect').first();
  await spot.scrollIntoViewIfNeeded();
  const from = (await spot.boundingBox())!;
  const stage = (await page.locator(".stage-plan g.zone polygon").first().boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height * 0.8, { steps: 8 }); // front part of the stage, still on screen
  await page.mouse.up();
  await expect.poll(async () => ((await api(page, "venue.fixture.list")) as { id: string; position?: { x: number; y: number; z: number } }[]).find((f) => f.id === "spot")?.position).toEqual({ x: expect.any(Number), y: expect.any(Number), z: 0.3 });
  const placed = ((await api(page, "venue.fixture.list")) as { id: string; position: { x: number; y: number } }[]).find((f) => f.id === "spot")!.position;
  expect(Math.abs(placed.x)).toBeLessThan(0.5); // dropped at the middle of the stage (x from -4 to 4)
  expect(placed.y).toBeGreaterThan(0.5); // 80 % of the way to the front: y ≈ 1 m
  expect(placed.y).toBeLessThan(1.5);
  await expect(page.locator(".stage-plan .hint")).not.toContainText("sans position");
  await page.getByLabel("Placer les projecteurs").uncheck();
  await page.getByLabel("Viser avec les lyres").check();
  await plan.click({ position: { x: 300, y: 60 } }); // the head, now placed, aims at the clicked spot
  await expect.poll(async () => ((await api(page, "position.list")) as { id: string; manual: unknown }[]).find((h) => h.id === "spot")?.manual).not.toBeNull();
  await api(page, "position.release");
  // front view: heights; dragging a bar up raises it
  await page.getByRole("button", { name: "Face", exact: true }).click();
  await expect(page.locator(".stage-plan .hint")).toContainText("hauteurs");
  await page.getByLabel("Placer les projecteurs").check();
  const bar0 = page.locator('.stage-plan g.fixture[data-fixture="bar-0"] rect').first();
  await bar0.scrollIntoViewIfNeeded();
  const b = (await bar0.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y - 120, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => ((await api(page, "venue.fixture.list")) as { id: string; position?: { y: number; z: number } }[]).find((f) => f.id === "bar-0")?.position?.z ?? 0).toBeGreaterThan(1);
  const raised = ((await api(page, "venue.fixture.list")) as { id: string; position: { y: number } }[]).find((f) => f.id === "bar-0")!.position;
  expect(raised.y).toBe(4.5); // depth kept
  await page.screenshot({ path: "test-results/stage-front.png", fullPage: true });
  await page.getByLabel("Placer les projecteurs").uncheck();
  await page.getByRole("button", { name: "Dessus", exact: true }).click();
  await api(page, "look.stopall");
  expect(errors).toEqual([]);
});

test("restoring a backup shows the differences first", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const backup = await page.evaluate(async () => {
    const res = await fetch("/api/plugins/light/archive", { headers: { authorization: `Bearer ${sessionStorage.getItem("token")}` } });
    return Array.from(new Uint8Array(await res.arrayBuffer()));
  });
  const file = { name: "show.lightshow", mimeType: "application/zip", buffer: Buffer.from(backup) };
  await page.locator("header nav button", { hasText: "Show" }).click();
  const input = page.locator('input[type=file][accept*="lightshow"]');
  // identical backup: nothing to restore
  await input.setInputFiles(file);
  await expect(page.locator(".show .error")).toContainText("identique");
  // a look renamed since the backup: the dialog lists it, accepting restores it
  const look = ((await api(page, "look.list")) as { id: string; name: string }[]).find((l) => l.id === "hole")!;
  await api(page, "look.put", { look: { ...look, name: "Renommé" } });
  let message = "";
  page.once("dialog", (d) => {
    message = d.message();
    void d.accept();
  });
  await input.setInputFiles(file);
  await expect.poll(async () => ((await api(page, "look.list")) as { id: string; name: string }[]).find((l) => l.id === "hole")?.name).toBe(look.name);
  expect(message).toContain("~ looks/hole.json");
  expect(errors).toEqual([]);
});

test("guided calibration of a moving head", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const spot = ((await api(page, "venue.fixture.list")) as { id: string }[]).find((f) => f.id === "spot")!;
  await api(page, "venue.fixture.put", { fixture: { ...spot, position: { x: 0, y: 2, z: 5 }, mount: "hung" } });
  await api(page, "stage.zone.put", { zone: { id: "marque", name: "Marque", type: "stage", polygon: [[-3, 0], [-2, 0], [-2, 1], [-3, 1]] } });
  await page.locator("header nav button", { hasText: "Lieu" }).click();
  await page.getByText("Calibrer les lyres").click();
  const box = page.locator(".calibration");
  await box.getByLabel("Repère").selectOption("marque");
  const pad = box.locator(".xy .pad");
  await pad.scrollIntoViewIfNeeded(); // below the fold on the Lieu page: a click by coordinates would miss it
  const r = (await pad.boundingBox())!;
  await page.mouse.click(r.x + r.width * 0.3, r.y + r.height * 0.4);
  await box.getByRole("button", { name: /Enregistrer ce repère/ }).click();
  await expect(box.getByRole("button", { name: /Enregistrer ce repère/ })).toContainText("(1)");
  await box.getByLabel("Repère").selectOption("");
  await box.getByLabel("x (m)").fill("3");
  await box.getByLabel("y (m)").fill("4");
  await page.mouse.click(r.x + r.width * 0.75, r.y + r.height * 0.2);
  await box.getByRole("button", { name: /Enregistrer ce repère/ }).click();
  await expect(box.getByRole("button", { name: /Enregistrer ce repère/ })).toContainText("(2)");
  await box.getByRole("button", { name: "Calculer" }).click();
  await expect(box.locator(".report")).toContainText("yaw");
  await page.screenshot({ path: "test-results/calibration.png", fullPage: true });
  page.once("dialog", (d) => void d.accept()); // random aiming: a large error, confirmation asked
  await box.getByRole("button", { name: "Appliquer" }).click();
  await expect.poll(async () => ((await api(page, "venue.fixture.list")) as { id: string; orientation?: { yaw: number } }[]).find((f) => f.id === "spot")?.orientation).toBeTruthy();
  expect(errors).toEqual([]);
});

test("group editor: nested DCAs multiply", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.locator("header nav button", { hasText: "Show" }).click();
  // a DCA on one bar
  await page.getByRole("button", { name: "+ Nouveau groupe" }).click();
  let editor = page.locator(".group-editor");
  await editor.getByLabel("Nom", { exact: true }).fill("LED bar public");
  await editor.locator("fieldset.checklist", { hasText: "Projecteurs" }).getByLabel("Bar 0").check();
  await editor.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(editor).toHaveCount(0);
  // a parent DCA holding it
  await page.getByRole("button", { name: "+ Nouveau groupe" }).click();
  editor = page.locator(".group-editor");
  await editor.getByLabel("Nom", { exact: true }).fill("Ambiance");
  await editor.locator("fieldset.checklist", { hasText: "Sous-groupes" }).getByLabel("LED bar public").check();
  await editor.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await api(page, "group.level", { id: "ambiance", level: 0.5 });
  await api(page, "group.level", { id: "led-bar-public", level: 0.5 });
  const list = (await api(page, "group.list")) as { id: string; effectiveLevel: number }[];
  expect(list.find((g) => g.id === "led-bar-public")!.effectiveLevel).toBe(0.25); // 50 % × 50 %
  await page.screenshot({ path: "test-results/groups.png", fullPage: true });
  // edit then delete
  await page.getByRole("button", { name: "Modifier Ambiance" }).click();
  page.once("dialog", (d) => void d.accept());
  await page.locator(".group-editor").getByRole("button", { name: "Supprimer" }).click();
  await expect.poll(async () => ((await api(page, "group.list")) as { id: string }[]).some((g) => g.id === "ambiance")).toBe(false);
  await api(page, "group.delete", { id: "led-bar-public" });
  expect(errors).toEqual([]);
});

test("rules: a type limit, relaxed by the show, seen on the output and explained", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await api(page, "look.stopall");
  await api(page, "look.go", { id: "masks" });
  await page.locator("header nav button", { hasText: "Lieu" }).click();
  const panel = page.locator(".rules-panel");
  const form = panel.locator(".rule-form");
  // type level: Bar 4 dimmer max 50 %
  await form.getByLabel("Niveau").selectOption("type");
  await form.getByLabel("Portée").first().selectOption("model");
  await form.locator("select[aria-label='Portée']").selectOption("Bar 4");
  await form.getByLabel("max %").fill("50");
  await form.getByRole("button", { name: "+ Ajouter la règle" }).click();
  await expect(panel.locator("table.rules tr", { hasText: "Gradateur max 50 %" })).toBeVisible();
  await expect.poll(async () => (await dmx(page))[0]).toBe(128);
  // show level: everything max 80 % — more specific level, relaxes the type's limit
  await form.getByLabel("Niveau").selectOption("show");
  await form.getByLabel("Portée").first().selectOption("all");
  await form.getByLabel("max %").fill("80");
  await form.getByRole("button", { name: "+ Ajouter la règle" }).click();
  await expect.poll(async () => (await dmx(page))[0]).toBe(204);
  await panel.getByLabel("Règles en vigueur pour un projecteur").selectOption("bar-0");
  await expect(panel.locator("table.effective")).toContainText("max ← Gradateur max 80 %");
  await page.screenshot({ path: "test-results/rules.png", fullPage: true });
  for (const name of ["Gradateur max 80 %", "Gradateur max 50 %"]) await panel.getByRole("button", { name: `Supprimer ${name}` }).click();
  await expect.poll(async () => (await dmx(page))[0]).toBe(255);
  await api(page, "look.stopall");
  expect(errors).toEqual([]);
});

test("MIDI mapping: learn a note, assign a look, the note starts it", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await api(page, "look.stopall");
  await page.locator("header nav button", { hasText: "MIDI" }).click();
  await page.getByRole("button", { name: "+ Nouveau mapping" }).click();
  const editor = page.locator(".mapping-editor");
  await editor.getByRole("button", { name: "Apprendre" }).click();
  await expect(editor.getByRole("button", { name: /J'écoute/ })).toBeVisible();
  await api(page, "midi.in", { port: "Web MIDI · test", bytes: [0x90, 50, 100] }); // the note played on a controller
  await expect(editor.getByLabel("Note / CC")).toHaveValue("50");
  await editor.getByLabel("Cible").selectOption("hole");
  await editor.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.locator(".midi table tr", { hasText: "hole" })).toBeVisible();
  await api(page, "midi.in", { port: "Web MIDI · test", bytes: [0x90, 50, 100] });
  await expect.poll(async () => ((await api(page, "look.list")) as { id: string; active: boolean }[]).find((l) => l.id === "hole")?.active).toBe(true);
  await page.screenshot({ path: "test-results/midi-mapping.png", fullPage: true });
  await page.getByRole("button", { name: "Modifier hole" }).click();
  await page.locator(".mapping-editor").getByRole("button", { name: "Supprimer" }).click();
  await expect(page.locator(".midi table tr", { hasText: "hole" })).toHaveCount(0);
  await api(page, "look.stopall");
  expect(errors).toEqual([]);
});

test("channel fader: on a dashboard, it drives its channels", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await api(page, "look.stopall");
  await api(page, "fader.put", { fader: { id: "blanc", name: "Blanc", channels: [{ fixture: "bar-0", offset: 2 }], level: 0 } });
  await page.getByRole("button", { name: "✎" }).click();
  await page.locator(".dashboards .bar select").selectOption("channel-fader");
  await page.locator(".dashboards .editor select").first().selectOption("blanc");
  await page.getByRole("button", { name: "✔" }).click();
  const fader = page.getByLabel("Fader de canaux Blanc");
  await expect(fader).toBeVisible();
  await fader.fill("1000");
  await expect.poll(async () => (await dmx(page))[2]).toBe(255);
  await page.locator("header nav button", { hasText: "Show" }).click();
  await expect(page.locator("section", { hasText: "Faders de canaux" }).locator("tr", { hasText: "Blanc" })).toContainText("100 %");
  await api(page, "fader.delete", { id: "blanc" });
  await expect.poll(async () => (await dmx(page))[2]).toBe(0);
  expect(errors).toEqual([]);
});

test("channel fader editor: one fader on the same channel of several fixtures", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.locator("header nav button", { hasText: "Show" }).click();
  await page.getByRole("button", { name: "+ Nouveau fader de canaux" }).click();
  const editor = page.locator(".fader-editor");
  await editor.getByLabel("Nom").fill("Strobes");
  await editor.getByLabel("Bar 0").check();
  await editor.getByLabel("Bar 1").check();
  await editor.getByLabel("Strobe (strobe)").check();
  await expect(editor.getByText("2 canal(aux) pilotés")).toBeVisible();
  await editor.getByLabel("Dosé par le DCA").selectOption("master");
  await editor.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(editor).toHaveCount(0);
  const saved = ((await api(page, "fader.list")) as { id: string; channels: unknown[]; dca?: string }[]).find((f) => f.id === "strobes")!;
  expect(saved.dca).toBe("master");
  expect(saved.channels).toEqual([
    { fixture: "bar-0", offset: 1 },
    { fixture: "bar-1", offset: 1 },
  ]);
  await page.getByRole("button", { name: "Modifier Strobes" }).click();
  await expect(page.locator(".fader-editor").getByLabel("Strobe (strobe)")).toBeChecked();
  page.once("dialog", (d) => void d.accept());
  await page.locator(".fader-editor").getByRole("button", { name: "Supprimer" }).click();
  await expect(page.locator("tr", { hasText: "Strobes" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("rule program: created, holds a rule, activated by hand and by a Program Change", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await api(page, "look.stopall");
  await api(page, "look.go", { id: "masks" });
  await page.locator("header nav button", { hasText: "Lieu" }).click();
  const panel = page.locator(".rules-panel");
  await panel.getByLabel("Nom du programme").fill("Prière");
  await panel.getByLabel("Program Change (#, comme dans Live)").fill("100");
  await panel.getByRole("button", { name: "+ Ajouter le programme" }).click();
  await expect(panel.locator("table.programs tr", { hasText: "Prière" })).toContainText("PC #100");
  const form = panel.locator(".rule-form");
  await form.getByLabel("max %").fill("40");
  await form.getByLabel("Programme", { exact: true }).selectOption("priere");
  await form.getByRole("button", { name: "+ Ajouter la règle" }).click();
  await expect(panel.locator("table.rules tr", { hasText: "max 40 %" })).toContainText("Prière");
  await expect.poll(async () => (await dmx(page))[0]).toBe(255); // not active yet
  await panel.locator("table.programs tr", { hasText: "Prière" }).getByRole("button", { name: "Activer" }).click();
  await expect.poll(async () => (await dmx(page))[0]).toBe(102);
  await expect(page.locator("header .badge", { hasText: "Programme" })).toBeVisible();
  await panel.locator("table.programs tr", { hasText: "Prière" }).getByRole("button", { name: "Désactiver" }).click();
  await expect.poll(async () => (await dmx(page))[0]).toBe(255);
  await api(page, "midi.in", { port: "Web MIDI · test", bytes: [0xc0, 99] }); // a « Prière #100 » clip launched in Live
  await expect.poll(async () => (await dmx(page))[0]).toBe(102);
  await page.screenshot({ path: "test-results/programs.png", fullPage: true });
  await api(page, "program.select", { id: null });
  await api(page, "rule.delete", { where: "show", id: "gradateur-max-40" });
  await api(page, "program.delete", { id: "priere" });
  await api(page, "look.stopall");
  expect(errors).toEqual([]);
});

test("rule program triggered by a MIDI note mapping", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await api(page, "program.put", { program: { id: "annonces", name: "Annonces" } });
  await page.locator("header nav button", { hasText: "MIDI" }).click();
  await page.getByRole("button", { name: "+ Nouveau mapping" }).click();
  const editor = page.locator(".mapping-editor");
  await editor.getByLabel("Note / CC").fill("51");
  await editor.getByLabel("Action").selectOption("program");
  await editor.getByLabel("Cible").selectOption("annonces");
  await editor.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await api(page, "midi.in", { port: "Web MIDI · test", bytes: [0x90, 51, 100] }); // a note in a Live clip, where a PC would be ignored
  await expect.poll(async () => ((await api(page, "program.list")) as { active: string | null }).active).toBe("annonces");
  await page.getByRole("button", { name: "Modifier Annonces" }).click();
  await page.locator(".mapping-editor").getByRole("button", { name: "Supprimer" }).click();
  await api(page, "program.select", { id: null });
  await api(page, "program.delete", { id: "annonces" });
  expect(errors).toEqual([]);
});

test("song MIDI file downloaded from the songs page", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.locator("header nav button", { hasText: "Chants" }).click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "MIDI Chant test" }).click()]);
  expect(download.suggestedFilename()).toBe("Chant test.mid");
  const path = await download.path();
  const { readFileSync } = await import("node:fs");
  expect(readFileSync(path!).subarray(0, 4).toString()).toBe("MThd");
  expect(errors).toEqual([]);
});

test("dashboard buttons: on while held (momentary), or on/off (latch)", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await api(page, "look.stopall");
  const active = async () => ((await api(page, "look.list")) as { id: string; active: boolean }[]).find((l) => l.id === "masks")!.active;
  await page.getByRole("button", { name: "✎" }).click();
  await page.locator(".dgrid button.look", { hasText: "masks" }).click(); // selects the widget in edit mode
  await expect.poll(active).toBe(false); // editing never fires
  await page.getByLabel("Mode").selectOption("momentary");
  await page.getByRole("button", { name: "✔" }).click();
  const button = page.locator(".dgrid button.look", { hasText: "masks" });
  await button.hover();
  await page.mouse.down();
  await expect.poll(active).toBe(true);
  await page.mouse.up();
  await expect.poll(active).toBe(false);
  // latch (the default) toggles
  const hole = page.locator(".dgrid button.look", { hasText: "hole" });
  await hole.click();
  await expect(hole).toHaveClass(/on/);
  await hole.click();
  await expect(hole).not.toHaveClass(/on/);
  // back to latch for the other tests
  await page.getByRole("button", { name: "✎" }).click();
  await button.click();
  await page.getByLabel("Mode").selectOption("latch");
  await page.getByRole("button", { name: "✔" }).click();
  expect(errors).toEqual([]);
});

test("dashboard editor: add a label widget and save", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.getByRole("button", { name: "✎" }).click();
  await page.locator(".dashboards .bar select").selectOption("label"); // value stays the kind id
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

test("live stage widget on a dashboard", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.getByRole("button", { name: "✎" }).click();
  await page.locator(".dashboards .bar select").selectOption("preview");
  await page.getByRole("button", { name: "✔" }).click();
  const widget = page.locator(".preview-widget svg");
  await expect(widget).toBeVisible();
  await expect(widget.locator("g.fixture")).toHaveCount(3);
  await page.screenshot({ path: "test-results/preview-widget.png", fullPage: true });
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
