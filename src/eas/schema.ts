import { SchemaEncoder } from "@ethereum-attestation-service/eas-sdk";
import { AbiCoder } from "ethers";

import { StoreOperation, type EncodedStoreRecord, type Hex } from "../types";

export const ZERO_UID =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;

export const STORE_SCHEMA =
  "bytes32 namespace,bytes32 key,bytes32 valueHash,string valueURI,string contentType,uint64 version,uint8 operation,bytes32 previousUID,bytes extra";

const encoder = new SchemaEncoder(STORE_SCHEMA);
const abiCoder = AbiCoder.defaultAbiCoder();

export interface StoreRecordExtra {
  key?: string;
  metadata: Hex;
}

function getDecodedValue<T = unknown>(
  items: ReturnType<SchemaEncoder["decodeData"]>,
  name: string
): T {
  const item = items.find((candidate) => candidate.name === name);

  if (!item) {
    throw new Error(`Missing schema field: ${name}`);
  }

  return item.value.value as T;
}

export function encodeStoreRecord(record: EncodedStoreRecord): Hex {
  return encoder.encodeData([
    {
      name: "namespace",
      type: "bytes32",
      value: record.namespaceHash
    },
    {
      name: "key",
      type: "bytes32",
      value: record.keyHash
    },
    {
      name: "valueHash",
      type: "bytes32",
      value: record.valueHash
    },
    {
      name: "valueURI",
      type: "string",
      value: record.valueURI
    },
    {
      name: "contentType",
      type: "string",
      value: record.contentType
    },
    {
      name: "version",
      type: "uint64",
      value: record.version
    },
    {
      name: "operation",
      type: "uint8",
      value: record.operation
    },
    {
      name: "previousUID",
      type: "bytes32",
      value: record.previousUID
    },
    {
      name: "extra",
      type: "bytes",
      value: record.extra
    }
  ]) as Hex;
}

export function decodeStoreRecord(data: Hex): EncodedStoreRecord {
  const decoded = encoder.decodeData(data);

  return {
    namespaceHash: getDecodedValue<Hex>(decoded, "namespace"),
    keyHash: getDecodedValue<Hex>(decoded, "key"),
    valueHash: getDecodedValue<Hex>(decoded, "valueHash"),
    valueURI: getDecodedValue<string>(decoded, "valueURI"),
    contentType: getDecodedValue<string>(decoded, "contentType"),
    version: getDecodedValue<bigint>(decoded, "version"),
    operation: Number(getDecodedValue<bigint>(decoded, "operation")) as StoreOperation,
    previousUID: getDecodedValue<Hex>(decoded, "previousUID"),
    extra: getDecodedValue<Hex>(decoded, "extra")
  };
}

export function encodeRecordExtra(input: {
  key: string;
  metadata?: Hex;
}): Hex {
  return abiCoder.encode(
    ["uint8", "string", "bytes"],
    [1, input.key, input.metadata ?? "0x"]
  ) as Hex;
}

export function decodeRecordExtra(extra: Hex): StoreRecordExtra {
  if (extra === "0x") {
    return { metadata: "0x" };
  }

  try {
    const [version, key, metadata] = abiCoder.decode(
      ["uint8", "string", "bytes"],
      extra
    ) as unknown as [bigint, string, Hex];

    if (version === 1n) {
      return {
        key,
        metadata
      };
    }
  } catch {
    return { metadata: extra };
  }

  return { metadata: extra };
}
