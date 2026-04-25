import { SchemaRegistry } from "@ethereum-attestation-service/eas-sdk";
import { ZeroAddress } from "ethers";

import {
  ensureSchema,
  type EnsuredSchema,
  type SchemaRegistryRuntimeConfig
} from "../eas/schema-registry";
import type { Address, Hex } from "../types";

export const PRIVATE_KEY_REGISTRY_SCHEMA =
  "address wallet,bytes32 keyId,string algorithm,string publicKey,uint64 keyVersion,uint64 createdAt,uint64 expiresAt,bytes metadata";

export const PRIVATE_VALUE_SCHEMA =
  "bytes32 namespace,bytes32 key,bytes32 ciphertextHash,string ciphertextURI,bytes32 envelopeHash,string envelopeURI,string algorithm,uint64 version,uint8 operation,bytes32 previousUID,bytes extra";

export const PRIVATE_ACCESS_EVENT_SCHEMA =
  "bytes32 namespace,bytes32 key,bytes32 recordUID,address reader,bytes32 readerKeyId,uint8 eventType,string wrappedKeyURI,bytes32 wrappedKeyHash,uint64 createdAt,bytes extra";

export function uidForPrivateSchema(input: {
  schema: string;
  resolverAddress?: Address;
  revocable?: boolean;
}): Hex {
  return SchemaRegistry.getSchemaUID(
    input.schema,
    input.resolverAddress ?? ZeroAddress,
    input.revocable ?? true
  ) as Hex;
}

export function uidForKeyRegistry(options: {
  resolverAddress?: Address;
  revocable?: boolean;
} = {}): Hex {
  return uidForPrivateSchema({
    schema: PRIVATE_KEY_REGISTRY_SCHEMA,
    ...options
  });
}

export function uidForPrivateValue(options: {
  resolverAddress?: Address;
  revocable?: boolean;
} = {}): Hex {
  return uidForPrivateSchema({
    schema: PRIVATE_VALUE_SCHEMA,
    ...options
  });
}

export function uidForAccessEvent(options: {
  resolverAddress?: Address;
  revocable?: boolean;
} = {}): Hex {
  return uidForPrivateSchema({
    schema: PRIVATE_ACCESS_EVENT_SCHEMA,
    ...options
  });
}

export async function ensureAllPrivateSchemas(
  config: SchemaRegistryRuntimeConfig,
  options: {
    resolverAddress?: Address;
    revocable?: boolean;
  } = {}
): Promise<{
  keyRegistry: EnsuredSchema;
  privateValue: EnsuredSchema;
  accessEvent: EnsuredSchema;
}> {
  const resolverAddress = options.resolverAddress ?? (ZeroAddress as Address);
  const revocable = options.revocable ?? true;

  const [keyRegistry, privateValue, accessEvent] = await Promise.all([
    ensureSchema(config, {
      schema: PRIVATE_KEY_REGISTRY_SCHEMA,
      resolverAddress,
      revocable
    }),
    ensureSchema(config, {
      schema: PRIVATE_VALUE_SCHEMA,
      resolverAddress,
      revocable
    }),
    ensureSchema(config, {
      schema: PRIVATE_ACCESS_EVENT_SCHEMA,
      resolverAddress,
      revocable
    })
  ]);

  return {
    keyRegistry,
    privateValue,
    accessEvent
  };
}
