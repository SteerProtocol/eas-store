import { hashBytes } from "../crypto/hash";
import type { StorageAdapter } from "../types";

export class MemoryStorage implements StorageAdapter {
  readonly persistence = "local" as const;

  private readonly data = new Map<string, Uint8Array>();

  async put(bytes: Uint8Array, _contentType: string): Promise<string> {
    const digest = hashBytes(bytes).slice(2);
    const uri = `memory://${digest}`;
    this.data.set(uri, bytes);
    return uri;
  }

  async get(uri: string): Promise<Uint8Array> {
    const value = this.data.get(uri);

    if (!value) {
      throw new Error(`Missing storage object for URI: ${uri}`);
    }

    return value;
  }
}
