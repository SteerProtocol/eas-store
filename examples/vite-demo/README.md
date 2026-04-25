# Vite Demo

This app is a curated web database-manager demo for `@steerprotocol/eas-store` and a browser-level smoke surface for the SDK.

## What it exercises

- Redis-like `EASStore.local()` and `EASStore.onchain()` usage
- Real offchain EAS signing
- Onchain Base / Base Sepolia presets with prefilled EAS addresses
- Schema publishing via `EASStore.schema.ensureDefault(...)`
- Inline attestation storage for small onchain JSON values
- Private records with IndexedDB recovery backup and inline encrypted values
- Reload/restore/decrypt flow for local private records
- Canonical `set`, `get`, `delete`, `history`, and `query` flows
- Browser-safe local adapters for local/offchain flows

## Commands

```bash
npm run demo:dev
npm run demo:build
npm run demo:typecheck
npm run demo:e2e
```

If Playwright browsers are not installed yet:

```bash
npm run test:e2e:install --workspace eas-store-vite-demo
```
