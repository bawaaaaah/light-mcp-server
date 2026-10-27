import { defineConfig } from "@playwright/test";

const port = 8799;
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
    command: "npm run build -w web && npx tsx test/ui/server.ts",
    env: { PORT: String(port) },
    url: `http://127.0.0.1:${port}/health`,
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
