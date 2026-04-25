import { startTransition, useEffect, useRef, useState } from "react";
import { BrowserProvider, Wallet, ZeroAddress } from "ethers";
import {
  Box,
  ChevronRight,
  Code2,
  Copy,
  Database,
  FileText as FileIcon,
  Globe2,
  History,
  Layers,
  Link2,
  Lock,
  LockKeyhole,
  MessageCircle,
  Network as NetworkIcon,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Shield,
  ShieldCheck,
  Trash2,
  X
} from "lucide-react";

import {
  EASStore,
  IndexedDBKeyBackupStorage,
  KNOWN_EAS_NETWORKS,
  LocalStorageIndexer,
  STORE_SCHEMA,
  StoreOperation,
  recoveryPhraseBackup,
  ensureSchema,
  getEASNetworkPreset,
  getEASNetworkPresetByKey,
  inlineStorage,
  type EncryptedKeyBackup,
  type EASPrivateStore,
  type EASNetworkPreset,
  type StoreMode,
  type StoredRecord
} from "@steerprotocol/eas-store";
import { SchemaBuilder } from "./schema-builder";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from "@/components/ui/tooltip";

const DEFAULT_OFFCHAIN_SCHEMA_UID =
  "0x1111111111111111111111111111111111111111111111111111111111111111" as const;
const DEFAULT_ONCHAIN_SCHEMA_UID = EASStore.schema.uidForDefault({
  resolverAddress: ZeroAddress as `0x${string}`,
  revocable: true
});
const DEFAULT_NAMESPACE = "demo";
const DEFAULT_KEY = "profile:alice";
const DEFAULT_NETWORK_KEY = "base-sepolia" as const;
const DEFAULT_VALUE = JSON.stringify(
  {
    name: "Alice",
    bio: "Attestation-backed demo profile",
    tags: ["demo", "offchain", "verified"]
  },
  null,
  2
);

const DEFAULT_SCHEMA_DEFINITION = STORE_SCHEMA;
const DEMO_PRIVATE_WALLET_KEY = "eas-store-demo:private-session-wallet";

type EnvConfig = {
  readonly VITE_EAS_NETWORK_KEY?: string;
  readonly VITE_EAS_CHAIN_ID?: string;
  readonly VITE_EAS_CONTRACT_ADDRESS?: string;
  readonly VITE_EAS_SCHEMA_REGISTRY_ADDRESS?: string;
  readonly VITE_EAS_SCHEMA_UID?: string;
  readonly VITE_EASSCAN_GRAPHQL_ENDPOINT?: string;
};

type KnownNetworkKey = EASNetworkPreset["key"] | "custom";
type OutputView = "latest" | "history" | "query";
type PrivateSetupView = "intro" | "created" | "restore";

type OnchainConfigInput = {
  networkKey: KnownNetworkKey;
  chainId: string;
  easContractAddress: string;
  schemaRegistryAddress: string;
  schemaUID: string;
  graphqlEndpoint: string;
};

type ResolvedOnchainConfig = {
  chainId: number;
  easContractAddress: `0x${string}`;
  schemaRegistryAddress: `0x${string}`;
  schemaUID?: `0x${string}`;
  graphqlEndpoint?: string;
};

type DemoStore = {
  store: EASStore;
  namespace: string;
  signerAddress: string;
  storageLabel: string;
  indexerLabel: string;
  onchainConfig?: OnchainConfigInput;
};

function getDefaultPreset(): EASNetworkPreset {
  return (
    getEASNetworkPresetByKey(DEFAULT_NETWORK_KEY) ??
    KNOWN_EAS_NETWORKS[0] ??
    (() => {
      throw new Error("No EAS network presets are available.");
    })()
  );
}

function buildOnchainConfigFromPreset(
  preset: EASNetworkPreset,
  overrides: Partial<OnchainConfigInput> = {}
): OnchainConfigInput {
  return {
    networkKey: preset.key,
    chainId: String(preset.chainId),
    easContractAddress: preset.easContractAddress,
    schemaRegistryAddress: preset.schemaRegistryAddress,
    schemaUID: overrides.schemaUID ?? "",
    graphqlEndpoint: overrides.graphqlEndpoint ?? preset.graphqlEndpoint
  };
}

function alignOnchainConfigToWalletChain(
  input: OnchainConfigInput,
  walletChainId: number
): OnchainConfigInput {
  const currentChainId = Number.parseInt(input.chainId.trim(), 10);

  if (input.networkKey === "custom" || currentChainId === walletChainId) {
    return input;
  }

  const walletPreset = getEASNetworkPreset(walletChainId);

  if (!walletPreset) {
    return input;
  }

  return buildOnchainConfigFromPreset(walletPreset, {
    schemaUID: input.schemaUID
  });
}

function getEnvConfig(): OnchainConfigInput {
  const env = import.meta.env as ImportMetaEnv & EnvConfig;
  const defaultPreset = getDefaultPreset();
  const requestedKey = env.VITE_EAS_NETWORK_KEY;
  const preset = requestedKey
    ? (getEASNetworkPresetByKey(requestedKey as EASNetworkPreset["key"]) ?? defaultPreset)
    : defaultPreset;

  return {
    networkKey:
      env.VITE_EAS_CHAIN_ID ||
      env.VITE_EAS_CONTRACT_ADDRESS ||
      env.VITE_EAS_SCHEMA_REGISTRY_ADDRESS
        ? "custom"
        : (preset?.key ?? defaultPreset.key),
    chainId: env.VITE_EAS_CHAIN_ID ?? String((preset ?? defaultPreset).chainId),
    easContractAddress:
      env.VITE_EAS_CONTRACT_ADDRESS ?? (preset ?? defaultPreset).easContractAddress,
    schemaRegistryAddress:
      env.VITE_EAS_SCHEMA_REGISTRY_ADDRESS ??
      (preset ?? defaultPreset).schemaRegistryAddress,
    schemaUID: env.VITE_EAS_SCHEMA_UID ?? DEFAULT_ONCHAIN_SCHEMA_UID,
    graphqlEndpoint:
      env.VITE_EASSCAN_GRAPHQL_ENDPOINT ?? (preset ?? defaultPreset).graphqlEndpoint
  };
}

function getInjectedProvider(): unknown {
  return (window as Window & { ethereum?: unknown }).ethereum;
}

function isHexAddress(value: string): value is `0x${string}` {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

function isHex32(value: string): value is `0x${string}` {
  return /^0x[a-fA-F0-9]{64}$/.test(value);
}

function parseOnchainConfig(
  input: OnchainConfigInput,
  options: {
    requireSchemaUID: boolean;
  }
): ResolvedOnchainConfig {
  const chainId = Number.parseInt(input.chainId.trim(), 10);

  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error("Chain ID must be a positive integer.");
  }

  if (!isHexAddress(input.easContractAddress.trim())) {
    throw new Error("EAS contract address must be a 20-byte hex address.");
  }

  if (!isHexAddress(input.schemaRegistryAddress.trim())) {
    throw new Error("Schema registry address must be a 20-byte hex address.");
  }

  const schemaUID = input.schemaUID.trim();

  if (options.requireSchemaUID && schemaUID.length === 0) {
    throw new Error("Schema UID is required. Publish a schema first or paste an existing UID.");
  }

  if (schemaUID && !isHex32(schemaUID)) {
    throw new Error("Schema UID must be a 32-byte hex string.");
  }

  const graphqlEndpoint = input.graphqlEndpoint.trim();

  return {
    chainId,
    easContractAddress: input.easContractAddress.trim() as `0x${string}`,
    schemaRegistryAddress: input.schemaRegistryAddress.trim() as `0x${string}`,
    ...(schemaUID ? { schemaUID: schemaUID as `0x${string}` } : {}),
    ...(graphqlEndpoint ? { graphqlEndpoint } : {})
  };
}

async function createOffchainDemoStore(namespace: string): Promise<DemoStore> {
  const signer = Wallet.createRandom();
  const address = (await signer.getAddress()) as `0x${string}`;
  const store = await EASStore.local({
    schemaUID: DEFAULT_OFFCHAIN_SCHEMA_UID,
    namespace,
    signer,
    defaultRecipient: address
  });

  return {
    store,
    namespace,
    signerAddress: address,
    storageLabel: "MemoryStorage",
    indexerLabel: "MemoryIndexer"
  };
}

function resolveDemoOnchainNamespace(namespace: string, address: `0x${string}`): string {
  void address;
  return namespace.trim() || DEFAULT_NAMESPACE;
}

async function createOnchainWalletContext(input: OnchainConfigInput): Promise<{
  config: ResolvedOnchainConfig;
  alignedConfigInput: OnchainConfigInput;
  provider: BrowserProvider;
  signer: Awaited<ReturnType<BrowserProvider["getSigner"]>>;
  address: `0x${string}`;
}> {
  const injectedProvider = getInjectedProvider();

  if (!injectedProvider) {
    throw new Error(
      "No injected wallet was found in this browser. Open the demo in a wallet-enabled browser to use onchain mode."
    );
  }

  const provider = new BrowserProvider(injectedProvider as never);
  await provider.send("eth_requestAccounts", []);
  const signer = await provider.getSigner();
  const address = (await signer.getAddress()) as `0x${string}`;
  const network = await provider.getNetwork();
  const configInput = alignOnchainConfigToWalletChain(input, Number(network.chainId));
  const config = parseOnchainConfig(configInput, {
    requireSchemaUID: false
  });

  if (Number(network.chainId) !== config.chainId) {
    throw new Error(
      `Connected wallet is on chain ${network.chainId.toString()}. Switch to chain ${config.chainId}.`
    );
  }

  return {
    config,
    alignedConfigInput: configInput,
    provider,
    signer,
    address
  };
}

async function createOnchainDemoStore(
  namespace: string,
  configInput: OnchainConfigInput
): Promise<DemoStore> {
  const { config, alignedConfigInput, provider, signer, address } = await createOnchainWalletContext(
    configInput
  );
  const resolvedNamespace = resolveDemoOnchainNamespace(namespace, address);

  if (!config.schemaUID) {
    throw new Error("Schema UID is required. Publish a schema first or paste an existing UID.");
  }

  const store = await EASStore.onchain({
    network: {
      chainId: config.chainId,
      easContractAddress: config.easContractAddress,
      easVersion: resolvePreset(alignedConfigInput.networkKey)?.easVersion ?? "1.3.0",
      schemaRegistryAddress: config.schemaRegistryAddress,
      ...(config.graphqlEndpoint ? { graphqlEndpoint: config.graphqlEndpoint } : {})
    },
    schemaUID: config.schemaUID,
    namespace: resolvedNamespace,
    signer: signer as never,
    provider: provider as never,
    defaultRecipient: address,
    storage: inlineStorage({ maxBytes: 32_768 })
  });

  return {
    store,
    namespace: resolvedNamespace,
    signerAddress: address,
    storageLabel: "InlineStorage",
    indexerLabel: config.graphqlEndpoint ? "EASScanIndexer" : "MemoryIndexer",
    onchainConfig: alignedConfigInput
  };
}

function formatPayload(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(
    value,
    (_key, item) => (typeof item === "bigint" ? item.toString() : item),
    2
  );
}

function summarizeRecord(record: StoredRecord | null): string {
  if (!record) {
    return "null";
  }

  return JSON.stringify(
    {
      key: record.key,
      uid: record.uid,
      version: record.version,
      operation: record.operation === StoreOperation.Delete ? "DELETE" : "SET",
      verified: record.verified,
      mode: record.mode,
      attester: record.attester,
      recipient: record.recipient,
      value: record.value
    },
    null,
    2
  );
}

type DemoRecordRow = {
  key: string;
  value: string;
  meta: string;
  operation: "SET" | "DELETE";
  version: string;
  status: string;
  substatus: string;
  updated: string;
  tone: "verified" | "private" | "deleted";
  uid?: string;
  schemaUID?: string;
  contentType?: string;
};

const SEEDED_RECORD_ROWS: DemoRecordRow[] = [
  {
    key: DEFAULT_KEY,
    value: '{ "name": "Alice", "role": "admin" }',
    meta: "Inline JSON payload",
    operation: "SET",
    version: "v1",
    status: "Ready",
    substatus: "Demo seed",
    updated: "2 min ago",
    tone: "verified"
  },
  {
    key: "profile:bob",
    value: "Private payload",
    meta: "Hash verified",
    operation: "SET",
    version: "v1",
    status: "Verified",
    substatus: "Canonical",
    updated: "8 min ago",
    tone: "private"
  },
  {
    key: "profile:charlie",
    value: '{ "plan": "pro", "active": true }',
    meta: "Inline JSON payload",
    operation: "SET",
    version: "v1",
    status: "Verified",
    substatus: "Canonical",
    updated: "25 min ago",
    tone: "verified"
  },
  {
    key: "profile:dave",
    value: "Tombstone (deleted)",
    meta: "(deleted)",
    operation: "DELETE",
    version: "v4",
    status: "Verified",
    substatus: "Deleted",
    updated: "1 hr ago",
    tone: "deleted"
  }
];

function keyLabel(recordKey: string): string {
  return recordKey.split(":").at(-1) || recordKey;
}

function profileKey(input: string): string {
  const trimmed = input.trim();

  if (!trimmed) {
    return DEFAULT_KEY;
  }

  return trimmed.includes(":") ? trimmed : `profile:${trimmed}`;
}

function compactValue(value: unknown): string {
  if (value === null) {
    return "Tombstone (deleted)";
  }

  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value).replace(/\s+/g, " ");
}

function rowFromRecord(record: StoredRecord): DemoRecordRow {
  const deleted = record.operation === StoreOperation.Delete;

  return {
    key: record.key,
    value: compactValue(record.value),
    meta: deleted ? "(deleted)" : record.contentType,
    operation: deleted ? "DELETE" : "SET",
    version: `v${record.version}`,
    status: record.verified ? "Verified" : "Unverified",
    substatus: deleted ? "Deleted" : "Canonical",
    updated: "just now",
    tone: deleted ? "deleted" : "verified",
    uid: record.uid,
    schemaUID: record.schemaUID,
    contentType: record.contentType
  };
}

function getPresetLabel(networkKey: KnownNetworkKey): string {
  if (networkKey === "custom") {
    return "Custom network";
  }

  return getEASNetworkPresetByKey(networkKey)?.label ?? "Unknown network";
}

function resolvePreset(networkKey: KnownNetworkKey): EASNetworkPreset | undefined {
  if (networkKey === "custom") {
    return undefined;
  }

  return getEASNetworkPresetByKey(networkKey);
}

function getIndexingSummary(input: OnchainConfigInput): {
  label: string;
  detail: string;
  tone: "indexed" | "custom";
} {
  if (input.graphqlEndpoint.trim()) {
    return {
      label: "Indexed reads",
      detail: "EASScan GraphQL is configured, so remote records can be discovered and then verified against chain data.",
      tone: "indexed"
    };
  }

  return {
    label: "Write capable",
    detail: "No GraphQL indexer is configured. Writes can still attest onchain, but cross-session reads need a durable indexer.",
    tone: "custom"
  };
}

function getSchemaFieldCount(schema: string): number {
  return schema
    .split(",")
    .map((segment) => segment.trim())
    .filter(Boolean).length;
}

function getOrCreateDemoPrivateWallet() {
  const stored = window.sessionStorage.getItem(DEMO_PRIVATE_WALLET_KEY);

  if (stored) {
    return new Wallet(stored);
  }

  const wallet = Wallet.createRandom();
  window.sessionStorage.setItem(DEMO_PRIVATE_WALLET_KEY, wallet.privateKey);
  return wallet;
}

export default function App() {
  const isDeveloperPage = window.location.pathname === "/developer";
  const storeRef = useRef<DemoStore | null>(null);
  const privateStoreRef = useRef<EASPrivateStore | null>(null);
  const privateBackupRef = useRef<EncryptedKeyBackup | null>(null);
  const privateBackupStorageRef = useRef(
    new IndexedDBKeyBackupStorage({
      dbName: "eas-store-demo"
    })
  );
  const [mode, setMode] = useState<StoreMode>("offchain");
  const [outputView, setOutputView] = useState<OutputView>("latest");
  const [showAdvancedSchema, setShowAdvancedSchema] = useState(false);
  const [namespaceInput, setNamespaceInput] = useState(DEFAULT_NAMESPACE);
  const [activeNamespace, setActiveNamespace] = useState(DEFAULT_NAMESPACE);
  const [key, setKey] = useState(DEFAULT_KEY);
  const [valueText, setValueText] = useState(DEFAULT_VALUE);
  const [editorOpen, setEditorOpen] = useState(false);
  const [draftPrivate, setDraftPrivate] = useState(false);
  const [privateSetupOpen, setPrivateSetupOpen] = useState(false);
  const [privateSetupView, setPrivateSetupView] = useState<PrivateSetupView>("intro");
  const [privateReady, setPrivateReady] = useState(false);
  const [onchainConfig, setOnchainConfig] = useState<OnchainConfigInput>(getEnvConfig);
  const [schemaDefinition, setSchemaDefinition] = useState(DEFAULT_SCHEMA_DEFINITION);
  const [signerAddress, setSignerAddress] = useState("");
  const [storageLabel, setStorageLabel] = useState("MemoryStorage");
  const [indexerLabel, setIndexerLabel] = useState("MemoryIndexer");
  const [status, setStatus] = useState("Booting demo store...");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [lastAction, setLastAction] = useState("No actions yet.");
  const [latestRecord, setLatestRecord] = useState("null");
  const [historyRecords, setHistoryRecords] = useState("[]");
  const [queryRecords, setQueryRecords] = useState("[]");
  const [recordRows, setRecordRows] = useState<DemoRecordRow[]>(SEEDED_RECORD_ROWS);
  const [privatePhrase, setPrivatePhrase] = useState("");
  const [privateStatus, setPrivateStatus] = useState("");
  const [privateOutput, setPrivateOutput] = useState("null");
  const [routeHash, setRouteHash] = useState(() =>
    typeof window === "undefined" ? "" : window.location.hash
  );

  function clearOutputs(nextAction: string) {
    startTransition(() => {
      setLatestRecord("null");
      setHistoryRecords("[]");
      setQueryRecords("[]");
      setRecordRows(SEEDED_RECORD_ROWS);
      setOutputView("query");
      setLastAction(nextAction);
    });
  }

  function upsertRecordRow(record: StoredRecord) {
    const nextRow = rowFromRecord(record);

    setRecordRows((currentRows) => {
      const existingIndex = currentRows.findIndex((row) => row.key === nextRow.key);

      if (existingIndex === -1) {
        return [nextRow, ...currentRows];
      }

      return currentRows.map((row, index) => (index === existingIndex ? nextRow : row));
    });
  }

  function applyDemoStore(nextStore: DemoStore, action: string) {
    storeRef.current = nextStore;
    setSignerAddress(nextStore.signerAddress);
    setStorageLabel(nextStore.storageLabel);
    setIndexerLabel(nextStore.indexerLabel);
    setActiveNamespace(nextStore.namespace);
    setNamespaceInput(nextStore.namespace);
    clearOutputs(action);
    setStatus("Ready");
  }

  function invalidateOnchainClient(nextAction: string) {
    storeRef.current = null;
    setStorageLabel("InlineStorage");
    setIndexerLabel(onchainConfig.graphqlEndpoint.trim() ? "EASScanIndexer" : "MemoryIndexer");
    setLatestRecord("null");
    setHistoryRecords("[]");
    setQueryRecords("[]");
    setLastAction(nextAction);
  }

  useEffect(() => {
    privateStoreRef.current = null;
    setPrivateReady(false);
    setDraftPrivate(false);
  }, [mode]);

  useEffect(() => {
    privateStoreRef.current = null;
    setPrivateReady(false);
    setDraftPrivate(false);
  }, [activeNamespace]);

  useEffect(() => {
    if (schemaDefinition.trim() !== STORE_SCHEMA) {
      setShowAdvancedSchema(true);
    }
  }, [schemaDefinition]);

  useEffect(() => {
    function syncHash() {
      setRouteHash(window.location.hash);
    }

    syncHash();
    window.addEventListener("hashchange", syncHash);

    return () => {
      window.removeEventListener("hashchange", syncHash);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function bootOffchainMode() {
      if (mode !== "offchain") {
        return;
      }

      setBusy(true);
      setError("");
      setStatus("Creating a fresh offchain demo store...");

      try {
        const namespace = namespaceInput.trim() || DEFAULT_NAMESPACE;
        const nextStore = await createOffchainDemoStore(namespace);

        if (cancelled) {
          return;
        }

        applyDemoStore(nextStore, "Offchain workspace initialized with a fresh random signer.");
      } catch (cause) {
        if (!cancelled) {
          setStatus("Failed");
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        if (!cancelled) {
          setBusy(false);
        }
      }
    }

    void bootOffchainMode();

    return () => {
      cancelled = true;
    };
  }, [mode]);

  async function runAction(
    label: string,
    action: (store: EASStore) => Promise<void>
  ) {
    const current = storeRef.current?.store;

    if (!current) {
      setError(
        mode === "onchain"
          ? "Create the onchain store client before running actions."
          : "Demo store is not ready yet."
      );
      return;
    }

    setBusy(true);
    setError("");
    setStatus(label);

    try {
      await action(current);
      setStatus("Ready");
    } catch (cause) {
      setStatus("Failed");
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function runPrivateAction(
    label: string,
    action: (store: EASPrivateStore) => Promise<void>
  ) {
    setBusy(true);
    setError("");
    setStatus(label);

    try {
      let current = privateStoreRef.current;

      if (!current) {
        const namespace = `${activeNamespace}.private`;
        const walletContext =
          mode === "onchain" ? await createOnchainWalletContext(onchainConfig) : null;
        const signer = walletContext?.signer ?? getOrCreateDemoPrivateWallet();
        const address = (await signer.getAddress()) as `0x${string}`;
        const backingStore =
          mode === "onchain"
            ? await EASStore.onchain({
                network: {
                  chainId: walletContext!.config.chainId,
                  easContractAddress: walletContext!.config.easContractAddress,
                  easVersion: resolvePreset(onchainConfig.networkKey)?.easVersion ?? "1.3.0",
                  schemaRegistryAddress: walletContext!.config.schemaRegistryAddress,
                  ...(walletContext!.config.graphqlEndpoint
                    ? { graphqlEndpoint: walletContext!.config.graphqlEndpoint }
                    : {})
                },
                namespace,
                schemaUID: walletContext!.config.schemaUID ?? DEFAULT_ONCHAIN_SCHEMA_UID,
                signer: signer as never,
                provider: walletContext!.provider as never,
                defaultRecipient: address,
                storage: inlineStorage({ maxBytes: 32_768 })
              })
            : await EASStore.local({
                signer,
                namespace,
                schemaUID: DEFAULT_OFFCHAIN_SCHEMA_UID,
                defaultRecipient: address,
                storage: inlineStorage({ maxBytes: 32_768 }),
                indexer: new LocalStorageIndexer({
                  key: `eas-store-demo:private-index:${namespace}`
                })
              });

        current = await EASStore["private"]({
          signer,
          namespace,
          schemaUID:
            mode === "onchain"
              ? walletContext!.config.schemaUID ?? DEFAULT_ONCHAIN_SCHEMA_UID
              : DEFAULT_OFFCHAIN_SCHEMA_UID,
          backup: recoveryPhraseBackup({
            storage: privateBackupStorageRef.current
          }),
          store: backingStore
        });
        privateStoreRef.current = current;
      }

      await action(current);
      setStatus("Ready");
    } catch (cause) {
      setStatus("Failed");
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function handleReset() {
    if (mode === "onchain") {
      await handleConnectWallet();
      return;
    }

    setBusy(true);
    setError("");
    setStatus("Resetting offchain workspace...");

    try {
      const namespace = namespaceInput.trim() || DEFAULT_NAMESPACE;
      const nextStore = await createOffchainDemoStore(namespace);
      applyDemoStore(nextStore, "Offchain workspace reset. Memory storage and indexer were cleared.");
    } catch (cause) {
      setStatus("Failed");
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function handleConnectWallet() {
    setBusy(true);
    setError("");
    setStatus("Connecting wallet and creating onchain client...");

    try {
      const namespace = namespaceInput.trim() || DEFAULT_NAMESPACE;
      const nextStore = await createOnchainDemoStore(namespace, onchainConfig);
      if (nextStore.onchainConfig) {
        setOnchainConfig(nextStore.onchainConfig);
      }
      applyDemoStore(
        nextStore,
        `Onchain client initialized with namespace ${nextStore.namespace}.`
      );
    } catch (cause) {
      setStatus("Failed");
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function handleActivateOnchainMode() {
    setBusy(true);
    setError("");
    setStatus("Connecting wallet and creating onchain client...");

    try {
      const namespace = namespaceInput.trim() || DEFAULT_NAMESPACE;
      const nextStore = await createOnchainDemoStore(namespace, onchainConfig);
      if (nextStore.onchainConfig) {
        setOnchainConfig(nextStore.onchainConfig);
      }
      setMode("onchain");
      applyDemoStore(
        nextStore,
        `Onchain client initialized with namespace ${nextStore.namespace}.`
      );
    } catch (cause) {
      setMode("offchain");
      setStatus("Ready");
      setError(
        cause instanceof Error
          ? `${cause.message} Staying in local mode.`
          : `${String(cause)} Staying in local mode.`
      );
    } finally {
      setBusy(false);
    }
  }

  async function handlePublishSchema() {
    setBusy(true);
    setError("");
    setStatus("Publishing schema to the selected EAS schema registry...");

    try {
      const schema = schemaDefinition.trim();

      if (!schema) {
        throw new Error("Schema definition is required before publishing.");
      }

      const { config, signer, address } = await createOnchainWalletContext(onchainConfig);
      const schemaOptions = {
        resolverAddress: ZeroAddress as `0x${string}`,
        revocable: true
      };
      const registered =
        schema === STORE_SCHEMA
          ? await EASStore.schema.ensureDefault({
              network: {
                chainId: config.chainId,
                easContractAddress: config.easContractAddress,
                schemaRegistryAddress: config.schemaRegistryAddress
              },
              signer,
              ...schemaOptions
            })
          : await ensureSchema(
              {
                chainId: config.chainId,
                easContractAddress: config.easContractAddress,
                schemaRegistryAddress: config.schemaRegistryAddress,
                signer
              },
              {
                schema,
                ...schemaOptions
              }
            );

      setSignerAddress(address);
      setOnchainConfig((current) => ({
        ...current,
        schemaUID: registered.uid
      }));
      invalidateOnchainClient(
        registered.created
          ? `Schema ${registered.uid} is ready on ${getPresetLabel(onchainConfig.networkKey)}. Connect the client to start writing records.`
          : `Schema ${registered.uid} already exists on ${getPresetLabel(onchainConfig.networkKey)}. Connect the client to start writing records.`
      );
      setStatus(registered.created ? "Schema ready" : "Schema loaded");
    } catch (cause) {
      setStatus("Failed");
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  function handleNetworkChange(nextKey: KnownNetworkKey) {
    if (nextKey === "custom") {
      setOnchainConfig((current) => ({
        ...current,
        networkKey: "custom"
      }));
      return;
    }

    const preset = resolvePreset(nextKey);

    if (!preset) {
      return;
    }

    setOnchainConfig((current) =>
      buildOnchainConfigFromPreset(preset, {
        graphqlEndpoint: current.graphqlEndpoint || preset.graphqlEndpoint
      })
    );
  }

  const controlsDisabled = busy || !storeRef.current;
  const walletAvailable = Boolean(getInjectedProvider());
  const selectedPreset = resolvePreset(onchainConfig.networkKey);
  const schemaFieldCount = getSchemaFieldCount(schemaDefinition);
  const schemaReady = Boolean(onchainConfig.schemaUID.trim());
  const indexingSummary = getIndexingSummary(onchainConfig);
  const showDeveloperSetup = mode === "onchain" && routeHash === "#setup";

  const outputValue =
    outputView === "latest"
      ? latestRecord
      : outputView === "history"
        ? historyRecords
        : queryRecords;

  const outputTitle =
    outputView === "latest"
      ? "Latest Record"
      : outputView === "history"
        ? "History"
        : "Query Output";

  function handleSetRecord() {
    void runAction("Writing attestation...", async (store) => {
      const parsed = JSON.parse(valueText) as unknown;
      const receipt = await store.set(key, parsed);
      const record = await store.getRecord(key);
      setLastAction(`Saved ${receipt.key} at version ${receipt.version}.`);
      setLatestRecord(summarizeRecord(record));
      if (record) {
        upsertRecordRow(record);
      }
      setEditorOpen(false);
      setOutputView("latest");
    });
  }

  function handleSaveRecord() {
    if (draftPrivate) {
      if (!privateReady) {
        setPrivateSetupOpen(true);
        return;
      }

      handlePrivateSet();
      return;
    }

    handleSetRecord();
  }

  function handleQueryRecords() {
    void runAction("Querying canonical heads...", async (store) => {
      const records = await store.scan();
      setLastAction(`Query returned ${records.length} canonical head(s).`);
      setQueryRecords(formatPayload(records));
      if (records.length > 0) {
        setRecordRows((currentRows) => {
          const liveRows = records.map(rowFromRecord);
          const liveKeys = new Set(liveRows.map((row) => row.key));
          return [
            ...liveRows,
            ...currentRows.filter((row) => !liveKeys.has(row.key))
          ];
        });
      }
      setOutputView("query");
    });
  }

  function handleLoadHistory() {
    void runAction("Loading verified history...", async (store) => {
      const history = await store.history(key);
      setLastAction(`Loaded ${history.length} verified record(s) for ${key}.`);
      setHistoryRecords(formatPayload(history));
      setOutputView("history");
    });
  }

  function handleVerifyRecord() {
    void runAction("Resolving canonical head...", async (store) => {
      const value = await store.get(key);
      const record = await store.getRecord(key);
      setLastAction(value !== null ? `Loaded canonical head for ${key}.` : `No live record for ${key}.`);
      setLatestRecord(summarizeRecord(record));
      setOutputView("latest");
    });
  }

  function handleDeleteRecord() {
    void runAction("Writing tombstone...", async (store) => {
      const receipt = await store.del(key);
      const history = await store.history(key);
      const record = history.at(-1) ?? null;
      setLastAction(`Deleted ${receipt.key} with tombstone version ${receipt.version}.`);
      setLatestRecord(summarizeRecord(record));
      if (record) {
        upsertRecordRow(record);
      }
      setOutputView("latest");
    });
  }

  function handleCreatePrivateIdentity() {
    void runPrivateAction("Creating private identity...", async (store) => {
      await store.private.identity.create();
      const phrase = await store.private.identity.createRecoveryPhrase();
      const backup = await store.private.identity.backup({ phrase });
      privateBackupRef.current = backup;
      setPrivatePhrase(phrase);
      setPrivateStatus("Private identity created and backed up locally. Publish the public key when readers need to find it.");
    });
  }

  function handlePublishPrivateKey() {
    void runPrivateAction("Publishing public encryption key...", async (store) => {
      await store.private.identity.publishKey();
      setPrivateReady(true);
      setPrivateStatus("Public encryption key published for this dapp.");
    });
  }

  function handleSetupPrivateMode() {
    void runPrivateAction("Setting up private mode...", async (store) => {
      await store.private.identity.create();
      const phrase = await store.private.identity.createRecoveryPhrase();
      const backup = await store.private.identity.backup({ phrase });
      privateBackupRef.current = backup;
      setPrivatePhrase(phrase);
      setPrivateSetupView("created");
      await store.private.identity.publishKey();
      setPrivateReady(true);
      setDraftPrivate(true);
      setPrivateStatus("Private mode is ready for this dapp. Save this recovery phrase to restore this dapp encryption key later.");
    });
  }

  function handlePrivateSet() {
    void runPrivateAction("Writing encrypted private record...", async (store) => {
      const parsed = JSON.parse(valueText) as unknown;
      const receipt = (await store.private.set(key, parsed)) as { key?: string; version?: number };
      const record = await store.private.getRecord(key);
      setPrivateOutput(formatPayload(record?.value ?? null));
      setPrivateStatus(`Encrypted ${key} inline.`);
      setLastAction(`Saved private ${key}${receipt.version ? ` at version ${receipt.version}` : ""}.`);
      setLatestRecord(summarizeRecord(record));
      setRecordRows((currentRows) => {
        const existingIndex = currentRows.findIndex((row) => row.key === key);
        const nextRow: DemoRecordRow = {
          key,
          value: "Private payload",
          meta: "Hash verified",
          operation: "SET",
          version: `v${record?.version ?? receipt.version ?? 1}`,
          status: "Verified",
          substatus: "Canonical",
          updated: "just now",
          tone: "private",
          ...(record?.uid ? { uid: record.uid } : {}),
          ...(record?.schemaUID ? { schemaUID: record.schemaUID } : {}),
          ...(record?.contentType ? { contentType: record.contentType } : {})
        };

        if (existingIndex === -1) {
          return [nextRow, ...currentRows];
        }

        return currentRows.map((row, index) => (index === existingIndex ? nextRow : row));
      });
      setEditorOpen(false);
      setOutputView("latest");
    });
  }

  function handlePrivateGet() {
    void runPrivateAction("Decrypting private record...", async (store) => {
      const value = await store.private.get(key);
      setPrivateOutput(formatPayload(value));
      setPrivateStatus(`Decrypted ${key}.`);
    });
  }

  function handlePrivateRestore() {
    void runPrivateAction("Restoring private identity...", async (store) => {
      await store.private.identity.restore({
        phrase: privatePhrase,
        ...(privateBackupRef.current ? { backup: privateBackupRef.current } : {})
      });
      setPrivateReady(true);
      setDraftPrivate(true);
      setPrivateSetupOpen(false);
      setPrivateStatus("Private identity restored for this dapp from the recovery phrase.");
    });
  }

  function handlePrivateModeToggle(checked: boolean) {
    if (!checked) {
      setDraftPrivate(false);
      return;
    }

    if (!privateReady) {
      setPrivateSetupView("intro");
      setPrivateSetupOpen(true);
      return;
    }

    setDraftPrivate(true);
  }

  const shortSigner = signerAddress
    ? `${signerAddress.slice(0, 6)}...${signerAddress.slice(-4)}`
    : mode === "onchain"
      ? "Connect wallet"
      : "Demo signer";
  const selectedRow =
    recordRows.find((row) => row.key === key) ?? recordRows[0] ?? SEEDED_RECORD_ROWS[0]!;
  const detailUID = selectedRow.uid ? `${selectedRow.uid.slice(0, 6)}...${selectedRow.uid.slice(-4)}` : "pending";
  const valueLineNumbers = valueText.split(/\r?\n/).map((_, index) => index + 1);
  const profileRecordCount = recordRows.filter((row) => row.key.startsWith("profile:")).length;
  const featureRows = [
    {
      icon: ShieldCheck,
      title: "Verifiable",
      description: "Every read cryptographically verifiable."
    },
    {
      icon: LockKeyhole,
      title: "Private by default",
      description: "Private payloads remain confidential."
    },
    {
      icon: Code2,
      title: "Simple API",
      description: "Set, get, delete. Designed for builders."
    }
  ];
  const developerSnippetLeft = `import { EASStore } from "@steerprotocol/eas-store";

const store = await EASStore.onchain({
  signer,
  namespace: "my-dapp",
  schemaUID
});

await store.set("alice", {
  name: "Alice",
  role: "admin"
});`
  const developerSnippetRight = `const record = await store.getRecord("alice");
const ok = await store.verify(record);
console.log(ok); // true

console.log(record.value);
// { name: "Alice", role: "admin" }`;
  const setupSteps = [
    {
      icon: Layers,
      title: "Pick a namespace",
      description: "Scope your data."
    },
    {
      icon: Pencil,
      title: "Write records",
      description: "Create an attested record."
    },
    {
      icon: ShieldCheck,
      title: "Read and verify",
      description: "Cryptographically verifiable."
    }
  ];

  return (
    <TooltipProvider>
    <main className="min-h-screen bg-[#fbfcff] px-5 py-5 text-slate-950">
      <div className="mx-auto max-w-[1218px] overflow-hidden rounded-[22px] border border-slate-200 bg-white shadow-[0_24px_80px_rgba(15,23,42,0.07)]">
        <nav className="flex min-h-[76px] items-center justify-between border-b border-slate-200 px-8">
          <div className="flex items-center gap-3">
            <div className="grid size-9 place-items-center text-blue-600">
              <Layers className="size-8 fill-blue-50 stroke-[2.4]" />
            </div>
            <h2 className="text-2xl font-semibold tracking-[-0.035em]">EAS Store</h2>
          </div>
          <div className="hidden items-center gap-11 text-[15px] font-medium text-slate-800 md:flex">
            <a href="#features">Features</a>
            <a href="#how-it-works">How It Works</a>
            <a href="#docs">Docs</a>
            <a href="https://github.com/SteerProtocol/eas-store" rel="noreferrer">GitHub</a>
          </div>
          <div className="hidden w-[72px] md:block" aria-hidden="true" />
        </nav>

        <section className="px-8 pb-7 pt-6 md:px-10 md:pb-10">
          <div className="mx-auto flex max-w-[790px] flex-col items-center text-center">
            <Badge variant="outline" className="h-11 rounded-full border-blue-200 bg-white px-5 text-[15px] font-semibold text-slate-900 shadow-[0_16px_60px_rgba(37,99,235,0.08)]">
              <ShieldCheck className="size-5 text-blue-600" />
              Attestation-backed key/value store
            </Badge>
            <h1 className="mt-5 max-w-[760px] text-[44px] font-semibold leading-[1.18] tracking-[-0.055em] text-slate-950 md:text-[50px]">
              Every write is an <span className="text-blue-600">attestation.</span>
              <br />
              Every read is <span className="text-blue-600">verifiable.</span>
            </h1>
            <p className="mt-5 max-w-[650px] text-[17px] leading-8 text-slate-600">
              A simple, trustless key/value store built on Ethereum Attestation Service.
              <br className="hidden md:block" />
              Verifiable. Canonical. Privacy-aware.
            </p>
          </div>

          {error ? (
            <Card className="mx-auto mt-8 max-w-[1080px] border-red-200 bg-red-50 text-red-700" data-testid="error-output">
              <CardContent className="pt-4">{error}</CardContent>
            </Card>
          ) : null}

          <Card className="mx-auto mt-10 max-w-[1080px] gap-0 overflow-hidden rounded-[18px] border-0 bg-white py-0 shadow-[0_22px_58px_rgba(15,23,42,0.12)] ring-1 ring-[#dfe7f1]">
            <div className="flex min-h-[64px] items-center justify-between border-b border-slate-200 px-6">
              <div className="flex items-center gap-3">
                <Layers className="size-8 text-blue-600" />
                <p className="text-lg font-semibold tracking-[-0.02em]">EAS Store</p>
              </div>
              <div className="flex items-center gap-2">
                <label className="mr-1 hidden h-8 items-center gap-2 rounded-full border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 shadow-sm sm:inline-flex">
                  <LockKeyhole className="size-4 text-violet-600" />
                  Private mode
                  <Switch
                    aria-label="Private mode"
                    data-testid="private-mode-toggle"
                    checked={draftPrivate}
                    disabled={busy}
                    onCheckedChange={handlePrivateModeToggle}
                    size="sm"
                  />
                </label>
                <button
                  type="button"
                  className={mode === "offchain" ? "inline-flex h-8 items-center gap-2 rounded-full border border-slate-200 bg-slate-950 px-3 text-sm font-medium text-white shadow-sm" : "inline-flex h-8 items-center gap-2 rounded-full border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 shadow-sm"}
                  data-testid="mode-offchain"
                  disabled={busy}
                  onClick={() => setMode("offchain")}
                >
                  Local
                </button>
                <button
                  type="button"
                  className={mode === "onchain" ? "inline-flex h-8 items-center gap-2 rounded-full border border-slate-200 bg-white px-3 text-sm font-medium text-slate-800 shadow-sm" : "inline-flex h-8 items-center gap-2 rounded-full border border-slate-200 bg-white px-3 text-sm font-medium text-slate-500 shadow-sm"}
                  data-testid="mode-onchain"
                  disabled={busy}
                  onClick={() => void handleActivateOnchainMode()}
                >
                  <span className={busy ? "size-3 rounded-full bg-amber-400" : mode === "onchain" ? "size-3 rounded-full bg-emerald-500 shadow-[0_0_0_4px_rgba(34,197,94,0.12)]" : "size-3 rounded-full bg-slate-300"} />
                  Onchain
                  <span className="sr-only" data-testid="demo-status">{busy ? "Running" : status}</span>
                </button>
              </div>
            </div>

            <div className="grid lg:grid-cols-[230px_minmax(0,1fr)]">
              <aside className="border-b border-slate-200 bg-slate-50/80 p-4 lg:min-h-[405px] lg:border-b-0 lg:border-r">
                <div className="mb-4 flex items-center justify-between">
                  <h2 className="text-lg font-semibold tracking-[-0.02em]">Tables</h2>
                  <Button type="button" variant="outline" size="icon" className="size-9 rounded-md border-slate-200 bg-white">
                    <Plus className="size-4" />
                  </Button>
                </div>
                <div className="grid gap-2">
                  {[
                    { icon: ShieldCheck, label: "profile", count: profileRecordCount, active: true },
                    { icon: RefreshCw, label: "settings", count: 2 },
                    { icon: NetworkIcon, label: "api", count: 3 },
                    { icon: FileIcon, label: "docs", count: 1 }
                  ].map(({ icon: Icon, label, count, active }) => (
                    <button
                      key={label}
                      type="button"
                      className={active ? "flex h-12 items-center justify-between rounded-lg border border-blue-100 bg-blue-50 px-3 text-blue-700 shadow-sm" : "flex h-12 items-center justify-between rounded-lg border border-transparent px-3 text-slate-600 hover:bg-white"}
                    >
                      <span className="flex items-center gap-3 text-[15px] font-medium">
                        <Icon className="size-5" />
                        {label}
                      </span>
                      <span className="text-sm">{count}</span>
                    </button>
                  ))}
                </div>
                <div className="mt-24 hidden text-sm leading-6 text-slate-500 lg:block">
                  Use <code className="rounded bg-blue-50 px-1.5 py-0.5 font-mono text-xs text-blue-700">&lt;table&gt;:&lt;key&gt;</code> to store and organize data.
                </div>
                <div className="mt-5 grid gap-2">
                  <label className="grid gap-1.5 text-sm">
                    <span className="font-medium text-slate-600">App namespace</span>
                    <Input
                      className="h-9 rounded-md bg-white text-sm"
                      data-testid="namespace-input"
                      value={namespaceInput}
                      onChange={(event) => setNamespaceInput(event.target.value)}
                    />
                  </label>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-9 rounded-md bg-white text-sm"
                    data-testid="reset-button"
                    disabled={busy}
                    onClick={() => void handleReset()}
                  >
                    {mode === "onchain" ? "Reconnect" : "Reset namespace"}
                  </Button>
                </div>
              </aside>

              <section className="min-w-0 p-5">
                <div className="mb-4 grid gap-4">
                  <h2 aria-label="profiles" className="text-xl font-semibold tracking-[-0.02em]">profile</h2>
                  <div className="flex min-w-0 items-center gap-5">
                    <div className="relative flex-1">
                      <Search className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-slate-400" />
                      <Input
                        className="h-11 rounded-lg border-slate-200 bg-white pl-11 text-[15px] shadow-sm"
                        data-testid="key-input"
                        value={keyLabel(key)}
                        onChange={(event) => setKey(profileKey(event.target.value))}
                        placeholder="Search keys..."
                      />
                    </div>
                    <Button
                      type="button"
                      className="h-11 rounded-md bg-blue-600 px-5 text-[15px] font-semibold text-white shadow-[0_10px_24px_rgba(37,99,235,0.22)] hover:bg-blue-700"
                      data-testid="set-button"
                      disabled={controlsDisabled}
                      onClick={() => setEditorOpen(true)}
                    >
                      <Plus className="size-4" />
                      New Entry
                    </Button>
                  </div>
                </div>
                <label className="mb-4 flex h-10 items-center justify-between rounded-xl border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 shadow-sm sm:hidden">
                  <span className="inline-flex items-center gap-2">
                    <LockKeyhole className="size-4 text-violet-600" />
                    Private mode
                  </span>
                  <Switch
                    aria-label="Private mode mobile"
                    checked={draftPrivate}
                    disabled={busy}
                    onCheckedChange={handlePrivateModeToggle}
                    size="sm"
                  />
                </label>

                <div className="overflow-hidden rounded-lg border border-slate-200">
                  <Table className="table-fixed">
                    <TableHeader>
                      <TableRow className="h-12 border-slate-200 bg-slate-50 hover:bg-slate-50">
                        <TableHead className="w-[24%] px-4 text-sm font-semibold text-slate-600">Key</TableHead>
                        <TableHead className="text-sm font-semibold text-slate-600">Value</TableHead>
                        <TableHead className="hidden w-[28%] text-sm font-semibold text-slate-600 md:table-cell">Updated</TableHead>
                        <TableHead className="w-10" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {recordRows.map((row, index) => (
                        <TableRow
                          key={`${row.key}:${index}`}
                          className="h-16 cursor-pointer border-slate-200"
                          onClick={() => {
                            setKey(row.key);
                            setEditorOpen(true);
                          }}
                        >
                          <TableCell className="px-4 font-medium text-slate-950">{keyLabel(row.key)}</TableCell>
                          <TableCell className="truncate">
                            <span className={row.tone === "private" ? "font-medium text-violet-600" : row.tone === "deleted" ? "font-medium text-red-500" : "font-mono text-sm text-emerald-700"}>
                              {row.tone === "private" ? <Lock className="mr-2 inline size-4 align-[-2px]" /> : null}
                              {row.tone === "deleted" ? <Trash2 className="mr-2 inline size-4 align-[-2px]" /> : null}
                              {row.value}
                            </span>
                          </TableCell>
                          <TableCell className="hidden text-sm text-slate-500 md:table-cell">{row.updated}</TableCell>
                          <TableCell>
                            <ChevronRight className="size-5 text-slate-500" />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <div className="mt-8 text-center text-sm font-medium text-slate-500">{recordRows.length} entries</div>
              </section>
            </div>
          </Card>

          {editorOpen ? (
            <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/25 p-4 backdrop-blur-md" role="dialog" aria-modal="true" aria-label="Record editor">
              <aside className="max-h-[92vh] w-full max-w-[1120px] overflow-y-auto rounded-[18px] border-0 bg-white p-6 text-slate-950 shadow-[0_28px_90px_rgba(15,23,42,0.20)] ring-1 ring-[#dfe7f1] md:p-8">
                <div className="mb-7 flex items-start justify-between gap-4">
                  <div>
                    <p className="text-[15px] font-semibold text-slate-500">Record editor</p>
                    <h3 className="mt-2 text-[32px] font-medium leading-none tracking-[-0.05em]">{keyLabel(key)}</h3>
                  </div>
                  <div className="flex items-center gap-3">
                    <Tooltip>
                      <TooltipTrigger>
                        <span className="inline-flex h-11 items-center gap-2 rounded-lg border border-emerald-100 bg-emerald-50 px-4 text-[15px] font-semibold text-emerald-700 shadow-sm">
                          <ShieldCheck className="size-4" />
                          Verified
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        Verified canonical record, hash, and history continuity.
                      </TooltipContent>
                    </Tooltip>
                    <button
                      type="button"
                      className={draftPrivate ? "inline-flex h-11 items-center gap-2 rounded-lg border border-blue-100 bg-blue-50 px-4 text-[15px] font-semibold text-blue-700 shadow-sm" : "inline-flex h-11 items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 text-[15px] font-semibold text-slate-600 shadow-sm hover:bg-slate-50"}
                      data-testid="entry-private-option"
                      disabled={busy}
                      onClick={() => {
                        if (draftPrivate) {
                          setDraftPrivate(false);
                          return;
                        }

                        if (!privateReady) {
                          setPrivateSetupOpen(true);
                          return;
                        }

                        setDraftPrivate(true);
                      }}
                    >
                      <LockKeyhole className="size-4" />
                      {draftPrivate ? "Encrypted" : "Public"}
                    </button>
                    <button
                      type="button"
                      className="grid size-11 place-items-center rounded-lg border border-slate-200 bg-white text-slate-500 shadow-sm transition hover:bg-slate-50 hover:text-slate-900"
                      onClick={() => setEditorOpen(false)}
                      aria-label="Close editor"
                    >
                      <X className="size-5" />
                    </button>
                  </div>
                </div>

                <div className="grid gap-7 lg:grid-cols-[minmax(0,1fr)_360px]">
                  <section className="min-w-0">
                    <label className="grid gap-3 text-[15px] font-semibold text-slate-500">
                      Key
                      <div className="flex h-12 items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 text-base font-medium text-slate-900 shadow-sm">
                        <Input
                          className="h-auto min-w-0 border-0 bg-transparent p-0 text-base shadow-none focus-visible:ring-0"
                          value={keyLabel(key)}
                          onChange={(event) => setKey(profileKey(event.target.value))}
                        />
                        <Copy className="size-4 shrink-0 text-slate-400" />
                      </div>
                    </label>

                    <label className="mt-7 grid gap-3 text-[15px] font-semibold text-slate-500">
                      Value (JSON)
                      <div className="grid grid-cols-[42px_minmax(0,1fr)] rounded-lg border border-slate-200 bg-white shadow-sm">
                        <div className="select-none border-r border-slate-100 px-3 py-4 text-right font-mono text-sm leading-7 text-slate-400">
                          {valueLineNumbers.map((line) => (
                            <div key={line}>{line}</div>
                          ))}
                        </div>
                        <Textarea
                          className="min-h-[320px] resize-y border-0 bg-transparent px-4 py-4 font-mono text-sm leading-7 text-emerald-700 shadow-none focus-visible:ring-0"
                          data-testid="value-input"
                          value={valueText}
                          onChange={(event) => setValueText(event.target.value)}
                          spellCheck={false}
                        />
                      </div>
                    </label>
                  </section>

                  <aside className="border-t border-slate-200 pt-5 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-4">
                    <div className="mb-7 flex items-center justify-between">
                      <div className="flex items-center gap-3 text-slate-600">
                        <History className="size-5" />
                        <p className="font-semibold">Versions</p>
                      </div>
                      <button
                        type="button"
                        className="text-sm font-semibold text-blue-600 hover:text-blue-700"
                        data-testid="history-button"
                        disabled={controlsDisabled}
                        onClick={handleLoadHistory}
                      >
                        View all
                      </button>
                    </div>
                    <div className="grid gap-4">
                      {[
                        [`${selectedRow.version}`, detailUID, selectedRow.updated, true],
                        ["v2", "0x91c3...ab22", "4 days ago", false],
                        ["v1", "0x0000...0001", "12 days ago", false]
                      ].map(([version, uid, time, current]) => (
                        <div key={`${version}-${uid}`} className="rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
                          <div className="flex items-start justify-between gap-4">
                            <div className="flex items-start gap-4">
                              <ShieldCheck className="mt-0.5 size-5 text-emerald-600" />
                              <div>
                                <div className="flex items-center gap-2">
                                  <p className="text-lg font-semibold tracking-[-0.02em] text-slate-950">{version}</p>
                                  {current ? (
                                    <span className="rounded-md bg-blue-50 px-2 py-0.5 text-xs font-semibold text-blue-600">Current</span>
                                  ) : null}
                                </div>
                                <div className="mt-3 flex items-center gap-2 text-sm text-slate-500">
                                  {uid}
                                  <Copy className="size-3.5 text-slate-400" />
                                </div>
                              </div>
                            </div>
                            <span className="text-sm font-medium text-slate-500">{time}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </aside>
                </div>

                <div className="mt-8 flex flex-col-reverse gap-3 border-t border-slate-200 pt-7 sm:flex-row sm:justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    className="h-12 rounded-lg border-red-100 bg-white px-8 text-base font-semibold text-red-600 shadow-sm hover:bg-red-50"
                    data-testid="delete-button"
                    disabled={controlsDisabled}
                    onClick={handleDeleteRecord}
                  >
                    <Trash2 className="size-4" />
                    Delete
                  </Button>
                  <Button
                    type="button"
                    className="h-12 rounded-lg bg-blue-600 px-8 text-base font-semibold text-white shadow-[0_12px_28px_rgba(37,99,235,0.22)] hover:bg-blue-700"
                    data-testid="modal-set-button"
                    disabled={controlsDisabled}
                    onClick={handleSaveRecord}
                  >
                    {draftPrivate ? <LockKeyhole className="size-4" /> : <Plus className="size-4" />}
                    Save changes
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className="sr-only"
                    disabled={controlsDisabled}
                    onClick={handleVerifyRecord}
                  >
                    Verify Record
                    </Button>
                </div>
              </aside>
            </div>
          ) : null}

          <Dialog
            open={privateSetupOpen}
            onOpenChange={(open) => {
              setPrivateSetupOpen(open);
              if (open && !privateReady) {
                setPrivateSetupView("intro");
              }
            }}
          >
            <DialogContent className="max-h-[90vh] max-w-[390px] overflow-y-auto rounded-[18px] border-0 bg-white p-4 text-slate-950 shadow-[0_22px_58px_rgba(15,23,42,0.16)] ring-1 ring-[#dfe7f1]" data-testid="private-setup-dialog">
              <DialogHeader className="gap-1.5">
                <div className="mb-2 flex size-10 items-center justify-center rounded-xl bg-blue-50 text-blue-600 ring-1 ring-blue-100">
                  <LockKeyhole className="size-5" />
                </div>
                <DialogTitle className="text-lg tracking-[-0.02em]">Set up private mode</DialogTitle>
                <DialogDescription className="text-sm leading-5">
                  Create an app encryption key for private records. Your wallet only signs setup; this is not your wallet key.
                </DialogDescription>
              </DialogHeader>
              {privateSetupView === "created" || privateSetupView === "restore" ? (
                <div className="rounded-xl border border-blue-100 bg-blue-50 p-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-700">Recovery phrase</p>
                  <Textarea
                    className="mt-2 min-h-[58px] resize-none rounded-lg border-slate-200 bg-white text-sm shadow-sm focus-visible:border-blue-300 focus-visible:ring-blue-100"
                    data-testid="private-phrase"
                    value={privatePhrase}
                    placeholder={privateSetupView === "restore" ? "Paste your dapp recovery phrase." : "Recovery phrase will appear here."}
                    readOnly={privateSetupView === "created"}
                    onChange={(event) => setPrivatePhrase(event.target.value)}
                  />
                  <p className="mt-2 text-xs leading-5 text-slate-600">
                    This restores the dapp encryption key only. It is not your wallet seed phrase.
                  </p>
                </div>
              ) : null}
              {privateStatus ? (
                <p className="text-xs font-medium leading-5 text-slate-600">{privateStatus}</p>
              ) : null}
              <DialogFooter className="-mx-4 -mb-4 grid gap-2 rounded-b-[18px] border-t border-slate-100 bg-slate-50/80 p-4 sm:grid-cols-2">
                {privateSetupView === "restore" ? (
                  <>
                    <Button type="button" className="h-10 rounded-lg bg-blue-600 text-white shadow-[0_10px_24px_rgba(37,99,235,0.18)] hover:bg-blue-700" data-testid="private-restore-button" disabled={busy || !privatePhrase.trim()} onClick={handlePrivateRestore}>
                      Restore key
                    </Button>
                    <Button type="button" variant="outline" className="h-10 rounded-lg border-slate-200 bg-white text-slate-700 shadow-sm hover:bg-slate-50" disabled={busy} onClick={() => setPrivateSetupView("intro")}>
                      Back
                    </Button>
                  </>
                ) : (
                  <>
                    <Button type="button" className="h-10 rounded-lg bg-blue-600 text-white shadow-[0_10px_24px_rgba(37,99,235,0.18)] hover:bg-blue-700" data-testid="private-setup-button" disabled={busy} onClick={handleSetupPrivateMode}>
                      Create dapp key
                    </Button>
                    <Button type="button" variant="outline" className="h-10 rounded-lg border-slate-200 bg-white text-slate-700 shadow-sm hover:bg-slate-50" data-testid="private-restore-choice" disabled={busy} onClick={() => setPrivateSetupView("restore")}>
                      Restore existing
                    </Button>
                  </>
                )}
                <Button type="button" variant="outline" className="h-10 rounded-lg border-slate-200 bg-white text-slate-700 shadow-sm hover:bg-slate-50 sm:col-span-2" disabled={busy} onClick={() => setPrivateSetupOpen(false)}>
                  Not now
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <div className="sr-only" aria-hidden="true">
            <pre data-testid="latest-record">{latestRecord}</pre>
            <pre data-testid="history-output">{historyRecords}</pre>
            <pre data-testid="query-output">{queryRecords}</pre>
            <pre data-testid="private-output">{privateOutput}</pre>
            <p data-testid="private-status">{privateStatus}</p>
            <p data-testid="last-action">{lastAction}</p>
            <p data-testid="active-namespace">{activeNamespace}</p>
            <p data-testid="signer-address">{signerAddress || "Preparing wallet..."}</p>
            <p data-testid="wallet-help">{mode === "onchain" ? (walletAvailable ? "Detected" : "No injected wallet") : "Ephemeral signer"}</p>
          </div>

          {showDeveloperSetup ? (
            <Card className="mx-auto mt-5 max-w-[1080px] rounded-[18px] border-blue-100 bg-blue-50/40 shadow-sm">
              <CardContent className="grid gap-4 p-5 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.75fr)]">
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="flex flex-col gap-1.5 text-sm">
                    <span className="font-medium text-slate-700">Network</span>
                    <select className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm" data-testid="network-select" value={onchainConfig.networkKey} onChange={(event) => handleNetworkChange(event.target.value as KnownNetworkKey)}>
                      {KNOWN_EAS_NETWORKS.map((preset) => <option key={preset.key} value={preset.key}>{preset.label}</option>)}
                      <option value="custom">Custom</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-1.5 text-sm">
                    <span className="font-medium text-slate-700">Chain ID</span>
                    <Input data-testid="chain-id-input" value={onchainConfig.chainId} readOnly={onchainConfig.networkKey !== "custom"} onChange={(event) => setOnchainConfig((current) => ({ ...current, chainId: event.target.value, networkKey: "custom" }))} />
                  </label>
                  <label className="flex flex-col gap-1.5 text-sm">
                    <span className="font-medium text-slate-700">EAS Contract</span>
                    <Input data-testid="eas-address-input" value={onchainConfig.easContractAddress} readOnly={onchainConfig.networkKey !== "custom"} onChange={(event) => setOnchainConfig((current) => ({ ...current, easContractAddress: event.target.value, networkKey: "custom" }))} />
                  </label>
                  <label className="flex flex-col gap-1.5 text-sm">
                    <span className="font-medium text-slate-700">Schema Registry</span>
                    <Input data-testid="schema-registry-input" value={onchainConfig.schemaRegistryAddress} readOnly={onchainConfig.networkKey !== "custom"} onChange={(event) => setOnchainConfig((current) => ({ ...current, schemaRegistryAddress: event.target.value, networkKey: "custom" }))} />
                  </label>
                  <label className="flex flex-col gap-1.5 text-sm md:col-span-2">
                    <span className="font-medium text-slate-700">GraphQL Endpoint</span>
                    <Input data-testid="graphql-endpoint-input" value={onchainConfig.graphqlEndpoint} onChange={(event) => setOnchainConfig((current) => ({ ...current, graphqlEndpoint: event.target.value }))} />
                  </label>
                  <div className="rounded-xl border border-slate-200 bg-white p-3 md:col-span-2" data-testid="indexing-capability">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={indexingSummary.tone === "indexed" ? "default" : "secondary"}>{indexingSummary.label}</Badge>
                      <span className="text-xs font-medium uppercase tracking-[0.18em] text-slate-400">
                        {onchainConfig.networkKey === "custom" ? "Custom EAS chain" : "Known EAS chain"}
                      </span>
                    </div>
                    <p className="mt-2 text-sm leading-6 text-slate-600">{indexingSummary.detail}</p>
                  </div>
                </div>
                <div className="grid gap-3">
                  <div className="rounded-xl border border-slate-200 bg-white p-3" data-testid="schema-preset-card">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="font-semibold">Steer Store v1</p>
                        <p className="text-sm text-slate-500">namespace, key, value hash, value URI, version, previous UID</p>
                      </div>
                      <Badge variant="outline">{schemaFieldCount} fields</Badge>
                    </div>
                  </div>
                  <Input data-testid="schema-uid-input" value={onchainConfig.schemaUID} onChange={(event) => setOnchainConfig((current) => ({ ...current, schemaUID: event.target.value }))} />
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="outline" data-testid="show-raw-schema-button" disabled={busy} onClick={() => setShowAdvancedSchema((value) => !value)}>
                      <Shield className="size-4" />
                      Schema Builder
                    </Button>
                    {schemaReady ? null : (
                      <Button type="button" data-testid="publish-schema-button" disabled={busy} onClick={() => void handlePublishSchema()}>Publish Schema</Button>
                    )}
                    {schemaReady ? <Button type="button" variant="outline" data-testid="publish-another-schema-button" disabled={busy} onClick={() => void handlePublishSchema()}>Publish Another</Button> : null}
                  </div>
                  {showAdvancedSchema ? (
                    <div className="rounded-xl border border-slate-200 bg-white p-3">
                      <SchemaBuilder value={schemaDefinition} disabled={busy} onChange={setSchemaDefinition} />
                    </div>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          ) : null}

          <div id="features" className="mx-auto mt-14 grid max-w-[1080px] rounded-[18px] border border-slate-200 bg-white px-7 py-8 shadow-sm sm:grid-cols-3">
            {featureRows.map(({ icon: Icon, title, description }, index) => (
              <div key={title} className="flex gap-5 border-slate-200 py-3 sm:px-7 sm:[&:not(:last-child)]:border-r">
                <Icon className={index === 0 ? "mt-1 size-9 text-emerald-600" : index === 1 ? "mt-1 size-9 text-violet-600" : "mt-1 size-9 text-orange-500"} />
                <div>
                  <p className="text-base font-semibold tracking-[-0.02em] text-slate-950">{title}</p>
                  <p className="mt-2 text-sm leading-6 text-slate-600">{description}</p>
                </div>
              </div>
            ))}
          </div>

          <section id="how-it-works" className="mx-auto mt-20 max-w-[1080px]">
            <div className="grid gap-10 lg:grid-cols-[260px_minmax(0,1fr)] lg:items-center">
              <div>
                <Badge variant="outline" className="rounded-full border-blue-200 bg-white px-4 py-1 text-xs font-semibold uppercase tracking-[0.12em] text-blue-600">
                  How it works
                </Badge>
                <h2 className="mt-6 max-w-[240px] text-3xl font-semibold leading-tight tracking-[-0.055em] text-slate-950">
                  Three steps, end-to-end.
                </h2>
              </div>
              <div className="grid gap-8 md:grid-cols-3 md:gap-0">
                {setupSteps.map((step, index) => {
                  const Icon = step.icon;

                  return (
                    <div key={step.title} className="relative grid justify-items-center text-center md:px-4">
                      {index < setupSteps.length - 1 ? (
                        <div className="absolute left-[calc(50%+58px)] top-12 hidden h-px w-[calc(100%-116px)] border-t border-dashed border-slate-300 md:block" />
                      ) : null}
                      <div className="absolute -top-3 left-[calc(50%-56px)] z-10 grid size-8 place-items-center rounded-full bg-slate-950 text-sm font-semibold text-white">
                        {index + 1}
                      </div>
                      <div className="grid size-28 place-items-center rounded-3xl border border-slate-200 bg-white shadow-sm">
                        <Icon className={index === 0 ? "size-11 text-blue-600" : index === 1 ? "size-11 text-violet-600" : "size-11 text-emerald-600"} />
                      </div>
                      <h3 className="mt-5 text-base font-semibold tracking-[-0.02em] text-slate-950">{step.title}</h3>
                      <p className="mt-2 text-sm leading-6 text-slate-600">{step.description}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>

          <section id="docs" className="mx-auto mt-16 max-w-[1080px]">
            <Badge variant="outline" className="mb-4 rounded-full border-blue-200 bg-white px-4 py-1 text-xs font-semibold uppercase tracking-[0.12em] text-blue-600">
              Developer experience
            </Badge>
            <div className="overflow-hidden rounded-[18px] border border-slate-800 bg-slate-950 text-white shadow-[0_24px_70px_rgba(15,23,42,0.28)]">
              <div className="flex items-center justify-between gap-4 border-b border-white/10 bg-slate-950 p-3">
                <div className="grid grid-cols-2 rounded-md bg-slate-800 p-1 text-sm font-semibold">
                  <button type="button" className="rounded bg-blue-600 px-10 py-2 text-white">Onchain</button>
                  <button type="button" className="rounded px-10 py-2 text-slate-300">Private</button>
                </div>
                <div className="flex items-center gap-2">
                  <button type="button" className="rounded-md border border-white/15 px-4 py-2 text-xs font-semibold text-slate-200">
                    JavaScript
                  </button>
                  <button type="button" className="grid size-9 place-items-center rounded-md border border-white/15 text-slate-300" aria-label="Copy code example">
                    <Copy className="size-4" />
                  </button>
                </div>
              </div>
              <div className="grid lg:grid-cols-2">
                <pre className="overflow-x-auto border-white/10 p-6 text-left font-mono text-[14px] leading-7 text-emerald-100 lg:border-r">
                  <code>{developerSnippetLeft}</code>
                </pre>
                <pre className="overflow-x-auto p-6 text-left font-mono text-[14px] leading-7 text-cyan-100">
                  <code>{developerSnippetRight}</code>
                </pre>
              </div>
            </div>
          </section>

          <section className="mx-auto mt-16 grid max-w-[1080px] items-center gap-6 rounded-[18px] border border-slate-200 bg-white p-7 shadow-sm md:grid-cols-[1fr_2fr]">
            <div className="border-slate-200 md:border-r md:pr-10">
              <h2 className="text-2xl font-semibold tracking-[-0.045em] text-slate-950">Ready to build?</h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">Start storing verifiable data in minutes.</p>
              <Button type="button" className="mt-5 h-11 rounded-md bg-blue-600 px-6 text-white hover:bg-blue-700">
                Get started
                <ChevronRight className="size-4" />
              </Button>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              {[
                { icon: FileIcon, title: "Read the docs", description: "Guides and references", href: "#docs" },
                { icon: Box, title: "View on GitHub", description: "Open source", href: "https://github.com/SteerProtocol/eas-store" },
                { icon: MessageCircle, title: "Join the community", description: "Chat with builders", href: "https://github.com/SteerProtocol/eas-store/discussions" }
              ].map(({ icon: Icon, title, description, href }) => (
                <a key={title} href={href} className="flex items-start gap-4 rounded-xl p-3 transition hover:bg-slate-50">
                  <Icon className="mt-0.5 size-6 shrink-0 text-slate-700" />
                  <div>
                    <p className="text-sm font-semibold text-slate-950">{title}</p>
                    <p className="mt-1 text-xs leading-5 text-slate-600">{description}</p>
                  </div>
                </a>
              ))}
            </div>
          </section>

          <Card id="developer" className={isDeveloperPage ? "mx-auto mt-8 max-w-[1080px] rounded-[18px] border-slate-200 bg-white shadow-sm" : "mx-auto mt-8 hidden max-w-[1080px] rounded-[18px] border-slate-200 bg-white shadow-sm"}>
            <CardHeader>
              <CardTitle>Developer controls</CardTitle>
              <CardDescription>Live SDK controls for the database manager above.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1fr)]">
              <div className="grid gap-3">
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="outline" disabled={busy} onClick={() => setMode("offchain")}>Local Mode</Button>
                  <Button type="button" variant="outline" className="border-red-200 text-red-600" disabled={controlsDisabled} onClick={handleDeleteRecord}>Delete Record</Button>
                  <Button type="button" variant="outline" disabled={busy} onClick={() => void handleReset()}>{mode === "onchain" ? "Reconnect" : "Reset namespace"}</Button>
                  <Button type="button" variant="outline" disabled={controlsDisabled} onClick={handleQueryRecords}>Query Records</Button>
                  <Button type="button" variant="outline" disabled={controlsDisabled} onClick={handleVerifyRecord}>Verify Record</Button>
                </div>
                <label className="flex flex-col gap-1.5 text-sm">
                  <span className="font-medium text-slate-700">Namespace</span>
                  <Input value={namespaceInput} onChange={(event) => setNamespaceInput(event.target.value)} />
                </label>
                <label className="flex flex-col gap-1.5 text-sm">
                  <span className="font-medium text-slate-700">Draft payload</span>
                  <Textarea value={valueText} onChange={(event) => setValueText(event.target.value)} rows={5} spellCheck={false} className="font-mono text-sm" />
                </label>
              </div>
              <Card className="border-slate-200 bg-slate-50 shadow-none">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Developer inspector</CardTitle>
                  <CardDescription>{outputTitle}</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <ScrollArea className="h-[168px] rounded-lg border border-slate-200 bg-slate-950 p-3 text-slate-100">
                    <pre className="whitespace-pre-wrap break-words bg-transparent p-0 font-mono text-xs leading-relaxed text-emerald-100">{outputValue}</pre>
                  </ScrollArea>
                  <div className="rounded-lg border border-slate-200 bg-white p-3">
                    <p className="text-xs font-medium text-slate-500">Last action</p>
                    <p className="text-sm font-medium text-slate-900">{lastAction}</p>
                  </div>
                </CardContent>
              </Card>
            </CardContent>
          </Card>

          <Card className={isDeveloperPage ? "mx-auto mt-5 max-w-[1080px] rounded-[18px] border-slate-200 bg-white shadow-sm" : "mx-auto mt-5 hidden max-w-[1080px] rounded-[18px] border-slate-200 bg-white shadow-sm"}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><LockKeyhole className="size-5 text-blue-600" />Private records</CardTitle>
              <CardDescription>Create a dapp-scoped encryption identity, back it up with a recovery phrase, then write encrypted inline records.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 lg:grid-cols-[minmax(0,0.75fr)_minmax(0,1fr)]">
              <div className="grid gap-3 sm:grid-cols-2">
                <Button type="button" variant="outline" disabled={busy} onClick={handleCreatePrivateIdentity}>Create + Backup</Button>
                <Button type="button" variant="outline" disabled={busy} onClick={handlePublishPrivateKey}>Publish Key</Button>
                <Button type="button" disabled={busy} onClick={handlePrivateSet}>Private Set</Button>
                <Button type="button" variant="outline" disabled={busy} onClick={handlePrivateGet}>Private Get</Button>
                <Button type="button" variant="secondary" className="sm:col-span-2" disabled={busy || !privatePhrase} onClick={handlePrivateRestore}>Restore Identity</Button>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <label className="flex flex-col gap-1.5 text-sm">
                  <span className="font-medium text-slate-700">Recovery phrase</span>
                  <Textarea value={privatePhrase} placeholder="Create a dapp-specific recovery phrase or paste one here." onChange={(event) => setPrivatePhrase(event.target.value)} rows={4} />
                </label>
                <div className="grid gap-3">
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <p className="text-xs font-medium text-slate-500">Private status</p>
                    <p className="text-sm font-medium text-slate-900">{privateStatus}</p>
                  </div>
                  <ScrollArea className="h-[116px] rounded-lg border border-slate-200 bg-slate-950 p-3 text-slate-100">
                    <pre className="whitespace-pre-wrap break-words bg-transparent p-0 font-mono text-xs text-emerald-100">{privateOutput}</pre>
                  </ScrollArea>
                </div>
              </div>
            </CardContent>
          </Card>

          <div className={isDeveloperPage ? "mx-auto mt-5 grid max-w-[1080px] gap-3 pb-2 text-sm text-slate-600 md:grid-cols-4" : "mx-auto mt-5 hidden max-w-[1080px] gap-3 pb-2 text-sm text-slate-600 md:grid-cols-4"}>
            <div><span className="font-medium text-slate-900">Namespace:</span> <span>{activeNamespace}</span></div>
            <div><span className="font-medium text-slate-900">Signer:</span> <span>{signerAddress || "Preparing wallet..."}</span></div>
            <div><span className="font-medium text-slate-900">Wallet:</span> <span>{mode === "onchain" ? (walletAvailable ? "Detected" : "No injected wallet") : "Ephemeral signer"}</span></div>
            <div><span className="font-medium text-slate-900">Indexer:</span> {indexerLabel}</div>
          </div>
        </section>
      </div>
    </main>
    </TooltipProvider>
  );
}
