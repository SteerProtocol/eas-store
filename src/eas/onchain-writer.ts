import { EAS, NO_EXPIRATION } from "@ethereum-attestation-service/eas-sdk";

import { requireTransactionSigner } from "./client";
import { encodeStoreRecord } from "./schema";
import type { IndexedAttestationEnvelope, PreparedWrite, WriteContext } from "../types";

export class OnchainWriter {
  constructor(private readonly context: WriteContext) {}

  async attest(write: PreparedWrite): Promise<IndexedAttestationEnvelope> {
    const signer = requireTransactionSigner(this.context.signer);
    const eas = new EAS(this.context.easContractAddress);
    eas.connect(signer);

    const tx = await eas.attest({
      schema: this.context.schemaUID,
      data: {
        recipient: write.recipient,
        expirationTime: write.expirationTime,
        revocable: write.revocable,
        refUID: write.record.previousUID,
        data: encodeStoreRecord(write.record)
      }
    });

    const uid = (await tx.wait()) as `0x${string}`;
    const attestation = await eas.getAttestation(uid);

    return {
      uid: attestation.uid as `0x${string}`,
      schema: attestation.schema as `0x${string}`,
      refUID: attestation.refUID as `0x${string}`,
      time: attestation.time,
      expirationTime: attestation.expirationTime ?? NO_EXPIRATION,
      revocationTime: attestation.revocationTime,
      recipient: attestation.recipient as `0x${string}`,
      revocable: attestation.revocable,
      attester: attestation.attester as `0x${string}`,
      data: attestation.data as `0x${string}`,
      revoked: attestation.revocationTime > 0n,
      mode: "onchain",
      source: "chain"
    };
  }
}
