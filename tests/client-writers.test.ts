import { EAS } from "@ethereum-attestation-service/eas-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as clientModule from "../src/eas/client";
import {
  createEASClient,
  createOffchainClient,
  getTransactionSigner,
  getTransport,
  hasProvider,
  hasTransactionProvider,
  requireTransactionSigner,
  requireTypedDataSigner
} from "../src/eas/client";
import { OffchainWriter } from "../src/eas/offchain-writer";
import { OnchainWriter } from "../src/eas/onchain-writer";
import { encodeStoreRecord, ZERO_UID } from "../src/eas/schema";
import { ConfigurationError } from "../src/errors";
import { StoreOperation } from "../src/types";
import { EAS_ADDRESS, SCHEMA_UID, createWalletSigner } from "./helpers";

function createTransactionSigner() {
  const wallet = createWalletSigner();

  return Object.assign(wallet, {
    sendTransaction: vi.fn(),
    estimateGas: vi.fn(),
    call: vi.fn(),
    resolveName: vi.fn()
  });
}

function createTypedDataOnlySigner() {
  return {
    getAddress: vi.fn().mockResolvedValue(EAS_ADDRESS),
    signTypedData: vi.fn()
  };
}

function createPreparedWrite() {
  return {
    key: "profile:alice",
    recipient: EAS_ADDRESS,
    expirationTime: 0n,
    revocable: true,
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
  } as const;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("client helpers and writers", () => {
  it("detects transports and required signers", async () => {
    const signer = createTransactionSigner();
    const provider = {
      estimateGas: vi.fn(),
      call: vi.fn(),
      resolveName: vi.fn()
    };
    const connectSpy = vi
      .spyOn(EAS.prototype, "connect")
      .mockImplementation(function (this: EAS) {
        return this;
      });
    const getOffchainSpy = vi
      .spyOn(EAS.prototype, "getOffchain")
      .mockResolvedValue({ fromGetOffchain: true } as never);

    expect(getTransactionSigner(signer)).toBe(signer);
    expect(getTransactionSigner(createTypedDataOnlySigner() as never)).toBeUndefined();
    expect(getTransport({ chainId: 1, easContractAddress: EAS_ADDRESS, signer })).toBe(
      signer
    );
    expect(getTransport({ chainId: 1, easContractAddress: EAS_ADDRESS, provider })).toBe(
      provider
    );
    expect(hasProvider({ chainId: 1, easContractAddress: EAS_ADDRESS, provider })).toBe(
      true
    );
    expect(hasTransactionProvider(provider)).toBe(true);
    expect(requireTypedDataSigner(signer)).toBe(signer);
    expect(requireTransactionSigner(signer)).toBe(signer);
    expect(() => requireTypedDataSigner()).toThrow(ConfigurationError);
    expect(() => requireTransactionSigner(createTypedDataOnlySigner() as never)).toThrow(
      ConfigurationError
    );

    const client = createEASClient({
      chainId: 1,
      easContractAddress: EAS_ADDRESS,
      provider
    });

    expect(client).toBeInstanceOf(EAS);
    expect(connectSpy).toHaveBeenCalledWith(provider);

    expect(
      await createOffchainClient({
        chainId: 1,
        easContractAddress: EAS_ADDRESS,
        provider
      })
    ).toEqual({ fromGetOffchain: true });
    expect(getOffchainSpy).toHaveBeenCalledOnce();

    const offchainClient = await createOffchainClient({
      chainId: 1,
      easContractAddress: EAS_ADDRESS,
      easVersion: "1.3.0"
    });

    expect(offchainClient.verifyOffchainAttestationSignature).toBeTypeOf("function");
    await expect(
      createOffchainClient({
        chainId: 1,
        easContractAddress: EAS_ADDRESS
      })
    ).rejects.toThrow("Offchain mode requires either a provider/signer");
  });

  it("writes real offchain attestations and preserves encoded payloads", async () => {
    const signer = createWalletSigner();
    const writer = new OffchainWriter({
      chainId: 8453,
      easContractAddress: EAS_ADDRESS,
      easVersion: "1.3.0",
      signer,
      schemaUID: SCHEMA_UID
    });
    const preparedWrite = createPreparedWrite();
    const result = await writer.attest(preparedWrite);
    const offchain = await createOffchainClient({
      chainId: 8453,
      easContractAddress: EAS_ADDRESS,
      easVersion: "1.3.0"
    });

    expect(result.mode).toBe("offchain");
    expect(result.revoked).toBe(false);
    expect(result.data).toBe(encodeStoreRecord(preparedWrite.record));
    expect(result.signedOffchainAttestation?.message.schema).toBe(SCHEMA_UID);
    expect(result.signedOffchainAttestation?.message.recipient).toBe(EAS_ADDRESS);
    expect(result.signedOffchainAttestation?.message.refUID).toBe(ZERO_UID);
    expect(offchain.verifyOffchainAttestationSignature(result.attester, result.signedOffchainAttestation!)).toBe(true);
  });

  it("falls back to ZERO_UID and NO_EXPIRATION in offchain envelopes", async () => {
    const signer = createWalletSigner();
    const signOffchainAttestation = vi.fn().mockResolvedValue({
        uid: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        message: {
          schema: SCHEMA_UID,
          recipient: EAS_ADDRESS,
          time: 10n,
          expirationTime: 0n,
          revocable: true,
          data: "0x1234"
        },
        signature: "0x11",
        signer: await signer.getAddress(),
        domain: {} as never,
        types: {} as never
      } as never);
    const createOffchainClientSpy = vi
      .spyOn(clientModule, "createOffchainClient")
      .mockResolvedValue({
        signOffchainAttestation
      } as never);
    const writer = new OffchainWriter({
      chainId: 8453,
      easContractAddress: EAS_ADDRESS,
      easVersion: "1.3.0",
      signer,
      schemaUID: SCHEMA_UID
    });
    const preparedWrite = {
      ...createPreparedWrite(),
      expirationTime: undefined,
      record: {
        ...createPreparedWrite().record,
        previousUID: "" as `0x${string}`
      }
    } as never;
    const result = await writer.attest(preparedWrite);

    expect(createOffchainClientSpy).toHaveBeenCalled();
    expect(signOffchainAttestation).toHaveBeenCalledWith(
      expect.objectContaining({
        refUID: ZERO_UID
      }),
      signer,
      {
        verifyOnchain: false
      }
    );
    expect(result.refUID).toBe(ZERO_UID);
    expect(result.expirationTime).toBe(0n);
  });

  it("writes onchain attestations with the expected request payload", async () => {
    const signer = createTransactionSigner();
    const connectSpy = vi
      .spyOn(EAS.prototype, "connect")
      .mockImplementation(function (this: EAS) {
        return this;
      });
    const attestSpy = vi.spyOn(EAS.prototype, "attest").mockResolvedValue({
      wait: vi
        .fn()
        .mockResolvedValue(
          "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        )
    } as never);
    const getAttestationSpy = vi.spyOn(EAS.prototype, "getAttestation").mockResolvedValue({
      uid: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      schema: SCHEMA_UID,
      refUID: ZERO_UID,
      time: 10n,
      expirationTime: 0n,
      revocationTime: 0n,
      recipient: EAS_ADDRESS,
      revocable: true,
      attester: EAS_ADDRESS,
      data: "0xbeef"
    } as never);
    const writer = new OnchainWriter({
      chainId: 8453,
      easContractAddress: EAS_ADDRESS,
      signer,
      schemaUID: SCHEMA_UID
    });
    const preparedWrite = createPreparedWrite();
    const result = await writer.attest(preparedWrite);

    expect(connectSpy).toHaveBeenCalledWith(signer);
    expect(attestSpy).toHaveBeenCalledWith({
      schema: SCHEMA_UID,
      data: {
        recipient: EAS_ADDRESS,
        expirationTime: 0n,
        revocable: true,
        refUID: ZERO_UID,
        data: encodeStoreRecord(preparedWrite.record)
      }
    });
    expect(getAttestationSpy).toHaveBeenCalledWith(
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );
    expect(result.mode).toBe("onchain");
  });

  it("uses the SDK expiration fallback for onchain attestation reads", async () => {
    const signer = createTransactionSigner();
    vi.spyOn(EAS.prototype, "connect").mockImplementation(function (this: EAS) {
      return this;
    });
    vi.spyOn(EAS.prototype, "attest").mockResolvedValue({
      wait: vi
        .fn()
        .mockResolvedValue(
          "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        )
    } as never);
    vi.spyOn(EAS.prototype, "getAttestation").mockResolvedValue({
      uid: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      schema: SCHEMA_UID,
      refUID: ZERO_UID,
      time: 10n,
      expirationTime: undefined,
      revocationTime: 1n,
      recipient: EAS_ADDRESS,
      revocable: true,
      attester: EAS_ADDRESS,
      data: "0xbeef"
    } as never);
    const writer = new OnchainWriter({
      chainId: 8453,
      easContractAddress: EAS_ADDRESS,
      signer,
      schemaUID: SCHEMA_UID
    });
    const result = await writer.attest(createPreparedWrite());

    expect(result.expirationTime).toBe(0n);
    expect(result.revoked).toBe(true);
  });
});
