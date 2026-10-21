import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

/** A 16-bit mono WAV of clicks at `bpm`: the room the fake microphone hears, in a loop. */
function clickTrack(bpm: number, seconds: number, rate = 44100): Buffer {
  const n = Math.round(seconds * rate);
  const pcm = new Int16Array(n);
  let s = 5;
  const noise = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < n; i++) pcm[i] = Math.round(300 * noise());
  const period = (60 / bpm) * rate;
  for (let k = 0; k * period < n; k++) {
    const start = Math.round(k * period);
    for (let i = 0; i < 0.03 * rate && start + i < n; i++) pcm[start + i] = Math.max(-32767, Math.min(32767, pcm[start + i]! + Math.round(20000 * noise() * Math.exp(-i / (0.006 * rate)))));
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + n * 2, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(n * 2, 40);
  return Buffer.concat([header, Buffer.from(pcm.buffer)]);
}

// a whole number of beats, so the loop does not stumble
const room = join(tmpdir(), "light-ui-room-128bpm.wav");
writeFileSync(room, clickTrack(128, (60 / 128) * 32));
test.use({ launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${room}`] } });

test("the Tap widget listens to the room and follows its tempo", async ({ page }) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.locator("form.pin-login select").selectOption("regisseur");
  await page.getByPlaceholder(/PIN/).fill("1234");
  await page.locator("form.pin-login button").click();
  await expect(page.locator("header.top")).toBeVisible();

  const mic = page.getByRole("button", { name: "Écouter le tempo au micro" });
  await mic.click();
  await expect(mic).toHaveAttribute("aria-pressed", "true");
  // a first reading after 6 s, followed once the next one agrees
  await expect(mic).toHaveClass(/following/, { timeout: 25_000 });
  await expect(page.locator("button.tap")).toContainText(/12[78]\.\d|128\.0/);
  const tempo = await page.evaluate(async () => {
    const token = sessionStorage.getItem("token");
    const res = await fetch("/api/plugins/light/commands/tempo.get", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
    return ((await res.json()) as { result: { bpm: number; source: string } }).result;
  });
  expect(tempo.source).toBe("audio");
  expect(tempo.bpm).toBeGreaterThan(127);
  expect(tempo.bpm).toBeLessThan(129);

  // off: a manual tempo again, at the tempo it heard
  await mic.click();
  await expect(mic).toHaveAttribute("aria-pressed", "false");
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const token = sessionStorage.getItem("token");
        const res = await fetch("/api/plugins/light/commands/tempo.get", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
        return ((await res.json()) as { result: { source: string } }).result.source;
      }),
    )
    .toBe("manual");
  expect(errors).toEqual([]);
});
