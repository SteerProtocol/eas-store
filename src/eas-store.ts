import { Wallet } from "ethers";

import { EASScanIndexer } from "./indexers/easscan";
import { MemoryIndexer } from "./indexers/memory";
import { EASKeyStore } from "./store";
import {
  ensureDefaultStoreSchema,
  getDefaultStoreSchemaUID,
  getRegisteredSchema,
  schemaExists,
  type EnsuredSchema,
  type SchemaRegistryRuntimeConfig,
  type SchemaStatus
} from "./eas/schema-registry";
import {
  getEASNetworkPreset,
  getEASNetworkPresetByKey,
  type EASNetworkPreset
} from "./eas/networks";
import { InlineStorage } from "./storage/inline";
import { MemoryStorage } from "./storage/memory";
import { ConfigurationError } from "./errors";
import { EASPrivateStore } from "./private/store";
import {
  ensureAllPrivateSchemas,
  uidForAccessEvent,
  uidForKeyRegistry,
  uidForPrivateValue
} from "./private/schemas";
import type {
  EncryptionKeyRegistry,
  KeyBackupProvider,
  PrivateCryptoProvider
} from "./private/types";
import type {
  Address,
  EASKeyStoreConfig,
  Hex,
  IndexerAdapter,
  QueryFilter,
  SetOptions,
  StorageAdapter,
  StoreMode,
  StoreSigner,
  StoredRecord,
  VerificationPolicy
} from "./types";

export type EASStoreNetwork =
  | EASNetworkPreset["key"]
  | number
  | EASNetworkPreset
  | {
      chainId: number;
      easContractAddress: Address;
      easVersion?: string;
      schemaRegistryAddress?: Address;
      graphqlEndpoint?: string;
    };

export interface EASStoreBaseOptions {
  namespace: string;
  schemaUID: Hex;
  network?: EASStoreNetwork;
  signer?: StoreSigner;
  provider?: EASKeyStoreConfig["provider"];
  storage?: StorageAdapter;
  indexer?: IndexerAdapter;
  trustedAttesters?: Address[];
  verification?: Partial<
    Omit<VerificationPolicy, "schemaUID" | "namespaceHash" | "trustedAttesters">
  >;
  defaultRecipient?: Address;
}

export interface EASStoreOnchainOptions extends EASStoreBaseOptions {
  signer: StoreSigner;
}

export interface EASStoreOffchainOptions extends EASStoreBaseOptions {
  signer: StoreSigner;
}

export type EASStorePrivateMode = "onchain" | "offchain" | "local";

export interface EASStoreLocalOptions {
  namespace: string;
  signer?: StoreSigner;
  schemaUID?: Hex;
  storage?: StorageAdapter;
  indexer?: IndexerAdapter;
  defaultRecipient?: Address;
}

export interface EASStorePrivateOptions extends EASStoreOffchainOptions {
  mode?: EASStorePrivateMode;
  dappId?: string;
  /**
   * Reserved for dedicated key-registry schema support. Passing it before the
   * dedicated registry writer is wired would make deployments look safer than
   * they are, so EASStore.private rejects it for now.
   */
  keyRegistrySchemaUID?: Hex;
  crypto?: PrivateCryptoProvider;
  backup?: KeyBackupProvider;
  registry?: EncryptionKeyRegistry;
  store?: EASStore;
}

export interface WriteReceipt {
  key: string;
  uid: Hex;
  version: number;
  operation: "set" | "delete";
  schemaUID: Hex;
  txHash?: Hex;
}

type ResolvedNetwork = {
  chainId: number;
  easContractAddress: Address;
  easVersion?: string;
  schemaRegistryAddress?: Address;
  graphqlEndpoint?: string;
};

function resolveNetwork(network: EASStoreNetwork = "base-sepolia"): ResolvedNetwork {
  if (typeof network === "string") {
    const preset = getEASNetworkPresetByKey(network);

    if (!preset) {
      throw new ConfigurationError(`Unknown EAS network preset: ${network}`);
    }

    return preset;
  }

  if (typeof network === "number") {
    const preset = getEASNetworkPreset(network);

    if (!preset) {
      throw new ConfigurationError(
        `No EAS network preset exists for chain ${network}. Pass a custom network object with easContractAddress.`
      );
    }

    return preset;
  }

  return network;
}

function toCoreConfig(
  options: EASStoreBaseOptions,
  mode: StoreMode,
  defaults: {
    storage: StorageAdapter;
    indexer: IndexerAdapter;
  }
): EASKeyStoreConfig {
  const network = resolveNetwork(options.network);

  return {
    chainId: network.chainId,
    easContractAddress: network.easContractAddress,
    ...(network.easVersion ? { easVersion: network.easVersion } : {}),
    schemaUID: options.schemaUID,
    namespace: options.namespace,
    mode,
    storage: options.storage ?? defaults.storage,
    indexer: options.indexer ?? defaults.indexer,
    ...(options.signer ? { signer: options.signer } : {}),
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.trustedAttesters ? { trustedAttesters: options.trustedAttesters } : {}),
    ...(options.verification ? { verification: options.verification } : {}),
    ...(options.defaultRecipient ? { defaultRecipient: options.defaultRecipient } : {})
  };
}

function toReceipt(record: StoredRecord): WriteReceipt {
  return {
    key: record.key,
    uid: record.uid,
    version: record.version,
    operation: record.operation === 2 ? "delete" : "set",
    schemaUID: record.schemaUID
  };
}

function schemaRuntimeConfig(input: {
  network?: EASStoreNetwork;
  signer?: StoreSigner;
  provider?: EASKeyStoreConfig["provider"];
}): SchemaRegistryRuntimeConfig {
  const network = resolveNetwork(input.network);

  return {
    chainId: network.chainId,
    easContractAddress: network.easContractAddress,
    ...(network.easVersion ? { easVersion: network.easVersion } : {}),
    ...(network.schemaRegistryAddress
      ? { schemaRegistryAddress: network.schemaRegistryAddress }
      : {}),
    ...(input.signer ? { signer: input.signer } : {}),
    ...(input.provider ? { provider: input.provider } : {})
  };
}

export class EASStore {
  static readonly schema = {
    uidForDefault(options?: {
      resolverAddress?: Address;
      revocable?: boolean;
    }): Hex {
      return getDefaultStoreSchemaUID(options);
    },

    ensureDefault(options: {
      network?: EASStoreNetwork;
      signer: StoreSigner;
      resolverAddress?: Address;
      revocable?: boolean;
    }): Promise<EnsuredSchema> {
      return ensureDefaultStoreSchema(schemaRuntimeConfig(options), {
        ...(options.resolverAddress
          ? { resolverAddress: options.resolverAddress }
          : {}),
        ...(typeof options.revocable === "boolean"
          ? { revocable: options.revocable }
          : {})
      });
    },

    get(options: {
      network?: EASStoreNetwork;
      uid: Hex;
      signer?: StoreSigner;
      provider?: EASKeyStoreConfig["provider"];
    }): Promise<SchemaStatus> {
      return getRegisteredSchema(schemaRuntimeConfig(options), options.uid);
    },

    exists(options: {
      network?: EASStoreNetwork;
      uid: Hex;
      signer?: StoreSigner;
      provider?: EASKeyStoreConfig["provider"];
    }): Promise<boolean> {
      return schemaExists(schemaRuntimeConfig(options), options.uid);
    }
  };

  static readonly privateSchema = {
    uidForKeyRegistry: uidForKeyRegistry,
    uidForPrivateValue: uidForPrivateValue,
    uidForAccessEvent: uidForAccessEvent,
    ensureAll(options: {
      network?: EASStoreNetwork;
      signer: StoreSigner;
      resolverAddress?: Address;
      revocable?: boolean;
    }) {
      return ensureAllPrivateSchemas(schemaRuntimeConfig(options), {
        ...(options.resolverAddress
          ? { resolverAddress: options.resolverAddress }
          : {}),
        ...(typeof options.revocable === "boolean"
          ? { revocable: options.revocable }
          : {})
      });
    }
  };

  private constructor(private readonly core: EASKeyStore) {}

  static async onchain(options: EASStoreOnchainOptions): Promise<EASStore> {
    const network = resolveNetwork(options.network);
    const indexer =
      options.indexer ??
      (network.graphqlEndpoint
        ? new EASScanIndexer({
            endpoint: network.graphqlEndpoint
          })
        : new MemoryIndexer());

    return new EASStore(
      await EASKeyStore.create(
        toCoreConfig(options, "onchain", {
          storage: new InlineStorage(),
          indexer
        })
      )
    );
  }

  static async offchain(options: EASStoreOffchainOptions): Promise<EASStore> {
    return new EASStore(
      await EASKeyStore.create(
        toCoreConfig(options, "offchain", {
          storage: new InlineStorage(),
          indexer: new MemoryIndexer()
        })
      )
    );
  }

  static async local(options: EASStoreLocalOptions): Promise<EASStore> {
    const signer = options.signer ?? Wallet.createRandom();
    const recipient = options.defaultRecipient ?? ((await signer.getAddress()) as Address);

    return new EASStore(
      await EASKeyStore.create({
        chainId: 84532,
        easContractAddress: "0x0000000000000000000000000000000000000001",
        easVersion: "1.3.0",
        schemaUID:
          options.schemaUID ??
          "0x1111111111111111111111111111111111111111111111111111111111111111",
        namespace: options.namespace,
        mode: "offchain",
        signer,
        defaultRecipient: recipient,
        storage: options.storage ?? new MemoryStorage(),
        indexer: options.indexer ?? new MemoryIndexer()
      })
    );
  }

  static async ["private"](options: EASStorePrivateOptions): Promise<EASPrivateStore> {
    if (options.keyRegistrySchemaUID) {
      throw new ConfigurationError(
        "keyRegistrySchemaUID is reserved for the dedicated private key-registry writer and is not supported by EASStore.private yet."
      );
    }

    const storeOptions: EASStoreOffchainOptions = {
      namespace: options.namespace,
      schemaUID: options.schemaUID,
      signer: options.signer,
      ...(options.network ? { network: options.network } : {}),
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.storage ? { storage: options.storage } : {}),
      ...(options.indexer ? { indexer: options.indexer } : {}),
      ...(options.trustedAttesters ? { trustedAttesters: options.trustedAttesters } : {}),
      ...(options.verification ? { verification: options.verification } : {}),
      ...(options.defaultRecipient ? { defaultRecipient: options.defaultRecipient } : {})
    };
    const store =
      options.store ??
      (options.mode === "local"
        ? await EASStore.local({
            namespace: options.namespace,
            signer: options.signer,
            schemaUID: options.schemaUID,
            ...(options.storage ? { storage: options.storage } : {}),
            ...(options.indexer ? { indexer: options.indexer } : {}),
            ...(options.defaultRecipient ? { defaultRecipient: options.defaultRecipient } : {})
          })
        : options.mode === "offchain"
          ? await EASStore.offchain(storeOptions)
          : await EASStore.onchain(storeOptions));

    return EASPrivateStore.create({
      signer: options.signer,
      namespace: options.namespace,
      schemaUID: options.schemaUID,
      ...(options.dappId ? { dappId: options.dappId } : {}),
      ...(options.crypto ? { crypto: options.crypto } : {}),
      ...(options.backup ? { backup: options.backup } : {}),
      ...(options.registry ? { registry: options.registry } : {}),
      store
    });
  }

  static async createAdvanced(config: EASKeyStoreConfig): Promise<EASKeyStore> {
    return EASKeyStore.create(config);
  }

  get advanced(): EASKeyStore {
    return this.core;
  }

  async set<T>(key: string, value: T, options?: SetOptions): Promise<WriteReceipt> {
    return toReceipt(await this.core.set(key, value, options));
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const record = await this.core.get<T>(key);
    return record ? (record.value as T) : null;
  }

  async getRecord<T = unknown>(key: string): Promise<StoredRecord<T> | null> {
    return this.core.get<T>(key);
  }

  async del(key: string): Promise<WriteReceipt> {
    return toReceipt(await this.core.delete(key));
  }

  async delete(key: string): Promise<WriteReceipt> {
    return this.del(key);
  }

  async history<T = unknown>(key: string): Promise<Array<StoredRecord<T>>> {
    return this.core.history<T>(key);
  }

  async scan<T = unknown>(filter: QueryFilter = {}): Promise<Array<StoredRecord<T>>> {
    return this.core.query<T>(filter);
  }

  async query<T = unknown>(filter: QueryFilter = {}): Promise<Array<StoredRecord<T>>> {
    return this.scan<T>(filter);
  }

  async verify(record: StoredRecord): Promise<boolean> {
    return this.core.verify(record);
  }

  async timestamp(uid: Hex): Promise<bigint> {
    return this.core.timestamp(uid);
  }

  async batchTimestamp(uids: Hex[]): Promise<bigint[]> {
    return this.core.batchTimestamp(uids);
  }
}
