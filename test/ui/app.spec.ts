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

test("right-click on a look button in the Live: edit its look in a window, over the dashboard", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  await page.locator(".dgrid .cell button", { hasText: "hole" }).first().click({ button: "right" });
  await page.getByRole("dialog", { name: "Réglages du widget" }).getByRole("button", { name: "✎ Modifier le look" }).click();
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
  // from low in the strip: its top can sit under the page tabs, which stick to the top of the screen
  const x = Math.round(strip.x + strip.width / 2);
  const y = Math.round(Math.min(strip.y + strip.height, 480) - 200 - 20);
  expect(await page.evaluate<boolean>(`document.elementFromPoint(${x}, ${y})?.classList.contains("scroll-gutter") ?? false`)).toBe(true);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let i = 1; i <= 10; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + i * 20 }] });
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
  const [dash] = (await api(page, "dashboard.list")) as { widgets: { id: string; kind: string; x: number; y: number; w: number; h: number; color?: string; mode?: string }[] }[];
  const looks = dash!.widgets.filter((w) => w.kind === "look").sort((a, b) => a.y - b.y || a.x - b.x);
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
  // its first command gets a 401, unless the page got there by itself: the heartbeat closes the
  // socket of a closed session, whose reconnection is refused
  await page.locator("nav.pages").getByRole("button", { name: "Show", exact: true }).click({ timeout: 5000 }).catch(() => undefined);
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
  await expect(editor.locator(".preview-row .cell")).toHaveCount(8); // server preview on the 8-cell canvas
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
      if (m.address === "/setlist/jumpToSong") jumps.push(String(m.args[0]));
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
  const asked: string[] = [];
  page.on("dialog", (d) => (asked.push(d.message()), void d.accept()));
  await row.getByRole("button", { name: "Enregistrer" }).click();
  await expect.poll(async () => ((await api(page, "output.status")) as { config: { routes: unknown[] } }).config.routes[1]).toEqual({ universe: 2, artnet: { portAddress: 5, targets: ["127.0.0.2"] }, sacn: { universe: 2 } });
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
    await fx("bar-0").scrollIntoViewIfNeeded();
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
    const all = [await centre("bar-0"), await centre("bar-1"), await centre("spot")];
    const [left, top] = [Math.min(...all.map((c) => c.x)) - 60, Math.min(...all.map((c) => c.y)) - 40];
    await dragBy({ x: left, y: top }, Math.max(...all.map((c) => c.x)) + 60 - left, Math.max(...all.map((c) => c.y)) + 40 - top);
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
  await editor.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(editor).toHaveCount(0);
  const saved = ((await api(page, "fader.list")) as { id: string; channels: unknown[]; dca?: string; range?: unknown }[]).find((f) => f.id === "strobes")!;
  expect(saved.dca).toBe("master");
  expect(saved.range).toEqual({ min: 0, max: 200 });
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
    await expect.poll(async () => { const d = await dmx(page); return [d[0], d[15], d[18]].map((v) => Math.round(v! / 10)); }).toEqual([13, 13, 13]); // ½ of 255 each
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
  const cells = bar.locator("g rect:not(.selection):not(.strobe-outline)");
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
