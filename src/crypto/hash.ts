import { keccak256, toUtf8Bytes } from "ethers";

import type { Hex } from "../types";

export function hashBytes(bytes: Uint8Array): Hex {
  return keccak256(bytes) as Hex;
}

export function hashText(value: string): Hex {
  return keccak256(toUtf8Bytes(value)) as Hex;
}
