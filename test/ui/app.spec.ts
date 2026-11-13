import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page, type Route, type WebSocketRoute } from "@playwright/test";

/** The UI test server's port, as playwright.config.ts starts it (UI_PORT, 8799 by default). */
const PORT = Number(process.env.UI_PORT ?? 8799);

/** Collects page errors and console errors; every test asserts there are none. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    // a refused request is logged without saying which: its address is added, to tell an expected refusal from another
    if (m.type() === "error") errors.push(`console: ${m.text()}${/Failed to load resource/.test(m.text()) ? ` (${m.location().url})` : ""}`);
  });
  return errors;
}

/** PINs set by test/ui/server.ts, and the user each one belongs to. */
const PIN_USERS: Record<string, string> = { "1234": "regisseur", "9999": "admin", "5678": "benevole", "1357": "lecture" };

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
/** A dashboard as dashboard.list returns it, with the widget fields the tests read or patch. */
type TestDashboard = { id: string; widgets: { id: string; kind: string; x: number; y: number; w: number; h: number; target?: string; label?: string; mode?: string; color?: string }[] };

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

/** Waits out the launch guard, then launches from the preview sheet and waits for it to close. */
async function launchFromSheet(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(450);
  const dialog = page.getByRole("dialog", { name: `Aperçu avant lancement : ${name}` });
  await dialog.getByRole("button", { name: "Lancer" }).click();
  await expect(dialog).toHaveCount(0);
}

/** A bare look for the folder tests, seeded over the five looks of the imported show. */
function folderLook(id: string, name: string, tags: string[], canvas: string) {
  return { id, name, canvas, technique: { kind: "plat", color: "#ff0000" }, timing: { every: { beats: 1 }, attack: 0, order: "loop", entryFade: 0 }, tags };
}

/** The `dossier:` tags of a look; every other tag is left alone by the folder commands. */
const folderTags = (tags: string[]) => tags.filter((t) => t.startsWith("dossier:"));

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
  expect(errors.filter((e) => !e.includes("status of 401"))).toEqual([]);
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
  expect(errors.filter((e) => !e.includes("status of 401"))).toEqual([]);
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
  expect(errors.filter((e) => !e.includes("status of 401"))).toEqual([]);
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
  const origin = `http://localhost:${PORT}`;
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
  expect(errors.filter((e) => !e.includes("status of 401"))).toEqual([]);
});

test("guided import: a .qxf added from the browser, then a QLC+ workspace into a new show of its own", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page, "9999");
  await page.locator("nav.pages button", { hasText: "Import" }).click();
  const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url));
  await page.locator('input[type=file][accept=".qxf"]').setInputFiles({ name: "test-spot.qxf", mimeType: "text/xml", buffer: fixture("spot.qxf") });
  await expect(page.locator(".added-definitions")).toContainText("✔ test-spot.qxf");
  // the same file name with another content is refused, and « Remplacer » overwrites it after a confirmation
  const changed = Buffer.from(fixture("spot.qxf").toString().replace("</FixtureDefinition>", "<!-- v2 --></FixtureDefinition>"));
  await page.locator('input[type=file][accept=".qxf"]').setInputFiles({ name: "test-spot.qxf", mimeType: "text/xml", buffer: changed });
  await expect(page.locator(".added-definitions")).toContainText("✖ test-spot.qxf");
  page.once("dialog", (d) => void d.accept());
  await page.locator(".added-definitions").getByRole("button", { name: "Remplacer" }).click();
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
  // opening a show reloads every page: a command sent while this one reloads is replayed by `api`, and a
  // delete replayed is refused. The reload is waited for before the delete.
  const reloaded = page.waitForEvent("load");
  await api(page, "show.open", { id: "default" });
  await reloaded;
  await expect(page.locator("header .show-name")).toHaveText("Show");
  await api(page, "show.delete", { id: "autre-salle" });
  const refused = errors.findIndex((e) => e.includes("status of 422")); // the refused duplicate is one 422 on purpose
  expect(errors.filter((_, i) => i !== refused)).toEqual([]);
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

test("tempo source: chosen in the MIDI page, and « ↺ MIDI » gives Ableton the lead back when it plays", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const tempo = async () => (await api(page, "tempo.get")) as { bpm: number; source: string };
  const before = await tempo();
  await page.locator("nav.pages button", { hasText: "MIDI" }).click();
  await page.getByLabel("Le tempo suit").selectOption("manual");
  await expect.poll(async () => (await tempo()).source).toBe("manual");
  // Ableton plays: its clock arrives, not followed
  await page.evaluate(`window.__clock = setInterval(() => fetch("/api/plugins/light/commands/midi.in", { method: "POST", headers: { authorization: "Bearer " + sessionStorage.getItem("token"), "content-type": "application/json" }, body: JSON.stringify({ port: "Web MIDI · test", bytes: [248] }) }), 20)`);
  try {
    await expect(page.locator("small.hint", { hasText: "horloge reçue" })).toBeVisible();
    await page.locator("nav.pages button", { hasText: "Live" }).click();
    const back = page.getByRole("button", { name: "Ableton joue : suivre à nouveau son horloge MIDI" }); // « ↺ MIDI », or « ↺ » in a narrow Tap
    await expect(back).toBeVisible();
    await back.click();
    await expect.poll(async () => (await tempo()).source).toBe("midi");
    await expect(back).toHaveCount(0);
  } finally {
    await page.evaluate("clearInterval(window.__clock)");
    await api(page, "tempo.set", { bpm: before.bpm, source: before.source });
  }
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

test("Live: the show on the stage plan, top, face or 3D, to rehearse without the kit", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const toggle = page.getByRole("button", { name: "Scène", exact: true });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  const panel = page.locator(".live-stage-panel");
  await expect(panel.locator(".stage-plan svg")).toBeVisible();
  await api(page, "look.go", { id: "masks" }); // as it goes out: the plan lights up with it
  await expect.poll(() => panel.locator(".stage-plan g.fixture rect").evaluateAll((rs) => rs.some((r) => !["#000000", "rgb(0, 0, 0)"].includes(r.getAttribute("fill") ?? "")))).toBe(true);
  await panel.getByRole("button", { name: "Face" }).click();
  await expect(panel.getByRole("button", { name: "Face" })).toHaveAttribute("aria-pressed", "true");
  await panel.getByRole("button", { name: "3D" }).click();
  await expect(panel.locator(".plan-scroll")).toBeHidden(); // the 3D view in its place
  await page.reload(); // remembered by this browser
  await expect(page.locator(".live-stage-panel")).toBeVisible();
  await page.getByRole("button", { name: "Scène", exact: true }).click();
  await expect(page.locator(".live-stage-panel")).toHaveCount(0);
  await api(page, "look.stopall");
  expect(errors).toEqual([]);
});

test("Live: the bar stays in view while the buttons scroll; pinned, the stage or the edit tools with it", async ({ page }) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 1280, height: 600 });
  await login(page);
  // a dashboard taller than the window: a label far down
  await api(page, "dashboard.put", { dashboard: { id: "tall", name: "Défilement", columns: 12, widgets: [{ id: "far", kind: "label", label: "Tout en bas", x: 0, y: 40, w: 3, h: 1 }] } });
  await page.reload();
  await page.locator(".dash-top .bar .tab", { hasText: "Défilement" }).click();
  const far = page.locator(".dgrid .cell", { hasText: "Tout en bas" });
  /** Where a part of the Live's top sits, from the header's bottom edge (0: just under it). */
  const below = (selector: string) =>
    page.evaluate<{ top: number; bottom: number; height: number }>(
      `(() => {
        const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        return { top: Math.round(r.top - document.querySelector("header.top").getBoundingClientRect().bottom), bottom: r.bottom, height: r.height };
      })()`,
    );
  await far.scrollIntoViewIfNeeded();
  expect(await page.evaluate<number>("window.scrollY")).toBeGreaterThan(0);
  expect((await below(".dash-top .bar")).top).toBe(0); // the bar, with the dashboard's name, stays under the header

  // the stage, pinned under the bar: kept by this browser, and never the whole window
  await page.getByRole("button", { name: "Scène", exact: true }).click();
  const pinStage = page.getByRole("button", { name: "Épingler la scène" });
  await expect(pinStage).toHaveAttribute("aria-pressed", "false");
  await far.scrollIntoViewIfNeeded();
  await expect(page.locator(".live-stage-panel")).not.toBeInViewport(); // not pinned: scrolled away with the page
  await pinStage.click();
  await expect(pinStage).toHaveAttribute("aria-pressed", "true");
  await expect(pinStage).toHaveText(/Épinglée/); // said in words, not only by a colour
  await far.scrollIntoViewIfNeeded();
  const stage = await below(".live-stage-panel");
  expect(stage.top).toBeGreaterThan(0); // under the bar, in view
  expect((await below(".live-stage-panel .stage-plan svg")).height).toBeLessThanOrEqual(600 * 0.42 + 1);
  // its bottom edge sets its height (dragged, or the arrows), kept by this browser; a double click gives it back its own
  const drawing = page.locator(".live-stage-panel .stage-plan svg");
  const tall = async () => Math.round((await drawing.boundingBox())!.height);
  const h0 = await tall();
  const grip = page.getByRole("separator", { name: "Hauteur de la scène" });
  const g = (await grip.boundingBox())!;
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2 - 100, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => Math.abs((await tall()) - (h0 - 100))).toBeLessThanOrEqual(2);
  await grip.focus();
  await page.keyboard.press("ArrowDown");
  await expect.poll(async () => Math.abs((await tall()) - (h0 - 80))).toBeLessThanOrEqual(2);
  await page.reload();
  await expect(page.getByRole("button", { name: "Épingler la scène" })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => Math.abs((await tall()) - (h0 - 80))).toBeLessThanOrEqual(2);
  await grip.dblclick();
  await expect.poll(tall).toBe(h0);
  // folded in place: its row stays, to open it again where it was
  await page.locator(".live-stage-panel").getByRole("button", { name: /Masquer/ }).click();
  await expect(page.locator(".live-stage-panel .plan-scroll")).toBeHidden();
  await expect(grip).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Faisceaux" })).toBeVisible();
  await page.reload();
  await page.locator(".live-stage-panel").getByRole("button", { name: /Afficher/ }).click();
  await expect(drawing).toBeVisible();
  await page.getByRole("button", { name: "Scène", exact: true }).click(); // the stage hidden: nothing pinned
  await expect(page.getByRole("button", { name: "Épingler la scène" })).toHaveCount(0);
  await expect(page.locator(".dash-top")).not.toHaveClass(/pinned/);

  // editing: the tools stay in view (by default), or only the bar once unpinned
  await page.locator(".dash-top .bar .tab", { hasText: "Défilement" }).click();
  await page.getByRole("button", { name: "✎" }).click();
  const pinTools = page.getByRole("button", { name: "Épingler les outils" });
  await expect(pinTools).toHaveAttribute("aria-pressed", "true");
  await far.scrollIntoViewIfNeeded();
  expect((await below(".palette")).top).toBeGreaterThan(0);
  await expect(page.locator(".palette")).toBeInViewport();
  await pinTools.click();
  await expect(pinTools).toHaveAttribute("aria-pressed", "false");
  await far.scrollIntoViewIfNeeded();
  await expect(page.locator(".palette")).not.toBeInViewport();
  expect((await below(".dash-top .bar")).top).toBe(0);
  await page.getByRole("button", { name: "✕", exact: true }).first().click();
  await api(page, "dashboard.delete", { id: "tall" });
  expect(errors).toEqual([]);
});

test("Live: the beams on the stage and a look's preview on hover can both be left out", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  // a bar placed and turned towards jardin, lit: its cone and its arrow on the plan
  const before = ((await api(page, "venue.fixture.list")) as { id: string }[]).find((f) => f.id === "bar-0")!;
  await api(page, "venue.fixture.put", { fixture: { ...before, position: { x: -2, y: 4.5, z: 0.2 } } });
  await api(page, "venue.fixture.orient", { id: "bar-0", facing: "houseLeft" });
  await page.reload();
  await api(page, "look.go", { id: "masks" });
  await page.getByRole("button", { name: "Scène", exact: true }).click();
  const panel = page.locator(".live-stage-panel");
  const beams = page.getByRole("button", { name: "Faisceaux" });
  await expect(beams).toHaveAttribute("aria-pressed", "true");
  await expect(panel.locator('.light-cone[data-beam="bar-0"]')).toHaveCount(1);
  await expect(panel.locator('g.fixture[data-fixture="bar-0"] .beam')).toHaveCount(1);
  await beams.click();
  await expect(beams).toHaveAttribute("aria-pressed", "false");
  await expect(panel.locator(".light-cone")).toHaveCount(0);
  await expect(panel.locator("g.beam")).toHaveCount(0);
  await expect(panel.locator("ellipse").first()).toBeVisible(); // lit, it still glows
  await page.reload(); // remembered by this browser
  await expect(page.getByRole("button", { name: "Faisceaux" })).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".live-stage-panel .light-cone")).toHaveCount(0);
  await page.screenshot({ path: "test-results/live-stage-no-beams.png" });

  // the hover preview, switched off: a look button keeps its plain title
  const peek = page.locator(".dash-top .bar").getByRole("button", { name: "Aperçu", exact: true });
  await expect(peek).toHaveAttribute("aria-pressed", "true");
  await peek.click();
  await expect(peek).toHaveAttribute("aria-pressed", "false");
  const button = page.locator(".dgrid .cell button", { hasText: "checker" }).first();
  await button.hover();
  await page.waitForTimeout(700); // longer than the hover delay
  await expect(page.locator(".hover-peek")).toHaveCount(0);
  await expect(button).toHaveAttribute("title", /checker/);
  await page.mouse.move(0, 0);
  await api(page, "look.stopall");
  await api(page, "venue.fixture.put", { fixture: before });
  expect(errors).toEqual([]);
});

test("an LED bar is one rectangle: glued heads on the plan and in a look's strip, a gap only between two bars", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.getByRole("button", { name: "Scène", exact: true }).click();
  const panel = page.locator(".live-stage-panel");
  await api(page, "look.go", { id: "masks" });
  // the plan: heads side by side without a border of their own, and one outline around the bar
  const body = panel.locator('g.fixture[data-fixture="bar-0"] > g > rect:not(.selection):not(.strobe-outline):not(.bar-outline)');
  await expect.poll(() => body.count()).toBeGreaterThan(2);
  const heads = await body.evaluateAll((rs) => rs.map((r) => ({ x: Number(r.getAttribute("x")), w: Number(r.getAttribute("width")), stroke: r.getAttribute("stroke") })));
  await expect(panel.locator('g.fixture[data-fixture="bar-0"] .bar-outline')).toHaveCount(1); // one outline around the whole bar
  expect(heads.every((r) => r.stroke === null)).toBe(true);
  for (let i = 0; i + 1 < heads.length; i++) expect(heads[i]!.x + heads[i]!.w).toBeGreaterThanOrEqual(heads[i + 1]!.x - 0.001);
  await api(page, "look.stopall");
  // a look's strip: cells of one bar touch, two bars stay apart
  await page.locator(".dgrid .cell button", { hasText: "checker" }).first().click({ button: "right" });
  const menu = page.getByRole("dialog", { name: "Réglages du widget" });
  const cells = menu.locator(".preview.plain .cell");
  await expect(cells).toHaveCount(8);
  const boxes = await cells.evaluateAll((cs) => cs.map((c) => ({ x: c.getBoundingClientRect().x, right: c.getBoundingClientRect().right, start: c.classList.contains("block-start") })));
  for (let i = 1; i < boxes.length; i++) {
    const gap = boxes[i]!.x - boxes[i - 1]!.right;
    if (boxes[i]!.start) expect(gap).toBeGreaterThan(1);
    else expect(gap).toBeLessThan(0.6);
  }
  expect(errors).toEqual([]);
});

test("preview before launch: a tap on the backdrop closes the sheet and does not press what is under it", async ({ browser }) => {
  // a finger: the click that follows a tap goes to what is under the finger once the backdrop is gone
  const ctx = await browser.newContext({ hasTouch: true, viewport: { width: 820, height: 1180 }, baseURL: `http://127.0.0.1:${PORT}`, locale: "fr-FR" });
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await login(page);
  await api(page, "look.stopall");
  await api(page, "look.go", { id: "hole" });
  const playing = page.locator(".dgrid .cell button", { hasText: "hole" }).first();
  await expect(playing).toHaveClass(/on/);
  await page.locator(".dgrid .cell button", { hasText: "masks" }).first().tap();
  const sheet = page.getByRole("dialog", { name: "Aperçu avant lancement : masks" });
  await expect(sheet).toBeVisible();
  await page.waitForTimeout(450); // past the guard of the backdrop
  const at = (await playing.boundingBox())!;
  await page.touchscreen.tap(at.x + at.width / 2, at.y + at.height / 2);
  await expect(sheet).toHaveCount(0); // the tap was a way out
  await page.waitForTimeout(300);
  // and it did not stop the look that was under the finger, nor start the one of the sheet
  const state = (await api(page, "look.list", { brief: true })) as { id: string; active: boolean }[];
  expect(state.find((l) => l.id === "hole")?.active).toBe(true);
  expect(state.find((l) => l.id === "masks")?.active).toBe(false);
  await api(page, "look.stopall");
  expect(errors).toEqual([]);
  await ctx.close();
});

/** What the preview strip of a sheet draws now: the colour of each cell. */
const strip = (sheet: Locator) => sheet.locator(".preview.plain .cell").evaluateAll((cs) => cs.map((c) => (c as unknown as { style: { background: string } }).style.background).join("|"));

/** A probe under the Launch button of the open sheet, counting the presses that reach it (the sheet is above it, then gone). */
async function probeUnderLaunch(page: Page, panic = false): Promise<{ x: number; y: number }> {
  const box = (await page.getByRole("dialog", { name: /Aperçu avant lancement/ }).getByRole("button", { name: "Lancer" }).boundingBox())!;
  // as a string, like the other scripts of this file: the server's typecheck has no DOM types
  await page.evaluate(`(() => {
    const b = ${JSON.stringify(box)};
    const host = document.createElement("div");
    ${panic ? 'host.className = "panic-cell";' : ""}
    Object.assign(host.style, { position: "fixed", left: b.x + "px", top: b.y + "px", width: b.width + "px", height: b.height + "px", zIndex: "10" });
    const probe = document.createElement("button");
    probe.style.cssText = "width:100%;height:100%;opacity:0.01";
    ${panic ? 'probe.classList.add("panic");' : ""}
    window.probed = 0;
    probe.addEventListener("click", () => (window.probed += 1));
    host.appendChild(probe);
    document.body.appendChild(host);
  })()`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** How many presses reached the probe. */
const probed = (page: Page) => page.evaluate<number>("window.probed");

test("preview before launch: the second tap of a double tap on Lancer does not reach what is under it", async ({ browser }) => {
  const ctx = await browser.newContext({ hasTouch: true, viewport: { width: 820, height: 1180 }, baseURL: `http://127.0.0.1:${PORT}`, locale: "fr-FR" });
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await login(page);
  await api(page, "look.stopall");
  await page.locator(".dgrid .cell button", { hasText: "masks" }).first().tap();
  await expect(page.getByRole("dialog", { name: "Aperçu avant lancement : masks" })).toBeVisible();
  await page.waitForTimeout(450);
  const at = await probeUnderLaunch(page);
  await page.touchscreen.tap(at.x, at.y); // Lancer
  await page.waitForTimeout(80);
  await page.touchscreen.tap(at.x, at.y); // the second tap, on the spot the sheet has just left
  await page.waitForTimeout(300);
  expect(await probed(page)).toBe(0); // swallowed
  const state = (await api(page, "look.list", { brief: true })) as { id: string; active: boolean }[];
  expect(state.find((l) => l.id === "masks")?.active).toBe(true); // and the look went on
  await page.waitForTimeout(500); // the guard is over: a press at the same spot passes
  await page.touchscreen.tap(at.x, at.y);
  await expect.poll(() => probed(page)).toBe(1);
  await api(page, "look.stopall");
  expect(errors).toEqual([]);
  await ctx.close();
});

test("preview before launch: Panic is never swallowed after the sheet closes", async ({ browser }) => {
  const ctx = await browser.newContext({ hasTouch: true, viewport: { width: 820, height: 1180 }, baseURL: `http://127.0.0.1:${PORT}`, locale: "fr-FR" });
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await login(page);
  await api(page, "look.stopall");
  await page.locator(".dgrid .cell button", { hasText: "masks" }).first().tap();
  await expect(page.getByRole("dialog", { name: "Aperçu avant lancement : masks" })).toBeVisible();
  await page.waitForTimeout(450);
  const at = await probeUnderLaunch(page, true); // the same probe, in a Panic cell
  await page.touchscreen.tap(at.x, at.y); // Lancer
  await page.waitForTimeout(80);
  await page.touchscreen.tap(at.x, at.y); // at once, on Panic
  await expect.poll(() => probed(page)).toBe(1);
  await api(page, "look.stopall");
  expect(errors).toEqual([]);
  await ctx.close();
});

test("preview before launch: a press that starts in the sheet and ends on the backdrop does not close it", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.getByRole("button", { name: "Voir avant de lancer" }).click();
  await api(page, "look.stopall");
  await page.locator(".dgrid .cell button", { hasText: "hole" }).first().click();
  const sheet = page.getByRole("dialog", { name: "Aperçu avant lancement : hole" });
  await expect(sheet).toBeVisible();
  await page.waitForTimeout(450); // past the guard
  const box = (await sheet.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 20); // on the sheet
  await page.mouse.down();
  await page.mouse.move(box.x - 40, box.y + 20); // out, on the backdrop
  await page.mouse.up(); // the click goes to the common ancestor, the backdrop
  await expect(sheet).toBeVisible(); // not a way out
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await api(page, "look.stopall");
  expect(errors).toEqual([]);
});

test("preview before launch: a press on the backdrop during the guard sends the focus to the page, and Tab and Escape still belong to the sheet", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.getByRole("button", { name: "Voir avant de lancer" }).click();
  await api(page, "look.stopall");
  await page.locator(".dgrid .cell button", { hasText: "hole" }).first().click();
  const sheet = page.getByRole("dialog", { name: "Aperçu avant lancement : hole" });
  await expect(sheet).toBeVisible();
  const box = (await sheet.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, Math.max(2, box.y - 30)); // on the backdrop, inside the guard: it closes nothing
  await expect(sheet).toBeVisible();
  expect(await page.evaluate("!document.activeElement || document.activeElement === document.body")).toBe(true); // the focus is on the page
  await page.keyboard.press("Tab");
  await expect(sheet.locator(":focus")).toHaveCount(1); // back into the sheet
  await page.mouse.click(box.x + box.width / 2, Math.max(2, box.y - 30));
  await page.keyboard.press("Escape"); // from the page: still the sheet's
  await expect(sheet).toHaveCount(0);
  await api(page, "look.stopall");
  expect(errors).toEqual([]);
});

test("right-click on a look button in the Live: its preview at once, concise, and on the stage on demand", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.locator(".dgrid .cell button", { hasText: "checker" }).first().click({ button: "right" });
  const menu = page.getByRole("dialog", { name: "Réglages du widget" });
  await expect(menu.locator(".preview.plain .cell")).toHaveCount(8); // the look's canvas, played at once
  await expect.poll(() => menu.locator(".preview.plain .cell:not(.free)").count()).toBeGreaterThan(0);
  await expect(menu.locator(".preview-names span")).toHaveText(["Bar 0", "Bar 1"]); // each fixture above its cells
  await expect(menu.locator(".stage-plan")).toHaveCount(0);
  const narrow = (await menu.boundingBox())!.width;
  await menu.getByRole("button", { name: "Sur la scène" }).click();
  await expect(menu.locator(".stage-plan svg")).toBeVisible(); // the fuller preview, on demand
  await expect.poll(async () => (await menu.boundingBox())!.width).toBeGreaterThan(narrow); // the menu makes room
  // from the audience: the whole stage, nothing cut at the bottom under the view switch
  await menu.getByRole("button", { name: "Face", exact: true }).click();
  const drawn = (await menu.locator(".stage-plan svg").boundingBox())!;
  const frame = (await menu.locator(".stage-plan .plan-scroll").boundingBox())!;
  const plan = (await menu.locator(".stage-plan").boundingBox())!;
  expect(drawn.y + drawn.height).toBeLessThanOrEqual(frame.y + frame.height + 1);
  expect(frame.y + frame.height).toBeLessThanOrEqual(plan.y + plan.height + 1);
  await page.screenshot({ path: "test-results/widget-menu-preview.png" });
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a mouse resting on a look button of the Live shows its colours in a tooltip", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const button = page.locator(".dgrid .cell button", { hasText: "checker" }).first();
  await button.hover();
  const tip = page.locator(".hover-peek");
  await expect(tip.locator(".preview-names span")).toHaveText(["Bar 0", "Bar 1"]); // the fixtures above their cells
  await expect(tip.locator(".preview.plain .cell")).toHaveCount(8);
  await expect(tip.getByRole("button")).toHaveCount(0); // no stage in a tooltip
  await expect(button).not.toHaveAttribute("title"); // one bubble only
  await page.screenshot({ path: "test-results/look-hover-peek.png" });
  await page.mouse.move(0, 0);
  await expect(tip).toHaveCount(0);
  await expect(button).toHaveAttribute("title", /checker/);
  expect(errors).toEqual([]);
});

test("the tooltip of a look button at the bottom of the window opens above it, never over it", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const button = page.locator(".dgrid .cell button", { hasText: "checker" }).first();
  await button.scrollIntoViewIfNeeded();
  // a window that ends just under the button: no room below for the tooltip
  const at = (await button.boundingBox())!;
  await page.setViewportSize({ width: 1280, height: Math.ceil(at.y + at.height + 10) });
  await button.scrollIntoViewIfNeeded();
  await button.hover();
  const tip = page.locator(".hover-peek");
  await expect(tip).toBeVisible();
  const box = (await button.boundingBox())!;
  const peek = (await tip.boundingBox())!;
  expect(peek.y + peek.height).toBeLessThanOrEqual(box.y + 1); // above the button, not over it
  expect(peek.y).toBeGreaterThanOrEqual(0); // and on the screen
  await button.click(); // the button can still be pressed
  await expect(tip).toHaveCount(0);
  await expect.poll(async () => ((await api(page, "look.list")) as { id: string; active?: boolean }[]).some((l) => l.id === "checker" && l.active)).toBe(true);
  await api(page, "look.stopall");
  expect(errors).toEqual([]);
});

test("right-click on a look button in the Live: edit its look in a window, over the dashboard", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.locator(".dgrid .cell button", { hasText: "hole" }).first().click({ button: "right" });
  await page.getByRole("dialog", { name: "Réglages du widget" }).getByRole("button", { name: "✎ Avancé" }).click();
  const editor = page.getByRole("dialog", { name: "hole" });
  await expect(editor.locator(".look-editor")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Réglages du widget" })).toHaveCount(0); // the menu made way
  await expect(editor.getByLabel("Nom", { exact: true })).toHaveValue("hole");
  await editor.getByRole("button", { name: "Fermer" }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.locator(".dgrid")).toBeVisible(); // back on the Live
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
  await expect(menu).toContainText("Note 61");
  await page.screenshot({ path: "test-results/widget-menu.png" });
  await api(page, "midi.in", { port: "Web MIDI · test", bytes: [0x90, 61, 100] });
  const breath = async () => ((await api(page, "look.list")) as { id: string; active: boolean }[]).find((l) => l.id === "breath")?.active;
  await expect.poll(breath).toBe(true);
  // played from an Ableton clip: « while held », the light lasts as long as the note
  await menu.getByLabel("Mode · note 61 · 1").selectOption("momentary");
  await expect.poll(async () => ((await api(page, "midi.mapping.list")) as { input: { number: number }; mode: string; off?: { command: string } }[]).find((m) => m.input.number === 61)).toMatchObject({ mode: "momentary", off: { command: "look.stop" } });
  await api(page, "midi.in", { port: "Web MIDI · test", bytes: [0x90, 61, 100] });
  await api(page, "midi.in", { port: "Web MIDI · test", bytes: [0x80, 61, 0] });
  await expect.poll(breath).toBe(false);
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
  expect(errors.filter((e) => !e.includes("status of 401"))).toEqual([]);
});

test("my account: signed in with the token, create my administrator account, then add my security key", async ({ page }) => {
  const errors = watchErrors(page);
  page.on("dialog", (d) => void d.accept());
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "usb", hasResidentKey: true, hasUserVerification: true, isUserVerified: true } });
  await page.goto(`http://localhost:${PORT}/#token=ui-test-token`);
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
  await page.goto(`http://localhost:${PORT}/#token=ui-test-token`);
  await page.locator("nav.pages button", { hasText: "Réglages" }).click();
  await page.locator(".users-table tr", { hasText: "Moi" }).getByRole("button", { name: "Supprimer" }).click();
  await expect(page.locator(".users-table")).not.toContainText("Moi");
  expect(errors.filter((e) => !e.includes("status of 401"))).toEqual([]);
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
  expect(errors.filter((e) => !e.includes("status of 422"))).toEqual([]); // the question comes as a 422: the browser logs it
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
  const ctx = await browser.newContext({ hasTouch: true, viewport: { width: 820, height: 480 }, baseURL: `http://127.0.0.1:${PORT}`, locale: "fr-FR" });
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
  const gutterBox = (await gutter.boundingBox())!;
  // from just under what sticks to the top of the screen (the page tabs, the pinned edit tools)
  const x = Math.round(gutterBox.x + gutterBox.width / 2);
  const y = Math.round(Math.max(gutterBox.y, await page.locator(".dash-top").evaluate((e) => e.getBoundingClientRect().bottom)) + 10);
  expect(y + 120).toBeLessThan(480); // room left for the swipe
  expect(await page.evaluate<boolean>(`document.elementFromPoint(${x}, ${y})?.classList.contains("scroll-gutter") ?? false`)).toBe(true);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let i = 1; i <= 10; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + i * 12 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
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
  const ctx = await browser.newContext({ hasTouch: true, viewport: { width: 820, height: 1180 }, baseURL: `http://127.0.0.1:${PORT}`, locale: "fr-FR" });
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
  // a short tap now opens the preview sheet (touch context ⇒ mode on by default): launch it
  await page.keyboard.press("Escape");
  await button.tap();
  const sheet = page.getByRole("dialog", { name: "Aperçu avant lancement : hole" });
  await expect(sheet).toBeVisible();
  await launchFromSheet(page, "hole");
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
  // from the handle itself (a small square half clipped by the cell's edge), not a point guessed near the corner
  const handle = (await cell.locator(".handle.se").boundingBox())!;
  const visible = (await cell.boundingBox())!;
  await drag({ x: Math.min(handle.x + handle.width / 2, visible.x + visible.width - 2), y: Math.min(handle.y + handle.height / 2, visible.y + visible.height - 2) }, cw, 0); // one column wider
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

test("exclusive groups as radio buttons: chosen from a button's menu, each releasing only its own set", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  type G = { id: string; name: string; exclusive: boolean; members: { fixtures: string[]; looks: string[]; groups: string[] } };
  const groups = async () => (await api(page, "group.list")) as G[];
  const before = await groups();
  const setOf = async (look: string) => (await groups()).filter((g) => g.exclusive && g.members.looks.includes(look)).map((g) => g.name);
  const [dash] = (await api(page, "dashboard.list")) as { widgets: { id: string; kind: string; target?: string }[] }[];
  const buttons = dash!.widgets.filter((w) => w.kind === "look" && w.target);
  const [a, b, c] = [buttons[0]!, buttons[1]!, buttons[2]!];
  const choose = async (w: { id: string }, option: string) => {
    await page.locator(`.dgrid .cell[data-widget="${w.id}"] button`).first().click({ button: "right" });
    const menu = page.getByRole("dialog", { name: "Réglages du widget" });
    const set = menu.getByLabel("Exclusif avec");
    const label = (await set.locator("option").allTextContents()).find((o) => o.startsWith(option))!;
    await set.selectOption({ label });
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  };
  try {
    await api(page, "look.stopall");
    // a and b in a new set, c in another new one
    await choose(a, "+ Nouveau groupe exclusif");
    await expect.poll(() => setOf(a.target!)).toHaveLength(1);
    const [first] = await setOf(a.target!);
    await choose(b, first!);
    await expect.poll(() => setOf(b.target!)).toEqual([first]);
    await choose(c, "+ Nouveau groupe exclusif");
    await expect.poll(async () => (await setOf(c.target!))[0]).not.toBe(first);
    // b releases a, its own set, never c, in another
    await api(page, "look.go", { id: a.target });
    await api(page, "look.go", { id: c.target });
    await api(page, "look.go", { id: b.target });
    const playing = ((await api(page, "look.list", { brief: true })) as { id: string; active: boolean }[]).filter((l) => l.active).map((l) => l.id);
    expect(playing).toContain(b.target);
    expect(playing).toContain(c.target);
    expect(playing).not.toContain(a.target);
    // while arranging, each button says its set; two chosen at once are taken out of every set
    await page.getByRole("button", { name: "✎" }).click();
    await expect(page.locator(`.dgrid .cell[data-widget="${a.id}"] .set-mark`)).toContainText(first!);
    await page.locator(`.dgrid .cell[data-widget="${a.id}"]`).click();
    await page.locator(`.dgrid .cell[data-widget="${c.id}"]`).click({ modifiers: ["ControlOrMeta"] });
    const panel = page.locator(".dashboards .editor.many");
    await expect(panel.getByLabel("Exclusif avec")).toHaveValue("+mixed");
    await panel.getByLabel("Exclusif avec").selectOption("");
    await expect.poll(async () => [...(await setOf(a.target!)), ...(await setOf(c.target!))]).toEqual([]);
    await expect(page.locator(`.dgrid .cell[data-widget="${a.id}"] .set-mark`)).toHaveCount(0);
    await page.screenshot({ path: "test-results/exclusive-sets.png" });
    await page.getByRole("button", { name: "✔" }).click();
  } finally {
    await api(page, "look.stopall");
    const now = await groups();
    for (const g of now.filter((x) => !before.some((y) => y.id === x.id))) await api(page, "group.delete", { id: g.id, force: true });
    for (const g of before) {
      const { effectiveLevel: _, ...plain } = g as G & { effectiveLevel?: number };
      await api(page, "group.put", { group: plain });
    }
  }
  expect(errors).toEqual([]);
});

test("layout editing: several widgets selected (Ctrl/⌘, Shift for a frame) get the same colour and mode at once", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const [dash] = (await api(page, "dashboard.list")) as TestDashboard[];
  const looks = dash!.widgets.filter((w) => w.kind === "look").sort((p, q) => p.y - q.y || p.x - q.x);
  const [a, b] = [looks[0]!, looks[looks.length - 1]!];
  // what a frame from a to b takes: every widget whose centre lies in the rectangle they span
  const [x1, y1, x2, y2] = [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x + a.w, b.x + b.w), Math.max(a.y + a.h, b.y + b.h)];
  const framed = dash!.widgets.filter((w) => w.x + w.w / 2 > x1 && w.x + w.w / 2 < x2 && w.y + w.h / 2 > y1 && w.y + w.h / 2 < y2);
  expect(framed.length).toBeGreaterThan(2);
  await page.getByRole("button", { name: "✎" }).click();
  const cell = (id: string) => page.locator(`.dgrid .cell[data-widget="${id}"]`);
  await cell(a.id).click();
  await cell(looks[1]!.id).click({ modifiers: ["ControlOrMeta"] });
  const panel = page.locator(".dashboards .editor.many");
  await expect(panel).toContainText("2 widgets sélectionnés");
  await cell(looks[1]!.id).click({ modifiers: ["ControlOrMeta"] }); // again: taken out
  await expect(panel).toHaveCount(0);
  await cell(a.id).click(); // alone again, and the corner a frame starts from
  await cell(b.id).click({ modifiers: ["Shift"] }); // everything framed from a to b
  await expect(panel).toContainText(`${framed.length} widgets sélectionnés`);
  await expect(page.locator(".dgrid .cell.selected")).toHaveCount(framed.length);
  await panel.getByRole("radio", { name: "rouge" }).click();
  await panel.getByLabel("Mode").selectOption("momentary");
  await page.screenshot({ path: "test-results/dashboard-multi-select.png" });
  await page.getByRole("button", { name: "✔" }).click();
  const saved = ((await api(page, "dashboard.list")) as typeof dash[])[0]!.widgets.filter((w) => framed.some((f) => f.id === w.id));
  expect(saved.every((w) => w.kind === "preview" || w.color === "#ef4444")).toBe(true);
  expect(saved.filter((w) => w.kind === "look").every((w) => w.mode === "momentary")).toBe(true);
  // back as it was
  await api(page, "dashboard.put", { dashboard: dash });
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
  expect(errors.filter((e) => !e.includes("status of 401"))).toEqual([]);
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

test("a dashboard fader maps its whole track and keeps keyboard access", async ({ page, browserName }) => {
  const errors = watchErrors(page);
  await login(page);
  const cell = page.locator(".cell .fader").first();
  const fader = cell.locator("input[type=range]");
  const track = cell.locator(".track");
  const thumb = cell.locator(".fader-thumb");
  const level = cell.locator(".level-bar");
  const travel = (await track.boundingBox())!.height;

  for (const value of [0, 250, 500, 750, 1000]) {
    await fader.fill(String(value));
    const trackBox = (await track.boundingBox())!;
    const levelBox = (await level.boundingBox())!;
    const thumbBox = (await thumb.boundingBox())!;
    expect(trackBox.height).toBe(travel);
    expect((await fader.boundingBox())!.height).toBe(travel);
    expect(Math.abs(levelBox.height - (travel * value) / 1000)).toBeLessThanOrEqual(1);
    expect(Math.abs(thumbBox.y + thumbBox.height / 2 - (trackBox.y + trackBox.height - levelBox.height))).toBeLessThanOrEqual(1);
  }

  const box = (await track.boundingBox())!;
  // WebKit rounds pointer coordinates to whole CSS pixels; allow one pixel, Chromium must be exact.
  const clickTolerance = browserName === "webkit" ? Math.ceil(1000 / box.height) : 0;
  const clicked = async (fraction: number) => {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height * (1 - fraction));
    await expect.poll(async () => Math.abs(Number(await fader.inputValue()) - fraction * 1000)).toBeLessThanOrEqual(clickTolerance);
  };
  await clicked(0.8);
  await clicked(0.2);
  await fader.fill("1000");
  await thumb.click();
  await expect(fader).toHaveValue("1000");
  await fader.fill("0");
  await thumb.click();
  await expect(fader).toHaveValue("0");

  await fader.focus();
  const press = async (key: string, value: string) => {
    await page.keyboard.press(key);
    // let each command and its refresh settle before the next distinct key press
    await page.waitForTimeout(100);
    await expect(fader).toHaveValue(value);
  };
  await press("End", "1000");
  await press("Home", "0");
  await press("ArrowUp", "1");
  await press("ArrowRight", "2");
  await press("ArrowDown", "1");
  await press("ArrowLeft", "0");
  await fader.fill("1000");
  expect(errors).toEqual([]);
});

test("smoothed DCA: the output glides to the fader, a ghost bar shows the level sent", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  type G = { id: string; master?: { level: number; mute: boolean; smoothing?: unknown } };
  const master = ((await api(page, "group.list")) as G[]).find((g) => g.id === "master")!;
  try {
    await api(page, "group.put", { group: { ...master, master: { level: 1, mute: false, smoothing: { curve: "linear", msPerStep: 10 } } } });
    await page.reload();
    const cell = page.locator(".cell .fader").first();
    await expect(cell.locator("label")).toContainText("≈"); // the mark of a smoothed fader
    await cell.locator("input[type=range]").fill("0"); // 2.55 s to get there
    await expect(cell.locator(".ghost-bar")).toBeVisible();
    await expect(cell.locator(".sent")).toBeVisible();
    expect((await dmx(page))[0]).toBeGreaterThan(0); // still on its way down
    await page.screenshot({ path: "test-results/fader-ghost-bar.png" });
    await expect(cell.locator(".ghost-bar")).toHaveCount(0, { timeout: 5000 }); // arrived: gone
    expect((await dmx(page))[0]).toBe(0);
  } finally {
    await api(page, "group.put", { group: { ...master, master: { level: 1, mute: false } } });
  }
  expect(errors).toEqual([]);
});

test("right-click on a DCA fader: its smoothing, and « Advanced » opens the group editor", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  type G = { id: string; master?: { level: number; mute: boolean; smoothing?: unknown } };
  const master = ((await api(page, "group.list")) as G[]).find((g) => g.id === "master")!;
  try {
    await page.locator(".cell .fader").first().click({ button: "right" });
    const menu = page.getByRole("dialog", { name: "Réglages du widget" });
    await menu.getByLabel("Lissage").selectOption("5");
    await expect.poll(async () => ((await api(page, "group.list")) as G[]).find((g) => g.id === "master")!.master!.smoothing).toEqual({ curve: "linear", msPerStep: 5 });
    await expect(page.locator(".cell .fader label").first()).toContainText("≈");
    await page.screenshot({ path: "test-results/widget-menu-smoothing.png" });
    await menu.getByRole("button", { name: "✎ Avancé" }).click();
    await expect(menu).toHaveCount(0); // the menu made way
    const editor = page.locator(".group-editor");
    await expect(editor).toBeVisible();
    await expect(editor.getByLabel("Lissage")).toHaveValue("5"); // the same setting, in the whole editor
    await editor.getByRole("button", { name: "Fermer" }).click();
    await expect(editor).toHaveCount(0);
  } finally {
    await api(page, "group.put", { group: { ...master, master: { level: 1, mute: false } } });
  }
  expect(errors).toEqual([]);
});

test("a smoothed DCA fader dragged up and back down keeps its travel and lands on its real level", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  type G = { id: string; master?: { level: number; mute: boolean; smoothing?: unknown }; effectiveLevel: number };
  const master = ((await api(page, "group.list")) as G[]).find((g) => g.id === "master")!;
  const height = async (locator: Locator) => Math.round((await locator.boundingBox())!.height);
  try {
    await api(page, "group.put", { group: { ...master, master: { level: 1, mute: false, smoothing: { curve: "linear", msPerStep: 5 } } } });
    await page.reload();
    const cell = page.locator(".cell .fader").first();
    const fader = cell.locator("input[type=range]");
    await expect(fader).toBeVisible();
    await expect(cell.locator("label")).toContainText("≈");
    await expect.poll(async () => (await dmx(page))[0]).toBe(255);
    const travel = await height(cell.locator(".track"));
    const length = await height(fader);

    // the gesture of the report: up by dragging, back down by dragging, then let go
    const box = (await fader.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = (fraction: number) => box.y + (1 - fraction) * box.height;
    let sawGhost = false;
    const at = async (fraction: number) => {
      await page.mouse.move(x, y(fraction));
      await page.waitForTimeout(60);
      // the level path has to stay drawn while it glides, or the arrival would take the whole bar
      // back and the fader would look like it halved under the finger
      expect(await cell.locator(".level-bar").count(), `the level path at ${fraction}`).toBe(1);
      // the read-out's second line goes from the effective level to the one sent: it must keep its height,
      // or the track would take back the room under the finger
      expect(await height(cell.locator(".track")), `travel at ${fraction}`).toBe(travel);
      expect(await height(fader), `slider length at ${fraction}`).toBe(length);
      if (await cell.locator(".ghost-bar").count()) sawGhost = true; // the glide was really running
    };
    await page.mouse.move(x, y(0.4));
    await page.mouse.down();
    for (const f of [0.55, 0.7, 0.85, 0.95]) await at(f);
    for (const f of [0.85, 0.7, 0.55, 0.4]) await at(f);
    await page.mouse.up();
    expect(sawGhost, "the level was on its way during the gesture").toBe(true);

    // the glide lands: the level shown, the level beside it and the level reached all agree
    await expect(cell.locator(".ghost-bar")).toHaveCount(0, { timeout: 5000 });
    const asked = Math.round(Number(await fader.inputValue()) / 10);
    await expect.poll(async () => (await cell.locator(".value").innerText()).replace(/\s+/g, " ").trim()).toBe(`${asked}% (${asked}%)`);
    await expect.poll(async () => Math.round(((await api(page, "group.list")) as G[]).find((g) => g.id === "master")!.effectiveLevel * 100)).toBe(asked);
    expect(await height(cell.locator(".track")), "the fader ends on the travel it started with").toBe(travel);
    expect(await height(fader), "the slider ends on the length it started with").toBe(length);
    expect(Math.abs((await height(cell.locator(".level-bar"))) - Math.round((travel * asked) / 100))).toBeLessThanOrEqual(2);
  } finally {
    await api(page, "group.put", { group: { ...master, master: { level: 1, mute: false } } });
  }
  expect(errors).toEqual([]);
});

test("a group list answer that lands late does not rewrite the fader", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  type G = { id: string; master?: { level: number; mute: boolean; smoothing?: unknown }; effectiveLevel: number };
  const master = ((await api(page, "group.list")) as G[]).find((g) => g.id === "master")!;
  let held: { route: Route; status: number; headers: Record<string, string>; body: string } | undefined;
  let lists = 0;
  try {
    await api(page, "group.put", { group: { ...master, master: { level: 1, mute: false, smoothing: { curve: "linear", msPerStep: 10 } } } });
    await page.reload();
    const cell = page.locator(".cell .fader").first();
    const fader = cell.locator("input[type=range]");
    await expect(fader).toHaveValue("1000");
    // the desk's slow link: the first group.list's answer is held in the wire
    await page.route("**/api/plugins/light/commands/group.list", async (route) => {
      lists++;
      if (lists === 1) {
        const response = await route.fetch();
        held = { route, status: response.status(), headers: response.headers(), body: await response.text() };
        return;
      }
      await route.fulfill({ response: await route.fetch() });
    });
    await api(page, "group.level", { id: master.id, level: 0.2 });
    await expect.poll(() => Boolean(held)).toBe(true);
    await expect.poll(async () => (JSON.parse(held!.body) as { result: G[] }).result.find((g) => g.id === master.id)!.master!.level).toBe(0.2);
    await api(page, "group.level", { id: master.id, level: 0.8 });
    await expect(fader).toHaveValue("800");
    await expect(cell.locator(".ghost-bar")).toHaveCount(0, { timeout: 6000 });
    await expect.poll(() => lists).toBeGreaterThanOrEqual(3); // the landing's own read ran after the held one

    // the held answer is released now, after the landing: the last read must win
    await held!.route.fulfill({ status: held!.status, headers: held!.headers, body: held!.body });
    await expect(fader).toHaveValue("800"); // the 20 % state is gone, the fader stays at 80 %
    await expect(cell.locator(".value")).toContainText("80%");
  } finally {
    await page.unrouteAll();
    await api(page, "group.put", { group: { ...master, master: { level: 1, mute: false } } });
  }
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

test("show page: right-click a look to edit, start, duplicate it, with its preview", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await api(page, "look.stopall");
  await page.locator("nav.pages").getByRole("button", { name: "Show", exact: true }).click();
  const row = page.locator("tr", { has: page.locator("button.look", { hasText: "checker" }) });
  await row.locator("td").nth(1).click({ button: "right" });
  const menu = page.getByRole("dialog", { name: "Look" });
  await expect(menu.locator(".preview.plain .cell")).toHaveCount(8); // its preview at once
  await menu.getByRole("button", { name: "▶ Lancer" }).click();
  await expect.poll(async () => ((await api(page, "look.list")) as { id: string; active: boolean }[]).find((l) => l.id === "checker")?.active).toBe(true);
  await expect(menu.getByRole("button", { name: "■ Arrêt" })).toBeVisible();
  await menu.getByRole("button", { name: "✎ Modifier" }).click();
  const editor = page.getByRole("dialog", { name: "checker" });
  await expect(editor.locator(".look-editor")).toBeVisible();
  await expect(menu).toHaveCount(0);
  await editor.getByRole("button", { name: "Fermer" }).click();
  await row.locator("td").nth(1).click({ button: "right" });
  await page.getByRole("dialog", { name: "Look" }).getByRole("button", { name: "⧉ Dupliquer" }).click();
  await expect(page.getByRole("dialog", { name: /checker \(copie\)/ }).getByRole("textbox", { name: /^Nom/ })).toHaveValue("checker (copie)"); // a copy to save under another name
  await page.getByRole("dialog", { name: /checker \(copie\)/ }).getByRole("button", { name: "Fermer" }).click();
  await api(page, "look.stopall");
  expect(errors).toEqual([]);
});

test("venue: right-click a zone to edit it, and move zones only once allowed", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await api(page, "stage.zone.put", { zone: { id: "test-zone", name: "Zone test", type: "riser", polygon: [[-1, 2], [1, 2], [1, 3], [-1, 3]], floorHeight: 0.4 } });
  const zone = async () => ((await api(page, "stage.zone.list")) as { id: string; name: string; polygon: [number, number][]; floorHeight: number }[]).find((z) => z.id === "test-zone")!;
  try {
    await page.locator("nav.pages").getByRole("button", { name: "Lieu" }).click();
    const shape = page.locator('.stage-plan g.zone[data-zone="test-zone"] polygon').first();
    await shape.scrollIntoViewIfNeeded();
    // not allowed yet: dragging it does nothing
    let box = (await shape.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 4 });
    await page.mouse.up();
    expect((await zone()).polygon).toEqual([[-1, 2], [1, 2], [1, 3], [-1, 3]]);
    // its menu: a new name and width
    await shape.click({ button: "right" });
    const menu = page.getByRole("dialog", { name: "Zone" });
    await menu.getByLabel("Nom de la zone").fill("Estrade test");
    await menu.getByLabel("largeur (m)").fill("4");
    await menu.getByRole("button", { name: "Enregistrer" }).click();
    await expect.poll(async () => (await zone()).name).toBe("Estrade test");
    expect((await zone()).polygon).toEqual([[-2, 2], [2, 2], [2, 3], [-2, 3]]); // 4 m wide, still centred, its front kept
    // allowed: dragged to the right, it moves
    await page.getByLabel("Déplacer les zones").check();
    box = (await shape.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => (await zone()).polygon[0]![0]).toBeGreaterThan(-2);
    const [[x0, y0]] = (await zone()).polygon;
    expect(y0).toBe(2); // moved sideways only
    expect(Math.round(x0! * 10)).toBe(x0! * 10); // by 10 cm
    await page.getByLabel("Déplacer les zones").uncheck();
  } finally {
    await api(page, "stage.zone.delete", { id: "test-zone" });
  }
  expect(errors).toEqual([]);
});

test("venue: a canvas is deleted from its list after asking, and gone from venue.canvas.list", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await api(page, "venue.canvas.put", { canvas: { id: "test-canvas", name: "Canevas test", cells: 2, render: [{ from: 0, to: 1, targets: [{ fixture: "bar-0", head: -1 }] }] } });
  const listed = async () => ((await api(page, "venue.canvas.list")) as { id: string }[]).some((c) => c.id === "test-canvas");
  try {
    await page.locator("nav.pages").getByRole("button", { name: "Lieu" }).click();
    const del = page.getByRole("button", { name: "Supprimer Canevas test" });
    const row = page.locator("li", { has: del });
    await expect(row).toHaveCount(1);
    // the question names the canvas; dismissed, it stays
    let asked = "";
    page.once("dialog", (d) => ((asked = d.message()), void d.dismiss()));
    await del.click();
    await expect.poll(() => asked).toContain("Canevas test");
    expect(await listed()).toBe(true);
    await expect(row).toHaveCount(1);
    // accepted: gone from the page and from the venue
    page.once("dialog", (d) => void d.accept());
    await del.click();
    await expect(row).toHaveCount(0);
    expect(await listed()).toBe(false);
  } finally {
    if (await listed()) await api(page, "venue.canvas.delete", { id: "test-canvas", force: true });
  }
  expect(errors).toEqual([]);
});

/** A canvas of bar-0's four heads, one cell each, for the canvas editor's tests. */
const editableCanvas = { id: "test-edit", name: "Canevas éditable", cells: 4, render: [0, 1, 2, 3].map((h) => ({ from: h, to: h, targets: [{ fixture: "bar-0", head: h }] })) };
async function openCanvasEditor(page: Page): Promise<Locator> {
  await page.locator("nav.pages").getByRole("button", { name: "Lieu" }).click();
  await page.getByRole("button", { name: "Éditer Canevas éditable" }).click();
  const dialog = page.getByRole("dialog", { name: /Éditer le canevas · Canevas éditable/ });
  await expect(dialog.getByRole("listbox").getByRole("option")).toHaveCount(4);
  return dialog;
}
const canvasHeads = async (page: Page) => {
  const c = ((await api(page, "venue.canvas.list")) as { id: string; cells: number; render: { from: number; to: number; targets: { fixture: string; head: number }[] }[] }[]).find((x) => x.id === "test-edit")!;
  const out: string[] = [];
  for (const r of c.render) for (let i = r.from; i <= r.to; i++) out[i] = r.targets.map((t) => `${t.fixture}:${t.head}`).join("+");
  return Array.from({ length: c.cells }, (_, i) => out[i] ?? "");
};

test("canvas editor: pick with click, Ctrl and Shift or a frame, remove at once, undo and redo, add a fixture", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await api(page, "venue.canvas.put", { canvas: editableCanvas, force: true });
  try {
    // reading the canvas is a read: opening the editor writes no activity line and does not reload on its own echo
    let reads = 0;
    page.on("request", (r) => void (r.url().endsWith("/commands/venue.canvas.get") && reads++));
    const linesBefore = ((await api(page, "activity.list")) as unknown[]).length;
    const dialog = await openCanvasEditor(page);
    const cell = (i: number) => dialog.getByRole("listbox").getByRole("option").nth(i);
    // the keyboard is in the window as it opens
    await expect(cell(0)).toBeFocused();
    await page.waitForTimeout(600);
    expect(reads).toBeLessThanOrEqual(2);
    expect(((await api(page, "activity.list")) as unknown[]).length).toBe(linesBefore);
    // click, Ctrl/⌘, Shift
    await cell(0).click();
    await cell(2).click({ modifiers: ["ControlOrMeta"] });
    await expect(dialog.locator("[aria-selected=true]")).toHaveCount(2);
    await cell(3).click({ modifiers: ["Shift"] });
    await expect(dialog.locator("[aria-selected=true]")).toHaveCount(2); // from 2 (the last clicked) to 3
    await expect(cell(2)).toHaveAttribute("aria-selected", "true");
    // a frame drawn from the strip's corner over the first two squares
    const cellStrip = dialog.getByRole("listbox");
    const box = (await cellStrip.boundingBox())!;
    const second = (await cell(1).boundingBox())!;
    await page.mouse.move(box.x + 6, box.y + 12); // inside the rounded corner
    await page.mouse.down();
    await page.mouse.move(second.x + second.width - 2, second.y + second.height - 2, { steps: 4 });
    await page.mouse.up();
    await expect(dialog.locator("[aria-selected=true]")).toHaveCount(2);
    await expect(cell(0)).toHaveAttribute("aria-selected", "true");
    await expect(cell(1)).toHaveAttribute("aria-selected", "true");
    // removed at once (no question: no look on it)
    await page.keyboard.press("Delete");
    await expect(dialog.getByRole("listbox").getByRole("option")).toHaveCount(2);
    expect(await canvasHeads(page)).toEqual(["bar-0:2", "bar-0:3"]);
    // ⌘Z puts it back, ⇧⌘Z takes it away again
    await page.keyboard.press("ControlOrMeta+z");
    await expect(dialog.getByRole("listbox").getByRole("option")).toHaveCount(4);
    expect(await canvasHeads(page)).toEqual(["bar-0:0", "bar-0:1", "bar-0:2", "bar-0:3"]);
    await dialog.getByRole("button", { name: "Rétablir" }).click();
    await expect(dialog.getByRole("listbox").getByRole("option")).toHaveCount(2);
    await dialog.getByRole("button", { name: "Annuler" }).first().click();
    await expect(dialog.getByRole("listbox").getByRole("option")).toHaveCount(4);
    // add bar-1 at the end: one square per head
    await dialog.getByText("Ajouter des projecteurs").click();
    const secondBar = ((await api(page, "venue.fixture.list")) as { id: string; name: string }[]).find((f) => f.id === "bar-1")!.name;
    await dialog.locator(".canvas-add-list").getByLabel(secondBar, { exact: true }).check();
    await dialog.getByRole("button", { name: /^Ajouter \(1\)/ }).click();
    await expect(dialog.getByRole("listbox").getByRole("option")).toHaveCount(8);
    expect((await canvasHeads(page)).slice(4)).toEqual(["bar-1:0", "bar-1:1", "bar-1:2", "bar-1:3"]);
    await page.screenshot({ path: "test-results/canvas-editor.png", fullPage: true });
    await dialog.getByRole("button", { name: "Fermer" }).click(); // closed before the canvas goes
    await expect(page.getByRole("button", { name: "Éditer Canevas éditable" })).toBeFocused(); // back where it was opened from
  } finally {
    await api(page, "venue.canvas.delete", { id: "test-edit", force: true });
  }
  expect(errors).toEqual([]);
});

test("canvas editor: keyboard alone picks and moves; a drag moves; a look of exact steps is asked about, adapted, and undone with its steps", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await api(page, "venue.canvas.put", { canvas: editableCanvas, force: true });
  const steps = [["#ff0000", "#00ff00", "#0000ff", "#ffffff"]];
  await api(page, "look.put", { look: { id: "test-edit-look", name: "Pas exacts", canvas: "test-edit", technique: { kind: "pas", steps } } });
  const rows = async () => (((await api(page, "look.get", { id: "test-edit-look" })) as { technique: { steps: string[][] } }).technique.steps);
  try {
    const dialog = await openCanvasEditor(page);
    const cell = (i: number) => dialog.getByRole("listbox").getByRole("option").nth(i);
    // keyboard: focus the first square, go right, pick it, move it one later
    await cell(0).focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Space");
    await expect(cell(1)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Alt+ArrowRight");
    // the look would be shifted: the question names it, with its steps before and after
    const impact = dialog.getByRole("alertdialog", { name: "Des looks sont touchés" });
    await expect(impact).toContainText("Pas exacts");
    await expect(impact.locator(".mini-row")).toHaveCount(2);
    await impact.getByRole("button", { name: "Adapter les pas" }).click();
    await expect(impact).toHaveCount(0);
    expect(await canvasHeads(page)).toEqual(["bar-0:0", "bar-0:2", "bar-0:1", "bar-0:3"]);
    expect(await rows()).toEqual([["#ff0000", "#0000ff", "#00ff00", "#ffffff"]]); // each column followed its cell
    await expect(cell(2)).toHaveAttribute("aria-selected", "true"); // still picked where it went
    // undo: the canvas and the look's steps come back together
    await dialog.getByRole("button", { name: "Annuler" }).first().click();
    await expect.poll(() => canvasHeads(page)).toEqual(["bar-0:0", "bar-0:1", "bar-0:2", "bar-0:3"]);
    expect(await rows()).toEqual(steps);
    // a drag of the last square before the first (mouse, past 8 px): asked, then done anyway
    const from = (await cell(3).boundingBox())!;
    const to = (await cell(0).boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + 4, to.y + to.height / 2, { steps: 8 });
    await expect(dialog.locator(".canvas-gap")).toHaveCount(1);
    await page.mouse.up();
    await expect(impact).toBeVisible();
    await page.screenshot({ path: "test-results/canvas-editor-question.png", fullPage: true });
    await impact.getByRole("button", { name: "Le faire quand même" }).click();
    await expect.poll(() => canvasHeads(page)).toEqual(["bar-0:3", "bar-0:0", "bar-0:1", "bar-0:2"]);
    expect(await rows()).toEqual(steps); // forced: the steps stay as they were
    // cancelled: nothing moves
    await cell(0).click();
    await expect(dialog.getByRole("button", { name: "Déplacer d'une case vers le début" })).toBeDisabled(); // already the first
    await dialog.getByRole("button", { name: "Déplacer d'une case vers la fin" }).click();
    await impact.getByRole("button", { name: "Annuler" }).click();
    expect(await canvasHeads(page)).toEqual(["bar-0:3", "bar-0:0", "bar-0:1", "bar-0:2"]);
    await page.screenshot({ path: "test-results/canvas-editor-impact.png", fullPage: true });
    await dialog.getByRole("button", { name: "Fermer" }).click(); // closed before the canvas goes
  } finally {
    await api(page, "look.delete", { id: "test-edit-look", force: true });
    await api(page, "venue.canvas.delete", { id: "test-edit", force: true });
  }
  expect(errors.filter((e) => !e.includes("status of 400"))).toEqual([]); // the refusals that ask about the look come as a 400: the browser logs them
});

test("canvas editor: a drag let go away from the strip or ended by Escape moves nothing; a burst of keys loses no gesture", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await api(page, "venue.canvas.put", { canvas: editableCanvas, force: true });
  const start = ["bar-0:0", "bar-0:1", "bar-0:2", "bar-0:3"];
  try {
    const dialog = await openCanvasEditor(page);
    const cell = (i: number) => dialog.getByRole("listbox").getByRole("option").nth(i);
    const from = (await cell(3).boundingBox())!;
    const first = (await cell(0).boundingBox())!;
    const band = (await dialog.getByRole("listbox").boundingBox())!;
    const carry = async () => {
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(first.x + 4, first.y + first.height / 2, { steps: 8 });
      await expect(dialog.locator(".canvas-gap")).toHaveCount(1);
    };
    // let go well above the strip: the mark goes, nothing moves
    await carry();
    await page.mouse.move(first.x + 4, band.y - 80, { steps: 4 });
    await expect(dialog.locator(".canvas-gap")).toHaveCount(0);
    await page.mouse.up();
    await expect(dialog.getByRole("status").last()).toHaveText("Déplacement annulé.");
    expect(await canvasHeads(page)).toEqual(start);
    // Escape while carrying: nothing moves, and the square under the pointer is not picked by the release
    await carry();
    await page.keyboard.press("Escape");
    await expect(dialog.locator(".canvas-gap")).toHaveCount(0);
    await page.mouse.up();
    expect(await canvasHeads(page)).toEqual(start);
    await expect(dialog.locator("[aria-selected=true]")).toHaveCount(0);
    await expect(dialog).toBeVisible(); // Escape did not close the window either
    // three Alt+→ in a burst: three places, the focus following the square
    await cell(0).focus();
    await page.keyboard.press("Space");
    for (let k = 0; k < 3; k++) await page.keyboard.press("Alt+ArrowRight", { delay: 0 });
    await expect.poll(() => canvasHeads(page)).toEqual(["bar-0:1", "bar-0:2", "bar-0:3", "bar-0:0"]);
    await expect(cell(3)).toBeFocused();
    await expect(cell(3)).toHaveAttribute("aria-selected", "true");
    // a gesture made from a button leaves the focus on it, to press it again
    await dialog.getByRole("button", { name: "Déplacer d'une case vers le début" }).click();
    await expect.poll(() => canvasHeads(page)).toEqual(["bar-0:1", "bar-0:2", "bar-0:0", "bar-0:3"]);
    await expect(dialog.getByRole("button", { name: "Déplacer d'une case vers le début" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(() => canvasHeads(page)).toEqual(["bar-0:1", "bar-0:0", "bar-0:2", "bar-0:3"]);
    await page.keyboard.press("ControlOrMeta+z");
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => canvasHeads(page)).toEqual(["bar-0:1", "bar-0:2", "bar-0:3", "bar-0:0"]);
    // ⌘Z twice in a burst: two steps back, none lost
    await page.keyboard.press("ControlOrMeta+z", { delay: 0 });
    await page.keyboard.press("ControlOrMeta+z", { delay: 0 });
    await expect.poll(() => canvasHeads(page)).toEqual(["bar-0:1", "bar-0:0", "bar-0:2", "bar-0:3"]);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => canvasHeads(page)).toEqual(start);
    await expect(dialog.getByRole("button", { name: "Annuler" }).first()).toBeDisabled();
    await dialog.getByRole("button", { name: "Rétablir" }).click();
    await expect.poll(() => canvasHeads(page)).toEqual(["bar-0:1", "bar-0:0", "bar-0:2", "bar-0:3"]);
    // every square picked: Delete sends nothing, and says why
    await cell(0).focus();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Delete");
    await expect(dialog.getByRole("status").last()).toContainText("garde au moins une case");
    expect((await canvasHeads(page)).length).toBe(4);
    // « move before… » then a touch on the destination: one move, as a tablet does it
    await cell(3).click();
    await dialog.getByRole("button", { name: "Déplacer avant…" }).click();
    await cell(0).click();
    await expect.poll(() => canvasHeads(page)).toEqual(["bar-0:3", "bar-0:1", "bar-0:0", "bar-0:2"]);
    await dialog.getByRole("button", { name: "Fermer" }).click();
  } finally {
    await api(page, "venue.canvas.delete", { id: "test-edit", force: true });
  }
  expect(errors).toEqual([]);
});

test("canvas editor: a canvas deleted elsewhere is said gone and never comes back by an undo; one changed elsewhere empties the undo", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await api(page, "venue.canvas.put", { canvas: editableCanvas, force: true });
  try {
    const dialog = await openCanvasEditor(page);
    const cell = (i: number) => dialog.getByRole("listbox").getByRole("option").nth(i);
    const undo = dialog.getByRole("button", { name: "Annuler" }).first();
    await cell(0).click();
    await page.keyboard.press("Delete");
    await expect(dialog.getByRole("listbox").getByRole("option")).toHaveCount(3);
    await expect(undo).toBeEnabled();
    // changed elsewhere (another device, the AI): what this window would undo is no longer the canvas
    await api(page, "venue.canvas.edit", { id: "test-edit", ops: [{ op: "set", notes: "ailleurs" }] });
    await expect(undo).toBeDisabled();
    await cell(0).click();
    await page.keyboard.press("Delete");
    await expect(dialog.getByRole("listbox").getByRole("option")).toHaveCount(2);
    await expect(undo).toBeEnabled();
    // deleted elsewhere, then ⌘Z here
    await api(page, "venue.canvas.delete", { id: "test-edit", force: true });
    await expect(dialog.getByText("Ce canevas n'existe plus.")).toBeVisible();
    await page.keyboard.press("ControlOrMeta+z");
    await page.waitForTimeout(300);
    expect(((await api(page, "venue.canvas.list")) as { id: string }[]).some((c) => c.id === "test-edit")).toBe(false);
    await dialog.getByRole("button", { name: "Fermer" }).click();
  } finally {
    await api(page, "venue.canvas.delete", { id: "test-edit", force: true }).catch(() => undefined);
  }
  expect(errors.filter((e) => !e.includes("status of 422"))).toEqual([]); // the read of a canvas that is gone is refused: the browser logs it
});

test("canvas editor: a mirrored mask cannot follow its squares; adapting the others then forcing it keeps them adapted", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await api(page, "venue.canvas.put", { canvas: editableCanvas, force: true });
  await api(page, "look.put", { look: { id: "test-edit-look", name: "Pas exacts", canvas: "test-edit", technique: { kind: "pas", steps: [["#ff0000", "#00ff00", "#0000ff", "#ffffff"]] } } });
  await api(page, "look.put", { look: { id: "test-edit-mirror", name: "Masque miroir", canvas: "test-edit", mirror: true, technique: { kind: "masques", colors: ["#ff0000", "#0000ff"], block: 1, masks: ["#-"] } } });
  try {
    const dialog = await openCanvasEditor(page);
    await dialog.getByRole("listbox").getByRole("option").nth(1).click();
    await dialog.getByRole("button", { name: "Déplacer d'une case vers la fin" }).click();
    const impact = dialog.getByRole("alertdialog", { name: "Des looks sont touchés" });
    await expect(impact).toContainText("Masque miroir");
    await impact.getByRole("button", { name: "Adapter les pas" }).click();
    // asked again for the mask alone: nothing left to adapt, only to do it anyway
    await expect(impact).toContainText("Ne peuvent pas suivre leurs cases");
    await expect(impact.getByRole("button", { name: "Adapter les pas" })).toHaveCount(0);
    await expect(impact.locator(".mini-row")).toHaveCount(0);
    await impact.getByRole("button", { name: "Le faire quand même" }).click();
    await expect.poll(() => canvasHeads(page)).toEqual(["bar-0:0", "bar-0:2", "bar-0:1", "bar-0:3"]);
    // the look that could follow did: forcing the mask did not shift it
    expect(((await api(page, "look.get", { id: "test-edit-look" })) as { technique: { steps: string[][] } }).technique.steps).toEqual([["#ff0000", "#0000ff", "#00ff00", "#ffffff"]]);
    await dialog.getByRole("button", { name: "Fermer" }).click();
  } finally {
    await api(page, "look.delete", { id: "test-edit-look", force: true });
    await api(page, "look.delete", { id: "test-edit-mirror", force: true });
    await api(page, "venue.canvas.delete", { id: "test-edit", force: true });
  }
  expect(errors.filter((e) => !e.includes("status of 400"))).toEqual([]);
});

test("canvas editor on a phone: the question about the looks shows on screen, takes the focus, and Escape cancels it", async ({ page }) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await api(page, "venue.canvas.put", { canvas: editableCanvas, force: true });
  await api(page, "look.put", { look: { id: "test-edit-look", name: "Pas exacts", canvas: "test-edit", technique: { kind: "pas", steps: [["#ff0000", "#00ff00", "#0000ff", "#ffffff"]] } } });
  try {
    const dialog = await openCanvasEditor(page);
    const cell = (i: number) => dialog.getByRole("listbox").getByRole("option").nth(i);
    await cell(1).click();
    await dialog.getByRole("button", { name: "Déplacer d'une case vers la fin" }).click();
    const impact = dialog.getByRole("alertdialog", { name: "Des looks sont touchés" });
    await expect(impact).toBeInViewport({ ratio: 0.9 });
    await expect(impact).toContainText("Pas exacts : 1 pas, chaque colonne suit sa case"); // said in words, not only drawn
    await expect(impact).toBeFocused(); // on the question, not on a button a key still on its way would press
    await expect(dialog.getByRole("button", { name: "Dupliquer" })).toBeDisabled(); // the gestures wait for the answer
    const [panel, preview] = [(await impact.boundingBox())!, (await impact.locator(".steps-compare").boundingBox())!];
    expect(panel.x + panel.width).toBeLessThanOrEqual(390);
    expect(preview.x + preview.width).toBeLessThanOrEqual(panel.x + panel.width);
    // a gesture meanwhile is held back and said, not lost in silence
    await page.keyboard.press("Escape");
    await expect(impact).toHaveCount(0);
    await expect(dialog).toBeVisible();
    expect(await canvasHeads(page)).toEqual(["bar-0:0", "bar-0:1", "bar-0:2", "bar-0:3"]);
    // adapted once « for the next gestures too »: the next move asks nothing
    await dialog.getByRole("button", { name: "Déplacer d'une case vers la fin" }).click();
    await impact.getByLabel(/Adapter aussi les pas aux gestes suivants/).check();
    await impact.getByRole("button", { name: "Adapter les pas" }).click();
    await expect.poll(() => canvasHeads(page)).toEqual(["bar-0:0", "bar-0:2", "bar-0:1", "bar-0:3"]);
    await dialog.getByRole("button", { name: "Déplacer d'une case vers la fin" }).click();
    await expect.poll(() => canvasHeads(page)).toEqual(["bar-0:0", "bar-0:2", "bar-0:3", "bar-0:1"]);
    await expect(impact).toHaveCount(0);
    expect(((await api(page, "look.get", { id: "test-edit-look" })) as { technique: { steps: string[][] } }).technique.steps).toEqual([["#ff0000", "#0000ff", "#ffffff", "#00ff00"]]);
    // undo: the canvas and the steps go back in one write
    await dialog.getByRole("button", { name: "Annuler" }).first().click();
    await expect.poll(() => canvasHeads(page)).toEqual(["bar-0:0", "bar-0:2", "bar-0:1", "bar-0:3"]);
    expect(((await api(page, "look.get", { id: "test-edit-look" })) as { technique: { steps: string[][] } }).technique.steps).toEqual([["#ff0000", "#0000ff", "#00ff00", "#ffffff"]]);
    await page.screenshot({ path: "test-results/canvas-editor-phone.png" });
    await dialog.getByRole("button", { name: "Fermer" }).click();
  } finally {
    await api(page, "look.delete", { id: "test-edit-look", force: true });
    await api(page, "venue.canvas.delete", { id: "test-edit", force: true });
  }
  expect(errors.filter((e) => !e.includes("status of 400"))).toEqual([]);
});

test("show page: between buttons, the last one started covers, or the highest value", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.locator("nav.pages").getByRole("button", { name: "Show", exact: true }).click();
  const merge = page.getByLabel("Entre les boutons");
  await expect(merge).toHaveValue("last"); // as before, by default
  await merge.selectOption("highest");
  await expect.poll(async () => ((await api(page, "show.settings")) as { looksMerge: string }).looksMerge).toBe("highest");
  await merge.selectOption("last"); // back for the other tests
  await expect.poll(async () => ((await api(page, "show.settings")) as { looksMerge: string }).looksMerge).toBe("last");
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

test("show page: looks group by folder, unfolded, and folding hides only its group", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const canvas = ((await api(page, "venue.canvas.list")) as { id: string }[])[0]!.id;
  const extra = [
    folderLook("grp-mac-0", "Méca 0", ["dossier:Machines"], canvas),
    folderLook("grp-mac-1", "Méca 1", ["dossier:Machines"], canvas),
    folderLook("grp-mac-2", "Méca 2", ["dossier:Machines"], canvas),
    folderLook("grp-chant-0", "Oratoire 0", ["dossier:Chants"], canvas),
    folderLook("grp-chant-1", "Oratoire 1", ["dossier:Chants"], canvas),
  ];
  for (const l of extra) await api(page, "look.put", { look: l });
  try {
    await page.locator("nav.pages").getByRole("button", { name: "Show", exact: true }).click();
    // one header per folder, sorted, « sans dossier » last, every group unfolded
    await expect(page.locator("tr.group-row button")).toHaveText(["▾ Chants (2)", "▾ Machines (3)", "▾ Sans dossier (5)"]);
    await expect(page.locator("button.look", { hasText: "Méca 2" })).toBeVisible();
    // folding one header hides only its own rows
    await page.locator("tr.group-row button", { hasText: "Machines (3)" }).click();
    await expect(page.locator("button.look", { hasText: "Méca 2" })).toBeHidden();
    await expect(page.locator("button.look", { hasText: "Oratoire 1" })).toBeVisible();
    await expect(page.locator("tr.group-row button", { hasText: "▸ Machines (3)" })).toBeVisible();
    await page.locator("tr.group-row button", { hasText: "Machines (3)" }).click();
    await expect(page.locator("button.look", { hasText: "Méca 2" })).toBeVisible();
    // the folder filter composes with the groups: only its group keeps rows, empty groups never render
    await page.getByLabel("Dossier").selectOption("Chants");
    await expect(page.locator("tr.group-row")).toHaveCount(1);
    await expect(page.locator("tr.group-row button", { hasText: "Chants (2)" })).toBeVisible();
    await expect(page.locator("button.look", { hasText: "Méca 0" })).toBeHidden();
    await page.getByLabel("Dossier").selectOption("");
    // the search as well: one matching row, one group, no phantom header for an empty one
    await page.getByRole("searchbox", { name: "Chercher un look" }).fill("méca 1");
    await expect(page.locator("tr.group-row")).toHaveCount(1);
    await expect(page.locator("tr.group-row button", { hasText: "Machines (1)" })).toBeVisible();
  } finally {
    for (const l of extra) await api(page, "look.delete", { id: l.id, force: true });
  }
  expect(errors).toEqual([]);
});

test("show page: a right-click moves a look to another folder", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const canvas = ((await api(page, "venue.canvas.list")) as { id: string }[])[0]!.id;
  const extra = [
    folderLook("men-mac-0", "Méca 0", ["dossier:Machines"], canvas),
    folderLook("men-mac-1", "Méca 1", ["dossier:Machines"], canvas),
    folderLook("men-chant-0", "Oratoire 0", ["dossier:Chants"], canvas),
  ];
  for (const l of extra) await api(page, "look.put", { look: l });
  try {
    await page.locator("nav.pages").getByRole("button", { name: "Show", exact: true }).click();
    await page.locator("button.look", { hasText: "Méca 0" }).click({ button: "right" });
    const menu = page.getByRole("dialog", { name: "Look", exact: true });
    await expect(menu).toBeVisible();
    // the menu stays open, like the other actions, and the select follows the moved look
    await menu.getByRole("combobox", { name: "Dossier" }).selectOption("Chants");
    await expect(menu.getByRole("combobox", { name: "Dossier" })).toHaveValue("Chants");
    await expect.poll(async () => ((await api(page, "look.get", { id: "men-mac-0" })) as { tags: string[] }).tags).toEqual(["dossier:Chants"]);
    await page.keyboard.press("Escape");
    await expect(page.locator("tr.group-row button", { hasText: "Machines (1)" })).toBeVisible();
    await expect(page.locator("tr.group-row button", { hasText: "Chants (2)" })).toBeVisible();
    // the folder tag is not repeated on the row: the header shows it
    await expect(page.locator("tr", { hasText: "Méca 0" }).locator("td small")).not.toContainText("dossier");
  } finally {
    for (const l of extra) await api(page, "look.delete", { id: l.id, force: true });
  }
  expect(errors).toEqual([]);
});

test("show page: the editor's folder field survives the tags field, and creates a folder", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const canvas = ((await api(page, "venue.canvas.list")) as { id: string }[])[0]!.id;
  await api(page, "look.put", { look: folderLook("edn-solo", "Soliste", ["dossier:Machines"], canvas) });
  try {
    await page.locator("nav.pages").getByRole("button", { name: "Show", exact: true }).click();
    await page.getByLabel("Modifier Soliste").click();
    const dialog = page.getByRole("dialog", { name: "Soliste" });
    const folderField = dialog.getByLabel("Dossier", { exact: true });
    await expect(folderField).toHaveValue("Machines");
    await expect(folderField).toHaveAttribute("list", "look-folder-suggestions");
    // the folder can be picked from the known ones (nested paths included), and typing follows both ways
    const chooser = dialog.getByLabel("Choisir un dossier");
    await expect(chooser).toHaveValue("Machines");
    await folderField.fill("Rigging"); // a folder is created by typing it
    await expect(chooser).toHaveValue("Rigging");
    // typing tags and blurring must not erase the folder typed just before
    await dialog.getByLabel("tags").fill("libre");
    await dialog.getByLabel("tags").press("Tab");
    await dialog.getByRole("button", { name: "Enregistrer", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator("tr.group-row button", { hasText: "Rigging (1)" })).toBeVisible();
    // the free tags are kept, the folder tag is not repeated on the row
    await expect(page.locator("tr", { hasText: "Soliste" }).locator("td small")).toContainText("libre");
    await expect(page.locator("tr", { hasText: "Soliste" }).locator("td small")).not.toContainText("dossier");
    const saved = ((await api(page, "look.get", { id: "edn-solo" })) as { tags: string[] }).tags;
    expect(saved.filter((g) => g.startsWith("dossier:"))).toEqual(["dossier:Rigging"]);
    expect(saved).toContain("libre");
  } finally {
    await api(page, "look.delete", { id: "edn-solo", force: true });
  }
  expect(errors).toEqual([]);
});

test("show page: an empty or doubled folder tag counts for nothing, the first folder wins", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const canvas = ((await api(page, "venue.canvas.list")) as { id: string }[])[0]!.id;
  const extra = [
    folderLook("dbl-a", "Double A", ["dossier:", "dossier:Machines", "dossier:Machines"], canvas),
    folderLook("dbl-b", "Double B", ["dossier:Chants", "dossier:Machines"], canvas),
    folderLook("dbl-mac-0", "Méca 0", ["dossier:Machines"], canvas),
    folderLook("dbl-mac-1", "Méca 1", ["dossier:Machines"], canvas),
  ];
  for (const l of extra) await api(page, "look.put", { look: l });
  try {
    await page.locator("nav.pages").getByRole("button", { name: "Show", exact: true }).click();
    // the empty tag makes no group and no option; deduped, sorted, « sans dossier » last
    await expect(page.locator("tr.group-row button")).toHaveText(["▾ Chants (1)", "▾ Machines (3)", "▾ Sans dossier (5)"]);
    const folders = await page.getByLabel("Dossier").locator("option").evaluateAll((os) => os.map((o) => (o as unknown as { value: string }).value));
    expect(folders).toEqual(["", "Chants", "Machines"]);
    // a double-folder look stands once, under its first folder
    await page.locator("tr.group-row button", { hasText: "Chants (1)" }).click();
    await expect(page.locator("button.look", { hasText: "Double B" })).toBeHidden();
    await page.locator("tr.group-row button", { hasText: "Chants (1)" }).click();
    await expect(page.locator("button.look", { hasText: "Double B" })).toBeVisible();
    // the filter follows the first folder too: « Machines » does not surface « Double B »
    await page.getByLabel("Dossier").selectOption("Machines");
    await expect(page.getByRole("heading", { name: /Looks \(3 \/ 9\)/ })).toBeVisible();
    await expect(page.locator("button.look", { hasText: "Double B" })).toBeHidden();
    await page.getByLabel("Dossier").selectOption("");
    // the first pass of the menu rewrites those tags to a single dossier tag
    await page.locator("button.look", { hasText: "Double A" }).click({ button: "right" });
    const menu = page.getByRole("dialog", { name: "Look", exact: true });
    await menu.getByRole("combobox", { name: "Dossier" }).selectOption("Chants");
    await expect.poll(async () => ((await api(page, "look.get", { id: "dbl-a" })) as { tags: string[] }).tags).toEqual(["dossier:Chants"]);
    await page.keyboard.press("Escape");
  } finally {
    for (const l of extra) await api(page, "look.delete", { id: l.id, force: true });
  }
  expect(errors).toEqual([]);
});

test("show page: picked looks drag together onto a folder header", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const canvas = ((await api(page, "venue.canvas.list")) as { id: string }[])[0]!.id;
  const extra = [
    folderLook("drag-a", "Trapeze 0", ["dossier:Rigging"], canvas),
    folderLook("drag-b", "Trapeze 1", ["dossier:Rigging"], canvas),
  ];
  for (const l of extra) await api(page, "look.put", { look: l });
  try {
    await page.locator("nav.pages").getByRole("button", { name: "Show", exact: true }).click();
    // ⌘/Ctrl picks two looks of the same folder (a click without modifiers launches and selects nothing)
    await page.locator("button.look", { hasText: "Trapeze 0" }).click({ modifiers: ["ControlOrMeta"] });
    await page.locator("button.look", { hasText: "Trapeze 1" }).click({ modifiers: ["ControlOrMeta"] });
    // dragged together onto the « sans dossier » header right below (the drop target must be on screen: elementFromPoint knows the viewport only)
    const source = page.locator("button.look", { hasText: "Trapeze 1" });
    const header = page.locator('tr.group-row[data-folder=""]');
    await header.scrollIntoViewIfNeeded();
    const from = (await source.boundingBox())!;
    const to = (await header.boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
    // the ghost label follows the pointer: counted when several looks are carried
    await expect(page.locator(".drag-ghost")).toContainText("2 looks");
    await expect(header).toHaveClass(/drop/);
    await page.mouse.up();
    await expect.poll(async () => folderTags(((await api(page, "look.get", { id: "drag-a" })) as { tags: string[] }).tags)).toEqual([]);
    await expect.poll(async () => folderTags(((await api(page, "look.get", { id: "drag-b" })) as { tags: string[] }).tags)).toEqual([]);
    // the last folder empty, the table is flat again: not one group row
    await expect(page.locator("tr.group-row")).toHaveCount(0);
    await expect(page.locator("button.look", { hasText: "Trapeze 1" })).toBeVisible();
  } finally {
    for (const l of extra) await api(page, "look.delete", { id: l.id, force: true });
  }
  expect(errors).toEqual([]);
});

test("show page: a look's menu creates a folder and goes straight into it", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const canvas = ((await api(page, "venue.canvas.list")) as { id: string }[])[0]!.id;
  await api(page, "look.put", { look: folderLook("new-mc", "Méca 0", ["dossier:Machines"], canvas) });
  try {
    await page.locator("nav.pages").getByRole("button", { name: "Show", exact: true }).click();
    await page.locator("button.look", { hasText: "Méca 0" }).click({ button: "right" });
    const menu = page.getByRole("dialog", { name: "Look", exact: true });
    await menu.getByRole("textbox", { name: "Nouveau dossier…" }).fill("Véranda");
    await menu.screenshot({ path: "test-results/folder-menu.png" });
    await menu.getByRole("button", { name: "Nouveau dossier…" }).click();
    await expect(menu.getByRole("textbox", { name: "Nouveau dossier…" })).toHaveValue(""); // the field clears
    await expect.poll(async () => ((await api(page, "look.get", { id: "new-mc" })) as { tags: string[] }).tags).toEqual(["dossier:Véranda"]);
    await expect(page.locator("tr.group-row button", { hasText: "Véranda (1)" })).toBeVisible();
    await page.keyboard.press("Escape");
  } finally {
    await api(page, "look.delete", { id: "new-mc", force: true });
  }
  expect(errors).toEqual([]);
});

test("show page: the looks bar creates a folder, empty or from the picked looks", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const canvas = ((await api(page, "venue.canvas.list")) as { id: string }[])[0]!.id;
  const extra = [folderLook("bar-a", "Trapeze 0", [], canvas), folderLook("bar-b", "Trapeze 1", [], canvas)];
  for (const l of extra) await api(page, "look.put", { look: l });
  try {
    await page.locator("nav.pages").getByRole("button", { name: "Show", exact: true }).click();
    // the ✔ stays disabled while the name is empty
    await page.getByRole("button", { name: "📁 Nouveau dossier…" }).click();
    const bar = page.locator(".folder-create");
    await expect(bar.getByRole("button", { name: "Enregistrer", exact: true })).toBeDisabled();
    // bare-handed, a validation names the folder: it is born empty and its header waits for drops
    await bar.getByRole("combobox", { name: "Nouveau dossier…" }).fill("Génie");
    await bar.getByRole("button", { name: "Enregistrer", exact: true }).click();
    await expect(bar).toBeHidden();
    await expect(page.locator("tr.group-row button", { hasText: "Génie (0)" })).toBeVisible();
    // picked looks follow: the hint counts them, one validation files them in
    await page.getByRole("button", { name: "📁 Nouveau dossier…" }).click();
    await expect(bar).toBeVisible();
    await page.locator("button.look", { hasText: "Trapeze 0" }).click({ modifiers: ["ControlOrMeta"] });
    await page.locator("button.look", { hasText: "Trapeze 1" }).click({ modifiers: ["ControlOrMeta"] });
    await expect(bar).toContainText("2 look(s)");
    await bar.getByRole("combobox", { name: "Nouveau dossier…" }).fill("Trappe");
    await bar.getByRole("button", { name: "Enregistrer", exact: true }).click();
    await expect(bar).toBeHidden();
    await expect.poll(async () => folderTags(((await api(page, "look.get", { id: "bar-a" })) as { tags: string[] }).tags)).toEqual(["dossier:Trappe"]);
    await expect.poll(async () => folderTags(((await api(page, "look.get", { id: "bar-b" })) as { tags: string[] }).tags)).toEqual(["dossier:Trappe"]);
    await expect(page.locator("tr.group-row button", { hasText: "Trappe (2)" })).toBeVisible();
  } finally {
    for (const l of extra) await api(page, "look.delete", { id: l.id, force: true });
    await api(page, "show.folder.delete", { folder: "Génie", force: true });
  }
  expect(errors).toEqual([]);
});

test("show page: Ctrl+click on a mac selects instead of opening the menu", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const canvas = ((await api(page, "venue.canvas.list")) as { id: string }[])[0]!.id;
  await api(page, "look.put", { look: folderLook("mctrl", "Orchidée", [], canvas) });
  try {
    await page.locator("nav.pages").getByRole("button", { name: "Show", exact: true }).click();
    // Ctrl+click is a right-click for the browser: here it selects, like ⌘ does
    await page.locator("button.look", { hasText: "Orchidée" }).click({ modifiers: ["Control"] });
    await expect(page.getByRole("dialog")).toHaveCount(0); // no look menu opened
    await expect(page.locator("tr", { hasText: "Orchidée" })).toHaveClass(/selected/);
    // a true right-click still opens the look's menu
    await page.locator("button.look", { hasText: "Orchidée" }).click({ button: "right" });
    await expect(page.getByRole("dialog", { name: "Look", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
  } finally {
    await api(page, "look.delete", { id: "mctrl", force: true });
  }
  expect(errors).toEqual([]);
});

test("show page: folders nest by path, from the menu and by dragging a header onto another", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const canvas = ((await api(page, "venue.canvas.list")) as { id: string }[])[0]!.id;
  const extra = [folderLook("nest-a", "Trapeze 0", ["dossier:Nid"], canvas), folderLook("nest-b", "Mousse", [], canvas)];
  for (const l of extra) await api(page, "look.put", { look: l });
  await api(page, "show.folder.create", { folder: "Bois" });
  try {
    await page.locator("nav.pages").getByRole("button", { name: "Show", exact: true }).click();
    // a sub-folder is created from the header's menu, with the parent's name ready before the last segment
    await page.locator("tr.group-row[data-folder=Nid]").click({ button: "right" });
    const menu = page.getByRole("dialog", { name: "Dossier", exact: true });
    await menu.getByRole("button", { name: "➕ Sous-dossier" }).click();
    const field = menu.getByRole("textbox", { name: "➕ Sous-dossier" });
    await expect(field).toHaveValue("Nid/");
    await field.fill("Nid/Oeuf");
    await field.press("Enter");
    await expect(menu).toBeHidden();
    await expect.poll(async () => ((await api(page, "show.settings")) as { folders: string[] }).folders).toContain("Nid/Oeuf");
    await expect(page.locator("tr.group-row button", { hasText: "Oeuf (0)" })).toBeVisible();
    // a look dropped on the sub-header takes the whole path, and the parent counts its subtree
    const source = page.locator("button.look", { hasText: "Trapeze 0" });
    const target = page.locator('tr.group-row[data-folder="Nid/Oeuf"]');
    const from = (await source.boundingBox())!;
    const to = (await target.boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
    await expect(target).toHaveClass(/drop/);
    await page.mouse.up();
    await expect.poll(async () => folderTags(((await api(page, "look.get", { id: "nest-a" })) as { tags: string[] }).tags)).toEqual(["dossier:Nid/Oeuf"]);
    // the row says where it stands without a label: the member tint marks what the folder holds
    await expect(page.locator("tr", { hasText: "Trapeze 0" })).toHaveClass(/member/);
    await expect(page.locator("tr.group-row button", { hasText: "Nid (1)" })).toBeVisible();
    await page.screenshot({ path: "test-results/folder-tree.png" }); // the tree look, to review
    await expect(page.locator("tr.group-row button", { hasText: "Oeuf (1)" })).toBeVisible();
    // folding the parent folds its whole branch
    await page.locator("tr.group-row button", { hasText: "Nid (1)" }).click();
    await expect(page.locator("button.look", { hasText: "Trapeze 0" })).toBeHidden();
    await expect(page.locator("tr.group-row button", { hasText: "Oeuf (1)" })).toBeHidden();
    await page.locator("tr.group-row button", { hasText: "Nid (1)" }).click();
    // a folder header dragged onto another nests it, looks along
    const carried = page.locator('tr.group-row[data-folder="Nid/Oeuf"]');
    const home = page.locator("tr.group-row[data-folder=Bois]");
    const from2 = (await carried.boundingBox())!;
    const to2 = (await home.boundingBox())!;
    await page.mouse.move(from2.x + from2.width / 2, from2.y + from2.height / 2);
    await page.mouse.down();
    await page.mouse.move(to2.x + to2.width / 2, to2.y + to2.height / 2, { steps: 8 });
    await expect(home).toHaveClass(/drop/);
    await page.mouse.up();
    await expect.poll(async () => folderTags(((await api(page, "look.get", { id: "nest-a" })) as { tags: string[] }).tags)).toEqual(["dossier:Bois/Oeuf"]);
    await expect(page.locator("tr.group-row button", { hasText: "Bois (1)" })).toBeVisible();
    await expect(page.locator("tr.group-row[data-folder=Nid]")).toHaveCount(0); // the emptied parent was not named: it vanishes
    // a look dropped on another look files into that look's folder, the row lighting as its target
    // (hover() brings the pointer on each side itself: bounding boxes go stale under every scroll)
    const bare = page.locator("button.look", { hasText: "Mousse" });
    const member = page.locator("tr[data-look=nest-a]");
    await bare.hover();
    await page.mouse.down();
    await member.hover();
    await expect(member).toHaveClass(/drop-row/);
    await page.mouse.up();
    await expect.poll(async () => folderTags(((await api(page, "look.get", { id: "nest-b" })) as { tags: string[] }).tags)).toEqual(["dossier:Bois/Oeuf"]);
  } finally {
    for (const l of extra) await api(page, "look.delete", { id: l.id, force: true });
    for (const f of ["Bois", "Nid"]) await api(page, "show.folder.delete", { folder: f, force: true });
  }
  expect(errors).toEqual([]);
});

test("show page: a folder header is renamed or disbanded from its menu", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const canvas = ((await api(page, "venue.canvas.list")) as { id: string }[])[0]!.id;
  const extra = [folderLook("head-a", "Méca 0", ["dossier:Machines"], canvas), folderLook("head-b", "Méca 1", ["dossier:Machines"], canvas)];
  for (const l of extra) await api(page, "look.put", { look: l });
  try {
    await page.locator("nav.pages").getByRole("button", { name: "Show", exact: true }).click();
    const menu = page.getByRole("dialog", { name: "Dossier", exact: true });
    // rename: the tag is rewritten on every look of the folder
    await page.locator("tr.group-row[data-folder=Machines]").click({ button: "right" });
    await menu.getByRole("button", { name: "Renommer" }).click();
    const field = menu.getByRole("textbox", { name: "Renommer" });
    await expect(field).toHaveValue("Machines");
    await field.fill("Atelier");
    await field.press("Enter");
    await expect(menu).toBeHidden();
    await expect.poll(async () => folderTags(((await api(page, "look.get", { id: "head-b" })) as { tags: string[] }).tags)).toEqual(["dossier:Atelier"]);
    // disband: its looks go back « sans dossier », confirmed like a delete
    await page.locator("tr.group-row[data-folder=Atelier]").click({ button: "right" });
    page.once("dialog", (d) => void d.accept());
    await menu.getByRole("button", { name: "Dissoudre" }).click();
    await expect(menu).toBeHidden();
    await expect.poll(async () => folderTags(((await api(page, "look.get", { id: "head-a" })) as { tags: string[] }).tags)).toEqual([]);
    // the last folder gone, the table is flat again: not one group row
    await expect(page.locator("tr.group-row")).toHaveCount(0);
    await expect(page.locator("button.look", { hasText: "Méca 1" })).toBeVisible();
  } finally {
    for (const l of extra) await api(page, "look.delete", { id: l.id, force: true });
  }
  expect(errors).toEqual([]);
});

test("show page: a parent folder with no look of its own still has its menu", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const canvas = ((await api(page, "venue.canvas.list")) as { id: string }[])[0]!.id;
  const deep = folderLook("deep-a", "Profond", ["dossier:Haut/Bas"], canvas);
  await api(page, "look.put", { look: deep });
  try {
    await page.locator("nav.pages").getByRole("button", { name: "Show", exact: true }).click();
    const menu = page.getByRole("dialog", { name: "Dossier", exact: true });
    // « Haut » only exists as the parent of « Haut/Bas »: its header opens the menu all the same
    await page.locator("tr.group-row[data-folder=Haut]").click({ button: "right" });
    await menu.getByRole("button", { name: "Renommer" }).click();
    const field = menu.getByRole("textbox", { name: "Renommer" });
    await field.fill("Sommet");
    await field.press("Enter");
    await expect(menu).toBeHidden();
    await expect.poll(async () => folderTags(((await api(page, "look.get", { id: "deep-a" })) as { tags: string[] }).tags)).toEqual(["dossier:Sommet/Bas"]);
  } finally {
    await api(page, "look.delete", { id: deep.id, force: true });
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

// ---- show check: information notes and type groups on proposal (T22)
test("show check: notes come last, and a type group is created only on a click, fixed or live", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  for (const [id, address] of [["head-a", 200], ["head-b", 300]] as const) await api(page, "venue.fixture.put", { fixture: { id, name: id, manufacturer: "Test", model: "Spot 7", mode: "Standard", universe: 2, address } });
  try {
    await page.locator("nav.pages").getByRole("button", { name: "Show", exact: true }).click();
    await page.getByRole("button", { name: "Vérifier le show" }).click();
    const report = page.locator(".lint-report");
    await expect(report.locator("strong")).toContainText(/ℹ \d+ information\(s\)/);
    await expect(report.locator("li.hint", { hasText: "sans position sur la scène" }).first()).toBeVisible();
    // a note is grey, not the colour of a warning
    const muted = (await page.evaluate(`(() => { const p = document.createElement("span"); p.style.color = "var(--muted)"; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; })()`)) as string;
    await expect(report.locator("li.hint").first()).toHaveCSS("color", muted);
    const proposal = report.getByRole("region", { name: "Groupes par type proposés" });
    await expect(proposal).toContainText("Les étiquettes restent en français"); // the help is written, not only hovered
    await expect(proposal.locator("p.hint", { hasText: "Coché : le groupe suit l'étiquette" })).toHaveCount(1); // once, not under each group
    const lyres = proposal.locator("li", { has: page.locator("span.name", { hasText: /^Lyres$/ }) });
    await expect(lyres).toContainText("3 projecteur(s)");
    await expect(lyres).toContainText("head-a, head-b"); // the fixtures, by name, before the click
    expect(((await api(page, "group.list")) as { id: string }[]).some((g) => g.id === "type-lyre")).toBe(false); // nothing written yet
    // a group gathering them by tag: nothing to propose, read again on each check
    await api(page, "group.put", { group: { id: "mes-lyres", name: "Mes lyres", selector: { tags: ["lyre"] } } });
    await page.getByRole("button", { name: "Vérifier le show" }).click();
    await expect(lyres).toHaveCount(0);
    await api(page, "group.delete", { id: "mes-lyres", force: true });
    // a group of the user's that selects by the tag and another: the change is said before the click
    await api(page, "group.put", { group: { id: "lyres-face", name: "Lyres de face", selector: { tags: ["lyre", "face"] } } });
    const headA = ((await api(page, "venue.fixture.list")) as { id: string }[]).find((f) => f.id === "head-a")!;
    await api(page, "venue.fixture.put", { fixture: { ...headA, tags: ["face"] } });
    await page.getByRole("button", { name: "Vérifier le show" }).click();
    await expect(lyres).toContainText("change aussi : « Lyres de face » +1");
    const live = lyres.getByLabel("mettre à jour automatiquement");
    await expect(live).toBeChecked(); // a live group by tag unless unticked
    await live.uncheck();
    await expect(lyres).not.toContainText("change aussi"); // a fixed list adds no tag
    await lyres.getByRole("button", { name: "Créer le groupe" }).click();
    await expect(lyres).toHaveCount(0); // gathered now: no longer proposed
    const group = ((await api(page, "group.list")) as { id: string; selector?: unknown; members: { fixtures: string[] } }[]).find((g) => g.id === "type-lyre")!;
    expect(group.selector).toBeUndefined();
    expect(group.members.fixtures.sort()).toEqual(["head-a", "head-b", "spot"]);
    // the groups table says what a live group follows and gathers, not « — »
    await api(page, "group.put", { group: { id: "lyres-tag", name: "Lyres par étiquette", selector: { tags: ["face"] } } });
    await page.reload();
    await page.locator("nav.pages").getByRole("button", { name: "Show", exact: true }).click();
    await expect(page.locator("table.listing tr", { hasText: "Lyres par étiquette" })).toContainText("suit face · 1 fixtures");
  } finally {
    for (const id of ["type-lyre", "lyres-face", "lyres-tag", "mes-lyres"]) await api(page, "group.delete", { id, force: true }).catch(() => undefined);
    for (const id of ["head-a", "head-b"]) await api(page, "venue.fixture.delete", { id });
  }
  expect(errors).toEqual([]);
});

test("show check: a type group applied while the check fails says why and reads the proposal again", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  for (const [id, address] of [["head-c", 200], ["head-d", 300]] as const) await api(page, "venue.fixture.put", { fixture: { id, name: id, manufacturer: "Test", model: "Spot 7", mode: "Standard", universe: 2, address } });
  try {
    await page.locator("nav.pages").getByRole("button", { name: "Show", exact: true }).click();
    await page.getByRole("button", { name: "Vérifier le show" }).click();
    const proposal = page.locator(".lint-report").getByRole("region", { name: "Groupes par type proposés" });
    const lyres = proposal.locator("li", { has: page.locator("span.name", { hasText: /^Lyres$/ }) });
    await expect(lyres).toHaveCount(1);
    // the check after the click fails: its error is said, and the proposal does not keep the group just made
    await page.route("**/api/plugins/light/commands/show.lint", (route) => route.fulfill({ status: 500, json: { ok: false, error: "vérification en échec pour le test" } }));
    await lyres.getByRole("button", { name: "Créer le groupe" }).click();
    await expect(page.locator(".error", { hasText: "vérification en échec pour le test" })).toBeVisible();
    await expect(lyres).toHaveCount(0);
  } finally {
    await page.unroute("**/api/plugins/light/commands/show.lint");
    await api(page, "group.delete", { id: "type-lyre", force: true }).catch(() => undefined);
    for (const id of ["head-c", "head-d"]) await api(page, "venue.fixture.delete", { id });
  }
  expect(errors.filter((e) => !e.includes("500"))).toEqual([]);
});

test("venue: a show whose settings cannot be read is named above the patch", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.route("**/api/plugins/light/commands/venue.list", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { result: object[] };
    body.result = body.result.map((r) => ({ ...r, warning: "réglages illisibles (show.json), show laissé hors des lieux : abime (Unexpected token)" }));
    await route.fulfill({ response: res, json: body });
  });
  await page.locator("nav.pages").getByRole("button", { name: "Lieu" }).click();
  await expect(page.locator(".venue > p.warn[role=status]")).toContainText("abime");
  await page.unroute("**/api/plugins/light/commands/venue.list");
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

test("venue: a shared venue says so, asks before deleting a fixture, and detaches", async ({ page, request }) => {
  const errors = watchErrors(page);
  // setup and cleanup with the master token, outside the page
  const call = async (name: string, args: unknown = {}) =>
    ((await (await request.post(`/api/plugins/light/commands/${name}`, { headers: { authorization: "Bearer ui-test-token" }, data: args })).json()) as { result: unknown }).result;
  const shows = (await call("show.list")) as { id: string; venue: string; active: boolean }[];
  const open = shows.find((s) => s.active)!;
  await login(page);
  await page.locator("nav.pages").getByRole("button", { name: "Lieu" }).click();
  const banner = page.locator(".venue p.hint", { hasText: "Ce lieu est partagé" });
  await expect(page.locator("#venue-patch tr").first()).toBeVisible();
  await expect(banner).toHaveCount(0);
  // another show on the same venue, not opened: the page hears it and says so
  const other = (await call("show.create", { name: "Show partagé", venue: "current", open: false })) as { id: string };
  try {
    await expect(banner).toContainText("Show partagé");
    await call("venue.fixture.put", { fixture: { id: "spare", name: "Spare", manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 2, address: 400 } });
    const del = page.locator("#venue-patch tr", { hasText: "Spare" }).getByRole("button", { name: "Supprimer Spare" });
    let asked = "";
    page.once("dialog", (d) => ((asked = d.message()), void d.dismiss()));
    await del.click();
    await expect.poll(() => asked).toContain("Show partagé"); // asked after show.references answered
    expect(asked).toContain("Installé pour ce show");
    await expect(page.locator("#venue-patch tr", { hasText: "Spare" })).toHaveCount(1); // dismissed: kept
    page.once("dialog", (d) => void d.accept());
    await del.click();
    await expect(page.locator("#venue-patch tr", { hasText: "Spare" })).toHaveCount(0);
    // detach: the open show gets its own copy (same show, no reload), its patch kept; the banner goes
    page.once("dialog", (d) => void d.accept());
    await banner.getByRole("button", { name: "Dissocier" }).click();
    await expect(banner).toHaveCount(0);
    await expect(page.locator("#venue-patch tr", { hasText: "Bar 0" })).toHaveCount(1);
    const venues = (await call("venue.list")) as { id: string; shows: string[]; active: boolean }[];
    expect(venues.find((v) => v.active)!.id).not.toBe(open.venue);
    expect(venues.find((v) => v.id === open.venue)!.shows).toEqual([other.id]);
  } finally {
    // back on the first venue (same show: no reload), whatever step failed
    await call("venue.fixture.delete", { id: "spare", force: true });
    await call("show.venue.set", { venue: open.venue });
    await call("show.delete", { id: other.id });
  }
  expect(errors).toEqual([]);
});

test("venue: right-click a fixture to rename it and give it a marker colour", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.locator("nav.pages").getByRole("button", { name: "Lieu" }).click();
  try {
    await page.locator("tr", { hasText: "Bar 1" }).click({ button: "right" });
    const menu = page.getByRole("dialog", { name: "Réglages de l'appareil" });
    await expect(menu).toContainText("Bar 1 · U1.16");
    await menu.getByRole("radio", { name: "vert" }).click();
    await menu.getByLabel("Nom").fill("Barre jardin");
    await menu.getByLabel("Nom").press("Enter");
    await expect(menu).toHaveCount(0);
    const row = page.locator("tr", { hasText: "Barre jardin" });
    await expect(row.locator(".swatch-dot")).toHaveCSS("background-color", "rgb(34, 197, 94)");
    await page.screenshot({ path: "test-results/venue-fixture-menu.png" });
    // the same colour where its channels are picked (a channel fader's tree, page Show)
    const channels = (await api(page, "venue.fixture.channels")) as { id: string; name: string; color?: string }[];
    expect(channels.find((f) => f.id === "bar-1")).toMatchObject({ name: "Barre jardin", color: "#22c55e" });
  } finally {
    await api(page, "venue.fixture.mark", { id: "bar-1", name: "Bar 1", color: null });
  }
  expect(errors).toEqual([]);
});

test("venue: moving a fixture from its menu shows the overlap on both fixtures, and clears it once moved back", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.locator("nav.pages").getByRole("button", { name: "Lieu" }).click();
  try {
    await page.locator("tr", { hasText: "Bar 1" }).click({ button: "right" });
    const menu = page.getByRole("dialog", { name: "Réglages de l'appareil" });
    await expect(menu.getByRole("alert")).toHaveCount(0);
    await menu.getByLabel("Adresse DMX").fill("10");
    await menu.getByRole("button", { name: "Déplacer" }).click();
    // the menu names the other fixture, and the patch flags both
    await expect(menu).toContainText("Bar 1 · U1.10");
    await expect(menu.getByRole("alert")).toContainText("Bar 0");
    await expect(page.locator("tr", { hasText: "Bar 0" }).locator(".badge.conflict")).toHaveCount(1);
    await expect(page.locator("tr", { hasText: "Bar 1" }).locator(".badge.conflict")).toHaveCount(1);
    // the rest of the fixture is written back whole: its role and mode stay
    const moved = ((await api(page, "venue.fixture.list")) as { id: string; address: number; mode: string }[]).find((f) => f.id === "bar-1")!;
    expect(moved).toMatchObject({ address: 10, mode: "15 Channel" });
    await menu.getByLabel("Adresse DMX").fill("16");
    await menu.getByRole("button", { name: "Déplacer" }).click();
    await expect(menu.getByRole("alert")).toHaveCount(0);
    await expect(page.locator("#venue-patch .badge.conflict")).toHaveCount(0); // the rules panel has its own (a locked rule)
  } finally {
    const f = ((await api(page, "venue.fixture.list")) as Record<string, unknown>[]).find((x) => x.id === "bar-1")!;
    await api(page, "venue.fixture.put", { fixture: { ...f, address: 16 } });
  }
  expect(errors).toEqual([]);
});

test("venue: a fixture is deleted from its menu or the ✕ through the same confirmation, naming where it is used", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const spare = (id: string, address: number) => ({ id, name: id, manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 2, address });
  await api(page, "venue.fixture.put", { fixture: spare("menu-del", 300) });
  await api(page, "venue.fixture.put", { fixture: spare("cross-del", 400) });
  await api(page, "fader.put", { fader: { id: "del-fader", name: "Fader suppression", channels: [{ fixture: "menu-del", offset: 0 }, { fixture: "cross-del", offset: 0 }], level: 0 } });
  await page.locator("nav.pages").getByRole("button", { name: "Lieu" }).click();
  try {
    // from the menu: dismissed, the fixture stays; accepted, it goes, forced after the informed yes
    await page.locator("tr", { hasText: "menu-del" }).click({ button: "right" });
    let asked = "";
    page.once("dialog", (d) => ((asked = d.message()), void d.dismiss()));
    await page.getByRole("dialog", { name: "Réglages de l'appareil" }).getByRole("button", { name: "Supprimer", exact: true }).click();
    await expect.poll(() => asked).toContain("fader de canaux « Fader suppression »");
    expect(asked).toContain("encore utilisé");
    await expect(page.locator("tr", { hasText: "menu-del" })).toHaveCount(1);
    await expect(page.getByRole("dialog", { name: "Réglages de l'appareil" })).toHaveCount(1); // cancelled: the menu stays
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("dialog", { name: "Réglages de l'appareil" }).getByRole("button", { name: "Supprimer", exact: true }).click();
    await expect(page.locator("tr", { hasText: "menu-del" })).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "Réglages de l'appareil" })).toHaveCount(0);
    // from the ✕: the same question
    asked = "";
    page.once("dialog", (d) => ((asked = d.message()), void d.accept()));
    await page.locator("tr", { hasText: "cross-del" }).getByRole("button", { name: "Supprimer cross-del" }).click();
    await expect(page.locator("tr", { hasText: "cross-del" })).toHaveCount(0);
    expect(asked).toContain("fader de canaux « Fader suppression »");
    expect(asked).toContain("Le supprimer quand même");
  } finally {
    await api(page, "fader.delete", { id: "del-fader", force: true });
    await api(page, "venue.fixture.delete", { id: "menu-del", force: true });
    await api(page, "venue.fixture.delete", { id: "cross-del", force: true });
  }
  expect(errors).toEqual([]);
});

test("venue: a fixture delete refused because another show cannot be read is offered forced, after a second yes", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await api(page, "venue.fixture.put", { fixture: { id: "unchecked-del", name: "unchecked-del", manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 2, address: 300 } });
  // the server's refusal when another show.json of the venue is damaged (the test server has none such)
  const sent: unknown[] = [];
  await page.route("**/api/plugins/light/commands/venue.fixture.delete", async (route) => {
    const args = route.request().postDataJSON() as { force?: boolean };
    sent.push(args);
    if (args.force) return route.continue();
    await route.fulfill({ status: 400, json: { ok: false, error: "les réglages du show « abime » sont illisibles (show.json). Le supprimer quand même, sans vérifier les autres shows de ce lieu : force: true", detail: { force: true, reason: "les réglages du show « abime » sont illisibles (show.json)" } } });
  });
  await page.locator("nav.pages").getByRole("button", { name: "Lieu" }).click();
  const menu = page.getByRole("dialog", { name: "Réglages de l'appareil" });
  try {
    await page.locator("tr", { hasText: "unchecked-del" }).click({ button: "right" });
    const asked: string[] = [];
    // first yes (the usual question), then a no to the second: nothing forced, the fixture stays
    page.once("dialog", (d) => (asked.push(d.message()), void d.accept().then(() => page.once("dialog", (d2) => (asked.push(d2.message()), void d2.dismiss())))));
    await menu.getByRole("button", { name: "Supprimer", exact: true }).click();
    await expect.poll(() => asked.length).toBe(2);
    expect(asked[1]).toContain("« abime » sont illisibles");
    expect(asked[1]).toContain("n'ont pas pu être vérifiés");
    expect(asked[1]).not.toContain("force: true"); // the AI's wording stays out of the question
    await expect(page.locator("tr", { hasText: "unchecked-del" })).toHaveCount(1);
    expect(sent).toEqual([{ id: "unchecked-del", force: false }]);
    // yes twice: forced
    page.once("dialog", (d) => void d.accept().then(() => page.once("dialog", (d2) => void d2.accept())));
    await menu.getByRole("button", { name: "Supprimer", exact: true }).click();
    await expect(page.locator("tr", { hasText: "unchecked-del" })).toHaveCount(0);
    expect(sent.at(-1)).toEqual({ id: "unchecked-del", force: true });
    await expect(menu).toHaveCount(0);
  } finally {
    await page.unroute("**/api/plugins/light/commands/venue.fixture.delete");
    await api(page, "venue.fixture.delete", { id: "unchecked-del", force: true });
  }
  expect(errors.filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
});

test("venue: the fixture menu shows the zones deduced for a wash and corrects its halo", async ({ page }) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 1400, height: 800 });
  await login(page);
  await api(page, "venue.fixture.put", { fixture: { id: "wash-ui", name: "Wash zones", manufacturer: "Test", model: "Wash Zones", mode: "18 Channel", universe: 2, address: 200 } });
  try {
    await page.locator("nav.pages").getByRole("button", { name: "Lieu" }).click();
    const row = page.locator("tr", { hasText: "Wash zones" });
    // opened low in the window, as a right-click near the bottom of the list would
    await row.evaluate((el) => el.dispatchEvent(new el.ownerDocument.defaultView!.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 300, clientY: 760, button: 2 })));
    const menu = page.getByRole("dialog", { name: "Réglages de l'appareil" });
    await menu.getByRole("button", { name: "Têtes et halo…" }).click();
    const rows = menu.locator(".invert-row > span");
    await expect(rows).toHaveText([/^Zone 1Red 1, Green 1/, /^Zone 2/, /^Zone 3/, /^HaloHalo Red, Halo Green, Halo Blue/, "Le halo suit le look"]);
    await expect(menu).toContainText("zones déduites des noms des canaux, par leur numéro");
    await expect(menu).toContainText("Concerne 1 appareil(s) de ce modèle.");
    await expect(menu.getByRole("radio", { name: "Ce modèle" })).toHaveAttribute("aria-checked", "true");
    // the scope is one radio group: one tab stop, arrows move the choice and the focus
    const modelRadio = menu.getByRole("radio", { name: "Ce modèle" });
    const fixtureRadio = menu.getByRole("radio", { name: "Cet appareil seul" });
    await expect(fixtureRadio).toHaveAttribute("tabindex", "-1");
    await modelRadio.focus();
    await page.keyboard.press("ArrowRight");
    await expect(fixtureRadio).toHaveAttribute("aria-checked", "true");
    await expect(fixtureRadio).toBeFocused();
    await expect(fixtureRadio).toHaveAttribute("tabindex", "0");
    // nothing to say for this fixture alone (no correction yet): no empty line
    await expect(menu.locator("small.hint:empty")).toHaveCount(0);
    await page.keyboard.press("ArrowLeft");
    await expect(modelRadio).toHaveAttribute("aria-checked", "true");
    await expect(modelRadio).toBeFocused();
    // End and Home go to the last and the first choice, as in any radio group
    await page.keyboard.press("End");
    await expect(fixtureRadio).toHaveAttribute("aria-checked", "true");
    await expect(fixtureRadio).toBeFocused();
    await page.keyboard.press("Home");
    await expect(modelRadio).toHaveAttribute("aria-checked", "true");
    await expect(modelRadio).toBeFocused();
    // the menu grew with the heads: it stays inside the window, its last button reachable
    // the ResizeObserver re-places it on the next frame: poll rather than read once
    await expect.poll(async () => { const b = (await menu.boundingBox())!; return b.y >= 0 && b.y + b.height <= 800; }).toBe(true);
    await menu.getByRole("button", { name: "Supprimer" }).scrollIntoViewIfNeeded();
    await expect(menu.getByRole("button", { name: "Supprimer" })).toBeInViewport();
    // this fixture only: its halo becomes a fourth zone, the focus stays on that head
    await menu.getByRole("radio", { name: "Cet appareil seul" }).click();
    const haloToggle = menu.getByRole("button", { name: /^C'est le halo · Halo Red/ });
    await haloToggle.click();
    await expect(rows).toHaveText([/^Zone 1/, /^Zone 2/, /^Zone 3/, /^Zone 4Halo Red/]);
    await expect(haloToggle).toBeFocused();
    await expect(menu).toContainText("Corrigé pour cet appareil.");
    expect(await api(page, "venue.fixture.heads", { fixture: "wash-ui" })).toMatchObject({ overrides: { fixture: { accent: [] } } });
    await page.screenshot({ path: "test-results/venue-fixture-heads.png" });
    // the last full zone cannot become the halo: its button says why instead of sending what the server refuses
    for (const n of [1, 2, 3]) await menu.getByRole("button", { name: new RegExp(`^C'est le halo · Red ${n},`) }).click();
    await expect(rows).toHaveText([/^Halo/, /^Halo/, /^Halo/, /^Zone 4Halo Red.*Dernière zone pleine : un halo a besoin d'une zone à côté de lui\.$/, "Le halo suit le look"]);
    await expect(haloToggle).toHaveAttribute("aria-disabled", "true");
    await expect(haloToggle).toHaveAccessibleDescription("Dernière zone pleine : un halo a besoin d'une zone à côté de lui.");
    await haloToggle.focus(); // still reachable, so that its reason is read
    await expect(haloToggle).toBeFocused();
    await haloToggle.click({ force: true });
    await expect(haloToggle).toHaveAttribute("aria-pressed", "false");
    await expect(menu.getByRole("alert")).toHaveCount(0);
    // a zone given back: the lock goes
    await menu.getByRole("button", { name: /^C'est le halo · Red 1,/ }).click();
    await expect(haloToggle).not.toHaveAttribute("aria-disabled", "true");
    // « this model » shows the model's own list, not the fixture's
    await menu.getByRole("radio", { name: "Ce modèle" }).click();
    await expect(rows).toHaveText([/^Zone 1/, /^Zone 2/, /^Zone 3/, /^Halo/, "Le halo suit le look"]);
    // opened again: « this fixture only » is preselected, as it has its own correction
    await page.keyboard.press("Escape");
    await row.click({ button: "right" });
    await menu.getByRole("button", { name: "Têtes et halo…" }).click();
    await expect(menu.getByRole("radio", { name: "Cet appareil seul" })).toHaveAttribute("aria-checked", "true");
    await menu.getByRole("button", { name: "Annuler la correction de cet appareil" }).click();
    await expect(rows).toHaveText([/^Zone 1/, /^Zone 2/, /^Zone 3/, /^Halo/, "Le halo suit le look"]);
  } finally {
    await api(page, "venue.fixture.delete", { id: "wash-ui" });
  }
  expect(errors).toEqual([]);
});


test("venue: the fixture menu from the keyboard, focus kept inside and given back, colours as one radio group", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.locator("nav.pages").getByRole("button", { name: "Lieu" }).click();
  try {
    const row = page.locator("tr", { hasText: "Bar 1" });
    await row.focus();
    await page.keyboard.press("Shift+F10");
    const menu = page.getByRole("dialog", { name: "Réglages de l'appareil" });
    await expect(menu).toContainText("Bar 1 · U1.16");
    await expect(menu.getByLabel("Nom")).toBeFocused();
    // Tab goes round inside the menu
    await page.keyboard.press("Shift+Tab");
    await expect(menu.getByRole("button", { name: "Supprimer", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(menu.getByLabel("Nom")).toBeFocused();
    // the 13 swatches: one Tab stop, the arrows choose
    const radios = menu.getByRole("radiogroup", { name: "Couleur de repère" }).getByRole("radio");
    await expect(radios).toHaveCount(13);
    await expect(menu.locator('[role="radio"][tabindex="0"]')).toHaveCount(1);
    await page.keyboard.press("Tab");
    await expect(menu.getByRole("radio", { name: "Sans couleur" })).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(menu.getByRole("radio", { name: "rouge" })).toBeFocused();
    await expect(menu.getByRole("radio", { name: "rouge" })).toHaveAttribute("aria-checked", "true");
    await expect.poll(async () => ((await api(page, "venue.fixture.list")) as { id: string; color?: string }[]).find((f) => f.id === "bar-1")?.color).toBe("#ef4444");
    // Escape closes it and gives the focus back to the row
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(row).toBeFocused();
  } finally {
    await api(page, "venue.fixture.mark", { id: "bar-1", color: null });
  }
  expect(errors).toEqual([]);
});

test("venue: the fixture menu checks a move before sending it, opens from the plan, and says when the fixture is gone", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await api(page, "venue.fixture.put", { fixture: { id: "gone-fx", name: "gone-fx", manufacturer: "Test", model: "Bar 4", mode: "15 Channel", universe: 2, address: 470 } });
  await page.locator("nav.pages").getByRole("button", { name: "Lieu" }).click();
  try {
    // from the stage plan: the same menu, on a fixture named for assistive technologies
    const onPlan = page.locator("#venue-stage").getByRole("button", { name: "Bar 1", exact: true });
    await expect(onPlan).toHaveAttribute("aria-pressed", /^(true|false)$/); // a button that selects it, pressed while selected
    await expect(onPlan).not.toHaveAttribute("aria-haspopup");
    await onPlan.click({ button: "right" });
    const menu = page.getByRole("dialog", { name: "Réglages de l'appareil" });
    await expect(menu).toContainText("Bar 1 · U1.16");
    const move = menu.getByRole("button", { name: "Déplacer", exact: true });
    const universe = menu.getByLabel("Univers");
    const address = menu.getByLabel("Adresse DMX");
    await expect(move).toBeDisabled(); // nothing changed yet
    await universe.fill("3");
    await expect(move).toBeDisabled();
    await expect(menu).toContainText("L'univers est un nombre entier de 1 à 2");
    await universe.fill("1");
    await address.fill("510");
    await expect(move).toBeDisabled();
    await expect(menu).toContainText("finirait au canal 524");
    // the faulty field points at the sentence saying why
    const why = await address.getAttribute("aria-describedby");
    expect(why).toBeTruthy();
    await expect(menu.locator(`[id="${why}"]`)).toContainText("finirait au canal 524");
    await expect(universe).not.toHaveAttribute("aria-describedby");
    await address.fill("0");
    await expect(menu).toContainText("L'adresse est un nombre entier de 1 à 512");
    await menu.screenshot({ path: "test-results/venue-fixture-move-check.png" });
    // Enter moves from either field
    await address.fill("300");
    await universe.press("Enter");
    await expect(menu).toContainText("Bar 1 · U1.300");
    await page.keyboard.press("Escape");
    // a deletion refused by the server is said in the menu
    await page.locator("tr", { hasText: "gone-fx" }).click({ button: "right" });
    await page.route("**/api/plugins/light/commands/venue.fixture.delete", (route) => route.fulfill({ status: 409, json: { error: "refusé pour le test" } }));
    page.once("dialog", (d) => void d.accept());
    await menu.getByRole("button", { name: "Supprimer", exact: true }).click();
    await expect(menu.getByRole("alert")).toContainText("refusé pour le test");
    await page.unroute("**/api/plugins/light/commands/venue.fixture.delete");
    // deleted meanwhile (another device): said on the page, the menu closed
    await api(page, "venue.fixture.delete", { id: "gone-fx", force: true });
    await expect(menu).toHaveCount(0);
    await expect(page.locator(".venue > p.error")).toContainText("supprimé entre-temps");
  } finally {
    const f = ((await api(page, "venue.fixture.list")) as Record<string, unknown>[]).find((x) => x.id === "bar-1")!;
    await api(page, "venue.fixture.put", { fixture: { ...f, universe: 1, address: 16 } });
    await api(page, "venue.fixture.delete", { id: "gone-fx", force: true });
  }
  expect(errors.filter((e) => !e.includes("status of 409"))).toEqual([]);
});

/** T6: the synthetic « Mode Par » (test/fixtures/mode-par.qxf, in the library of the UI server), patched by the test itself. */
const modePar = (extra: Record<string, unknown> = {}) => ({ id: "mode-par", name: "Par à modes", manufacturer: "Test", model: "Mode Par", mode: "6 Channel", universe: 2, address: 200, ...extra });

test("venue: the fixture menu changes the DMX mode with its plan, carries channels by name, asks before a loss, and undoes", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await api(page, "venue.fixture.put", { fixture: modePar() });
  await api(page, "fader.put", { fader: { id: "mode-prog", name: "Programme", channels: [{ fixture: "mode-par", offset: 4 }], level: 0 } });
  const fader = async () => ((await api(page, "fader.list")) as { id: string; channels: { offset: number }[] }[]).find((f) => f.id === "mode-prog");
  const mode = async () => ((await api(page, "venue.fixture.list")) as { id: string; mode: string }[]).find((f) => f.id === "mode-par")?.mode;
  try {
    await page.locator("nav.pages").getByRole("button", { name: "Lieu" }).click();
    await page.locator("tr", { hasText: "Par à modes" }).click({ button: "right" });
    const menu = page.getByRole("dialog", { name: "Réglages de l'appareil" });
    const section = menu.locator("fieldset.dmx-mode");
    // the definition's modes, the current one marked by a sign and a word
    await expect(section.getByRole("button", { name: /6 Channel/ })).toHaveAttribute("aria-current", "true");
    await expect(section.getByRole("button", { name: /6 Channel/ })).toContainText("en cours");
    // 8 channels: the plan first (nothing written), then applied; the fader follows « Program » by its name
    await section.getByRole("button", { name: /^8 Channel/ }).click();
    const plan = section.getByRole("region", { name: "Passer en « 8 Channel »" });
    await expect(plan).toContainText("6 → 8 canaux");
    await expect(plan).toContainText("Reportés (1)");
    expect(await mode()).toBe("6 Channel");
    await menu.screenshot({ path: "test-results/fixture-mode-plan.png" });
    await plan.getByRole("button", { name: "Appliquer" }).click();
    await expect(section.getByRole("status")).toContainText("Mode changé : « 8 Channel »");
    await expect(section.getByRole("status")).toBeFocused(); // the focus is not lost with the plan gone
    await expect.poll(async () => (await fader())?.channels[0]!.offset).toBe(6);
    expect(await mode()).toBe("8 Channel");
    // renamed since: the undo names it and asks before putting the old state back; then one undo takes the whole change back, and says so
    await api(page, "venue.fixture.mark", { id: "mode-par", name: "Par renommé" });
    let changed = "";
    page.once("dialog", (d) => ((changed = d.message()), void d.accept()));
    await section.getByRole("button", { name: "↶ Défaire" }).click();
    await expect.poll(() => changed).toContain("Par renommé");
    await expect.poll(mode).toBe("6 Channel");
    await expect(section.getByRole("status")).toContainText("Changement de mode défait");
    await expect(section.getByRole("status")).toBeFocused();
    expect((await fader())?.channels[0]!.offset).toBe(4);
    // a plan put aside: the focus goes back to the mode in force
    await section.getByRole("button", { name: /^Pixel reversed/ }).click();
    await section.getByRole("button", { name: "Annuler" }).click();
    await expect(section.getByRole("button", { name: /6 Channel/ })).toBeFocused();
    // Pixel has no « Program »: lost, named, and asked again before it is forced
    await section.getByRole("button", { name: /^Pixel 9/ }).click();
    const lossy = section.getByRole("region", { name: "Passer en « Pixel »" });
    await expect(lossy.getByRole("alert")).toContainText("Program");
    let asked = "";
    page.once("dialog", (d) => ((asked = d.message()), void d.dismiss()));
    await lossy.getByRole("button", { name: "Appliquer" }).click();
    await expect.poll(() => asked).toContain("Programme");
    expect(asked).toContain("Perdu :");
    expect(await mode()).toBe("6 Channel"); // dismissed: nothing written
    page.once("dialog", (d) => void d.accept());
    await lossy.getByRole("button", { name: "Appliquer" }).click();
    await expect.poll(mode).toBe("Pixel");
    expect(await fader()).toBeUndefined(); // left with no channel: deleted
    await section.getByRole("button", { name: "↶ Défaire" }).click();
    await expect.poll(mode).toBe("6 Channel");
    expect((await fader())?.channels[0]!.offset).toBe(4);
  } finally {
    await api(page, "fader.delete", { id: "mode-prog", force: true });
    await api(page, "venue.fixture.delete", { id: "mode-par", force: true });
  }
  expect(errors.filter((e) => !e.includes("commands/show.revert"))).toEqual([]); // the first undo is refused on purpose (renamed since)
});

test("venue: on a shared venue the DMX mode change offers a venue of this show's own, or the change for every show", async ({ page, request }) => {
  const errors = watchErrors(page);
  const call = async (name: string, args: unknown = {}) =>
    ((await (await request.post(`/api/plugins/light/commands/${name}`, { headers: { authorization: "Bearer ui-test-token" }, data: args })).json()) as { result: unknown }).result;
  const open = ((await call("show.list")) as { id: string; venue: string; active: boolean }[]).find((s) => s.active)!;
  await call("venue.fixture.put", { fixture: modePar() });
  const other = (await call("show.create", { name: "Show voisin", venue: "current", open: false })) as { id: string };
  const modeIn = async (venue: string) => ((await call("venue.fixture.list")) as { id: string; mode: string }[]).find((f) => f.id === "mode-par")?.mode + `@${((await call("venue.list")) as { id: string; active: boolean }[]).find((v) => v.active)!.id === venue ? "open" : "other"}`;
  await login(page);
  try {
    await page.locator("nav.pages").getByRole("button", { name: "Lieu" }).click();
    await page.locator("tr", { hasText: "Par à modes" }).click({ button: "right" });
    const section = page.getByRole("dialog", { name: "Réglages de l'appareil" }).locator("fieldset.dmx-mode");
    await section.getByRole("button", { name: /^8 Channel/ }).click();
    const plan = section.getByRole("region", { name: "Passer en « 8 Channel »" });
    await expect(plan).toContainText("Show voisin");
    await expect(plan.getByRole("button", { name: /^Appliquer/ })).toHaveCount(0);
    // for every show: the plan is read again that way (their looks and faders), then applied on a yes
    await plan.getByRole("button", { name: "Modifier pour tous les shows…" }).click();
    await expect(plan).toContainText("Show voisin : 0 look(s), 0 fader(s) reportés, 0 perte(s)");
    await plan.getByRole("button", { name: "Appliquer pour tous les shows" }).click();
    await expect(section.getByRole("status")).toContainText("Mode changé");
    expect(await modeIn(open.venue)).toBe("8 Channel@open");
    await section.getByRole("button", { name: "↶ Défaire" }).click();
    await expect.poll(() => modeIn(open.venue)).toBe("6 Channel@open");
    // a venue of its own: said first (the show moves, its looks stop), then this show moves to a copy, the other keeps the old mode
    await section.getByRole("button", { name: /^8 Channel/ }).click();
    await plan.getByRole("button", { name: "Créer un lieu pour ce show…" }).click();
    await expect(plan).toContainText("propre copie du lieu");
    await plan.getByRole("button", { name: "Appliquer sur un lieu à ce show" }).click();
    await expect(section.getByRole("status")).toContainText("propre lieu");
    await expect.poll(() => modeIn(open.venue)).toBe("8 Channel@other");
    const venues = (await call("venue.list")) as { id: string; shows: string[] }[];
    expect(venues.find((v) => v.id === open.venue)!.shows).toEqual([other.id]);
    await expect(page.locator(".venue p.hint", { hasText: "Ce lieu est partagé" })).toHaveCount(0);
    // the undo takes the mode back, not the copy: said
    await section.getByRole("button", { name: "↶ Défaire" }).click();
    await expect(section.getByRole("status")).toContainText("reste sur son propre lieu");
    await expect.poll(() => modeIn(open.venue)).toBe("6 Channel@other");
  } finally {
    await call("show.venue.set", { venue: open.venue });
    await call("show.delete", { id: other.id });
    await call("venue.fixture.delete", { id: "mode-par", force: true });
  }
  expect(errors).toEqual([]);
});

test("venue plan: the panel sets a channel's working mode by name, reads the one going out, names a look holding it higher, and shows the neighbouring ranges", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page, "9999");
  await api(page, "venue.fixture.put", { fixture: modePar({ position: { x: 2, y: 1, z: 4 } }) });
  const canvas = ((await api(page, "venue.canvas.list")) as { id: string }[])[0]!.id;
  await api(page, "look.put", { look: { id: "mode-hold", name: "Tient le programme", canvas, technique: { kind: "plat", color: "#000000" }, channels: { targets: [{ fixture: "mode-par", offset: 4 }], steps: [[230]] } } });
  const program = async () => (await dmx(page, 2))[199 + 4];
  try {
    await page.locator("nav.pages button", { hasText: "Lieu" }).click();
    await page.evaluate('document.querySelector(".stage-plan")?.scrollIntoView({ block: "center" })');
    const body = page.locator('.stage-plan g.fixture[data-fixture="mode-par"]').first();
    const box = (await body.boundingBox())!;
    for (const [fx, fy] of [[0.5, 0.5], [0.85, 0.85], [0.15, 0.15]]) {
      await body.click({ position: { x: box.width * fx!, y: box.height * fy! }, timeout: 1500 }).catch(() => undefined);
      if (await page.locator(".fixture-panel").isVisible()) break;
    }
    const panel = page.locator(".fixture-panel");
    // the mode going out now, read on the output: nothing asked yet, « No function »
    const button = panel.getByRole("button", { name: /^Program : / });
    await expect(button).toContainText("No function");
    await button.click();
    // opened right under its button, the focus inside; Escape closes it and gives the focus back
    const list = page.getByRole("dialog", { name: /^Program — / });
    await expect(list.getByRole("searchbox")).toBeFocused(); // more than 8 rows: the search first
    await page.keyboard.press("Escape");
    await expect(list).toHaveCount(0);
    await expect(button).toBeFocused();
    await button.click();
    // variants indented under their mode, in one list; a mode's own row shows the values it sends (its first variant)
    await expect(list.locator("li.variant", { hasText: "Auto 2" })).toBeVisible();
    await expect(list.locator("li:not(.variant)", { hasText: "Sound" })).toContainText("104–135");
    await list.getByRole("button", { name: /^Auto 2/ }).click();
    await expect.poll(program).toBe(55); // the middle of 40–71
    await expect(button).toContainText("Auto 2");
    await expect(button).toBeFocused();
    // the fader of that channel shows the range it is in, and its neighbours with their values
    const ladder = panel.getByRole("list", { name: "Plages de Program" });
    await expect(ladder.locator("li.now")).toContainText("Auto 2");
    await expect(ladder.locator("li.now")).toContainText("55");
    await expect(ladder).toContainText("Auto 3");
    await expect(ladder).toContainText("Auto 1");
    await panel.scrollIntoViewIfNeeded();
    await panel.screenshot({ path: "test-results/fixture-panel-modes.png" });
    // a look writing it higher wins (highest takes precedence): the panel names it
    await api(page, "look.go", { id: "mode-hold" });
    await expect.poll(program).toBe(230);
    await button.click();
    await list.getByRole("button", { name: /^Auto 1/ }).click();
    await expect(panel.getByRole("status").filter({ hasText: "Tient le programme" })).toContainText("il l'emporte");
    await expect(button).toContainText("Color fade fast");
    await api(page, "look.stop", { id: "mode-hold" });
    await expect.poll(program).toBe(23);
    await expect(panel.getByRole("status").filter({ hasText: "Tient le programme" })).toHaveCount(0);
    // below the mode: the DCA dosing the channel's fader is named, then the rule bounding it
    await api(page, "group.put", { group: { id: "mode-doseur", name: "Doseur", members: { fixtures: [], groups: [], looks: [] }, master: { level: 0.5, mute: false }, presets: { included: [], excluded: [] } } });
    const own = ((await api(page, "fader.list")) as { id: string; channels: { fixture: string; offset: number }[] }[]).find((f) => f.channels.length === 1 && f.channels[0]!.fixture === "mode-par" && f.channels[0]!.offset === 4)!;
    await api(page, "fader.put", { fader: { ...own, dca: "mode-doseur" } });
    await button.click();
    await list.getByRole("button", { name: /^Auto 2/ }).click();
    await expect(panel.getByRole("status").filter({ hasText: "Program" })).toContainText("dosé par le DCA « Doseur »");
    await api(page, "fader.put", { fader: { ...own, dca: undefined } });
    await api(page, "rule.put", { where: "show", rule: { id: "mode-cap", name: "Plafond programme", scope: { fixture: "mode-par" }, target: { channel: "Program" }, max: 30 } });
    await button.click();
    await list.getByRole("button", { name: /^Auto 2/ }).click();
    await expect(panel.getByRole("status").filter({ hasText: "Program" })).toContainText("borné par la règle « Plafond programme »");
    await api(page, "rule.delete", { where: "show", id: "mode-cap" });
    // on a phone the list still opens in view, under its button
    await page.setViewportSize({ width: 400, height: 860 });
    await button.scrollIntoViewIfNeeded();
    await button.click();
    const shown = (await list.boundingBox())!;
    expect(shown.y).toBeGreaterThanOrEqual(0);
    expect(shown.y + 40).toBeLessThan(860);
    expect(shown.x + shown.width).toBeLessThanOrEqual(400);
    await page.screenshot({ path: "test-results/fixture-panel-modes-phone.png" });
    await page.keyboard.press("Escape");
  } finally {
    await api(page, "look.stop", { id: "mode-hold" });
    await api(page, "look.delete", { id: "mode-hold", force: true });
    await api(page, "rule.delete", { where: "show", id: "mode-cap" });
    for (const f of (await api(page, "fader.list")) as { id: string; channels: { fixture: string }[] }[]) if (f.channels.some((c) => c.fixture === "mode-par")) await api(page, "fader.delete", { id: f.id, force: true });
    await api(page, "group.delete", { id: "mode-doseur", force: true });
    await api(page, "venue.fixture.delete", { id: "mode-par", force: true });
  }
  expect(errors).toEqual([]);
});

test("live: a channel fader on a channel cut into functions shows its ranges when it has room, and never leaves its cell", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await api(page, "venue.fixture.put", { fixture: modePar() });
  await api(page, "fader.put", { fader: { id: "mode-live", name: "Programme", channels: [{ fixture: "mode-par", offset: 4 }], level: 0.2 } });
  const widget = (id: string, x: number, w: number) => ({ id, kind: "channel-fader", target: "mode-live", x, y: 0, w, h: 4 });
  await api(page, "dashboard.put", { dashboard: { id: "modes-live", name: "Plages", columns: 12, widgets: [widget("narrow", 0, 1), widget("wide", 2, 3)] } });
  try {
    for (const size of [{ width: 1280, height: 800 }, { width: 400, height: 860 }]) {
      await page.setViewportSize(size);
      await page.reload();
      await page.locator(".dash-top .bar .tab", { hasText: "Plages" }).click();
      const narrow = page.locator('[data-widget="narrow"]');
      const wide = page.locator('[data-widget="wide"]');
      await expect(narrow.locator(".range-ladder")).toHaveCount(0); // one cell wide: no column, the range input says it
      await expect(narrow.getByRole("slider")).toHaveAttribute("aria-valuetext", "51 — Auto 2");
      await expect(wide.locator(".range-ladder li.now")).toContainText("Auto 2");
      for (const cell of [narrow, wide]) {
        const outer = (await cell.boundingBox())!;
        for (const part of await cell.locator(".track, .range-ladder").all()) {
          const b = (await part.boundingBox())!;
          expect(b.x).toBeGreaterThanOrEqual(outer.x - 0.5);
          expect(b.x + b.width).toBeLessThanOrEqual(outer.x + outer.width + 0.5);
        }
      }
    }
    await page.screenshot({ path: "test-results/live-fader-ranges.png" });
  } finally {
    await api(page, "dashboard.delete", { id: "modes-live", force: true });
    await api(page, "fader.delete", { id: "mode-live", force: true });
    await api(page, "venue.fixture.delete", { id: "mode-par", force: true });
  }
  expect(errors).toEqual([]);
});

test("show page: undoing a mode change edited since names what was edited and asks first", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await api(page, "venue.fixture.put", { fixture: modePar() });
  const mode = async () => ((await api(page, "venue.fixture.list")) as { id: string; mode: string }[]).find((f) => f.id === "mode-par")?.mode;
  try {
    await api(page, "venue.fixture.mode", { id: "mode-par", mode: "8 Channel" });
    await api(page, "venue.fixture.mark", { id: "mode-par", name: "Par retouché" });
    await page.locator("nav.pages").getByRole("button", { name: "Show" }).click();
    // earlier tests left reverted proposals of the same title: the applied one is the newest
    const row = page.locator("section.proposals .proposal.applied", { hasText: "Mode DMX de Par à modes" }).first();
    const undo = row.getByRole("button", { name: "↶ Défaire" });
    await expect(undo).toBeVisible();
    await expect(row).toBeVisible();
    let asked = "";
    page.once("dialog", (d) => ((asked = d.message()), void d.dismiss()));
    await undo.click();
    await expect.poll(() => asked).toContain("appareil « Par retouché »");
    expect(await mode()).toBe("8 Channel"); // dismissed: nothing undone
    page.once("dialog", (d) => void d.accept());
    await undo.click();
    await expect.poll(mode).toBe("6 Channel");
  } finally {
    await api(page, "venue.fixture.delete", { id: "mode-par", force: true });
  }
  expect(errors.filter((e) => !e.includes("commands/show.revert"))).toEqual([]); // the first undo is refused on purpose
});

test("venue: the menu's undo over a canvas enlarged since asks for each refusal, then goes through", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await api(page, "venue.fixture.put", { fixture: modePar({ mode: "Pixel" }) });
  await api(page, "venue.canvas.put", { canvas: { id: "mode-pix", name: "Pixels essai", topology: "line", cells: 2, render: [{ from: 0, to: 0, targets: [{ fixture: "mode-par", head: 0 }] }, { from: 1, to: 1, targets: [{ fixture: "mode-par", head: 1 }] }] } });
  const mode = async () => ((await api(page, "venue.fixture.list")) as { id: string; mode: string }[]).find((f) => f.id === "mode-par")?.mode;
  const asked: string[] = [];
  try {
    await page.locator("nav.pages").getByRole("button", { name: "Lieu" }).click();
    await page.locator("tr", { hasText: "Par à modes" }).click({ button: "right" });
    const section = page.getByRole("dialog", { name: "Réglages de l'appareil" }).locator("fieldset.dmx-mode");
    // to 6 channels: the canvas loses its heads (forced on a yes)
    page.once("dialog", (d) => void d.accept());
    await section.getByRole("button", { name: /^6 Channel/ }).click();
    await section.getByRole("region", { name: "Passer en « 6 Channel »" }).getByRole("button", { name: "Appliquer" }).click();
    await expect.poll(mode).toBe("6 Channel");
    // the canvas enlarged since, and a look of exact steps written on its three cells
    await api(page, "venue.canvas.put", { canvas: { id: "mode-pix", name: "Pixels essai", topology: "line", cells: 3, render: [] }, force: true });
    await api(page, "look.put", { look: { id: "mode-steps", name: "Pas exacts", canvas: "mode-pix", technique: { kind: "pas", steps: [["#ff0000", "#00ff00", "#0000ff"]] } } });
    // the undo: edited since (one yes), then a canvas whose look no longer lines up (a second yes), then done
    page.on("dialog", (d) => void (asked.push(d.message()), d.accept()));
    await section.getByRole("button", { name: "↶ Défaire" }).click();
    await expect.poll(mode).toBe("Pixel");
    expect(asked).toHaveLength(2);
    expect(asked[0]).toContain("Pixels essai");
    expect(asked[1]).toContain("Défaire quand même ?");
    await expect(section.getByRole("status")).toContainText("Changement de mode défait");
  } finally {
    await api(page, "look.delete", { id: "mode-steps", force: true });
    await api(page, "venue.canvas.delete", { id: "mode-pix", force: true });
    await api(page, "venue.fixture.delete", { id: "mode-par", force: true });
  }
  expect(errors.filter((e) => !e.includes("commands/show.revert"))).toEqual([]); // the first two undos are refused on purpose
});

test("venue: the patch table names its columns", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.locator("nav.pages").getByRole("button", { name: "Lieu" }).click();
  await expect(page.locator("#venue-patch thead th")).toHaveText(["", "Nom", "Mode", "Univers", "Rôle", "Présent", "Retirer"]);
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
  await row.getByRole("button", { name: "Enregistrer" }).click();
  await expect(looks.locator("li", { hasText: "note de test, relue" })).toBeVisible();
  // from the keyboard too: a note is a button, Enter opens it for editing
  const edited = looks.locator("li", { has: page.locator("strong", { hasText: /^checker$/ }) });
  await edited.getByRole("button", { name: "note de test, relue" }).focus();
  await page.keyboard.press("Enter");
  await expect(edited.getByRole("textbox")).toHaveValue(/^note de test, relue/); // the server dates a note
  await edited.getByRole("button", { name: "Enregistrer" }).click();
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
  // its first command gets a 401, unless the page got there by itself: the heartbeat closes the
  // socket of a closed session, whose reconnection is refused
  await page.locator("nav.pages").getByRole("button", { name: "Show", exact: true }).click({ timeout: 5000 }).catch(() => undefined);
  await expect(page.locator("form.pin-login")).toBeVisible();
  await expect(page.getByText(/Session terminée/)).toBeVisible();
  // the browser itself logs the refused requests and a socket whose ticket predates the sign-out
  expect(errors.filter((e) => !e.includes("status of 401") && !e.includes("WebSocket connection"))).toEqual([]);
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

test("a page whose file an update replaced: the tab reloads once and shows it, never in a loop", async ({ page }) => {
  await login(page);
  // the tab knows the old name of the Songs page's file, which the server no longer has (404)
  let missing = 1;
  await page.route("**/assets/Songs-*.js", (route) => (missing-- > 0 ? route.fulfill({ status: 404, body: "" }) : route.continue()));
  let loads = 0;
  page.on("load", () => loads++);
  await page.locator("nav.pages button", { hasText: "Chants" }).first().click();
  await expect.poll(() => loads).toBe(1); // reloaded once
  await page.locator("nav.pages button", { hasText: "Chants" }).first().click();
  await expect(page.locator(".songs")).toBeVisible(); // and the page shows after it
  // really missing: one reload, then the error stays (no loop)
  await page.unroute("**/assets/Songs-*.js");
  await page.evaluate("sessionStorage.removeItem('reloadedForMissingChunk')");
  await page.route("**/assets/Songs-*.js", (route) => route.fulfill({ status: 404, body: "" }));
  loads = 0;
  await page.reload(); // the tab reopens on Chants: missing, one more reload, then it says so in the page's place
  await expect(page.getByRole("alert")).toContainText("Cette page n'a pas pu se charger");
  await page.waitForTimeout(1500);
  expect(loads).toBe(2); // ours, and the one reload: no loop
  await page.locator("nav.pages button", { hasText: "Live" }).first().click(); // the rest still works
  await expect(page.locator(".dgrid")).toBeVisible();
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

test("DMX console: « Pourquoi ce canal » names the zone or the halo and the look painting it", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await api(page, "venue.fixture.put", { fixture: { id: "why-wash", name: "Wash pourquoi", manufacturer: "Test", model: "Wash Zones", mode: "18 Channel", universe: 1, address: 300 } });
  await api(page, "venue.canvas.put", { canvas: { id: "why-wash", name: "Wash pourquoi", cells: 1, render: [{ from: 0, to: 0, targets: [{ fixture: "why-wash", head: 1 }] }] } });
  await api(page, "look.put", { look: { id: "why-red", name: "Zone 2 rouge", canvas: "why-wash", technique: { kind: "plat", color: "#ff0000" } } });
  await api(page, "look.go", { id: "why-red" });
  try {
    await page.getByRole("button", { name: "Console DMX" }).click();
    const wash = page.getByRole("region", { name: "Wash pourquoi" });
    // Red 2 is the 7th channel (306), the halo's red the 15th (314)
    await wash.getByRole("button", { name: "Pourquoi ce canal 306" }).click();
    const zone = page.getByRole("region", { name: "Pourquoi ce canal 306" });
    await expect(zone).toContainText("Wash pourquoi · canal 7 (Red 2, color) · Zone 2");
    await expect(zone).toContainText("Couleur peinte par « Zone 2 rouge »");
    await zone.getByRole("button", { name: "Fermer" }).click();
    await wash.getByRole("button", { name: "Pourquoi ce canal 314" }).click();
    const halo = page.getByRole("region", { name: "Pourquoi ce canal 314" });
    await expect(halo).toContainText("(Halo Red, color) · Halo");
    await expect(halo).toContainText("Couleur peinte par « Zone 2 rouge »"); // the halo follows the zone it paints
  } finally {
    await api(page, "look.stop", { id: "why-red" });
    await api(page, "look.delete", { id: "why-red" });
    await api(page, "venue.canvas.delete", { id: "why-wash" });
    await api(page, "venue.fixture.delete", { id: "why-wash" });
  }
  expect(errors).toEqual([]);
});

// ---- DCAs dose a raw scene, through a parent reached twice, a linked fader and the grand master (T35)
test("DCA: a raw scene follows its DCA once, a fader's DCA and the grand master, and the console says why", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  // a generic dimmer (a lamp, no .qxf) at 450, lit by a raw scene at 255
  await api(page, "venue.fixture.put", { fixture: { id: "t35-lamp", name: "Lampe DCA", manufacturer: "Generic", model: "Generic", mode: "1 Channel", universe: 1, address: 450 } });
  await api(page, "venue.canvas.put", { canvas: { id: "t35", name: "T35", cells: 1, render: [{ from: 0, to: 0, targets: [{ fixture: "t35-lamp", head: -1 }] }] } });
  await api(page, "look.put", { look: { id: "t35-scene", name: "Scène lampe", canvas: "t35", technique: { kind: "aucune" }, channels: { targets: [{ fixture: "t35-lamp", offset: 0 }], steps: [[255]] } } });
  const group = (id: string, name: string, level: number, members: { fixtures?: string[]; groups?: string[] }) =>
    api(page, "group.put", { group: { id, name, members: { fixtures: members.fixtures ?? [], groups: members.groups ?? [], looks: [] }, master: { level, mute: false } } });
  const lamp = async () => (await dmx(page))[449];
  try {
    await api(page, "look.go", { id: "t35-scene" });
    await expect.poll(lamp).toBe(255);
    // two sub-groups holding the lamp under one parent DCA at 50 %: the parent counts once (128, not 64)
    await group("t35-a", "Sous A", 1, { fixtures: ["t35-lamp"] });
    await group("t35-b", "Sous B", 1, { fixtures: ["t35-lamp"] });
    await group("t35-parent", "DCA lampes", 0.5, { groups: ["t35-a", "t35-b"] });
    await expect.poll(lamp).toBe(128);
    // the grand master lowers it too
    await api(page, "grandmaster.set", { level: 0.5 });
    await expect.poll(lamp).toBe(64);
    await api(page, "grandmaster.set", { level: 1 });
    // a fader on the lamp, linked to another DCA at 50 %: the look writing the fader's channel follows that DCA
    await group("t35-fader-dca", "DCA du fader", 0.5, {});
    await api(page, "fader.put", { fader: { id: "t35-fader", name: "Fader lampe", channels: [{ fixture: "t35-lamp", offset: 0 }], level: 0, dca: "t35-fader-dca" } });
    await expect.poll(lamp).toBe(64);
    await page.getByRole("button", { name: "Console DMX" }).click();
    const fixture = page.getByRole("region", { name: "Lampe DCA" });
    await fixture.getByRole("button", { name: "Pourquoi ce canal 450" }).click();
    const why = page.getByRole("region", { name: "Pourquoi ce canal 450" });
    await expect(why).toContainText("U1.450 = 64");
    await expect(why).toContainText("grand master 100 % × Sous A 100 % × Sous B 100 % × DCA lampes 50 % = 50 %");
    await expect(why.locator(".why-raw-dosed")).toHaveText("Gradateur ou couleur bruts : le look qui l'écrit est dosé par cette intensité");
    await expect(why).toContainText("Looks sur ce canal, dosés aussi par le DCA lié à son fader : DCA du fader 50 % = 50 %");
    await expect(why).toContainText("Look à canaux bruts « Scène lampe »");
    await expect(why).toContainText("Fader de canaux « Fader lampe » 0 % × DCA du fader 50 %"); // its own value, its DCAs named
    await expect(why).toContainText("× grand master 100 % → 0 %");
    await page.screenshot({ path: "test-results/t35-console-why.png" });
    await page.keyboard.press("Escape"); // Escape closes the panel
    await expect(why).toHaveCount(0);
    // a machine channel (a bar's Program) says it is not dosed, instead of an intensity it does not follow
    await page.getByRole("region", { name: "Bar 0" }).getByRole("button", { name: "Pourquoi ce canal 3" }).click();
    const program = page.getByRole("region", { name: "Pourquoi ce canal 3" });
    await expect(program).toContainText("Canal hors lumière : non dosé (ni grand master ni DCA)");
    await expect(program).not.toContainText("Intensité");
  } finally {
    await api(page, "grandmaster.set", { level: 1 });
    await api(page, "look.stop", { id: "t35-scene" });
    await api(page, "fader.delete", { id: "t35-fader", force: true });
    for (const id of ["t35-parent", "t35-a", "t35-b", "t35-fader-dca"]) await api(page, "group.delete", { id, force: true });
    await api(page, "look.delete", { id: "t35-scene", force: true });
    await api(page, "venue.canvas.delete", { id: "t35" });
    await api(page, "venue.fixture.delete", { id: "t35-lamp" });
  }
  expect(errors).toEqual([]);
});

test("DCA: the group editor, the fader editor and the raw channels say what a DCA doses (T35)", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.locator("nav.pages button", { hasText: "Show" }).click();
  await page.getByRole("button", { name: "+ Nouveau groupe" }).click();
  const editor = page.locator(".group-editor");
  await editor.getByLabel("DCA", { exact: true }).check();
  await expect(editor.locator(".dca-doses li")).toHaveCount(4);
  await expect(editor.locator(".dca-doses")).toContainText("sur les projecteurs que ce groupe ne contient pas déjà");
  await expect(editor.locator(".dca-doses")).toContainText("Il compte une seule fois");
  await expect(editor.getByLabel("DCA", { exact: true })).toHaveAttribute("aria-describedby", /.+/);
  await editor.screenshot({ path: "test-results/t35-group-editor.png" });
  await editor.getByLabel("DCA", { exact: true }).uncheck();
  await expect(editor.locator(".dca-doses")).toHaveCount(0); // said only where it applies
  await editor.getByRole("button", { name: "Fermer", exact: true }).click();
  await expect(editor).toHaveCount(0);
  // the raw channels of a look say which of them follow the DCAs
  await page.getByRole("button", { name: "+ Nouveau look" }).click();
  const look = page.locator(".look-editor").last();
  await look.getByLabel("Canaux bruts (machines, lampes)").check();
  await expect(look.locator(".raw-dca")).toContainText("Un gradateur ou une couleur bruts suivent le grand master et les DCA de leur projecteur");
  await look.getByRole("button", { name: "Fermer", exact: true }).click();
  await expect(look).toHaveCount(0);
  // the fader editor says it once a DCA is chosen
  await page.getByRole("button", { name: "+ Nouveau fader de canaux" }).click();
  const fader = page.locator(".fader-editor, .look-editor").last();
  await expect(fader.locator(".fader-dca")).toHaveCount(0);
  await fader.getByLabel("Dosé par le DCA").selectOption({ index: 1 });
  await expect(fader.locator(".fader-dca")).toHaveText("Un look qui écrit ces canaux (gradateur, couleur) suit aussi ce DCA.");
  expect(errors).toEqual([]);
});

// ---- DMX console: the built-in Reset protection and a voluntary reset (T22)
test("DMX console: a Reset channel stays at rest, says why, and « Réinitialiser l'appareil » resets that fixture", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const xml = `<?xml version="1.0" encoding="UTF-8"?><FixtureDefinition xmlns="http://www.qlcplus.org/FixtureDefinition"><Manufacturer>Test</Manufacturer><Model>Reset Head</Model><Type>Moving Head</Type><Channel Name="Pan" Preset="PositionPan"/><Channel Name="Tilt" Preset="PositionTilt"/><Channel Name="Dimmer" Preset="IntensityDimmer"/><Channel Name="Control"><Group Byte="0">Maintenance</Group><Capability Min="0" Max="149">No function</Capability><Capability Min="150" Max="199">Reset pan/tilt</Capability><Capability Min="200" Max="255">Reset all</Capability></Channel><Mode Name="4 Channel"><Channel Number="0">Pan</Channel><Channel Number="1">Tilt</Channel><Channel Number="2">Dimmer</Channel><Channel Number="3">Control</Channel></Mode></FixtureDefinition>`;
  await api(page, "fixture.definition.add", { name: "test-reset-head.qxf", xml, replace: true });
  await api(page, "venue.fixture.put", { fixture: { id: "reset-head", name: "Tête reset", manufacturer: "Test", model: "Reset Head", mode: "4 Channel", universe: 1, address: 100 } });
  await api(page, "dmx.set", { universe: 1, channel: 103, value: 250 }); // forced into its Reset range
  try {
    await page.getByRole("button", { name: "Console DMX" }).click();
    const head = page.getByRole("region", { name: "Tête reset" });
    await expect(head.locator(".ch").nth(3).locator(".val")).toHaveText("0"); // held at rest: what the show sends, not the top of « No function »
    await head.getByRole("button", { name: "Pourquoi ce canal 103" }).click();
    const why = page.getByRole("region", { name: "Pourquoi ce canal 103" });
    await expect(why).toContainText("Protection du canal Reset");
    await expect(why).not.toContainText("(intégrée)");
    await expect(why).toContainText("250 → 0");
    await expect(why).toContainText("pas pendant un chant"); // the help is written, not only hovered
    const button = why.getByRole("button", { name: "Réinitialiser l'appareil" });
    await expect(button).toHaveClass(/danger/);
    let asked = "";
    page.once("dialog", (d) => ((asked = d.message()), void d.accept()));
    await button.click();
    await expect(why.getByRole("status")).toContainText("Reset envoyé pendant 5 s");
    expect(asked).toContain("Control : Reset all (200–255)"); // the range sent, named
    expect(asked).toContain("autres plages Reset, non envoyées : Reset pan/tilt (150–199)"); // and the one left alone
    await expect(button).toBeDisabled(); // once at a time
    await expect(why).toContainText("U1.103 = 227", { timeout: 3000 }); // the middle of its Reset range, for a few seconds
    await expect(why).toContainText("U1.103 = 0", { timeout: 10000 }); // then protected again
    await expect(why.getByRole("status")).toHaveText("", { timeout: 3000 }); // the message goes with the window
    await expect(button).toBeEnabled();
    // a fixture running past 512: its last channel is shown as never sent
    await api(page, "venue.fixture.put", { fixture: { id: "late-head", name: "Tête tardive", manufacturer: "Test", model: "Reset Head", mode: "4 Channel", universe: 1, address: 510 } });
    await page.reload();
    await page.getByRole("button", { name: "Console DMX" }).click();
    const late = page.getByRole("region", { name: "Tête tardive" });
    await expect(late.locator(".ch.unsent")).toHaveCount(1);
    await expect(late.locator(".ch.unsent")).toContainText("513");
    await expect(late.locator(".ch.unsent .unsent-note")).toHaveText("non envoyé"); // written, not only hovered
    await expect(late.locator(".ch.unsent input")).toBeDisabled();
  } finally {
    await api(page, "dmx.release", {});
    for (const id of ["reset-head", "late-head"]) await api(page, "venue.fixture.delete", { id }).catch(() => undefined);
  }
  expect(errors).toEqual([]);
});

// ---- DMX console: who places a moving head's pan (the motion layer, T25)
test("DMX console: « Pourquoi ce canal » on a pan channel names who places the head and who is masked", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const canvas = ((await api(page, "venue.canvas.list")) as { id: string }[])[0]!.id;
  await api(page, "venue.fixture.put", { fixture: { id: "why-head", name: "Lyre pourquoi", manufacturer: "Test", model: "Spot 7", mode: "Standard", universe: 1, address: 104 } });
  await api(page, "look.put", { look: { id: "why-scene", name: "Scène pan", canvas, technique: { kind: "aucune" }, channels: { targets: [{ fixture: "why-head", offset: 0 }], steps: [[40]] } } });
  try {
    await page.getByRole("button", { name: "Console DMX" }).click();
    const head = page.getByRole("region", { name: "Lyre pourquoi" });
    await head.getByRole("button", { name: "Pourquoi ce canal 104" }).click();
    const why = page.getByRole("region", { name: "Pourquoi ce canal 104" });
    await expect(why.locator(".why-motion")).toHaveText("Couche Mouvement (pan) : position de repos (personne ne la réclame)");
    // a scene that writes the channel raw: it glides there, then holds the axis and is named as its source
    await api(page, "look.go", { id: "why-scene" });
    await expect(why.locator(".why-motion")).toContainText("look « Scène pan » · glisse de 50 % vers 16 %, encore", { timeout: 3000 });
    await expect(why.locator(".why-motion")).toHaveText("Couche Mouvement (pan) : look « Scène pan »", { timeout: 5000 });
    await expect(why).toContainText("Look à canaux bruts « Scène pan »");
    // the pad takes the head: the scene still writes the channel but no longer places it, and is said masked
    await api(page, "position.set", { fixtures: ["why-head"], pan: 0.8 });
    await expect(why.locator(".why-motion")).toHaveText("Couche Mouvement (pan) : position manuelle (pad, visée)", { timeout: 3000 });
    await expect(why.locator(".why-motion-masked")).toHaveText("Voudrait la déplacer : look « Scène pan » — masqué par : position manuelle (pad, visée)");
    await expect(why).not.toContainText("Look à canaux bruts");
    // sent home, the scene is released on this head: said so, not « masked by »
    await api(page, "position.home", { fixtures: ["why-head"] });
    await expect(why.locator(".why-motion")).toContainText("position de repos", { timeout: 3000 });
    await expect(why.locator(".why-motion-masked")).toHaveText("look « Scène pan » — relâché");
    // a Panic holds the head; handing it back lets it go to rest
    await api(page, "panic");
    await expect(why.locator(".why-motion")).toHaveText("Couche Mouvement (pan) : tenue après un Panic (la lyre reste où elle est)", { timeout: 3000 });
    await api(page, "position.release", { fixtures: ["why-head"] });
    await expect(why.locator(".why-motion")).toContainText("position de repos", { timeout: 3000 });
  } finally {
    await api(page, "panic.undo").catch(() => undefined);
    await api(page, "look.stop", { id: "why-scene" }).catch(() => undefined);
    await api(page, "position.release", {});
    await api(page, "look.delete", { id: "why-scene", force: true }).catch(() => undefined);
    await api(page, "venue.fixture.delete", { id: "why-head" }).catch(() => undefined);
  }
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
  await expect(pad.getByTestId("xy-sent-dot")).toBeVisible();
  const box = (await pad.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.75, box.y + box.height * 0.25);
  await expect(page.locator(".xy-position")).toHaveText("75 / 75");
  await expect.poll(async () => (await dmx(page, 2)).slice(0, 3)).toEqual([191, expect.any(Number), 191]); // pan, pan fine, tilt
  await page.getByRole("button", { name: "Rendre la main", exact: true }).click();
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
  await expect(editor.locator(".preview-row .cell")).toHaveCount(8); // server preview on the 8-cell canvas
  // an LED bar is one rectangle there too: its cells touch, two bars stay apart
  const stripCells = await editor.locator(".preview-row .cell").evaluateAll((cs) => cs.map((c) => ({ x: c.getBoundingClientRect().x, right: c.getBoundingClientRect().right, start: c.classList.contains("block-start") })));
  for (let i = 1; i < stripCells.length; i++) {
    const gap = stripCells[i]!.x - stripCells[i - 1]!.right;
    if (stripCells[i]!.start) expect(gap).toBeGreaterThan(1);
    else expect(Math.abs(gap)).toBeLessThan(0.6);
  }
  await expect(editor.locator(".preview-row .cell.free")).toHaveCount(0);
  await page.screenshot({ path: "test-results/look-editor.png", fullPage: true });
  await editor.getByRole("button", { name: "Enregistrer et lancer" }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.locator("button.look", { hasText: "Mon damier" })).toHaveClass(/on/);
  await expect.poll(async () => (await dmx(page)).slice(3, 15).some((v) => v > 0)).toBe(true);

  // edit: raw steps, first cell painted « éteint »
  await page.getByRole("button", { name: "Modifier Mon damier" }).click();
  await editor.getByLabel("Technique").selectOption("pas");
  await expect(editor.locator(".steps-editor .step-row .cell")).toHaveCount(8);
  // above the steps, the fixture behind each run of cells, each name right over its first square
  const blocks = editor.locator(".step-blocks .block");
  await expect(blocks).toHaveText(["Bar 0", "Bar 1"]);
  const firstRow = editor.locator(".steps-editor .step-row:not(.step-blocks)").first().locator(".cell");
  for (const [block, cell] of [[0, 0], [1, 4]] as const) {
    const [b, c] = [(await blocks.nth(block).boundingBox())!, (await firstRow.nth(cell).boundingBox())!];
    expect(Math.abs(b.x - c.x)).toBeLessThan(1.5);
  }
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
  // a channel cut into functions offers them by name: the value goes to the start of the range
  await editor.getByLabel("pas 1 · Bar 0 · Program · fonction").selectOption({ label: "Sound Control (192–255)" });
  await expect(editor.getByLabel("pas 1 · Bar 0 · Program", { exact: true })).toHaveValue("192");
  await editor.getByLabel("pas 1 · Bar 0 · Program", { exact: true }).fill("200");
  await expect(editor.getByLabel("pas 1 · Bar 0 · Program · fonction")).toHaveValue("2"); // still « Sound Control »
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

test("look editor: in a window, cells in the stage's order, the preview played on the stage", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  // Bar 1 on the jardin side of Bar 0
  const list = (await api(page, "venue.fixture.list")) as { id: string; position?: object }[];
  const before = Object.fromEntries(list.map((f) => [f.id, f]));
  const place = (id: string, x: number) => api(page, "venue.fixture.put", { fixture: { ...before[id], position: { x, y: 1, z: 0.3 } } });
  await place("bar-0", 2);
  await place("bar-1", -2);
  const canvas = ((await api(page, "venue.canvas.list")) as { id: string; cells: number }[]).find((c) => c.cells === 8)!;
  await api(page, "look.put", { look: { id: "ordre-scene", name: "Ordre scène", canvas: canvas.id, technique: { kind: "pas", steps: [Array.from({ length: 8 }, () => "-")] } } });
  try {
    await page.locator("nav.pages button", { hasText: "Show" }).click();
    await page.getByRole("button", { name: "Modifier Ordre scène" }).click();
    const editor = page.getByRole("dialog", { name: "Ordre scène" }); // over the page, wherever the list was
    await expect(editor.locator(".cells-view .step-blocks .block")).toHaveText(["Bar 1", "Bar 0"]); // from jardin to cour
    await expect(editor.locator(".steps-editor .step-blocks .block")).toHaveText(["Bar 1", "Bar 0"]);
    await expect(editor.locator(".preview-row .cell.block-start")).toHaveCount(1); // a separator where Bar 0 begins
    // the first square shown is Bar 1's first head: canvas cell 4
    await editor.locator(".steps-editor .step-row:not(.step-blocks)").first().locator(".cell").first().dispatchEvent("pointerdown");
    await editor.getByRole("button", { name: "Enregistrer", exact: true }).click();
    await expect(editor).toHaveCount(0);
    const saved = ((await api(page, "look.get", { id: "ordre-scene" })) as { technique: { steps: string[][] } }).technique.steps[0]!;
    expect(saved.findIndex((c) => c !== "-")).toBe(4);
    // the canvas's order again, and the preview on the stage plan
    await page.getByRole("button", { name: "Modifier Ordre scène" }).click();
    await editor.getByLabel("dans l'ordre de la scène").uncheck();
    await expect(editor.locator(".cells-view .step-blocks .block")).toHaveText(["Bar 0", "Bar 1"]);
    await editor.getByRole("button", { name: "Voir sur la scène" }).click();
    await expect(editor.locator(".stage-plan")).toBeVisible();
    await page.screenshot({ path: "test-results/look-editor-stage.png", fullPage: true });
    await editor.getByRole("button", { name: "Fermer" }).click();
    await expect(editor).toHaveCount(0);
  } finally {
    await api(page, "look.delete", { id: "ordre-scene" });
    for (const id of ["bar-0", "bar-1"]) await api(page, "venue.fixture.put", { fixture: before[id] });
  }
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
  await expect(editor.locator(".preview-row .cell")).toHaveCount(8);
  await page.screenshot({ path: "test-results/look-random.png", fullPage: true });
  await editor.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(editor).toHaveCount(0);
  const mine = ((await api(page, "look.list", { brief: false })) as { id: string; technique: { kind: string; random?: boolean }; move?: { shape: string; shuffle?: boolean } }[]).find((l) => l.id === "hasard")!;
  expect(mine.technique).toMatchObject({ kind: "palette", random: true });
  expect(mine.move).toMatchObject({ shape: "aleatoire", shuffle: true });
  await api(page, "look.delete", { id: "hasard", force: true });
  expect(errors).toEqual([]);
});

test("settings: DJ software connected over OS2L, its tempo and its buttons", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const status = (await api(page, "os2l.status")) as { port: number };
  const before = (await api(page, "tempo.get")) as { bpm: number; source: string };
  await api(page, "tempo.set", { source: "manual" }); // the server starts on the MIDI clock, silent here: the DJ would take over anyway
  const { connect } = await import("node:net");
  const dj = connect(status.port, "127.0.0.1");
  await new Promise((r) => dj.once("connect", r));
  await page.locator("nav.pages button", { hasText: "Réglages" }).click();
  const section = page.locator(".os2l");
  await expect(section).toContainText(`:${status.port}`); // the address to give VirtualDJ
  dj.write(JSON.stringify({ evt: "beat", change: true, pos: 1, bpm: 127, strength: 0.4 }));
  dj.write(JSON.stringify({ evt: "btn", name: "breath", state: "on" }));
  await expect(section).toContainText("127.0 BPM", { timeout: 6000 });
  await expect(section).toContainText("breath (on)");
  await expect.poll(async () => ((await api(page, "tempo.get")) as { source: string }).source).toBe("os2l");
  await expect.poll(async () => ((await api(page, "look.list")) as { id: string; active: boolean }[]).find((l) => l.id === "breath")?.active).toBe(true);
  dj.destroy();
  await api(page, "look.stopall");
  await api(page, "tempo.set", { bpm: before.bpm, source: before.source });
  expect(errors).toEqual([]);
});

test("AbleSet: followed from the MIDI page, says when it does not answer", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.locator("nav.pages button", { hasText: "MIDI" }).click();
  const follow = page.getByLabel("Suivre AbleSet");
  await follow.click();
  await expect(follow).toBeChecked();
  await expect(page.locator(".ableset")).toContainText("AbleSet ne répond pas"); // none on the test machine
  expect(((await api(page, "ableset.status")) as { enabled: boolean }).enabled).toBe(true);
  await follow.click();
  await expect(follow).not.toBeChecked();
  expect(((await api(page, "ableset.status")) as { enabled: boolean }).enabled).toBe(false);
  expect(errors).toEqual([]);
});

test("AbleSet answering: a song is sent there from the Chants page", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  // a fake AbleSet on the test server's AbleSet port: its heartbeat to whoever subscribes, and the jumps it gets
  const { createSocket } = await import("node:dgram");
  const { decodeOsc, encodeOsc } = await import("../../src/plugins/light/osc/codec.js");
  const ableset = createSocket("udp4");
  const jumps: string[] = [];
  let beat: NodeJS.Timeout | undefined;
  ableset.on("message", (buf, rinfo) => {
    for (const m of decodeOsc(buf)) {
      if (m.address === "/setlist/jumpToSong") jumps.push(String(m.args[0] as string | number));
      if (m.address !== "/subscribe" || beat) continue;
      const arg = m.args[1];
      const port = typeof arg === "number" ? arg : (arg as { value: number }).value;
      beat = setInterval(() => ableset.send(encodeOsc({ address: "/heartbeat", args: [] }), port, rinfo.address), 500);
    }
  });
  await new Promise<void>((r) => ableset.bind(39999, "127.0.0.1", r));
  try {
    await api(page, "ableset.configure", { enabled: true, host: "127.0.0.1" });
    await page.locator("nav.pages button", { hasText: "Chants" }).click();
    const send = page.getByRole("button", { name: "AbleSet Chant test" });
    await expect(send).toBeVisible({ timeout: 8000 });
    await send.click();
    await expect.poll(() => jumps).toEqual(["Chant test"]);
  } finally {
    if (beat) clearInterval(beat);
    ableset.close();
    await api(page, "ableset.configure", { enabled: false });
  }
  expect(errors).toEqual([]);
});

test("a DJ's numbered command (OS2L) mapped to the grand master, from the MIDI page", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.locator("nav.pages button", { hasText: "MIDI" }).click();
  await page.getByRole("button", { name: "+ Nouveau mapping" }).click();
  const editor = page.locator(".mapping-editor");
  await editor.getByLabel("Source").selectOption("os2l");
  await expect(editor.getByLabel("Canal")).toHaveCount(0); // a DJ command has no MIDI channel
  await editor.getByLabel("Commande DJ n° (0-127)").fill("7");
  await editor.getByLabel("Action").selectOption("grandmaster");
  await editor.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.locator(".midi table tr", { hasText: "DJ (OS2L) n° 7" })).toBeVisible();
  const { port } = (await api(page, "os2l.status")) as { port: number };
  const { connect } = await import("node:net");
  const dj = connect(port, "127.0.0.1");
  await new Promise((r) => dj.once("connect", r));
  try {
    dj.write(JSON.stringify({ evt: "cmd", id: 7, param: 0.25 }));
    await expect.poll(async () => Math.round(((await api(page, "show.settings")) as { grandMaster: number }).grandMaster * 100)).toBe(25);
  } finally {
    dj.destroy();
    await api(page, "grandmaster.set", { level: 1 });
    const mapping = ((await api(page, "midi.mapping.list")) as { id: string; input: { port?: string } }[]).find((m) => m.input.port === "OS2L");
    if (mapping) await api(page, "midi.mapping.delete", { id: mapping.id });
  }
  expect(errors).toEqual([]);
});

test("MIDI page: the RTP-MIDI sessions of the network, joined, kept, or by address", async ({ page }) => {
  const errors = watchErrors(page);
  // the network is played by the test: no Bonjour, no session leaves this machine
  const sent: [string, unknown][] = [];
  await page.route("**/api/plugins/light/commands/midi.status", async (route) => {
    const real = (await (await route.fetch()).json()) as { result: { rtp: object; profileConfig: { rtp: object } } };
    real.result.rtp = { enabled: true, port: 5006, wanted: 5004, peers: [] };
    real.result.profileConfig.rtp = { enabled: true, port: 5004, name: "light-mcp-server" };
    await route.fulfill({ json: real });
  });
  await page.route("**/api/plugins/light/commands/midi.rtp.sessions", (route) =>
    route.fulfill({
      json: {
        ok: true,
        result: {
          sessions: [
            { name: "light-mcp-server", host: "regie", address: "192.0.2.9", port: 5006, connected: false, kept: false, self: true },
            { name: "iPad de scène", host: "ipad", address: "192.0.2.21", port: 5004, connected: false, kept: false, self: false },
            // an interface announcing a session per port: folded
            ...[1, 2, 3, 4, 5].map((n) => ({ name: `Interface-0${n}`, host: "interface", address: "192.0.2.40", port: 5002 + 2 * n, connected: false, kept: false, self: false })),
          ],
        },
      },
    }),
  );
  for (const name of ["midi.rtp.connect", "midi.rtp.keep", "midi.rtp.disconnect"])
    await page.route(`**/api/plugins/light/commands/${name}`, (route) => (sent.push([name, route.request().postDataJSON()]), route.fulfill({ json: { ok: true, result: {} } })));
  await login(page);
  await page.locator("nav.pages button", { hasText: "MIDI" }).first().click();
  const panel = page.locator("section.rtp");
  await expect(panel).toContainText("Session de la régie « light-mcp-server » · port 5006");
  await expect(panel).toContainText("le port 5004 est pris");
  const iface = panel.locator("details.rtp-device");
  await expect(iface.locator("summary")).toContainText("interface 192.0.2.40 · 5 session(s)");
  await expect(iface.getByRole("listitem").first()).toBeHidden(); // folded until opened
  await iface.locator("summary").click();
  await expect(iface.getByRole("listitem")).toHaveCount(5);
  await expect(panel.getByRole("listitem")).toHaveCount(6); // this stage's own session is not offered
  await expect(panel.locator(".rtp-device", { hasText: "iPad de scène" })).toContainText("ipad 192.0.2.21 · 1 session(s)");
  const ipad = panel.getByRole("listitem").filter({ hasText: "iPad de scène" });
  await expect(ipad).toContainText(":5004");
  await ipad.getByRole("button", { name: "Connecter" }).click();
  await expect.poll(() => sent.length).toBe(1);
  await ipad.getByRole("checkbox", { name: "toujours" }).click(); // shown as the server says: the (played) network keeps it unticked
  await expect.poll(() => sent.length).toBe(2);
  await panel.getByLabel("adresse:port").fill("192.0.2.30:5008");
  await panel.getByRole("button", { name: "Connecter" }).last().click();
  await expect.poll(() => sent.length).toBe(3);
  expect(sent).toEqual([
    ["midi.rtp.connect", { name: "iPad de scène" }],
    ["midi.rtp.connect", { name: "iPad de scène", keep: true }],
    ["midi.rtp.connect", { address: "192.0.2.30", port: 5008 }],
  ]);
  await page.screenshot({ path: "test-results/midi-rtp.png", fullPage: true });
  expect(errors).toEqual([]);
});

test("settings: choose a universe's outputs, Art-Net, sACN, DMX USB", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.locator("nav.pages button", { hasText: "Réglages" }).click();
  const row = page.locator(".routes .route", { hasText: "Univers 2" });
  const artnet = page.getByLabel("Univers 2 · Art-Net");
  await expect(artnet).toHaveValue("1");
  await expect(page.getByLabel("Univers 2 · sACN")).toHaveCount(0); // not ticked: no field
  await artnet.fill("5");
  await row.getByRole("checkbox", { name: "sACN" }).check();
  await expect(page.getByLabel("Univers 2 · sACN")).toHaveValue("2"); // offered: the same number
  // a route saved with targets is sent to the chosen nodes only; the one chosen is listed, even unseen
  await expect(row.getByRole("radio", { name: "nodes choisies" })).toBeChecked();
  await expect(row.locator(".send-nodes li", { hasText: "127.0.0.2" })).toContainText("pas vue sur le réseau");
  await expect(row.getByRole("checkbox", { name: /127\.0\.0\.2/ })).toBeChecked();
  await row.screenshot({ path: "test-results/settings-route-nodes.png" });
  const asked: string[] = [];
  page.on("dialog", (d) => (asked.push(d.message()), void d.accept()));
  await row.getByRole("button", { name: "Enregistrer" }).click();
  await expect.poll(async () => ((await api(page, "output.status")) as { config: { routes: unknown[] } }).config.routes[1]).toEqual({ universe: 2, artnet: { portAddress: 5, send: "nodes", targets: ["127.0.0.2"] }, sacn: { universe: 2 } });
  expect(asked[0]).toContain("tout de suite");
  await expect(row.getByRole("button", { name: "Enregistrer" })).toHaveCount(0);
  // DMX USB only: Art-Net and sACN unticked, the (fake) FTDI interface ticked, as a USB Pro
  await row.getByRole("checkbox", { name: "Art-Net" }).uncheck();
  await row.getByRole("checkbox", { name: "sACN" }).uncheck();
  await row.getByRole("checkbox", { name: "DMX USB" }).check();
  await expect(page.getByLabel("Univers 2 · DMX USB")).toHaveValue(/usbserial-TEST1/);
  await page.getByLabel("Univers 2 · type d'interface").selectOption("pro");
  await row.getByRole("button", { name: "Enregistrer" }).click();
  await expect.poll(async () => ((await api(page, "output.status")) as { config: { routes: { usb?: { kind: string } }[] } }).config.routes[1]).toEqual({ universe: 2, usb: { path: expect.stringMatching(/usbserial-TEST1$/), kind: "pro" } });
  await expect(page.locator("ul.usb li")).toContainText(/usbserial-TEST1 \(USB Pro\) · envoie$/);
  await page.screenshot({ path: "test-results/settings-routes.png", fullPage: true });
  // back as it was, by the command
  await api(page, "output.route", { universe: 2, artnet: { portAddress: 1 }, sacn: null, usb: null });
  await expect(artnet).toHaveValue("1");
  await expect(page.locator("ul.usb")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("settings: a banner says when an Art-Net route reaches nobody, and offers broadcast first, then the node found", async ({ page }) => {
  const errors = watchErrors(page);
  // output.status is given what a dead target looks like (the test server has no node, and loopback sends never fail)
  await page.route("**/api/plugins/light/commands/output.status", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { result: { coverage: object; destinations: { universe: number; artnet?: string[] }[] } };
    body.result.coverage = { ...body.result.coverage, misdirected: [{ universe: 1, portAddress: 0, targets: ["127.0.0.2"], nodes: [{ key: "198.51.100.7#0", ip: "198.51.100.7", shortName: "Node scène" }] }] };
    // universe 2 goes to a broadcast address the network refuses: the loopback /8 one (127.0.0.255 is a host there)
    body.result.destinations = body.result.destinations.map((d) => (d.universe === 2 ? { ...d, artnet: ["127.255.255.255"] } : d));
    Object.assign(body.result, {
      sendHealth: { windowSeconds: 10, hosts: [{ host: "127.0.0.2", sends: 100, errors: 90, failing: true }, { host: "127.255.255.255", sends: 50, errors: 50, failing: true }] },
      outOfSubnet: ["198.51.100.7"],
    });
    await route.fulfill({ response: res, json: body });
  });
  const routed: unknown[] = [];
  await page.route("**/api/plugins/light/commands/output.route", async (route) => {
    routed.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true, result: {} } }); // the machine config stays as it is
  });
  const asked: string[] = [];
  page.on("dialog", (d) => (asked.push(d.message()), void d.accept()));
  await login(page);
  await page.locator("nav.pages button", { hasText: "Réglages" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Art-Net" })).toHaveCount(2);
  const banner = page.locator(".reach", { hasText: "Univers 1" }); // its two reasons in one banner
  await expect(banner).toHaveAttribute("role", "status");
  await expect(banner).toContainText("Univers 1 → Art-Net 0");
  await expect(banner).toContainText("les envois vers 127.0.0.2 échouent");
  await expect(banner.locator("small[aria-live=off]")).toContainText("(sur 100, 90 en erreur"); // the counters stay out of the live region
  await expect(banner).toContainText("cette adresse ne répond plus");
  await expect(banner).toContainText("la node répond peut-être depuis 198.51.100.7");
  await banner.screenshot({ path: "test-results/settings-reach.png" });
  // broadcast first, as the primary action; the node found after it, marked out of this machine's subnet
  const actions = banner.getByRole("button");
  await expect(actions.first()).toHaveText("Passer en broadcast");
  await expect(actions.first()).toHaveClass(/primary/);
  await expect(actions.nth(1)).toContainText("Recibler vers la node Node scène (198.51.100.7)");
  await expect(actions.nth(1)).toContainText("hors du sous-réseau");
  await actions.nth(1).click();
  await expect.poll(() => routed.length).toBe(1);
  expect(routed[0]).toEqual({ universe: 1, artnet: { portAddress: 0, send: "nodes", targets: ["198.51.100.7"] } });
  expect(asked[0]).toContain("vers 198.51.100.7"); // the confirmation names the IP aimed at
  await actions.first().click();
  await expect.poll(() => routed.length).toBe(2);
  expect(routed[1]).toEqual({ universe: 1, artnet: { portAddress: 0, send: "broadcast" } });
  expect(asked[1]).toContain("tout le réseau");
  // a broadcast address failing: the network refuses the sends, and broadcast is no way out
  const refused = page.locator(".reach", { hasText: "Univers 2" });
  await expect(refused).toContainText("le réseau refuse les envois vers 127.255.255.255");
  await expect(refused).not.toContainText("la node répond peut-être");
  await expect(refused.getByRole("button", { name: "Passer en broadcast" })).toHaveCount(0);
  expect(asked.length).toBe(2); // each change of the machine config is confirmed first
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
  // the song's intentions are picked (T15b: stored by id, shown by label)
  const moods = editor.locator(".theme-picker").getByRole("searchbox");
  for (const word of ["joie", "louange"]) {
    await moods.fill(word);
    await moods.press("Enter");
  }
  await expect(editor.locator(".theme-chips .chip")).toHaveText([/Joie/, /Louange/]);
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

test("venue plan: several fixtures chosen, moved together, lined up and spread, on a magnetic grid", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  type Fx = { id: string; position?: { x: number; y: number; z: number } };
  const before = (await api(page, "venue.fixture.list")) as Fx[];
  const at = async (id: string) => ((await api(page, "venue.fixture.list")) as Fx[]).find((f) => f.id === id)!.position!;
  const put = (id: string, position: { x: number; y: number; z: number }) => api(page, "venue.fixture.put", { fixture: { ...before.find((f) => f.id === id)!, position } });
  await put("bar-0", { x: -2, y: 3, z: 0.2 });
  await put("bar-1", { x: 1, y: 2.5, z: 0.2 });
  await put("spot", { x: 3, y: 1, z: 4 });
  const fx = (id: string) => page.locator(`.stage-plan g.fixture[data-fixture="${id}"] rect`).first();
  const centre = async (id: string) => {
    const body = page.locator(`.stage-plan g.fixture[data-fixture="${id}"] > g`).first(); // all its heads
    await body.scrollIntoViewIfNeeded();
    const b = (await body.boundingBox())!;
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  const dragBy = async (from: { x: number; y: number }, dx: number, dy: number) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + dx, from.y + dy, { steps: 6 });
    await page.mouse.up();
  };
  try {
    await page.locator("nav.pages button", { hasText: "Lieu" }).click();
    await page.getByLabel("Placer les projecteurs").check();
    await page.getByLabel("Grille").selectOption("0.5");
    await page.getByLabel("Aligner sur les autres").uncheck();
    // the plan in the middle of the screen: where the earlier tests leave the scroll, a fixture may
    // sit right under the sticky header, and a drag upwards would end on the header
    await page.evaluate('document.querySelector(".stage-plan")?.scrollIntoView({ block: "center" })');
    // a click chooses one, Shift adds another
    await fx("bar-0").click();
    await fx("bar-1").click({ modifiers: ["Shift"] });
    await expect(page.locator(".place-panel")).toContainText("2 projecteurs choisis");
    expect(await at("bar-0")).toEqual({ x: -2, y: 3, z: 0.2 }); // a click moves nothing
    await page.getByRole("button", { name: "Même profondeur" }).click();
    await expect.poll(async () => [(await at("bar-0")).y, (await at("bar-1")).y]).toEqual([2.75, 2.75]);
    // dragged together: the one held lands on the 50 cm grid, the other keeps its place beside it
    await dragBy(await centre("bar-1"), 70, 0);
    await expect.poll(async () => (await at("bar-1")).x).toBeGreaterThan(1);
    const [b0, b1] = [await at("bar-0"), await at("bar-1")];
    expect((b1.x * 2) % 1).toBe(0);
    expect(b1.y).toBe(3); // 2.75 on the grid
    expect([b0.x, b0.y, b0.z]).toEqual([b1.x - 3, 3, 0.2]);
    // with the guides: the spot, dragged near bar-1's column, is held on it
    await page.getByLabel("Aligner sur les autres").check();
    await fx("spot").click();
    const [spot, bar1] = [await centre("spot"), await centre("bar-1")];
    await dragBy(spot, bar1.x - spot.x + 3, -30);
    await expect.poll(async () => (await at("spot")).x).toBe(b1.x);
    // a frame drawn on the stage chooses all three; spread across, then nudged upstage by a grid step
    // from outside the fixtures' own boxes (their hit area included), whatever size the plan is drawn at
    const boxes = await Promise.all(["bar-0", "bar-1", "spot"].map(async (id) => (await page.locator(`.stage-plan g.fixture[data-fixture="${id}"]`).first().boundingBox())!));
    const [left, top] = [Math.min(...boxes.map((b) => b.x)) - 20, Math.min(...boxes.map((b) => b.y)) - 20];
    const [right, bottom] = [Math.max(...boxes.map((b) => b.x + b.width)) + 20, Math.max(...boxes.map((b) => b.y + b.height)) + 20];
    await dragBy({ x: left, y: top }, right - left, bottom - top);
    await expect(page.locator(".place-panel")).toContainText("3 projecteurs choisis");
    await page.getByRole("button", { name: "Répartir en largeur" }).click();
    await expect.poll(async () => (await at("bar-1")).x).not.toBe(b1.x);
    const xs = [(await at("bar-0")).x, (await at("spot")).x, (await at("bar-1")).x].sort((a, b) => a - b);
    expect(Math.abs(xs[1]! - (xs[0]! + xs[2]!) / 2)).toBeLessThan(0.011); // evenly spaced
    const depth = (await at("bar-0")).y;
    await page.keyboard.press("ArrowUp");
    await expect.poll(async () => (await at("bar-0")).y).toBe(depth + 0.5);
    await page.screenshot({ path: "test-results/venue-plan-chosen.png", fullPage: true });
    await page.keyboard.press("Escape");
    await expect(page.locator(".place-panel")).toContainText("Clic : choisir");
    await page.getByLabel("Placer les projecteurs").uncheck();
  } finally {
    for (const f of before) await api(page, "venue.fixture.put", { fixture: f });
  }
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
  // the point fields opened above the pad: it moved, measure it again
  const r2 = (await pad.boundingBox())!;
  await page.mouse.click(r2.x + r2.width * 0.75, r2.y + r2.height * 0.2);
  // the mark is the position really sent: wait for the gesture to reach the head
  await expect.poll(async () => Math.round((((await api(page, "position.list")) as { id: string; sent: { pan: number } | null }[]).find((h) => h.id === "spot")?.sent?.pan ?? 0) * 100)).toBe(75);
  await box.getByRole("button", { name: /Enregistrer ce repère/ }).click();
  await expect(box.getByRole("button", { name: /Enregistrer ce repère/ })).toContainText("(2)");
  await box.getByRole("button", { name: "Calculer" }).click();
  await expect(box.locator(".report")).toContainText("yaw");
  await page.screenshot({ path: "test-results/calibration.png", fullPage: true });
  page.once("dialog", (d) => void d.accept()); // random aiming: a large error, confirmation asked
  await box.getByRole("button", { name: "Appliquer" }).click();
  await expect.poll(async () => ((await api(page, "venue.fixture.list")) as { id: string; orientation?: { yaw: number } }[]).find((f) => f.id === "spot")?.orientation).toBeTruthy();
  // the tests after this one find the head as it was: its orientation solved here comes from a random aiming
  await api(page, "venue.fixture.put", { fixture: spot });
  await api(page, "position.release", { fixtures: ["spot"] });
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
  // the engine's Reset protection reads as words, without a conflict badge nor its name twice
  const builtin = panel.locator("table.rules tr", { hasText: "Protection du canal Reset" });
  await expect(builtin).toContainText("canaux à plage Reset");
  await expect(builtin).toContainText("tenus au repos");
  await expect(builtin).not.toContainText("{");
  await expect(builtin).not.toContainText("(intégrée)");
  await expect(builtin.locator(".badge.conflict")).toHaveCount(0);
  await expect(builtin.locator(".rule-notes")).toContainText("Règle du moteur, ni supprimable ni modifiable"); // its notes written, not only hovered
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
  await expect(editor).toContainText("n'éteint jamais"); // the chosen mode explains itself
  await page.screenshot({ path: "test-results/midi-mapping-editor.png" });
  await editor.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.locator(".midi table tr", { hasText: "hole" })).toBeVisible();
  // reverse search: play the note, the list keeps only what it plays
  const rows = page.locator(".midi table tr");
  await page.getByRole("button", { name: /Écouter une entrée/ }).click();
  await expect(page.getByRole("button", { name: /J'écoute/ })).toBeVisible();
  await api(page, "midi.in", { port: "Web MIDI · test", bytes: [0x90, 50, 100] });
  await expect(page.locator(".heard")).toContainText("note 50 · ch1");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("hole");
  await page.screenshot({ path: "test-results/midi-reverse-search.png" });
  // an unmapped note says so, and offers to map it
  await page.getByRole("button", { name: /Écouter une entrée/ }).click();
  await expect(page.getByRole("button", { name: /J'écoute/ })).toBeVisible();
  await api(page, "midi.in", { port: "Web MIDI · test", bytes: [0x90, 51, 100] });
  await expect(page.locator(".heard")).toContainText("rien n'est mappé");
  await page.getByRole("button", { name: "+ La mapper" }).click();
  await expect(page.locator(".mapping-editor").getByLabel("Note / CC")).toHaveValue("51");
  await page.locator(".mapping-editor").getByRole("button", { name: "Fermer" }).click();
  await page.getByRole("button", { name: "Revoir tous les mappings" }).click();
  await expect(rows.filter({ hasText: "hole" })).toBeVisible();
  await expect.poll(() => rows.count()).toBeGreaterThan(1);
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
  await editor.getByLabel("Nom", { exact: true }).fill("Strobes");
  // the same channel on every bar: the bars shown by a search, then « Strobe » ticked everywhere
  await editor.getByLabel("Chercher (nom ou adresse)").fill("bar");
  await editor.getByLabel("Même canal partout").selectOption("Strobe");
  await editor.getByRole("button", { name: "Cocher partout" }).click();
  await expect(editor.getByText("2 canal(aux) pilotés")).toBeVisible();
  await editor.getByLabel("Dosé par le DCA").selectOption("master");
  await editor.getByLabel("Borne supérieure").fill("200"); // as QLC+'s value range
  // smoothed: the output glides to the fader, 10 ms per step (a full travel in 2.55 s), eased
  await editor.getByLabel("Lissage").selectOption("10");
  await expect(editor.getByText("0 → 100 % en 2,6 s")).toBeVisible();
  await editor.getByLabel("Courbe").selectOption("ease");
  await editor.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(editor).toHaveCount(0);
  const saved = ((await api(page, "fader.list")) as { id: string; channels: unknown[]; dca?: string; range?: unknown; smoothing?: unknown }[]).find((f) => f.id === "strobes")!;
  expect(saved.dca).toBe("master");
  expect(saved.range).toEqual({ min: 0, max: 200 });
  expect(saved.smoothing).toEqual({ curve: "ease", msPerStep: 10 });
  expect(saved.channels).toEqual([
    { fixture: "bar-0", offset: 1 },
    { fixture: "bar-1", offset: 1 },
  ]);
  await page.getByRole("button", { name: "Modifier Strobes" }).click();
  await expect(page.locator(".fader-editor").getByLabel("Bar 0 · 002:Strobe")).toBeChecked(); // opened on what it drives
  page.once("dialog", (d) => void d.accept());
  await page.locator(".fader-editor").getByRole("button", { name: "Supprimer" }).click();
  await expect(page.locator("tr", { hasText: "Strobes" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("channel fader editor: a function picked by name narrows the fader to it (T12)", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.locator("nav.pages button", { hasText: "Show" }).click();
  await page.getByRole("button", { name: "+ Nouveau fader de canaux" }).click();
  const editor = page.locator(".fader-editor");
  const picker = editor.locator(".function-picker");
  await editor.getByLabel("Nom", { exact: true }).fill("Roue lyre");
  await expect(picker).toHaveCount(0); // no channel ticked yet: nothing to pick from
  await editor.getByLabel("Chercher (nom ou adresse)").fill("Lyre");
  await editor.getByLabel("Même canal partout").selectOption("Color Wheel");
  await editor.getByRole("button", { name: "Cocher partout" }).click();
  // the wheel's functions as buttons, found by a search that ignores case and dash kind
  await expect(picker.getByRole("status")).toHaveText("toute la course (0–255)");
  await picker.getByRole("searchbox", { name: "Chercher une fonction (gobo, macro…)" }).fill("red (16-31)");
  await expect(picker.locator(".function-list button")).toHaveCount(2); // the whole travel, and Red
  await picker.getByRole("button", { name: "Red (16–31)" }).click();
  await expect(editor.getByLabel("Borne inférieure")).toHaveValue("16");
  await expect(editor.getByLabel("Borne supérieure")).toHaveValue("31");
  await expect(picker.getByRole("status")).toHaveText("Red (16–31) — le fader parcourt cette fonction seulement");
  await expect(picker.getByRole("button", { name: "Red (16–31)" })).toHaveAttribute("aria-pressed", "true");
  // a limit typed by hand: an emptied field stays empty while typing, « 20 » is not « 020 », and it applies
  // when the field is left — the range becomes custom; « 300 » is brought to 255, not cut to its « 30 »
  const low = editor.getByLabel("Borne inférieure");
  await low.fill("");
  await expect(low).toHaveValue("");
  await low.fill("20");
  await expect(low).toHaveValue("20");
  await low.blur();
  await expect(picker.getByRole("status")).toHaveText("intervalle sur mesure");
  const high = editor.getByLabel("Borne supérieure");
  await high.fill("300");
  await high.blur();
  await expect(high).toHaveValue("255");
  await picker.getByRole("button", { name: "Red (16–31)" }).click();
  await editor.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(editor).toHaveCount(0);
  const saved = ((await api(page, "fader.list")) as { id: string; range?: unknown }[]).find((f) => f.id === "roue-lyre")!;
  expect(saved.range).toEqual({ min: 16, max: 31 });
  // reopened it names the function; « the whole travel » takes it back off
  await page.getByRole("button", { name: "Modifier Roue lyre" }).click();
  const again = page.locator(".fader-editor .function-picker");
  await expect(again.getByRole("status")).toHaveText("Red (16–31) — le fader parcourt cette fonction seulement");
  await again.getByRole("button", { name: "Toute la course (0–255)" }).click();
  await expect(page.locator(".fader-editor").getByLabel("Borne supérieure")).toHaveValue("255");
  // a second channel without that function: the single range would bound it too, and it is named
  await again.getByRole("button", { name: "Red (16–31)" }).click();
  await page.locator(".fader-editor").getByLabel("Chercher (nom ou adresse)").fill("bar");
  await page.locator(".fader-editor").getByLabel("Même canal partout").selectOption("Strobe");
  await page.locator(".fader-editor").getByRole("button", { name: "Cocher partout" }).click();
  await expect(page.locator(".fader-editor .function-picker").getByRole("alert")).toContainText("Bar 0 · Strobe");
  page.once("dialog", (d) => void d.accept());
  await page.locator(".fader-editor").getByRole("button", { name: "Supprimer" }).click();
  await expect(page.locator("tr", { hasText: "Roue lyre" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("venue plan: the selected fixture's pad keeps sending after its first gesture", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page, "9999");
  type Fx = { id: string; position?: { x: number; y: number; z: number } };
  const spot = ((await api(page, "venue.fixture.list")) as Fx[]).find((f) => f.id === "spot")!;
  await api(page, "venue.fixture.put", { fixture: { ...spot, position: { x: 0, y: 1, z: 4 } } });
  const manual = async () => ((await api(page, "position.list")) as { id: string; manual: { pan: number; tilt: number } | null }[]).find((h) => h.id === "spot")?.manual;
  try {
    await page.locator("nav.pages button", { hasText: "Lieu" }).click();
    await page.evaluate('document.querySelector(".stage-plan")?.scrollIntoView({ block: "center" })');
    const body = page.locator('.stage-plan g.fixture[data-fixture="spot"] > g').first();
    const box = (await body.boundingBox())!;
    for (const [fx, fy] of [[0.85, 0.85], [0.15, 0.85], [0.85, 0.15], [0.15, 0.15]]) {
      await body.click({ position: { x: box.width * fx!, y: box.height * fy! }, timeout: 1500 }).catch(() => undefined);
      if (await page.locator(".fixture-panel").isVisible()) break;
    }
    const pad = page.locator(".fixture-panel .xy .pad");
    await pad.scrollIntoViewIfNeeded();
    const p = (await pad.boundingBox())!;
    expect(p.height).toBeGreaterThan(p.width * 0.8); // square: tilt as fine as pan
    // three gestures in a row: each one reaches the head (only the first did, the send loop got stuck)
    for (const [x, y] of [[0.2, 0.8], [0.8, 0.2], [0.5, 0.5]]) {
      await page.mouse.click(p.x + p.width * x!, p.y + p.height * y!);
      await expect.poll(async () => Math.round(((await manual())?.pan ?? -1) * 10)).toBe(Math.round(x! * 10));
    }
  } finally {
    await api(page, "position.release", { fixtures: ["spot"] });
    await api(page, "venue.fixture.put", { fixture: spot });
  }
  expect(errors).toEqual([]);
});

test("show page: the Panic fallback goes from a snapshot back to a look, then to none", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const snap = (await api(page, "snapshot.save", { name: "Secours essai" })) as { id: string };
  type S = { safeSnapshot?: string; safeLook?: string };
  const settings = async () => (await api(page, "show.settings")) as S;
  try {
    await page.locator("nav.pages button", { hasText: "Show" }).click();
    const fallback = page.locator("select").filter({ has: page.locator(`option[value="snapshot:${snap.id}"]`) }).first();
    await fallback.selectOption(`snapshot:${snap.id}`);
    await expect.poll(async () => (await settings()).safeSnapshot).toBe(snap.id);
    await fallback.selectOption("look:checker");
    await expect.poll(async () => { const s = await settings(); return [s.safeSnapshot ?? null, s.safeLook ?? null]; }).toEqual([null, "checker"]);
    await fallback.selectOption("");
    await expect.poll(async () => { const s = await settings(); return [s.safeSnapshot ?? null, s.safeLook ?? null]; }).toEqual([null, null]);
    await expect(fallback).toHaveValue("");
  } finally {
    await api(page, "show.settings.set", { safeSnapshot: null, safeLook: null });
    await api(page, "snapshot.delete", { id: snap.id, force: true });
  }
  expect(errors).toEqual([]);
});

test("show page: the startup snapshot is chosen, badged in the table, then cleared", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const snap = (await api(page, "snapshot.save", { name: "Demarrage essai" })) as { id: string };
  const settings = async () => (await api(page, "show.settings")) as { startupSnapshot?: string };
  try {
    await page.locator("nav.pages button", { hasText: "Show" }).click();
    const select = page.getByTestId("startup-snapshot");
    await select.selectOption(snap.id);
    await expect.poll(async () => (await settings()).startupSnapshot).toBe(snap.id);
    await expect(page.locator(".snapshots tr", { hasText: "Demarrage essai" })).toContainText("démarrage");
    await select.selectOption("");
    await expect.poll(async () => (await settings()).startupSnapshot).toBeUndefined();
    await expect(page.locator(".snapshots tr", { hasText: "Demarrage essai" })).not.toContainText("démarrage");
  } finally {
    await api(page, "show.settings.set", { startupSnapshot: null });
    await api(page, "snapshot.delete", { id: snap.id });
  }
  expect(errors).toEqual([]);
});

test("faders on chosen fixtures and channels (found by address), dosing the dimmer, under one DCA", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  // whatever happens, the next tests find the bars lit: no fader left dosing their dimmers
  try {
    await api(page, "look.stopall");
    await page.locator("nav.pages button", { hasText: "Show" }).click();
    // « Bords »: the first bar's dimmer
    await page.getByRole("button", { name: "+ Nouveau fader de canaux" }).click();
    let editor = page.locator(".fader-editor");
    await expect(editor.locator(".fixture-row", { hasText: "Bar 0" })).toContainText("U1 · 001"); // where it is patched
    await editor.getByLabel("Nom", { exact: true }).fill("Bords");
    await editor.getByRole("button", { name: "Déplier Bar 0" }).click();
    await expect(editor.locator(".channel-row", { hasText: "001:Dimmer" })).toContainText("DMX 1");
    await editor.getByLabel("Bar 0 · 001:Dimmer").check();
    await editor.getByRole("button", { name: "Enregistrer", exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect.poll(async () => (await dmx(page))[0]).toBe(0); // at 0 the bar is dark: the fader doses its dimmer
    // « Centre rouge »: the second bar's dimmer and its first red
    await page.getByRole("button", { name: "+ Nouveau fader de canaux" }).click();
    editor = page.locator(".fader-editor");
    await editor.getByLabel("Nom", { exact: true }).fill("Centre rouge");
    await editor.getByLabel("Chercher (nom ou adresse)").fill("016"); // found by its start address
    await expect(editor.locator(".fixture-row")).toHaveCount(1);
    await editor.getByRole("button", { name: "Déplier Bar 1" }).click();
    await editor.getByLabel("Bar 1 · 001:Dimmer").check();
    await editor.getByLabel("Bar 1 · 004:R1").check();
    await expect(editor.getByText("2 canal(aux) pilotés")).toBeVisible();
    await editor.screenshot({ path: "test-results/fader-tree.png" });
    await editor.getByRole("button", { name: "Enregistrer", exact: true }).click();
    await expect(editor).toHaveCount(0);
    // one DCA over both faders, chosen from the DCA
    await page.getByRole("button", { name: "+ Nouveau groupe" }).click();
    const group = page.locator(".group-editor");
    await group.getByLabel("Nom", { exact: true }).fill("Barres");
    await group.getByLabel("Bords").check();
    await group.getByLabel("Centre rouge").check();
    await group.screenshot({ path: "test-results/dca-faders.png" });
    await group.getByRole("button", { name: "Enregistrer", exact: true }).click();
    await expect(group).toHaveCount(0);
    const faders = (await api(page, "fader.list")) as { id: string; dca?: string }[];
    expect(faders.filter((f) => f.dca === "barres").map((f) => f.id).sort()).toEqual(["bords", "centre-rouge"]);
    await api(page, "fader.level", { id: "bords", level: 1 });
    await api(page, "fader.level", { id: "centre-rouge", level: 1 });
    await api(page, "group.level", { id: "barres", level: 0.5 });
    await expect.poll(async () => { const d = await dmx(page); return [d[0], d[15], d[18]].map((v) => Math.round(v! / 10)); }).toEqual([13, 13, 26]); // both dimmers at ½; the second bar's red at its fader's full, its dimmer carrying the DCA once (T35)
    // unticked from the DCA: the fader no longer follows it
    await page.getByRole("button", { name: "Modifier Barres" }).click();
    await page.locator(".group-editor").getByLabel("Centre rouge").uncheck();
    await page.locator(".group-editor").getByRole("button", { name: "Enregistrer", exact: true }).click();
    await expect.poll(async () => ((await api(page, "fader.list")) as { id: string; dca?: string }[]).find((f) => f.id === "centre-rouge")!.dca).toBeUndefined();
  } finally {
    for (const id of ["bords", "centre-rouge"]) await api(page, "fader.delete", { id, force: true }).catch(() => undefined);
    await api(page, "group.delete", { id: "barres", force: true }).catch(() => undefined);
  }
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
  // its own tempo, whatever the tests before left (a MIDI clock keeps its last tempo)
  const before = (await api(page, "tempo.get")) as { source: string };
  await api(page, "tempo.set", { bpm: 120, source: "manual" });
  await page.locator("nav.pages button", { hasText: "Import" }).click();
  await page.getByLabel("Mesurer aussi la cadence").check();
  await page.getByRole("button", { name: "Lancer l'auto-test" }).click();
  const table = page.locator("table.cadence");
  await expect(table).toBeVisible({ timeout: 40_000 });
  await expect(table.locator("caption")).toContainText("120 BPM");
  expect(await table.locator("tr").count()).toBeGreaterThanOrEqual(4);
  await expect(table.locator("tr.error")).toHaveCount(0);
  await page.screenshot({ path: "test-results/selftest-cadence.png", fullPage: true });
  await api(page, "tempo.set", { source: before.source });
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
  // a bar stood up, facing the audience: it stands in the face view, its four heads one above the other
  await panel.getByRole("button", { name: "┃ verticale" }).click();
  await expect.poll(async () => ((await facing()).orientation as { roll?: number } | undefined)?.roll).toBe(90);
  await expect(panel.getByRole("button", { name: "┃ verticale" })).toHaveAttribute("aria-pressed", "true");
  const cells = bar.locator("g rect:not(.selection):not(.strobe-outline):not(.bar-outline)");
  await expect(cells).toHaveCount(1); // from above, only its top
  await page.getByRole("button", { name: "Face", exact: true }).click();
  await expect(cells).toHaveCount(4);
  await expect(bar.locator("g[transform^='rotate(-90']")).toHaveCount(1);
  const [first, last] = [(await cells.first().boundingBox())!, (await cells.last().boundingBox())!];
  expect(first.y).toBeGreaterThan(last.y); // its first head at the bottom
  await page.screenshot({ path: "test-results/orient-standing-bar.png", fullPage: true });
  await panel.getByRole("button", { name: "━ horizontale" }).click();
  await expect.poll(async () => ((await facing()).orientation as { roll?: number } | undefined)?.roll).toBe(0);
  await page.getByRole("button", { name: "Dessus", exact: true }).click();
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
  const row = (name: string) => page.locator("#venue-patch tr", { hasText: name }).getByRole("checkbox", { name: /canevas/ });
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

test("venue plan: the selected fixture's panel creates a channel fader at the first touch and sends the last value", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page, "9999");
  type Fx = { id: string; position?: { x: number; y: number; z: number } };
  type Fader = { id: string; name: string; channels: { fixture: string; offset: number }[]; level: number };
  const spot = ((await api(page, "venue.fixture.list")) as Fx[]).find((f) => f.id === "spot")!;
  await api(page, "venue.fixture.put", { fixture: { ...spot, position: { x: 0, y: 1, z: 4 } } }); // mid-stage: clear of the sticky header once scrolled to
  const ours = async () => ((await api(page, "fader.list")) as Fader[]).filter((f) => f.id.startsWith("panel-spot-"));
  try {
    await page.locator("nav.pages button", { hasText: "Lieu" }).click();
    const body = page.locator('.stage-plan g.fixture[data-fixture="spot"] > g').first();
    await body.scrollIntoViewIfNeeded();
    const box = (await body.boundingBox())!;
    // inside the body but off its centre: the beam arrow an earlier test's orientation left starts there
    const spots = [[0.85, 0.85], [0.15, 0.85], [0.85, 0.15], [0.15, 0.15]].map(([fx, fy]) => ({ x: box.width * fx!, y: box.height * fy! }));
    for (const position of spots) {
      await body.click({ position, timeout: 1500 }).catch(() => undefined);
      if (await page.locator(".fixture-panel").isVisible()) break;
    }
    const panel = page.locator(".fixture-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("slider", { name: "Fader de canaux Pan", exact: true })).toHaveCount(0); // pan and tilt move by the pad
    const dimmer = panel.getByRole("slider", { name: "Fader de canaux Dimmer", exact: true });
    await dimmer.fill("500");
    await dimmer.press("ArrowUp");
    await dimmer.press("ArrowUp");
    // one fader of exactly this channel, at the last value of the gesture
    await expect.poll(async () => (await ours()).map((f) => [f.channels.length, f.name, f.level])).toEqual([[1, "Panneau Lyre · Dimmer", 0.502]]);
    await dimmer.press("ArrowDown");
    await expect.poll(async () => (await ours()).map((f) => f.level)).toEqual([0.501]); // the same fader follows
    await panel.getByRole("button", { name: /Ranger le panneau/ }).click();
    await expect(panel).toBeHidden();
  } finally {
    for (const f of await ours()) await api(page, "fader.delete", { id: f.id, force: true });
    await api(page, "venue.fixture.put", { fixture: spot });
  }
  expect(errors).toEqual([]);
});

test("venue patch: a moving head's pan and tilt are inverted from its menu, and the patch shows it", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page, "9999");
  type Fx = { id: string; orientation?: { invertPan?: boolean; invertTilt?: boolean } };
  const spot = ((await api(page, "venue.fixture.list")) as Fx[]).find((f) => f.id === "spot")!;
  const inverted = async () => {
    const o = ((await api(page, "venue.fixture.list")) as Fx[]).find((f) => f.id === "spot")!.orientation;
    return [Boolean(o?.invertPan), Boolean(o?.invertTilt)];
  };
  try {
    await page.locator("nav.pages button", { hasText: "Lieu" }).click();
    const row = page.locator("tr", { hasText: "Lyre" }).filter({ has: page.locator("td") }).first();
    await row.click({ button: "right" });
    const menu = page.getByRole("dialog", { name: "Réglages de l'appareil", exact: true });
    const pan = menu.getByRole("button", { name: "Inverser X (pan)", exact: true });
    await expect(pan).toHaveAttribute("aria-pressed", "false");
    await pan.click();
    await expect.poll(inverted).toEqual([true, false]);
    await expect(pan).toHaveAttribute("aria-pressed", "true");
    await menu.getByRole("button", { name: "Inverser Y (tilt)", exact: true }).click();
    await expect.poll(inverted).toEqual([true, true]);
    await expect(row.locator(".badge.invert")).toHaveText("⇄ X·Y");
    await pan.click();
    await expect.poll(inverted).toEqual([false, true]); // one axis at a time: the other one kept
    await expect(row.locator(".badge.invert")).toHaveText("⇄ Y");
  } finally {
    await api(page, "venue.fixture.put", { fixture: spot });
  }
  expect(errors).toEqual([]);
});

test("venue patch: a lamp's colour wheel is corrected from its menu, for the model then for this fixture", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page, "9999");
  type Settings = { slots?: Record<string, { color?: string; answers?: string[]; off?: boolean }> } | null;
  type Wheel = { applies: string; model: Settings; own: Settings };
  const wheel = async () => (await api(page, "venue.wheel.get", { id: "spot" })) as Wheel;
  try {
    await page.locator("nav.pages button", { hasText: "Lieu" }).click();
    await page.locator("tr", { hasText: "Lyre" }).filter({ has: page.locator("td") }).first().click({ button: "right" });
    const menu = page.getByRole("dialog", { name: "Réglages de l'appareil", exact: true });
    await menu.getByRole("button", { name: "Roue de couleurs…" }).click();
    const editor = menu.getByRole("group", { name: "Roue de couleurs…" });
    // every range of the wheel channel: white, red, green, blue, amber, and the rainbow, which has no colour yet
    await expect(editor.locator(".wheel-slots li")).toHaveCount(6);
    await expect(editor.locator(".wheel-slots li").last()).toContainText("sans couleur dans la définition");
    await expect(editor.locator(".wheel-head")).toHaveText("CaseCouleur réelleRépond aussi àExclue"); // the columns are named, not left to tooltips
    // the same scope names as « Têtes et halo… », and the help in clear
    const scopes = editor.getByRole("radiogroup", { name: "S'applique à" });
    await expect(scopes.getByRole("radio", { name: "Ce modèle" })).toHaveAttribute("aria-checked", "true");
    await expect(editor).toContainText("ceux d'un appareil remplacent en bloc ceux du modèle");
    // dragging in the colour picker saves nothing: only the colour chosen in the end is saved, once
    const add = editor.getByLabel("Ajouter une couleur à laquelle cette case répond · Amber");
    await page.evaluate(`(() => {
      const el = document.querySelector('input[aria-label="Ajouter une couleur à laquelle cette case répond · Amber"]');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      for (let i = 0; i < 20; i++) {
        set.call(el, "#ff00" + i.toString(16).padStart(2, "0"));
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    })()`);
    await page.waitForTimeout(300);
    expect((await wheel()).model).toBe(null);
    await add.fill("#ff0000"); // the picker closes: `change`
    await expect.poll(async () => (await wheel()).model?.slots?.["64"]?.answers).toEqual(["#ff0000"]);
    await expect(editor).toContainText("S'applique : les réglages du modèle");
    // an answer just removed can be added again (the picker went back to its start colour)
    await editor.getByRole("button", { name: "Retirer #ff0000 · Amber" }).click();
    await expect.poll(async () => (await wheel()).model?.slots?.["64"]?.answers).toBe(undefined);
    await add.fill("#ff0000");
    await expect.poll(async () => (await wheel()).model?.slots?.["64"]?.answers).toEqual(["#ff0000"]);
    // a slot's real colour: marked as modified, and ↺ brings back the definition's
    await editor.getByLabel("Couleur réelle de la case · Red").fill("#ee1111");
    await expect.poll(async () => (await wheel()).model?.slots?.["16"]?.color).toBe("#ee1111");
    const red = editor.locator(".wheel-slots li", { hasText: "Red" });
    await expect(red).toContainText("modifiée");
    await red.getByRole("button", { name: "Revenir à la couleur de la définition · Red" }).click();
    await expect.poll(async () => (await wheel()).model?.slots?.["16"]).toBe(undefined);
    await expect(red).not.toContainText("modifiée");
    // the rainbow given its real colour becomes a slot
    // a range without colour can be given white (its picker starts on a neutral grey)
    await editor.getByLabel("Couleur réelle de la case · Rainbow").fill("#ffffff");
    await expect.poll(async () => (await wheel()).model?.slots?.["80"]?.color).toBe("#ffffff");
    await editor.getByRole("button", { name: "Revenir à la couleur de la définition · Rainbow" }).click();
    await expect.poll(async () => (await wheel()).model?.slots?.["80"]).toBe(undefined);
    await editor.getByLabel("Couleur réelle de la case · Rainbow").fill("#8000ff");
    await expect.poll(async () => (await wheel()).model?.slots?.["80"]?.color).toBe("#8000ff");
    await editor.getByRole("button", { name: "Revenir à la couleur de la définition · Rainbow" }).click();
    await expect.poll(async () => (await wheel()).model?.slots?.["80"]).toBe(undefined);
    // the scope radios move with the arrow keys (roving tabindex)
    await expect(scopes.getByRole("radio", { name: "Cet appareil seul" })).toHaveAttribute("tabindex", "-1");
    await scopes.getByRole("radio", { name: "Ce modèle" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(scopes.getByRole("radio", { name: "Cet appareil seul" })).toBeFocused();
    await expect(scopes.getByRole("radio", { name: "Cet appareil seul" })).toHaveAttribute("aria-checked", "true");
    // this fixture only: said to start from the model's settings, and its own replace them
    await expect(editor).toContainText("cet appareil ne suivra plus le modèle");
    const off = editor.getByRole("button", { name: "Jamais choisie depuis une couleur peinte · White" });
    await expect(off).toContainText("Exclue"); // a visible label, not a bare glyph
    await off.click();
    await expect.poll(async () => (await wheel()).own?.slots).toEqual({ "0": { off: true }, "64": { answers: ["#ff0000"] } });
    await expect(editor).toContainText("S'applique : les réglages de cet appareil");
    await expect(editor).not.toContainText("cet appareil ne suivra plus le modèle");
    await page.screenshot({ path: "test-results/venue-wheel-editor.png" });
    // clearing asks in the menu itself, and gives the focus back to the scope
    let dialogs = 0;
    page.on("dialog", (d) => (dialogs++, void d.dismiss()));
    await editor.getByRole("button", { name: "Effacer ces réglages" }).click();
    const ask = editor.getByRole("group", { name: "Effacer ces réglages" });
    await expect(ask).toContainText("Effacer les réglages de cet appareil ?");
    await expect(ask.getByRole("button", { name: "Annuler" })).toBeFocused(); // the safe answer holds the focus
    await ask.getByRole("button", { name: "Annuler" }).click();
    await expect(scopes.getByRole("radio", { name: "Cet appareil seul" })).toBeFocused();
    expect((await wheel()).applies).toBe("fixture");
    await editor.getByRole("button", { name: "Effacer ces réglages" }).click();
    await ask.getByRole("button", { name: "Effacer", exact: true }).click();
    await expect.poll(async () => (await wheel()).applies).toBe("model");
    await expect(scopes.getByRole("radio", { name: "Cet appareil seul" })).toBeFocused();
    await expect(editor.getByRole("button", { name: "Effacer ces réglages" })).toHaveCount(0); // nothing of its own left to clear
    expect(dialogs).toBe(0);
  } finally {
    await api(page, "venue.wheel.clear", { id: "spot", scope: "fixture" });
    await api(page, "venue.wheel.clear", { id: "spot", scope: "model" });
  }
  expect(errors).toEqual([]);
});

test("venue patch: fadeable tracks are enabled on a fixture and ticked for its model, then for it alone (T5)", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page, "9999");
  type Tracks = { enabled: boolean; applies: string; own: string[] | null; model: { fade: string[] | null } };
  const tracks = async () => (await api(page, "venue.tracks.get", { fixture: "spot" })) as Tracks;
  try {
    await page.locator("nav.pages button", { hasText: "Lieu" }).click();
    const row = page.locator("tr", { hasText: "Lyre" }).filter({ has: page.locator("td") }).first();
    await row.click({ button: "right" });
    const menu = page.getByRole("dialog", { name: "Réglages de l'appareil", exact: true });
    await menu.getByRole("button", { name: "Transitions…" }).click();
    const editor = menu.getByRole("group", { name: "Transitions…" });
    // nothing ticked at first, the tracks off: the usual engine, said in clear
    await expect(editor.getByRole("status")).toContainText("Rien de coché : tous les canaux sautent");
    await expect(editor).toContainText("comportement habituel du moteur");
    await expect(editor.getByRole("checkbox", { name: "Dimmer" })).not.toBeChecked();
    // pan and tilt can be ticked, and say what the box does (the motion layer reads it); the wheel has no box
    await expect(editor.getByRole("group", { name: "Position" })).toContainText("coché, l'axe glisse");
    await expect(editor.getByRole("checkbox", { name: "Pan", exact: true })).toBeVisible();
    await expect(editor.getByRole("checkbox", { name: "Color Wheel" })).toHaveCount(0);
    await expect(editor).toContainText("la roue change de case à mi-fondu, ou au noir");
    // enabled on the fixture: saved, and the patch shows it
    await editor.getByRole("button", { name: "Pistes activées sur cet appareil" }).click();
    await expect.poll(async () => (await tracks()).enabled).toBe(true);
    await expect(editor.getByRole("button", { name: "Pistes activées sur cet appareil" })).toHaveAttribute("aria-pressed", "true");
    await expect(row.locator(".badge.tracks")).toBeVisible();
    // for the model (the default scope): the shortcut ticks the intensity
    await expect(editor.getByRole("radio", { name: "Ce modèle" })).toHaveAttribute("aria-checked", "true");
    await editor.getByRole("button", { name: "Cocher l'intensité" }).click();
    await expect.poll(async () => (await tracks()).model.fade).toEqual(["Dimmer"]);
    await expect(editor.getByRole("checkbox", { name: "Dimmer" })).toBeChecked();
    await expect(editor.getByRole("button", { name: "Décocher l'intensité" })).toBeVisible(); // the shortcut now unticks
    await expect(editor).toContainText("S'applique : la liste du modèle");
    await expect(editor.getByRole("status")).toContainText("Les canaux cochés suivent les fondus");
    // for this fixture only: it starts from the model's list, then keeps its own
    await editor.getByRole("radio", { name: "Cet appareil seul" }).click();
    await expect(editor).toContainText("copie la liste du modèle");
    await editor.getByRole("checkbox", { name: "Shutter" }).check();
    await expect.poll(async () => (await tracks()).own).toEqual(["Dimmer", "Shutter"]);
    await expect(editor).toContainText("S'applique : la liste de cet appareil");
    await page.screenshot({ path: "test-results/venue-tracks-editor.png" });
    // back to the model: its own list goes, the tracks stay enabled
    await editor.getByRole("button", { name: "Revenir au modèle" }).click();
    await expect.poll(async () => [(await tracks()).own, (await tracks()).applies, (await tracks()).enabled]).toEqual([null, "model", true]);
    await expect(editor.getByRole("checkbox", { name: "Shutter" })).not.toBeChecked();
    await expect(editor.getByRole("radio", { name: "Cet appareil seul" })).toBeFocused(); // the keyboard is not lost
    // switched off: the list stays, and can still be ticked
    await editor.getByRole("button", { name: "Pistes activées sur cet appareil" }).click();
    await expect.poll(async () => (await tracks()).enabled).toBe(false);
    await expect(row.locator(".badge.tracks")).toHaveCount(0);
    await expect(editor.getByRole("checkbox", { name: "Dimmer" })).toBeChecked();
    // two quick clicks switch on then off: the second one flips what the first asked, not what the page still shows
    const asked: unknown[] = [];
    page.on("request", (r) => void (r.url().endsWith("/commands/venue.tracks.put") && asked.push((r.postDataJSON() as { enabled?: boolean }).enabled)));
    await editor.getByRole("button", { name: "Pistes activées sur cet appareil" }).dblclick();
    await expect.poll(() => asked).toEqual([true, false]);
    await expect.poll(async () => (await tracks()).enabled).toBe(false);
    await expect(editor.getByRole("button", { name: "Pistes activées sur cet appareil" })).toHaveAttribute("aria-pressed", "false");
  } finally {
    await api(page, "venue.tracks.put", { fixtures: ["spot"], enabled: false, fade: null });
    await api(page, "venue.tracks.clear", { fixture: "spot", scope: "model" });
  }
  expect(errors).toEqual([]);
});

test("venue patch: the tracks editor warns of a colour a channel fader holds, and its switches follow what was asked (T5)", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page, "9999");
  const ids = ["tracks-par-a", "tracks-par-b"];
  type Tracks = { enabled: boolean; model: { enabled: string[] } };
  const tracks = async (fixture: string) => (await api(page, "venue.tracks.get", { fixture })) as Tracks;
  for (const [i, id] of ids.entries()) await api(page, "venue.fixture.put", { fixture: modePar({ id, name: i ? "Par pistes B" : "Par pistes A", address: 300 + 10 * i }) });
  // a channel fader on the red of the first one
  await api(page, "fader.put", { fader: { id: "tracks-red", name: "Rouge", channels: [{ fixture: ids[0], offset: 1 }], level: 0 } });
  try {
    await page.locator("nav.pages button", { hasText: "Lieu" }).click();
    const row = page.locator("tr", { hasText: "Par pistes A" }).filter({ has: page.locator("td") }).first();
    await row.click({ button: "right" });
    const menu = page.getByRole("dialog", { name: "Réglages de l'appareil", exact: true });
    await menu.getByRole("button", { name: "Transitions…" }).click();
    const editor = menu.getByRole("group", { name: "Transitions…" });
    const own = editor.getByRole("button", { name: "Pistes activées sur cet appareil" });
    // off, the boxes are not dimmed: they still work
    await expect(editor.locator(".tracks-groups.off")).toHaveCSS("opacity", "1");
    // the dimmer fades and the colours jump: the fader's red would go dark as a look comes in — said, with its channel
    await expect(editor.getByRole("note")).toHaveCount(0);
    await editor.getByRole("button", { name: "Cocher l'intensité" }).click();
    await expect(editor.getByRole("note")).toContainText("Un fader de canal tient Red");
    await expect(editor.getByRole("note")).toContainText("Cocher toutes les couleurs l'évite");
    await page.screenshot({ path: "test-results/venue-tracks-fader-warning.png" });
    await editor.getByRole("button", { name: "Cocher la couleur" }).click();
    await expect(editor.getByRole("note")).toHaveCount(0);
    // the warning reads the list the fixture follows, not the one being edited: with a list of its own where a colour
    // is unticked, it stays while the model's list (every colour ticked) is the one shown
    await editor.getByRole("radio", { name: "Cet appareil seul" }).click();
    await editor.getByRole("checkbox", { name: "Green" }).uncheck();
    await expect(editor.getByRole("note")).toContainText("Un fader de canal tient Red");
    await editor.getByRole("radio", { name: "Ce modèle" }).click();
    await expect(editor.getByRole("checkbox", { name: "Green" })).toBeChecked();
    await expect(editor.getByRole("note")).toContainText("Un fader de canal tient Red");
    // and the model's list changed does not bring it back once the fixture's own list is fine
    await editor.getByRole("button", { name: "Revenir au modèle" }).click();
    await expect(editor.getByRole("note")).toHaveCount(0);
    await editor.getByRole("radio", { name: "Cet appareil seul" }).click();
    await editor.getByRole("checkbox", { name: "Speed" }).check();
    await editor.getByRole("radio", { name: "Ce modèle" }).click();
    await editor.getByRole("checkbox", { name: "Green" }).uncheck();
    await expect(editor.getByRole("checkbox", { name: "Green" })).not.toBeChecked();
    await expect(editor.getByRole("note")).toHaveCount(0);
    await editor.getByRole("checkbox", { name: "Green" }).check();
    await editor.getByRole("button", { name: "Revenir au modèle" }).click();
    // the whole model switched on, then this fixture at once: it goes off (the model's switch asked it on), the other stays on
    const asked: unknown[] = [];
    page.on("request", (r) => void (r.url().endsWith("/commands/venue.tracks.put") && asked.push((r.postDataJSON() as { enabled?: boolean }).enabled)));
    await editor.getByRole("button", { name: "Activer sur les 2 appareils de ce modèle" }).click();
    await own.click();
    await expect.poll(() => asked.filter((x) => x !== undefined)).toEqual([true, false]);
    await expect.poll(async () => [(await tracks(ids[0]!)).enabled, (await tracks(ids[1]!)).enabled]).toEqual([false, true]);
    await expect(own).toHaveAttribute("aria-pressed", "false");
    await expect(editor.getByRole("button", { name: "Activer sur les 2 appareils de ce modèle" })).toBeVisible();
    // the switch shows what was asked before the answer is back
    await page.route("**/commands/venue.tracks.put", async (route) => {
      await new Promise((r) => setTimeout(r, 600));
      await route.continue();
    });
    await own.click();
    await expect(own).toHaveAttribute("aria-pressed", "true", { timeout: 400 });
    await expect.poll(async () => (await tracks(ids[0]!)).enabled).toBe(true);
    await expect(own).toHaveAttribute("aria-pressed", "true");
    await page.unroute("**/commands/venue.tracks.put");
  } finally {
    await api(page, "venue.tracks.clear", { fixture: ids[0], scope: "model" }).catch(() => undefined);
    await api(page, "fader.delete", { id: "tracks-red" }).catch(() => undefined);
    for (const id of ids) await api(page, "venue.fixture.delete", { id, force: true }).catch(() => undefined);
  }
  expect(errors).toEqual([]);
});

test("DMX console: a channel of a fixture with tracks says whether it follows the fades or jumps (T5)", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await api(page, "venue.tracks.put", { fixtures: ["spot"], enabled: true, fade: ["Dimmer"] });
  try {
    await page.getByRole("button", { name: "Console DMX" }).click();
    await page.locator("section.bar select").first().selectOption("2");
    // the spot sits at 2.1: Pan, Pan fine, Tilt, Tilt fine, Color Wheel, Dimmer (6), Shutter (7)
    await page.getByRole("button", { name: "Pourquoi ce canal 6", exact: true }).click();
    await expect(page.getByRole("region", { name: "Pourquoi ce canal 6", exact: true }).locator("li.why-track")).toHaveText("Pistes de l'appareil : suit les fondus");
    await page.getByRole("button", { name: "Pourquoi ce canal 7", exact: true }).click();
    await expect(page.getByRole("region", { name: "Pourquoi ce canal 7", exact: true }).locator("li.why-track")).toHaveText("Pistes de l'appareil : saute à mi-fondu");
  } finally {
    await api(page, "venue.tracks.put", { fixtures: ["spot"], enabled: false, fade: null });
  }
  expect(errors).toEqual([]);
});

test("DMX console: a colour wheel channel says its slot, the colour asked and the gap between them", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await api(page, "venue.canvas.put", { canvas: { id: "wheel-why", name: "Roue", topology: "line", cells: 1, render: [{ from: 0, to: 0, targets: [{ fixture: "spot", head: -1 }] }] } });
  await api(page, "look.put", { look: { id: "wheel-why", name: "Rose", canvas: "wheel-why", technique: { kind: "plat", color: "#ff3060" }, timing: { every: { beats: 1 }, attack: 0, order: "loop", entryFade: 0 } } });
  await api(page, "look.go", { id: "wheel-why" });
  try {
    await page.getByRole("button", { name: "Console DMX" }).click();
    await page.locator("section.bar select").first().selectOption("2");
    await page.getByRole("button", { name: "Pourquoi ce canal 5", exact: true }).click();
    const why = page.getByRole("region", { name: "Pourquoi ce canal 5", exact: true });
    const line = why.locator("li.why-wheel");
    await expect(line).toContainText(/Case Red \(#ff0000\) · demandé #ff3060 · écart 0,\d{3}/);
    await expect(line.locator(".swatch-dot")).toHaveCount(2);
    await expect(why).not.toContainText("Intensité"); // a wheel does not carry the level
    await page.screenshot({ path: "test-results/console-wheel-why.png" });
    await api(page, "look.stop", { id: "wheel-why" });
    await expect(line).toHaveText(/^Case Red \(#ff0000\)$/, { timeout: 5000 }); // nothing painted: the slot held, nothing asked
  } finally {
    await api(page, "look.stop", { id: "wheel-why" });
    await api(page, "look.delete", { id: "wheel-why", force: true });
    await api(page, "venue.canvas.delete", { id: "wheel-why", force: true });
  }
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

test("preview before launch: « Voir avant de lancer » is pressed by default with touch, not with a mouse", async ({ page, browser }) => {
  const errors = watchErrors(page);
  await login(page);
  await expect(page.getByRole("button", { name: "Voir avant de lancer" })).toHaveAttribute("aria-pressed", "false");
  const ctx = await browser.newContext({ hasTouch: true, viewport: { width: 820, height: 1180 }, baseURL: `http://127.0.0.1:${PORT}`, locale: "fr-FR" });
  const touchPage = await ctx.newPage();
  const touchErrors = watchErrors(touchPage);
  await login(touchPage);
  await expect(touchPage.getByRole("button", { name: "Voir avant de lancer" })).toHaveAttribute("aria-pressed", "true");
  await api(touchPage, "look.stopall");
  expect(touchErrors).toEqual([]);
  await ctx.close();
  await api(page, "look.stopall");
  expect(errors).toEqual([]);
});

test("preview before launch: with the mode on, opening then cancelling launches nothing", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.getByRole("button", { name: "Voir avant de lancer" }).click();
  await api(page, "look.stopall");
  const button = page.locator(".dgrid .cell button", { hasText: "hole" }).first();
  const active = async () => ((await api(page, "look.list", { brief: true })) as { id: string; active: boolean }[]).find((l) => l.id === "hole")!.active;
  await button.click();
  const sheet = page.getByRole("dialog", { name: "Aperçu avant lancement : hole" });
  await expect(sheet).toBeVisible();
  expect(await active()).toBe(false);
  await sheet.getByRole("button", { name: "Annuler" }).click();
  await expect(sheet).toHaveCount(0);
  expect(await active()).toBe(false);
  await button.click();
  await launchFromSheet(page, "hole");
  expect(await active()).toBe(true);
  await api(page, "look.stopall");
  expect(errors).toEqual([]);
});

test("preview before launch: Escape closes the sheet and launches nothing", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.getByRole("button", { name: "Voir avant de lancer" }).click();
  await api(page, "look.stopall");
  const button = page.locator(".dgrid .cell button", { hasText: "hole" }).first();
  const active = async () => ((await api(page, "look.list", { brief: true })) as { id: string; active: boolean }[]).find((l) => l.id === "hole")!.active;
  await button.click();
  const sheet = page.getByRole("dialog", { name: "Aperçu avant lancement : hole" });
  await expect(sheet).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  expect(await active()).toBe(false);
  await api(page, "look.stopall");
  expect(errors).toEqual([]);
});

test("preview before launch: a double tap is blocked by the 400 ms guard and leaves the sheet open", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.getByRole("button", { name: "Voir avant de lancer" }).click();
  await api(page, "look.stopall");
  const button = page.locator(".dgrid .cell button", { hasText: "hole" }).first();
  await button.click();
  const sheet = page.getByRole("dialog", { name: "Aperçu avant lancement : hole" });
  await expect(sheet).toBeVisible();
  const box = (await sheet.getByRole("button", { name: "Lancer" }).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.waitForTimeout(80);
  await page.mouse.click(x, y);
  await page.waitForTimeout(100);
  const active = async () => ((await api(page, "look.list", { brief: true })) as { id: string; active: boolean }[]).find((l) => l.id === "hole")!.active;
  expect(await active()).toBe(false);
  await expect(sheet).toBeVisible();
  await page.keyboard.press("Escape");
  await api(page, "look.stopall");
  expect(errors).toEqual([]);
});

test("preview before launch: stopping a playing look is immediate, with no sheet", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.getByRole("button", { name: "Voir avant de lancer" }).click();
  await api(page, "look.stopall");
  const button = page.locator(".dgrid .cell button", { hasText: "hole" }).first();
  await api(page, "look.go", { id: "hole" });
  await expect(button).toHaveClass(/on/);
  await button.click();
  const sheet = page.getByRole("dialog", { name: "Aperçu avant lancement : hole" });
  // stopping is immediate: no sheet opens
  await expect(sheet).toHaveCount(0);
  await expect.poll(async () => ((await api(page, "look.list", { brief: true })) as { id: string; active: boolean }[]).find((l) => l.id === "hole")!.active).toBe(false);
  await api(page, "look.stopall");
  expect(errors).toEqual([]);
});

test("preview before launch: Blackout opens no sheet", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.getByRole("button", { name: "Voir avant de lancer" }).click();
  await api(page, "look.stopall");
  const blackout = page.locator("button.blackout").first();
  await blackout.click();
  await expect(blackout).toHaveText("Blackout actif");
  await expect(page.getByRole("dialog", { name: /Aperçu avant lancement/ })).toHaveCount(0);
  await blackout.click(); // back out of blackout
  await expect(blackout).toHaveText("Blackout");
  await api(page, "look.stopall");
  expect(errors).toEqual([]);
});

test("preview before launch: a « À confirmer » look opens the sheet on the first press and never arms", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.getByRole("button", { name: "Voir avant de lancer" }).click();
  await api(page, "look.stopall");
  const cell = page.locator(".dgrid .cell", { has: page.locator("button", { hasText: "hole" }) }).first();
  const button = cell.locator("button");
  await button.click({ button: "right" });
  await page.getByRole("dialog", { name: "Réglages du widget" }).getByLabel("À confirmer (deux appuis)").check();
  try {
    await page.keyboard.press("Escape");
    await button.click();
    const sheet = page.getByRole("dialog", { name: "Aperçu avant lancement : hole" });
    await expect(sheet).toBeVisible();
    await expect(button).not.toContainText("Appuyer encore");
    await page.keyboard.press("Escape");
    await api(page, "look.stopall");
    // back to a plain button
    await button.click({ button: "right" });
    await page.getByRole("dialog", { name: "Réglages du widget" }).getByLabel("À confirmer (deux appuis)").uncheck();
    await page.keyboard.press("Escape");
    await expect.poll(async () => JSON.stringify(await api(page, "dashboard.list"))).not.toContain('"confirm"');
  } finally {
    await page.keyboard.press("Escape").catch(() => undefined);
    await button.click({ button: "right" }).catch(() => undefined);
    await page.getByRole("dialog", { name: "Réglages du widget" }).getByLabel("À confirmer (deux appuis)").uncheck().catch(() => undefined);
    await page.keyboard.press("Escape").catch(() => undefined);
    await expect.poll(async () => JSON.stringify(await api(page, "dashboard.list"))).not.toContain('"confirm"').catch(() => undefined);
  }
  expect(errors).toEqual([]);
});

test("preview before launch: a read-only role has its look button disabled and no sheet", async ({ page }) => {
  const errors = watchErrors(page);
  await page.addInitScript(() => localStorage.setItem("lookPreviewFirst", "true"));
  await login(page, "1357");
  const button = page.locator(".dgrid .cell button", { hasText: "hole" }).first();
  await expect(button).toBeDisabled();
  await button.click({ force: true });
  await expect(page.getByRole("dialog", { name: /Aperçu avant lancement/ })).toHaveCount(0);
  const active = async () => ((await api(page, "look.list", { brief: true })) as { id: string; active: boolean }[]).find((l) => l.id === "hole")!.active;
  expect(await active()).toBe(false);
  // cleanup as the token holder (the lecture role cannot stop looks; no new login screen needed)
  await page.evaluate(async () => {
    await fetch("/api/plugins/light/commands/look.stopall", { method: "POST", headers: { authorization: "Bearer ui-test-token", "content-type": "application/json" }, body: "{}" });
  });
  expect(errors).toEqual([]);
});

test("preview before launch: deleting the look while the sheet is open closes it", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.getByRole("button", { name: "Voir avant de lancer" }).click();
  await api(page, "look.stopall");
  const canvas = ((await api(page, "venue.canvas.list")) as { id: string }[])[0]!.id;
  const tempId = "preview-temp";
  await api(page, "look.put", { look: { id: tempId, name: "Temp", canvas, technique: { kind: "plat", color: "#00ff00" }, timing: { every: { beats: 1 }, attack: 0, order: "loop", entryFade: 0 } } });
  const dashboards = (await api(page, "dashboard.list")) as TestDashboard[];
  const dash = dashboards[0]!;
  const widget = dash.widgets.find((w) => w.kind === "look" && w.target === "hole")!;
  const backup = JSON.parse(JSON.stringify(dash)) as TestDashboard;
  const patched = JSON.parse(JSON.stringify(dash)) as TestDashboard;
  const pw = patched.widgets.find((x) => x.id === widget.id)!;
  pw.target = tempId;
  pw.label = "Temp";
  try {
    await api(page, "dashboard.put", { dashboard: patched });
    await page.reload();
    await expect(page.locator("header.top")).toBeVisible();
    const button = page.locator(".dgrid .cell button", { hasText: "Temp" }).first();
    await expect(button).toBeVisible();
    await button.click();
    const sheet = page.getByRole("dialog", { name: "Aperçu avant lancement : Temp" });
    await expect(sheet).toBeVisible();
    await api(page, "look.delete", { id: tempId, force: true });
    await expect(sheet).toHaveCount(0);
  } finally {
    await api(page, "dashboard.put", { dashboard: backup });
    await api(page, "look.delete", { id: tempId, force: true }).catch(() => undefined);
  }
  await api(page, "look.stopall");
  expect(errors).toEqual([]);
});

test("preview before launch: freezing a flashing look shows the frozen note", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await api(page, "look.stopall");
  const canvas = ((await api(page, "venue.canvas.list")) as { id: string }[])[0]!.id;
  const hole = (await api(page, "look.get", { id: "hole" })) as { canvas: string };
  const tempId = "preview-flash";
  await api(page, "look.put", { look: { id: tempId, name: "Flash", canvas: hole.canvas ?? canvas, technique: { kind: "pas", steps: [["#ffffff"], ["-"]] }, timing: { every: { seconds: 0.1 }, attack: 0, order: "loop", entryFade: 0 } } });
  const dashboards = (await api(page, "dashboard.list")) as TestDashboard[];
  const dash = dashboards[0]!;
  const widget = dash.widgets.find((w) => w.kind === "look" && w.target === "hole")!;
  const backup = JSON.parse(JSON.stringify(dash)) as TestDashboard;
  const patched = JSON.parse(JSON.stringify(dash)) as TestDashboard;
  const pw = patched.widgets.find((x) => x.id === widget.id)!;
  pw.target = tempId;
  pw.label = "Flash";
  try {
    await api(page, "dashboard.put", { dashboard: patched });
    await page.reload();
    await expect(page.locator("header.top")).toBeVisible();
    await page.getByRole("button", { name: "Voir avant de lancer" }).click(); // mode on (mouse default off)
    const flashBtn = page.locator(".dgrid .cell button", { hasText: "Flash" }).first();
    await expect(flashBtn).toBeVisible();
    // freeze off by default: no frozen note
    await flashBtn.click();
    const sheetOff = page.getByRole("dialog", { name: "Aperçu avant lancement : Flash" });
    await expect(sheetOff).toBeVisible();
    await expect(sheetOff.getByText("Aperçu figé : flashs rapides")).toHaveCount(0);
    // not frozen: the strip really flashes (several different colours in a third of a second)
    const seen = new Set<string>();
    for (let k = 0; k < 8; k++) {
      seen.add(await strip(sheetOff));
      await page.waitForTimeout(50);
    }
    expect(seen.size).toBeGreaterThan(1);
    await page.keyboard.press("Escape");
    // switch freeze on via toggle
    await page.getByRole("button", { name: "Aperçus sans flash" }).click();
    await expect(page.getByRole("button", { name: "Aperçus sans flash" })).toHaveAttribute("aria-pressed", "true");
    await flashBtn.click();
    const sheetOn = page.getByRole("dialog", { name: "Aperçu avant lancement : Flash" });
    await expect(sheetOn).toBeVisible();
    await expect(sheetOn.getByText("Aperçu figé : flashs rapides")).toBeVisible();
    // frozen: the same colours, whatever the time
    await page.waitForTimeout(150); // the first render draws nothing yet; then the first step, and no other
    const frozen = new Set<string>();
    for (let k = 0; k < 8; k++) {
      frozen.add(await strip(sheetOn));
      await page.waitForTimeout(50);
    }
    expect(frozen.size).toBe(1);
    await page.keyboard.press("Escape");
  } finally {
    await api(page, "dashboard.put", { dashboard: backup });
    await api(page, "look.delete", { id: tempId, force: true });
  }
  await api(page, "look.stopall");
  expect(errors).toEqual([]);
});

test("preview before launch: edit mode opens no sheet", async ({ page }) => {
  const errors = watchErrors(page);
  try {
    await login(page);
    await page.getByRole("button", { name: "Voir avant de lancer" }).click();
    await api(page, "look.stopall");
    await page.getByRole("button", { name: "✎" }).click();
    const button = page.locator(".dgrid .cell button", { hasText: "hole" }).first();
    await button.click({ force: true });
    await expect(page.getByRole("dialog", { name: /Aperçu avant lancement/ })).toHaveCount(0);
  } finally {
    const done = page.getByRole("button", { name: "✔" });
    if (await done.isVisible().catch(() => false)) await done.click().catch(() => undefined);
    await api(page, "look.stopall").catch(() => undefined);
  }
  expect(errors).toEqual([]);
});

test("preview before launch: focus returns to the button after closing the sheet", async ({ page }) => {
  const errors = watchErrors(page);
  try {
    await login(page);
    await page.getByRole("button", { name: "Voir avant de lancer" }).click();
    await api(page, "look.stopall");
    const button = page.locator(".dgrid .cell button", { hasText: "hole" }).first();
    const sheet = page.getByRole("dialog", { name: "Aperçu avant lancement : hole" });
    await button.click();
    await expect(sheet).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(button).toBeFocused();
    await button.click();
    await expect(sheet).toBeVisible();
    await sheet.getByRole("button", { name: "Annuler" }).click();
    await expect(sheet).toHaveCount(0);
    await expect(button).toBeFocused();
  } finally {
    await page.keyboard.press("Escape").catch(() => undefined);
    await api(page, "look.stopall").catch(() => undefined);
  }
  expect(errors).toEqual([]);
});

test("preview before launch: a trigger-mode button that is already playing opens no sheet", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await api(page, "look.stopall");
  const dashboards = (await api(page, "dashboard.list")) as TestDashboard[];
  const dash = dashboards[0]!;
  const widget = dash.widgets.find((w) => w.kind === "look" && w.target === "hole")!;
  const backup = JSON.parse(JSON.stringify(dash)) as TestDashboard;
  const patched = JSON.parse(JSON.stringify(dash)) as TestDashboard;
  const pw = patched.widgets.find((x) => x.id === widget.id)!;
  pw.mode = "trigger";
  try {
    await api(page, "dashboard.put", { dashboard: patched });
    await page.reload();
    await expect(page.locator("header.top")).toBeVisible();
    await page.getByRole("button", { name: "Voir avant de lancer" }).click();
    await api(page, "look.stopall");
    await api(page, "look.go", { id: "hole" });
    const button = page.locator(".dgrid .cell button", { hasText: "hole" }).first();
    await expect(button).toHaveClass(/on/);
    await button.click();
    await expect(page.getByRole("dialog", { name: /Aperçu avant lancement/ })).toHaveCount(0);
    await expect(button).toHaveClass(/on/);
    await api(page, "look.stopall");
    await expect.poll(async () => ((await api(page, "look.list", { brief: true })) as { id: string; active: boolean }[]).find((l) => l.id === "hole")!.active).toBe(false);
    await button.click();
    const sheet = page.getByRole("dialog", { name: "Aperçu avant lancement : hole" });
    await expect(sheet).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
  } finally {
    await api(page, "dashboard.put", { dashboard: backup }).catch(() => undefined);
    await api(page, "look.stopall").catch(() => undefined);
  }
  expect(errors).toEqual([]);
});

test("preview before launch: a momentary button opens no sheet", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await api(page, "look.stopall");
  const dashboards = (await api(page, "dashboard.list")) as TestDashboard[];
  const dash = dashboards[0]!;
  const widget = dash.widgets.find((w) => w.kind === "look" && w.target === "hole")!;
  const backup = JSON.parse(JSON.stringify(dash)) as TestDashboard;
  const patched = JSON.parse(JSON.stringify(dash)) as TestDashboard;
  const pw = patched.widgets.find((x) => x.id === widget.id)!;
  pw.mode = "momentary";
  try {
    await api(page, "dashboard.put", { dashboard: patched });
    await page.reload();
    await expect(page.locator("header.top")).toBeVisible();
    await page.getByRole("button", { name: "Voir avant de lancer" }).click();
    await api(page, "look.stopall");
    const button = page.locator(".dgrid .cell button", { hasText: "hole" }).first();
    const active = async () => ((await api(page, "look.list", { brief: true })) as { id: string; active: boolean }[]).find((l) => l.id === "hole")!.active;
    await button.hover();
    await page.mouse.down();
    await expect(page.getByRole("dialog", { name: /Aperçu avant lancement/ })).toHaveCount(0);
    await expect.poll(active).toBe(true);
    await page.mouse.up();
    await expect.poll(active).toBe(false);
  } finally {
    await api(page, "dashboard.put", { dashboard: backup }).catch(() => undefined);
    await api(page, "look.stopall").catch(() => undefined);
  }
  expect(errors).toEqual([]);
});

test("preview before launch: a confirm rule shows its native dialog after Lancer", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await api(page, "look.stopall");
  await api(page, "rule.put", { rule: { id: "demande", name: "Rouge demandé", level: "show", target: { color: "red" }, max: 128, onViolation: "confirm" } });
  try {
    await page.getByRole("button", { name: "Voir avant de lancer" }).click();
    await api(page, "look.stopall");
    const button = page.locator(".dgrid button.look", { hasText: "hole" }).first();
    const active = async () => ((await api(page, "look.list", { brief: true })) as { id: string; active: boolean }[]).find((l) => l.id === "hole")!.active;
    let asked = "";
    page.once("dialog", (d) => ((asked = d.message()), void d.accept()));
    await button.click();
    await launchFromSheet(page, "hole");
    await expect.poll(() => asked, { timeout: 10000 }).toContain("Rouge demandé"); // the rule's question, after Lancer
    await expect.poll(active, { timeout: 10000 }).toBe(true);
  } finally {
    await api(page, "rule.delete", { where: "show", id: "demande" });
    await api(page, "look.stopall");
  }
  expect(errors.filter((e) => !e.includes("status of 422"))).toEqual([]);
});

test("preview before launch: the preview toggle is absent for a read-only role", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page, "1357");
  await expect(page.getByRole("button", { name: "Voir avant de lancer" })).toHaveCount(0);
  await page.evaluate(async () => {
    await fetch("/api/plugins/light/commands/look.stopall", { method: "POST", headers: { authorization: "Bearer ui-test-token", "content-type": "application/json" }, body: "{}" });
  });
  expect(errors).toEqual([]);
});

test("accessibility: icon buttons have names, empty lists and searches say so, the keyboard focus shows", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  // Live: the song navigation is named, not only drawn
  await expect(page.getByRole("button", { name: "Chant précédent" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Chant suivant" })).toBeVisible();
  // the keyboard focus is an accent ring
  await page.getByRole("button", { name: "Chant suivant" }).focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  const outline = await page.evaluate<string>("getComputedStyle(document.activeElement).outlineStyle");
  expect(outline).toBe("solid");
  // OSC: each copy button names the address it copies; a search with no result says so
  await page.locator("nav.pages").getByRole("button", { name: "OSC" }).click();
  await expect(page.getByRole("button", { name: "Copier l'adresse /light/look/go" })).toBeVisible();
  await page.getByRole("searchbox", { name: "Rechercher" }).fill("zzz-nothing");
  await expect(page.getByText("Rien ne correspond à cette recherche.")).toBeVisible();
  // MIDI: the monitor says it has heard nothing yet
  await page.locator("nav.pages").getByRole("button", { name: "MIDI" }).click();
  await expect(page.locator("pre.monitor")).toContainText("Aucun message reçu");
  // Lieu: a fixture's box says what it does (the empty lists of the Show page: the empty-show tour)
  await page.locator("nav.pages").getByRole("button", { name: "Lieu" }).click();
  await expect(page.getByRole("checkbox", { name: /^Dans le nouveau canevas : / }).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("create by intention: search themes, pick two, add a free one, dry run, remove a chip (T14)", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.locator("nav.pages button", { hasText: "Show" }).click();
  const section = page.locator("section", { has: page.getByRole("heading", { name: "Créer un look par intention" }) });
  const picker = section.locator(".theme-picker");
  const search = picker.getByRole("searchbox", { name: "Chercher une thématique (intimité, fête…)" });
  const chips = picker.locator(".theme-chips .chip");
  await expect(picker.locator(".theme-list button").first()).toBeVisible(); // the knowledge base is listed
  await expect(section.getByRole("button", { name: "Proposition" })).toBeDisabled(); // nothing chosen yet
  // an accent-free query finds the accented label; the list shows label, swatches and family
  await search.fill("intimite");
  await expect(picker.locator(".theme-list button")).toHaveCount(1);
  const intimacy = picker.getByRole("button", { name: /^Intimité/ });
  await expect(intimacy.locator(".theme-swatches i").first()).toBeVisible();
  await expect(intimacy.locator(".theme-family")).toHaveText("froid");
  await intimacy.click();
  await expect(chips).toHaveText(["Intimité×"]);
  await expect(intimacy).toHaveAttribute("aria-pressed", "true");
  await search.fill("FETE");
  await picker.getByRole("button", { name: /^Fête/ }).click();
  await expect(chips).toHaveText(["Intimité×", "Fête×"]);
  // a word no theme matches is offered as a free one
  await search.fill("brume");
  await expect(picker.locator(".theme-list button")).toHaveCount(0);
  await picker.getByRole("button", { name: "Ajouter « brume »" }).click();
  await expect(chips).toHaveText(["Intimité×", "Fête×", "brume×"]);
  await expect(search).toHaveValue("");
  // the dry run sends the keys and reports the unknown word
  await section.getByRole("button", { name: "Proposition" }).click();
  const result = section.locator("ul.hint").last();
  await expect(result).toContainText("« Intimité »");
  await expect(result).toContainText("« Fête »");
  await expect(result.locator("li.warn")).toHaveText("? brume");
  // a chip is removed by its cross
  await picker.getByRole("button", { name: "Retirer Fête" }).click();
  await expect(chips).toHaveText(["Intimité×", "brume×"]);
  await expect(picker.getByRole("button", { name: /^Fête/ })).toHaveAttribute("aria-pressed", "false");
  expect(errors).toEqual([]);
});

test("a pad's arrow moves the head, not the fixture the plan is turning (Orienter)", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page, "9999");
  type Fx = { id: string; position?: { x: number; y: number; z: number }; orientation?: { yaw?: number } };
  const list = async () => (await api(page, "venue.fixture.list")) as Fx[];
  const spot = (await list()).find((f) => f.id === "spot")!;
  await api(page, "venue.fixture.put", { fixture: { ...spot, position: { x: 0, y: 1, z: 4 } } });
  const yaw = async () => (await list()).find((f) => f.id === "spot")?.orientation?.yaw ?? 0;
  const manual = async () => ((await api(page, "position.list")) as { id: string; manual: { pan: number; tilt: number } | null }[]).find((h) => h.id === "spot")?.manual;
  try {
    await page.locator("nav.pages button", { hasText: "Lieu" }).click();
    await page.getByLabel("Orienter").check();
    const body = page.locator('.stage-plan g.fixture[data-fixture="spot"] > g').first();
    await body.scrollIntoViewIfNeeded();
    const box = (await body.boundingBox())!;
    for (const [fx, fy] of [[0.85, 0.85], [0.15, 0.85], [0.85, 0.15], [0.15, 0.15]]) {
      await body.click({ position: { x: box.width * fx!, y: box.height * fy! }, timeout: 1500 }).catch(() => undefined);
      if (await page.locator(".fixture-panel").isVisible()) break;
    }
    const pad = page.locator(".fixture-panel .xy .pad");
    await expect(pad).toBeVisible();
    const before = await yaw();
    await pad.focus();
    await expect(pad).toHaveAttribute("aria-valuemin", "0");
    await expect(pad).toHaveAttribute("aria-valuemax", "100");
    await expect(pad).toHaveAttribute("aria-describedby", /.+/);
    await page.keyboard.press("ArrowLeft");
    await expect.poll(async () => (await manual())?.pan).toBe(0.49); // the pad moved the head by 1 %
    await expect(pad).toHaveAttribute("aria-valuenow", "49");
    await page.waitForTimeout(300);
    expect(await yaw()).toBe(before); // the plan did not turn the fixture
  } finally {
    await api(page, "position.release", { fixtures: ["spot"] });
    await api(page, "venue.fixture.put", { fixture: spot });
  }
  expect(errors).toEqual([]);
});

test("a refused look save stays on screen while the preview keeps refreshing", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.locator(".dgrid .cell button", { hasText: "hole" }).first().click({ button: "right" });
  await page.getByRole("dialog", { name: "Réglages du widget" }).getByRole("button", { name: "✎ Avancé" }).click();
  const editor = page.getByRole("dialog", { name: "hole" });
  await expect(editor.locator(".look-editor")).toBeVisible();
  await page.route("**/api/plugins/light/commands/look.put", (route) => route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ ok: false, error: "refus du test" }) }));
  await editor.getByRole("button", { name: "Enregistrer", exact: true }).click();
  const alert = editor.getByRole("alert");
  await expect(alert).toHaveText("refus du test");
  // a change of the draft re-runs the preview (debounced, 250 ms): its success must not wipe the save error
  await editor.getByLabel("Nom", { exact: true }).fill("hole bis");
  await page.waitForTimeout(900);
  await expect(alert).toHaveText("refus du test");
  expect(errors.filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
});

test("theme picker: a word inside a theme is still addable, Enter only adds, × is a touch target (T14)", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.locator("nav.pages button", { hasText: "Show" }).click();
  const picker = page.locator("section", { has: page.getByRole("heading", { name: "Créer un look par intention" }) }).locator(".theme-picker");
  const search = picker.getByRole("searchbox");
  const chips = picker.locator(".theme-chips .chip");
  await expect(picker.getByRole("list", { name: "Thématiques connues" })).toBeVisible();
  // « inti » is the start of a theme: Enter picks it; typed again, Enter does not remove it
  await search.fill("inti");
  await search.press("Enter");
  await expect(chips).toHaveText(["Intimité×"]);
  await search.fill("intimite");
  await search.press("Enter");
  await expect(chips).toHaveText(["Intimité×"]);
  // a word only contained in a label (« ange » in « Louange ») is offered as a free word
  await search.fill("ange");
  await expect(picker.getByRole("button", { name: "Ajouter « ange »" })).toBeVisible();
  await expect(picker.getByRole("button", { name: /^Louange/ })).toBeVisible();
  await search.press("Enter");
  await expect(chips).toHaveText(["Intimité×", "ange×"]);
  // the cross is at least 32 px square, and gives the focus back to the search field
  const cross = picker.getByRole("button", { name: "Retirer ange" });
  const b = (await cross.boundingBox())!;
  expect(Math.min(b.width, b.height)).toBeGreaterThanOrEqual(32);
  await cross.click();
  await expect(chips).toHaveText(["Intimité×"]);
  await expect(search).toBeFocused();
  await expect(picker.getByRole("status")).toContainText("Intimité");
  expect(errors).toEqual([]);
});

test("intentions: create one in the show, use it by intention, rename it, allow a duplicate label, touch up and hide a shipped one (T15, T15b)", async ({ page }) => {
  const errors = watchErrors(page);
  const asked: string[] = [];
  page.on("dialog", (d) => {
    asked.push(d.message());
    void d.accept();
  });
  await login(page);
  await page.locator("nav.pages button", { hasText: "Show" }).click();
  const section = page.locator("section.intentions");
  const list = section.getByRole("list", { name: "Intentions connues" });
  const row = (label: string) => list.locator("li", { has: page.locator("strong", { hasText: new RegExp(`^${label}$`) }) });
  const byIntent = page.locator("section", { has: page.getByRole("heading", { name: "Créer un look par intention" }) });
  const picker = byIntent.locator(".theme-picker");
  try {
    // a new one, stored in the show: two colours typed in hexadecimal, an energy, the live proposal
    await section.getByRole("button", { name: "➕ Nouvelle intention" }).click();
    const editor = page.getByRole("dialog", { name: "Nouvelle intention" });
    // a label over 80 characters is stopped as it is typed
    await editor.getByLabel("Libellé").fill("x".repeat(81));
    await expect(editor.getByText(/Libellé trop long/)).toBeVisible();
    await expect(editor.getByRole("button", { name: "Enregistrer" })).toBeDisabled();
    // the label of a shipped one: allowed, a second « Joie », said (T15b)
    await editor.getByLabel("Libellé").fill("Joie");
    await expect(editor.getByText(/Même libellé qu'une autre intention : Joie \(livrée\)/)).toBeVisible();
    await expect(editor.getByRole("button", { name: "Enregistrer" })).toBeEnabled();
    await editor.getByLabel("Libellé").fill("Lever de rideau");
    await expect(editor.getByText("Elle recevra un id à l'enregistrement : son libellé pourra changer sans rien casser.")).toBeVisible();
    await editor.getByLabel("Couleur 1, en hexadécimal").fill("#ff0000");
    await editor.getByRole("button", { name: "+ Couleur" }).click();
    await editor.getByLabel("Couleur 2, en hexadécimal").fill("0000ff");
    await editor.getByLabel("Énergie").selectOption("survolte");
    await expect(editor.locator(".intention-preview")).toContainText("« Lever de rideau »");
    await expect(editor.locator(".intention-preview")).toContainText("ΔE");
    await expect(editor.locator(".intention-preview li").first()).not.toContainText("—"); // no family: nothing said of it
    await expect(editor.getByRole("radio", { name: /ce show/ })).toBeChecked();
    await page.screenshot({ path: "test-results/intention-editor.png" });
    await editor.getByRole("button", { name: "Enregistrer" }).click();
    await expect(editor).toHaveCount(0);
    await section.screenshot({ path: "test-results/intentions.png" });
    await section.getByRole("searchbox").fill("rideau");
    await expect(row("Lever de rideau").locator(".badge")).toHaveText("ce show");
    await expect(row("Lever de rideau")).toContainText("survolté");
    // offered at once by « create a look by intention », marked as the show's
    await picker.getByRole("searchbox").fill("rideau");
    const theme = picker.getByRole("button", { name: /^Lever de rideau/ });
    await expect(theme.locator(".theme-origin")).toHaveText("ce show");
    await theme.click();
    await byIntent.getByRole("button", { name: "Proposition" }).click();
    await expect(byIntent.locator("ul.hint").last()).toContainText("« Lever de rideau »");
    await expect(byIntent.locator("ul.hint").last().locator("li").first()).not.toContainText("—");
    // its uses, one then two, said in words and listed when unfolded
    await api(page, "song.put", { song: { id: "t15-a", title: "Essai A", mood: ["lever de rideau"], sections: [] } });
    await expect(row("Lever de rideau").locator(".intention-uses summary")).toHaveText("1 usage");
    await api(page, "song.put", { song: { id: "t15-b", title: "Essai B", mood: ["Lever-de-rideau"], sections: [] } });
    await expect(row("Lever de rideau").locator(".intention-uses summary")).toHaveText("2 usages");
    await row("Lever de rideau").locator(".intention-uses summary").click();
    await expect(row("Lever de rideau").locator(".intention-uses li")).toHaveText(["chant « Essai A »", "chant « Essai B »"]);
    await api(page, "song.delete", { id: "t15-a" });
    await api(page, "song.delete", { id: "t15-b" });
    await expect(row("Lever de rideau")).toContainText("inutilisée");
    // edited: the label changes, the generated id stays (T15b)
    await row("Lever de rideau").getByRole("button", { name: "Modifier · Lever de rideau" }).click();
    const edit = page.getByRole("dialog", { name: "Lever de rideau" });
    await edit.getByLabel("Libellé").fill("Lever du rideau");
    await expect(edit.getByText(/^Id : i-[a-z0-9]+-[a-z0-9]{4} /)).toBeVisible();
    await expect(edit.getByRole("radio")).toHaveCount(0); // an edit keeps its place
    await edit.getByRole("button", { name: "Enregistrer" }).click();
    await expect(row("Lever du rideau")).toBeVisible();
    // opened again: the label it left is kept as a former one
    await row("Lever du rideau").getByRole("button", { name: "Modifier · Lever du rideau" }).click();
    const again = page.getByRole("dialog", { name: "Lever du rideau" });
    await expect(again.getByRole("list", { name: "Anciens libellés (la retrouvent encore) : Lever de rideau" })).toBeVisible();
    await expect(again.getByRole("button", { name: "Retirer l'ancien libellé « Lever de rideau »" })).toBeVisible();
    await again.getByRole("button", { name: "Annuler" }).click();
    // a new one of the same label is allowed, and said before it is sent
    await section.getByRole("button", { name: "➕ Nouvelle intention" }).click();
    const dup = page.getByRole("dialog", { name: "Nouvelle intention" });
    await dup.getByLabel("Libellé").fill("lever du rideau !");
    await expect(dup.getByText(/Même libellé qu'une autre intention : Lever du rideau \(ce show\)/)).toBeVisible();
    await expect(dup.getByRole("button", { name: "Enregistrer" })).toBeEnabled();
    await dup.getByRole("button", { name: "Annuler" }).click();
    // an editor left unchanged closes with Escape, and gives the focus back to what opened it
    const opener = section.getByRole("button", { name: "➕ Nouvelle intention" });
    await opener.click();
    await expect(page.getByRole("dialog", { name: "Nouvelle intention" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Nouvelle intention" })).toHaveCount(0);
    await expect(opener).toBeFocused();
    // a shipped one touched up for the show, then back to the original
    await section.getByRole("searchbox").fill("paix");
    await row("Paix").getByRole("button", { name: "Retoucher pour ce show · Paix" }).click();
    const touch = page.getByRole("dialog", { name: "Paix" });
    await touch.getByLabel("Couleur 1, en hexadécimal").fill("#00ff00");
    await touch.getByRole("button", { name: "Enregistrer" }).click();
    await expect(row("Paix").locator(".badge")).toHaveText("ce show");
    await expect(row("Paix")).toContainText("remplace : livrée");
    await row("Paix").getByRole("button", { name: "Revenir à l'original · Paix" }).click();
    await expect(row("Paix").locator(".badge")).toHaveText("livrée");
    // a shipped one a song uses: hidden after saying where it serves, then shown again
    await section.getByRole("searchbox").fill("joie");
    await row("Joie").getByRole("button", { name: "Masquer pour ce show · Joie" }).click();
    await expect(row("Joie")).toContainText("masquée dans ce show");
    await expect(row("Joie").locator(".badge")).toHaveText("livrée"); // a mask still says what it hides
    expect(asked.at(-1)).toContain("chant « Chant test »");
    expect(asked.at(-1)).toContain("La masquer quand même");
    expect(asked.at(-1)).not.toMatch(/supprimer/i);
    await picker.getByRole("searchbox").fill("joie");
    await expect(picker.getByRole("button", { name: /^Joie/ })).toHaveCount(0);
    await row("Joie").getByRole("button", { name: "Rétablir · Joie" }).click();
    await expect(row("Joie").locator(".badge")).toHaveText("livrée");
    await expect(picker.getByRole("button", { name: /^Joie/ })).toBeVisible();
    // deleted when nothing uses it
    await section.getByRole("searchbox").fill("rideau");
    await row("Lever du rideau").getByRole("button", { name: "Supprimer · Lever du rideau" }).click();
    await expect(list).toHaveCount(0);
    await expect(section.getByText("Rien ne correspond à cette recherche.")).toBeVisible();
  } finally {
    for (const songId of ["t15-a", "t15-b"]) await api(page, "song.delete", { id: songId });
    const kb = (await api(page, "knowledge.get")) as { moods: Record<string, { origin: string; label?: string }>; hidden: { id: string }[] };
    // the show's own made here (generated ids), and what was touched up or masked
    const made = Object.entries(kb.moods).filter(([, m]) => m.origin === "show" && /^Lever d/.test(m.label ?? "")).map(([id]) => id);
    for (const id of [...made, "paix", "joie"]) if (kb.moods[id]?.origin === "show" || kb.hidden.some((h) => h.id === id)) await api(page, "intention.delete", { id, force: true });
  }
  expect(errors).toEqual([]);
});

test("intentions travel in a backup: the restore says what happens to them, and brings them back (T15)", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  // an intention made before ids were generated (T15b): its key is its id
  await api(page, "intention.put", { intention: { id: "douceur", label: "Douceur", colors: ["#ffeedd", "#ffb000"], energy: "pose", family: "chaud" } });
  try {
    const backup = await page.evaluate(async () => {
      const res = await fetch("/api/plugins/light/archive", { headers: { authorization: `Bearer ${sessionStorage.getItem("token")}` } });
      return Array.from(new Uint8Array(await res.arrayBuffer()));
    });
    await api(page, "intention.delete", { id: "douceur" });
    expect(((await api(page, "knowledge.get")) as { moods: Record<string, unknown> }).moods.douceur).toBeUndefined();
    await page.locator("nav.pages button", { hasText: "Fichiers" }).click();
    let message = "";
    page.once("dialog", (d) => {
      message = d.message();
      void d.accept();
    });
    await page.locator('input[type=file][accept*="lightshow"]').setInputFiles({ name: "show.lightshow", mimeType: "application/zip", buffer: Buffer.from(backup) });
    await expect.poll(async () => ((await api(page, "knowledge.get")) as { moods: Record<string, { origin?: string }> }).moods.douceur?.origin).toBe("show");
    expect(message).toContain("Intentions du show : +1 / ~0 / -0");
    // and it is listed again on the Show page
    await page.locator("nav.pages button", { hasText: "Show" }).click();
    await page.locator("section.intentions").getByRole("searchbox").fill("douceur");
    await expect(page.locator("section.intentions li", { hasText: "Douceur" }).locator(".badge")).toHaveText("ce show");
  } finally {
    await api(page, "intention.delete", { id: "douceur", force: true });
  }
  expect(errors).toEqual([]);
});

test("intentions on a phone: the list grows with the page, finger-sized controls, each radio beside its text (T15)", async ({ page }) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.locator("nav.pages button", { hasText: "Show" }).click();
  const section = page.locator("section.intentions");
  const list = section.getByRole("list", { name: "Intentions connues" });
  await expect(list).toBeVisible();
  expect(await list.evaluate((el) => el.ownerDocument.defaultView!.getComputedStyle(el).overflowY)).toBe("visible");
  const action = list.locator(".intention-actions button").first();
  expect((await action.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  for (const control of [section.getByRole("searchbox"), section.getByRole("button", { name: "➕ Nouvelle intention" })]) expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  // the uses, unfolded by a finger: a 44 px target
  await api(page, "song.put", { song: { id: "t15-phone", title: "Essai téléphone", mood: ["calme"], sections: [] } });
  try {
    await section.getByRole("searchbox").fill("calme");
    const uses = list.locator("li", { hasText: "Calme" }).locator(".intention-uses summary");
    await expect(uses).toBeVisible();
    expect((await uses.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  } finally {
    await api(page, "song.delete", { id: "t15-phone" });
  }
  await section.getByRole("searchbox").fill("");
  await section.getByRole("button", { name: "➕ Nouvelle intention" }).click();
  const editor = page.getByRole("dialog", { name: "Nouvelle intention" });
  await editor.getByRole("button", { name: "+ Couleur" }).click();
  const down = editor.getByRole("button", { name: "Descendre la couleur 1" });
  const box = (await down.boundingBox())!;
  expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
  // moved, the colour keeps the focus on its own button
  await editor.getByLabel("Couleur 1, en hexadécimal").fill("#123456");
  await down.click();
  await expect(editor.getByLabel("Couleur 2, en hexadécimal")).toHaveValue("#123456");
  await expect(editor.getByRole("button", { name: "Monter la couleur 2" })).toBeFocused();
  for (const name of [/ce show/, /ma bibliothèque personnelle/]) {
    const radio = (await editor.getByRole("radio", { name }).boundingBox())!;
    const text = (await editor.locator(".intention-scope label", { has: page.getByRole("radio", { name }) }).locator("span").boundingBox())!;
    expect(radio.y).toBeLessThan(text.y + 24); // on the text's first line, not alone above it
    expect(radio.x).toBeLessThan(text.x);
  }
  await page.screenshot({ path: "test-results/intention-editor-phone.png" });
  await editor.getByRole("button", { name: "Annuler" }).click();
  expect(errors).toEqual([]);
});

test("intentions: a show's one goes to the library, the library is managed from Fichiers, a song says where its intentions come from (T15)", async ({ page }) => {
  const errors = watchErrors(page);
  const asked: string[] = [];
  page.on("dialog", (d) => {
    asked.push(d.message());
    void d.accept();
  });
  await login(page);
  await api(page, "intention.put", { intention: { id: "brume-du-soir", label: "Brume du soir", colors: ["#445566"], energy: "pose" } });
  try {
    // the song editor names its intentions with where each comes from
    await page.locator("nav.pages button", { hasText: "Chants" }).click();
    await page.getByRole("button", { name: "Modifier Chant test" }).click();
    await expect(page.locator(".song-editor").getByRole("list", { name: "Intentions" })).toContainText("Joie · livrée");
    await page.locator(".song-editor").getByRole("button", { name: "Fermer" }).first().click();
    // a show's intention added to the library: the show's copy goes on the second yes, the show now uses the library's
    await page.locator("nav.pages button", { hasText: "Show" }).click();
    const section = page.locator("section.intentions");
    await section.getByRole("searchbox").fill("brume du soir");
    const row = section.locator("li", { hasText: "Brume du soir" });
    await row.getByRole("button", { name: "Ajouter à ma bibliothèque · Brume du soir" }).click();
    await expect(row.locator(".badge")).toHaveText("personnelle");
    expect(asked).toEqual([expect.stringContaining("Ajouter « Brume du soir » à ta bibliothèque personnelle"), expect.stringContaining("Retirer la copie de ce show")]);
    // the library, whatever show is open: listed in Fichiers, deleted from there
    await page.locator("nav.pages button", { hasText: "Fichiers" }).click();
    const library = page.locator("section.intentions", { has: page.getByRole("heading", { name: "Ma bibliothèque d'intentions" }) });
    const own = library.locator("li", { hasText: "Brume du soir" });
    await expect(own).toBeVisible();
    await expect(own.locator(".badge")).toHaveCount(0); // every row is personal there: not repeated
    // a new one from the library with a shipped label: a second « Joie », said (T15b)
    await library.getByRole("button", { name: "➕ Nouvelle intention" }).click();
    const editor = page.getByRole("dialog", { name: "Nouvelle intention" });
    await expect(editor.getByRole("radio")).toHaveCount(0); // its place is the library
    await editor.getByLabel("Libellé").fill("Joie");
    await expect(editor.getByText(/Même libellé qu'une autre intention : Joie \(livrée\)/)).toBeVisible();
    await editor.getByRole("button", { name: "Annuler" }).click();
    await own.getByRole("button", { name: "Supprimer · Brume du soir" }).click();
    await expect(own).toHaveCount(0);
    expect(asked.at(-1)).toContain("Supprimer « Brume du soir » de ta bibliothèque");
    await expect(library.getByText("Aucune intention dans ta bibliothèque.")).toBeVisible();
  } finally {
    // what a failed run left behind only: a delete of nothing would be a 404 in the console
    const kb = (await api(page, "knowledge.get")) as { moods: Record<string, { origin: string }> };
    if (kb.moods["brume-du-soir"]?.origin === "show") await api(page, "intention.delete", { id: "brume-du-soir", force: true });
    if (((await api(page, "intention.library")) as { id: string }[]).some((x) => x.id === "brume-du-soir")) await api(page, "intention.delete", { id: "brume-du-soir", scope: "personal", force: true });
  }
  expect(errors).toEqual([]);
});

test("intentions by id: renamed, the song and the look still name it, shown by its label; picked in the song editor (T15b)", async ({ page }) => {
  const errors = watchErrors(page);
  page.on("dialog", (d) => void d.accept());
  await login(page);
  const made = (await api(page, "intention.put", { intention: { label: "Aurore", colors: ["#ffaa66"], energy: "pose" } })) as { intention: { id: string } };
  const id = made.intention.id;
  const CANVAS = ((await api(page, "look.get", { id: "checker" })) as { canvas: string }).canvas;
  try {
    // written by name, stored by id
    await api(page, "song.put", { song: { id: "t15b-s", title: "Essai ids", mood: ["aurore"], sections: [] } });
    await api(page, "look.put", { look: { id: "t15b-l", name: "Essai ids", canvas: CANVAS, technique: { kind: "plat", color: "#ffffff" }, tags: ["ambiance:Aurore"] } });
    expect(((await api(page, "song.list")) as { id: string; mood: string[] }[]).find((s) => s.id === "t15b-s")!.mood).toEqual([id]);
    // renamed: every place says the new label, nothing is lost
    await api(page, "intention.put", { intention: { id, label: "Aube rose", colors: ["#ffaa66"], energy: "pose" } });
    await page.locator("nav.pages button", { hasText: "Chants" }).click();
    await expect(page.locator("section.song h2", { hasText: "Essai ids" })).toContainText("Aube rose (ce show)");
    await page.locator("nav.pages button", { hasText: "Show" }).click();
    await expect(page.locator("tr", { hasText: "Essai ids" }).first()).toContainText("ambiance:Aube rose");
    await expect(page.locator("tr", { hasText: "Essai ids" }).first()).not.toContainText(id);
    // the song editor: its intentions as chips by label, a new one picked by name and stored by id
    await page.locator("nav.pages button", { hasText: "Chants" }).click();
    await page.getByRole("button", { name: "Modifier Essai ids" }).click();
    const editor = page.locator(".song-editor");
    await expect(editor.locator(".theme-chips .chip")).toHaveText([/^Aube rose/]);
    const search = editor.locator(".theme-picker").getByRole("searchbox");
    await search.fill("joie");
    await search.press("Enter");
    await expect(editor.locator(".theme-chips .chip")).toHaveText([/^Aube rose/, /^Joie/]);
    await page.screenshot({ path: "test-results/t15b-song-picker.png" });
    await editor.getByRole("button", { name: "Enregistrer", exact: true }).click();
    await expect(editor).toHaveCount(0);
    expect(((await api(page, "song.list")) as { id: string; mood: string[] }[]).find((s) => s.id === "t15b-s")!.mood).toEqual([id, "joie"]);
  } finally {
    await api(page, "song.delete", { id: "t15b-s" });
    await api(page, "look.delete", { id: "t15b-l", force: true });
    await api(page, "intention.delete", { id, force: true });
  }
  expect(errors).toEqual([]);
});

test("restore: an intention made apart on another machine is said, and this machine's can be kept (T15b)", async ({ page }) => {
  const errors = watchErrors(page);
  const asked: string[] = [];
  page.on("dialog", (d) => {
    asked.push(d.message());
    void d.accept(); // the summary
  });
  await login(page);
  const first = ((await api(page, "intention.put", { intention: { label: "Crépuscule", colors: ["#552266"], energy: "pose" }, scope: "personal" })) as { intention: { id: string } }).intention.id;
  let second = "";
  try {
    await api(page, "song.put", { song: { id: "t15b-r", title: "Essai machine", mood: [first], sections: [] } });
    const backup = await page.evaluate(async () => {
      const res = await fetch("/api/plugins/light/archive", { headers: { authorization: `Bearer ${sessionStorage.getItem("token")}` } });
      return Array.from(new Uint8Array(await res.arrayBuffer()));
    });
    // « another machine »: the same intention made again, under another id
    await api(page, "intention.delete", { id: first, scope: "personal", force: true });
    second = ((await api(page, "intention.put", { intention: { label: "Crépuscule", colors: ["#552266"], energy: "pose" }, scope: "personal" })) as { intention: { id: string } }).intention.id;
    await page.locator("nav.pages button", { hasText: "Fichiers" }).click();
    await page.locator('input[type=file][accept*="lightshow"]').setInputFiles({ name: "show.lightshow", mimeType: "application/zip", buffer: Buffer.from(backup) });
    await expect.poll(() => asked.length).toBeGreaterThanOrEqual(1);
    expect(asked[0]).toContain(`« Crépuscule » (${first}) : cette machine en a une de ce libellé (personnelle, ${second}), créée à part`);
    // one choice per intention, in a dialog: the backup's by default, this machine's picked
    const dialog = page.getByRole("dialog", { name: "Intentions créées à part sur une autre machine" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("radio", { name: new RegExp(`Celle de la sauvegarde \\(${first}\\)`) })).toBeChecked();
    await page.screenshot({ path: "test-results/t15b/restore-twins.png" });
    await dialog.getByRole("radio", { name: new RegExp(`Celle de cette machine \\(personnelle, ${second}\\)`) }).check();
    await dialog.getByRole("button", { name: "Restaurer" }).click();
    await expect(dialog).toHaveCount(0);
    // kept this machine's: the restored song names it, the backup's copy is not in the show
    await expect.poll(async () => ((await api(page, "song.list")) as { id: string; mood: string[] }[]).find((s) => s.id === "t15b-r")?.mood).toEqual([second]);
    const kb = (await api(page, "knowledge.get")) as { moods: Record<string, { origin: string }> };
    expect(kb.moods[first]).toBeUndefined();
    expect(kb.moods[second]?.origin).toBe("personal");
  } finally {
    await api(page, "song.delete", { id: "t15b-r" });
    for (const id of [first, second].filter(Boolean)) if (((await api(page, "intention.library")) as { id: string }[]).some((x) => x.id === id)) await api(page, "intention.delete", { id, scope: "personal", force: true });
  }
  expect(errors).toEqual([]);
});

test("a label shared by the show and the library: the restore keeps the show's own, the song editor pins the one picked (T15b, review)", async ({ page }) => {
  const errors = watchErrors(page);
  const asked: string[] = [];
  page.on("dialog", (d) => {
    asked.push(d.message());
    void d.accept();
  });
  await login(page);
  const mine = ((await api(page, "intention.put", { intention: { label: "Brise", colors: ["#88ccee"], energy: "pose" }, scope: "personal" })) as { intention: { id: string } }).intention.id;
  const own = ((await api(page, "intention.put", { intention: { label: "Brise", colors: ["#2266aa"], energy: "pose" } })) as { intention: { id: string } }).intention.id;
  try {
    await api(page, "song.put", { song: { id: "t15b-p", title: "Essai brise", mood: [own], sections: [] } });
    const backup = await page.evaluate(async () => {
      const res = await fetch("/api/plugins/light/archive", { headers: { authorization: `Bearer ${sessionStorage.getItem("token")}` } });
      return Array.from(new Uint8Array(await res.arrayBuffer()));
    });
    await api(page, "song.delete", { id: "t15b-p" });
    // the show's own « Brise » is no twin of the library's: no question, the song still names it
    await page.locator("nav.pages button", { hasText: "Fichiers" }).click();
    await page.locator('input[type=file][accept*="lightshow"]').setInputFiles({ name: "show.lightshow", mimeType: "application/zip", buffer: Buffer.from(backup) });
    await expect.poll(async () => ((await api(page, "song.list")) as { id: string; mood: string[] }[]).find((s) => s.id === "t15b-p")?.mood).toEqual([own]);
    expect(asked.join("\n")).not.toContain("créée à part");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(((await api(page, "knowledge.get")) as { moods: Record<string, { origin: string }> }).moods[own]?.origin).toBe("show");
    // the song editor: Enter on the shared label picks nothing, each is offered with where it lives
    await page.locator("nav.pages button", { hasText: "Chants" }).click();
    await page.getByRole("button", { name: "Modifier Essai brise" }).click();
    const editor = page.locator(".song-editor");
    await expect(editor.getByRole("textbox", { name: "Titre" })).toBeFocused(); // the keyboard goes to it
    await expect(editor.locator(".theme-chips .chip")).toHaveText([/^Brise · ce show/]);
    const search = editor.locator(".theme-picker").getByRole("searchbox");
    await search.fill("brise");
    await search.press("Enter");
    await expect(editor.locator(".theme-chips .chip")).toHaveCount(1);
    await expect(editor.locator(".theme-list button", { hasText: "Brise" })).toHaveCount(2);
    // ArrowDown goes into the list
    await search.press("ArrowDown");
    await expect(editor.locator(".theme-list button").first()).toBeFocused();
    // the label is said shared, and the other one can be picked: the song names it by its id
    const origins = editor.locator(".intention-origins");
    await expect(origins).toContainText("2 intentions portent ce libellé");
    await origins.getByRole("combobox", { name: "Laquelle « Brise » désigne" }).selectOption(mine);
    await expect(editor.locator(".theme-chips .chip")).toHaveText([/^Brise · personnelle/]);
    await page.screenshot({ path: "test-results/t15b/song-shared.png", fullPage: true });
    await editor.getByRole("button", { name: "Enregistrer", exact: true }).click();
    await expect(editor).toHaveCount(0);
    expect(((await api(page, "song.list")) as { id: string; mood: string[] }[]).find((s) => s.id === "t15b-p")!.mood).toEqual([mine]);
    // Escape closes an editor left unchanged
    await page.getByRole("button", { name: "Modifier Essai brise" }).click();
    await expect(editor).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(editor).toHaveCount(0);
  } finally {
    await api(page, "song.delete", { id: "t15b-p" });
    await api(page, "intention.delete", { id: own, force: true });
    await api(page, "intention.delete", { id: mine, scope: "personal", force: true });
  }
  expect(errors).toEqual([]);
});

test("the song editor on a phone: the intentions' picker fits, finger-sized (T15b, review)", async ({ page }) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.locator("nav.pages button", { hasText: "Chants" }).click();
  await page.getByRole("button", { name: "Modifier Chant test" }).click();
  const picker = page.locator(".song-editor .theme-picker");
  await expect(picker).toBeVisible();
  const box = (await picker.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await picker.screenshot({ path: "test-results/t15b/song-picker-phone.png" });
  await page.locator(".song-editor").getByRole("button", { name: "Fermer" }).first().click();
  expect(errors).toEqual([]);
});

test("a show intention with the same label as a shipped one: choose the shipped one in the song picker and the look editor, reopen, still the shipped one (T15b, review 2)", async ({ page }) => {
  const errors = watchErrors(page);
  page.on("dialog", (d) => void d.accept());
  await login(page);
  const own = ((await api(page, "intention.put", { intention: { label: "Joie", colors: ["#2266aa"], energy: "pose" } })) as { intention: { id: string } }).intention.id;
  const canvas = ((await api(page, "look.get", { id: "checker" })) as { canvas: string }).canvas;
  try {
    await api(page, "song.put", { song: { id: "t15b-j", title: "Essai joie", mood: [], sections: [] } });
    await api(page, "look.put", { look: { id: "t15b-jl", name: "Essai joie look", canvas, technique: { kind: "plat", color: "#ffffff" }, tags: ["ambiance:joie"] } });
    // the song picker: the shipped « Joie » picked beside the show's
    await page.locator("nav.pages button", { hasText: "Chants" }).click();
    await page.getByRole("button", { name: "Modifier Essai joie" }).click();
    const editor = page.locator(".song-editor");
    await editor.locator(".theme-picker").getByRole("searchbox").fill("joie");
    await editor.locator(".theme-list button", { hasText: "livrée" }).click();
    await expect(editor.locator(".theme-chips .chip")).toHaveText([/^Joie · livrée/]);
    await editor.getByRole("button", { name: "Enregistrer", exact: true }).click();
    await expect(editor).toHaveCount(0);
    expect(((await api(page, "song.list")) as { id: string; mood: string[] }[]).find((s) => s.id === "t15b-j")!.mood).toEqual(["=joie"]);
    await page.getByRole("button", { name: "Modifier Essai joie" }).click();
    await expect(editor.locator(".theme-chips .chip")).toHaveText([/^Joie · livrée/]);
    await expect(editor.locator(".theme-list button", { hasText: "livrée" })).toHaveAttribute("aria-pressed", "true");
    await expect(editor.locator(".theme-list button", { hasText: "ce show" })).toHaveAttribute("aria-pressed", "false");
    await page.keyboard.press("Escape");
    // the look editor: « joie » reads as the show's; « Laquelle » picks the shipped one
    await page.locator("nav.pages button", { hasText: "Show" }).click();
    await page.getByRole("button", { name: "Modifier Essai joie look" }).click();
    const look = page.locator(".look-editor");
    const which = look.getByRole("combobox", { name: "Laquelle « Joie » désigne" });
    await expect(which).toHaveValue(own);
    await expect(look.locator(".intention-origins .chip.shared")).toHaveCount(1); // by a name several bear: a warning
    await which.selectOption("joie");
    await expect(look.locator(".intention-origins .chip")).toContainText("Joie · livrée");
    await expect(look.locator(".intention-origins .chip.shared")).toHaveCount(0); // pinned: said quietly
    await page.screenshot({ path: "test-results/t15b/look-strict.png" });
    await look.getByRole("button", { name: "Enregistrer", exact: true }).click();
    await expect.poll(async () => ((await api(page, "look.get", { id: "t15b-jl" })) as { tags: string[] }).tags).toEqual(["ambiance:=joie"]);
    await expect(look).toHaveCount(0);
    await page.getByRole("button", { name: "Modifier Essai joie look" }).click();
    await expect(look.getByRole("combobox", { name: "Laquelle « Joie » désigne" })).toHaveValue("joie");
    await expect(look.getByLabel("tags", { exact: true })).toHaveValue("ambiance:Joie");
  } finally {
    await api(page, "song.delete", { id: "t15b-j" });
    await api(page, "look.delete", { id: "t15b-jl", force: true });
    await api(page, "intention.delete", { id: own, force: true });
  }
  expect(errors).toEqual([]);
});

// ---- Motion layer UI (T25, lot 6)
test("motion settings: the show's default glide is saved in seconds, beats, or as a cut", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.locator("nav.pages").getByRole("button", { name: "Show", exact: true }).click();
  const mode = page.getByRole("combobox", { name: "Temps de déplacement par défaut", exact: true });
  const settings = async () => ((await api(page, "show.settings")) as { moveFade: { seconds?: number; beats?: number } }).moveFade;
  try {
    await expect(mode).toHaveValue("seconds");
    const seconds = page.getByRole("spinbutton", { name: "Temps de déplacement par défaut · secondes" });
    await seconds.fill("");
    await seconds.pressSequentially("2.5", { delay: 30 }); // real keystrokes, not one pasted value
    await expect.poll(settings).toEqual({ seconds: 2.5 });
    await mode.selectOption("beats");
    await expect.poll(settings).toEqual({ beats: 2.5 });
    await page.getByRole("spinbutton", { name: "Temps de déplacement par défaut · temps" }).fill("2");
    await expect.poll(settings).toEqual({ beats: 2 });
    await mode.selectOption("cut");
    await expect.poll(settings).toEqual({ seconds: 0 });
    await page.locator("header select").selectOption("en");
    await expect(page.getByRole("combobox", { name: "Default movement glide", exact: true })).toHaveValue("cut");
    await page.locator("header select").selectOption("fr");
  } finally {
    await api(page, "show.settings.set", { moveFade: { seconds: 1 } });
  }
  expect(errors).toEqual([]);
});

test("motion settings: a look saves automatic, seconds, beats and cut", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.locator("nav.pages").getByRole("button", { name: "Show", exact: true }).click();
  await page.getByRole("button", { name: "+ Nouveau look" }).click();
  const editor = page.locator(".look-editor");
  await editor.getByLabel("Nom", { exact: true }).fill("Test mouvement");
  await editor.getByRole("checkbox", { name: "Mouvement (lyres)", exact: true }).check();
  const mode = editor.getByRole("combobox", { name: "Temps de déplacement", exact: true });
  const fade = async () => ((await api(page, "look.get", { id: "test-mouvement" })) as { move?: { fade?: { seconds?: number; beats?: number } } }).move?.fade;
  const save = async () => {
    await editor.getByRole("button", { name: "Enregistrer", exact: true }).click();
    await expect(editor).toHaveCount(0);
  };
  const reopen = async () => {
    await page.getByRole("button", { name: "Modifier Test mouvement" }).click();
    await expect(editor).toBeVisible();
  };
  try {
    await expect(mode).toHaveValue("auto");
    await mode.selectOption("seconds");
    const seconds = editor.getByRole("spinbutton", { name: "Temps de déplacement · secondes" });
    await seconds.fill("");
    await seconds.pressSequentially("0.5", { delay: 30 }); // typing zero must not turn the field into « Coupe »
    await expect(seconds).toBeFocused();
    await save();
    await expect.poll(fade).toEqual({ seconds: 0.5 });
    await reopen();
    await mode.selectOption("beats");
    await editor.getByRole("spinbutton", { name: "Temps de déplacement · temps" }).fill("2");
    await save();
    await expect.poll(fade).toEqual({ beats: 2 });
    await reopen();
    await mode.selectOption("cut");
    await save();
    await expect.poll(fade).toEqual({ seconds: 0 });
    await reopen();
    await mode.selectOption("auto");
    await save();
    await expect.poll(fade).toBeUndefined();
  } finally {
    await api(page, "look.delete", { id: "test-mouvement", force: true }).catch(() => undefined);
  }
  expect(errors).toEqual([]);
});

test("motion pad: sent dot, per-axis layers, a masked look and one layer released per press", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const canvas = ((await api(page, "look.get", { id: "checker" })) as { canvas: string }).canvas;
  await api(page, "look.put", { look: { id: "motion-layer", name: "Position test", canvas, technique: { kind: "aucune" }, channels: { targets: [{ fixture: "spot", offset: 0 }], steps: [[40]] } } });
  const xy = page.locator(".xy").first();
  const layer = (axis: "pan" | "tilt") => xy.locator(`.xy-layers [data-axis="${axis}"]`);
  try {
    await api(page, "look.go", { id: "motion-layer" });
    await expect(layer("pan")).toHaveText("Pan : Look « Position test »");
    await expect(layer("tilt")).toHaveText("Tilt : Repos");
    const dot = xy.getByTestId("xy-sent-dot");
    await expect(dot).toBeVisible();
    const dotLeft = async () => Number((await dot.getAttribute("style"))?.match(/left: ([\d.]+)%/)?.[1]);
    await expect.poll(dotLeft).toBeLessThan(49); // the sent dot follows the glide, not only its target
    await expect.poll(dotLeft, { timeout: 4000 }).toBeCloseTo(15.7, 0);
    await api(page, "position.set", { fixtures: ["spot"], pan: 0.8, tilt: 0.7 });
    await expect(layer("pan")).toHaveText("Pan : Main");
    await expect(layer("tilt")).toHaveText("Tilt : Main");
    await expect.poll(dotLeft).toBeCloseTo(80, 0);
    await expect(xy.locator(".xy-masked")).toContainText("le look « Position test » voudrait la déplacer");
    await page.locator("header select").selectOption("en");
    await expect(layer("pan")).toHaveText("Pan: Manual");
    await expect(xy.locator(".xy-masked")).toContainText("look “Position test” would move it");
    await expect(xy.getByRole("button", { name: "Hand back", exact: true })).toBeVisible();
    await page.locator("header select").selectOption("fr");
    await xy.getByRole("button", { name: "Rendre la main", exact: true }).click();
    await expect(layer("pan")).toHaveText("Pan : Look « Position test »");
    await expect(layer("tilt")).toHaveText("Tilt : Repos");
    await xy.getByRole("button", { name: "Rendre la main", exact: true }).click();
    await expect(layer("pan")).toHaveText("Pan : Repos");
    await expect(layer("tilt")).toHaveText("Tilt : Repos");
  } finally {
    await api(page, "look.stop", { id: "motion-layer" }).catch(() => undefined);
    await api(page, "position.home", {}).catch(() => undefined);
    await api(page, "look.delete", { id: "motion-layer", force: true }).catch(() => undefined);
  }
  expect(errors).toEqual([]);
});

test("motion pad: a group shows and releases only its own heads", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await api(page, "venue.fixture.put", { fixture: { id: "other-head", name: "Autre lyre", manufacturer: "Test", model: "Spot 7", mode: "Standard", universe: 2, address: 20 } });
  await api(page, "group.put", { group: { id: "motion-only", name: "Une lyre", members: { fixtures: ["spot"], groups: [], looks: [] } } });
  await api(page, "dashboard.put", { dashboard: { id: "motion-group", name: "Pad groupe", columns: 4, widgets: [{ id: "xy", kind: "xy", target: "motion-only", x: 0, y: 0, w: 4, h: 4 }] } });
  try {
    await page.reload();
    await page.getByRole("button", { name: /Pad groupe/ }).click();
    await api(page, "position.set", { fixtures: ["spot"], pan: 0.8, tilt: 0.7 });
    await api(page, "position.set", { fixtures: ["other-head"], pan: 0.2, tilt: 0.3 });
    const xy = page.locator(".xy").first();
    await expect(xy.getByTestId("xy-sent-dot")).toHaveCount(1);
    await expect(xy.getByTestId("xy-sent-dot")).toHaveAttribute("data-fixture", "spot");
    await expect(xy.locator(".xy-position")).toHaveText("80 / 70");
    await expect(xy.locator('.xy-layers [data-axis="pan"]')).toHaveText("Pan : Main");
    await xy.getByRole("button", { name: "Rendre la main", exact: true }).click();
    await expect(xy.locator('.xy-layers [data-axis="pan"]')).toHaveText("Pan : Repos");
    const other = ((await api(page, "position.list")) as { id: string; motion: { pan: { layer: string } } | null }[]).find((h) => h.id === "other-head");
    expect(other?.motion?.pan.layer).toBe("manual"); // the other pad's head is not released
  } finally {
    await api(page, "position.home", {}).catch(() => undefined);
    await api(page, "dashboard.delete", { id: "motion-group" }).catch(() => undefined);
    await api(page, "group.delete", { id: "motion-only" }).catch(() => undefined);
    await api(page, "venue.fixture.delete", { id: "other-head" }).catch(() => undefined);
  }
  expect(errors).toEqual([]);
});

test("motion fixture panel: set, clear and return to rest, with 44 px controls on a phone", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page, "9999");
  type Fixture = { id: string; position?: { x: number; y: number; z: number } };
  const spot = ((await api(page, "venue.fixture.list")) as Fixture[]).find((f) => f.id === "spot")!;
  const head = async () => ((await api(page, "position.list")) as { id: string; sent: { pan: number; tilt: number } | null; rest: { pan: number; tilt: number; set: boolean }; motion: { pan: { layer: string }; tilt: { layer: string } } | null }[]).find((h) => h.id === "spot")!;
  await api(page, "venue.fixture.put", { fixture: { ...spot, position: { x: 0, y: 1, z: 4 } } });
  try {
    await page.locator("nav.pages button", { hasText: "Lieu" }).click();
    const body = page.locator('.stage-plan g.fixture[data-fixture="spot"] > g').first();
    const bodyBox = (await body.boundingBox())!;
    for (const [fx, fy] of [[0.85, 0.85], [0.15, 0.85], [0.85, 0.15], [0.15, 0.15]]) {
      await body.click({ position: { x: bodyBox.width * fx!, y: bodyBox.height * fy! }, timeout: 1500 }).catch(() => undefined);
      if (await page.locator(".fixture-panel").isVisible()) break;
    }
    const panel = page.locator(".fixture-panel");
    const pad = panel.locator(".xy .pad");
    await pad.scrollIntoViewIfNeeded();
    let box = (await pad.boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.3);
    await expect.poll(async () => Math.round(((await head()).sent?.pan ?? 0) * 10)).toBe(7);
    await expect(panel.getByTestId("xy-sent-dot")).toHaveAttribute("style", /left: 70(?:\.\d+)?%/);
    await panel.getByRole("button", { name: "Définir comme repos", exact: true }).click();
    await expect.poll(async () => (await head()).rest.set).toBe(true);
    expect((await head()).rest.pan).toBeCloseTo(0.7, 1);
    expect((await head()).rest.tilt).toBeCloseTo(0.7, 1);
    await panel.getByRole("button", { name: "Rendre la main", exact: true }).click();
    await expect(panel.locator('.xy-layers [data-axis="pan"]')).toHaveText("Pan : Repos");
    box = (await pad.boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.8);
    await expect.poll(async () => Math.round(((await head()).sent?.pan ?? 0) * 10)).toBe(2);
    await panel.getByRole("button", { name: "Retour au repos", exact: true }).click();
    await expect.poll(async () => (await head()).sent?.pan ?? 0, { timeout: 5000 }).toBeCloseTo(0.7, 1);
    await panel.getByRole("button", { name: "Effacer le repos", exact: true }).click();
    await expect.poll(async () => (await head()).rest.set).toBe(false);
    await panel.getByRole("button", { name: "Retour au repos", exact: true }).click();
    await expect.poll(async () => (await head()).sent?.pan ?? 0, { timeout: 5000 }).toBeCloseTo(0.5, 1);
    await page.setViewportSize({ width: 400, height: 860 });
    await pad.scrollIntoViewIfNeeded();
    const panelBox = (await panel.boundingBox())!;
    expect(panelBox.x).toBeGreaterThanOrEqual(0);
    expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(400);
    const buttons = await panel.locator(".xy-actions button").evaluateAll((items) => items.map((b) => ({ width: b.getBoundingClientRect().width, height: b.getBoundingClientRect().height, right: b.getBoundingClientRect().right })));
    expect(buttons).toHaveLength(4);
    for (const button of buttons) {
      expect(button.height).toBeGreaterThanOrEqual(44);
      expect(button.right).toBeLessThanOrEqual(400);
    }
    await page.screenshot({ path: "test-results/t25-motion-panel-phone.png", fullPage: true });
  } finally {
    await api(page, "position.home", {}).catch(() => undefined);
    await api(page, "position.rest.clear", { fixtures: ["spot"] }).catch(() => undefined);
    await api(page, "venue.fixture.put", { fixture: spot }).catch(() => undefined);
  }
  expect(errors).toEqual([]);
});

test("calibration: record refusals stay visible beside the controls", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  type Fixture = { id: string; position?: { x: number; y: number; z: number } };
  const spot = ((await api(page, "venue.fixture.list")) as Fixture[]).find((f) => f.id === "spot")!;
  await api(page, "venue.fixture.put", { fixture: { ...spot, position: { x: 0, y: 1, z: 4 } } });
  let refusal = "";
  await page.route("**/api/plugins/light/commands/calibration.record", (route) => route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ ok: false, error: refusal }) }));
  try {
    await page.locator("nav.pages button", { hasText: "Lieu" }).click();
    await page.getByText("Calibrer les lyres").click();
    const calibration = page.locator(".calibration");
    for (const message of [
      "Lyre : la lyre n'est pas encore arrivée ; attendre, puis enregistrer",
      "Lyre : un look la déplace ; la viser d'abord à la main (pad XY), puis enregistrer",
      "Lyre : une cible la tient ; la viser d'abord à la main (pad XY), puis enregistrer",
      "Lyre : sortie arrêtée, aucune trame rendue : impossible de lire où pointe la lyre",
    ]) {
      refusal = message;
      await calibration.getByRole("button", { name: /Enregistrer ce repère/ }).click();
      await expect(calibration.getByRole("alert")).toHaveText(message);
    }
  } finally {
    await page.unroute("**/api/plugins/light/commands/calibration.record");
    await api(page, "venue.fixture.put", { fixture: spot }).catch(() => undefined);
  }
  expect(errors.filter((e) => !e.includes("status of 400"))).toEqual([]);
});
