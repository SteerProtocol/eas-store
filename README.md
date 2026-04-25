# @steerprotocol/eas-store

`@steerprotocol/eas-store` is a TypeScript library for an attestation-backed key-value store on top of Ethereum Attestation Service.

It exposes a database-like API, but every write is an EAS attestation and every read is verification-first.

## What ships now

- `EASStore` with Redis-like `set`, `get`, `del`, `getRecord`, `history`, and `scan`
- `EASKeyStore` with `set`, `get`, `delete`, `history`, `verify`, `query`, `timestamp`, and `batchTimestamp`
- `EASStore.schema.ensureDefault(...)` for idempotent default schema setup
- Onchain and offchain write paths
- Canonical linked-history resolution using `previousUID`
- Strict verification for onchain and offchain reads
- `InlineStorage` for small zero-infrastructure JSON values
- `MemoryStorage` and `MemoryIndexer` for local dev and tests
- `EASScanIndexer` for verified onchain discovery via EASScan GraphQL

## Supported read matrix

| Mode | Indexer | Verified remote reads | Notes |
| --- | --- | --- | --- |
| `onchain` | `MemoryIndexer` | Yes | Useful for tests/local flows |
| `onchain` | `EASScanIndexer` | Yes | EASScan is discovery only; final revocation/expiry truth comes from chain |
| `offchain` | `MemoryIndexer` | Yes | Works because the signed offchain package is preserved |
| `offchain` | `EASScanIndexer` | No | Rejected at creation time |

`EASScanIndexer` is intentionally onchain-only for verified reads. Offchain attestations require the original signed EIP-712 package, and EASScan GraphQL does not return that package.

## Verification model

- Onchain reads:
  - use the indexer to discover candidate attestations
  - fetch the attestation from chain
  - derive revocation and expiry status from chain data
  - verify schema, namespace, trusted attester policy, recipient policy, payload integrity, and value hash
- Offchain reads:
  - require the original signed offchain package
  - verify the EIP-712 signature
  - optionally require an onchain timestamp
  - verify payload integrity and value hash

## Canonical history rules

- Records are append-only.
- A key is readable only when its verified records form one unambiguous linked chain.
- If multiple verified heads exist, `get()` returns `null`, `query()` excludes the key, and `history()` / future writes fail with `VerificationError`.
- `query({ limit })` applies the limit after deduplicating to one canonical head per key.

## Current constraints

- Offchain writes require either:
  - `easVersion` in config, or
  - a signer/provider connected to the target EAS contract so the SDK can discover the contract version
- Durable verified offchain remote reads require a custom indexer that preserves `signedOffchainAttestation`
- `EASScanIndexer` paginates schema results and post-filters them by namespace/key; it is a discovery adapter, not the trust anchor

## Quick Start

### Local dev

```ts
import { EASStore } from "@steerprotocol/eas-store";

const store = await EASStore.local({
  namespace: "my-dapp.profile"
});

await store.set("profile:alice", {
  name: "Alice"
});

const profile = await store.get<{ name: string }>("profile:alice");
```

`get()` returns the stored value. Use `getRecord()` when you need attestation metadata:

```ts
const record = await store.getRecord("profile:alice");
console.log(record?.uid);
```

### Default schema setup

Run this once per chain/environment and persist the UID:

```ts
import { EASStore } from "@steerprotocol/eas-store";

const schema = await EASStore.schema.ensureDefault({
  network: "base-sepolia",
  signer
});

console.log(schema.uid);
```

`ensureDefault()` is idempotent. It computes the default schema UID, checks the registry, and only sends a registration transaction if the schema is missing.

### Onchain store

```ts
import { EASStore } from "@steerprotocol/eas-store";

const store = await EASStore.onchain({
  network: "base-sepolia",
  namespace: "my-dapp.profile",
  signer,
  schemaUID: process.env.EAS_STORE_SCHEMA_UID as `0x${string}`
});

await store.set("profile:0xabc", {
  name: "Alice",
  avatar: "ipfs://..."
});

const profile = await store.get<{ name: string; avatar: string }>("profile:0xabc");
```

The onchain preset fills in chain config, EAS contract address, EAS version, inline storage for small values, and EASScan verified reads.

Built-in network presets cover the EASScan-indexed EAS deployments for
Ethereum, Sepolia, Arbitrum, Arbitrum Nova, Base, Base Sepolia, Optimism,
Optimism Sepolia, Scroll, Polygon, Linea, and Celo. For any other EAS
deployment, pass a custom `network` object with `chainId`, `easContractAddress`,
`schemaRegistryAddress`, and optionally `graphqlEndpoint`. Without a GraphQL
endpoint, onchain writes still work, but remote cross-session reads require a
custom durable indexer.

### Private records

Private records encrypt values before they are attested. The wallet signs EAS
records, while a dedicated dapp encryption key decrypts private values.

```ts
import {
  EASStore,
  IndexedDBKeyBackupStorage,
  recoveryPhraseBackup
} from "@steerprotocol/eas-store";

const store = await EASStore.private({
  signer,
  namespace: "my-dapp.profile",
  schemaUID: process.env.EAS_STORE_SCHEMA_UID as `0x${string}`,
  backup: recoveryPhraseBackup({
    storage: new IndexedDBKeyBackupStorage({
      dbName: "my-dapp-eas-store"
    })
  })
});

// EASStore.private() defaults to onchain mode. Use mode: "local" or
// mode: "offchain" only when you explicitly want non-onchain records.
const phrase = await store.private.identity.createRecoveryPhrase();
await store.private.identity.create();
await store.private.identity.backup({ phrase });
await store.private.identity.publishKey(); // explicit attestation/transaction

await store.private.set("profile.email", "alice@example.com");
const email = await store.private.get<string>("profile.email");
```

The recovery phrase restores only this dapp encryption identity. It is not a
wallet seed phrase, and it is never sent to the backup storage adapter.
Recovery phrases are BIP-39 mnemonics generated from at least 128 bits of
entropy. Key backups authenticate their metadata, and restore requires the
connected wallet to match the backup wallet.

`identity.create()` and `identity.restore()` are local-only. They do not publish
the public encryption key. `identity.publishKey()` is the explicit operation
that writes the public key claim so other wallets can encrypt shared records to
this reader.

Reader keys are resolved through the configured encryption key registry before
encryption. By default, the private store uses the backing `EASStore` as a
verified key registry so reader public keys are bound to the wallet that
attested them and to the current dapp ID. `grant()`, `revokeFuture()`, and `rotate()` are owner-only; a
reader who can decrypt cannot delegate access. Revocation is forward-only:
`revokeFuture()` writes a new latest encrypted version without that reader, but
cannot claw back ciphertext they already decrypted.

Private value encryption uses AES-256-GCM. Per-reader data-key wrapping uses
ephemeral ECDH, HKDF-SHA-256, and AES-GCM with dapp/schema/key/reader context
bound into derivation and authenticated data.

### Advanced construction

Use `EASKeyStore.create(...)` or `EASStore.createAdvanced(...)` when you need direct adapter control.

#### Verified onchain reads with EASScan

```ts
import {
  EASKeyStore,
  EASScanIndexer,
  InlineStorage,
  getEASNetworkPreset
} from "@steerprotocol/eas-store";

const base = getEASNetworkPreset(8453);

const store = await EASKeyStore.create({
  chainId: base!.chainId,
  easContractAddress: base!.easContractAddress,
  easVersion: base!.easVersion,
  schemaUID: "0x..." as const,
  namespace: "my-dapp.profile",
  signer,
  mode: "onchain",
  storage: new InlineStorage(),
  indexer: new EASScanIndexer({
    endpoint: base!.graphqlEndpoint
  })
});

await store.set("profile:0xabc", {
  name: "Alice",
  avatar: "ipfs://..."
});

const profile = await store.get("profile:0xabc");
```

Use `InlineStorage` for small values when reads are discovered through EASScan. It embeds the value bytes in the attestation payload as a `data:` URI, so another browser can verify the value hash later. Local-only adapters such as `MemoryStorage` are rejected with remote onchain indexers because they cannot be verified across sessions.

#### Verified offchain reads with a signature-preserving indexer

```ts
import {
  EASKeyStore,
  MemoryIndexer,
  MemoryStorage,
  getEASNetworkPreset,
  registerSchema
} from "@steerprotocol/eas-store";

const baseSepolia = getEASNetworkPreset(84532);

const registeredSchema = await registerSchema(
  {
    chainId: baseSepolia!.chainId,
    easContractAddress: baseSepolia!.easContractAddress,
    signer
  },
  {
    schema:
      "bytes32 namespace,bytes32 key,bytes32 valueHash,string valueURI,string contentType,uint64 version,uint8 operation,bytes32 previousUID,bytes extra",
    revocable: true
  }
);

const store = await EASKeyStore.create({
  chainId: baseSepolia!.chainId,
  easContractAddress: baseSepolia!.easContractAddress,
  easVersion: baseSepolia!.easVersion,
  schemaUID: registeredSchema.uid,
  namespace: "my-dapp.profile",
  signer,
  mode: "offchain",
  storage: new MemoryStorage(),
  indexer: new MemoryIndexer()
});
```

## Scripts

```bash
npm run build
npm run demo:dev
npm run demo:build
npm run demo:e2e
npm run typecheck
npm test
```

## Release

The package is published as `@steerprotocol/eas-store`.

Releases are intended to run through GitHub Actions and npm trusted publishing:

- GitHub workflow: `.github/workflows/npm-publish.yml`
- npm package: `@steerprotocol/eas-store`
- npm trusted publisher provider: GitHub Actions
- npm trusted publisher owner/repo: `SteerProtocol/eas-store`
- npm trusted publisher workflow: `npm-publish.yml`

The publish workflow uses OIDC (`id-token: write`) and does not require an
`NPM_TOKEN` secret. Before the first release, configure the trusted publisher in
npm package settings, then publish a GitHub release or run the workflow
manually. The workflow runs typecheck, coverage, build, and `npm publish
--access public`.

## Demo App

A browser demo lives in [examples/vite-demo](/Users/derekbarrera/Development/SteerFinance/eas-store/examples/vite-demo/README.md). It runs the real SDK with:

- `mode: "offchain"`
- `MemoryStorage`
- `MemoryIndexer`
- a fresh random signer on each reset

The same demo also includes an onchain path with:

- Base / Base Sepolia EAS contract prefilled from known network presets
- all EASScan-indexed EAS chains available in the onchain network selector
- custom EAS chain inputs for newer or private deployments
- inline attestation storage for small JSON values
- schema publishing through `EASStore.schema.ensureDefault(...)`
- automatic schema UID handoff into the write form

That makes it useful for both browser-level smoke tests and wallet-backed developer demos.

The demo deploys to GitHub Pages from `.github/workflows/pages.yml`. The Vite
build switches to `base: "/eas-store/"` only when `GITHUB_PAGES=true`, so local
dev and preview keep serving from `/`.
