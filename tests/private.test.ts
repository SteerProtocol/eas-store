import { SchemaRegistry } from "@ethereum-attestation-service/eas-sdk";
import { ZeroAddress } from "ethers";
import { describe, expect, it, vi } from "vitest";

import {
  EASStore,
  IndexedDBKeyBackupStorage,
  MemoryEncryptionKeyRegistry,
  MemoryIndexer,
  MemoryKeyBackupStorage,
  MemoryStorage,
  RecoveryPhraseBackupProvider,
  StoreBackedEncryptionKeyRegistry,
  WebCryptoPrivateCryptoProvider,
  computeWrappedKeysHash,
  recoveryPhraseBackup,
  uidForAccessEvent,
  uidForKeyRegistry,
  uidForPrivateValue
} from "../src";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  hexToBytes,
  randomHex
} from "../src/private/encoding";
import {
  PRIVATE_ACCESS_EVENT_SCHEMA,
  PRIVATE_KEY_REGISTRY_SCHEMA,
  PRIVATE_VALUE_SCHEMA
} from "../src/private/schemas";
import { SCHEMA_UID, createWalletSigner } from "./helpers";

describe("private records", () => {
  it("encrypts and decrypts values with real WebCrypto", async () => {
    const crypto = new WebCryptoPrivateCryptoProvider();
    const writer = await crypto.createIdentity({
      wallet: "0x0000000000000000000000000000000000000001",
      dappId: "test-dapp"
    });
    const envelope = await crypto.encryptValue({
      value: {
        email: "alice@example.com"
      },
      key: "profile.email",
      namespace: "test.private",
      dappId: "test-dapp",
      schemaUID: SCHEMA_UID,
      recordVersion: 1,
      writer,
      readers: []
    });

    await expect(
      crypto.decryptValue({
        envelope,
        key: "profile.email",
        namespace: "test.private",
        dappId: "test-dapp",
        schemaUID: SCHEMA_UID,
        identity: writer
      })
    ).resolves.toEqual({
      email: "alice@example.com"
    });
    await expect(
      crypto.decryptValue({
        envelope: {
          ...envelope,
          ciphertext: envelope.ciphertext.replace(/.$/, "A")
        },
        key: "profile.email",
        namespace: "test.private",
        dappId: "test-dapp",
        schemaUID: SCHEMA_UID,
        identity: writer
      })
    ).rejects.toThrow();
    await expect(
      crypto.decryptValue({
        envelope,
        key: "other",
        namespace: "test.private",
        dappId: "test-dapp",
        schemaUID: SCHEMA_UID,
        identity: writer
      })
    ).rejects.toThrow("key hash");
    await expect(
      crypto.decryptValue({
        envelope: {
          ...envelope,
          schemaUID: "0x9999999999999999999999999999999999999999999999999999999999999999"
        },
        key: "profile.email",
        namespace: "test.private",
        dappId: "test-dapp",
        schemaUID: SCHEMA_UID,
        identity: writer
      })
    ).rejects.toThrow("schema UID");
    await expect(
      crypto.decryptValue({
        envelope,
        key: "profile.email",
        namespace: "test.private",
        dappId: "other-dapp",
        schemaUID: SCHEMA_UID,
        identity: writer
      })
    ).rejects.toThrow("dapp ID");
    await expect(
      crypto.decryptValue({
        envelope: {
          ...envelope,
          namespaceHash: "0x9999999999999999999999999999999999999999999999999999999999999999"
        },
        key: "profile.email",
        namespace: "test.private",
        dappId: "test-dapp",
        schemaUID: SCHEMA_UID,
        identity: writer
      })
    ).rejects.toThrow("namespace hash");
    await expect(
      crypto.decryptValue({
        envelope: {
          ...envelope,
          aadHash: "0x9999999999999999999999999999999999999999999999999999999999999999"
        },
        key: "profile.email",
        namespace: "test.private",
        dappId: "test-dapp",
        schemaUID: SCHEMA_UID,
        identity: writer
      })
    ).rejects.toThrow("authenticated data");
    await expect(
      crypto.decryptValue({
        envelope: {
          ...envelope,
          wrappedKeysHash: "0x9999999999999999999999999999999999999999999999999999999999999999"
        },
        key: "profile.email",
        namespace: "test.private",
        dappId: "test-dapp",
        schemaUID: SCHEMA_UID,
        identity: writer
      })
    ).rejects.toThrow("wrapped key list");
    const unsupportedWrappedKeys = [
      {
        ...envelope.wrappedKeys[0]!,
        algorithm: "unsupported" as never
      }
    ];
    await expect(
      crypto.decryptValue({
        envelope: {
          ...envelope,
          wrappedKeys: unsupportedWrappedKeys,
          wrappedKeysHash: computeWrappedKeysHash(unsupportedWrappedKeys)
        },
        key: "profile.email",
        namespace: "test.private",
        dappId: "test-dapp",
        schemaUID: SCHEMA_UID,
        identity: writer
      })
    ).rejects.toThrow("Unsupported wrapped key algorithm");
  });

  it("creates recovery phrases, backs up identities, and restores them", async () => {
    const crypto = new WebCryptoPrivateCryptoProvider();
    const storage = new MemoryKeyBackupStorage();
    const backup = recoveryPhraseBackup({
      storage
    });
    const identity = await crypto.createIdentity({
      wallet: "0x0000000000000000000000000000000000000001",
      dappId: "test-dapp"
    });
    const phrase = await backup.createRecoveryPhrase();
    const longerPhrase = await backup.createRecoveryPhrase(24);
    const encrypted = await backup.backup(identity, phrase);

    expect(phrase.split(" ")).toHaveLength(12);
    expect(longerPhrase.split(" ")).toHaveLength(24);
    expect(encrypted.encryptedPrivateKey).not.toContain("private");
    await expect(storage.get(identity.wallet, "test-dapp")).resolves.toEqual(encrypted);
    await expect(
      backup.restore({
        backup: encrypted,
        phrase: "wrong " + phrase,
        wallet: identity.wallet
      })
    ).rejects.toThrow("Recovery phrase");
    await expect(
      backup.restore({
        backup: encrypted,
        phrase,
        wallet: "0x0000000000000000000000000000000000000002"
      })
    ).rejects.toThrow("connected wallet");

    const restored = await backup.restore({
      backup: encrypted,
      phrase,
      wallet: identity.wallet
    });

    expect(restored.keyId).toBe(identity.keyId);
  });

  it("stores encrypted key backups in IndexedDB", async () => {
    const stores = new Map<string, Map<string, unknown>>();
    const originalIndexedDB = (globalThis as typeof globalThis & {
      indexedDB?: unknown;
    }).indexedDB;
    const request = <T>(result: T) => {
      const created = {
        result,
        error: null,
        onsuccess: null as ((event: unknown) => void) | null,
        onerror: null as ((event: unknown) => void) | null
      };
      queueMicrotask(() => created.onsuccess?.({}));
      return created;
    };
    const db = {
      close() {},
      objectStoreNames: {
        contains: (name: string) => stores.has(name)
      },
      createObjectStore(name: string) {
        stores.set(name, new Map());
      },
      transaction(name: string) {
        return {
          objectStore() {
            const store = stores.get(name)!;
            return {
              put(value: { id: string }) {
                store.set(value.id, value);
                return request(undefined);
              },
              get(key: string) {
                return request(store.get(key));
              }
            };
          }
        };
      }
    };

    (globalThis as typeof globalThis & {
      indexedDB?: unknown;
    }).indexedDB = {
      open() {
        const created = {
          result: db,
          error: null,
          onsuccess: null as ((event: unknown) => void) | null,
          onerror: null as ((event: unknown) => void) | null,
          onupgradeneeded: null as ((event: { target: { result: typeof db } }) => void) | null
        };
        queueMicrotask(() => {
          created.onupgradeneeded?.({
            target: {
              result: db
            }
          });
          created.onsuccess?.({});
        });
        return created;
      }
    };

    try {
      const crypto = new WebCryptoPrivateCryptoProvider();
      const identity = await crypto.createIdentity({
        wallet: "0x0000000000000000000000000000000000000001",
        dappId: "test-dapp"
      });
      const backup = recoveryPhraseBackup({
        storage: new IndexedDBKeyBackupStorage({
          dbName: "test-db"
        })
      });
      const phrase = await backup.createRecoveryPhrase();
      const encrypted = await backup.backup(identity, phrase);

      await expect(backup.storage?.get(identity.wallet, identity.dappId)).resolves.toEqual(encrypted);
    } finally {
      (globalThis as typeof globalThis & {
        indexedDB?: unknown;
      }).indexedDB = originalIndexedDB;
    }

    (globalThis as typeof globalThis & {
      indexedDB?: unknown;
    }).indexedDB = undefined;

    try {
      await expect(
        new IndexedDBKeyBackupStorage().get(
          "0x0000000000000000000000000000000000000001",
          "test-dapp"
        )
      ).rejects.toThrow("indexedDB support");
    } finally {
      (globalThis as typeof globalThis & {
        indexedDB?: unknown;
      }).indexedDB = originalIndexedDB;
    }
  });

  it("rejects tampered encrypted key backup metadata", async () => {
    const crypto = new WebCryptoPrivateCryptoProvider();
    const backup = recoveryPhraseBackup();
    const identity = await crypto.createIdentity({
      wallet: "0x0000000000000000000000000000000000000001",
      dappId: "test-dapp"
    });
    const phrase = await backup.createRecoveryPhrase();
    const encrypted = await backup.backup(identity, phrase);

    await expect(
      backup.restore({
        backup: {
          ...encrypted,
          dappId: "other-dapp"
        },
        phrase,
        wallet: identity.wallet
      })
    ).rejects.toThrow("Recovery phrase");
    await expect(
      backup.restore({
        backup: {
          ...encrypted,
          keyId: "0x9999999999999999999999999999999999999999999999999999999999999999"
        },
        phrase,
        wallet: identity.wallet
      })
    ).rejects.toThrow("Recovery phrase");
    await expect(
      backup.restore({
        backup: {
          ...encrypted,
          encryption: {
            ...encrypted.encryption,
            iterations: 1
          }
        },
        phrase,
        wallet: identity.wallet
      })
    ).rejects.toThrow("iterations");
    await expect(
      backup.backup(identity, "not a real phrase")
    ).rejects.toThrow("valid 12 or 24 word");
    await expect(
      backup.restore({
        backup: {
          ...encrypted,
          encryption: {
            ...encrypted.encryption,
            kdf: "scrypt" as never
          }
        },
        phrase,
        wallet: identity.wallet
      })
    ).rejects.toThrow("Unsupported key backup KDF");
    await expect(
      backup.restore({
        backup: {
          ...encrypted,
          version: 2 as never
        },
        phrase,
        wallet: identity.wallet
      })
    ).rejects.toThrow("Unsupported encrypted key backup");
  });

  it("restores backups from configured storage and fails without a backup", async () => {
    const signer = createWalletSigner();
    const storage = new MemoryKeyBackupStorage();
    const store = await EASStore["private"]({
      signer,
      namespace: "test.private",
      schemaUID: SCHEMA_UID,
      mode: "local",
      backup: new RecoveryPhraseBackupProvider(storage)
    });
    const phrase = await store.private.identity.createRecoveryPhrase();

    await store.private.identity.create();
    await store.private.identity.backup({
      phrase
    });

    const restored = await store.private.identity.restore({
      phrase
    });

    expect(restored.wallet).toBe((await signer.getAddress()).toLowerCase());

    const empty = await EASStore["private"]({
      signer: createWalletSigner(),
      namespace: "test.private",
      schemaUID: SCHEMA_UID,
      mode: "local"
    });

    await expect(
      empty.private.identity.restore({
        phrase
      })
    ).rejects.toThrow("No encrypted key backup");
  });

  it("rejects corrupted identities during key publication", async () => {
    const crypto = new WebCryptoPrivateCryptoProvider();
    const identity = await crypto.createIdentity({
      wallet: "0x0000000000000000000000000000000000000001",
      dappId: "test.private"
    });
    const badIdentity = {
      ...identity,
      keyId: "0x9999999999999999999999999999999999999999999999999999999999999999" as const
    };
    const memoryRegistry = new MemoryEncryptionKeyRegistry();
    const storeRegistry = new StoreBackedEncryptionKeyRegistry({
      async set() {
        return undefined;
      },
      async getRecord() {
        return null;
      }
    });

    await expect(memoryRegistry.publish(badIdentity)).rejects.toThrow("key ID");
    await expect(storeRegistry.publish(badIdentity)).rejects.toThrow("key ID");
  });

  it("requires explicit local mode and rejects unsupported private registry schema wiring", async () => {
    const signer = createWalletSigner();

    await expect(
      EASStore["private"]({
        signer,
        namespace: "test.private",
        schemaUID: SCHEMA_UID,
        keyRegistrySchemaUID: SCHEMA_UID
      })
    ).rejects.toThrow("keyRegistrySchemaUID is reserved");

    const defaultStore = await EASStore["private"]({
      signer,
      namespace: "test.private",
      schemaUID: SCHEMA_UID,
      indexer: new MemoryIndexer()
    });

    await expect(defaultStore.private.set("secret", "v1")).rejects.toThrow(
      "Private identity is not initialized"
    );
  });

  it("sets and gets private values for the writer", async () => {
    const signer = createWalletSigner();
    const store = await EASStore["private"]({
      signer,
      namespace: "test.private",
      schemaUID: SCHEMA_UID,
      mode: "local"
    });

    const phrase = await store.private.identity.createRecoveryPhrase();
    await store.private.identity.create();
    const backup = await store.private.identity.backup({
      phrase
    });
    await store.private.set("profile.email", "alice@example.com");

    await expect(store.private.get("profile.email")).resolves.toBe("alice@example.com");
    await expect(store.private.get("missing")).resolves.toBeNull();
    await expect(
      store.private.revokeFuture("missing", {
        reader: (await store.private.identity.current()!).wallet
      })
    ).rejects.toThrow("missing private key");
    expect(backup.wallet).toBe((await signer.getAddress()).toLowerCase());
  });

  it("rejects reader keys scoped to a different dapp", async () => {
    const registry = new MemoryEncryptionKeyRegistry();
    const writer = await EASStore["private"]({
      signer: createWalletSigner(),
      namespace: "test.private",
      schemaUID: SCHEMA_UID,
      mode: "local",
      registry
    });
    const reader = await EASStore["private"]({
      signer: createWalletSigner(),
      namespace: "test.private",
      schemaUID: SCHEMA_UID,
      mode: "local",
      dappId: "other-dapp",
      registry
    });

    const readerIdentity = await reader.private.identity.create();
    const otherDappReader = await reader.private.identity.publishKey();

    await expect(writer.private.resolveReader(readerIdentity.wallet)).rejects.toThrow(
      "No registered encryption key"
    );

    const maliciousRegistry = {
      async publish() {
        return otherDappReader;
      },
      async resolve() {
        return otherDappReader;
      }
    };
    const guardedWriter = await EASStore["private"]({
      signer: createWalletSigner(),
      namespace: "test.private",
      schemaUID: SCHEMA_UID,
      mode: "local",
      registry: maliciousRegistry
    });

    await expect(guardedWriter.private.resolveReader(readerIdentity.wallet)).rejects.toThrow(
      "is scoped to other-dapp"
    );
  });

  it("grants another registered reader access to the latest version", async () => {
    const registry = new MemoryEncryptionKeyRegistry();
    const shared = await EASStore.local({
      namespace: "test.private",
      schemaUID: SCHEMA_UID
    });
    const writer = await EASStore["private"]({
      signer: createWalletSigner(),
      namespace: "test.private",
      schemaUID: SCHEMA_UID,
      mode: "local",
      registry,
      store: shared
    });
    const reader = await EASStore["private"]({
      signer: createWalletSigner(),
      namespace: "test.private",
      schemaUID: SCHEMA_UID,
      mode: "local",
      registry,
      store: shared
    });

    await writer.private.identity.create();
    await reader.private.identity.create();
    await reader.private.identity.publishKey();
    await expect(writer.private.resolveReader("0x0000000000000000000000000000000000000999")).rejects.toThrow(
      "No registered encryption key"
    );
    await writer.private.set("secret", {
      value: 1
    });
    await expect(reader.private.get("secret")).rejects.toThrow("No wrapped data key");

    const readerIdentity = reader.private.identity.current()!;
    const readerInfo = await writer.private.resolveReader(readerIdentity.wallet);
    await expect(writer.private.verifyReader(readerInfo)).resolves.toBe(true);
    await expect(
      writer.private.verifyReader({
        ...readerInfo,
        keyId: "0x9999999999999999999999999999999999999999999999999999999999999999"
      })
    ).resolves.toBe(false);
    await writer.private.grant("secret", {
      reader: readerInfo
    });

    await expect(reader.private.get("secret")).resolves.toEqual({
      value: 1
    });
    await writer.private.set("secret", {
      value: 2
    }, {
      inheritReaders: true
    });
    await expect(reader.private.get("secret")).resolves.toEqual({
      value: 2
    });
    await expect(
      writer.private.grant("missing", {
        reader: readerInfo
      })
    ).rejects.toThrow("missing private key");
  });

  it("uses the verified store-backed key registry by default across SDK instances", async () => {
    const indexer = new MemoryIndexer();
    const storage = new MemoryStorage();
    const writerSigner = createWalletSigner();
    const readerSigner = createWalletSigner();
    const writerStore = await EASStore.local({
      signer: writerSigner,
      namespace: "test.private",
      schemaUID: SCHEMA_UID,
      indexer,
      storage
    });
    const readerStore = await EASStore.local({
      signer: readerSigner,
      namespace: "test.private",
      schemaUID: SCHEMA_UID,
      indexer,
      storage
    });
    const writer = await EASStore["private"]({
      signer: writerSigner,
      namespace: "test.private",
      schemaUID: SCHEMA_UID,
      mode: "local",
      store: writerStore
    });
    const reader = await EASStore["private"]({
      signer: readerSigner,
      namespace: "test.private",
      schemaUID: SCHEMA_UID,
      mode: "local",
      store: readerStore
    });

    await writer.private.identity.create();
    const readerIdentity = await reader.private.identity.create();
    await reader.private.identity.publishKey();
    const readerInfo = await writer.private.resolveReader(readerIdentity.wallet);

    await writer.private.set("secret", "v1", {
      readers: [readerInfo]
    });

    await expect(reader.private.get("secret")).resolves.toBe("v1");
  });

  it("rejects forged or stale store-backed key registry records", async () => {
    const crypto = new WebCryptoPrivateCryptoProvider();
    const identity = await crypto.createIdentity({
      wallet: "0x0000000000000000000000000000000000000001",
      dappId: "test.private"
    });
    const validClaim = {
      version: 1 as const,
      wallet: identity.wallet,
      keyId: identity.keyId,
      algorithm: identity.algorithm,
      publicKey: identity.publicKey,
      keyVersion: identity.keyVersion,
      dappId: identity.dappId,
      createdAt: identity.createdAt
    };
    const registryFor = (record: unknown) =>
      new StoreBackedEncryptionKeyRegistry({
        async set() {
          return undefined;
        },
        async getRecord() {
          return record as never;
        }
      });

    await expect(
      registryFor(null).resolve(identity.wallet)
    ).resolves.toBeNull();
    await expect(
      registryFor({
        value: validClaim,
        attester: identity.wallet,
        verified: false
      }).resolve(identity.wallet)
    ).rejects.toThrow("not verified");
    await expect(
      registryFor({
        value: validClaim,
        attester: "0x0000000000000000000000000000000000000002",
        verified: true
      }).resolve(identity.wallet)
    ).rejects.toThrow("was not attested");
    await expect(
      registryFor({
        value: {
          ...validClaim,
          wallet: "0x0000000000000000000000000000000000000002"
        },
        attester: identity.wallet,
        verified: true
      }).resolve(identity.wallet)
    ).rejects.toThrow("wallet mismatch");
    await expect(
      registryFor({
        value: {
          ...validClaim,
          algorithm: "bad" as never
        },
        attester: identity.wallet,
        verified: true
      }).resolve(identity.wallet)
    ).rejects.toThrow("Unsupported encryption key algorithm");
    await expect(
      registryFor({
        value: {
          ...validClaim,
          expiresAt: Math.floor(Date.now() / 1000) - 1
        },
        attester: identity.wallet,
        verified: true
      }).resolve(identity.wallet)
    ).rejects.toThrow("expired");
    await expect(
      registryFor({
        value: {
          ...validClaim,
          keyId: "0x9999999999999999999999999999999999999999999999999999999999999999"
        },
        attester: identity.wallet,
        verified: true
      }).resolve(identity.wallet)
    ).rejects.toThrow("key ID mismatch");
  });

  it("blocks non-owner readers from granting or rotating private records", async () => {
    const registry = new MemoryEncryptionKeyRegistry();
    const shared = await EASStore.local({
      namespace: "test.private",
      schemaUID: SCHEMA_UID
    });
    const writer = await EASStore["private"]({
      signer: createWalletSigner(),
      namespace: "test.private",
      schemaUID: SCHEMA_UID,
      mode: "local",
      registry,
      store: shared
    });
    const reader = await EASStore["private"]({
      signer: createWalletSigner(),
      namespace: "test.private",
      schemaUID: SCHEMA_UID,
      mode: "local",
      registry,
      store: shared
    });
    const third = await EASStore["private"]({
      signer: createWalletSigner(),
      namespace: "test.private",
      schemaUID: SCHEMA_UID,
      mode: "local",
      registry,
      store: shared
    });

    await writer.private.identity.create();
    const readerIdentity = await reader.private.identity.create();
    const thirdIdentity = await third.private.identity.create();
    await reader.private.identity.publishKey();
    await third.private.identity.publishKey();
    const readerInfo = await writer.private.resolveReader(readerIdentity.wallet);
    const thirdInfo = await writer.private.resolveReader(thirdIdentity.wallet);

    await writer.private.set("secret", "v1", {
      readers: [readerInfo]
    });
    await expect(reader.private.get("secret")).resolves.toBe("v1");
    await expect(
      reader.private.grant("secret", {
        reader: thirdInfo
      })
    ).rejects.toThrow("Only the private record owner");
    await expect(
      reader.private.rotate("secret", "v2", {
        readers: [thirdInfo]
      })
    ).rejects.toThrow("Only the private record owner");
  });

  it("rejects unverified reader objects even when they contain a wallet address", async () => {
    const registry = new MemoryEncryptionKeyRegistry();
    const writer = await EASStore["private"]({
      signer: createWalletSigner(),
      namespace: "test.private",
      schemaUID: SCHEMA_UID,
      mode: "local",
      registry
    });
    const reader = await EASStore["private"]({
      signer: createWalletSigner(),
      namespace: "test.private",
      schemaUID: SCHEMA_UID,
      mode: "local",
      registry
    });

    await writer.private.identity.create();
    const readerIdentity = await reader.private.identity.create();
    await reader.private.identity.publishKey();
    const readerInfo = await writer.private.resolveReader(readerIdentity.wallet);

    await expect(
      writer.private.set("secret", "v1", {
        readers: [
          {
            ...readerInfo,
            keyId: "0x9999999999999999999999999999999999999999999999999999999999999999"
          }
        ]
      })
    ).rejects.toThrow("not verified");
  });

  it("keeps revocation forward-only through rotate", async () => {
    const registry = new MemoryEncryptionKeyRegistry();
    const shared = await EASStore.local({
      namespace: "test.private",
      schemaUID: SCHEMA_UID
    });
    const writer = await EASStore["private"]({
      signer: createWalletSigner(),
      namespace: "test.private",
      schemaUID: SCHEMA_UID,
      mode: "local",
      registry,
      store: shared
    });
    const reader = await EASStore["private"]({
      signer: createWalletSigner(),
      namespace: "test.private",
      schemaUID: SCHEMA_UID,
      mode: "local",
      registry,
      store: shared
    });

    await writer.private.identity.create();
    const readerIdentity = await reader.private.identity.create();
    await reader.private.identity.publishKey();
    const readerInfo = await writer.private.resolveReader(readerIdentity.wallet);

    await writer.private.set("secret", "v1", {
      readers: [readerInfo]
    });
    await expect(reader.private.get("secret")).resolves.toBe("v1");

    await writer.private.revokeFuture("secret", {
      reader: readerInfo
    });
    await writer.private.rotate("secret", "v2", {
      readers: []
    });

    await expect(reader.private.get("secret")).rejects.toThrow("No wrapped data key");
    await expect(writer.private.get("secret")).resolves.toBe("v2");
  });

  it("exposes deterministic private schema UID helpers", () => {
    expect(uidForKeyRegistry()).toMatch(/^0x[0-9a-f]{64}$/);
    expect(uidForPrivateValue()).toMatch(/^0x[0-9a-f]{64}$/);
    expect(uidForAccessEvent()).toMatch(/^0x[0-9a-f]{64}$/);
    expect(EASStore.privateSchema.uidForKeyRegistry()).toBe(uidForKeyRegistry());
  });

  it("ensures all private schemas through EAS schema helpers", async () => {
    const signer = createWalletSigner();
    vi.spyOn(SchemaRegistry.prototype, "connect").mockImplementation(function (
      this: SchemaRegistry
    ) {
      return this;
    });
    vi.spyOn(SchemaRegistry.prototype, "getSchema").mockImplementation(async (input) => ({
      uid: input.uid,
      schema:
        input.uid === uidForKeyRegistry()
          ? PRIVATE_KEY_REGISTRY_SCHEMA
          : input.uid === uidForPrivateValue()
            ? PRIVATE_VALUE_SCHEMA
            : PRIVATE_ACCESS_EVENT_SCHEMA,
      resolver: ZeroAddress,
      revocable: true
    }) as never);

    await expect(
      EASStore.privateSchema.ensureAll({
        network: "base-sepolia",
        signer
      })
    ).resolves.toMatchObject({
      keyRegistry: {
        schema: PRIVATE_KEY_REGISTRY_SCHEMA
      },
      privateValue: {
        schema: PRIVATE_VALUE_SCHEMA
      },
      accessEvent: {
        schema: PRIVATE_ACCESS_EVENT_SCHEMA
      }
    });
  });

  it("covers private encoding helpers and browser-style base64 fallback", () => {
    const bytes = new Uint8Array([1, 2, 253]);
    const encoded = bytesToBase64Url(bytes);

    expect(base64UrlToBytes(encoded)).toEqual(bytes);
    expect(hexToBytes(randomHex(4))).toHaveLength(4);
  });
});
