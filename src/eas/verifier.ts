import { Signature, verifyTypedData } from "ethers";

import { createEASClient, createOffchainClient, getTransport } from "./client";
import { decodeStoreRecord, encodeStoreRecord, ZERO_UID } from "./schema";
import { decodeStoredValue } from "../codecs/json";
import { hashBytes } from "../crypto/hash";
import { isTrustedAttester, sameAddress } from "../policies/trusted-attesters";
import type {
  EASRuntimeConfig,
  IndexedStoreRecord,
  StorageAdapter,
  StoredRecord,
  VerificationPolicy
} from "../types";

export interface VerificationResult<T = unknown> {
  verified: boolean;
  value: T | null;
  record?: IndexedStoreRecord;
  reason?: string;
}

function nowInSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

function toOptionalSeconds(value: bigint): number | null {
  return value === 0n ? null : Number(value);
}

export class EASRecordVerifier {
  constructor(
    private readonly runtime: EASRuntimeConfig,
    private readonly namespace: string,
    private readonly storage: StorageAdapter,
    private readonly policy: VerificationPolicy
  ) {}

  private async verifyOnchainAttestation(
    record: IndexedStoreRecord
  ): Promise<IndexedStoreRecord | null> {
    const transport = getTransport(this.runtime);

    if (!transport) {
      return this.policy.requireChainValidationOnchain ? null : record;
    }

    const eas = createEASClient(this.runtime);
    const chainRecord = await eas.getAttestation(record.attestation.uid);
    const fieldsMatch =
      sameAddress(chainRecord.attester, record.attestation.attester) &&
      sameAddress(chainRecord.recipient, record.attestation.recipient) &&
      chainRecord.schema.toLowerCase() === record.attestation.schema.toLowerCase() &&
      chainRecord.data.toLowerCase() === record.attestation.data.toLowerCase() &&
      chainRecord.refUID.toLowerCase() === record.attestation.refUID.toLowerCase() &&
      chainRecord.time === record.attestation.time &&
      chainRecord.revocable === record.attestation.revocable;

    if (!fieldsMatch) {
      return null;
    }

    return {
      ...record,
      attestation: {
        ...record.attestation,
        time: chainRecord.time,
        expirationTime: chainRecord.expirationTime,
        revocationTime: chainRecord.revocationTime,
        recipient: chainRecord.recipient as `0x${string}`,
        revocable: chainRecord.revocable,
        attester: chainRecord.attester as `0x${string}`,
        data: chainRecord.data as `0x${string}`,
        revoked: chainRecord.revocationTime > 0n
      }
    };
  }

  private async verifyOffchainAttestation(record: IndexedStoreRecord): Promise<boolean> {
    const signed = record.attestation.signedOffchainAttestation;

    if (!signed) {
      return false;
    }

    const offchain = await createOffchainClient(this.runtime);
    const signature = Signature.from(signed.signature).serialized;
    const recovered = verifyTypedData(
      signed.domain,
      signed.types,
      signed.message,
      signature
    );

    return (
      sameAddress(recovered, record.attestation.attester) &&
      offchain.verifyOffchainAttestationSignature(record.attestation.attester, signed) &&
      signed.uid.toLowerCase() === record.attestation.uid.toLowerCase()
    );
  }

  async verifyRecord<T = unknown>(record: IndexedStoreRecord): Promise<VerificationResult<T>> {
    const fail = (reason: string): VerificationResult<T> => {
      const result: VerificationResult<T> = {
        verified: false,
        value: null
      };
      Object.defineProperty(result, "reason", {
        value: reason,
        enumerable: false
      });
      return result;
    };
    const effectiveRecord =
      record.attestation.mode === "onchain"
        ? await this.verifyOnchainAttestation(record)
        : record;

    if (!effectiveRecord) {
      return fail("onchain attestation could not be validated against the chain");
    }

    if (effectiveRecord.attestation.schema.toLowerCase() !== this.policy.schemaUID.toLowerCase()) {
      return fail("attestation schema does not match verification policy");
    }

    if (
      effectiveRecord.record.namespaceHash.toLowerCase() !==
      this.policy.namespaceHash.toLowerCase()
    ) {
      return fail("attestation namespace does not match verification policy");
    }

    if (
      !isTrustedAttester(
        effectiveRecord.attestation.attester,
        this.policy.trustedAttesters
      )
    ) {
      return fail("attester is not trusted by verification policy");
    }

    if (
      this.policy.requireRecipient &&
      !sameAddress(effectiveRecord.attestation.recipient, this.policy.requireRecipient)
    ) {
      return fail("recipient does not match verification policy");
    }

    if (
      !this.policy.allowExpired &&
      effectiveRecord.attestation.expirationTime > 0n &&
      effectiveRecord.attestation.expirationTime < nowInSeconds()
    ) {
      return fail("attestation is expired");
    }

    if (
      !this.policy.allowRevoked &&
      (
        effectiveRecord.attestation.revoked ||
        effectiveRecord.attestation.revocationTime > 0n
      )
    ) {
      return fail("attestation is revoked");
    }

    if (
      encodeStoreRecord(effectiveRecord.record).toLowerCase() !==
      effectiveRecord.attestation.data.toLowerCase()
    ) {
      return fail("attestation data does not match the indexed record");
    }

    const decodedRecord = decodeStoreRecord(effectiveRecord.attestation.data);

    if (
      decodedRecord.keyHash.toLowerCase() !== effectiveRecord.record.keyHash.toLowerCase() ||
      decodedRecord.valueHash.toLowerCase() !== effectiveRecord.record.valueHash.toLowerCase() ||
      decodedRecord.previousUID.toLowerCase() !== effectiveRecord.record.previousUID.toLowerCase()
    ) {
      return fail("decoded attestation payload does not match the indexed record");
    }

    if (effectiveRecord.attestation.mode === "offchain") {
      const offchainValid = await this.verifyOffchainAttestation(effectiveRecord);

      if (!offchainValid) {
        return fail("offchain attestation signature is invalid or missing");
      }
    }

    if (
      this.policy.requireTimestamp &&
      effectiveRecord.attestation.mode === "offchain"
    ) {
      const transport = getTransport(this.runtime);

      if (!transport) {
        return fail("timestamp verification requires a chain provider");
      }

      const eas = createEASClient(this.runtime);
      const timestamp = await eas.getTimestamp(effectiveRecord.attestation.uid);

      if (timestamp === 0n) {
        return fail("offchain attestation has not been timestamped onchain");
      }
    }

    if (effectiveRecord.record.operation === 2) {
      return { verified: true, value: null, record: effectiveRecord };
    }

    let bytes: Uint8Array;

    try {
      bytes = effectiveRecord.record.valueURI
        ? await this.storage.get(effectiveRecord.record.valueURI)
        : new Uint8Array();
    } catch {
      return fail(`stored value could not be loaded from ${effectiveRecord.record.valueURI}`);
    }

    if (
      hashBytes(bytes).toLowerCase() !== effectiveRecord.record.valueHash.toLowerCase()
    ) {
      return fail("stored value hash does not match attestation payload");
    }

    return {
      verified: true,
      value: decodeStoredValue<T>(bytes, effectiveRecord.record.contentType),
      record: effectiveRecord
    };
  }

  materializeStoredRecord<T>(
    record: IndexedStoreRecord,
    value: T | null,
    verified: boolean,
    key: string
  ): StoredRecord<T> {
    return {
      key,
      value,
      uid: record.attestation.uid,
      schemaUID: record.attestation.schema,
      namespace: this.namespace,
      namespaceHash: record.record.namespaceHash,
      keyHash: record.record.keyHash,
      valueHash: record.record.valueHash,
      valueURI: record.record.valueURI,
      contentType: record.record.contentType,
      version: Number(record.record.version),
      operation: record.record.operation,
      attester: record.attestation.attester,
      recipient: record.attestation.recipient,
      time: Number(record.attestation.time),
      expirationTime: toOptionalSeconds(record.attestation.expirationTime),
      revoked: record.attestation.revoked,
      verified,
      mode: record.attestation.mode,
      raw: record,
      ...(record.record.previousUID === ZERO_UID
        ? {}
        : { previousUID: record.record.previousUID })
    };
  }
}
