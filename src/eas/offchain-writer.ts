import { NO_EXPIRATION } from "@ethereum-attestation-service/eas-sdk";

import { createOffchainClient, requireTypedDataSigner } from "./client";
import { encodeStoreRecord, ZERO_UID } from "./schema";
import type { IndexedAttestationEnvelope, PreparedWrite, WriteContext } from "../types";

export class OffchainWriter {
  constructor(private readonly context: WriteContext) {}

  async attest(write: PreparedWrite): Promise<IndexedAttestationEnvelope> {
    const signer = requireTypedDataSigner(this.context.signer);
    const offchain = await createOffchainClient(this.context);
    const attester = (await signer.getAddress()) as `0x${string}`;
    const time = BigInt(Math.floor(Date.now() / 1000));
    const data = encodeStoreRecord(write.record);
    const signed = await offchain.signOffchainAttestation(
      {
        schema: this.context.schemaUID,
        recipient: write.recipient,
        time,
        expirationTime: write.expirationTime,
        revocable: write.revocable,
        refUID: write.record.previousUID || ZERO_UID,
        data
      },
      signer,
      {
        verifyOnchain: false
      }
    );

    return {
      uid: signed.uid as `0x${string}`,
      schema: this.context.schemaUID,
      refUID: (signed.message.refUID || ZERO_UID) as `0x${string}`,
      time,
      expirationTime: write.expirationTime ?? NO_EXPIRATION,
      revocationTime: 0n,
      recipient: write.recipient,
      revocable: write.revocable,
      attester,
      data,
      revoked: false,
      mode: "offchain",
      signedOffchainAttestation: signed,
      source: "write-through-cache"
    };
  }
}
