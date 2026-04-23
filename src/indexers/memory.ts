import type { IndexedStoreRecord, IndexerAdapter, IndexQuery } from "../types";

function sortRecords(records: IndexedStoreRecord[]): IndexedStoreRecord[] {
  return [...records].sort((left, right) => {
    if (left.record.version === right.record.version) {
      return Number(right.attestation.time - left.attestation.time);
    }

    return Number(right.record.version - left.record.version);
  });
}

export class MemoryIndexer implements IndexerAdapter {
  private readonly records = new Map<string, IndexedStoreRecord>();

  supportsVerifiedReads(): boolean {
    return true;
  }

  async index(record: IndexedStoreRecord): Promise<void> {
    this.records.set(record.attestation.uid, record);
  }

  async query(filter: IndexQuery): Promise<IndexedStoreRecord[]> {
    const records = Array.from(this.records.values()).filter((record) => {
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

    const sorted = sortRecords(records);
    return typeof filter.limit === "number" ? sorted.slice(0, filter.limit) : sorted;
  }
}
