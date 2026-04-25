import { expect, test } from "@playwright/test";
import "./coverage";

const MOCK_WALLET_ADDRESS = "0x1111111111111111111111111111111111111111";

async function installMockWallet(
  page: Parameters<Parameters<typeof test>[1]>[0]["page"],
  chainIdHex: string
) {
  await page.addInitScript(
    ({ address, chainId }) => {
      Object.defineProperty(window, "ethereum", {
        configurable: true,
        value: {
          async request({ method }: { method: string }) {
            switch (method) {
              case "eth_requestAccounts":
              case "eth_accounts":
                return [address];
              case "eth_chainId":
                return chainId;
              case "net_version":
                return String(Number.parseInt(chainId, 16));
              default:
                throw new Error(`Mock wallet does not implement ${method}`);
            }
          }
        }
      });
    },
    {
      address: MOCK_WALLET_ADDRESS,
      chainId: chainIdHex
    }
  );
}

async function switchToSchemaBuilder(page: Parameters<Parameters<typeof test>[1]>[0]["page"]) {
  await page.getByTestId("mode-onchain").click();
  await page.getByRole("button", { name: /Schema Builder/ }).click();
  await expect(page.getByTestId("schema-builder")).toBeVisible();
}

async function openRecordEditor(page: Parameters<Parameters<typeof test>[1]>[0]["page"]) {
  await page.getByTestId("set-button").click();
  await expect(page.getByRole("dialog", { name: "Record editor" })).toBeVisible();
}

test("developers can exercise the sdk through the demo flow", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "EAS Store" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "profiles" })).toBeVisible();
  await expect(page.getByTestId("demo-status")).toContainText("Ready");

  await page.getByTestId("key-input").fill("profile:bob");
  await openRecordEditor(page);
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

  await page.getByTestId("modal-set-button").click();
  await expect(page.getByTestId("last-action")).toContainText("Saved profile:bob at version 1");
  await expect(page.getByRole("row", { name: /bob .*Bob.* just now/ })).toBeVisible();
  await expect(page.getByTestId("latest-record")).toContainText("\"version\": 1");
  await expect(page.getByTestId("latest-record")).toContainText("\"name\": \"Bob\"");

  await openRecordEditor(page);
  await page.getByTestId("history-button").click();
  await expect(page.getByTestId("history-output")).toContainText("\"version\": 1");

  await page.getByTestId("delete-button").click();
  await expect(page.getByTestId("latest-record")).toContainText("\"operation\": \"DELETE\"");

  await page.getByRole("button", { name: "Close editor" }).click();

  await page.getByTestId("private-mode-toggle").click();
  await expect(page.getByTestId("private-setup-dialog")).toBeVisible();
  await page.getByTestId("private-setup-button").click();
  await expect(page.getByTestId("private-status")).toContainText("Private mode is ready");
  await expect(page.getByTestId("private-phrase")).toHaveValue(/\w+ \w+ \w+/);
  const recoveryPhrase = await page.getByTestId("private-phrase").inputValue();
  await page.getByRole("button", { name: "Not now" }).click();

  await page.getByTestId("key-input").fill("profile:secret");
  await openRecordEditor(page);
  await expect(page.getByTestId("entry-private-option")).toContainText("Private encrypted");
  await page.getByTestId("value-input").fill(
    JSON.stringify(
      {
        name: "Bob",
        secret: "encrypted"
      },
      null,
      2
    )
  );
  await page.getByTestId("modal-set-button").click();
  await expect(page.getByTestId("private-status")).toContainText("Encrypted profile:secret");
  await expect(page.getByTestId("private-output")).toContainText("\"name\": \"Bob\"");
  await expect(page.getByRole("row", { name: /secret Private payload just now/ })).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("demo-status")).toContainText("Ready");
  await page.getByTestId("private-mode-toggle").click();
  await expect(page.getByTestId("private-setup-dialog")).toBeVisible();
  await expect(page.getByTestId("private-phrase")).toHaveCount(0);
  await page.getByTestId("private-restore-choice").click();
  await page.getByTestId("private-phrase").fill(recoveryPhrase);
  await page.getByTestId("private-restore-button").click();
  await expect(page.getByTestId("private-status")).toContainText("restored");

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
  await expect(page.getByTestId("indexing-capability")).toContainText("Indexed reads");
  await page.getByRole("button", { name: /Schema Builder/ }).click();
  await expect(page.getByTestId("schema-preset-card")).toContainText("Steer Store v1");
  await expect(page.getByTestId("schema-preset-card")).toContainText(
    "namespace, key, value hash"
  );
  await expect(page.getByTestId("wallet-help")).toContainText("No injected wallet");
});

test("database manager layout stays responsive without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "EAS Store" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "profiles" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New Entry" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Three steps, end-to-end." })).toBeVisible();
  await expect(page.getByText("import { EASStore } from")).toBeVisible();
  await expect(page.getByText("const record = await store.getRecord")).toBeVisible();
  await expect(page.getByText("Ready to build?")).toBeVisible();

  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
      )
    )
    .toBe(true);

  await page.setViewportSize({ width: 390, height: 900 });
  await expect(page.getByRole("heading", { name: "EAS Store" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "profiles" })).toBeVisible();
  await expect(page.getByTestId("key-input")).toBeVisible();

  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
      )
    )
    .toBe(true);
});

test("record editor surfaces invalid JSON without mutating the last verified output", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("demo-status")).toContainText("Ready");

  await openRecordEditor(page);
  await page.getByTestId("value-input").fill("{ bad json");
  await page.getByTestId("modal-set-button").click();

  await expect(page.getByTestId("error-output")).toContainText("Expected property name");
  await expect(page.getByTestId("demo-status")).toContainText("Failed");
  await expect(page.getByTestId("last-action")).toContainText(
    "Offchain workspace initialized"
  );
});

test("onchain setup is explicit and fails safely without an injected wallet", async ({ page }) => {
  await page.goto("/");

  await page.getByTestId("mode-onchain").click();
  await expect(page.getByTestId("wallet-help")).toContainText("No injected wallet");
  await expect(page.getByTestId("network-select")).toHaveValue("base-sepolia");

  await page.getByTestId("connect-wallet-button").click();
  await expect(page.getByTestId("error-output")).toContainText("No injected wallet");
  await expect(page.getByTestId("demo-status")).toContainText("Failed");

  await page.getByTestId("mode-offchain").click();
  await expect(page.getByTestId("demo-status")).toContainText("Ready");
  await expect(page.getByTestId("wallet-help")).toContainText("Ephemeral signer");
});

test("mocked onchain wallet validates chain id before creating a client", async ({ page }) => {
  await installMockWallet(page, "0x2105");
  await page.goto("/");

  await page.getByTestId("mode-onchain").click();
  await expect(page.getByTestId("wallet-help")).toContainText("Detected");
  await page.getByTestId("connect-wallet-button").click();

  await expect(page.getByTestId("error-output")).toContainText("Switch to chain 84532");
  await expect(page.getByTestId("demo-status")).toContainText("Failed");
});

test("mocked onchain wallet can initialize the wallet scoped client", async ({ page }) => {
  await installMockWallet(page, "0x14a34");
  await page.goto("/");

  await page.getByTestId("mode-onchain").click();
  await page.getByTestId("connect-wallet-button").click();

  await expect(page.getByTestId("demo-status")).toContainText("Ready");
  await expect(page.getByTestId("active-namespace")).toContainText("demo.profile.111111");
  await expect(page.getByTestId("signer-address")).toContainText(MOCK_WALLET_ADDRESS);
  await expect(page.getByTestId("last-action")).toContainText("Onchain client initialized");
});

test("schema builder supports adding templates, moving fields, removing fields, and restoring defaults", async ({ page }) => {
  await page.goto("/");
  await switchToSchemaBuilder(page);
  await expect(page.getByTestId("schema-definition-output")).toContainText("bytes32 namespace");

  await page.getByRole("button", { name: "+ recipient" }).click();
  await expect(page.getByTestId("schema-definition-output")).toContainText("address recipient");

  const downButtons = page.getByRole("button", { name: "Down" });
  await expect(downButtons.first()).toBeEnabled();
  await downButtons.first().click();

  const upButtons = page.getByRole("button", { name: "Up" });
  await expect(upButtons.nth(1)).toBeEnabled();
  await upButtons.nth(1).click();

  const removeButtons = page.getByRole("button", { name: "Remove" });
  const removeCount = await removeButtons.count();
  await expect(removeButtons.nth(removeCount - 1)).toBeEnabled();
  await removeButtons.nth(removeCount - 1).click();
  await expect(page.getByTestId("schema-definition-output")).not.toContainText(
    "address recipient"
  );

  await page.getByRole("button", { name: "Add Field" }).click();
  await expect(page.getByTestId("schema-definition-output")).toContainText("bytes32 key");

  await page.getByRole("button", { name: "Restore Default" }).click();
  await expect(page.getByTestId("schema-definition-output")).toContainText("bytes32 namespace");
  await expect(page.getByTestId("schema-preset-card")).toContainText("9 fields");
});

test("schema publishing validates empty definitions before requesting a wallet", async ({ page }) => {
  await page.goto("/");
  await switchToSchemaBuilder(page);

  while ((await page.getByRole("button", { name: "Remove" }).count()) > 0) {
    await page.getByRole("button", { name: "Remove" }).first().click();
  }

  await expect(page.getByTestId("schema-definition-output")).toContainText(
    "Add at least one named field"
  );

  await page.getByTestId("publish-another-schema-button").click();
  await expect(page.getByTestId("error-output")).toContainText(
    "Schema definition is required"
  );
  await expect(page.getByTestId("demo-status")).toContainText("Failed");
});

test("custom onchain setup validates user supplied contract addresses with a wallet present", async ({ page }) => {
  await installMockWallet(page, "0x14a34");
  await page.goto("/");

  await page.getByTestId("mode-onchain").click();
  await page.getByTestId("network-select").selectOption("custom");
  await expect(page.getByTestId("chain-id-input")).not.toHaveAttribute("readonly", "");

  await page.getByTestId("chain-id-input").fill("84532");
  await page.getByTestId("eas-address-input").fill("0xnot-an-address");
  await page.getByTestId("schema-registry-input").fill(
    "0x4200000000000000000000000000000000000020"
  );
  await page.getByTestId("graphql-endpoint-input").fill("");
  await expect(page.getByTestId("indexing-capability")).toContainText("Write capable");

  await page.getByTestId("connect-wallet-button").click();
  await expect(page.getByTestId("error-output")).toContainText(
    "EAS contract address must be a 20-byte hex address"
  );
});

test("custom onchain setup validates chain id, schema registry, and schema uid mistakes", async ({ page }) => {
  await installMockWallet(page, "0x14a34");
  await page.goto("/");

  await page.getByTestId("mode-onchain").click();
  await page.getByTestId("network-select").selectOption("custom");
  await page.getByTestId("eas-address-input").fill(
    "0x4200000000000000000000000000000000000021"
  );
  await page.getByTestId("schema-registry-input").fill(
    "0x4200000000000000000000000000000000000020"
  );

  await page.getByTestId("chain-id-input").fill("0");
  await page.getByTestId("connect-wallet-button").click();
  await expect(page.getByTestId("error-output")).toContainText(
    "Chain ID must be a positive integer"
  );

  await page.getByTestId("chain-id-input").fill("84532");
  await page.getByTestId("schema-registry-input").fill("0xnot-a-registry");
  await page.getByTestId("connect-wallet-button").click();
  await expect(page.getByTestId("error-output")).toContainText(
    "Schema registry address must be a 20-byte hex address"
  );

  await page.getByTestId("schema-registry-input").fill(
    "0x4200000000000000000000000000000000000020"
  );
  await page.getByTestId("schema-uid-input").fill("0x1234");
  await page.getByTestId("connect-wallet-button").click();
  await expect(page.getByTestId("error-output")).toContainText(
    "Schema UID must be a 32-byte hex string"
  );

  await page.getByTestId("schema-uid-input").fill("");
  await page.getByTestId("connect-wallet-button").click();
  await expect(page.getByTestId("error-output")).toContainText(
    "Schema UID is required"
  );
});

test("custom onchain setup can initialize with a memory indexer when GraphQL is blank", async ({ page }) => {
  await installMockWallet(page, "0x14a34");
  await page.goto("/");

  await page.getByTestId("mode-onchain").click();
  await page.getByTestId("network-select").selectOption("custom");
  await page.getByTestId("chain-id-input").fill("84532");
  await page.getByTestId("eas-address-input").fill(
    "0x4200000000000000000000000000000000000021"
  );
  await page.getByTestId("schema-registry-input").fill(
    "0x4200000000000000000000000000000000000020"
  );
  await page.getByTestId("graphql-endpoint-input").fill("");

  await page.getByTestId("connect-wallet-button").click();
  await expect(page.getByTestId("demo-status")).toContainText("Ready");
  await expect(page.getByTestId("active-namespace")).toContainText("demo.profile.111111");
  await expect(page.getByTestId("last-action")).toContainText("Onchain client initialized");
});

test("onchain reconnect reuses the wallet flow and default preset can be restored", async ({ page }) => {
  await installMockWallet(page, "0x14a34");
  await page.goto("/");

  await page.getByTestId("mode-onchain").click();
  await page.getByTestId("network-select").selectOption("custom");
  await page.getByTestId("graphql-endpoint-input").fill("");
  await page.getByTestId("network-select").selectOption("base-sepolia");
  await expect(page.getByTestId("network-select")).toHaveValue("base-sepolia");
  await expect(page.getByTestId("graphql-endpoint-input")).toHaveValue(
    "https://base-sepolia.easscan.org/graphql"
  );
  await page.getByTestId("schema-uid-input").fill(
    "0x1111111111111111111111111111111111111111111111111111111111111111"
  );

  await page.getByTestId("connect-wallet-button").click();
  await expect(page.getByTestId("demo-status")).toContainText("Ready");

  await page.getByTestId("reset-button").click();
  await expect(page.getByTestId("last-action")).toContainText("Onchain client initialized");
});

test("private set reports malformed JSON before writing encrypted data", async ({ page }) => {
  await page.goto("/");

  await page.getByTestId("private-mode-toggle").click();
  await page.getByTestId("private-setup-button").click();
  await expect(page.getByTestId("private-status")).toContainText("Private mode is ready");
  await page.getByRole("button", { name: "Not now" }).click();

  await openRecordEditor(page);
  await page.getByTestId("value-input").fill("{ broken private json");
  await page.getByTestId("modal-set-button").click();

  await expect(page.getByTestId("error-output")).toContainText("Expected property name");
  await expect(page.getByTestId("demo-status")).toContainText("Failed");
  await expect(page.getByTestId("private-status")).toContainText("Private mode is ready");
});

test("private restore reports phrase or backup failures clearly", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("demo-status")).toContainText("Ready");

  await page.getByTestId("private-mode-toggle").click();
  await expect(page.getByTestId("private-setup-dialog")).toBeVisible();
  await expect(page.getByTestId("private-phrase")).toHaveCount(0);
  await page.getByTestId("private-restore-choice").click();
  await page.getByTestId("private-phrase").fill(
    "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima"
  );
  await page.getByTestId("private-restore-button").click();

  await expect(page.getByTestId("error-output")).toBeVisible();
  await expect(page.getByTestId("demo-status")).toContainText("Failed");
  await expect(page.getByTestId("private-status")).toBeEmpty();
});
