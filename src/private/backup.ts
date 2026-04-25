import { generateMnemonic, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

import { ConfigurationError, VerificationError } from "../errors";
import type { Address } from "../types";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  canonicalBytes,
  randomBytes
} from "./encoding";
import {
  computeEncryptionKeyId,
  publicKeyFromPrivateJwk
} from "./crypto";
import type {
  EncryptedKeyBackup,
  EncryptionIdentity,
  KeyBackupProvider,
  KeyBackupStorage
} from "./types";
import type { WebCryptoJwk, WebCryptoKey, WebCryptoSubtle } from "./webcrypto-types";

function subtle(): WebCryptoSubtle {
  if (!globalThis.crypto?.subtle) {
    throw new ConfigurationError("Recovery phrase backups require WebCrypto crypto.subtle.");
  }

  return globalThis.crypto.subtle;
}

function normalizeAddress(address: string): Address {
  return address.toLowerCase() as Address;
}

function backupAad(backup: Omit<EncryptedKeyBackup, "encryptedPrivateKey">): Uint8Array {
  return canonicalBytes({
    createdAt: backup.createdAt,
    dappId: backup.dappId,
    encryption: backup.encryption,
    keyId: backup.keyId.toLowerCase(),
    publicKey: backup.publicKey,
    version: backup.version,
    wallet: backup.wallet.toLowerCase()
  });
}

async function derivePhraseKey(input: {
  phrase: string;
  salt: Uint8Array;
  iterations: number;
}): Promise<WebCryptoKey> {
  const phraseKey = await subtle().importKey(
    "raw",
    new TextEncoder().encode(input.phrase.normalize("NFKD")),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return subtle().deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: input.salt,
      iterations: input.iterations
    },
    phraseKey,
    {
      name: "AES-GCM",
      length: 256
    },
    false,
    ["encrypt", "decrypt"]
  );
}

export class MemoryKeyBackupStorage implements KeyBackupStorage {
  private readonly backups = new Map<string, EncryptedKeyBackup>();

  async put(backup: EncryptedKeyBackup): Promise<void> {
    this.backups.set(`${backup.wallet.toLowerCase()}:${backup.dappId}`, backup);
  }

  async get(wallet: Address, dappId: string): Promise<EncryptedKeyBackup | null> {
    return this.backups.get(`${wallet.toLowerCase()}:${dappId}`) ?? null;
  }
}

export class RecoveryPhraseBackupProvider implements KeyBackupProvider {
  constructor(readonly storage?: KeyBackupStorage | undefined) {}

  async createRecoveryPhrase(words: 12 | 24 = 12): Promise<string> {
    return generateMnemonic(wordlist, words === 24 ? 256 : 128);
  }

  async backup(identity: EncryptionIdentity, phrase: string): Promise<EncryptedKeyBackup> {
    if (!validateMnemonic(phrase, wordlist)) {
      throw new ConfigurationError("Recovery phrase must be a valid 12 or 24 word BIP-39 phrase.");
    }

    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const iterations = 250_000;
    const createdAt = new Date().toISOString();
    const phraseKey = await derivePhraseKey({
      phrase,
      salt,
      iterations
    });
    const privateKey = await subtle().exportKey("jwk", identity.privateKey);
    const backupMetadata: Omit<EncryptedKeyBackup, "encryptedPrivateKey"> = {
      version: 1,
      wallet: normalizeAddress(identity.wallet),
      dappId: identity.dappId,
      keyId: identity.keyId,
      publicKey: identity.publicKey,
      encryption: {
        alg: "AES-256-GCM",
        kdf: "PBKDF2",
        salt: bytesToBase64Url(salt),
        iv: bytesToBase64Url(iv),
        iterations
      },
      createdAt
    };
    const encryptedPrivateKey = await subtle().encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: backupAad(backupMetadata)
      },
      phraseKey,
      new TextEncoder().encode(JSON.stringify(privateKey))
    );
    const backup: EncryptedKeyBackup = {
      ...backupMetadata,
      encryptedPrivateKey: bytesToBase64Url(new Uint8Array(encryptedPrivateKey)),
    };

    await this.storage?.put(backup);
    return backup;
  }

  async restore(input: {
    backup: EncryptedKeyBackup;
    phrase: string;
    wallet: Address;
  }): Promise<EncryptionIdentity> {
    if (normalizeAddress(input.backup.wallet) !== normalizeAddress(input.wallet)) {
      throw new VerificationError("Encrypted key backup does not belong to the connected wallet.");
    }
    if (input.backup.version !== 1 || input.backup.encryption.alg !== "AES-256-GCM") {
      throw new VerificationError("Unsupported encrypted key backup format.");
    }
    if (input.backup.encryption.kdf !== "PBKDF2") {
      throw new VerificationError(`Unsupported key backup KDF: ${input.backup.encryption.kdf}`);
    }
    if (
      !Number.isSafeInteger(input.backup.encryption.iterations) ||
      input.backup.encryption.iterations < 250_000 ||
      input.backup.encryption.iterations > 2_000_000
    ) {
      throw new VerificationError("Encrypted key backup KDF iterations are outside the supported range.");
    }
    if (!validateMnemonic(input.phrase, wordlist)) {
      throw new VerificationError("Recovery phrase is not a valid BIP-39 phrase.");
    }

    const phraseKey = await derivePhraseKey({
      phrase: input.phrase,
      salt: base64UrlToBytes(input.backup.encryption.salt),
      iterations: input.backup.encryption.iterations
    });

    let privateKeyJwk: WebCryptoJwk;

    try {
      const decrypted = await subtle().decrypt(
        {
          name: "AES-GCM",
          iv: base64UrlToBytes(input.backup.encryption.iv),
          additionalData: backupAad({
            version: input.backup.version,
            wallet: normalizeAddress(input.backup.wallet),
            dappId: input.backup.dappId,
            keyId: input.backup.keyId,
            publicKey: input.backup.publicKey,
            encryption: input.backup.encryption,
            createdAt: input.backup.createdAt
          })
        },
        phraseKey,
        base64UrlToBytes(input.backup.encryptedPrivateKey)
      );
      privateKeyJwk = JSON.parse(new TextDecoder().decode(decrypted)) as WebCryptoJwk;
    } catch (cause) {
      throw new VerificationError("Recovery phrase could not decrypt this key backup.", {
        cause
      });
    }

    const privateKey = await subtle().importKey(
      "jwk",
      privateKeyJwk,
      {
        name: "ECDH",
        namedCurve: "P-256"
      },
      true,
      ["deriveKey", "deriveBits"]
    );
    const publicKey = publicKeyFromPrivateJwk(privateKeyJwk);
    const keyId = computeEncryptionKeyId({
      algorithm: "ECDH-P256+A256GCM",
      dappId: input.backup.dappId,
      publicKey,
      wallet: normalizeAddress(input.backup.wallet)
    });

    if (keyId.toLowerCase() !== input.backup.keyId.toLowerCase()) {
      throw new VerificationError("Encrypted key backup key ID does not match the restored private key.");
    }

    return {
      wallet: normalizeAddress(input.backup.wallet),
      dappId: input.backup.dappId,
      keyId,
      algorithm: "ECDH-P256+A256GCM",
      publicKey,
      privateKey,
      keyVersion: 1,
      createdAt: Math.floor(new Date(input.backup.createdAt).getTime() / 1000)
    };
  }
}

export function recoveryPhraseBackup(options: {
  storage?: KeyBackupStorage | undefined;
} = {}): RecoveryPhraseBackupProvider {
  return new RecoveryPhraseBackupProvider(options.storage);
}
