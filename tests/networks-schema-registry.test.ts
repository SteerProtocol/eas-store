import { SchemaRegistry } from "@ethereum-attestation-service/eas-sdk";
import { ZeroAddress } from "ethers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as clientModule from "../src/eas/client";
import {
  ensureSchema,
  getEASNetworkPreset,
  getEASNetworkPresetByKey,
  registerSchema,
  resolveSchemaRegistryAddress
} from "../src";
import { ConfigurationError } from "../src/errors";
import { createWalletSigner } from "./helpers";

const BASE_EAS_ADDRESS = "0x4200000000000000000000000000000000000021" as const;
const BASE_SCHEMA_REGISTRY_ADDRESS =
  "0x4200000000000000000000000000000000000020" as const;

function createTransactionSigner() {
  const wallet = createWalletSigner();

  return Object.assign(wallet, {
    sendTransaction: vi.fn(),
    estimateGas: vi.fn(),
    call: vi.fn(),
    resolveName: vi.fn()
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("network presets and schema registry helpers", () => {
  it("exposes known Base presets", () => {
    expect(getEASNetworkPreset(8453)).toMatchObject({
      key: "base",
      easContractAddress: BASE_EAS_ADDRESS,
      schemaRegistryAddress: BASE_SCHEMA_REGISTRY_ADDRESS
    });
    expect(getEASNetworkPresetByKey("base-sepolia")).toMatchObject({
      chainId: 84532,
      easContractAddress: BASE_EAS_ADDRESS,
      schemaRegistryAddress: BASE_SCHEMA_REGISTRY_ADDRESS
    });
  });

  it("registers schemas with the SDK schema registry on known networks", async () => {
    const signer = createTransactionSigner();
    const connectSpy = vi
      .spyOn(SchemaRegistry.prototype, "connect")
      .mockImplementation(function (this: SchemaRegistry) {
        return this;
      });
    const registerSpy = vi.spyOn(SchemaRegistry.prototype, "register").mockResolvedValue({
      wait: vi
        .fn()
        .mockResolvedValue(
          "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        )
    } as never);

    const result = await registerSchema(
      {
        chainId: 84532,
        easContractAddress: BASE_EAS_ADDRESS,
        signer
      },
      {
        schema: "string key,string value"
      }
    );

    expect(connectSpy).toHaveBeenCalledWith(signer);
    expect(registerSpy).toHaveBeenCalledWith({
      schema: "string key,string value",
      resolverAddress: ZeroAddress,
      revocable: true
    });
    expect(result).toMatchObject({
      uid: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      chainId: 84532,
      schemaRegistryAddress: BASE_SCHEMA_REGISTRY_ADDRESS,
      resolverAddress: ZeroAddress,
      revocable: true
    });
  });

  it("resolves schema registry from the EAS contract for custom networks", async () => {
    const getSchemaRegistry = vi
      .fn()
      .mockResolvedValue("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    vi.spyOn(clientModule, "createEASClient").mockReturnValue({
      contract: {
        getSchemaRegistry
      }
    } as never);

    const resolved = await resolveSchemaRegistryAddress({
      chainId: 99_999,
      easContractAddress: BASE_EAS_ADDRESS,
      provider: {
        estimateGas: vi.fn(),
        call: vi.fn(),
        resolveName: vi.fn()
      }
    });

    expect(getSchemaRegistry).toHaveBeenCalledOnce();
    expect(resolved).toBe("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  });

  it("fails for custom schema registration without a way to resolve the registry", async () => {
    await expect(
      resolveSchemaRegistryAddress({
        chainId: 99_999,
        easContractAddress: BASE_EAS_ADDRESS
      })
    ).rejects.toThrow(ConfigurationError);
  });

  it("reuses an existing schema instead of attempting to register it again", async () => {
    const signer = createTransactionSigner();
    vi.spyOn(SchemaRegistry.prototype, "connect").mockImplementation(function (
      this: SchemaRegistry
    ) {
      return this;
    });
    const getSchemaSpy = vi.spyOn(SchemaRegistry.prototype, "getSchema").mockResolvedValue({
      uid: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      schema: "string key,string value",
      resolver: ZeroAddress,
      revocable: true
    } as never);
    const registerSpy = vi.spyOn(SchemaRegistry.prototype, "register");

    const result = await ensureSchema(
      {
        chainId: 84532,
        easContractAddress: BASE_EAS_ADDRESS,
        signer
      },
      {
        schema: "string key,string value"
      }
    );

    expect(getSchemaSpy).toHaveBeenCalledOnce();
    expect(registerSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      created: false,
      schema: "string key,string value",
      resolverAddress: ZeroAddress,
      revocable: true
    });
  });
});
