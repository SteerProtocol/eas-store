import { SchemaRegistry } from "@ethereum-attestation-service/eas-sdk";
import { ZeroAddress } from "ethers";

import { createEASClient, getTransport, requireTransactionSigner } from "./client";
import { getEASNetworkPreset } from "./networks";
import { STORE_SCHEMA } from "./schema";
import { ConfigurationError } from "../errors";
import type { Address, EASRuntimeConfig, Hex } from "../types";

export interface SchemaRegistryRuntimeConfig extends EASRuntimeConfig {
  schemaRegistryAddress?: Address;
}

export interface RegisterSchemaOptions {
  schema: string;
  resolverAddress?: Address;
  revocable?: boolean;
}

export interface RegisteredSchema {
  uid: Hex;
  schema: string;
  resolverAddress: Address;
  revocable: boolean;
  chainId: number;
  schemaRegistryAddress: Address;
}

export interface EnsuredSchema extends RegisteredSchema {
  created: boolean;
}

export interface SchemaStatus extends RegisteredSchema {
  exists: boolean;
}

export async function resolveSchemaRegistryAddress(
  config: SchemaRegistryRuntimeConfig
): Promise<Address> {
  if (config.schemaRegistryAddress) {
    return config.schemaRegistryAddress;
  }

  const preset = getEASNetworkPreset(config.chainId);

  if (preset) {
    return preset.schemaRegistryAddress;
  }

  if (!config.easContractAddress) {
    throw new ConfigurationError(
      "Schema registration requires either schemaRegistryAddress or a known chain EAS contract."
    );
  }

  if (!getTransport(config)) {
    throw new ConfigurationError(
      "Schema registration requires a provider or signer to resolve the schema registry for custom networks."
    );
  }

  const eas = createEASClient(config);
  const schemaRegistryAddress = await eas.contract.getSchemaRegistry();

  return schemaRegistryAddress as Address;
}

export async function registerSchema(
  config: SchemaRegistryRuntimeConfig,
  options: RegisterSchemaOptions
): Promise<RegisteredSchema> {
  const signer = requireTransactionSigner(config.signer);
  const schemaRegistryAddress = await resolveSchemaRegistryAddress(config);
  const registry = new SchemaRegistry(schemaRegistryAddress);
  registry.connect(signer);

  const resolverAddress = (options.resolverAddress ?? ZeroAddress) as Address;
  const revocable = options.revocable ?? true;
  const tx = await registry.register({
    schema: options.schema,
    resolverAddress,
    revocable
  });
  const uid = (await tx.wait()) as Hex;

  return {
    uid,
    schema: options.schema,
    resolverAddress,
    revocable,
    chainId: config.chainId,
    schemaRegistryAddress
  };
}

export async function ensureSchema(
  config: SchemaRegistryRuntimeConfig,
  options: RegisterSchemaOptions
): Promise<EnsuredSchema> {
  const signer = requireTransactionSigner(config.signer);
  const schemaRegistryAddress = await resolveSchemaRegistryAddress(config);
  const registry = new SchemaRegistry(schemaRegistryAddress);
  registry.connect(signer);

  const resolverAddress = (options.resolverAddress ?? ZeroAddress) as Address;
  const revocable = options.revocable ?? true;
  const uid = SchemaRegistry.getSchemaUID(
    options.schema,
    resolverAddress,
    revocable
  ) as Hex;

  try {
    const existing = await registry.getSchema({ uid });

    return {
      uid,
      schema: existing.schema,
      resolverAddress: existing.resolver as Address,
      revocable: existing.revocable,
      chainId: config.chainId,
      schemaRegistryAddress,
      created: false
    };
  } catch {
    const created = await registerSchema(config, options);

    return {
      ...created,
      created: true
    };
  }
}

export function getDefaultStoreSchemaUID(options: {
  resolverAddress?: Address;
  revocable?: boolean;
} = {}): Hex {
  return SchemaRegistry.getSchemaUID(
    STORE_SCHEMA,
    options.resolverAddress ?? ZeroAddress,
    options.revocable ?? true
  ) as Hex;
}

export async function ensureDefaultStoreSchema(
  config: SchemaRegistryRuntimeConfig,
  options: Omit<RegisterSchemaOptions, "schema"> = {}
): Promise<EnsuredSchema> {
  return ensureSchema(config, {
    ...options,
    schema: STORE_SCHEMA
  });
}

export async function getRegisteredSchema(
  config: SchemaRegistryRuntimeConfig,
  uid: Hex
): Promise<SchemaStatus> {
  const schemaRegistryAddress = await resolveSchemaRegistryAddress(config);
  const registry = new SchemaRegistry(schemaRegistryAddress);
  const transport = getTransport(config);

  if (transport) {
    registry.connect(transport);
  }

  const schema = await registry.getSchema({ uid });

  return {
    uid,
    schema: schema.schema,
    resolverAddress: schema.resolver as Address,
    revocable: schema.revocable,
    chainId: config.chainId,
    schemaRegistryAddress,
    exists: true
  };
}

export async function schemaExists(
  config: SchemaRegistryRuntimeConfig,
  uid: Hex
): Promise<boolean> {
  try {
    await getRegisteredSchema(config, uid);
    return true;
  } catch {
    return false;
  }
}
