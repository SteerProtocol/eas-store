import { describe, expect, it } from "vitest";

import {
  MOCK_EAS_STORE_ADDRESS,
  MOCK_EAS_STORE_CHAIN_ID,
  createMockEASStore,
  createMockEASStoreProvider
} from "../src/testing";

describe("testing helpers", () => {
  it("creates a standalone mock store for simple consumer tests", async () => {
    const store = await createMockEASStore({
      namespace: "consumer.simple"
    });

    await store.set("profile:alice", {
      name: "Alice"
    });

    await expect(store.get("profile:alice")).resolves.toEqual({
      name: "Alice"
    });
  });

  it("shares in-memory records across stores from the same provider", async () => {
    const provider = createMockEASStoreProvider({
      namespace: "consumer.shared"
    });
    const writer = await provider.store();
    const reader = await provider.store();

    await writer.set("settings/theme", "dark");

    await expect(reader.get("settings/theme")).resolves.toBe("dark");
    await expect(reader.getRecord("settings/theme")).resolves.toMatchObject({
      attester: await provider.getAddress(),
      version: 1
    });
  });

  it("isolates records by namespace while sharing one provider", async () => {
    const provider = createMockEASStoreProvider();
    const first = await provider.store({
      namespace: "consumer.first"
    });
    const second = await provider.store({
      namespace: "consumer.second"
    });

    await first.set("feature/enabled", true);

    await expect(first.get("feature/enabled")).resolves.toBe(true);
    await expect(second.get("feature/enabled")).resolves.toBeNull();
  });

  it("resets shared in-memory state between tests", async () => {
    const provider = createMockEASStoreProvider({
      namespace: "consumer.reset"
    });
    const beforeReset = await provider.store();

    await beforeReset.set("session", {
      id: "abc"
    });
    provider.reset();

    const afterReset = await provider.store();

    await expect(afterReset.get("session")).resolves.toBeNull();
  });

  it("creates advanced stores with the mock network constants", async () => {
    const provider = createMockEASStoreProvider({
      namespace: "consumer.advanced"
    });
    const store = await provider.advancedStore();

    await store.set("raw", {
      ok: true
    });

    expect(provider.chainId).toBe(MOCK_EAS_STORE_CHAIN_ID);
    expect(provider.easContractAddress).toBe(MOCK_EAS_STORE_ADDRESS);
    await expect(store.get("raw")).resolves.toMatchObject({
      value: {
        ok: true
      },
      verified: true
    });
  });
});
