import { Wallet } from "ethers";

import { EASStore } from "./eas-store";
import { MemoryIndexer } from "./indexers/memory";
import { MemoryStorage } from "./storage/memory";
import type {
  Address,
  EASKeyStoreConfig,
  Hex,
  IndexerAdapter,
  StorageAdapter,
  StoreSigner
} from "./types";

export const MOCK_EAS_STORE_CHAIN_ID = 31_337;
export const MOCK_EAS_STORE_ADDRESS =
  "0x0000000000000000000000000000000000000001" as const;
export const MOCK_EAS_STORE_SCHEMA_UID =
  "0x1111111111111111111111111111111111111111111111111111111111111111" as const;

export interface MockEASStoreProviderOptions {
  namespace?: string;
  schemaUID?: Hex;
  signer?: StoreSigner;
  defaultRecipient?: Address;
}

export interface MockEASStoreOptions {
  namespace?: string;
  schemaUID?: Hex;
  signer?: StoreSigner;
  defaultRecipient?: Address;
}

export interface MockEASStoreAdvancedOptions extends MockEASStoreOptions {
  mode?: "offchain";
}

export class MockEASStoreProvider {
  readonly chainId = MOCK_EAS_STORE_CHAIN_ID;
  readonly easContractAddress = MOCK_EAS_STORE_ADDRESS;

  private readonly defaultNamespace: string;
  private readonly defaultSchemaUID: Hex;
  private readonly defaultSigner: StoreSigner;
  private readonly defaultRecipient: Address | undefined;
  private storage: StorageAdapter;
  private indexer: IndexerAdapter;

  constructor(options: MockEASStoreProviderOptions = {}) {
    this.defaultNamespace = options.namespace ?? "test.eas-store";
    this.defaultSchemaUID = options.schemaUID ?? MOCK_EAS_STORE_SCHEMA_UID;
    this.defaultSigner = options.signer ?? Wallet.createRandom();
    this.defaultRecipient = options.defaultRecipient;
    this.storage = new MemoryStorage();
    this.indexer = new MemoryIndexer();
  }

  get signer(): StoreSigner {
    return this.defaultSigner;
  }

  get sharedStorage(): StorageAdapter {
    return this.storage;
  }

  get sharedIndexer(): IndexerAdapter {
    return this.indexer;
  }

  async getAddress(): Promise<Address> {
    return (await this.defaultSigner.getAddress()) as Address;
  }

  reset(): void {
    this.storage = new MemoryStorage();
    this.indexer = new MemoryIndexer();
  }

  async store(options: MockEASStoreOptions = {}): Promise<EASStore> {
    const signer = options.signer ?? this.defaultSigner;
    const defaultRecipient =
      options.defaultRecipient ?? this.defaultRecipient ?? ((await signer.getAddress()) as Address);

    return EASStore.local({
      namespace: options.namespace ?? this.defaultNamespace,
      schemaUID: options.schemaUID ?? this.defaultSchemaUID,
      signer,
      defaultRecipient,
      storage: this.storage,
      indexer: this.indexer
    });
  }

  async advancedStore(
    options: MockEASStoreAdvancedOptions = {}
  ): Promise<Awaited<ReturnType<typeof EASStore.createAdvanced>>> {
    const signer = options.signer ?? this.defaultSigner;
    const defaultRecipient =
      options.defaultRecipient ?? this.defaultRecipient ?? ((await signer.getAddress()) as Address);
    const config: EASKeyStoreConfig = {
      chainId: this.chainId,
      easContractAddress: this.easContractAddress,
      easVersion: "1.3.0",
      schemaUID: options.schemaUID ?? this.defaultSchemaUID,
      namespace: options.namespace ?? this.defaultNamespace,
      mode: options.mode ?? "offchain",
      signer,
      defaultRecipient,
      storage: this.storage,
      indexer: this.indexer
    };

    return EASStore.createAdvanced(config);
  }
}

export function createMockEASStoreProvider(
  options?: MockEASStoreProviderOptions
): MockEASStoreProvider {
  return new MockEASStoreProvider(options);
}

export async function createMockEASStore(
  options: MockEASStoreOptions = {}
): Promise<EASStore> {
  return createMockEASStoreProvider(options).store();
}
