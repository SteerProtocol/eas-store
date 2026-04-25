import type { IndexedStoreRecord, IndexerAdapter, IndexQuery } from "../types";

type LocalStorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

function localStorageForBrowser(): LocalStorageLike {
  const storage = (globalThis as typeof globalThis & {
    localStorage?: LocalStorageLike;
  }).localStorage;

  if (!storage) {
    throw new Error("LocalStorageIndexer requires browser localStorage support.");
  }

  return storage;
}

function serialize(record: IndexedStoreRecord): string {
  return JSON.stringify(record, (_key, value) =>
    typeof value === "bigint" ? { __easStoreBigInt: value.toString() } : value
  );
}

function deserialize(value: string): IndexedStoreRecord {
  return JSON.parse(value, (_key, item) => {
    if (
      item &&
      typeof item === "object" &&
      "__easStoreBigInt" in item &&
      typeof item.__easStoreBigInt === "string"
    ) {
      return BigInt(item.__easStoreBigInt);
    }

    return item;
  }) as IndexedStoreRecord;
}

function sortRecords(records: IndexedStoreRecord[]): IndexedStoreRecord[] {
  return [...records].sort((left, right) => {
    if (left.record.version === right.record.version) {
      return Number(right.attestation.time - left.attestation.time);
    }

    return Number(right.record.version - left.record.version);
  });
}

/**
 * Browser-local indexer for demos and explicit local/offchain development.
 *
 * Records are still cryptographically verified by the store, but localStorage is
 * mutable by same-origin code and cannot prove freshness. Do not use this as a
 * production source of latest state without an external freshness anchor.
 */
export class LocalStorageIndexer implements IndexerAdapter {
  readonly scope = "local" as const;

  constructor(
    private readonly options: {
      key?: string;
      storage?: LocalStorageLike;
    } = {}
  ) {}

  supportsVerifiedReads(): boolean {
    return true;
  }

  async index(record: IndexedStoreRecord): Promise<void> {
    const records = this.readAll();
    records.set(record.attestation.uid.toLowerCase(), record);
    this.writeAll(records);
  }

  async query(filter: IndexQuery): Promise<IndexedStoreRecord[]> {
    const records = Array.from(this.readAll().values()).filter((record) =>
      this.matches(record, filter)
    );
    const sorted = sortRecords(records);
    return typeof filter.limit === "number" ? sorted.slice(0, filter.limit) : sorted;
  }

  private matches(record: IndexedStoreRecord, filter: IndexQuery): boolean {
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
  }

  private readAll(): Map<string, IndexedStoreRecord> {
    const raw = this.storage().getItem(this.key());

    if (!raw) {
      return new Map();
    }

    const records = JSON.parse(raw) as string[];
    return new Map(
      records.map((record) => {
        const decoded = deserialize(record);
        return [decoded.attestation.uid.toLowerCase(), decoded];
      })
    );
  }

  private writeAll(records: Map<string, IndexedStoreRecord>): void {
    this.storage().setItem(this.key(), JSON.stringify(Array.from(records.values()).map(serialize)));
  }

  private storage(): LocalStorageLike {
    return this.options.storage ?? localStorageForBrowser();
  }

  private key(): string {
    return this.options.key ?? "eas-store:indexer";
  }
}
