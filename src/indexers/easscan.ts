import { decodeRecordExtra, decodeStoreRecord } from "../eas/schema";
import type { IndexedStoreRecord, IndexerAdapter, IndexQuery, StoreMode } from "../types";

type GraphQLAttestation = {
  id: `0x${string}`;
  schemaId: `0x${string}`;
  attester: `0x${string}`;
  recipient: `0x${string}`;
  time: string;
  expirationTime: string;
  revocationTime: string;
  refUID: `0x${string}`;
  revocable: boolean;
  isOffchain: boolean;
  data: `0x${string}`;
};

type GraphQLResponse = {
  data?: {
    attestations: GraphQLAttestation[];
  };
  errors?: Array<{ message: string }>;
};

export interface EASScanIndexerOptions {
  endpoint: string;
  fetchImpl?: typeof fetch;
}

function toBigInt(value: string | null | undefined): bigint {
  if (!value) {
    return 0n;
  }

  return BigInt(value);
}

export class EASScanIndexer implements IndexerAdapter {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: EASScanIndexerOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  supportsVerifiedReads(mode: StoreMode): boolean {
    return mode === "onchain";
  }

  async index(): Promise<void> {}

  async query(filter: IndexQuery): Promise<IndexedStoreRecord[]> {
    const take = Math.max(filter.limit ?? 100, 1);
    const where: Record<string, unknown> = {
      schemaId: { equals: filter.schemaUID }
    };

    if (filter.attester) {
      where.attester = { equals: filter.attester.toLowerCase() };
    }

    if (filter.recipient) {
      where.recipient = { equals: filter.recipient.toLowerCase() };
    }

    if (filter.mode) {
      where.isOffchain = { equals: filter.mode === "offchain" };
    }

    const query = `
      query Attestations($take: Int!, $skip: Int!, $where: AttestationWhereInput) {
        attestations(take: $take, skip: $skip, where: $where, orderBy: { time: desc }) {
          id
          schemaId
          attester
          recipient
          time
          expirationTime
          revocationTime
          refUID
          revocable
          isOffchain
          data
        }
      }
    `;
    const records: IndexedStoreRecord[] = [];
    let skip = 0;

    while (true) {
      const response = await this.fetchImpl(this.options.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          query,
          variables: {
            take,
            skip,
            where
          }
        })
      });

      const body = (await response.json()) as GraphQLResponse;

      if (body.errors && body.errors.length > 0) {
        throw new Error(body.errors.map((error) => error.message).join("; "));
      }

      if (!body.data || !Array.isArray(body.data.attestations)) {
        throw new Error("Invalid EASScan response: missing attestations array.");
      }

      for (const attestation of body.data.attestations) {
        const record = this.mapAttestation(attestation, filter);

        if (!record) {
          continue;
        }

        records.push(record);

        if (typeof filter.limit === "number" && records.length >= filter.limit) {
          return records.slice(0, filter.limit);
        }
      }

      if (body.data.attestations.length < take) {
        return records;
      }

      skip += body.data.attestations.length;
    }
  }

  private mapAttestation(
    attestation: GraphQLAttestation,
    filter: IndexQuery
  ): IndexedStoreRecord | null {
    let record;

    try {
      record = decodeStoreRecord(attestation.data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to decode attestation ${attestation.id}: ${message}`);
    }

    if (
      filter.namespaceHash &&
      record.namespaceHash.toLowerCase() !== filter.namespaceHash.toLowerCase()
    ) {
      return null;
    }

    if (filter.keyHash && record.keyHash.toLowerCase() !== filter.keyHash.toLowerCase()) {
      return null;
    }

    const mode: StoreMode = attestation.isOffchain ? "offchain" : "onchain";
    const extra = decodeRecordExtra(record.extra);

    return {
      attestation: {
        uid: attestation.id,
        schema: attestation.schemaId,
        refUID: attestation.refUID,
        time: toBigInt(attestation.time),
        expirationTime: toBigInt(attestation.expirationTime),
        revocationTime: toBigInt(attestation.revocationTime),
        recipient: attestation.recipient,
        revocable: attestation.revocable,
        attester: attestation.attester,
        data: attestation.data,
        revoked: toBigInt(attestation.revocationTime) > 0n,
        mode,
        source: this.options.endpoint
      },
      record,
      ...(extra.key ? { lookupKey: extra.key } : {})
    } satisfies IndexedStoreRecord;
  }
}
