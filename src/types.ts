import type {
  SignedOffchainAttestation,
  TransactionProvider,
  TransactionSigner
} from "@ethereum-attestation-service/eas-sdk";
import type { TypedDataDomain, TypedDataField } from "ethers";

export type Hex = `0x${string}`;
export type Address = Hex;
export type StoreMode = "onchain" | "offchain";
export type StoragePersistence = "inline" | "remote" | "local";
export type IndexerScope = "remote" | "local";

export enum StoreOperation {
  Set = 1,
  Delete = 2
}

export interface TypedDataSignerLike {
  getAddress(): Promise<string>;
  signTypedData(
    domain: TypedDataDomain,
    types: Record<string, Array<TypedDataField>>,
    value: Record<string, unknown>
  ): Promise<string>;
}

export type StoreSigner = TypedDataSignerLike & Partial<TransactionSigner>;

export interface StorageAdapter {
  readonly persistence?: StoragePersistence;
  put(data: Uint8Array, contentType: string): Promise<string>;
  get(uri: string): Promise<Uint8Array>;
}

export interface EncodedStoreRecord {
  namespaceHash: Hex;
  keyHash: Hex;
  valueHash: Hex;
  valueURI: string;
  contentType: string;
  version: bigint;
  operation: StoreOperation;
  previousUID: Hex;
  extra: Hex;
}

export interface IndexedAttestationEnvelope {
  uid: Hex;
  schema: Hex;
  refUID: Hex;
  time: bigint;
  expirationTime: bigint;
  revocationTime: bigint;
  recipient: Address;
  revocable: boolean;
  attester: Address;
  data: Hex;
  revoked: boolean;
  mode: StoreMode;
  signedOffchainAttestation?: SignedOffchainAttestation;
  source?: string;
}

export interface IndexedStoreRecord {
  attestation: IndexedAttestationEnvelope;
  record: EncodedStoreRecord;
  lookupKey?: string;
}

export interface IndexQuery {
  schemaUID: Hex;
  namespaceHash?: Hex;
  keyHash?: Hex;
  attester?: Address;
  recipient?: Address;
  mode?: StoreMode;
  limit?: number;
}

export interface IndexerAdapter {
  readonly scope?: IndexerScope;
  index?(record: IndexedStoreRecord): Promise<void>;
  query(filter: IndexQuery): Promise<IndexedStoreRecord[]>;
  supportsVerifiedReads?(mode: StoreMode): boolean;
}

export interface SetOptions {
  recipient?: Address;
  contentType?: string;
  expirationTime?: bigint;
  revocable?: boolean;
  extra?: Hex;
}

export interface QueryFilter {
  attester?: Address;
  recipient?: Address;
  limit?: number;
  includeDeleted?: boolean;
}

export interface VerificationPolicy {
  schemaUID: Hex;
  namespaceHash: Hex;
  trustedAttesters?: Address[];
  requireRecipient?: Address;
  allowExpired?: boolean;
  allowRevoked?: boolean;
  requireTimestamp?: boolean;
  requireChainValidationOnchain?: boolean;
}

export interface StoredRecord<T = unknown> {
  key: string;
  value: T | null;
  uid: Hex;
  schemaUID: Hex;
  namespace: string;
  namespaceHash: Hex;
  keyHash: Hex;
  valueHash: Hex;
  valueURI: string;
  contentType: string;
  version: number;
  operation: StoreOperation;
  previousUID?: Hex;
  attester: Address;
  recipient: Address;
  time: number;
  expirationTime: number | null;
  revoked: boolean;
  verified: boolean;
  mode: StoreMode;
  raw: IndexedStoreRecord;
}

export interface EASRuntimeConfig {
  chainId: number;
  easContractAddress: Address;
  easVersion?: string;
  signer?: StoreSigner;
  provider?: TransactionProvider;
}

export interface EASKeyStoreConfig extends EASRuntimeConfig {
  schemaUID: Hex;
  namespace: string;
  mode?: StoreMode;
  storage?: StorageAdapter;
  indexer?: IndexerAdapter;
  trustedAttesters?: Address[];
  verification?: Partial<
    Omit<VerificationPolicy, "schemaUID" | "namespaceHash" | "trustedAttesters">
  >;
  defaultRecipient?: Address;
}

export interface PreparedWrite {
  key: string;
  record: EncodedStoreRecord;
  recipient: Address;
  expirationTime: bigint;
  revocable: boolean;
}

export interface WriteContext extends EASRuntimeConfig {
  schemaUID: Hex;
}
