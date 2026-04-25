import type { StorageAdapter } from "../types";

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }

  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return globalThis.btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(base64, "base64"));
  }

  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

export interface InlineStorageOptions {
  maxBytes?: number;
}

export class InlineStorage implements StorageAdapter {
  readonly persistence = "inline" as const;

  private readonly maxBytes: number;

  constructor(options: InlineStorageOptions = {}) {
    this.maxBytes = options.maxBytes ?? 8_192;
  }

  async put(bytes: Uint8Array, contentType: string): Promise<string> {
    if (bytes.byteLength > this.maxBytes) {
      throw new Error(
        `Value is ${bytes.byteLength} bytes, which exceeds InlineStorage maxBytes=${this.maxBytes}. Configure a durable storage adapter for larger values.`
      );
    }

    return `data:${encodeURIComponent(contentType)};base64,${bytesToBase64(bytes)}`;
  }

  async get(uri: string): Promise<Uint8Array> {
    const match = uri.match(/^data:([^,]*);base64,(.*)$/);

    if (!match) {
      throw new Error(`Invalid inline storage URI: ${uri}`);
    }

    return base64ToBytes(match[2] ?? "");
  }
}

export function inlineStorage(options?: InlineStorageOptions): InlineStorage {
  return new InlineStorage(options);
}
