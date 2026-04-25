import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "@playwright/test";

declare global {
  interface Window {
    __coverage__?: unknown;
  }
}

test.afterEach(async ({ page }, testInfo) => {
  if (process.env.E2E_COVERAGE !== "true") {
    return;
  }

  const coverage = await page.evaluate(() => window.__coverage__ ?? null);

  if (!coverage) {
    return;
  }

  const outputDir = path.resolve(testInfo.config.rootDir, "../.nyc_output");
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    path.join(
      outputDir,
      `coverage-${testInfo.workerIndex}-${testInfo.retry}-${Date.now()}.json`
    ),
    JSON.stringify(coverage)
  );
});
