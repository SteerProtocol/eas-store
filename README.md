# @steerprotocol/eas-store

`@steerprotocol/eas-store` is a TypeScript SDK for building a verifiable key/value store on top of Ethereum Attestation Service.

Use it like a small database. Verify it like an attestation.

- `set`, `get`, `del`, `history`, and `scan` for database-like app code.
- Onchain, offchain, and local development modes.
- Verification-first reads with canonical linked history.
- Inline storage for small JSON values.
- Private encrypted records with app-specific recovery phrases.
- Adapter hooks for custom storage and indexing.

Repository: [github.com/SteerProtocol/eas-store](https://github.com/SteerProtocol/eas-store)

## Install

```bash
npm install @steerprotocol/eas-store
```

Requires Node.js 20+ or a modern browser with WebCrypto support.

## Mental Model

EAS Store uses EAS as a verifiable write log, not as a mutable database.

```txt
app
  |
  v
EASStore.set(key, value)
  |
  |-- canonicalize + hash value
  |-- store value inline or through a storage adapter
  |-- write an EAS attestation
  |-- link to previousUID
  |-- index for lookup
  v
verified record history
```

Records are append-only. Updates write a new version. Deletes write a tombstone. Reads verify the record before returning it.

Default store schema:

```txt
bytes32 namespace,
bytes32 key,
bytes32 valueHash,
string valueURI,
string contentType,
uint64 version,
uint8 operation,
bytes32 previousUID,
bytes extra
```

## Quick Start

### Local Store

Use local mode for demos, tests, and development without wallet or network setup.

```ts
import { EASStore } from "@steerprotocol/eas-store";

const store = await EASStore.local({
  namespace: "my-dapp"
});

await store.set("profile:alice", {
  name: "Alice",
  role: "admin"
});

const value = await store.get<{ name: string; role: string }>("profile:alice");
console.log(value?.name); // Alice
```

`get()` returns the decoded value. Use `getRecord()` when you need attestation metadata.

```ts
const record = await store.getRecord("profile:alice");

console.log(record?.uid);
console.log(record?.version);
console.log(record?.verified);
```

### Mock Provider For App Tests

Consumer apps can import the testing entrypoint when they want one reusable,
resettable EAS Store provider for a Vitest, Jest, or Playwright test suite.

```ts
import { createMockEASStoreProvider } from "@steerprotocol/eas-store/testing";

const easStore = createMockEASStoreProvider({
  namespace: "my-dapp.test"
});

beforeEach(() => {
  easStore.reset();
});

it("reads app settings", async () => {
  const store = await easStore.store();

  await store.set("settings:theme", {
    value: "dark"
  });

  await expect(store.get("settings:theme")).resolves.toEqual({
    value: "dark"
  });
});
```

Stores created from the same provider share in-memory storage and indexing, so
separate app services can see the same mock attestations. Passing a different
`namespace` keeps records isolated while still using the same provider.

### Onchain Store

Use onchain mode when records should be public, chain-verifiable, and discoverable through an indexer.

```ts
import { EASStore } from "@steerprotocol/eas-store";

const store = await EASStore.onchain({
  network: "base-sepolia",
  namespace: "my-dapp",
  signer,
  schemaUID: process.env.EAS_STORE_SCHEMA_UID as `0x${string}`
});

await store.set("profile:alice", {
  name: "Alice",
  avatar: "ipfs://..."
});

const profile = await store.get<{ name: string; avatar: string }>("profile:alice");
```

Network presets fill in chain ID, EAS contract address, EAS version, inline storage for small values, and EASScan discovery when available.

### Offchain Store

Use offchain mode when you want gas-free signed attestations and control the storage/indexing path.

```ts
import { EASStore, MemoryIndexer } from "@steerprotocol/eas-store";

const store = await EASStore.offchain({
  network: "base-sepolia",
  namespace: "my-dapp",
  signer,
  schemaUID,
  indexer: new MemoryIndexer()
});

await store.set("draft:alice", {
  status: "pending"
});

const draft = await store.get("draft:alice");
```

Verified offchain reads require an indexer that preserves the original signed offchain attestation package. `EASScanIndexer` is rejected for offchain verified reads because it does not provide that package.

## Schema Setup

Run schema setup once per chain/environment, then persist the returned UID in your app configuration.

```ts
import { EASStore } from "@steerprotocol/eas-store";

const schema = await EASStore.schema.ensureDefault({
  network: "base-sepolia",
  signer
});

console.log(schema.uid);
```

`ensureDefault()` is idempotent. It computes the expected schema UID, checks the registry, and only sends a registration transaction when the schema is missing.

Check a schema:

```ts
const exists = await EASStore.schema.exists({
  network: "base-sepolia",
  uid: schema.uid,
  signer
});

const status = await EASStore.schema.get({
  network: "base-sepolia",
  uid: schema.uid,
  signer
});
```

Private schema helpers are also exported for apps that want dedicated private-record schemas:

```ts
const schemas = await EASStore.privateSchema.ensureAll({
  network: "base-sepolia",
  signer
});

console.log(schemas.keyRegistry.uid);
console.log(schemas.privateValue.uid);
console.log(schemas.accessEvent.uid);
```

## Common Flows

### Set And Get

```ts
await store.set("settings:theme", {
  value: "dark"
});

const settings = await store.get<{ value: string }>("settings:theme");
```

### Update A Record

```ts
await store.set("settings:theme", { value: "dark" });
await store.set("settings:theme", { value: "light" });

const latest = await store.get("settings:theme");
const history = await store.history("settings:theme");
```

The second write links to the first write through `previousUID`.

### Delete A Record

```ts
await store.del("settings:theme");

const value = await store.get("settings:theme");
console.log(value); // null

const history = await store.history("settings:theme");
console.log(history.at(-1)?.operation); // StoreOperation.Delete
```

`delete()` is also available as an alias for `del()`.

### Scan Records

```ts
const records = await store.scan({
  limit: 20
});

const includingDeleted = await store.scan({
  includeDeleted: true
});
```

`scan()` returns verified canonical heads. `query()` is an alias.

### Verify A Record

```ts
const record = await store.getRecord("profile:alice");

if (record) {
  const ok = await store.verify(record);
  console.log(ok); // true
}
```

### Restrict Trusted Attesters

Anyone can attest to a public schema. For app-owned records, pass a trusted attester allowlist.

```ts
const store = await EASStore.onchain({
  network: "base",
  namespace: "my-dapp",
  signer,
  schemaUID,
  trustedAttesters: [
    "0x1234567890123456789012345678901234567890"
  ]
});
```

You can also require a recipient and tune expiry/revocation policy.

```ts
const store = await EASStore.onchain({
  network: "base",
  namespace: "my-dapp",
  signer,
  schemaUID,
  verification: {
    requireRecipient: userAddress,
    allowExpired: false,
    allowRevoked: false
  }
});
```

### Timestamp Offchain Attestations

```ts
const receipt = await store.set("profile:alice", { name: "Alice" });

await store.timestamp(receipt.uid);
await store.batchTimestamp([receipt.uid]);
```

Timestamping is useful when offchain attestations need an onchain proof-of-existence time.

## Private Records

Private records encrypt values before writing the attestation. The wallet signs EAS records, but a dedicated app encryption identity decrypts private values.

The recovery phrase restores only this app encryption identity. It is not a wallet seed phrase.

```ts
import {
  EASStore,
  IndexedDBKeyBackupStorage,
  recoveryPhraseBackup
} from "@steerprotocol/eas-store";

const privateStore = await EASStore.private({
  mode: "onchain",
  network: "base-sepolia",
  signer,
  namespace: "my-dapp",
  schemaUID: process.env.EAS_STORE_SCHEMA_UID as `0x${string}`,
  backup: recoveryPhraseBackup({
    storage: new IndexedDBKeyBackupStorage({
      dbName: "my-dapp-eas-store"
    })
  })
});
```

Create and back up a private identity:

```ts
const phrase = await privateStore.identity.createRecoveryPhrase();

await privateStore.identity.create();
await privateStore.identity.backup({ phrase });
await privateStore.identity.publishKey();
```

What each step does:

- `createRecoveryPhrase()` creates a BIP-39 recovery phrase.
- `create()` creates the app encryption identity locally.
- `backup({ phrase })` encrypts the private key backup with the phrase.
- `publishKey()` writes the public encryption key claim so other wallets can encrypt to this user.

Restore:

```ts
await privateStore.identity.restore({
  phrase
});

const identity = privateStore.identity.current();
```

Restore requires the connected wallet to match the wallet recorded in the encrypted backup.

Set and get private values:

```ts
await privateStore.set("profile:email", "alice@example.com");

const email = await privateStore.get<string>("profile:email");
```

Add a reader:

```ts
const bobAddress = "0x1234567890123456789012345678901234567890" as const;
const reader = await privateStore.resolveReader(bobAddress);

const valid = await privateStore.verifyReader(reader);

if (valid) {
  await privateStore.grant("profile:email", {
    reader,
    scope: "latest-version"
  });
}
```

Revoke future access:

```ts
await privateStore.revokeFuture("profile:email", {
  reader
});

await privateStore.rotate("profile:email", "new@example.com", {
  readers: [reader]
});
```

Revocation is forward-only. A reader may already have decrypted old ciphertext, but future rotated versions can exclude them.

Private value encryption uses AES-256-GCM. Per-reader data-key wrapping uses ephemeral ECDH, HKDF-SHA-256, and AES-GCM with dapp/schema/key/reader context bound into derivation and authenticated data.

## Networks

Built-in network presets cover the EASScan-indexed EAS deployments for:

- Ethereum
- Sepolia
- Arbitrum
- Arbitrum Nova
- Base
- Base Sepolia
- Optimism
- Optimism Sepolia
- Scroll
- Polygon
- Linea
- Celo

Use a preset by key:

```ts
const store = await EASStore.onchain({
  network: "base",
  namespace: "my-dapp",
  signer,
  schemaUID
});
```

Look up a preset:

```ts
import { getEASNetworkPreset, getEASNetworkPresetByKey } from "@steerprotocol/eas-store";

const base = getEASNetworkPreset(8453);
const baseSepolia = getEASNetworkPresetByKey("base-sepolia");
```

Use a custom EAS deployment:

```ts
const store = await EASStore.onchain({
  network: {
    chainId: 84532,
    easContractAddress: "0x..." as `0x${string}`,
    schemaRegistryAddress: "0x..." as `0x${string}`,
    graphqlEndpoint: "https://..."
  },
  namespace: "my-dapp",
  signer,
  schemaUID
});
```

Without a GraphQL endpoint, onchain writes still work, but remote cross-session reads require your own durable indexer.

## Storage And Indexers

EAS Store keeps storage and indexing pluggable.

Storage adapter shape:

```ts
interface StorageAdapter {
  readonly persistence?: "inline" | "remote" | "local";
  put(data: Uint8Array, contentType: string): Promise<string>;
  get(uri: string): Promise<Uint8Array>;
}
```

Built-in storage adapters:

- `InlineStorage` / `inlineStorage()` stores small values as `data:` URIs in the attestation payload.
- `MemoryStorage` stores values in process memory for tests and local demos.

Use inline storage explicitly:

```ts
import { inlineStorage } from "@steerprotocol/eas-store";

const store = await EASStore.onchain({
  network: "base-sepolia",
  namespace: "my-dapp",
  signer,
  schemaUID,
  storage: inlineStorage({
    maxBytes: 32_768
  })
});
```

Indexer adapter shape:

```ts
interface IndexerAdapter {
  readonly scope?: "remote" | "local";
  index?(record: IndexedStoreRecord): Promise<void>;
  query(filter: IndexQuery): Promise<IndexedStoreRecord[]>;
  supportsVerifiedReads?(mode: "onchain" | "offchain"): boolean;
}
```

Built-in indexers:

- `EASScanIndexer` discovers onchain attestations through EASScan GraphQL.
- `MemoryIndexer` stores indexed records in memory.
- `LocalStorageIndexer` stores indexed records in browser local storage.

EASScan is discovery only. Verification still checks chain data and value hashes before records are returned.

## Verification And Canonical History

Onchain reads:

- query an indexer for candidate attestations
- fetch the authoritative attestation from chain
- derive revocation and expiry from chain data
- verify schema, namespace, trusted attester policy, recipient policy, payload integrity, and value hash

Offchain reads:

- require the original signed offchain package
- verify the EIP-712 signature
- optionally require an onchain timestamp
- verify payload integrity and value hash

Canonical history rules:

- Records are append-only.
- A key is readable only when its verified records form one unambiguous linked chain.
- If multiple verified heads exist, `get()` returns `null`.
- `scan()` / `query()` exclude ambiguous keys.
- `history()` and future writes fail with `VerificationError` when history is ambiguous.
- `scan({ limit })` applies the limit after deduplicating to one canonical head per key.

Read support matrix:

| Mode | Indexer | Verified remote reads | Notes |
| --- | --- | --- | --- |
| `onchain` | `MemoryIndexer` | Yes | Useful for tests and local flows |
| `onchain` | `EASScanIndexer` | Yes | Discovery through GraphQL; truth comes from chain |
| `offchain` | `MemoryIndexer` | Yes | Works because the signed offchain package is preserved |
| `offchain` | `EASScanIndexer` | No | Rejected at creation time |

Durable verified offchain remote reads require an indexer that preserves the original signed offchain package.

## Advanced Construction

Use `EASKeyStore.create(...)` or `EASStore.createAdvanced(...)` when you need direct adapter control.

```ts
import {
  EASKeyStore,
  EASScanIndexer,
  InlineStorage,
  getEASNetworkPreset
} from "@steerprotocol/eas-store";

const base = getEASNetworkPreset(8453);

if (!base) {
  throw new Error("Base preset missing");
}

const keyStore = await EASKeyStore.create({
  chainId: base.chainId,
  easContractAddress: base.easContractAddress,
  easVersion: base.easVersion,
  schemaUID,
  namespace: "my-dapp",
  signer,
  mode: "onchain",
  storage: new InlineStorage(),
  indexer: new EASScanIndexer({
    endpoint: base.graphqlEndpoint
  }),
  trustedAttesters: [await signer.getAddress() as `0x${string}`]
});

const record = await keyStore.get("profile:alice");
```

## API Reference

### `EASStore`

Constructors:

```ts
EASStore.local(options): Promise<EASStore>
EASStore.onchain(options): Promise<EASStore>
EASStore.offchain(options): Promise<EASStore>
EASStore.private(options): Promise<EASPrivateStore>
EASStore.createAdvanced(config): Promise<EASKeyStore>
```

Instance methods:

```ts
store.set<T>(key: string, value: T, options?: SetOptions): Promise<WriteReceipt>
store.get<T = unknown>(key: string): Promise<T | null>
store.getRecord<T = unknown>(key: string): Promise<StoredRecord<T> | null>
store.del(key: string): Promise<WriteReceipt>
store.delete(key: string): Promise<WriteReceipt>
store.history<T = unknown>(key: string): Promise<Array<StoredRecord<T>>>
store.scan<T = unknown>(filter?: QueryFilter): Promise<Array<StoredRecord<T>>>
store.query<T = unknown>(filter?: QueryFilter): Promise<Array<StoredRecord<T>>>
store.verify(record: StoredRecord): Promise<boolean>
store.timestamp(uid: `0x${string}`): Promise<bigint>
store.batchTimestamp(uids: Array<`0x${string}`>): Promise<bigint[]>
store.advanced: EASKeyStore
```

Schema helpers:

```ts
EASStore.schema.uidForDefault(options?): `0x${string}`
EASStore.schema.ensureDefault(options): Promise<EnsuredSchema>
EASStore.schema.get(options): Promise<SchemaStatus>
EASStore.schema.exists(options): Promise<boolean>
```

Private schema helpers:

```ts
EASStore.privateSchema.uidForKeyRegistry(options): `0x${string}`
EASStore.privateSchema.uidForPrivateValue(options): `0x${string}`
EASStore.privateSchema.uidForAccessEvent(options): `0x${string}`
EASStore.privateSchema.ensureAll(options): Promise<{
  keyRegistry: EnsuredSchema;
  privateValue: EnsuredSchema;
  accessEvent: EnsuredSchema;
}>
```

### `@steerprotocol/eas-store/testing`

Test helpers:

```ts
createMockEASStore(options?): Promise<EASStore>
createMockEASStoreProvider(options?): MockEASStoreProvider

provider.store(options?): Promise<EASStore>
provider.advancedStore(options?): Promise<EASKeyStore>
provider.reset(): void
provider.getAddress(): Promise<`0x${string}`>
provider.signer: StoreSigner
provider.sharedStorage: StorageAdapter
provider.sharedIndexer: IndexerAdapter
```

### `EASPrivateStore`

```ts
privateStore.identity.create(): Promise<EncryptionIdentity>
privateStore.identity.createRecoveryPhrase(words?: 12 | 24): Promise<string>
privateStore.identity.backup(input: { phrase: string }): Promise<EncryptedKeyBackup>
privateStore.identity.restore(input: {
  phrase: string;
  backup?: EncryptedKeyBackup;
}): Promise<EncryptionIdentity>
privateStore.identity.publishKey(): Promise<PrivateReader>
privateStore.identity.current(): EncryptionIdentity | null

privateStore.set<T>(key: string, value: T, options?: PrivateSetOptions): Promise<unknown>
privateStore.get<T = unknown>(key: string): Promise<T | null>
privateStore.getRecord<T = unknown>(key: string): Promise<StoredRecord<T> | null>
privateStore.resolveReader(reader: `0x${string}`): Promise<PrivateReader>
privateStore.verifyReader(reader: PrivateReader): Promise<boolean>
privateStore.grant(key: string, options: PrivateGrantOptions): Promise<void>
privateStore.revokeFuture(key: string, options: PrivateRevokeOptions): Promise<void>
privateStore.rotate<T>(key: string, value: T, options: PrivateRotateOptions): Promise<unknown>
```

### `EASKeyStore`

`EASKeyStore` is the lower-level API. It returns full `StoredRecord` objects from `get()` instead of only returning decoded values.

```ts
EASKeyStore.create(config: EASKeyStoreConfig): Promise<EASKeyStore>

keyStore.set<T>(key: string, value: T, options?: SetOptions): Promise<StoredRecord<T>>
keyStore.get<T = unknown>(key: string): Promise<StoredRecord<T> | null>
keyStore.delete(key: string): Promise<StoredRecord<null>>
keyStore.history<T = unknown>(key: string): Promise<Array<StoredRecord<T>>>
keyStore.query<T = unknown>(filter?: QueryFilter): Promise<Array<StoredRecord<T>>>
keyStore.verify(record: StoredRecord): Promise<boolean>
keyStore.timestamp(uid: `0x${string}`): Promise<bigint>
keyStore.batchTimestamp(uids: Array<`0x${string}`>): Promise<bigint[]>
```

### Common Options

```ts
type EASStoreNetwork =
  | EASNetworkPreset["key"]
  | number
  | EASNetworkPreset
  | {
      chainId: number;
      easContractAddress: `0x${string}`;
      easVersion?: string;
      schemaRegistryAddress?: `0x${string}`;
      graphqlEndpoint?: string;
    };
```

```ts
interface SetOptions {
  recipient?: `0x${string}`;
  contentType?: string;
  expirationTime?: bigint;
  revocable?: boolean;
  extra?: `0x${string}`;
}

interface QueryFilter {
  attester?: `0x${string}`;
  recipient?: `0x${string}`;
  limit?: number;
  includeDeleted?: boolean;
}
```

```ts
interface PrivateSetOptions {
  readers?: Array<PrivateReader | `0x${string}`>;
  inheritReaders?: boolean;
}

interface PrivateGrantOptions {
  reader: PrivateReader | `0x${string}`;
  scope?: "latest-version";
}

interface PrivateRevokeOptions {
  reader: PrivateReader | `0x${string}`;
}

interface PrivateRotateOptions {
  readers: Array<PrivateReader | `0x${string}`>;
}
```

## Exports

Common exports:

- `EASStore`
- `EASKeyStore`
- `MemoryStorage`
- `InlineStorage`
- `inlineStorage`
- `MemoryIndexer`
- `LocalStorageIndexer`
- `EASScanIndexer`
- `canonicalizeJson`
- `STORE_SCHEMA`
- `ZERO_UID`
- `KNOWN_EAS_NETWORKS`
- `getEASNetworkPreset`
- `getEASNetworkPresetByKey`
- `ensureSchema`
- `registerSchema`
- `getRegisteredSchema`
- `schemaExists`
- `EASStoreError`
- `ConfigurationError`
- `VerificationError`

Private-record exports:

- `RecoveryPhraseBackupProvider`
- `MemoryKeyBackupStorage`
- `IndexedDBKeyBackupStorage`
- `recoveryPhraseBackup`
- `WebCryptoPrivateCryptoProvider`
- `MemoryEncryptionKeyRegistry`
- `StoreBackedEncryptionKeyRegistry`
- `computeEncryptionKeyId`
- `computeWrappedKeysHash`
- `PRIVATE_VALUE_CONTENT_TYPE`
- `PRIVATE_KEY_REGISTRY_SCHEMA`
- `PRIVATE_VALUE_SCHEMA`
- `PRIVATE_ACCESS_EVENT_SCHEMA`

## Error Handling

```ts
import {
  ConfigurationError,
  VerificationError
} from "@steerprotocol/eas-store";

try {
  await store.history("profile:alice");
} catch (error) {
  if (error instanceof VerificationError) {
    // Ambiguous history, revoked/expired record, hash mismatch, or failed proof.
  }

  if (error instanceof ConfigurationError) {
    // Missing schema UID, unsupported indexer mode, bad chain config, etc.
  }
}
```

## Security Notes

- Do not store wallet private keys or secrets in EAS Store.
- Onchain records are public.
- Offchain records are only as durable as the storage/indexer you choose.
- Private records encrypt payloads, but metadata such as attester, recipient, schema UID, namespace hash, key hash, and timing can still be visible depending on mode.
- Private revocation is forward-only. Previously authorized readers may already have decrypted older ciphertext.
- Treat GraphQL indexers as discovery layers, not trust anchors.

## Demo App

A browser demo lives in [examples/vite-demo](./examples/vite-demo/README.md). It runs the real SDK with local, onchain, schema setup, inline storage, and private-record flows.

```bash
npm run demo:dev
```

## Scripts

```bash
npm run build
npm run typecheck
npm test
npm run demo:build
npm run demo:e2e
```
