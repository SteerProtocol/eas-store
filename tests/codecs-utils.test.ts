import { describe, expect, it } from "vitest";

import {
  canonicalizeJson,
  MemoryStorage
} from "../src";
import { decodeStoredValue, encodeStoredValue } from "../src/codecs/json";
import { hashBytes, hashText } from "../src/crypto/hash";
import { isTrustedAttester, sameAddress } from "../src/policies/trusted-attesters";

describe("codecs and utilities", () => {
  it("canonicalizes nested JSON values", () => {
    expect(
      canonicalizeJson({
        zebra: 1,
        alpha: {
          second: true,
          first: true
        },
        omit: undefined
      })
    ).toBe('{"alpha":{"first":true,"second":true},"zebra":1}');
  });

  it("canonicalizes arrays recursively", () => {
    expect(
      canonicalizeJson([
        {
          b: 2,
          a: 1
        }
      ])
    ).toBe('[{"a":1,"b":2}]');
  });

  it("encodes and decodes JSON payloads", () => {
    const encoded = encodeStoredValue({
      b: 2,
      a: 1
    });

    expect(decodeStoredValue(encoded, "application/json")).toEqual({
      a: 1,
      b: 2
    });
  });

  it("encodes and decodes text payloads", () => {
    const encoded = encodeStoredValue("hello", "text/plain");
    expect(decodeStoredValue(encoded, "text/plain")).toBe("hello");
  });

  it("passes binary payloads through unchanged", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(encodeStoredValue(bytes)).toBe(bytes);
    expect(decodeStoredValue(bytes, "application/octet-stream")).toBe(bytes);
  });

  it("hashes text and bytes deterministically", () => {
    expect(hashText("alpha")).toMatch(/^0x[0-9a-f]{64}$/);
    expect(hashBytes(new Uint8Array([1, 2, 3]))).toMatch(/^0x[0-9a-f]{64}$/);
    expect(hashText("alpha")).not.toBe(hashText("beta"));
  });

  it("compares addresses case-insensitively", () => {
    const address = "0xAbCd000000000000000000000000000000000000";
    expect(sameAddress(address, address.toLowerCase())).toBe(true);
    expect(
      isTrustedAttester(address, [address.toLowerCase() as `0x${string}`])
    ).toBe(true);
    expect(
      isTrustedAttester(address, [
        "0x0000000000000000000000000000000000000009"
      ] as Array<`0x${string}`>)
    ).toBe(false);
    expect(isTrustedAttester(address)).toBe(true);
  });

  it("stores values in memory storage", async () => {
    const storage = new MemoryStorage();
    const bytes = new Uint8Array([4, 5, 6]);
    const uri = await storage.put(bytes, "application/octet-stream");

    expect(uri.startsWith("memory://")).toBe(true);
    expect(await storage.get(uri)).toEqual(bytes);
    await expect(storage.get("memory://missing")).rejects.toThrow(
      "Missing storage object"
    );
  });
});
