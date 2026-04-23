# @steerprotocol/eas-store

`@steerprotocol/eas-store` is a TypeScript library for an attestation-backed key-value store on top of Ethereum Attestation Service.

It exposes a database-like API, but every write is an EAS attestation and every read is verification-first.

## What ships now

- `EASKeyStore` with `set`, `get`, `delete`, `history`, `verify`, `query`, `timestamp`, and `batchTimestamp`
- Onchain and offchain write paths
- Canonical linked-history resolution using `previousUID`
- Strict verification for onchain and offchain reads
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

## Quick start

### Verified onchain reads with EASScan

```ts
import {
  EASKeyStore,
  EASScanIndexer,
  MemoryStorage,
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
  storage: new MemoryStorage(),
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

### Verified offchain reads with a signature-preserving indexer

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

## Demo App

A browser demo lives in [examples/vite-demo](/Users/derekbarrera/Development/SteerFinance/eas-store/examples/vite-demo/README.md). It runs the real SDK with:

- `mode: "offchain"`
- `MemoryStorage`
- `MemoryIndexer`
- a fresh random signer on each reset

The same demo also includes an onchain path with:

- Base / Base Sepolia EAS contract prefilled from known network presets
- schema publishing through `registerSchema(...)`
- automatic schema UID handoff into the write form

That makes it useful for both browser-level smoke tests and wallet-backed developer demos.
