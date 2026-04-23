# Vite Demo

This app is a local playground for `@steerprotocol/eas-store` and a browser-level smoke surface for the SDK.

## What it exercises

- Real `EASKeyStore.create()` usage
- Real offchain EAS signing
- Onchain Base / Base Sepolia presets with prefilled EAS addresses
- Schema publishing via `registerSchema(...)`
- Canonical `set`, `get`, `delete`, `history`, and `query` flows
- Browser-safe `MemoryStorage` and `MemoryIndexer` adapters

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
