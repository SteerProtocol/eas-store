import { ConfigurationError, VerificationError } from "../errors";
import { PRIVATE_VALUE_CONTENT_TYPE } from "./types";
import type { Address, StoredRecord } from "../types";
import { StoreBackedEncryptionKeyRegistry } from "./registry";
import {
  computeEncryptionKeyId,
  computeWrappedKeysHash,
  WebCryptoPrivateCryptoProvider
} from "./crypto";
import {
  RecoveryPhraseBackupProvider,
  MemoryKeyBackupStorage
} from "./backup";
import type {
  EncryptedKeyBackup,
  EncryptionIdentity,
  EncryptionKeyRegistry,
  KeyBackupProvider,
  PrivateCryptoProvider,
  PrivateEnvelope,
  PrivateGrantOptions,
  PrivateReader,
  PrivateRevokeOptions,
  PrivateRotateOptions,
  PrivateSetOptions,
  PrivateStoreOptions
} from "./types";

function normalizeAddress(address: string): Address {
  return address.toLowerCase() as Address;
}

export class EASPrivateStore {
  readonly ["private"] = this;

  private readonly crypto: PrivateCryptoProvider;
  private readonly backup: KeyBackupProvider;
  private readonly registry: EncryptionKeyRegistry;
  private identityValue: EncryptionIdentity | null = null;

  private constructor(private readonly options: PrivateStoreOptions) {
    this.crypto = options.crypto ?? new WebCryptoPrivateCryptoProvider();
    this.backup =
      options.backup ??
      new RecoveryPhraseBackupProvider(new MemoryKeyBackupStorage());
    this.registry =
      options.registry ??
      new StoreBackedEncryptionKeyRegistry(
        options.store ??
          (() => {
            throw new ConfigurationError("Private records require a backing EASStore for key registry persistence.");
          })()
      );
  }

  static async create(options: PrivateStoreOptions): Promise<EASPrivateStore> {
    return new EASPrivateStore(options);
  }

  get identity() {
    return {
      create: () => this.createIdentity(),
      createRecoveryPhrase: (words?: 12 | 24) =>
        this.backup.createRecoveryPhrase(words),
      backup: (input: { phrase: string }) => this.backupIdentity(input.phrase),
      restore: (input: { phrase: string; backup?: EncryptedKeyBackup }) =>
        this.restoreIdentity(input),
      publishKey: () => this.publishKey(),
      current: () => this.identityValue
    };
  }

  async set<T>(key: string, value: T, options: PrivateSetOptions = {}): Promise<unknown> {
    const identity = await this.requireIdentity();
    const previous = await this.options.store?.getRecord<PrivateEnvelope>(key);
    const previousEnvelope = previous?.value ?? undefined;
    this.assertOwnerCanModify(previousEnvelope, identity);
    const readers = await this.resolveReadersForSet(key, previousEnvelope, options);
    const recordVersion = (previous?.version ?? 0) + 1;
    const envelope = await this.crypto.encryptValue({
      value,
      key,
      namespace: this.options.namespace,
      dappId: this.dappId(),
      schemaUID: this.options.schemaUID,
      recordVersion,
      writer: identity,
      readers
    });

    return this.options.store?.set(key, envelope, {
      contentType: PRIVATE_VALUE_CONTENT_TYPE
    });
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const record = await this.getRecord<T>(key);
    return record?.value ?? null;
  }

  async getRecord<T = unknown>(key: string): Promise<StoredRecord<T> | null> {
    const identity = await this.requireIdentity();
    const record = await this.options.store?.getRecord<PrivateEnvelope>(key);

    if (!record || !record.value) {
      return null;
    }

    const value = await this.crypto.decryptValue<T>({
      envelope: record.value,
      key,
      namespace: this.options.namespace,
      dappId: this.dappId(),
      schemaUID: this.options.schemaUID,
      identity
    });

    return {
      ...record,
      value
    } as StoredRecord<T>;
  }

  async resolveReader(reader: Address): Promise<PrivateReader> {
    const resolved = await this.registry.resolve(normalizeAddress(reader), this.dappId());

    if (!resolved) {
      throw new ConfigurationError(
        `No registered encryption key exists for reader ${reader}.`
      );
    }
    this.assertReaderDappScope(resolved);

    return resolved;
  }

  async verifyReader(reader: PrivateReader): Promise<boolean> {
    const readerDappId = reader.dappId ?? this.dappId();
    const resolved = await this.registry.resolve(
      normalizeAddress(reader.wallet),
      readerDappId
    );
    const expectedKeyId = computeEncryptionKeyId({
      algorithm: reader.algorithm,
      dappId: readerDappId,
      publicKey: reader.publicKey,
      wallet: normalizeAddress(reader.wallet)
    });

    return Boolean(
      resolved &&
        readerDappId === this.dappId() &&
        resolved.dappId === this.dappId() &&
        expectedKeyId.toLowerCase() === reader.keyId.toLowerCase() &&
        resolved.keyId.toLowerCase() === reader.keyId.toLowerCase() &&
        resolved.algorithm === reader.algorithm &&
        (resolved.expiresAt === undefined ||
          resolved.expiresAt > Math.floor(Date.now() / 1000))
    );
  }

  async grant(key: string, options: PrivateGrantOptions): Promise<void> {
    const reader = await this.resolveReaderInput(options.reader);
    const current = await this.options.store?.getRecord<PrivateEnvelope>(key);

    if (!current?.value) {
      throw new VerificationError(`Cannot grant access for missing private key "${key}".`);
    }

    const identity = await this.requireIdentity();
    this.assertOwnerCanModify(current.value, identity);
    const wrappedKey = current.value.wrappedKeys.find(
      (candidate) => candidate.reader.toLowerCase() === identity.wallet.toLowerCase()
    );

    if (!wrappedKey) {
      throw new VerificationError("Cannot grant access because the caller cannot decrypt the current data key.");
    }

    const dataKey = await this.crypto.unwrapDataKey({
      wrappedKey,
      identity,
      context: this.contextFor(key, current.value)
    });
    const newWrap = await this.crypto.wrapDataKey({
      dataKey,
      reader,
      context: this.contextFor(key, current.value)
    });
    const wrappedKeys = [
      ...current.value.wrappedKeys.filter(
        (candidate) => candidate.reader.toLowerCase() !== reader.wallet.toLowerCase()
      ),
      newWrap
    ];
    const updatedEnvelope: PrivateEnvelope = {
      ...current.value,
      wrappedKeys,
      wrappedKeysHash: computeWrappedKeysHash(wrappedKeys)
    };

    await this.options.store?.set(key, updatedEnvelope, {
      contentType: PRIVATE_VALUE_CONTENT_TYPE
    });
  }

  async revokeFuture(key: string, options: PrivateRevokeOptions): Promise<void> {
    const record = await this.options.store?.getRecord<PrivateEnvelope>(key);

    if (!record?.value) {
      throw new VerificationError(`Cannot revoke access for missing private key "${key}".`);
    }

    const reader = await this.resolveReaderInput(options.reader);
    const value = await this.get(key);
    const remainingReaders = await this.readersFromEnvelope(record.value, {
      exclude: new Set([reader.wallet, record.value.owner])
    });

    await this.set(key, value, {
      readers: remainingReaders
    });
  }

  async rotate<T>(key: string, value: T, options: PrivateRotateOptions): Promise<unknown> {
    return this.set(key, value, {
      readers: options.readers
    });
  }

  private async createIdentity(): Promise<EncryptionIdentity> {
    const wallet = normalizeAddress(await this.options.signer.getAddress());
    const identity = await this.crypto.createIdentity({
      wallet,
      dappId: this.options.dappId ?? this.options.namespace
    });

    this.identityValue = identity;
    return identity;
  }

  private async backupIdentity(phrase: string): Promise<EncryptedKeyBackup> {
    return this.backup.backup(await this.requireIdentity(), phrase);
  }

  private async restoreIdentity(input: {
    phrase: string;
    backup?: EncryptedKeyBackup;
  }): Promise<EncryptionIdentity> {
    const wallet = normalizeAddress(await this.options.signer.getAddress());
    const dappId = this.options.dappId ?? this.options.namespace;
    const backup =
      input.backup ?? (await this.backup.storage?.get(wallet, dappId));

    if (!backup) {
      throw new ConfigurationError("No encrypted key backup is available to restore.");
    }

    const identity = await this.backup.restore({
      backup,
      phrase: input.phrase,
      wallet
    });

    this.identityValue = identity;
    return identity;
  }

  private async publishKey(): Promise<PrivateReader> {
    return this.registry.publish(await this.requireIdentity());
  }

  private async requireIdentity(): Promise<EncryptionIdentity> {
    if (!this.identityValue) {
      throw new ConfigurationError(
        "Private identity is not initialized. Call identity.create() or identity.restore() before using private records."
      );
    }

    return this.identityValue;
  }

  private dappId(): string {
    return this.options.dappId ?? this.options.namespace;
  }

  private async resolveReadersForSet(
    key: string,
    previous: PrivateEnvelope | undefined,
    options: PrivateSetOptions
  ): Promise<PrivateReader[]> {
    if (options.readers) {
      return Promise.all(options.readers.map((reader) => this.resolveReaderInput(reader)));
    }

    if (options.inheritReaders) {
      if (!previous) {
        return [];
      }

      return this.readersFromEnvelope(previous, {
        exclude: new Set([previous.owner])
      });
    }

    return [];
  }

  private async resolveReaderInput(reader: PrivateReader | Address): Promise<PrivateReader> {
    const wallet = typeof reader === "string" ? normalizeAddress(reader) : normalizeAddress(reader.wallet);
    const resolved = await this.resolveReader(wallet);

    if (typeof reader !== "string") {
      const normalized = {
        ...reader,
        wallet
      };

      if (!(await this.verifyReader(normalized))) {
        throw new VerificationError(`Reader ${wallet} is not verified by the encryption key registry.`);
      }
    }

    return resolved;
  }

  private assertReaderDappScope(reader: PrivateReader): void {
    if (reader.dappId !== this.dappId()) {
      throw new VerificationError(
        `Encryption key for ${reader.wallet} is scoped to ${reader.dappId ?? "unknown dapp"}, not ${this.dappId()}.`
      );
    }
  }

  private assertOwnerCanModify(
    envelope: PrivateEnvelope | undefined,
    identity: EncryptionIdentity
  ): void {
    if (!envelope) {
      return;
    }

    if (envelope.owner.toLowerCase() !== identity.wallet.toLowerCase()) {
      throw new VerificationError("Only the private record owner can modify reader access.");
    }
  }

  private contextFor(key: string, envelope: PrivateEnvelope) {
    return {
      namespace: this.options.namespace,
      key,
      dappId: this.dappId(),
      schemaUID: this.options.schemaUID,
      recordVersion: envelope.recordVersion,
      writer: envelope.owner,
      keyId: envelope.keyId
    };
  }

  private async readersFromEnvelope(
    envelope: PrivateEnvelope,
    options: {
      exclude: Set<Address>;
    }
  ): Promise<PrivateReader[]> {
    const wallets = new Set(
      envelope.wrappedKeys
        .map((wrapped) => normalizeAddress(wrapped.reader))
        .filter((wallet) => !options.exclude.has(wallet))
    );
    const readers: PrivateReader[] = [];

    for (const wallet of wallets) {
      readers.push(await this.resolveReader(wallet));
    }

    return readers;
  }
}
