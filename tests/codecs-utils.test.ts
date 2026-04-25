import { describe, expect, it } from "vitest";

import {
  canonicalizeJson,
  inlineStorage,
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

  it("stores small values inline and rejects oversized values", async () => {
    const storage = inlineStorage({
      maxBytes: 4
    });
    const bytes = new Uint8Array([1, 2, 3]);
    const uri = await storage.put(bytes, "application/octet-stream");

    expect(uri).toMatch(/^data:application%2Foctet-stream;base64,/);
    expect(await storage.get(uri)).toEqual(bytes);
    await expect(storage.put(new Uint8Array([1, 2, 3, 4, 5]), "bytes")).rejects.toThrow(
      "exceeds InlineStorage"
    );
    await expect(storage.get("memory://not-inline")).rejects.toThrow(
      "Invalid inline storage URI"
    );
  });

  it("supports inline storage in browser-like runtimes without Buffer", async () => {
    const originalBuffer = globalThis.Buffer;
    const originalBtoa = globalThis.btoa;
    const originalAtob = globalThis.atob;
    const global = globalThis as typeof globalThis & {
      btoa: (value: string) => string;
      atob: (value: string) => string;
    };

    Reflect.set(globalThis, "Buffer", undefined);
    global.btoa = (value: string) => originalBuffer.from(value, "binary").toString("base64");
    global.atob = (value: string) => originalBuffer.from(value, "base64").toString("binary");

    try {
      const storage = inlineStorage();
      const bytes = new Uint8Array([7, 8, 9]);
      const uri = await storage.put(bytes, "application/octet-stream");

      expect(await storage.get(uri)).toEqual(bytes);
    } finally {
      Reflect.set(globalThis, "Buffer", originalBuffer);
      global.btoa = originalBtoa;
      global.atob = originalAtob;
    }
  });
});
