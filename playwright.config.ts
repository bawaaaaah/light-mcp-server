import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

// UI_PORT: run on another port when 8799 is taken (the specs read the same variable);
// UI_ARTNET_PORT: the Art-Net port of the UI server (16455 by default, apart from the other tests' 16454);
// UI_SKIP_BUILD=1: serve web/dist as it is, without building it again first. For a second suite run at the same time
// (on other ports): a build empties web/dist, and the pages the first suite loads meanwhile would come back missing.
const port = Number(process.env.UI_PORT ?? 8799);
const skipBuild = process.env.UI_SKIP_BUILD === "1";
// without a build there, every page would answer 404: say why at once instead of 313 failures
if (skipBuild && !existsSync(new URL("web/dist/index.html", import.meta.url))) throw new Error("UI_SKIP_BUILD=1 but web/dist/index.html is missing: run `npm run build -w web` first");
export default defineConfig({
  testDir: "test/ui",
  testMatch: "*.spec.ts",
  timeout: 30_000,
  retries: 0,
  workers: 1, // one shared server: tests change its state
  fullyParallel: false,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${port}`, locale: "fr-FR", screenshot: "only-on-failure", trace: "retain-on-failure" },
  outputDir: "test-results",
  webServer: {
    command: `${skipBuild ? "" : "npm run build -w web && "}npx tsx test/ui/server.ts`,
    env: { PORT: String(port), UI_ARTNET_PORT: process.env.UI_ARTNET_PORT ?? "16455" },
    url: `http://127.0.0.1:${port}/health`,
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
