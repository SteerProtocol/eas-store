import { getBytes, hexlify, keccak256, toUtf8Bytes } from "ethers";

import { canonicalizeJson } from "../codecs/canonical-json";
import type { Hex } from "../types";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function bytesToBase64Url(bytes: Uint8Array): string {
  const base64 =
    typeof Buffer !== "undefined"
      ? Buffer.from(bytes).toString("base64")
      : globalThis.btoa(String.fromCharCode(...bytes));

  return base64.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");

  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(padded, "base64"));
  }

  return Uint8Array.from(globalThis.atob(padded), (char) => char.charCodeAt(0));
}

export function utf8ToBytes(value: string): Uint8Array {
  return textEncoder.encode(value);
}

export function bytesToUtf8(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

export function canonicalBytes(value: unknown): Uint8Array {
  return utf8ToBytes(canonicalizeJson(value));
}

export function digestJson(value: unknown): Hex {
  return keccak256(toUtf8Bytes(canonicalizeJson(value))) as Hex;
}

export function digestBytes(bytes: Uint8Array): Hex {
  return keccak256(bytes) as Hex;
}

export function hexToBytes(value: Hex): Uint8Array {
  return getBytes(value);
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function randomHex(length: number): Hex {
  return hexlify(randomBytes(length)) as Hex;
}

