import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: "browser.spec.js",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:8739",
    browserName: "chromium",
    launchOptions: {
      executablePath: process.env.CI
        ? undefined
        : process.env.CHROME_PATH || "/usr/bin/google-chrome",
      args: ["--no-sandbox"],
    },
  },
  webServer: {
    command: "DEMO_MODE=true COOKIE_SECURE=false npm start",
    url: "http://127.0.0.1:8739",
    reuseExistingServer: false,
  },
});
