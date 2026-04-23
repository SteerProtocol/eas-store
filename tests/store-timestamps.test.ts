import { EAS } from "@ethereum-attestation-service/eas-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EASKeyStore, MemoryIndexer, MemoryStorage } from "../src";
import { EAS_ADDRESS, SCHEMA_UID, createWalletSigner } from "./helpers";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("EASKeyStore timestamp helpers", () => {
  it("calls single and batch timestamp methods through the SDK client", async () => {
    const signer = createWalletSigner();
    const connectSpy = vi
      .spyOn(EAS.prototype, "connect")
      .mockImplementation(function (this: EAS) {
        return this;
      });
    const timestampSpy = vi.spyOn(EAS.prototype, "timestamp").mockResolvedValue({
      wait: vi.fn().mockResolvedValue(123n)
    } as never);
    const multiTimestampSpy = vi
      .spyOn(EAS.prototype, "multiTimestamp")
      .mockResolvedValue({
        wait: vi.fn().mockResolvedValue([123n, 456n])
      } as never);

    const store = await EASKeyStore.create({
      chainId: 8453,
      easContractAddress: EAS_ADDRESS,
      easVersion: "1.3.0",
      schemaUID: SCHEMA_UID,
      namespace: "test.profile",
      signer,
      storage: new MemoryStorage(),
      indexer: new MemoryIndexer()
    });

    await expect(
      store.timestamp(
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      )
    ).resolves.toBe(123n);
    await expect(
      store.batchTimestamp([
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      ])
    ).resolves.toEqual([123n, 456n]);
    expect(connectSpy).toHaveBeenCalled();
    expect(timestampSpy).toHaveBeenCalledWith(
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );
    expect(multiTimestampSpy).toHaveBeenCalledWith([
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    ]);
  });

  it("requires a signer for timestamp calls", async () => {
    const store = await EASKeyStore.create({
      chainId: 8453,
      easContractAddress: EAS_ADDRESS,
      easVersion: "1.3.0",
      schemaUID: SCHEMA_UID,
      namespace: "test.profile",
      storage: new MemoryStorage(),
      indexer: new MemoryIndexer(),
      defaultRecipient: EAS_ADDRESS
    });

    await expect(
      store.timestamp(
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      )
    ).rejects.toThrow("timestamp() requires a signer");
    await expect(
      store.batchTimestamp([
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      ])
    ).rejects.toThrow("batchTimestamp() requires a signer");
  });
});
