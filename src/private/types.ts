import type { Address, Hex, StoreSigner, StoredRecord } from "../types";
import type { WebCryptoJwk, WebCryptoKey } from "./webcrypto-types";

export const PRIVATE_VALUE_CONTENT_TYPE = "application/vnd.eas-store.private+json";

export type PrivateAlgorithm = "AES-256-GCM";
export type KeyWrapAlgorithm = "ECDH-P256+A256GCM";

export interface EncryptionIdentity {
  wallet: Address;
  dappId: string;
  keyId: Hex;
  algorithm: KeyWrapAlgorithm;
  publicKey: WebCryptoJwk;
  privateKey: WebCryptoKey;
  keyVersion: number;
  createdAt: number;
  expiresAt?: number;
}

export interface PrivateReader {
  wallet: Address;
  keyId: Hex;
  algorithm: KeyWrapAlgorithm;
  publicKey: WebCryptoJwk;
  keyVersion: number;
  dappId?: string;
  createdAt?: number;
  expiresAt?: number;
}

export interface PrivateCryptoContext {
  namespace: string;
  key: string;
  dappId: string;
  schemaUID: Hex;
  recordVersion: number;
  writer: Address;
  keyId: Hex;
}

export interface WrappedDataKey {
  reader: Address;
  readerKeyId: Hex;
  algorithm: KeyWrapAlgorithm;
  iv: string;
  encryptedKey: string;
}

export interface PrivateEnvelope {
  version: 1;
  alg: PrivateAlgorithm;
  keyId: Hex;
  owner: Address;
  dappId: string;
  schemaUID: Hex;
  namespaceHash: Hex;
  keyHash: Hex;
  recordVersion: number;
  iv: string;
  ciphertext: string;
  aadHash: Hex;
  wrappedKeysHash: Hex;
  wrappedKeys: WrappedDataKey[];
}

export interface EncryptedKeyBackup {
  version: 1;
  wallet: Address;
  dappId: string;
  keyId: Hex;
  publicKey: WebCryptoJwk;
  encryptedPrivateKey: string;
  encryption: {
    alg: PrivateAlgorithm;
    kdf: "PBKDF2";
    salt: string;
    iv: string;
    iterations: number;
  };
  createdAt: string;
}

export interface KeyBackupStorage {
  put(backup: EncryptedKeyBackup): Promise<void>;
  get(wallet: Address, dappId: string): Promise<EncryptedKeyBackup | null>;
}

export interface KeyBackupProvider {
  createRecoveryPhrase(words?: 12 | 24): Promise<string>;
  backup(identity: EncryptionIdentity, phrase: string): Promise<EncryptedKeyBackup>;
  restore(input: {
    backup: EncryptedKeyBackup;
    phrase: string;
    wallet: Address;
  }): Promise<EncryptionIdentity>;
  storage?: KeyBackupStorage | undefined;
}

export interface EncryptionKeyRegistry {
  publish(identity: EncryptionIdentity): Promise<PrivateReader>;
  resolve(wallet: Address, dappId?: string): Promise<PrivateReader | null>;
}

export interface PrivateCryptoProvider {
  createIdentity(input: {
    wallet: Address;
    dappId: string;
  }): Promise<EncryptionIdentity>;
  encryptValue(input: {
    value: unknown;
    key: string;
    namespace: string;
    dappId: string;
    schemaUID: Hex;
    recordVersion: number;
    writer: EncryptionIdentity;
    readers: PrivateReader[];
  }): Promise<PrivateEnvelope>;
  decryptValue<T = unknown>(input: {
    envelope: PrivateEnvelope;
    key: string;
    namespace: string;
    dappId: string;
    schemaUID: Hex;
    identity: EncryptionIdentity;
  }): Promise<T>;
  wrapDataKey(input: {
    dataKey: WebCryptoKey;
    reader: PrivateReader;
    context: PrivateCryptoContext;
  }): Promise<WrappedDataKey>;
  unwrapDataKey(input: {
    wrappedKey: WrappedDataKey;
    identity: EncryptionIdentity;
    context: PrivateCryptoContext;
  }): Promise<WebCryptoKey>;
}

export interface PrivateSetOptions {
  readers?: Array<PrivateReader | Address>;
  inheritReaders?: boolean;
}

export interface PrivateGrantOptions {
  reader: PrivateReader | Address;
  scope?: "latest-version";
}

export interface PrivateRevokeOptions {
  reader: PrivateReader | Address;
}

export interface PrivateRotateOptions {
  readers: Array<PrivateReader | Address>;
}

export interface PrivateStoreOptions {
  signer: StoreSigner;
  namespace: string;
  schemaUID: Hex;
  dappId?: string;
  crypto?: PrivateCryptoProvider;
  backup?: KeyBackupProvider;
  registry?: EncryptionKeyRegistry;
  store?: {
    set<T>(key: string, value: T, options?: unknown): Promise<unknown>;
    getRecord<T = unknown>(key: string): Promise<StoredRecord<T> | null>;
    get<T = unknown>(key: string): Promise<T | null>;
  };
}
