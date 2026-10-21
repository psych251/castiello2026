// Playwright runs the whole experiment in headless Chromium.
//   npm test          -> starts the Firestore/Auth emulators, then runs this
//   npx playwright test  (without emulators) -> every test skips itself
const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "tests",
  timeout: 90000,
  retries: 0,
  // Every worker runs its own browser against one shared set of emulators; more than
  // four at once can starve the emulator's anonymous sign-in and time it out.
  workers: 4,
  reporter: [["list"]],
  use: {
    // Tests get their own port so a stray `npm start` / `npm run dev` (8000) can never be
    // mistaken for the tree under test; reuseExistingServer is off for the same reason.
    baseURL: "http://localhost:8017",
    headless: true,
    // Optional: point at a system Chromium instead of the Playwright-managed one
    // (used in CI containers that ship their own browser).
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : {},
  },
  webServer: [
    {
      command: "node scripts/serve.js",
      port: 8017,
      env: { PORT: "8017" },
      reuseExistingServer: false,
      timeout: 20000,
    },
    // The chat service is not started here: it is the Cloud Function in server/, which
    // `npm test` runs in the Functions emulator alongside Auth and Firestore.
  ],
});
