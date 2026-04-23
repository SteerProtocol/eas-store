import { EAS, NO_EXPIRATION } from "@ethereum-attestation-service/eas-sdk";

import { encodeStoredValue } from "./codecs/json";
import { hashBytes, hashText } from "./crypto/hash";
import { ConfigurationError, VerificationError } from "./errors";
import { OffchainWriter } from "./eas/offchain-writer";
import { OnchainWriter } from "./eas/onchain-writer";
import { encodeRecordExtra, ZERO_UID } from "./eas/schema";
import { EASRecordVerifier } from "./eas/verifier";
import { MemoryIndexer } from "./indexers/memory";
import { MemoryStorage } from "./storage/memory";
import {
  StoreOperation,
  type EASKeyStoreConfig,
  type IndexQuery,
  type IndexedStoreRecord,
  type IndexerAdapter,
  type PreparedWrite,
  type QueryFilter,
  type SetOptions,
  type StorageAdapter,
  type StoredRecord
} from "./types";

function dedupeRecords(records: IndexedStoreRecord[]): IndexedStoreRecord[] {
  const map = new Map<string, IndexedStoreRecord>();

  for (const record of records) {
    map.set(record.attestation.uid.toLowerCase(), record);
  }

  return Array.from(map.values());
}

function sortRecords(records: IndexedStoreRecord[]): IndexedStoreRecord[] {
  return [...records].sort((left, right) => {
    if (left.record.version === right.record.version) {
      return Number(right.attestation.time - left.attestation.time);
    }

    return Number(right.record.version - left.record.version);
  });
}

interface CanonicalResolution<T> {
  status: "empty" | "canonical" | "ambiguous";
  chain: Array<StoredRecord<T>>;
  head: StoredRecord<T> | null;
}

interface KeyResolution<T> extends CanonicalResolution<T> {
  rawRecords: IndexedStoreRecord[];
  verifiedRecords: Array<StoredRecord<T>>;
}

function resolveCanonicalChain<T>(
  records: Array<StoredRecord<T>>
): CanonicalResolution<T> {
  if (records.length === 0) {
    return {
      status: "empty",
      chain: [],
      head: null
    };
  }

  const byUid = new Map(records.map((record) => [record.uid.toLowerCase(), record]));
  const childrenByParent = new Map<string, Array<StoredRecord<T>>>();

  for (const record of records) {
    if (!record.previousUID) {
      continue;
    }

    const previousUID = record.previousUID.toLowerCase();

    if (!byUid.has(previousUID)) {
      return {
        status: "ambiguous",
        chain: [],
        head: null
      };
    }

    const siblings = childrenByParent.get(previousUID) ?? [];
    siblings.push(record);
    childrenByParent.set(previousUID, siblings);
  }

  const roots = records.filter((record) => !record.previousUID);

  if (roots.length !== 1) {
    return {
      status: "ambiguous",
      chain: [],
      head: null
    };
  }

  const chain: Array<StoredRecord<T>> = [];
  const visited = new Set<string>();
  let current = roots[0] ?? null;

  while (current) {
    const currentUID = current.uid.toLowerCase();

    if (visited.has(currentUID)) {
      return {
        status: "ambiguous",
        chain: [],
        head: null
      };
    }

    visited.add(currentUID);
    chain.push(current);

    const children = childrenByParent.get(currentUID) ?? [];

    if (children.length > 1) {
      return {
        status: "ambiguous",
        chain: [],
        head: null
      };
    }

    current = children[0] ?? null;
  }

  if (visited.size !== records.length) {
    return {
      status: "ambiguous",
      chain: [],
      head: null
    };
  }

  return {
    status: "canonical",
    chain,
    head: chain[chain.length - 1] ?? null
  };
}

export class EASKeyStore {
  private readonly namespaceHash: `0x${string}`;
  private readonly storage: StorageAdapter;
  private readonly indexer: IndexerAdapter;
  private readonly verifier: EASRecordVerifier;
  private readonly writeThroughCache = new Map<string, IndexedStoreRecord>();

  private constructor(private readonly config: EASKeyStoreConfig) {
    this.namespaceHash = hashText(config.namespace);
    this.storage = config.storage ?? new MemoryStorage();
    this.indexer = config.indexer ?? new MemoryIndexer();
    this.assertVerifiedReadSupport(config.mode ?? "offchain");

    const policy = {
      schemaUID: config.schemaUID,
      namespaceHash: this.namespaceHash,
      allowExpired: config.verification?.allowExpired ?? false,
      allowRevoked: config.verification?.allowRevoked ?? false,
      requireTimestamp: config.verification?.requireTimestamp ?? false,
      requireChainValidationOnchain:
        config.verification?.requireChainValidationOnchain ?? true,
      ...(config.trustedAttesters
        ? { trustedAttesters: config.trustedAttesters }
        : {}),
      ...(config.verification?.requireRecipient
        ? { requireRecipient: config.verification.requireRecipient }
        : {})
    };

    this.verifier = new EASRecordVerifier(
      config,
      config.namespace,
      this.storage,
      policy
    );
  }

  private assertVerifiedReadSupport(mode: "onchain" | "offchain"): void {
    if (this.indexer.supportsVerifiedReads?.(mode)) {
      return;
    }

    if (mode === "offchain") {
      throw new ConfigurationError(
        "Offchain mode requires an indexer that preserves signed offchain packages for verified reads. EASScanIndexer does not support durable verified offchain reads."
      );
    }

    throw new ConfigurationError(
      `The configured indexer does not support verified ${mode} reads.`
    );
  }

  static async create(config: EASKeyStoreConfig): Promise<EASKeyStore> {
    return new EASKeyStore({
      ...config,
      mode: config.mode ?? "offchain"
    });
  }

  private makeQuery(key?: string, filter?: QueryFilter): IndexQuery {
    return {
      schemaUID: this.config.schemaUID,
      namespaceHash: this.namespaceHash,
      ...(key ? { keyHash: hashText(key) } : {}),
      ...(filter?.attester ? { attester: filter.attester } : {}),
      ...(filter?.recipient ? { recipient: filter.recipient } : {}),
      ...(this.config.mode ? { mode: this.config.mode } : {})
    };
  }

  private getCachedRecords(filter: IndexQuery): IndexedStoreRecord[] {
    return Array.from(this.writeThroughCache.values()).filter((record) => {
      if (record.attestation.schema.toLowerCase() !== filter.schemaUID.toLowerCase()) {
        return false;
      }

      if (
        filter.namespaceHash &&
        record.record.namespaceHash.toLowerCase() !== filter.namespaceHash.toLowerCase()
      ) {
        return false;
      }

      if (filter.keyHash && record.record.keyHash.toLowerCase() !== filter.keyHash.toLowerCase()) {
        return false;
      }

      if (
        filter.attester &&
        record.attestation.attester.toLowerCase() !== filter.attester.toLowerCase()
      ) {
        return false;
      }

      if (
        filter.recipient &&
        record.attestation.recipient.toLowerCase() !== filter.recipient.toLowerCase()
      ) {
        return false;
      }

      if (filter.mode && record.attestation.mode !== filter.mode) {
        return false;
      }

      return true;
    });
  }

  private async loadRecords(key?: string, filter?: QueryFilter): Promise<IndexedStoreRecord[]> {
    const query = this.makeQuery(key, filter);
    const [indexed, cached] = await Promise.all([
      this.indexer.query(query),
      Promise.resolve(this.getCachedRecords(query))
    ]);

    return sortRecords(dedupeRecords([...cached, ...indexed]));
  }

  private async verifyRecords<T = unknown>(
    key: string | undefined,
    records: IndexedStoreRecord[]
  ): Promise<Array<StoredRecord<T>>> {
    const verified: Array<StoredRecord<T>> = [];

    for (const record of records) {
      const result = await this.verifier.verifyRecord<T>(record);

      if (!result.verified) {
        continue;
      }

      const effectiveRecord = result.record ?? record;
      verified.push(
        this.verifier.materializeStoredRecord<T>(
          effectiveRecord,
          result.value,
          true,
          key ?? effectiveRecord.lookupKey ?? effectiveRecord.record.keyHash
        )
      );
    }

    return verified;
  }

  private async loadKeyResolution<T = unknown>(key: string): Promise<KeyResolution<T>> {
    const rawRecords = await this.loadRecords(key);
    const verifiedRecords = await this.verifyRecords<T>(key, rawRecords);
    const resolution = resolveCanonicalChain(verifiedRecords);

    return {
      rawRecords,
      verifiedRecords,
      ...resolution
    };
  }

  private async prepareWrite(
    key: string,
    operation: StoreOperation,
    value: unknown,
    options?: SetOptions
  ): Promise<PreparedWrite> {
    const state = await this.loadKeyResolution(key);

    if (state.status === "ambiguous") {
      throw new VerificationError(
        `Cannot continue history for key "${key}" because multiple verified heads exist.`
      );
    }

    if (state.status === "empty" && state.rawRecords.length > 0) {
      throw new VerificationError(
        `Cannot continue history for key "${key}" because existing records could not be verified.`
      );
    }

    const latest = state.head;
    const signerAddress = this.config.signer
      ? ((await this.config.signer.getAddress()) as `0x${string}`)
      : undefined;
    const recipient = options?.recipient ?? this.config.defaultRecipient ?? signerAddress;

    if (!recipient) {
      throw new ConfigurationError(
        "A recipient is required. Provide one in options.recipient or config.defaultRecipient."
      );
    }

    const contentType =
      operation === StoreOperation.Delete
        ? "application/x-tombstone"
        : options?.contentType ?? "application/json";
    const bytes =
      operation === StoreOperation.Delete
        ? new Uint8Array()
        : encodeStoredValue(value, contentType);
    const valueURI =
      operation === StoreOperation.Delete ? "" : await this.storage.put(bytes, contentType);

    return {
      key,
      recipient,
      expirationTime: options?.expirationTime ?? NO_EXPIRATION,
      revocable: options?.revocable ?? true,
      record: {
        namespaceHash: this.namespaceHash,
        keyHash: hashText(key),
        valueHash: hashBytes(bytes),
        valueURI,
        contentType,
        version: BigInt((latest?.version ?? 0) + 1),
        operation,
        previousUID: latest?.uid ?? ZERO_UID,
        extra: encodeRecordExtra({
          key,
          ...(options?.extra ? { metadata: options.extra } : {})
        })
      }
    };
  }

  private async write<T = unknown>(
    key: string,
    operation: StoreOperation,
    value: unknown,
    options?: SetOptions
  ): Promise<StoredRecord<T>> {
    const prepared = await this.prepareWrite(key, operation, value, options);
    const writer =
      this.config.mode === "onchain"
        ? new OnchainWriter({
            chainId: this.config.chainId,
            easContractAddress: this.config.easContractAddress,
            schemaUID: this.config.schemaUID,
            ...(this.config.easVersion ? { easVersion: this.config.easVersion } : {}),
            ...(this.config.signer ? { signer: this.config.signer } : {}),
            ...(this.config.provider ? { provider: this.config.provider } : {})
          })
        : new OffchainWriter({
            chainId: this.config.chainId,
            easContractAddress: this.config.easContractAddress,
            schemaUID: this.config.schemaUID,
            ...(this.config.easVersion ? { easVersion: this.config.easVersion } : {}),
            ...(this.config.signer ? { signer: this.config.signer } : {}),
            ...(this.config.provider ? { provider: this.config.provider } : {})
          });
    const attestation = await writer.attest(prepared);
    const indexedRecord: IndexedStoreRecord = {
      attestation,
      record: prepared.record,
      lookupKey: key
    };

    this.writeThroughCache.set(attestation.uid, indexedRecord);

    if (this.indexer.index) {
      await this.indexer.index(indexedRecord);
    }

    const result = await this.verifier.verifyRecord<T>(indexedRecord);

    if (!result.verified) {
      throw new ConfigurationError(
        "The record was written but failed local verification. Check easVersion/provider and storage settings."
      );
    }

    return this.verifier.materializeStoredRecord(
      indexedRecord,
      result.value,
      true,
      key
    );
  }

  async set<T>(key: string, value: T, options?: SetOptions): Promise<StoredRecord<T>> {
    return this.write<T>(key, StoreOperation.Set, value, options);
  }

  async get<T>(key: string): Promise<StoredRecord<T> | null> {
    const state = await this.loadKeyResolution<T>(key);
    const latest = state.status === "canonical" ? state.head : null;

    if (!latest || latest.operation === StoreOperation.Delete) {
      return null;
    }

    return latest;
  }

  async delete(key: string): Promise<StoredRecord<null>> {
    return this.write<null>(key, StoreOperation.Delete, null, undefined);
  }

  async history<T>(key: string): Promise<Array<StoredRecord<T>>> {
    const state = await this.loadKeyResolution<T>(key);

    if (state.status === "empty") {
      if (state.rawRecords.length > 0) {
        throw new VerificationError(
          `Cannot build history for key "${key}" because existing records could not be verified.`
        );
      }

      return [];
    }

    if (state.status === "ambiguous") {
      throw new VerificationError(
        `Cannot build history for key "${key}" because multiple verified heads exist.`
      );
    }

    return state.chain;
  }

  async verify(record: StoredRecord): Promise<boolean> {
    const result = await this.verifier.verifyRecord(record.raw);
    return result.verified;
  }

  async query<T>(filter: QueryFilter = {}): Promise<Array<StoredRecord<T>>> {
    const records = await this.loadRecords(undefined, filter);
    const verified = await this.verifyRecords<T>(undefined, records);
    const recordsByKey = new Map<string, Array<StoredRecord<T>>>();

    for (const record of verified) {
      const bucket = recordsByKey.get(record.keyHash) ?? [];
      bucket.push(record);
      recordsByKey.set(record.keyHash, bucket);
    }

    const latestByKey: Array<StoredRecord<T>> = [];

    for (const bucket of recordsByKey.values()) {
      const resolution = resolveCanonicalChain(bucket);

      if (resolution.status !== "canonical" || !resolution.head) {
        continue;
      }

      latestByKey.push(resolution.head);
    }

    const values = latestByKey.sort((left, right) => {
      if (left.version === right.version) {
        return right.time - left.time;
      }

      return right.version - left.version;
    });
    const filteredValues = filter.includeDeleted
      ? values
      : values.filter((record) => record.operation !== StoreOperation.Delete);

    return typeof filter.limit === "number"
      ? filteredValues.slice(0, filter.limit)
      : filteredValues;
  }

  async timestamp(uid: `0x${string}`): Promise<bigint> {
    if (!this.config.signer) {
      throw new ConfigurationError("timestamp() requires a signer.");
    }

    const eas = new EAS(this.config.easContractAddress);
    eas.connect(this.config.signer as never);
    const tx = await eas.timestamp(uid);
    return tx.wait();
  }

  async batchTimestamp(uids: Array<`0x${string}`>): Promise<bigint[]> {
    if (!this.config.signer) {
      throw new ConfigurationError("batchTimestamp() requires a signer.");
    }

    const eas = new EAS(this.config.easContractAddress);
    eas.connect(this.config.signer as never);
    const tx = await eas.multiTimestamp(uids);
    return tx.wait();
  }
}
