import type { webcrypto } from "node:crypto";

export type WebCryptoKey = webcrypto.CryptoKey;
export type WebCryptoSubtle = webcrypto.SubtleCrypto;
export type WebCryptoJwk = Record<string, unknown>;
