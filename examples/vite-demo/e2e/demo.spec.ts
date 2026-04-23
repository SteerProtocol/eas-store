import { expect, test } from "@playwright/test";

test("developers can exercise the sdk through the demo flow", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "EAS Store Playground" })).toBeVisible();
  await expect(page.getByTestId("demo-status")).toContainText("Ready");

  await page.getByTestId("key-input").fill("profile:bob");
  await page.getByTestId("value-input").fill(
    JSON.stringify(
      {
        name: "Bob",
        theme: "sunrise",
        tags: ["playwright", "demo"]
      },
      null,
      2
    )
  );

  await page.getByTestId("set-button").click();
  await expect(page.getByTestId("last-action")).toContainText("Saved profile:bob at version 1");
  await expect(page.getByTestId("latest-record")).toContainText("\"version\": 1");
  await expect(page.getByTestId("latest-record")).toContainText("\"name\": \"Bob\"");

  await page.getByTestId("history-button").click();
  await expect(page.getByTestId("history-output")).toContainText("\"version\": 1");

  await page.getByTestId("query-button").click();
  await expect(page.getByTestId("query-output")).toContainText("profile:bob");

  await page.getByTestId("delete-button").click();
  await expect(page.getByTestId("latest-record")).toContainText("\"operation\": \"DELETE\"");

  await page.getByTestId("get-button").click();
  await expect(page.getByTestId("last-action")).toContainText("No live record for profile:bob");

  await page.getByTestId("namespace-input").fill("demo.team");
  const previousSigner = await page.getByTestId("signer-address").textContent();
  await page.getByTestId("reset-button").click();
  await expect(page.getByTestId("active-namespace")).toContainText("demo.team");
  await expect(page.getByTestId("query-output")).toContainText("[]");
  await expect(page.getByTestId("signer-address")).not.toHaveText(previousSigner ?? "");

  await page.getByTestId("mode-onchain").click();
  await expect(page.getByTestId("network-select")).toHaveValue("base-sepolia");
  await expect(page.locator('input[data-testid="eas-address-input"]')).toHaveValue(
    "0x4200000000000000000000000000000000000021"
  );
  await expect(page.locator('input[data-testid="schema-registry-input"]')).toHaveValue(
    "0x4200000000000000000000000000000000000020"
  );
  await expect(page.locator('input[data-testid="graphql-endpoint-input"]')).toHaveValue(
    "https://base-sepolia.easscan.org/graphql"
  );
  await page.getByRole("button", { name: "Continue To Schema" }).click();
  await expect(page.getByTestId("schema-preset-card")).toContainText("Steer Store v1");
  await expect(page.getByTestId("schema-preset-card")).toContainText(
    "namespace, key, value hash"
  );
  await expect(page.getByTestId("wallet-help")).toContainText("No injected wallet");
});
