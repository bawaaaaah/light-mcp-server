import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";

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

/**
 * Runs a command with the session token of the page. The app reloads itself when the open show
 * changes (a switch, a restore): a call caught by that reload waits for it and runs again.
 */
async function api(page: Page, name: string, args: unknown = {}): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await page.evaluate(
        async ([n, a]) => {
          const res = await fetch(`/api/plugins/light/commands/${n}`, { method: "POST", headers: { authorization: `Bearer ${sessionStorage.getItem("token")}`, "content-type": "application/json" }, body: JSON.stringify(a) });
          return ((await res.json()) as { result: unknown }).result;
        },
        [name, args] as const,
      );
    } catch (err) {
      if (attempt >= 3 || !/Execution context was destroyed|navigation/i.test(String(err))) throw err;
      await page.waitForLoadState("load");
    }
  }
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
  await page.locator("nav.pages button", { hasText: "Réglages" }).click();
  const share = page.locator(".share-link");
  await share.locator("select").selectOption("benevole");
  await share.getByPlaceholder("PIN").fill("5678");
  const link = (await share.locator("code.link").textContent())!;
  expect(link).toMatch(/\/#user=benevole&pin=5678$/);
  // a QR code of it, on request, for a tablet's camera
  await share.getByRole("button", { name: "QR code" }).click();
  const qr = share.getByRole("img", { name: "QR code du lien de partage" });
  await expect(qr).toBeVisible();
  // read back with a QR decoder (jsQR) from its pixels: what a camera would get
  await page.addScriptTag({ path: fileURLToPath(new URL("../../node_modules/jsqr/dist/jsQR.js", import.meta.url)) });
  const read = (await page.evaluate(`(async () => {
    const svg = document.querySelector(".share-link svg.qr-code");
    const img = new Image();
    img.src = "data:image/svg+xml;utf8," + encodeURIComponent(new XMLSerializer().serializeToString(svg));
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 440;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, 440, 440);
    const found = jsQR(ctx.getImageData(0, 0, 440, 440).data, 440, 440);
    return found ? found.data : "";
  })()`)) as string;
  expect(read).toBe(link);
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
  await page.locator("nav.pages button", { hasText: "Connexion IA" }).click();
  await expect(page.locator(".connect-fields")).toContainText("/mcp");
  await expect(page.locator(".code-block").first()).toContainText("claude mcp add --transport http light");
  await expect(page.locator(".code-block").first()).not.toContainText("ui-test-token");
  await page.getByRole("button", { name: "Afficher" }).click();
  await expect(page.locator(".connect-fields")).toContainText("ui-test-token");
  await page.screenshot({ path: "test-results/connect.png", fullPage: true });
  await page.getByRole("button", { name: "Quitter" }).click();
  await expect(page.locator("form.token-login")).toBeVisible();
  await login(page, "5678");
  await expect(page.locator("nav.pages button", { hasText: "Connexion IA" })).toHaveCount(0);
  expect(errors.filter((e) => !e.includes("401"))).toEqual([]);
});

test("files: a new show opens on every screen, keeps backups, resets, and the first show comes back", async ({ page }) => {
  const errors = watchErrors(page);
  page.on("dialog", (d) => void d.accept());
  await login(page, "9999");
  await page.locator("nav.pages button", { hasText: "Fichiers" }).click();
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
  const reloaded = page.waitForEvent("load"); // the header shows the name a moment before the app reloads onto it
  await files.locator(".shows tr", { hasText: "Show" }).first().getByRole("button", { name: "Ouvrir" }).click();
  await reloaded;
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
  await page.locator("nav.pages button", { hasText: "Show" }).first().click();
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
  await page.locator("nav.pages button", { hasText: "Réglages" }).click();
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
  await page.locator("nav.pages button", { hasText: "Réglages" }).click();
  await page.locator(".users-table tr", { hasText: "Régie test" }).getByRole("button", { name: "Supprimer" }).click();
  await expect(page.locator(".users-table")).not.toContainText("Régie test");
  expect(errors.filter((e) => !e.includes("401"))).toEqual([]);
});

test("guided import: a .qxf added from the browser, then a QLC+ workspace into a new show of its own", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page, "9999");
  await page.locator("nav.pages button", { hasText: "Import" }).click();
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

test("grand master widget: dragged on the live, kept in the show, also playable from MIDI", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  type Dash = { id: string; widgets: { id: string; kind: string; x: number; y: number; w: number; h: number }[] };
  const [dash] = (await api(page, "dashboard.list")) as Dash[];
  const bottom = Math.max(...dash!.widgets.map((w) => w.y + w.h));
  await api(page, "dashboard.put", { dashboard: { ...dash, widgets: [...dash!.widgets, { id: "gm", kind: "grand-master", x: 0, y: bottom, w: 1, h: 4 }] } });
  await page.reload();
  const fader = page.getByRole("slider", { name: "Grand master" });
  await fader.scrollIntoViewIfNeeded();
  await fader.fill("600");
  await expect.poll(async () => ((await api(page, "show.settings")) as { grandMaster: number }).grandMaster).toBeCloseTo(0.6, 2);
  await expect(page.locator(".grand-master .value")).toHaveText("60%");
  // another screen moves it: this one follows
  await api(page, "grandmaster.set", { level: 0.25 });
  await expect(page.locator(".grand-master .value")).toHaveText("25%");
  // the MIDI action is offered on the right-click menu
  await page.locator('[data-widget="gm"]').click({ button: "right" });
  await expect(page.getByRole("dialog", { name: "Réglages du widget" })).toContainText("Apprendre une note ou un CC");
  await page.keyboard.press("Escape");
  await api(page, "grandmaster.set", { level: 1 });
  await api(page, "dashboard.put", { dashboard: dash });
  expect(errors).toEqual([]);
});

test("Tap widget: a tempo typed by hand, Escape cancels", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const tempo = async () => (await api(page, "tempo.get")) as { bpm: number; source: string };
  const before = await tempo(); // given back at the end: the server starts on the MIDI clock
  const field = page.getByLabel("Tempo (BPM)");
  await field.click();
  await field.fill("97,5"); // a comma, as typed in French
  await field.press("Enter");
  await expect.poll(tempo).toMatchObject({ bpm: 97.5, source: "manual" });
  await expect(field).toHaveValue("97.5");
  await field.click();
  await field.fill("150");
  await field.press("Escape");
  await expect(field).toHaveValue("97.5");
  await field.click();
  await page.locator("header.top").click(); // left untouched: nothing sent
  expect((await tempo()).bpm).toBe(97.5);
  await api(page, "tempo.set", { bpm: before.bpm, source: before.source });
  await expect(field).toHaveValue(before.bpm.toFixed(1));
  expect(errors).toEqual([]);
});

test("an update on the server is offered to a tab left open, which reloads on the new one", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await expect(page.locator(".new-version")).toHaveCount(0); // the same build: nothing to say
  // the server now serves another build of the page
  const isPage = (url: URL) => url.pathname === "/";
  await page.route(isPage, async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, body: (await res.text()).replace(/src="\/assets\/[^"]+\.js"/, 'src="/assets/index-newer.js"') });
  });
  await page.evaluate("document.dispatchEvent(new Event('visibilitychange'))"); // the tab shown again
  const banner = page.locator(".new-version");
  await expect(banner).toContainText("nouvelle version");
  await page.unroute(isPage);
  await banner.getByRole("button", { name: "Recharger" }).click();
  await expect(page.locator("header.top")).toBeVisible();
  await page.evaluate("document.dispatchEvent(new Event('visibilitychange'))");
  await page.waitForTimeout(300);
  await expect(page.locator(".new-version")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("right-click menu: long names never widen it past the screen, on a computer or a phone", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const canvas = ((await api(page, "venue.canvas.list")) as { id: string }[])[0]!.id;
  const long = "Couplet final très lumineux avec les barres en dégradé ambre et les lyres au public";
  await api(page, "look.put", { look: { id: "long-name", name: long, canvas, technique: { kind: "plat", color: "#ffffff" }, timing: { every: { beats: 1 }, attack: 0, order: "loop", entryFade: 0 } } });
  for (const viewport of [{ width: 1280, height: 800 }, { width: 375, height: 740 }]) {
    await page.setViewportSize(viewport);
    await page.reload();
    const button = page.locator(".dgrid .cell button", { hasText: "hole" }).first();
    await button.scrollIntoViewIfNeeded();
    await button.click({ button: "right" });
    const menu = page.getByRole("dialog", { name: "Réglages du widget" });
    await expect(menu).toBeVisible();
    const fit = {
      ...(await menu.evaluate((m) => ({ right: m.getBoundingClientRect().right, left: m.getBoundingClientRect().left, sideways: m.scrollWidth - m.clientWidth }))),
      ...(await page.evaluate<{ page: number; screen: number }>("({ page: document.documentElement.scrollWidth, screen: window.innerWidth })")),
    };
    expect(fit.sideways).toBe(0); // nothing to scroll sideways inside the menu
    expect(fit.left).toBeGreaterThanOrEqual(0);
    expect(fit.right).toBeLessThanOrEqual(fit.screen);
    expect(fit.page).toBeLessThanOrEqual(fit.screen);
    await page.screenshot({ path: `test-results/widget-menu-${viewport.width}.png` });
    await page.keyboard.press("Escape");
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await api(page, "look.delete", { id: "long-name", force: true });
  expect(errors).toEqual([]);
});

test("right-click on a dashboard button: assign another look, learn a MIDI note for it, no edit mode", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await api(page, "look.stopall");
  const button = page.locator(".dgrid .cell button", { hasText: "hole" }).first();
  await button.click({ button: "right" });
  const menu = page.getByRole("dialog", { name: "Réglages du widget" });
  await expect(menu).toBeVisible();
  await menu.getByLabel("Look lancé").selectOption("breath");
  await expect(page.locator(".dgrid .cell button", { hasText: "breath" })).toHaveCount(2); // saved: this button now starts « breath »
  await menu.getByRole("button", { name: "Apprendre une note ou un CC" }).click();
  await expect(menu.getByRole("button", { name: /J'écoute/ })).toBeVisible();
  await api(page, "midi.in", { port: "Web MIDI · test", bytes: [0x90, 61, 100] });
  await expect(menu).toContainText("note 61 · 1");
  await page.screenshot({ path: "test-results/widget-menu.png" });
  await api(page, "midi.in", { port: "Web MIDI · test", bytes: [0x90, 61, 100] });
  await expect.poll(async () => ((await api(page, "look.list")) as { id: string; active: boolean }[]).find((l) => l.id === "breath")?.active).toBe(true);
  // clean up: the mapping, then the button back to « hole »
  await menu.locator("li", { hasText: "note 61" }).getByRole("button").click();
  await expect(menu).toContainText("aucune note ni CC");
  await menu.getByLabel("Look lancé").selectOption("hole");
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await api(page, "look.stopall");
  expect(((await api(page, "dashboard.list")) as { widgets: { target?: string }[] }[])[0]!.widgets.filter((w) => w.target === "hole").length).toBe(1);
  expect(errors).toEqual([]);
});

test("roles: a volunteer sees only Live and their account; a right taken away greys its button", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page, "5678");
  expect(await page.locator("nav.pages button").allTextContents()).toEqual(["Live", "Mon compte"]);
  await expect(page.locator(".dgrid button", { hasText: "Panic neutre" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "✎" })).toHaveCount(0); // no layout editing
  await page.getByRole("button", { name: "Quitter" }).click();
  await login(page, "9999");
  await page.locator("nav.pages button", { hasText: "Réglages" }).click();
  const panic = page.getByLabel("Bénévole · Panic");
  await expect(panic).toBeChecked();
  await panic.uncheck();
  await expect(panic).not.toBeChecked();
  await page.screenshot({ path: "test-results/roles.png", fullPage: true });
  await page.getByRole("button", { name: "Quitter" }).click();
  await login(page, "5678");
  await expect(page.locator(".dgrid button", { hasText: "Panic neutre" })).toBeDisabled();
  await page.getByRole("button", { name: "Quitter" }).click();
  await login(page, "9999");
  await page.locator("nav.pages button", { hasText: "Réglages" }).click();
  await page.getByLabel("Bénévole · Panic").check();
  await expect(page.getByLabel("Bénévole · Panic")).toBeChecked();
  expect(errors.filter((e) => !e.includes("401"))).toEqual([]);
});

test("my account: signed in with the token, create my administrator account, then add my security key", async ({ page }) => {
  const errors = watchErrors(page);
  page.on("dialog", (d) => void d.accept());
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "usb", hasResidentKey: true, hasUserVerification: true, isUserVerified: true } });
  await page.goto("http://localhost:8799/#token=ui-test-token");
  await page.locator(".role").click(); // the name in the top bar leads to « Mon compte »
  const account = page.locator(".account");
  await expect(account).toContainText("Créer mon compte administrateur");
  await account.getByLabel("Nom de l'utilisateur").fill("Moi");
  await account.getByRole("button", { name: "Créer le compte" }).click();
  await account.getByRole("button", { name: "Ajouter une clé" }).click();
  await expect(account.locator(".keys-table")).toContainText("Clé de Moi");
  await page.screenshot({ path: "test-results/account.png", fullPage: true });
  await page.getByRole("button", { name: "Quitter" }).click();
  await page.getByRole("button", { name: "Entrer avec une clé de sécurité" }).click();
  await expect(page.locator(".role")).toHaveText("Moi");
  await page.locator("nav.pages button", { hasText: "Réglages" }).click();
  await expect(page.locator(".users-table tr", { hasText: "Moi" })).toContainText("c'est vous"); // one cannot delete oneself
  // clean up with the token
  await page.getByRole("button", { name: "Quitter" }).click();
  await page.goto("about:blank");
  await page.goto("http://localhost:8799/#token=ui-test-token");
  await page.locator("nav.pages button", { hasText: "Réglages" }).click();
  await page.locator(".users-table tr", { hasText: "Moi" }).getByRole("button", { name: "Supprimer" }).click();
  await expect(page.locator(".users-table")).not.toContainText("Moi");
  expect(errors.filter((e) => !e.includes("401"))).toEqual([]);
});

test("colours: a button gets a colour from its menu, or its look's own (auto), and lights up in it", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await api(page, "look.stopall");
  const cell = page.locator(".dgrid .cell", { has: page.locator("button", { hasText: "hole" }) }).first();
  await cell.locator("button").click({ button: "right" });
  const menu = page.getByRole("dialog", { name: "Réglages du widget" });
  await menu.getByRole("radio", { name: "bleu" }).click();
  await expect(cell).toHaveClass(/tinted/);
  await expect(cell).toHaveAttribute("style", /--wc: #3b82f6/);
  await menu.getByRole("radio", { name: "Auto : la couleur de son look" }).click();
  await expect(cell).toHaveAttribute("style", /--wc: #ff0000/); // « hole » is red
  await page.keyboard.press("Escape");
  await cell.locator("button").click(); // on: filled with its colour
  await expect(cell.locator("button")).toHaveCSS("background-color", "rgb(255, 0, 0)");
  await page.screenshot({ path: "test-results/colours.png" });
  // back to neutral
  await api(page, "look.stopall");
  await cell.locator("button").click({ button: "right" });
  await menu.getByRole("radio", { name: "Sans couleur" }).click();
  await expect(cell).not.toHaveClass(/tinted/);
  expect(errors).toEqual([]);
});

test("a rule that asks first: pressing a look it would bound asks, and plays on yes", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await api(page, "look.stopall");
  // « hole » paints red: a rule on red asks before it is launched
  await api(page, "rule.put", { rule: { id: "demande", name: "Rouge demandé", level: "show", target: { color: "red" }, max: 128, onViolation: "confirm" } });
  try {
    const active = async () => ((await api(page, "look.list")) as { id: string; active: boolean }[]).find((l) => l.id === "hole")!.active;
    let asked = "";
    page.once("dialog", (d) => ((asked = d.message()), void d.dismiss()));
    await page.locator(".dgrid button.look", { hasText: "hole" }).first().click();
    await expect.poll(() => asked).toContain("Rouge demandé");
    expect(await active()).toBe(false); // « Annuler »: not launched
    page.once("dialog", (d) => void d.accept());
    await page.locator(".dgrid button.look", { hasText: "hole" }).first().click();
    await expect.poll(active).toBe(true);
  } finally {
    await api(page, "rule.delete", { where: "show", id: "demande" });
    await api(page, "look.stopall");
  }
  expect(errors.filter((e) => !e.includes("422"))).toEqual([]); // the question comes as a 422: the browser logs it
});

test("a button to confirm: the first press arms it, the second plays; stopping never asks", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await api(page, "look.stopall");
  const cell = page.locator(".dgrid .cell", { has: page.locator("button", { hasText: "hole" }) }).first();
  const button = cell.locator("button");
  const active = async () => ((await api(page, "look.list")) as { id: string; active: boolean }[]).find((l) => l.id === "hole")!.active;
  await button.click({ button: "right" });
  await page.getByRole("dialog", { name: "Réglages du widget" }).getByLabel("À confirmer (deux appuis)").check();
  await page.keyboard.press("Escape");
  await button.click();
  await expect(button).toContainText("Appuyer encore");
  expect(await active()).toBe(false);
  await page.screenshot({ path: "test-results/confirm-armed.png" });
  await button.click();
  await expect.poll(active).toBe(true);
  await expect(button).not.toContainText("Appuyer encore");
  await button.click(); // a latch stops at once
  await expect.poll(active).toBe(false);
  await button.click(); // armed, then left alone: it disarms
  await expect(button).toContainText("Appuyer encore");
  await expect(button).not.toContainText("Appuyer encore", { timeout: 5000 });
  expect(await active()).toBe(false);
  // back to a plain button
  await button.click({ button: "right" });
  await page.getByRole("dialog", { name: "Réglages du widget" }).getByLabel("À confirmer (deux appuis)").uncheck();
  await page.keyboard.press("Escape");
  await expect.poll(async () => JSON.stringify(await api(page, "dashboard.list"))).not.toContain('"confirm"'); // saved before the next test presses it
  expect(errors).toEqual([]);
});

test("tablet, editing a dashboard: a blank strip on the right scrolls, widgets still move", async ({ browser }) => {
  // a landscape tablet with the keyboard up: the page is always taller than the screen
  const ctx = await browser.newContext({ hasTouch: true, viewport: { width: 820, height: 480 }, baseURL: "http://127.0.0.1:8799", locale: "fr-FR" });
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await login(page);
  await page.getByRole("button", { name: "✎" }).click();
  await page.getByLabel("Colonnes").fill("24"); // wider than the tablet: the grid scrolls sideways too
  await expect.poll(() => page.locator(".dgrid-scroll").evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
  const gutter = page.locator(".scroll-gutter");
  await expect(gutter).toBeVisible();
  const touch = (sel: string) => page.evaluate<string>(`getComputedStyle(document.querySelector(${JSON.stringify(sel)})).touchAction`);
  expect(await touch(".dgrid.fine.editing")).toBe("pan-x pan-y"); // the empty cells scroll
  expect(await touch(".dgrid.fine.editing > .cell")).toBe("none"); // a widget takes the finger
  // kept at the right edge of the screen, wherever the grid is scrolled
  await page.locator(".dgrid-scroll").evaluate((e) => (e.scrollLeft = e.scrollWidth));
  const box = (await gutter.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(820);
  expect(box.x + box.width).toBeGreaterThan(760);
  // a finger dragged down the strip scrolls the page back up (taller than the screen, whatever the fonts)
  await page.evaluate("window.scrollTo(0, document.documentElement.scrollHeight)");
  const y0 = await page.evaluate<number>("window.scrollY");
  expect(y0).toBeGreaterThan(100);
  // the grid's own box scrolls sideways only: a vertical swipe always goes to the page
  expect(await page.evaluate<string>("getComputedStyle(document.querySelector('.dgrid-scroll')).overflowY")).toBe("hidden");
  const cdp = await ctx.newCDPSession(page);
  const strip = (await gutter.boundingBox())!;
  const y = Math.round(Math.max(strip.y + 10, 10));
  expect(y + 200).toBeLessThan(480); // the whole gesture on screen, on the strip
  await cdp.send("Input.synthesizeScrollGesture", { x: Math.round(strip.x + strip.width / 2), y, yDistance: 200, gestureSourceType: "touch", speed: 800 });
  await expect.poll(() => page.evaluate<number>("window.scrollY")).toBeLessThan(y0);
  await page.screenshot({ path: "test-results/tablet-edit-gutter.png" });
  // a finger on a widget still moves it, and does not scroll
  await page.locator(".dgrid-scroll").evaluate((e) => (e.scrollLeft = 0));
  const cell = page.locator(".dgrid.fine.editing > .cell").first();
  await cell.scrollIntoViewIfNeeded();
  const column = () => cell.getAttribute("style");
  const before = await column();
  const c = (await cell.boundingBox())!;
  const from = { x: Math.round(c.x + c.width / 2), y: Math.round(c.y + c.height / 2) };
  const scrollBefore = await page.evaluate<number>("window.scrollY");
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
  for (let i = 1; i <= 6; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x + i * 25, y: from.y }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(column).not.toBe(before);
  expect(await page.evaluate<number>("window.scrollY")).toBe(scrollBefore);
  await page.getByRole("button", { name: "✕", exact: true }).first().click(); // cancel: nothing saved
  await expect(page.locator(".scroll-gutter")).toHaveCount(0);
  expect(errors).toEqual([]);
  await ctx.close();
});

test("tablet: a long press opens the widget menu, without starting the look", async ({ browser }) => {
  const ctx = await browser.newContext({ hasTouch: true, viewport: { width: 820, height: 1180 }, baseURL: "http://127.0.0.1:8799", locale: "fr-FR" });
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await login(page);
  await api(page, "look.stopall");
  const button = page.locator(".dgrid .cell button", { hasText: "hole" }).first();
  const box = (await button.boundingBox())!;
  const cdp = await ctx.newCDPSession(page);
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at] });
  await page.waitForTimeout(800);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(page.getByRole("dialog", { name: "Réglages du widget" })).toBeVisible();
  await page.waitForTimeout(300);
  expect(((await api(page, "look.list")) as { id: string; active: boolean }[]).find((l) => l.id === "hole")?.active).toBe(false);
  // a short tap still plays it
  await page.keyboard.press("Escape");
  await button.tap();
  await expect.poll(async () => ((await api(page, "look.list")) as { id: string; active: boolean }[]).find((l) => l.id === "hole")?.active).toBe(true);
  await api(page, "look.stopall");
  expect(errors).toEqual([]);
  await ctx.close();
});

test("layout editing: drag to move, a corner to resize, magnetic grid on or off, wide dashboards scroll sideways", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const [dash] = (await api(page, "dashboard.list")) as { widgets: { id: string; kind: string; target?: string; x: number; y: number; w: number }[] }[];
  const hole = dash!.widgets.find((w) => w.kind === "look" && w.target === "hole")!;
  await page.getByRole("button", { name: "✎" }).click();
  const cell = page.locator(`.dgrid .cell[data-widget="${hole.id}"]`);
  const grid = page.locator(".dgrid.fine");
  const pos = page.locator(".dashboards .editor .hint");
  const columns = Number(await page.getByLabel("Colonnes").inputValue());
  const cw = (await grid.boundingBox())!.width / columns;
  const drag = async (from: { x: number; y: number }, dx: number, dy: number) => {
    // pointer events only reach what is on screen: points taken off-screen would never land
    expect(from.y, "drag start on screen").toBeLessThan(page.viewportSize()!.height);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 4 });
    await page.mouse.move(from.x + dx, from.y + dy, { steps: 4 });
    await page.mouse.up();
  };
  await cell.evaluate((e) => e.scrollIntoView({ block: "center" })); // its corners must be on screen to be dragged
  await cell.click(); // select: its position shows in the editor bar
  const [x0, y0, w0] = (await pos.textContent())!.match(/[\d.]+/g)!.map(Number);
  // centred before each drag: the widget bar above the grid grows (two lines with wider fonts) and pushes it down
  const centre = () => cell.evaluate((e) => e.scrollIntoView({ block: "center" }));
  await centre();
  let box = (await cell.boundingBox())!;
  await drag({ x: box.x + box.width / 2, y: box.y + box.height / 2 }, cw * 2, 0); // two columns right
  await expect(pos).toHaveText(`${x0! + 2},${y0} · ${w0}×1`);
  await centre();
  box = (await cell.boundingBox())!;
  await drag({ x: box.x + box.width - 3, y: box.y + box.height - 3 }, cw, 0); // the bottom-right corner: one column wider
  await expect(pos).toHaveText(`${x0! + 2},${y0} · ${w0! + 1}×1`);
  await page.getByRole("button", { name: "Grille magnétique" }).click(); // off: quarters
  await centre();
  box = (await cell.boundingBox())!;
  await drag({ x: box.x + box.width / 2, y: box.y + box.height / 2 }, cw * 0.27, 0);
  await expect(pos).toHaveText(`${x0! + 2.25},${y0} · ${w0! + 1}×1`);
  await page.screenshot({ path: "test-results/layout-editing.png" });
  // what it was dropped onto went down, nothing overlaps
  const boxes = await page.locator(".dgrid .cell").evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ l: r.left, t: r.top, r: r.right, b: r.bottom })));
  const overlaps = boxes.flatMap((a, i) => boxes.slice(i + 1).filter((b) => a.l < b.r - 1 && b.l < a.r - 1 && a.t < b.b - 1 && b.t < a.b - 1));
  expect(overlaps).toEqual([]);
  await page.getByRole("button", { name: "Grille magnétique" }).click(); // back on for the other tests
  await page.getByLabel("Colonnes").fill("32");
  await expect.poll(() => page.locator(".dgrid-scroll").evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
  await page.getByRole("button", { name: "✕", exact: true }).first().click(); // cancel: nothing saved
  await expect(page.locator(".dgrid-scroll")).toBeVisible();
  expect(((await api(page, "dashboard.list")) as { columns: number }[])[0]!.columns).toBe(columns);
  expect(errors).toEqual([]);
});

test("dashboards: a new one, a look dragged from the palette, undo and redo, a snapshot button, full screen, then deleted", async ({ page }) => {
  const errors = watchErrors(page);
  page.on("dialog", (d) => void d.accept());
  await login(page);
  await api(page, "look.stopall");
  await api(page, "look.go", { id: "breath" });
  await api(page, "snapshot.save", { name: "Respire" });
  await api(page, "look.stopall");
  await page.getByRole("button", { name: "✎" }).click();
  await page.getByRole("button", { name: "+ Nouveau" }).click();
  await expect(page.locator(".dashboards .bar .tab.active")).toContainText("Nouveau dashboard");
  await page.getByLabel("Nom", { exact: true }).fill("Louange");
  const grid = page.locator(".dgrid.fine");
  await page.locator(".palette .chips.bound .chip", { hasText: "hole" }).dragTo(grid, { targetPosition: { x: 200, y: 20 } });
  await expect(grid.locator(".cell", { hasText: "hole" })).toHaveCount(1);
  await page.getByRole("button", { name: "Annuler" }).click();
  await expect(grid.locator(".cell", { hasText: "hole" })).toHaveCount(0);
  await page.getByRole("button", { name: "Rétablir" }).click();
  await expect(grid.locator(".cell", { hasText: "hole" })).toHaveCount(1);
  await page.locator(".palette .chips.bound .chip", { hasText: "Respire" }).click(); // a click adds it under the others
  await page.getByRole("button", { name: "✔" }).click();
  await expect(page.locator(".dashboards .bar .tab.active")).toContainText("Louange");
  await page.locator(".dgrid button.snapshot", { hasText: "Respire" }).click();
  await expect.poll(async () => ((await api(page, "look.list")) as { id: string; active: boolean }[]).find((l) => l.id === "breath")?.active).toBe(true);
  await page.getByRole("button", { name: "Plein écran" }).click();
  await expect(page.locator(".sidebar")).toBeHidden();
  await page.screenshot({ path: "test-results/kiosk.png" });
  await page.getByRole("button", { name: "Plein écran" }).click();
  await expect(page.locator(".sidebar")).toBeVisible();
  await page.getByRole("button", { name: "✎" }).click();
  await page.locator(".dash-manage").getByRole("button", { name: "Supprimer" }).click();
  await expect(page.locator(".dashboards .bar .tab", { hasText: "Louange" })).toHaveCount(0);
  await page.getByRole("button", { name: "✕", exact: true }).first().click();
  await api(page, "look.stopall");
  await api(page, "snapshot.delete", { id: "respire" });
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
  await page.locator("nav.pages button", { hasText: "Show" }).click();
  const max = page.getByLabel("max Master");
  await max.fill("50");
  await max.blur();
  await expect.poll(async () => ((await api(page, "group.list")) as { id: string; limits?: { max?: number } }[]).find((g) => g.id === "master")?.limits?.max).toBe(0.5);
  await page.locator("nav.pages button", { hasText: "Live" }).click();
  await expect(page.locator(".fader .mark.max")).toBeVisible();
  const fader = page.getByLabel("DCA Master");
  await fader.fill("1000"); // pushed to the top…
  await expect(page.locator(".cell .fader .value").first()).toHaveText(/^50%/); // …it stops at the max, and is shown there
  await expect.poll(async () => (await dmx(page))[0]).toBe(128);
  await page.screenshot({ path: "test-results/dca-limits.png", fullPage: true });
  await page.locator("nav.pages button", { hasText: "Show" }).click();
  await page.getByLabel("max Master").fill("");
  await page.getByLabel("max Master").blur();
  await expect.poll(async () => ((await api(page, "group.list")) as { id: string; limits?: { max?: number } }[]).find((g) => g.id === "master")?.limits?.max).toBeUndefined();
  await api(page, "group.level", { id: "master", level: 1 });
  expect(errors).toEqual([]);
});

test("show page: a long list of looks is searched and filtered by its QLC+ folder", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const canvas = ((await api(page, "venue.canvas.list")) as { id: string }[])[0]!.id;
  const extra = Array.from({ length: 6 }, (_, i) => ({
    id: `long-${i}`,
    name: `Long ${i}`,
    canvas,
    technique: { kind: "plat", color: "#ff0000" },
    timing: { every: { beats: 1 }, attack: 0, order: "loop", entryFade: 0 },
    tags: [i < 2 ? "dossier:Machines" : "dossier:Chants"],
  }));
  for (const look of extra) await api(page, "look.put", { look });
  try {
    await page.locator("nav.pages").getByRole("button", { name: "Show", exact: true }).click();
    await expect(page.getByRole("heading", { name: /Looks \(11\)/ })).toBeVisible();
    await page.getByLabel("Dossier").selectOption("Machines");
    await expect(page.getByRole("heading", { name: /Looks \(2 \/ 11\)/ })).toBeVisible();
    await page.getByLabel("Dossier").selectOption("");
    await page.getByRole("searchbox", { name: "Chercher un look" }).fill("long 5");
    await expect(page.locator("button.look", { hasText: "Long 5" })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Looks \(1 \/ 11\)/ })).toBeVisible();
  } finally {
    for (const look of extra) await api(page, "look.delete", { id: look.id, force: true });
  }
  expect(errors).toEqual([]);
});

test("show page: a deleted look comes back from « Récemment supprimés »", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const canvas = ((await api(page, "venue.canvas.list")) as { id: string }[])[0]!.id;
  await api(page, "look.put", { look: { id: "ephemere", name: "Éphémère", canvas, technique: { kind: "plat", color: "#00ff00" }, timing: { every: { beats: 1 }, attack: 0, order: "loop", entryFade: 0 } } });
  await api(page, "look.delete", { id: "ephemere" });
  await page.locator("nav.pages").getByRole("button", { name: "Show", exact: true }).click();
  await expect(page.locator("button.look", { hasText: "Éphémère" })).toHaveCount(0);
  const bin = page.locator("details.recently-deleted");
  await bin.locator("summary").click();
  page.once("dialog", (d) => void d.accept());
  await bin.locator("li", { hasText: "Éphémère" }).getByRole("button", { name: "Restaurer" }).click();
  await expect(page.locator("button.look", { hasText: "Éphémère" })).toBeVisible();
  await expect(bin.locator("li", { hasText: "Éphémère" })).toHaveCount(0);
  await api(page, "look.delete", { id: "ephemere", force: true });
  expect(errors).toEqual([]);
});

test("settings: recent activity says who did what, from where, a dragged fader on one line", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page); // the régisseur
  await page.locator("button.look", { hasText: "hole" }).first().click();
  for (const level of [0.2, 0.4, 0.6]) await api(page, "group.level", { id: "master", level });
  await api(page, "group.level", { id: "master", level: 1 });
  await page.locator("nav.pages").getByRole("button", { name: "Réglages" }).click();
  const log = page.locator("table.activity");
  await expect(log.locator("tr", { hasText: "Niveau de groupe" }).first()).toContainText("×4");
  await expect(log.locator("tr", { hasText: "Lancer un look" }).first()).toContainText("Régisseur");
  await expect(log.locator("tr", { hasText: "Lancer un look" }).first()).toContainText("hole");
  // filters: only what came from the server itself (the test show's setup), then back to everything
  await page.getByLabel("D'où").selectOption({ label: "serveur" });
  await expect(log.locator("tr", { hasText: "Lancer un look" })).toHaveCount(0);
  await expect(log.locator("tr").first()).toContainText("serveur");
  await page.getByLabel("D'où").selectOption("");
  await page.getByLabel("Qui").selectOption("Régisseur");
  await expect(log.locator("tr", { hasText: "Lancer un look" }).first()).toBeVisible();
  await api(page, "look.stopall");
  expect(errors).toEqual([]);
});

test("settings: a change is undone from its line in the recent activity, after saying what came since", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const look = (await api(page, "look.get", { id: "masks" })) as { name: string };
  await api(page, "look.put", { look: { ...look, name: "Masques bleus" } });
  await page.locator("nav.pages").getByRole("button", { name: "Réglages" }).click();
  const line = page.locator("table.activity tr", { hasText: "masks" }).filter({ has: page.getByRole("button", { name: /Annuler cette modification/ }) }).first();
  await expect(line).toBeVisible();
  await expect(page.locator("table.activity tr", { hasText: "Niveau de groupe" }).getByRole("button", { name: /Annuler/ })).toHaveCount(0); // a level is state
  let asked = "";
  page.once("dialog", (d) => ((asked = d.message()), void d.accept()));
  await line.getByRole("button", { name: /Annuler cette modification/ }).click();
  await expect.poll(async () => ((await api(page, "look.get", { id: "masks" })) as { name: string }).name).toBe(look.name);
  expect(asked).toContain("« masks »");
  expect(errors).toEqual([]);
});

test("settings: who is online, this page included", async ({ page, browser }) => {
  const errors = watchErrors(page);
  const other = await browser.newContext({ locale: "fr-FR" });
  const tablet = await other.newPage();
  await login(tablet, "5678"); // a volunteer on a tablet
  await login(page, "9999");
  await page.locator("nav.pages").getByRole("button", { name: "Réglages" }).click();
  const online = page.locator("ul.online");
  await expect(online.locator("li", { hasText: "Bénévole" })).toBeVisible();
  await expect(online.locator("li", { hasText: "cette page" })).toContainText("Administrateur");
  await other.close();
  await expect(online.locator("li", { hasText: "Bénévole" })).toHaveCount(0, { timeout: 10_000 }); // gone with its page
  expect(errors).toEqual([]);
});

test("midi page: mappings in number order, and a search past a handful", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const numbers = [30, 3, 100, 29, 5, 12, 4];
  for (const n of numbers) await api(page, "midi.mapping.put", { mapping: { id: `sort-${n}`, label: `Tri ${n}`, input: { type: "note", channel: 9, number: n }, on: { command: "look.go", args: { id: "hole" } } } });
  try {
    await page.locator("nav.pages").getByRole("button", { name: "MIDI" }).click();
    const rows = page.locator("tr", { hasText: "Tri " });
    await expect(rows).toHaveCount(numbers.length);
    expect(await rows.locator("td:nth-child(3)").allTextContents()).toEqual(["Tri 3", "Tri 4", "Tri 5", "Tri 12", "Tri 29", "Tri 30", "Tri 100"]);
    await page.getByRole("searchbox", { name: /Chercher/ }).fill("note 29");
    await expect(rows).toHaveCount(1);
    await expect(page.getByRole("heading", { name: /Mappings \(1 \/ \d+\)/ })).toBeVisible();
  } finally {
    for (const n of numbers) await api(page, "midi.mapping.delete", { id: `sort-${n}` });
  }
  expect(errors).toEqual([]);
});

test("a proposal is read on the Show page, applied at once, then taken back", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const look = (await api(page, "look.get", { id: "masks" })) as { name: string };
  const made = (await api(page, "show.propose", { title: "Renommer masks", changes: [{ command: "look.put", args: { look: { ...look, name: "Masques IA" } } }] })) as { id: string };
  await page.locator("nav.pages").getByRole("button", { name: "Show", exact: true }).click();
  const card = page.locator(".proposal", { hasText: "Renommer masks" });
  await expect(card).toContainText("name : « masks » → « Masques IA »");
  await card.getByRole("button", { name: "Appliquer" }).click();
  await expect(card).toContainText("appliquée");
  expect(((await api(page, "look.get", { id: "masks" })) as { name: string }).name).toBe("Masques IA");
  await card.getByRole("button", { name: /Défaire/ }).click();
  await expect(card).toContainText("défaite");
  expect(((await api(page, "look.get", { id: "masks" })) as { name: string }).name).toBe(look.name);
  await page.screenshot({ path: "test-results/proposals.png" });
  await card.getByRole("button", { name: "Écarter" }).click();
  await expect(page.locator(".proposal", { hasText: "Renommer masks" })).toHaveCount(0);
  expect(made.id).toMatch(/^p-/);
  expect(errors).toEqual([]);
});

test("live AI: switched on from the Show page, said in every page's header, then off", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.locator("nav.pages").getByRole("button", { name: "Show", exact: true }).click();
  await page.getByLabel("IA en live").click(); // saved, then shown ticked
  await expect(page.getByLabel("IA en live")).toBeChecked();
  await expect(page.locator("header button.badge", { hasText: "IA en live" })).toBeVisible();
  await page.locator("nav.pages").getByRole("button", { name: "Live" }).click();
  await expect(page.locator("header button.badge", { hasText: "IA en live" })).toBeVisible(); // on every page
  await page.locator("header button.badge", { hasText: "IA en live" }).click(); // back to where it is switched
  await page.getByLabel("IA en live").click();
  await expect(page.getByLabel("IA en live")).not.toBeChecked();
  await expect(page.locator("header button.badge", { hasText: "IA en live" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("show check: a summary first, errors before warnings, and it closes", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await api(page, "venue.fixture.put", { fixture: { id: "overlap", name: "Chevauche", manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 1, address: 5 } });
  try {
    await page.locator("nav.pages").getByRole("button", { name: "Show", exact: true }).click();
    await page.getByRole("button", { name: "Vérifier le show" }).click();
    const report = page.locator(".lint-report");
    await expect(report.locator("strong")).toContainText(/⚠ \d+ alerte\(s\)/);
    await expect(report.locator("li", { hasText: "Chevauche" }).first()).toContainText("mêmes canaux");
    await report.getByRole("button", { name: "Fermer" }).click();
    await expect(report).toHaveCount(0);
    // in English, the server words its findings in English too
    await page.locator("header select").selectOption("en");
    await page.getByRole("button", { name: "Check the show" }).click();
    await expect(report.locator("li", { hasText: "Chevauche" }).first()).toContainText("two fixtures write the same channels");
  } finally {
    await page.locator("header select").selectOption("fr");
    await api(page, "venue.fixture.delete", { id: "overlap" });
  }
  expect(errors).toEqual([]);
});

test("venue: the patch reads by address, and fixtures sharing channels are flagged", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await api(page, "venue.fixture.put", { fixture: { id: "extra", name: "Extra", manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 1, address: 10 } });
  try {
    await page.locator("nav.pages").getByRole("button", { name: "Lieu" }).click();
    const universe1 = page.locator("tr", { hasText: /U1\.\d+/ });
    await expect(universe1.locator("td:nth-child(2)")).toHaveText(["Bar 0", "Extra", "Bar 1"]);
    await expect(page.locator("tr", { hasText: "Extra" }).locator(".badge.conflict")).toContainText("chevauche");
    await expect(page.locator("tr", { hasText: "Bar 0" }).locator(".badge.conflict")).toHaveCount(1);
    await api(page, "venue.fixture.put", { fixture: { id: "fog", name: "Fumée", manufacturer: "Acme", model: "Fog", mode: "Full", universe: 2, address: 100 } });
    await expect(page.locator("tr", { hasText: "Fumée" })).toContainText("sans définition");
  } finally {
    await api(page, "venue.fixture.delete", { id: "extra" });
    await api(page, "venue.fixture.delete", { id: "fog" });
  }
  expect(errors).toEqual([]);
});

test("notes: grouped by kind, one line each, edited in place", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.locator("nav.pages").getByRole("button", { name: "Notes" }).click();
  const looks = page.locator("details.note-group", { has: page.locator("summary", { hasText: "Looks" }) });
  await expect(looks).toHaveAttribute("open", "");
  const row = looks.locator("li", { hasText: "note de test" });
  await row.locator(".note-text").click();
  await row.getByRole("textbox").fill("note de test, relue");
  await row.getByRole("button", { name: "✔" }).click();
  await expect(looks.locator("li", { hasText: "note de test, relue" })).toBeVisible();
  await api(page, "notes.set", { collection: "looks", id: "checker", notes: "note de test" });
  expect(errors).toEqual([]);
});

test("installable on a tablet's home screen: manifest and icons are served", async ({ request, page }) => {
  const manifest = await request.get("/manifest.webmanifest");
  expect(manifest.status()).toBe(200);
  const m = (await manifest.json()) as { start_url: string; display: string; icons: { src: string }[] };
  expect(m).toMatchObject({ start_url: "/#live", display: "standalone" });
  for (const icon of [...m.icons.map((i) => i.src), "/apple-touch-icon.png"]) expect((await request.get(icon)).status(), icon).toBe(200);
  await page.goto("/");
  await expect(page).toHaveTitle("Lumière");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
});

test("built assets are cached for good, the page itself is checked each time", async ({ request }) => {
  const index = await request.get("/");
  expect(index.headers()["cache-control"]).toBe("public, max-age=0");
  const asset = /assets\/index-[^"]+\.js/.exec(await index.text())![0];
  const res = await request.get(`/${asset}`);
  expect(res.status()).toBe(200);
  expect(res.headers()["cache-control"]).toContain("immutable");
  expect((await request.get("/assets/nope.js")).status()).toBe(404); // a missing asset is not the app page
});

test("a session closed on the server sends the page back to sign-in, with the reason", async ({ page, request }) => {
  const errors = watchErrors(page);
  await login(page);
  const token = await page.evaluate(() => sessionStorage.getItem("token"));
  await request.post("/api/auth/logout", { headers: { authorization: `Bearer ${token}` } });
  await page.locator("nav.pages").getByRole("button", { name: "Show", exact: true }).click(); // its first command gets a 401
  await expect(page.locator("form.pin-login")).toBeVisible();
  await expect(page.getByText(/Session terminée/)).toBeVisible();
  // the browser itself logs the refused requests and a socket whose ticket predates the sign-out
  expect(errors.filter((e) => !e.includes("401") && !e.includes("WebSocket connection"))).toEqual([]);
});

test("a Panic pressed by mistake is undone with « Revenir », within the minute", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.locator("button.look", { hasText: "hole" }).first().click();
  await expect(page.locator("button.look", { hasText: "hole" }).first()).toHaveClass(/on/);
  await page.getByRole("button", { name: "Panic neutre" }).first().click();
  await expect(page.locator("button.look", { hasText: "hole" }).first()).not.toHaveClass(/on/);
  const undo = page.getByRole("button", { name: /Revenir/ });
  await expect(undo).toBeVisible({ timeout: 5000 });
  await page.screenshot({ path: "test-results/panic-undo.png", clip: { x: 190, y: 50, width: 700, height: 140 } });
  await undo.click();
  await expect(page.locator("button.look", { hasText: "hole" }).first()).toHaveClass(/on/);
  await expect(undo).toHaveCount(0, { timeout: 5000 }); // once
  await api(page, "look.stopall");
  expect(errors).toEqual([]);
});

test("full screen keeps the tablet awake, and lets it sleep again on the way out", async ({ page }) => {
  // a stand-in for the Screen Wake Lock: what the page asked for, and what it gave back
  await page.addInitScript(() => {
    const log: string[] = [];
    (globalThis as unknown as { wakeLog: string[] }).wakeLog = log;
    Object.defineProperty(navigator, "wakeLock", { value: { request: async () => (log.push("request"), { release: async () => void log.push("release") }) } });
  });
  await login(page);
  const wakeLog = () => page.evaluate(() => (globalThis as unknown as { wakeLog: string[] }).wakeLog);
  await page.getByRole("button", { name: "Plein écran" }).click();
  await expect.poll(wakeLog).toEqual(["request"]);
  await page.getByRole("button", { name: "Plein écran" }).click();
  await expect.poll(wakeLog).toEqual(["request", "release"]);
});

test("« stay signed in on this device »: a new tab opens signed in, until « Quitter »", async ({ page, context }) => {
  await page.goto("/");
  await page.getByLabel("Rester connecté sur cet appareil").check();
  await page.locator("form.pin-login select").selectOption("regisseur");
  await page.getByPlaceholder(/PIN/).fill("1234");
  await page.locator("form.pin-login button").click();
  await expect(page.locator("header.top")).toBeVisible();
  const tab = await context.newPage(); // a new tab, or the home-screen app opened again: no sessionStorage
  await tab.goto("/");
  await expect(tab.locator("header.top")).toBeVisible();
  await tab.getByRole("button", { name: "Quitter" }).click();
  const another = await context.newPage();
  await another.goto("/");
  await expect(another.locator("form.pin-login")).toBeVisible(); // signed out on this device too
  await expect(another.getByLabel("Rester connecté sur cet appareil")).not.toBeChecked();
});

test("without « stay signed in », a new tab asks to sign in", async ({ page, context }) => {
  await login(page);
  const tab = await context.newPage();
  await tab.goto("/");
  await expect(tab.locator("form.pin-login")).toBeVisible();
});

test("reloading while the server restarts keeps the session: it waits, then comes back signed in", async ({ page }) => {
  await login(page);
  await page.route("**/api/auth/me", (route) => route.fulfill({ status: 502, body: "Bad Gateway" })); // the proxy, server down
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("Serveur injoignable");
  await expect(page.locator("form.pin-login")).toHaveCount(0);
  await page.unroute("**/api/auth/me");
  await expect(page.locator("header.top")).toBeVisible({ timeout: 10_000 }); // the next try gets in, no sign-in asked
});

test("a lost link to the server is said plainly, and goes away once it is back", async ({ page }) => {
  // the WebSockets go through the test: cut them as a server restart would, then let them back
  let down = false;
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket(/\/api\/ws/, (ws) => {
    if (down) return void ws.close();
    ws.connectToServer();
    sockets.push(ws);
  });
  await login(page);
  await expect(page.locator(".dot.ok")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  down = true;
  for (const ws of sockets) await ws.close();
  await expect(page.getByRole("alert")).toContainText("Liaison avec le serveur coupée", { timeout: 10_000 });
  down = false;
  await expect(page.getByRole("alert")).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator(".dot.ok")).toBeVisible();
});

test("getting started: a new empty show becomes playable from the Live page", async ({ page, request }) => {
  const errors = watchErrors(page);
  // setup and cleanup with the master token: opening a show reloads the app under page.evaluate
  const call = async (name: string, args: unknown = {}) =>
    ((await (await request.post(`/api/plugins/light/commands/${name}`, { headers: { authorization: "Bearer ui-test-token" }, data: args })).json()) as { result: unknown }).result;
  const before = ((await call("show.list")) as { id: string; active: boolean }[]).find((s) => s.active)!.id;
  await login(page);
  const guide = page.getByRole("region", { name: "Pour commencer" });
  await expect(guide).toHaveCount(0); // the test show is ready to play
  await expect(page.locator(".show-name")).toBeVisible(); // the app knows the open show: a switch reloads it
  const reloaded = page.waitForEvent("load");
  const created = (await call("show.create", { name: "Premier show", venue: "new" })) as { id: string };
  try {
    await reloaded; // the header shows the new name a moment before the reload: wait for the reload itself
    await expect(page.locator("header.top")).toContainText("Premier show");
    await expect(guide).toBeVisible();
    await expect(guide.getByRole("button", { name: "Un canevas avec tout le patch" })).toBeDisabled();
    await call("venue.fixture.put", { fixture: { id: "bar-a", name: "Bar A", manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 1, address: 1 } });
    await expect(guide.getByText("Patcher les projecteurs (1)")).toBeVisible();
    await guide.getByRole("button", { name: "Un canevas avec tout le patch" }).click();
    await guide.getByRole("button", { name: /Presets automatiques/ }).click();
    await guide.getByRole("button", { name: "Générer depuis le show" }).click();
    await expect(guide).toHaveCount(0);
    await expect(page.locator(".dgrid button.look").first()).toBeVisible();
  } finally {
    await page.goto("about:blank"); // leave before the app reloads on the show switch: no request cut mid-flight
    await call("show.open", { id: before });
    await call("show.delete", { id: created.id });
  }
  expect(errors).toEqual([]);
});

test("DMX console: shows live values and parks a channel", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.getByRole("button", { name: "Console DMX" }).click();
  // by default, the patched channels of universe 1, grouped by fixture and named
  const bar0 = page.getByRole("region", { name: "Bar 0" });
  await expect(bar0.locator(".ch")).toHaveCount(15);
  await expect(page.locator(".fx")).toHaveCount(2);
  const ch10 = bar0.locator(".ch").nth(9);
  await ch10.locator("input").fill("200");
  await expect(ch10).toHaveClass(/parked/);
  await expect(ch10.locator(".val")).toHaveText("200");
  // a forced channel is said on every page, until released
  await expect(page.locator("header.top")).toContainText("🔧 1 canal(aux) forcé(s)", { timeout: 5000 });
  // and the console says why a channel has its value
  await ch10.getByRole("button", { name: "Pourquoi ce canal 10" }).click();
  const why = page.getByRole("region", { name: "Pourquoi ce canal 10" });
  await expect(why).toContainText("U1.10 = 200");
  await expect(why).toContainText("Bar 0 · canal 10");
  await expect(why).toContainText("Forcé à 200");
  await why.getByRole("button", { name: "Fermer" }).click();
  await expect(why).toHaveCount(0);
  await page.getByRole("button", { name: "Tout relâcher" }).click();
  await expect(ch10).not.toHaveClass(/parked/);
  await expect(page.locator("header.top")).not.toContainText("forcé", { timeout: 5000 });
  await page.getByRole("radio", { name: "Les 512 canaux" }).click();
  await expect(page.locator(".ch")).toHaveCount(512);
  await page.getByRole("radio", { name: "Canaux patchés" }).click(); // the choice is remembered: leave the default
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
    await page.locator("nav.pages button", { hasText: name }).first().click();
    await page.waitForTimeout(150);
    await page.screenshot({ path: `test-results/page-${name.replace(/\s/g, "-")}.png`, fullPage: true });
  }
  await page.locator("nav.pages button", { hasText: "Réglages" }).click();
  await expect(page.locator(".users-table strong", { hasText: "Régisseur" })).toBeVisible();
  await page.locator("nav.pages button", { hasText: "Notes" }).click();
  await expect(page.getByText("note de test")).toBeVisible();
  await page.locator("nav.pages button", { hasText: "Import" }).click();
  await expect(page.getByText("Choisir un fichier .qxw")).toBeVisible();
  await page.locator("nav.pages button", { hasText: "OSC" }).click();
  await expect(page.getByText("/light/panic", { exact: true })).toBeVisible();
  await page.locator("header select").selectOption("en");
  await expect(page.locator("nav.pages button", { hasText: "Settings" })).toBeVisible();
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
  await page.locator("nav.pages button", { hasText: "Show" }).click();
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
  const look = (await api(page, "look.list", { brief: false })) as { id: string; technique: { kind: string; steps: string[][] } }[];
  const mine = look.find((l) => l.id === "mon-damier")!;
  expect(mine.technique.kind).toBe("pas");
  expect(mine.technique.steps[0]![0]).toBe("-");
  await expect.poll(async () => (await dmx(page)).slice(3, 9)).toEqual([0, 0, 0, 255, 255, 255]); // head 1 off, head 2 white

  // the damier comes back from the earlier versions
  await page.getByRole("button", { name: "Modifier Mon damier" }).click();
  await editor.locator("summary", { hasText: "Versions précédentes" }).click();
  page.once("dialog", (d) => void d.accept());
  await editor.locator(".versions li").first().getByRole("button", { name: "Restaurer" }).click();
  await expect(editor).toHaveCount(0);
  await expect
    .poll(async () => ((await api(page, "look.list")) as { id: string; technique: { kind: string } }[]).find((l) => l.id === "mon-damier")!.technique.kind)
    .toBe("damier");
  await api(page, "look.stopall");
  expect(errors).toEqual([]);
});

test("machine button: a look with raw channels and no colour", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await api(page, "look.stopall");
  await page.locator("nav.pages button", { hasText: "Show" }).click();
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
  const mine = ((await api(page, "look.list", { brief: false })) as { id: string; channels?: unknown }[]).find((l) => l.id === "machine")!;
  expect(mine.channels).toEqual({ targets: [{ fixture: "bar-0", offset: 2 }], steps: [[200]] });
  await api(page, "look.stopall");
  await expect.poll(async () => (await dmx(page))[2]).toBe(0);
  await api(page, "look.delete", { id: "machine", force: true });
  expect(errors).toEqual([]);
});

test("look editor: random choices, as for the order of the steps", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.locator("nav.pages button", { hasText: "Show" }).click();
  await page.getByRole("button", { name: "+ Nouveau look" }).click();
  const editor = page.locator(".look-editor");
  await editor.getByLabel("Nom", { exact: true }).fill("Hasard");
  await editor.getByLabel("Technique").selectOption("palette");
  await editor.getByLabel("Tirage au hasard").check();
  await expect(editor.getByLabel("Tirage au hasard")).toBeChecked();
  await editor.getByLabel("Mouvement (lyres)").check();
  await editor.getByLabel("Forme").selectOption("aleatoire");
  await editor.getByLabel("Ordre mélangé").check();
  await expect(editor.locator(".preview .cell")).toHaveCount(8);
  await page.screenshot({ path: "test-results/look-random.png", fullPage: true });
  await editor.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(editor).toHaveCount(0);
  const mine = ((await api(page, "look.list", { brief: false })) as { id: string; technique: { kind: string; random?: boolean }; move?: { shape: string; shuffle?: boolean } }[]).find((l) => l.id === "hasard")!;
  expect(mine.technique).toMatchObject({ kind: "palette", random: true });
  expect(mine.move).toMatchObject({ shape: "aleatoire", shuffle: true });
  await api(page, "look.delete", { id: "hasard", force: true });
  expect(errors).toEqual([]);
});

test("settings: route a universe to another Art-Net address and to sACN", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.locator("nav.pages button", { hasText: "Réglages" }).click();
  const artnet = page.getByLabel("Univers 2 · Art-Net");
  await expect(artnet).toHaveValue("1");
  await artnet.fill("5");
  await page.getByLabel("Univers 2 · sACN").fill("2");
  const asked: string[] = [];
  page.once("dialog", (d) => (asked.push(d.message()), void d.accept()));
  await page.locator(".routes .route", { hasText: "Univers 2" }).getByRole("button", { name: "Enregistrer" }).click();
  await expect.poll(async () => ((await api(page, "output.status")) as { config: { routes: unknown[] } }).config.routes[1]).toEqual({ universe: 2, artnet: { portAddress: 5, targets: ["127.0.0.2"] }, sacn: { universe: 2 } });
  expect(asked[0]).toContain("tout de suite");
  await expect(page.locator(".routes .route", { hasText: "Univers 2" }).getByRole("button", { name: "Enregistrer" })).toHaveCount(0);
  await page.screenshot({ path: "test-results/settings-routes.png", fullPage: true });
  // back as it was, by the command
  await api(page, "output.route", { universe: 2, artnet: { portAddress: 1 }, sacn: null });
  await expect(artnet).toHaveValue("1");
  expect(errors).toEqual([]);
});

test("automatic presets light a venue in one click", async ({ page }) => {
  const errors = watchErrors(page);
  page.on("dialog", (d) => void d.accept());
  await login(page);
  await page.locator("nav.pages button", { hasText: "Show" }).click();
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
  await page.locator("nav.pages button", { hasText: "Chants" }).click();
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

test("song editor: the tempo heard in a recording fills the BPM", async ({ page }) => {
  const errors = watchErrors(page);
  // a 20 s recording at 124 BPM: clicks on a soft noise, 16-bit WAV
  const rate = 22050;
  const samples = new Int16Array(20 * rate);
  let seed = 7;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < samples.length; i++) samples[i] = Math.round(300 * noise());
  for (let k = 0; (k * 60 * rate) / 124 < samples.length; k++) {
    const start = Math.round((k * 60 * rate) / 124);
    for (let i = 0; i < 600 && start + i < samples.length; i++) samples[start + i] = Math.max(-32767, Math.min(32767, samples[start + i]! + Math.round(20000 * noise() * Math.exp(-i / 130))));
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + samples.byteLength, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(samples.byteLength, 40);
  await login(page);
  await page.locator("nav.pages button", { hasText: "Chants" }).click();
  await page.getByRole("button", { name: "+ Nouveau chant" }).click();
  const editor = page.locator(".song-editor");
  await editor.getByLabel("Tempo depuis un fichier audio").setInputFiles({ name: "chant.wav", mimeType: "audio/wav", buffer: Buffer.concat([header, Buffer.from(samples.buffer)]) });
  const found = editor.locator(".tempo-audio strong");
  await expect(found).toContainText("BPM", { timeout: 10_000 });
  const bpm = Number(((await found.textContent()) ?? "").replace(/[^\d.]/g, ""));
  expect(bpm).toBeGreaterThan(123.7);
  expect(bpm).toBeLessThan(124.3);
  await editor.getByRole("button", { name: "Utiliser" }).click();
  expect(Number(await editor.getByLabel("BPM").inputValue())).toBe(bpm);
  expect(errors).toEqual([]);
});

test("song editor: the sections heard in a recording become the song's sections", async ({ page }) => {
  const errors = watchErrors(page);
  // 8 soft bars, 16 loud and bright, 8 soft, at 100 BPM, as a 16-bit WAV
  const rate = 22050;
  const bar = (60 / 100) * 4;
  let seed = 3;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const samples = new Float32Array(Math.round((0.37 + 32 * bar + 0.5) * rate));
  let low = 0;
  for (let i = 0; i < samples.length; i++) {
    const b = Math.floor((i / rate - 0.37) / bar);
    low = 0.97 * low + 0.03 * noise();
    samples[i] = b >= 8 && b < 24 ? 0.25 * noise() : 0.6 * low;
  }
  for (let k = 0; (k * 60) / 100 < 32 * bar; k++) {
    const start = Math.round((0.37 + (k * 60) / 100) * rate);
    for (let i = 0; i < 0.03 * rate && start + i < samples.length; i++) samples[start + i]! += 0.8 * noise() * Math.exp(-i / (0.006 * rate));
  }
  const pcm = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => pcm.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 32767))), i * 2));
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  await login(page);
  await page.locator("nav.pages button", { hasText: "Chants" }).click();
  await page.getByRole("button", { name: "+ Nouveau chant" }).click();
  const editor = page.locator(".song-editor");
  await editor.getByLabel("Tempo depuis un fichier audio").setInputFiles({ name: "chant.wav", mimeType: "audio/wav", buffer: Buffer.concat([header, pcm]) });
  await expect(editor.locator(".tempo-audio")).toContainText("Sections entendues : 8 + 16 + 8 mesures", { timeout: 10_000 });
  await editor.getByRole("button", { name: "Utiliser ces sections" }).click();
  await expect(editor.getByLabel("Section 2", { exact: true })).toHaveValue("Partie 2");
  await expect(editor.locator("table.sections tbody tr")).toHaveCount(3);
  expect(errors).toEqual([]);
});

test("timeline action: placed in the song editor, fired by ▶ playback", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.locator("nav.pages button", { hasText: "Chants" }).click();
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
  await page.locator("nav.pages button", { hasText: "Chants" }).click();
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
  await page.locator("nav.pages button", { hasText: "Lieu" }).click();
  const plan = page.locator(".stage-plan svg");
  await expect(plan).toBeVisible();
  await expect(plan.locator("g.fixture")).toHaveCount(3);
  await expect(page.locator(".stage-plan .hint")).toContainText("3 projecteur(s) sans position");
  const bar = plan.locator('g.fixture[data-fixture="bar-0"] rect');
  await expect(bar.first()).toHaveAttribute("fill", "#000000");
  await api(page, "look.go", { id: "masks" });
  await expect.poll(async () => (await bar.evaluateAll((rs) => rs.map((r) => r.getAttribute("fill")))).some((f) => f !== "#000000")).toBe(true); // lit, live
  await page.screenshot({ path: "test-results/stage-preview.png", fullPage: true });
  // zoom: the plan grows inside its frame, which scrolls; back to the whole room
  const frame = page.locator(".stage-plan .plan-scroll");
  const width = (await plan.boundingBox())!.width;
  await page.getByRole("button", { name: "Zoomer sur le plan" }).click();
  await page.getByRole("button", { name: "Zoomer sur le plan" }).click();
  await expect(page.locator(".stage-plan .zoom")).toContainText("×2");
  expect((await plan.boundingBox())!.width).toBeGreaterThan(width * 1.9);
  expect(await frame.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await page.getByRole("button", { name: "Dézoomer le plan" }).click();
  await page.getByRole("button", { name: "Dézoomer le plan" }).click();
  await expect(page.getByRole("button", { name: "Dézoomer le plan" })).toBeDisabled();
  expect(Math.round((await plan.boundingBox())!.width)).toBe(Math.round(width));
  // a strobing fixture: a still marker, never a flashing screen
  const patch = ((await api(page, "venue.fixture.list")) as { id: string; universe: number; address: number }[]).find((f) => f.id === "bar-0")!;
  const strobeOffset = ((await api(page, "venue.fixture.channels")) as { id: string; channels: { offset: number; attribute: string }[] }[]).find((f) => f.id === "bar-0")!.channels.find((c) => c.attribute === "strobe")!.offset;
  const strobeChannel = patch.address + strobeOffset;
  await expect(plan.locator(".strobe-mark")).toHaveCount(0);
  await api(page, "dmx.set", { universe: patch.universe, channel: strobeChannel, value: 200 });
  await expect(plan.locator('g.fixture[data-fixture="bar-0"] .strobe-mark')).toBeVisible();
  await page.screenshot({ path: "test-results/stage-preview-strobe.png", fullPage: true });
  await api(page, "dmx.release", { universe: patch.universe, channels: [strobeChannel] });
  await expect(plan.locator(".strobe-mark")).toHaveCount(0);
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
  await page.locator("nav.pages button", { hasText: "Fichiers" }).click();
  const input = page.locator('input[type=file][accept*="lightshow"]');
  // identical backup: nothing to restore
  await input.setInputFiles(file);
  await expect(page.locator(".files .error")).toContainText("identique");
  // a look renamed since the backup: the dialog lists it, accepting restores it
  const look = (await api(page, "look.get", { id: "hole" })) as { id: string; name: string };
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
  await page.locator("nav.pages button", { hasText: "Lieu" }).click();
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
  await page.locator("nav.pages button", { hasText: "Show" }).click();
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
  // a sub-group still in use: the question says where, and « no » keeps it
  await page.getByRole("button", { name: "Modifier LED bar public" }).click();
  let question = "";
  page.once("dialog", (d) => {
    question = d.message();
    void d.dismiss();
  });
  await page.locator(".group-editor").getByRole("button", { name: "Supprimer" }).click();
  await expect.poll(() => question).toContain("groupe « Ambiance » (sous-groupe)");
  expect(((await api(page, "group.list")) as { id: string }[]).some((g) => g.id === "led-bar-public")).toBe(true);
  await page.locator(".group-editor").getByRole("button", { name: "Fermer", exact: true }).click();
  // edit then delete
  await page.getByRole("button", { name: "Modifier Ambiance" }).click();
  page.once("dialog", (d) => void d.accept());
  await page.locator(".group-editor").getByRole("button", { name: "Supprimer" }).click();
  await expect.poll(async () => ((await api(page, "group.list")) as { id: string }[]).some((g) => g.id === "ambiance")).toBe(false);
  await api(page, "group.delete", { id: "led-bar-public", force: true });
  expect(errors).toEqual([]);
});

test("rules: a type limit, relaxed by the show, seen on the output and explained", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await api(page, "look.stopall");
  await api(page, "look.go", { id: "masks" });
  await page.locator("nav.pages button", { hasText: "Lieu" }).click();
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
  // a bounded duration: at full for a second at most, then held just under 90 %
  await form.getByLabel("au-dessus de (%)").fill("90");
  await form.getByLabel("pendant (s) au plus").fill("1");
  await form.getByRole("button", { name: "+ Ajouter la règle" }).click();
  await expect(panel.locator("table.rules tr", { hasText: "Gradateur ≥ 90 % 1 s max" })).toBeVisible();
  await expect.poll(async () => (await dmx(page))[0], { timeout: 5000 }).toBe(229);
  await panel.getByRole("button", { name: "Supprimer Gradateur ≥ 90 % 1 s max" }).click();
  await expect.poll(async () => (await dmx(page))[0]).toBe(255);
  // for some callers only: it checks their launches and leaves the output alone
  await form.getByLabel("max %").fill("50");
  await form.locator("fieldset", { hasText: "seulement pour" }).getByLabel("IA (MCP)").check();
  await form.locator("fieldset", { hasText: "seulement pour" }).getByLabel("Bénévole").check();
  await form.getByRole("button", { name: "+ Ajouter la règle" }).click();
  const scoped = panel.locator("table.rules tr", { hasText: "Gradateur max 50 % (IA (MCP), Bénévole)" });
  await expect(scoped).toContainText("seulement pour : IA (MCP), Bénévole");
  await expect.poll(async () => (await dmx(page))[0]).toBe(255); // the output is not bounded by it
  const saved = ((await api(page, "rule.list")) as { show: { id: string; appliesTo?: { origins?: string[]; roles?: string[] } }[] }).show.find((r) => r.appliesTo);
  expect(saved!.appliesTo).toEqual({ origins: ["mcp"], roles: ["benevole"] });
  await panel.getByRole("button", { name: "Supprimer Gradateur max 50 % (IA (MCP), Bénévole)" }).click();
  await api(page, "look.stopall");
  expect(errors).toEqual([]);
});

test("MIDI mapping: learn a note, assign a look, the note starts it", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await api(page, "look.stopall");
  await page.locator("nav.pages button", { hasText: "MIDI" }).click();
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
  await page.locator(".palette").getByRole("button", { name: "Fader de canaux", exact: true }).click();
  await page.locator(".dashboards .editor select").first().selectOption("blanc");
  await page.getByRole("button", { name: "✔" }).click();
  const fader = page.getByLabel("Fader de canaux Blanc");
  await expect(fader).toBeVisible();
  await fader.fill("1000");
  await expect.poll(async () => (await dmx(page))[2]).toBe(255);
  await page.locator("nav.pages button", { hasText: "Show" }).click();
  await expect(page.locator("section", { hasText: "Faders de canaux" }).locator("tr", { hasText: "Blanc" })).toContainText("100 %");
  await api(page, "fader.delete", { id: "blanc", force: true }); // still on the dashboard
  await expect.poll(async () => (await dmx(page))[2]).toBe(0);
  expect(errors).toEqual([]);
});

test("channel fader editor: one fader on the same channel of several fixtures", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.locator("nav.pages button", { hasText: "Show" }).click();
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
  await page.locator("nav.pages button", { hasText: "Lieu" }).click();
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
  await page.locator("nav.pages button", { hasText: "MIDI" }).click();
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
  await page.locator("nav.pages button", { hasText: "Chants" }).click();
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
  const masksCell = page.locator(".dgrid .cell", { has: page.locator("button.look", { hasText: "masks" }) });
  await masksCell.click(); // selects the widget in edit mode (its button does not take clicks there)
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
  await masksCell.click();
  await page.getByLabel("Mode").selectOption("latch");
  await page.getByRole("button", { name: "✔" }).click();
  expect(errors).toEqual([]);
});

test("dashboard editor: add a label widget and save", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.getByRole("button", { name: "✎" }).click();
  await page.locator(".palette").getByRole("button", { name: "Titre", exact: true }).click();
  await page.locator(".editor").getByLabel("Libellé", { exact: true }).fill("Mon repère");
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
  await page.locator("nav.pages button", { hasText: "Réglages" }).click();
  await page.getByRole("button", { name: "⏸ Mettre en veille" }).click();
  await expect(page.locator("header .badge.standby")).toContainText("Veille");
  await page.locator("nav.pages button", { hasText: "Live" }).click();
  await expect(page.locator("header .badge.standby")).toBeVisible(); // on every page
  await page.screenshot({ path: "test-results/standby.png" });
  await page.locator("nav.pages button", { hasText: "Réglages" }).click();
  await page.getByRole("button", { name: "▶ Reprendre la main" }).click();
  await expect(page.locator("header .badge.standby")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("self-test with the real-time cadence of every look", async ({ page }) => {
  test.setTimeout(60_000);
  const errors = watchErrors(page);
  await login(page);
  await page.locator("nav.pages button", { hasText: "Import" }).click();
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

test("orient a fixture on the live stage: towards a wall, the ceiling, turned by 15° or by dragging", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.locator("nav.pages button", { hasText: "Lieu" }).click();
  const facing = async () => ((await api(page, "venue.fixture.list")) as { id: string; facing?: string; orientation?: { yaw: number; pitch?: number } }[]).find((f) => f.id === "bar-0")!;
  const placed = await facing();
  if (!("position" in placed)) await api(page, "venue.fixture.put", { fixture: { ...placed, position: { x: -2, y: 4.5, z: 0.2 } } }); // a beam needs a place
  await page.reload();
  await page.getByLabel("Orienter").check();
  await expect(page.locator(".orient-panel")).toContainText("Cliquer un projecteur");
  const bar = page.locator('.stage-plan g.fixture[data-fixture="bar-0"]');
  await bar.locator("rect").first().click();
  const panel = page.locator(".orient-panel");
  await panel.getByRole("button", { name: "Mur jardin (gauche)" }).click();
  await expect.poll(async () => (await facing()).facing).toBe("houseLeft");
  await expect(panel.getByRole("button", { name: "Mur jardin (gauche)" })).toHaveAttribute("aria-pressed", "true");
  await expect(bar.locator(".beam line")).toHaveCount(1); // the beam, towards jardin: to the left of the plan
  const line = bar.locator(".beam line");
  expect(Number(await line.getAttribute("x2"))).toBeLessThan(Number(await line.getAttribute("x1")));
  await expect(bar.locator("g[transform^='rotate(90']")).toHaveCount(1); // the body turns with it
  // lit, it casts its light that way: a cone of its colour, towards jardin
  await api(page, "look.go", { id: "masks" });
  const cone = page.locator('.stage-plan .light-cone[data-beam="bar-0"] polygon');
  await expect(cone).toHaveCount(1);
  const xs = ((await cone.getAttribute("points")) ?? "").split(" ").map((pt) => Number(pt.split(",")[0]));
  expect(Math.min(...xs.slice(1))).toBeLessThan(xs[0]!);
  await page.screenshot({ path: "test-results/orient-jardin.png", fullPage: true });
  await panel.getByRole("button", { name: "Plafond" }).click();
  await expect.poll(async () => (await facing()).orientation).toEqual(expect.objectContaining({ yaw: -90, pitch: 90 }));
  await expect(bar.locator(".beam .dot")).toHaveCount(1); // ⊙: towards whoever looks from above
  await panel.getByRole("button", { name: "Public" }).click();
  await panel.getByRole("button", { name: /15° \(sens des aiguilles/ }).click();
  await expect.poll(async () => (await facing()).orientation?.yaw).toBe(-15);
  await page.keyboard.press("ArrowLeft"); // the keyboard turns it back
  await expect.poll(async () => (await facing()).facing).toBe("audience");
  // drag around it: pointing at the right of the plan is cour
  await bar.locator("g").first().scrollIntoViewIfNeeded();
  const box = (await bar.locator("g").first().boundingBox())!; // the body: its centre is the fixture's
  const [cx, cy] = [box.x + box.width / 2, box.y + box.height / 2];
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 150, cy, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await facing()).facing).toBe("houseRight");
  await panel.getByRole("button", { name: "Public" }).click();
  await expect.poll(async () => (await facing()).facing).toBe("audience");
  await page.getByLabel("Orienter").uncheck();
  await api(page, "look.stopall");
  expect(errors).toEqual([]);
});

test("place the checked fixtures along the front of a zone, turned towards the audience", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const zones = (await api(page, "stage.zone.list")) as { id: string }[];
  if (!zones.some((z) => z.id === "scene")) await api(page, "stage.zone.put", { zone: { id: "scene", name: "Scène", type: "stage", polygon: [[-4, 0], [4, 0], [4, 5], [-4, 5]] } });
  await page.locator("nav.pages button", { hasText: "Lieu" }).click();
  const row = (name: string) => page.locator("#venue-patch tr", { hasText: name }).getByRole("checkbox");
  await row("Bar 1").check(); // checked first: placed first, on the jardin side
  await row("Bar 0").check();
  const form = page.locator(".editor.arrange");
  await form.getByLabel("Zones").selectOption({ label: "Scène" });
  await form.getByLabel("Bord de la zone").selectOption("front");
  await form.getByLabel("Vers").selectOption("audience");
  await form.getByRole("button", { name: "Placer (2)" }).click();
  const at = async (id: string) => ((await api(page, "venue.fixture.list")) as { id: string; position?: { x: number; y: number }; facing?: string }[]).find((f) => f.id === id)!;
  await expect.poll(async () => (await at("bar-1")).position).toEqual(expect.objectContaining({ x: -2, y: 0.3 }));
  expect((await at("bar-0")).position).toEqual(expect.objectContaining({ x: 2, y: 0.3 }));
  expect((await at("bar-0")).facing).toBe("audience");
  await page.screenshot({ path: "test-results/arrange.png" });
  await row("Bar 1").uncheck();
  await row("Bar 0").uncheck();
  expect(errors).toEqual([]);
});

test("live stage in 3D: zones, fixtures and beams drawn, loaded on demand", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await api(page, "look.go", { id: "masks" });
  await page.locator("nav.pages button", { hasText: "Lieu" }).click();
  await page.locator(".stage-plan").getByRole("button", { name: "3D", exact: true }).click();
  const view = page.getByRole("img", { name: "Scène en 3D" });
  await expect(view).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".stage-plan svg[aria-label='Scène en direct']")).toBeHidden(); // the plan steps aside
  // something drawn: the canvas is not one flat colour
  await expect
    .poll(async () => (await page.evaluate(`(() => {
      const c = document.querySelector(".stage-3d canvas");
      const g = document.createElement("canvas");
      g.width = 64; g.height = 64;
      const ctx = g.getContext("2d");
      ctx.drawImage(c, 0, 0, 64, 64);
      const d = ctx.getImageData(0, 0, 64, 64).data;
      const seen = new Set();
      for (let i = 0; i < d.length; i += 4) seen.add(d[i] + "," + d[i + 1] + "," + d[i + 2]);
      return seen.size;
    })()`)) as number)
    .toBeGreaterThan(10);
  await view.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/stage-3d.png" });
  await page.locator(".stage-plan").getByRole("button", { name: "Dessus" }).click();
  await expect(page.locator(".stage-plan svg[aria-label='Scène en direct']")).toBeVisible();
  await api(page, "look.stopall");
  expect(errors).toEqual([]);
});

test("venue: a rectangular zone made from its size, shown on the plan, then deleted", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.locator("nav.pages button", { hasText: "Lieu" }).click();
  const form = page.locator(".zone-editor");
  await form.getByLabel("Nom de la zone").fill("Parvis");
  await form.getByLabel("Type de zone").selectOption("floor");
  await form.getByLabel("largeur (m)").fill("6");
  await form.getByLabel("profondeur (m)").fill("3");
  await form.getByLabel("bord avant Y (m)").fill("-4");
  await form.getByRole("button", { name: "+ Zone" }).click();
  await expect(page.locator("#venue-patch li", { hasText: "Parvis" })).toContainText("6 × 3 m");
  const zone = ((await api(page, "stage.zone.list")) as { id: string; polygon: number[][] }[]).find((z) => z.id === "parvis")!;
  expect(zone.polygon).toEqual([[-3, -4], [3, -4], [3, -1], [-3, -1]]);
  await expect(page.locator(".stage-plan g.zone", { hasText: "Parvis" })).toHaveCount(1);
  // no moving head may point into it: ticked on its line, hatched on the plan
  const line = page.locator("#venue-patch li", { hasText: "Parvis" });
  await line.getByLabel("interdite aux lyres").click(); // saved, then shown ticked
  await expect(line.getByLabel("interdite aux lyres")).toBeChecked();
  await expect(page.locator(".stage-plan g.zone", { hasText: "Parvis" }).locator("polygon.no-aim")).toHaveCount(1);
  expect(((await api(page, "stage.zone.list")) as { id: string; noAim?: boolean }[]).find((z) => z.id === "parvis")!.noAim).toBe(true);
  // except a look allowed into it
  await line.getByLabel("sauf : Parvis").selectOption({ label: "masks" });
  await expect(line.getByRole("button", { name: "Supprimer masks" })).toBeVisible();
  expect(((await api(page, "stage.zone.list")) as { id: string; allowLooks?: string[] }[]).find((z) => z.id === "parvis")!.allowLooks).toEqual(["masks"]);
  await form.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/zone-editor.png" });
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Supprimer Parvis" }).click();
  await expect(page.locator("#venue-patch li", { hasText: "Parvis" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("live stage widget on a dashboard", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.getByRole("button", { name: "✎" }).click();
  await page.locator(".palette").getByRole("button", { name: "Scène en direct", exact: true }).click();
  await page.getByRole("button", { name: "✔" }).click();
  const widget = page.locator(".preview-widget svg");
  await expect(widget).toBeVisible();
  await expect(widget.locator("g.fixture")).toHaveCount(3);
  await page.screenshot({ path: "test-results/preview-widget.png", fullPage: true });
  expect(errors).toEqual([]);
});

test("a volunteer cannot write the show: no DMX console offered, and the server refuses it anyway", async ({ page }) => {
  await login(page, "5678");
  await expect(page.locator("nav.pages button", { hasText: "Console DMX" })).toHaveCount(0);
  const status = await page.evaluate(async () => {
    const res = await fetch("/api/plugins/light/commands/dmx.set", { method: "POST", headers: { authorization: `Bearer ${sessionStorage.getItem("token")}`, "content-type": "application/json" }, body: JSON.stringify({ universe: 1, channel: 4, value: 90 }) });
    return res.status;
  });
  expect(status).toBe(403);
  const parked = await page.evaluate(async () => {
    const res = await fetch("/api/plugins/light/commands/dmx.get", { method: "POST", headers: { authorization: `Bearer ${sessionStorage.getItem("token")}`, "content-type": "application/json" }, body: JSON.stringify({ universe: 1 }) });
    return ((await res.json()) as { result: { parked: Record<string, number> } }).result.parked;
  });
  expect(parked["4"]).toBeUndefined();
});
