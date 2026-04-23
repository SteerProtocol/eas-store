import { AbiCoder } from "ethers";
import { SchemaEncoder } from "@ethereum-attestation-service/eas-sdk";
import { describe, expect, it, vi } from "vitest";

import { MemoryIndexer, StoreOperation, ZERO_UID } from "../src";
import {
  decodeRecordExtra,
  decodeStoreRecord,
  encodeRecordExtra,
  encodeStoreRecord
} from "../src/eas/schema";
import * as schemaModule from "../src/eas/schema";
import { EASScanIndexer } from "../src/indexers/easscan";
import type { IndexedStoreRecord } from "../src/types";
import { EAS_ADDRESS, SCHEMA_UID } from "./helpers";

function makeRecord(overrides: Partial<IndexedStoreRecord> = {}): IndexedStoreRecord {
  const base: IndexedStoreRecord = {
    attestation: {
      uid: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      schema: SCHEMA_UID,
      refUID: ZERO_UID,
      time: 2n,
      expirationTime: 0n,
      revocationTime: 0n,
      recipient: EAS_ADDRESS,
      revocable: true,
      attester: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      data: "0x",
      revoked: false,
      mode: "offchain"
    },
    record: {
      namespaceHash:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      keyHash:
        "0x2222222222222222222222222222222222222222222222222222222222222222",
      valueHash:
        "0x3333333333333333333333333333333333333333333333333333333333333333",
      valueURI: "memory://alpha",
      contentType: "application/json",
      version: 1n,
      operation: StoreOperation.Set,
      previousUID: ZERO_UID,
      extra: encodeRecordExtra({
        key: "profile:alice"
      })
    },
    lookupKey: "profile:alice"
  };

  base.attestation.data = encodeStoreRecord(base.record);

  return {
    ...base,
    ...overrides,
    attestation: {
      ...base.attestation,
      ...overrides.attestation
    },
    record: {
      ...base.record,
      ...overrides.record
    }
  };
}

describe("schema helpers and indexers", () => {
  it("round-trips encoded store records", () => {
    const record = makeRecord().record;
    expect(decodeStoreRecord(encodeStoreRecord(record))).toEqual(record);
  });

  it("throws when a schema field is missing from the encoded payload", () => {
    const encoder = new SchemaEncoder("bytes32 namespace");
    const incomplete = encoder.encodeData([
      {
        name: "namespace",
        type: "bytes32",
        value:
          "0x1111111111111111111111111111111111111111111111111111111111111111"
      }
    ]) as `0x${string}`;

    expect(() => decodeStoreRecord(incomplete)).toThrow();
  });

  it("encodes and decodes key metadata in extra", () => {
    const versionTwoExtra = AbiCoder.defaultAbiCoder().encode(
      ["uint8", "string", "bytes"],
      [2, "x", "0x"]
    ) as `0x${string}`;
    const extra = encodeRecordExtra({
      key: "settings/theme",
      metadata:
        "0x1234"
    });

    expect(decodeRecordExtra(extra)).toEqual({
      key: "settings/theme",
      metadata: "0x1234"
    });
    expect(decodeRecordExtra("0x")).toEqual({ metadata: "0x" });
    expect(decodeRecordExtra("0x1234")).toEqual({ metadata: "0x1234" });
    expect(decodeRecordExtra(versionTwoExtra)).toEqual({ metadata: versionTwoExtra });
  });

  it("filters and sorts memory indexer results", async () => {
    const indexer = new MemoryIndexer();
    expect(indexer.supportsVerifiedReads()).toBe(true);
    const first = makeRecord();
    const second = makeRecord({
      attestation: {
        ...makeRecord().attestation,
        uid: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        time: 5n
      },
      record: {
        ...makeRecord().record,
        version: 2n
      }
    });

    await indexer.index(first);
    await indexer.index(second);

    const results = await indexer.query({
      schemaUID: SCHEMA_UID,
      namespaceHash: first.record.namespaceHash,
      keyHash: first.record.keyHash,
      mode: "offchain",
      limit: 1
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.attestation.uid).toBe(second.attestation.uid);
  });

  it("rejects memory indexer results on schema, attester, recipient, and mode mismatch", async () => {
    const indexer = new MemoryIndexer();
    const record = makeRecord();
    await indexer.index(record);

    await expect(
      indexer.query({
        schemaUID:
          "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" as `0x${string}`
      })
    ).resolves.toHaveLength(0);
    await expect(
      indexer.query({
        schemaUID: SCHEMA_UID,
        attester:
          "0x0000000000000000000000000000000000000009" as `0x${string}`
      })
    ).resolves.toHaveLength(0);
    await expect(
      indexer.query({
        schemaUID: SCHEMA_UID,
        recipient:
          "0x0000000000000000000000000000000000000008" as `0x${string}`
      })
    ).resolves.toHaveLength(0);
    await expect(
      indexer.query({
        schemaUID: SCHEMA_UID,
        mode: "onchain"
      })
    ).resolves.toHaveLength(0);
  });

  it("queries EASScan and decodes remote keys", async () => {
    const record = makeRecord();
    const fetchImpl = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        data: {
          attestations: [
            {
              id: record.attestation.uid,
              schemaId: record.attestation.schema,
              attester: record.attestation.attester,
              recipient: record.attestation.recipient,
              time: "10",
              expirationTime: "0",
              revocationTime: "0",
              refUID: record.attestation.refUID,
              revocable: true,
              isOffchain: true,
              data: encodeStoreRecord(record.record)
            }
          ]
        }
      })
    });
    const indexer = new EASScanIndexer({
      endpoint: "https://base.easscan.org/graphql",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(indexer.supportsVerifiedReads("onchain")).toBe(true);
    expect(indexer.supportsVerifiedReads("offchain")).toBe(false);

    const results = await indexer.query({
      schemaUID: SCHEMA_UID,
      namespaceHash: record.record.namespaceHash,
      keyHash: record.record.keyHash,
      mode: "offchain",
      limit: 5
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(results).toHaveLength(1);
    expect(results[0]?.lookupKey).toBe("profile:alice");
    expect(results[0]?.attestation.mode).toBe("offchain");
  });

  it("uses the global fetch implementation when one is not injected", async () => {
    const record = makeRecord();
    const originalFetch = globalThis.fetch;
    const fetchImpl = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        data: {
          attestations: [
            {
              id: record.attestation.uid,
              schemaId: record.attestation.schema,
              attester: record.attestation.attester,
              recipient: record.attestation.recipient,
              time: "10",
              expirationTime: "0",
              revocationTime: "0",
              refUID: record.attestation.refUID,
              revocable: true,
              isOffchain: false,
              data: encodeStoreRecord({
                ...record.record,
                extra: "0x"
              })
            }
          ]
        }
      })
    });
    globalThis.fetch = fetchImpl as unknown as typeof fetch;

    try {
      const indexer = new EASScanIndexer({
        endpoint: "https://base.easscan.org/graphql"
      });
      const results = await indexer.query({
        schemaUID: SCHEMA_UID
      });

      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(results[0]?.lookupKey).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("binds the global fetch implementation before calling EASScan in browser-like environments", async () => {
    const record = makeRecord();
    const originalFetch = globalThis.fetch;
    const fetchImpl = vi.fn(function (this: unknown) {
      expect(this).toBe(globalThis);

      return Promise.resolve({
        json: vi.fn().mockResolvedValue({
          data: {
            attestations: [
              {
                id: record.attestation.uid,
                schemaId: record.attestation.schema,
                attester: record.attestation.attester,
                recipient: record.attestation.recipient,
                time: "10",
                expirationTime: "0",
                revocationTime: "0",
                refUID: record.attestation.refUID,
                revocable: true,
                isOffchain: false,
                data: encodeStoreRecord(record.record)
              }
            ]
          }
        })
      });
    });
    globalThis.fetch = fetchImpl as unknown as typeof fetch;

    try {
      const indexer = new EASScanIndexer({
        endpoint: "https://base.easscan.org/graphql"
      });

      const results = await indexer.query({
        schemaUID: SCHEMA_UID
      });

      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(results).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("applies attester, recipient, and namespace filters in EASScan queries", async () => {
    const record = makeRecord();
    const fetchImpl = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        data: {
          attestations: [
            {
              id: record.attestation.uid,
              schemaId: record.attestation.schema,
              attester: record.attestation.attester,
              recipient: record.attestation.recipient,
              time: "0",
              expirationTime: null,
              revocationTime: null,
              refUID: record.attestation.refUID,
              revocable: true,
              isOffchain: false,
              data: encodeStoreRecord({
                ...record.record,
                extra: "0x"
              })
            }
          ]
        }
      })
    });
    const indexer = new EASScanIndexer({
      endpoint: "https://base.easscan.org/graphql",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    const results = await indexer.query({
      schemaUID: SCHEMA_UID,
      attester: record.attestation.attester,
      recipient: record.attestation.recipient,
      namespaceHash:
        "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
    });

    expect(results).toHaveLength(0);
    const body = JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string);
    expect(body.variables.where.attester.equals).toBe(record.attestation.attester.toLowerCase());
    expect(body.variables.where.recipient.equals).toBe(record.attestation.recipient.toLowerCase());
    expect(body.variables.where.isOffchain).toBeUndefined();
  });

  it("drops EASScan records when the key hash does not match and handles empty timestamps", async () => {
    const record = makeRecord();
    const fetchImpl = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        data: {
          attestations: [
            {
              id: record.attestation.uid,
              schemaId: record.attestation.schema,
              attester: record.attestation.attester,
              recipient: record.attestation.recipient,
              time: "",
              expirationTime: "",
              revocationTime: "",
              refUID: record.attestation.refUID,
              revocable: true,
              isOffchain: true,
              data: encodeStoreRecord({
                ...record.record,
                keyHash:
                  "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
              })
            }
          ]
        }
      })
    });
    const indexer = new EASScanIndexer({
      endpoint: "https://base.easscan.org/graphql",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    await expect(
      indexer.query({
        schemaUID: SCHEMA_UID,
        keyHash: record.record.keyHash
      })
    ).resolves.toHaveLength(0);
  });

  it("maps empty timestamp fields from EASScan to zero values", async () => {
    const record = makeRecord();
    const fetchImpl = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        data: {
          attestations: [
            {
              id: record.attestation.uid,
              schemaId: record.attestation.schema,
              attester: record.attestation.attester,
              recipient: record.attestation.recipient,
              time: "",
              expirationTime: "",
              revocationTime: "",
              refUID: record.attestation.refUID,
              revocable: true,
              isOffchain: true,
              data: encodeStoreRecord(record.record)
            }
          ]
        }
      })
    });
    const indexer = new EASScanIndexer({
      endpoint: "https://base.easscan.org/graphql",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    const [result] = await indexer.query({
      schemaUID: SCHEMA_UID
    });

    expect(result?.attestation.time).toBe(0n);
    expect(result?.attestation.expirationTime).toBe(0n);
    expect(result?.attestation.revocationTime).toBe(0n);
  });

  it("paginates until it finds post-filter matches", async () => {
    const record = makeRecord();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue({
          data: {
            attestations: [
              {
                id: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
                schemaId: record.attestation.schema,
                attester: record.attestation.attester,
                recipient: record.attestation.recipient,
                time: "10",
                expirationTime: "0",
                revocationTime: "0",
                refUID: record.attestation.refUID,
                revocable: true,
                isOffchain: false,
                data: encodeStoreRecord({
                  ...record.record,
                  keyHash:
                    "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
                })
              }
            ]
          }
        })
      })
      .mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue({
          data: {
            attestations: [
              {
                id: record.attestation.uid,
                schemaId: record.attestation.schema,
                attester: record.attestation.attester,
                recipient: record.attestation.recipient,
                time: "9",
                expirationTime: "0",
                revocationTime: "0",
                refUID: record.attestation.refUID,
                revocable: true,
                isOffchain: false,
                data: encodeStoreRecord(record.record)
              }
            ]
          }
        })
      })
      .mockResolvedValueOnce({
        json: vi.fn().mockResolvedValue({
          data: {
            attestations: []
          }
        })
      });
    const indexer = new EASScanIndexer({
      endpoint: "https://base.easscan.org/graphql",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    const results = await indexer.query({
      schemaUID: SCHEMA_UID,
      keyHash: record.record.keyHash,
      limit: 1
    });

    expect(results).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(fetchImpl.mock.calls[1]?.[1]?.body as string);
    expect(secondBody.variables.skip).toBe(1);
  });

  it("throws actionable decode errors from EASScan", async () => {
    const indexer = new EASScanIndexer({
      endpoint: "https://base.easscan.org/graphql",
      fetchImpl: vi.fn().mockResolvedValue({
        json: vi.fn().mockResolvedValue({
          data: {
            attestations: [
              {
                id: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
                schemaId: SCHEMA_UID,
                attester: EAS_ADDRESS,
                recipient: EAS_ADDRESS,
                time: "0",
                expirationTime: "0",
                revocationTime: "0",
                refUID: ZERO_UID,
                revocable: true,
                isOffchain: false,
                data: "0x1234"
              }
            ]
          }
        })
      }) as unknown as typeof fetch
    });

    await expect(
      indexer.query({
        schemaUID: SCHEMA_UID
      })
    ).rejects.toThrow("Failed to decode attestation");
  });

  it("surfaces invalid EASScan response shapes", async () => {
    const indexer = new EASScanIndexer({
      endpoint: "https://base.easscan.org/graphql",
      fetchImpl: vi.fn().mockResolvedValue({
        json: vi.fn().mockResolvedValue({
          data: {}
        })
      }) as unknown as typeof fetch
    });

    await expect(
      indexer.query({
        schemaUID: SCHEMA_UID
      })
    ).rejects.toThrow("missing attestations array");
  });

  it("preserves non-Error decode failures as actionable messages", async () => {
    const record = makeRecord();
    const decodeSpy = vi
      .spyOn(schemaModule, "decodeStoreRecord")
      .mockImplementation(() => {
        throw "decode exploded";
      });
    const indexer = new EASScanIndexer({
      endpoint: "https://base.easscan.org/graphql",
      fetchImpl: vi.fn().mockResolvedValue({
        json: vi.fn().mockResolvedValue({
          data: {
            attestations: [
              {
                id: record.attestation.uid,
                schemaId: record.attestation.schema,
                attester: record.attestation.attester,
                recipient: record.attestation.recipient,
                time: "0",
                expirationTime: "0",
                revocationTime: "0",
                refUID: ZERO_UID,
                revocable: true,
                isOffchain: false,
                data: "0xdeadbeef"
              }
            ]
          }
        })
      }) as unknown as typeof fetch
    });

    await expect(
      indexer.query({
        schemaUID: SCHEMA_UID
      })
    ).rejects.toThrow("decode exploded");
    decodeSpy.mockRestore();
  });

  it("surfaces GraphQL errors from EASScan", async () => {
    const indexer = new EASScanIndexer({
      endpoint: "https://base.easscan.org/graphql",
      fetchImpl: vi.fn().mockResolvedValue({
        json: vi.fn().mockResolvedValue({
          errors: [{ message: "boom" }]
        })
      }) as unknown as typeof fetch
    });

    await expect(
      indexer.query({
        schemaUID: SCHEMA_UID
      })
    ).rejects.toThrow("boom");
  });
});
