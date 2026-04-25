import { ConfigurationError } from "../errors";
import type { Address } from "../types";
import type { EncryptedKeyBackup, KeyBackupStorage } from "./types";

type IDBDatabaseLike = {
  close(): void;
  createObjectStore(name: string, options?: { keyPath?: string }): void;
  objectStoreNames: {
    contains(name: string): boolean;
  };
  transaction(name: string, mode?: "readonly" | "readwrite"): {
    objectStore(name: string): {
      put(value: unknown): IDBRequestLike;
      get(key: string): IDBRequestLike;
    };
  };
};

type IDBRequestLike = {
  result: unknown;
  error: unknown;
  onsuccess: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
};

type IDBOpenRequestLike = IDBRequestLike & {
  onupgradeneeded: ((event: { target: { result: IDBDatabaseLike } }) => void) | null;
};

type IndexedDBFactoryLike = {
  open(name: string, version: number): IDBOpenRequestLike;
};

const STORE_NAME = "keyBackups";

function indexedDBFactory(): IndexedDBFactoryLike {
  const factory = (globalThis as typeof globalThis & {
    indexedDB?: IndexedDBFactoryLike;
  }).indexedDB;

  if (!factory) {
    throw new ConfigurationError("IndexedDB backup storage requires browser indexedDB support.");
  }

  return factory;
}

function normalizeAddress(address: string): Address {
  return address.toLowerCase() as Address;
}

function backupKey(wallet: Address, dappId: string): string {
  return `${normalizeAddress(wallet)}:${dappId}`;
}

function requestResult<T>(request: IDBRequestLike): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error);
  });
}

export class IndexedDBKeyBackupStorage implements KeyBackupStorage {
  constructor(
    private readonly options: {
      dbName?: string;
    } = {}
  ) {}

  async put(backup: EncryptedKeyBackup): Promise<void> {
    const db = await this.open();

    try {
      await requestResult<void>(
        db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put({
          ...backup,
          id: backupKey(backup.wallet, backup.dappId)
        })
      );
    } finally {
      db.close();
    }
  }

  async get(wallet: Address, dappId: string): Promise<EncryptedKeyBackup | null> {
    const db = await this.open();

    try {
      const stored = await requestResult<(EncryptedKeyBackup & { id: string }) | undefined>(
        db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(
          backupKey(wallet, dappId)
        )
      );

      if (!stored) {
        return null;
      }

      const { id: _id, ...backup } = stored;
      return backup;
    } finally {
      db.close();
    }
  }

  private open(): Promise<IDBDatabaseLike> {
    return new Promise((resolve, reject) => {
      const request = indexedDBFactory().open(this.options.dbName ?? "eas-store", 1);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, {
            keyPath: "id"
          });
        }
      };
      request.onsuccess = () => resolve(request.result as IDBDatabaseLike);
      request.onerror = () => reject(request.error);
    });
  }
}
