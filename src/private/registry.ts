import { VerificationError } from "../errors";
import type { Address } from "../types";
import { computeEncryptionKeyId } from "./crypto";
import type {
  EncryptionIdentity,
  EncryptionKeyRegistry,
  PrivateReader
} from "./types";

function normalizeAddress(address: string): Address {
  return address.toLowerCase() as Address;
}

export class MemoryEncryptionKeyRegistry implements EncryptionKeyRegistry {
  private readonly readers = new Map<string, PrivateReader>();

  async publish(identity: EncryptionIdentity): Promise<PrivateReader> {
    const wallet = normalizeAddress(identity.wallet);
    const keyId = computeEncryptionKeyId({
      algorithm: identity.algorithm,
      dappId: identity.dappId,
      publicKey: identity.publicKey,
      wallet
    });

    const reader: PrivateReader = {
      wallet,
      keyId,
      algorithm: identity.algorithm,
      publicKey: identity.publicKey,
      keyVersion: identity.keyVersion,
      dappId: identity.dappId,
      createdAt: identity.createdAt,
      ...(identity.expiresAt ? { expiresAt: identity.expiresAt } : {})
    };

    if (keyId.toLowerCase() !== identity.keyId.toLowerCase()) {
      throw new Error("Encryption identity key ID does not match its public key.");
    }

    this.readers.set(this.keyFor(reader.wallet, reader.dappId), reader);
    return reader;
  }

  async resolve(wallet: Address, dappId?: string): Promise<PrivateReader | null> {
    return this.readers.get(this.keyFor(wallet, dappId)) ?? null;
  }

  private keyFor(wallet: Address, dappId?: string): string {
    return `${dappId ?? ""}:${normalizeAddress(wallet)}`;
  }
}

type RegistryStore = {
  set<T>(key: string, value: T, options?: unknown): Promise<unknown>;
  getRecord<T = unknown>(key: string): Promise<{
    value: T | null;
    attester: Address;
    verified: boolean;
  } | null>;
};

type KeyRegistryClaim = PrivateReader & {
  version: 1;
};

export class StoreBackedEncryptionKeyRegistry implements EncryptionKeyRegistry {
  constructor(private readonly store: RegistryStore) {}

  async publish(identity: EncryptionIdentity): Promise<PrivateReader> {
    const wallet = normalizeAddress(identity.wallet);
    const keyId = computeEncryptionKeyId({
      algorithm: identity.algorithm,
      dappId: identity.dappId,
      publicKey: identity.publicKey,
      wallet
    });

    if (keyId.toLowerCase() !== identity.keyId.toLowerCase()) {
      throw new VerificationError("Encryption identity key ID does not match its public key.");
    }

    const reader: KeyRegistryClaim = {
      version: 1,
      wallet,
      keyId,
      algorithm: identity.algorithm,
      publicKey: identity.publicKey,
      keyVersion: identity.keyVersion,
      dappId: identity.dappId,
      createdAt: identity.createdAt,
      ...(identity.expiresAt ? { expiresAt: identity.expiresAt } : {})
    };

    await this.store.set(this.keyFor(wallet, identity.dappId), reader);
    return reader;
  }

  async resolve(wallet: Address, dappId?: string): Promise<PrivateReader | null> {
    const normalizedWallet = normalizeAddress(wallet);
    const record = await this.store.getRecord<KeyRegistryClaim>(
      this.keyFor(normalizedWallet, dappId)
    );

    if (!record?.value) {
      return null;
    }
    if (!record.verified) {
      throw new VerificationError(`Encryption key registry record for ${wallet} is not verified.`);
    }
    if (normalizeAddress(record.attester) !== normalizedWallet) {
      throw new VerificationError(`Encryption key registry record for ${wallet} was not attested by that wallet.`);
    }

    const claim = {
      ...record.value,
      wallet: normalizeAddress(record.value.wallet)
    };

    if (claim.wallet !== normalizedWallet) {
      throw new VerificationError(`Encryption key registry wallet mismatch for ${wallet}.`);
    }
    if (claim.algorithm !== "ECDH-P256+A256GCM") {
      throw new VerificationError(`Unsupported encryption key algorithm: ${claim.algorithm}`);
    }
    if (claim.expiresAt !== undefined && claim.expiresAt <= Math.floor(Date.now() / 1000)) {
      throw new VerificationError(`Encryption key for ${wallet} is expired.`);
    }

    const keyId = computeEncryptionKeyId({
      algorithm: claim.algorithm,
      dappId: claim.dappId ?? "",
      publicKey: claim.publicKey,
      wallet: normalizedWallet
    });

    if (keyId.toLowerCase() !== claim.keyId.toLowerCase()) {
      throw new VerificationError(`Encryption key ID mismatch for ${wallet}.`);
    }

    return claim;
  }

  private keyFor(wallet: Address, dappId?: string): string {
    return `__eas_store_private_key_registry:${dappId ?? ""}:${normalizeAddress(wallet)}`;
  }
}
