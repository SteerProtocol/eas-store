export { EASKeyStore } from "./store";
export {
  EASStore,
  type EASStoreBaseOptions,
  type EASStoreLocalOptions,
  type EASStoreNetwork,
  type EASStoreOffchainOptions,
  type EASStoreOnchainOptions,
  type EASStorePrivateOptions,
  type WriteReceipt
} from "./eas-store";
export { MemoryIndexer } from "./indexers/memory";
export { LocalStorageIndexer } from "./indexers/local-storage";
export { EASScanIndexer } from "./indexers/easscan";
export { MemoryStorage } from "./storage/memory";
export { InlineStorage, inlineStorage, type InlineStorageOptions } from "./storage/inline";
export { canonicalizeJson } from "./codecs/canonical-json";
export { STORE_SCHEMA, ZERO_UID } from "./eas/schema";
export {
  KNOWN_EAS_NETWORKS,
  getEASNetworkPreset,
  getEASNetworkPresetByKey,
  type EASNetworkPreset
} from "./eas/networks";
export {
  ensureDefaultStoreSchema,
  ensureSchema,
  getDefaultStoreSchemaUID,
  getRegisteredSchema,
  registerSchema,
  resolveSchemaRegistryAddress,
  schemaExists,
  type EnsuredSchema,
  type RegisterSchemaOptions,
  type RegisteredSchema,
  type SchemaStatus,
  type SchemaRegistryRuntimeConfig
} from "./eas/schema-registry";
export { EASStoreError, ConfigurationError, VerificationError } from "./errors";
export {
  RecoveryPhraseBackupProvider,
  MemoryKeyBackupStorage,
  recoveryPhraseBackup
} from "./private/backup";
export { IndexedDBKeyBackupStorage } from "./private/indexeddb-backup";
export {
  WebCryptoPrivateCryptoProvider,
  computeEncryptionKeyId,
  computeWrappedKeysHash
} from "./private/crypto";
export {
  MemoryEncryptionKeyRegistry,
  StoreBackedEncryptionKeyRegistry
} from "./private/registry";
export {
  PRIVATE_ACCESS_EVENT_SCHEMA,
  PRIVATE_KEY_REGISTRY_SCHEMA,
  PRIVATE_VALUE_SCHEMA,
  ensureAllPrivateSchemas,
  uidForAccessEvent,
  uidForKeyRegistry,
  uidForPrivateValue
} from "./private/schemas";
export { EASPrivateStore } from "./private/store";
export {
  PRIVATE_VALUE_CONTENT_TYPE,
  type EncryptedKeyBackup,
  type EncryptionIdentity,
  type EncryptionKeyRegistry,
  type KeyBackupProvider,
  type KeyBackupStorage,
  type PrivateCryptoContext,
  type PrivateCryptoProvider,
  type PrivateEnvelope,
  type PrivateGrantOptions,
  type PrivateReader,
  type PrivateRevokeOptions,
  type PrivateRotateOptions,
  type PrivateSetOptions,
  type PrivateStoreOptions,
  type WrappedDataKey
} from "./private/types";
export {
  StoreOperation,
  type Address,
  type EASKeyStoreConfig,
  type EncodedStoreRecord,
  type Hex,
  type IndexedStoreRecord,
  type IndexerAdapter,
  type QueryFilter,
  type SetOptions,
  type StorageAdapter,
  type StoredRecord,
  type StoreMode,
  type StoreSigner,
  type VerificationPolicy
} from "./types";
