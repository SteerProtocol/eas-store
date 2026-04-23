import { canonicalizeJson } from "./canonical-json";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encodeStoredValue(
  value: unknown,
  contentType = "application/json"
): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }

  if (typeof value === "string" && contentType.startsWith("text/")) {
    return textEncoder.encode(value);
  }

  return textEncoder.encode(canonicalizeJson(value));
}

export function decodeStoredValue<T = unknown>(
  bytes: Uint8Array,
  contentType: string
): T {
  if (contentType === "application/json") {
    return JSON.parse(textDecoder.decode(bytes)) as T;
  }

  if (contentType.startsWith("text/")) {
    return textDecoder.decode(bytes) as T;
  }

  return bytes as T;
}
