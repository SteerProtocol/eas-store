import { Wallet } from "ethers";

import { EASKeyStore, MemoryIndexer, MemoryStorage } from "../src";
import type { EASKeyStoreConfig, IndexedStoreRecord } from "../src";

export const EAS_ADDRESS = "0x0000000000000000000000000000000000000001" as const;
export const SCHEMA_UID =
  "0x1111111111111111111111111111111111111111111111111111111111111111" as const;

export function createWalletSigner() {
  return Wallet.createRandom();
}

export async function createOffchainStore(
  overrides: Partial<EASKeyStoreConfig> = {}
) {
  const signer = overrides.signer ?? createWalletSigner();

  return EASKeyStore.create({
    chainId: 8453,
    easContractAddress: EAS_ADDRESS,
    easVersion: "1.3.0",
    schemaUID: SCHEMA_UID,
    namespace: "test.profile",
    signer,
    storage: overrides.storage ?? new MemoryStorage(),
    indexer: overrides.indexer ?? new MemoryIndexer(),
    ...overrides
  });
}

export function cloneIndexedRecord(record: IndexedStoreRecord): IndexedStoreRecord {
  return {
    attestation: {
      ...record.attestation,
      ...(record.attestation.signedOffchainAttestation
        ? {
            signedOffchainAttestation: structuredClone(
              record.attestation.signedOffchainAttestation
            )
          }
        : {})
    },
    record: {
      ...record.record
    },
    ...(record.lookupKey ? { lookupKey: record.lookupKey } : {})
  };
}
