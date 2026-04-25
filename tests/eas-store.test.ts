import { EAS, SchemaRegistry } from "@ethereum-attestation-service/eas-sdk";
import { ZeroAddress } from "ethers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  EASKeyStore,
  EASStore,
  EASScanIndexer,
  InlineStorage,
  MemoryIndexer,
  MemoryStorage,
  STORE_SCHEMA
} from "../src";
import { createWalletSigner, SCHEMA_UID } from "./helpers";

beforeEach(() => {
  vi.restoreAllMocks();
});

function createTransactionSigner() {
  const wallet = createWalletSigner();

  return Object.assign(wallet, {
    sendTransaction: vi.fn(),
    estimateGas: vi.fn(),
    call: vi.fn(),
    resolveName: vi.fn()
  });
}

describe("EASStore ergonomic facade", () => {
  it("creates a zero-config local store with Redis-like value reads", async () => {
    const store = await EASStore.local({
      namespace: "test.local"
    });

    const receipt = await store.set("settings/theme", {
      theme: "dark"
    });
    const value = await store.get<{ theme: string }>("settings/theme");
    const record = await store.getRecord<{ theme: string }>("settings/theme");
    const scan = await store.scan();

    expect(receipt).toMatchObject({
      key: "settings/theme",
      operation: "set",
      version: 1
    });
    expect(value).toEqual({
      theme: "dark"
    });
    expect(record?.uid).toBe(receipt.uid);
    expect(scan.map((item) => item.key)).toContain("settings/theme");
  });

  it("returns compact delete receipts and null after deletion", async () => {
    const store = await EASStore.local({
      namespace: "test.local"
    });

    await store.set("settings/theme", "dark");
    const receipt = await store.delete("settings/theme");

    expect(receipt).toMatchObject({
      key: "settings/theme",
      operation: "delete",
      version: 2
    });
    await expect(store.get("settings/theme")).resolves.toBeNull();
    await expect(store.history("settings/theme")).resolves.toHaveLength(2);
    await expect(store.query()).resolves.toHaveLength(0);
  });

  it("creates an offchain store with inline storage defaults", async () => {
    const signer = createWalletSigner();
    const store = await EASStore.offchain({
      network: "base-sepolia",
      namespace: "test.offchain",
      schemaUID: SCHEMA_UID,
      signer
    });

    await store.set("profile:alice", {
      name: "Alice"
    });
    const record = await store.getRecord("profile:alice");

    expect(record?.valueURI).toMatch(/^data:application%2Fjson;base64,/);
  });

  it("creates an onchain store with preset EASScan defaults", async () => {
    const signer = createWalletSigner();
    const store = await EASStore.onchain({
      network: "base-sepolia",
      namespace: "test.onchain",
      schemaUID: SCHEMA_UID,
      signer,
      indexer: new MemoryIndexer()
    });

    expect(store.advanced).toBeInstanceOf(EASKeyStore);
  });

  it("stores onchain values inline by default", async () => {
    const signer = createTransactionSigner();
    let encodedData = "0x" as `0x${string}`;
    const connectSpy = vi
      .spyOn(EAS.prototype, "connect")
      .mockImplementation(function (this: EAS) {
        return this;
      });

    vi.spyOn(EAS.prototype, "attest").mockImplementation(async (request) => {
      encodedData = request.data.data as `0x${string}`;

      return {
        wait: vi
          .fn()
          .mockResolvedValue(
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          )
      } as never;
    });
    vi.spyOn(EAS.prototype, "getAttestation").mockImplementation(async () => ({
      uid: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      schema: SCHEMA_UID,
      refUID: "0x0000000000000000000000000000000000000000000000000000000000000000",
      time: 10n,
      expirationTime: 0n,
      revocationTime: 0n,
      recipient: await signer.getAddress(),
      revocable: true,
      attester: await signer.getAddress(),
      data: encodedData
    } as never));

    const store = await EASStore.onchain({
      network: "base-sepolia",
      namespace: "test.inline-onchain",
      schemaUID: SCHEMA_UID,
      signer,
      indexer: new MemoryIndexer()
    });
    const receipt = await store.set("profile:alice", {
      name: "Alice"
    });
    const record = await store.getRecord("profile:alice");

    expect(connectSpy).toHaveBeenCalled();
    expect(receipt).toMatchObject({
      key: "profile:alice",
      operation: "set"
    });
    expect(record?.valueURI).toMatch(/^data:application%2Fjson;base64,/);
  });

  it("rejects local-only storage with remote onchain indexers", async () => {
    await expect(
      EASStore.onchain({
        network: "base-sepolia",
        namespace: "test.bad-storage",
        schemaUID: SCHEMA_UID,
        signer: createTransactionSigner(),
        storage: new MemoryStorage()
      })
    ).rejects.toThrow("requires inline or remote storage");
  });

  it("creates stores from numeric and custom network inputs", async () => {
    const signer = createWalletSigner();
    const fromChainId = await EASStore.offchain({
      network: 84532,
      namespace: "test.numeric",
      schemaUID: SCHEMA_UID,
      signer
    });
    const fromCustomNetwork = await EASStore.offchain({
      network: {
        chainId: 12345,
        easContractAddress: "0x0000000000000000000000000000000000000001",
        easVersion: "1.3.0"
      },
      namespace: "test.custom",
      schemaUID: SCHEMA_UID,
      signer
    });

    await fromChainId.set("a", 1);
    await fromCustomNetwork.set("b", 2);

    await expect(fromChainId.get("a")).resolves.toBe(1);
    await expect(fromCustomNetwork.get("b")).resolves.toBe(2);
  });

  it("rejects unknown network inputs with guided configuration errors", async () => {
    const signer = createWalletSigner();

    await expect(
      EASStore.offchain({
        network: "not-a-network" as never,
        namespace: "test.unknown",
        schemaUID: SCHEMA_UID,
        signer
      })
    ).rejects.toThrow("Unknown EAS network preset");

    await expect(
      EASStore.offchain({
        network: 999_999,
        namespace: "test.unknown",
        schemaUID: SCHEMA_UID,
        signer
      })
    ).rejects.toThrow("Pass a custom network object");
  });

  it("exposes advanced creation for adapter-heavy callers", async () => {
    const signer = createWalletSigner();
    const advanced = await EASStore.createAdvanced({
      chainId: 84532,
      easContractAddress: "0x0000000000000000000000000000000000000001",
      easVersion: "1.3.0",
      schemaUID: SCHEMA_UID,
      namespace: "test.advanced",
      mode: "offchain",
      signer,
      storage: new MemoryStorage(),
      indexer: new MemoryIndexer()
    });

    expect(advanced).toBeInstanceOf(EASKeyStore);
  });

  it("builds default schema UIDs and reuses existing schemas through schema ops", async () => {
    const signer = createWalletSigner();
    const uid = EASStore.schema.uidForDefault({
      revocable: false
    });
    const connectSpy = vi
      .spyOn(SchemaRegistry.prototype, "connect")
      .mockImplementation(function (this: SchemaRegistry) {
        return this;
      });
    const getSchemaSpy = vi.spyOn(SchemaRegistry.prototype, "getSchema").mockResolvedValue({
      uid,
      schema: STORE_SCHEMA,
      resolver: ZeroAddress,
      revocable: true
    } as never);
    const registerSpy = vi.spyOn(SchemaRegistry.prototype, "register");

    const result = await EASStore.schema.ensureDefault({
      network: "base-sepolia",
      signer,
      resolverAddress: ZeroAddress as `0x${string}`,
      revocable: false
    });

    expect(connectSpy).toHaveBeenCalled();
    expect(getSchemaSpy).toHaveBeenCalledWith({
      uid
    });
    expect(registerSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      uid,
      created: false,
      schema: STORE_SCHEMA
    });
  });

  it("checks and loads schema status without forcing callers into registry internals", async () => {
    const uid = EASStore.schema.uidForDefault();
    vi.spyOn(SchemaRegistry.prototype, "connect").mockImplementation(function (
      this: SchemaRegistry
    ) {
      return this;
    });
    vi.spyOn(SchemaRegistry.prototype, "getSchema").mockResolvedValue({
      uid,
      schema: STORE_SCHEMA,
      resolver: ZeroAddress,
      revocable: true
    } as never);

    await expect(
      EASStore.schema.get({
        network: "base-sepolia",
        uid,
        signer: createWalletSigner()
      })
    ).resolves.toMatchObject({
      exists: true,
      schema: STORE_SCHEMA
    });
    await expect(
      EASStore.schema.exists({
        network: "base-sepolia",
        uid,
        signer: createWalletSigner()
      })
    ).resolves.toBe(true);
  });

  it("returns false for missing schemas through the schema existence helper", async () => {
    vi.spyOn(SchemaRegistry.prototype, "connect").mockImplementation(function (
      this: SchemaRegistry
    ) {
      return this;
    });
    vi.spyOn(SchemaRegistry.prototype, "getSchema").mockRejectedValue(
      new Error("Schema not found")
    );

    await expect(
      EASStore.schema.exists({
        network: "base-sepolia",
        uid: EASStore.schema.uidForDefault(),
        signer: createWalletSigner()
      })
    ).resolves.toBe(false);
  });

  it("keeps low-level adapter classes available for overrides", () => {
    expect(new InlineStorage()).toBeInstanceOf(InlineStorage);
    expect(
      new EASScanIndexer({
        endpoint: "https://base-sepolia.easscan.org/graphql",
        fetchImpl: vi.fn() as unknown as typeof fetch
      })
    ).toBeInstanceOf(EASScanIndexer);
  });
});
