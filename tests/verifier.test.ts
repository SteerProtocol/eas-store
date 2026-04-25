import { beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryStorage } from "../src";
import { EASRecordVerifier } from "../src/eas/verifier";
import { ZERO_UID } from "../src/eas/schema";
import * as clientModule from "../src/eas/client";
import { hashText } from "../src/crypto/hash";
import type { IndexedStoreRecord, StorageAdapter } from "../src/types";
import {
  cloneIndexedRecord,
  createOffchainStore,
  EAS_ADDRESS,
  SCHEMA_UID
} from "./helpers";

beforeEach(() => {
  vi.restoreAllMocks();
});

async function createVerifiedRawRecord() {
  const storage = new MemoryStorage();
  const store = await createOffchainStore({
    storage
  });
  const written = await store.set("profile:alice", {
    name: "Alice"
  });

  return {
    raw: written.raw,
    storage,
    store
  };
}

function createVerifier(storage: StorageAdapter = new MemoryStorage()) {
  return new EASRecordVerifier(
    {
      chainId: 8453,
      easContractAddress: EAS_ADDRESS,
      easVersion: "1.3.0"
    },
    "test.profile",
    storage,
    {
      schemaUID: SCHEMA_UID,
      namespaceHash: hashText("test.profile"),
      requireChainValidationOnchain: true
    }
  );
}

describe("EASRecordVerifier", () => {
  it("verifies a real offchain record and materializes it", async () => {
    const { raw, storage } = await createVerifiedRawRecord();
    const verifier = createVerifier(storage);
    const result = await verifier.verifyRecord<{ name: string }>(raw);

    expect(result).toMatchObject({
      verified: true,
      value: {
        name: "Alice"
      }
    });

    const materialized = verifier.materializeStoredRecord(
      raw,
      result.value,
      true,
      "profile:alice"
    );

    expect(materialized.key).toBe("profile:alice");
    expect(materialized.previousUID).toBeUndefined();
  });

  it("accepts delete tombstones without loading storage", async () => {
    const storage = new MemoryStorage();
    const store = await createOffchainStore({
      storage
    });
    await store.set("profile:alice", {
      name: "Alice"
    });
    const deleted = await store.delete("profile:alice");
    const tombstone = deleted.raw;

    const verifier = createVerifier(storage);
    const result = await verifier.verifyRecord(tombstone);

    expect(result).toMatchObject({
      verified: true,
      value: null
    });
  });

  it("rejects records that violate policy or data integrity", async () => {
    const { raw, storage } = await createVerifiedRawRecord();
    const verifier = createVerifier(storage);

    const wrongSchema = cloneIndexedRecord(raw);
    wrongSchema.attestation.schema =
      "0x9999999999999999999999999999999999999999999999999999999999999999";
    expect(await verifier.verifyRecord(wrongSchema)).toEqual({
      verified: false,
      value: null
    });

    const wrongNamespace = cloneIndexedRecord(raw);
    wrongNamespace.record.namespaceHash =
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    expect(await verifier.verifyRecord(wrongNamespace)).toEqual({
      verified: false,
      value: null
    });

    const revoked = cloneIndexedRecord(raw);
    revoked.attestation.revoked = true;
    expect(await verifier.verifyRecord(revoked)).toEqual({
      verified: false,
      value: null
    });

    const expired = cloneIndexedRecord(raw);
    expired.attestation.expirationTime = 1n;
    expect(await verifier.verifyRecord(expired)).toEqual({
      verified: false,
      value: null
    });

    const hashMismatch = cloneIndexedRecord(raw);
    hashMismatch.record.valueHash =
      "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    expect(await verifier.verifyRecord(hashMismatch)).toEqual({
      verified: false,
      value: null
    });
  });

  it("supports permissive expiration and revocation policy", async () => {
    const { raw, storage } = await createVerifiedRawRecord();
    const permissive = cloneIndexedRecord(raw);
    permissive.attestation.expirationTime = 1n;
    permissive.attestation.revoked = true;
    permissive.attestation.revocationTime = 1n;
    const verifier = new EASRecordVerifier(
      {
        chainId: 8453,
        easContractAddress: EAS_ADDRESS,
        easVersion: "1.3.0"
      },
      "test.profile",
      storage,
      {
        schemaUID: SCHEMA_UID,
        namespaceHash: hashText("test.profile"),
        allowExpired: true,
        allowRevoked: true
      }
    );

    expect(await verifier.verifyRecord(permissive)).toEqual({
      verified: true,
      value: {
        name: "Alice"
      },
      record: permissive
    });
  });

  it("rejects mismatched recipients and decoded payload mismatches", async () => {
    const { raw, storage } = await createVerifiedRawRecord();
    const verifier = new EASRecordVerifier(
      {
        chainId: 8453,
        easContractAddress: EAS_ADDRESS,
        easVersion: "1.3.0"
      },
      "test.profile",
      storage,
      {
        schemaUID: SCHEMA_UID,
        namespaceHash: hashText("test.profile"),
        requireRecipient:
          "0x0000000000000000000000000000000000000009"
      }
    );
    const mismatchedPrevious = cloneIndexedRecord(raw);
    mismatchedPrevious.record.previousUID =
      "0x9999999999999999999999999999999999999999999999999999999999999999";

    expect(await verifier.verifyRecord(raw)).toEqual({
      verified: false,
      value: null
    });
    expect(await createVerifier(storage).verifyRecord(mismatchedPrevious)).toEqual({
      verified: false,
      value: null
    });
  });

  it("treats missing storage values as unverifiable records", async () => {
    const { raw } = await createVerifiedRawRecord();
    const verifier = createVerifier({
      put: vi.fn(),
      get: vi.fn().mockRejectedValue(new Error("missing blob"))
    });

    await expect(verifier.verifyRecord(raw)).resolves.toEqual({
      verified: false,
      value: null
    });
  });

  it("verifies onchain records through the client transport", async () => {
    const { raw, storage } = await createVerifiedRawRecord();
    const onchain = cloneIndexedRecord(raw);
    onchain.attestation.mode = "onchain";
    delete onchain.attestation.signedOffchainAttestation;

    vi.spyOn(clientModule, "getTransport").mockReturnValue({
      estimateGas: vi.fn(),
      call: vi.fn(),
      resolveName: vi.fn()
    });
    vi.spyOn(clientModule, "createEASClient").mockReturnValue({
      getAttestation: vi.fn().mockResolvedValue({
        uid: onchain.attestation.uid,
        schema: onchain.attestation.schema,
        refUID: onchain.attestation.refUID,
        time: onchain.attestation.time,
        expirationTime: onchain.attestation.expirationTime,
        revocationTime: onchain.attestation.revocationTime,
        recipient: onchain.attestation.recipient,
        revocable: onchain.attestation.revocable,
        attester: onchain.attestation.attester,
        data: onchain.attestation.data
      })
    } as never);

    const verifier = createVerifier(storage);
    const result = await verifier.verifyRecord(onchain);
    expect(result.verified).toBe(true);
    expect(result.record?.attestation.revoked).toBe(false);
  });

  it("enforces offchain timestamp requirements", async () => {
    const { raw, storage } = await createVerifiedRawRecord();

    vi.spyOn(clientModule, "getTransport").mockReturnValue({
      estimateGas: vi.fn(),
      call: vi.fn(),
      resolveName: vi.fn()
    });
    vi.spyOn(clientModule, "createEASClient").mockReturnValue({
      getTimestamp: vi.fn().mockResolvedValue(0n)
    } as never);

    const verifier = new EASRecordVerifier(
      {
        chainId: 8453,
        easContractAddress: EAS_ADDRESS,
        easVersion: "1.3.0"
      },
      "test.profile",
      storage,
      {
        schemaUID: SCHEMA_UID,
        namespaceHash: hashText("test.profile"),
        requireTimestamp: true
      }
    );

    expect(await verifier.verifyRecord(raw)).toEqual({
      verified: false,
      value: null
    });
  });

  it("accepts timestamped offchain records and rejects corrupted stored bytes", async () => {
    const { raw, storage } = await createVerifiedRawRecord();
    vi.spyOn(clientModule, "getTransport").mockReturnValue({
      estimateGas: vi.fn(),
      call: vi.fn(),
      resolveName: vi.fn()
    });
    vi.spyOn(clientModule, "createEASClient").mockReturnValue({
      getTimestamp: vi.fn().mockResolvedValue(1n)
    } as never);
    const verifier = new EASRecordVerifier(
      {
        chainId: 8453,
        easContractAddress: EAS_ADDRESS,
        easVersion: "1.3.0"
      },
      "test.profile",
      {
        put: storage.put.bind(storage),
        get: vi.fn().mockResolvedValue(new TextEncoder().encode("corrupted"))
      },
      {
        schemaUID: SCHEMA_UID,
        namespaceHash: hashText("test.profile"),
        requireTimestamp: true
      }
    );

    expect(await verifier.verifyRecord(raw)).toEqual({
      verified: false,
      value: null
    });
  });

  it("fails offchain verification without a signed package", async () => {
    const { raw, storage } = await createVerifiedRawRecord();
    const invalid = cloneIndexedRecord(raw);
    delete invalid.attestation.signedOffchainAttestation;

    const verifier = createVerifier(storage);
    expect(await verifier.verifyRecord(invalid)).toEqual({
      verified: false,
      value: null
    });
  });

  it("fails timestamp checks when transport is missing", async () => {
    const { raw, storage } = await createVerifiedRawRecord();
    vi.spyOn(clientModule, "getTransport").mockReturnValue(undefined);

    const verifier = new EASRecordVerifier(
      {
        chainId: 8453,
        easContractAddress: EAS_ADDRESS,
        easVersion: "1.3.0"
      },
      "test.profile",
      storage,
      {
        schemaUID: SCHEMA_UID,
        namespaceHash: hashText("test.profile"),
        requireTimestamp: true
      }
    );

    expect(await verifier.verifyRecord(raw)).toEqual({
      verified: false,
      value: null
    });
  });

  it("rejects trusted-attester and recipient mismatches", async () => {
    const { raw, storage } = await createVerifiedRawRecord();
    const verifier = new EASRecordVerifier(
      {
        chainId: 8453,
        easContractAddress: EAS_ADDRESS,
        easVersion: "1.3.0"
      },
      "test.profile",
      storage,
      {
        schemaUID: SCHEMA_UID,
        namespaceHash: hashText("test.profile"),
        trustedAttesters: [
          "0x9999999999999999999999999999999999999999"
        ] as Array<`0x${string}`>,
        requireRecipient:
          "0x8888888888888888888888888888888888888888"
      }
    );

    expect(await verifier.verifyRecord(raw)).toEqual({
      verified: false,
      value: null
    });
  });

  it("fails onchain validation when transport is required but missing", async () => {
    const { raw, storage } = await createVerifiedRawRecord();
    const onchain = cloneIndexedRecord(raw);
    onchain.attestation.mode = "onchain";
    delete onchain.attestation.signedOffchainAttestation;

    vi.spyOn(clientModule, "getTransport").mockReturnValue(undefined);

    const verifier = createVerifier(storage);
    expect(await verifier.verifyRecord(onchain)).toEqual({
      verified: false,
      value: null
    });
  });

  it("allows onchain verification without transport when chain validation is optional", async () => {
    const { raw, storage } = await createVerifiedRawRecord();
    const onchain = cloneIndexedRecord(raw);
    onchain.attestation.mode = "onchain";
    delete onchain.attestation.signedOffchainAttestation;

    vi.spyOn(clientModule, "getTransport").mockReturnValue(undefined);

    const verifier = new EASRecordVerifier(
      {
        chainId: 8453,
        easContractAddress: EAS_ADDRESS,
        easVersion: "1.3.0"
      },
      "test.profile",
      storage,
      {
        schemaUID: SCHEMA_UID,
        namespaceHash: hashText("test.profile")
      }
    );

    expect(await verifier.verifyRecord(onchain)).toMatchObject({
      verified: true,
      value: {
        name: "Alice"
      }
    });
  });

  it("fails onchain verification when chain data mismatches", async () => {
    const { raw, storage } = await createVerifiedRawRecord();
    const onchain = cloneIndexedRecord(raw);
    onchain.attestation.mode = "onchain";
    delete onchain.attestation.signedOffchainAttestation;

    vi.spyOn(clientModule, "getTransport").mockReturnValue({
      estimateGas: vi.fn(),
      call: vi.fn(),
      resolveName: vi.fn()
    });
    vi.spyOn(clientModule, "createEASClient").mockReturnValue({
      getAttestation: vi.fn().mockResolvedValue({
        uid: onchain.attestation.uid,
        schema: onchain.attestation.schema,
        refUID: ZERO_UID,
        time: onchain.attestation.time,
        expirationTime: onchain.attestation.expirationTime,
        revocationTime: onchain.attestation.revocationTime,
        recipient: onchain.attestation.recipient,
        revocable: onchain.attestation.revocable,
        attester: "0x0000000000000000000000000000000000000009",
        data: onchain.attestation.data
      })
    } as never);

    const verifier = createVerifier(storage);
    expect(await verifier.verifyRecord(onchain)).toEqual({
      verified: false,
      value: null
    });
  });

  it("rejects onchain records when the chain says they are revoked", async () => {
    const { raw, storage } = await createVerifiedRawRecord();
    const onchain = cloneIndexedRecord(raw);
    onchain.attestation.mode = "onchain";
    delete onchain.attestation.signedOffchainAttestation;
    onchain.attestation.revoked = false;
    onchain.attestation.revocationTime = 0n;

    vi.spyOn(clientModule, "getTransport").mockReturnValue({
      estimateGas: vi.fn(),
      call: vi.fn(),
      resolveName: vi.fn()
    });
    vi.spyOn(clientModule, "createEASClient").mockReturnValue({
      getAttestation: vi.fn().mockResolvedValue({
        uid: onchain.attestation.uid,
        schema: onchain.attestation.schema,
        refUID: onchain.attestation.refUID,
        time: onchain.attestation.time,
        expirationTime: onchain.attestation.expirationTime,
        revocationTime: 1n,
        recipient: onchain.attestation.recipient,
        revocable: onchain.attestation.revocable,
        attester: onchain.attestation.attester,
        data: onchain.attestation.data
      })
    } as never);

    const verifier = createVerifier(storage);
    expect(await verifier.verifyRecord(onchain)).toEqual({
      verified: false,
      value: null
    });
  });

  it("materializes non-zero expiration and previous uid values", () => {
    const verifier = createVerifier();
    const record: IndexedStoreRecord = {
      attestation: {
        uid: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        schema: SCHEMA_UID,
        refUID: ZERO_UID,
        time: 10n,
        expirationTime: 25n,
        revocationTime: 0n,
        recipient: EAS_ADDRESS,
        revocable: true,
        attester: EAS_ADDRESS,
        data: "0x",
        revoked: false,
        mode: "onchain"
      },
      record: {
        namespaceHash: hashText("test.profile"),
        keyHash:
          "0x2222222222222222222222222222222222222222222222222222222222222222",
        valueHash:
          "0x3333333333333333333333333333333333333333333333333333333333333333",
        valueURI: "",
        contentType: "application/json",
        version: 2n,
        operation: 1,
        previousUID:
          "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        extra: "0x"
      }
    };

    const materialized = verifier.materializeStoredRecord(
      record,
      { ok: true },
      true,
      "profile:alice"
    );

    expect(materialized.expirationTime).toBe(25);
    expect(materialized.previousUID).toBe(
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    );
  });
});
