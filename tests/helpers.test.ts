import { describe, expect, it } from "vitest";

import type { IndexedStoreRecord } from "../src";
import { StoreOperation, ZERO_UID } from "../src";
import {
  cloneIndexedRecord,
  createOffchainStore,
  EAS_ADDRESS,
  SCHEMA_UID,
  createWalletSigner
} from "./helpers";

describe("test helpers", () => {
  it("honors explicit signer overrides when creating offchain stores", async () => {
    const signer = createWalletSigner();
    const store = await createOffchainStore({
      signer
    });
    const written = await store.set("profile:alice", { name: "Alice" });

    expect(written.attester).toBe(await signer.getAddress());
  });

  it("clones records without optional lookup metadata", () => {
    const record: IndexedStoreRecord = {
      attestation: {
        uid: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        schema: SCHEMA_UID,
        refUID: ZERO_UID,
        time: 1n,
        expirationTime: 0n,
        revocationTime: 0n,
        recipient: EAS_ADDRESS,
        revocable: true,
        attester: EAS_ADDRESS,
        data: "0x1234",
        revoked: false,
        mode: "onchain"
      },
      record: {
        namespaceHash:
          "0x1111111111111111111111111111111111111111111111111111111111111111",
        keyHash:
          "0x2222222222222222222222222222222222222222222222222222222222222222",
        valueHash:
          "0x3333333333333333333333333333333333333333333333333333333333333333",
        valueURI: "memory://value",
        contentType: "application/json",
        version: 1n,
        operation: StoreOperation.Set,
        previousUID: ZERO_UID,
        extra: "0x"
      }
    };

    expect(cloneIndexedRecord(record)).toEqual(record);
  });
});
