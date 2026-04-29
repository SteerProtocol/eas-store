import { EAS } from "@ethereum-attestation-service/eas-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ConfigurationError,
  EASKeyStore,
  EASScanIndexer,
  InlineStorage,
  MemoryIndexer,
  MemoryStorage,
  StoreOperation,
  VerificationError
} from "../src";
import { encodeStoredValue } from "../src/codecs/json";
import { hashBytes, hashText } from "../src/crypto/hash";
import { encodeStoreRecord, ZERO_UID } from "../src/eas/schema";
import * as clientModule from "../src/eas/client";
import type { IndexedStoreRecord, IndexerAdapter } from "../src/types";
import {
  cloneIndexedRecord,
  createOffchainStore,
  EAS_ADDRESS,
  SCHEMA_UID,
  createWalletSigner
} from "./helpers";

function createTransactionSigner() {
  const wallet = createWalletSigner();

  return Object.assign(wallet, {
    sendTransaction: vi.fn(),
    estimateGas: vi.fn(),
    call: vi.fn(),
    resolveName: vi.fn()
  });
}

function createIndexer(records: IndexedStoreRecord[]): IndexerAdapter {
  return {
    supportsVerifiedReads: () => true,
    query: vi.fn().mockResolvedValue(records)
  };
}

async function makeSyntheticOnchainRecord(
  storage: MemoryStorage,
  overrides: {
    key?: string;
    value?: unknown;
    uid?: `0x${string}`;
    previousUID?: `0x${string}`;
    version?: bigint;
    time?: bigint;
    operation?: StoreOperation;
    includeLookupKey?: boolean;
    recipient?: `0x${string}`;
    attester?: `0x${string}`;
  } = {}
): Promise<IndexedStoreRecord> {
  const key = overrides.key ?? "profile:alice";
  const value = overrides.value ?? { name: "Alice" };
  const contentType =
    overrides.operation === StoreOperation.Delete
      ? "application/x-tombstone"
      : "application/json";
  const bytes =
    overrides.operation === StoreOperation.Delete
      ? new Uint8Array()
      : encodeStoredValue(value, contentType);
  const valueURI =
    overrides.operation === StoreOperation.Delete
      ? ""
      : await storage.put(bytes, contentType);
  const record = {
    namespaceHash: hashText("test.profile"),
    keyHash: hashText(key),
    valueHash: hashBytes(bytes),
    valueURI,
    contentType,
    version: overrides.version ?? 1n,
    operation: overrides.operation ?? StoreOperation.Set,
    previousUID: overrides.previousUID ?? ZERO_UID,
    extra: "0x" as `0x${string}`
  };

  return {
    attestation: {
      uid:
        overrides.uid ??
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      schema: SCHEMA_UID,
      refUID: record.previousUID,
      time: overrides.time ?? 10n,
      expirationTime: 0n,
      revocationTime: 0n,
      recipient: overrides.recipient ?? EAS_ADDRESS,
      revocable: true,
      attester:
        overrides.attester ??
        "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      data: encodeStoreRecord(record),
      revoked: false,
      mode: "onchain"
    },
    record,
    ...(overrides.includeLookupKey === false ? {} : { lookupKey: key })
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("EASKeyStore", () => {
  it("writes, reads, versions, and tombstones records in offchain mode", async () => {
    const store = await createOffchainStore();

    const first = await store.set("profile:alice", {
      name: "Alice",
      avatar: "ipfs://alice"
    });
    const second = await store.set("profile:alice", {
      name: "Alice Two",
      avatar: "ipfs://alice-two"
    });
    const latest = await store.get<{ name: string }>("profile:alice");
    const history = await store.history<{ name: string }>("profile:alice");

    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(latest?.value).toEqual({
      name: "Alice Two",
      avatar: "ipfs://alice-two"
    });
    expect(history.map((record) => record.version)).toEqual([1, 2]);

    const tombstone = await store.delete("profile:alice");
    const afterDelete = await store.get("profile:alice");
    const postDeleteHistory = await store.history("profile:alice");

    expect(tombstone.operation).toBe(2);
    expect(afterDelete).toBeNull();
    expect(postDeleteHistory).toHaveLength(3);
    expect(postDeleteHistory[2]?.operation).toBe(2);
  });

  it("applies query limits after collapsing to canonical heads", async () => {
    const store = await createOffchainStore();

    await store.set("profile:alice", { name: "Alice v1" });
    await store.set("profile:alice", { name: "Alice v2" });
    await store.set("profile:bob", { name: "Bob v1" });
    await store.set("profile:bob", { name: "Bob v2" });
    await store.set("profile:carol", { name: "Carol v1" });

    const results = await store.query<{ name: string }>({
      limit: 2
    });

    expect(results).toHaveLength(2);
    expect(new Set(results.map((record) => record.key)).size).toBe(2);
  });

  it("returns empty history for unknown keys", async () => {
    const store = await createOffchainStore();

    await expect(store.get("profile:missing")).resolves.toBeNull();
    await expect(store.history("profile:missing")).resolves.toEqual([]);
  });

  it("rejects unsupported offchain EASScan configurations at creation time", async () => {
    await expect(
      EASKeyStore.create({
        chainId: 8453,
        easContractAddress: EAS_ADDRESS,
        easVersion: "1.3.0",
        schemaUID: SCHEMA_UID,
        namespace: "test.profile",
        mode: "offchain",
        signer: createWalletSigner(),
        storage: new MemoryStorage(),
        indexer: new EASScanIndexer({
          endpoint: "https://base.easscan.org/graphql",
          fetchImpl: vi.fn() as unknown as typeof fetch
        })
      })
    ).rejects.toThrow("does not support durable verified offchain reads");
  });

  it("rejects unsupported onchain indexers at creation time", async () => {
    await expect(
      EASKeyStore.create({
        chainId: 8453,
        easContractAddress: EAS_ADDRESS,
        schemaUID: SCHEMA_UID,
        namespace: "test.profile",
        mode: "onchain",
        signer: createTransactionSigner(),
        defaultRecipient: EAS_ADDRESS,
        storage: new MemoryStorage(),
        indexer: {
          supportsVerifiedReads: () => false,
          query: vi.fn().mockResolvedValue([])
        }
      })
    ).rejects.toThrow("does not support verified onchain reads");
  });

  it("refuses to continue offchain history when prior records are present but unverifiable", async () => {
    const storage = new MemoryStorage();
    const sourceStore = await createOffchainStore({
      storage
    });
    const written = await sourceStore.set("profile:alice", { name: "Alice" });
    const remoteOnly = cloneIndexedRecord(written.raw);
    delete remoteOnly.attestation.signedOffchainAttestation;

    const store = await createOffchainStore({
      storage,
      indexer: createIndexer([remoteOnly])
    });

    await expect(store.get("profile:alice")).resolves.toBeNull();
    await expect(store.set("profile:alice", { name: "Alice v2" })).rejects.toThrow(
      VerificationError
    );
    await expect(store.history("profile:alice")).rejects.toThrow(VerificationError);
  });

  it("rejects ambiguous forked histories in reads and future writes", async () => {
    const storage = new MemoryStorage();
    const branchA = await createOffchainStore({
      storage
    });
    const branchB = await createOffchainStore({
      storage
    });
    const recordA = await branchA.set("profile:alice", { name: "Alice A" });
    const recordB = await branchB.set("profile:alice", { name: "Alice B" });
    const store = await createOffchainStore({
      storage,
      indexer: createIndexer([recordA.raw, recordB.raw])
    });

    await expect(store.get("profile:alice")).resolves.toBeNull();
    await expect(store.query()).resolves.toHaveLength(0);
    await expect(store.history("profile:alice")).rejects.toThrow(VerificationError);
    await expect(store.set("profile:alice", { name: "Alice C" })).rejects.toThrow(
      VerificationError
    );
  });

  it("rejects records with missing predecessors as ambiguous history", async () => {
    const storage = new MemoryStorage();
    const orphan = await makeSyntheticOnchainRecord(storage, {
      previousUID:
        "0x9999999999999999999999999999999999999999999999999999999999999999"
    });
    vi.spyOn(clientModule, "getTransport").mockReturnValue(undefined);
    const store = await EASKeyStore.create({
      chainId: 8453,
      easContractAddress: EAS_ADDRESS,
      schemaUID: SCHEMA_UID,
      namespace: "test.profile",
      mode: "onchain",
      signer: createTransactionSigner(),
      defaultRecipient: EAS_ADDRESS,
      storage,
      indexer: createIndexer([orphan]),
      verification: {
        requireChainValidationOnchain: false
      }
    });

    await expect(store.get("profile:alice")).resolves.toBeNull();
    await expect(store.history("profile:alice")).rejects.toThrow(VerificationError);
    await expect(store.set("profile:alice", { name: "Alice v2" })).rejects.toThrow(
      VerificationError
    );
  });

  it("treats ZERO_UID as the root predecessor for onchain query records", async () => {
    const storage = new MemoryStorage();
    const root = await makeSyntheticOnchainRecord(storage);
    vi.spyOn(clientModule, "getTransport").mockReturnValue(undefined);
    const store = await EASKeyStore.create({
      chainId: 8453,
      easContractAddress: EAS_ADDRESS,
      schemaUID: SCHEMA_UID,
      namespace: "test.profile",
      mode: "onchain",
      signer: createTransactionSigner(),
      defaultRecipient: EAS_ADDRESS,
      storage,
      indexer: createIndexer([root]),
      verification: {
        requireChainValidationOnchain: false
      }
    });

    await expect(store.get<{ name: string }>("profile:alice")).resolves.toMatchObject({
      uid: root.attestation.uid,
      value: { name: "Alice" }
    });
    await expect(store.query<{ name: string }>()).resolves.toHaveLength(1);
  });

  it("rejects histories with multiple verified children from one head", async () => {
    const storage = new MemoryStorage();
    const root = await makeSyntheticOnchainRecord(storage, {
      uid: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      version: 1n,
      time: 1n
    });
    const branchA = await makeSyntheticOnchainRecord(storage, {
      uid: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      previousUID: root.attestation.uid,
      version: 2n,
      time: 2n,
      value: { name: "Alice A" }
    });
    const branchB = await makeSyntheticOnchainRecord(storage, {
      uid: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      previousUID: root.attestation.uid,
      version: 2n,
      time: 3n,
      value: { name: "Alice B" }
    });
    vi.spyOn(clientModule, "getTransport").mockReturnValue(undefined);
    const store = await EASKeyStore.create({
      chainId: 8453,
      easContractAddress: EAS_ADDRESS,
      schemaUID: SCHEMA_UID,
      namespace: "test.profile",
      mode: "onchain",
      signer: createTransactionSigner(),
      defaultRecipient: EAS_ADDRESS,
      storage,
      indexer: createIndexer([root, branchA, branchB]),
      verification: {
        requireChainValidationOnchain: false
      }
    });

    await expect(store.get("profile:alice")).resolves.toBeNull();
    await expect(store.query()).resolves.toEqual([]);
    await expect(store.history("profile:alice")).rejects.toThrow(VerificationError);
  });

  it("reads onchain records across process boundaries using EASScan plus chain verification", async () => {
    const signer = createTransactionSigner();
    const storage = new InlineStorage();
    const connectSpy = vi
      .spyOn(EAS.prototype, "connect")
      .mockImplementation(function (this: EAS) {
        return this;
      });
    let encodedData = "0x" as `0x${string}`;
    let attester = "";
    const attestSpy = vi.spyOn(EAS.prototype, "attest").mockImplementation(async (request) => {
      encodedData = request.data.data as `0x${string}`;
      attester = await signer.getAddress();

      return {
        wait: vi
          .fn()
          .mockResolvedValue(
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          )
      } as never;
    });
    const getAttestationSpy = vi
      .spyOn(EAS.prototype, "getAttestation")
      .mockImplementation(async (uid) => ({
        uid,
        schema: SCHEMA_UID,
        refUID: ZERO_UID,
        time: 10n,
        expirationTime: 0n,
        revocationTime: 0n,
        recipient: EAS_ADDRESS,
        revocable: true,
        attester,
        data: encodedData
      }) as never);

    const writeStore = await EASKeyStore.create({
      chainId: 8453,
      easContractAddress: EAS_ADDRESS,
      schemaUID: SCHEMA_UID,
      namespace: "test.profile",
      mode: "onchain",
      signer,
      defaultRecipient: EAS_ADDRESS,
      storage,
      indexer: new MemoryIndexer()
    });
    const written = await writeStore.set("profile:alice", { name: "Alice" });
    const readIndexer = new EASScanIndexer({
      endpoint: "https://base.easscan.org/graphql",
      fetchImpl: vi.fn().mockResolvedValue({
        json: vi.fn().mockResolvedValue({
          data: {
            attestations: [
              {
                id: written.uid,
                schemaId: SCHEMA_UID,
                attester: written.attester,
                recipient: written.recipient,
                time: String(written.time),
                expirationTime: "0",
                revocationTime: "0",
                refUID: ZERO_UID,
                revocable: true,
                isOffchain: false,
                data: encodeStoreRecord(written.raw.record)
              }
            ]
          }
        })
      }) as unknown as typeof fetch
    });
    const readStore = await EASKeyStore.create({
      chainId: 8453,
      easContractAddress: EAS_ADDRESS,
      schemaUID: SCHEMA_UID,
      namespace: "test.profile",
      mode: "onchain",
      signer,
      defaultRecipient: EAS_ADDRESS,
      storage,
      indexer: readIndexer
    });

    await expect(readStore.get<{ name: string }>("profile:alice")).resolves.toMatchObject({
      value: { name: "Alice" },
      mode: "onchain"
    });
    expect(attestSpy).toHaveBeenCalledOnce();
    expect(getAttestationSpy).toHaveBeenCalled();
    expect(connectSpy).toHaveBeenCalled();
  });

  it("excludes deleted heads from default queries but includes them when requested", async () => {
    const store = await createOffchainStore();

    await store.set("profile:alice", { name: "Alice" });
    await store.set("profile:bob", { name: "Bob" });
    await store.delete("profile:bob");

    await expect(store.query()).resolves.toHaveLength(1);
    await expect(
      store.query({
        includeDeleted: true
      })
    ).resolves.toHaveLength(2);
  });

  it("uses hashed keys when a verified record has no plaintext key metadata", async () => {
    const storage = new MemoryStorage();
    const record = await makeSyntheticOnchainRecord(storage, {
      includeLookupKey: false
    });
    vi.spyOn(clientModule, "getTransport").mockReturnValue(undefined);
    const store = await EASKeyStore.create({
      chainId: 8453,
      easContractAddress: EAS_ADDRESS,
      schemaUID: SCHEMA_UID,
      namespace: "test.profile",
      mode: "onchain",
      signer: createTransactionSigner(),
      defaultRecipient: EAS_ADDRESS,
      storage,
      indexer: createIndexer([record]),
      verification: {
        requireChainValidationOnchain: false
      }
    });

    await expect(store.query()).resolves.toMatchObject([
      {
        key: record.record.keyHash
      }
    ]);
  });

  it("applies cached attester and recipient filters", async () => {
    const signer = createWalletSigner();
    const store = await createOffchainStore({
      signer
    });
    const written = await store.set("profile:alice", { name: "Alice" });

    await expect(
      store.query({
        attester:
          "0x0000000000000000000000000000000000000009"
      })
    ).resolves.toEqual([]);
    await expect(
      store.query({
        recipient:
          "0x0000000000000000000000000000000000000008"
      })
    ).resolves.toEqual([]);
    await expect(
      store.query({
        attester: written.attester,
        recipient: written.recipient
      })
    ).resolves.toHaveLength(1);
  });

  it("supports trusted attester and recipient verification policy wiring", async () => {
    const signer = createWalletSigner();
    const store = await createOffchainStore({
      signer,
      trustedAttesters: [await signer.getAddress() as `0x${string}`],
      verification: {
        requireRecipient: EAS_ADDRESS
      },
      defaultRecipient: EAS_ADDRESS
    });

    await expect(
      store.set(
        "profile:alice",
        { name: "Alice" },
        {
          extra: "0x1234"
        }
      )
    ).resolves.toMatchObject({
      recipient: EAS_ADDRESS
    });
  });

  it("requires a recipient before attempting a write", async () => {
    const store = await EASKeyStore.create({
      chainId: 8453,
      easContractAddress: EAS_ADDRESS,
      schemaUID: SCHEMA_UID,
      namespace: "test.profile",
      mode: "offchain",
      storage: new MemoryStorage(),
      indexer: new MemoryIndexer()
    });

    await expect(store.set("profile:alice", { name: "Alice" })).rejects.toThrow(
      "A recipient is required"
    );
  });

  it("fails offchain writes without a signer even when a provider is available", async () => {
    const provider = {
      estimateGas: vi.fn(),
      call: vi.fn(),
      resolveName: vi.fn()
    };
    const store = await EASKeyStore.create({
      chainId: 8453,
      easContractAddress: EAS_ADDRESS,
      schemaUID: SCHEMA_UID,
      namespace: "test.profile",
      mode: "offchain",
      provider,
      defaultRecipient: EAS_ADDRESS,
      storage: new MemoryStorage(),
      indexer: new MemoryIndexer()
    });

    await expect(store.set("profile:alice", { name: "Alice" })).rejects.toThrow(
      "A signer is required for write operations."
    );
  });

  it("supports onchain writes when easVersion and provider are both configured", async () => {
    const signer = createTransactionSigner();
    const provider = {
      estimateGas: vi.fn(),
      call: vi.fn(),
      resolveName: vi.fn()
    };
    let encodedData = "0x" as `0x${string}`;
    vi.spyOn(EAS.prototype, "connect").mockImplementation(function (this: EAS) {
      return this;
    });
    vi.spyOn(EAS.prototype, "attest").mockImplementation(async (request) => {
      encodedData = request.data.data as `0x${string}`;

      return {
        wait: vi
          .fn()
          .mockResolvedValue(
            "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
          )
      } as never;
    });
    vi.spyOn(EAS.prototype, "getAttestation").mockImplementation(async () => ({
      uid: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      schema: SCHEMA_UID,
      refUID: ZERO_UID,
      time: 10n,
      expirationTime: 0n,
      revocationTime: 0n,
      recipient: EAS_ADDRESS,
      revocable: true,
      attester: await signer.getAddress(),
      data: encodedData
    }) as never);
    const store = await EASKeyStore.create({
      chainId: 8453,
      easContractAddress: EAS_ADDRESS,
      easVersion: "1.3.0",
      schemaUID: SCHEMA_UID,
      namespace: "test.profile",
      mode: "onchain",
      signer,
      provider,
      defaultRecipient: EAS_ADDRESS,
      storage: new MemoryStorage(),
      indexer: new MemoryIndexer()
    });

    await expect(store.set("profile:alice", { name: "Alice" })).resolves.toMatchObject({
      mode: "onchain"
    });
  });

  it("writes without indexer.index and throws when local verification fails", async () => {
    const storage = {
      put: vi.fn().mockResolvedValue("memory://broken"),
      get: vi.fn().mockResolvedValue(new TextEncoder().encode("corrupted"))
    };
    const store = await createOffchainStore({
      storage,
      indexer: {
        supportsVerifiedReads: () => true,
        query: vi.fn().mockResolvedValue([])
      }
    });

    await expect(store.set("profile:alice", { name: "Alice" })).rejects.toThrow(
      ConfigurationError
    );
  });

  it("delegates verification through the verifier pipeline", async () => {
    const store = await createOffchainStore();
    const written = await store.set("profile:alice", { name: "Alice" });

    await expect(store.verify(written)).resolves.toBe(true);
  });
});
