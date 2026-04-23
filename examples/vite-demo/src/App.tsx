import { startTransition, useEffect, useRef, useState } from "react";
import { BrowserProvider, Wallet, ZeroAddress, keccak256 } from "ethers";

import {
  EASKeyStore,
  EASScanIndexer,
  KNOWN_EAS_NETWORKS,
  MemoryIndexer,
  MemoryStorage,
  STORE_SCHEMA,
  StoreOperation,
  ensureSchema,
  getEASNetworkPresetByKey,
  type EASNetworkPreset,
  type StorageAdapter,
  type StoreMode,
  type StoredRecord
} from "@steerprotocol/eas-store";
import { SchemaBuilder } from "./schema-builder";

const DEFAULT_OFFCHAIN_EAS_ADDRESS =
  "0x0000000000000000000000000000000000000001" as const;
const DEFAULT_OFFCHAIN_SCHEMA_UID =
  "0x1111111111111111111111111111111111111111111111111111111111111111" as const;
const DEFAULT_NAMESPACE = "demo.profile";
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

type EnvConfig = {
  readonly VITE_EAS_NETWORK_KEY?: string;
  readonly VITE_EAS_CHAIN_ID?: string;
  readonly VITE_EAS_CONTRACT_ADDRESS?: string;
  readonly VITE_EAS_SCHEMA_REGISTRY_ADDRESS?: string;
  readonly VITE_EAS_SCHEMA_UID?: string;
  readonly VITE_EASSCAN_GRAPHQL_ENDPOINT?: string;
};

type KnownNetworkKey = EASNetworkPreset["key"] | "custom";
type WorkspaceStep = "setup" | "schema" | "records";
type OutputView = "latest" | "history" | "query";

type OnchainConfigInput = {
  networkKey: KnownNetworkKey;
  chainId: string;
  easContractAddress: string;
  schemaRegistryAddress: string;
  schemaUID: string;
  graphqlEndpoint: string;
};

type SchemaDraftInput = {
  resolverAddress: string;
  revocable: boolean;
};

type ResolvedOnchainConfig = {
  chainId: number;
  easContractAddress: `0x${string}`;
  schemaRegistryAddress: `0x${string}`;
  schemaUID?: `0x${string}`;
  graphqlEndpoint?: string;
};

type DemoStore = {
  store: EASKeyStore;
  signerAddress: string;
  storageLabel: string;
  indexerLabel: string;
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

function getEnvConfig(): OnchainConfigInput {
  const env = import.meta.env as ImportMetaEnv & EnvConfig;
  const defaultPreset = getDefaultPreset();
  const requestedKey = env.VITE_EAS_NETWORK_KEY;
  const preset =
    requestedKey === "base" || requestedKey === "base-sepolia"
      ? getEASNetworkPresetByKey(requestedKey)
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
    schemaUID: env.VITE_EAS_SCHEMA_UID ?? "",
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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";

  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index] ?? 0);
  }

  return window.btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

class LocalStorageStorage implements StorageAdapter {
  constructor(private readonly scope: string) {}

  async put(bytes: Uint8Array, contentType: string): Promise<string> {
    const digest = keccak256(bytes).slice(2);
    const uri = `localstorage://${this.scope}/${digest}`;
    window.localStorage.setItem(
      uri,
      JSON.stringify({
        contentType,
        bytes: bytesToBase64(bytes)
      })
    );

    return uri;
  }

  async get(uri: string): Promise<Uint8Array> {
    const value = window.localStorage.getItem(uri);

    if (!value) {
      throw new Error(`Missing storage object for URI: ${uri}`);
    }

    const parsed = JSON.parse(value) as { bytes?: string };

    if (!parsed.bytes) {
      throw new Error(`Corrupt local storage object for URI: ${uri}`);
    }

    return base64ToBytes(parsed.bytes);
  }
}

async function createOffchainDemoStore(namespace: string): Promise<DemoStore> {
  const signer = Wallet.createRandom();
  const address = (await signer.getAddress()) as `0x${string}`;
  const store = await EASKeyStore.create({
    chainId: 8453,
    easContractAddress: DEFAULT_OFFCHAIN_EAS_ADDRESS,
    easVersion: "1.3.0",
    schemaUID: DEFAULT_OFFCHAIN_SCHEMA_UID,
    namespace,
    mode: "offchain",
    signer,
    defaultRecipient: address,
    storage: new MemoryStorage(),
    indexer: new MemoryIndexer()
  });

  return {
    store,
    signerAddress: address,
    storageLabel: "MemoryStorage",
    indexerLabel: "MemoryIndexer"
  };
}

async function createOnchainWalletContext(input: OnchainConfigInput): Promise<{
  config: ResolvedOnchainConfig;
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
  const config = parseOnchainConfig(input, {
    requireSchemaUID: false
  });
  const network = await provider.getNetwork();

  if (Number(network.chainId) !== config.chainId) {
    throw new Error(
      `Connected wallet is on chain ${network.chainId.toString()}. Switch to chain ${config.chainId}.`
    );
  }

  return {
    config,
    provider,
    signer,
    address
  };
}

async function createOnchainDemoStore(
  namespace: string,
  configInput: OnchainConfigInput
): Promise<DemoStore> {
  const { config, provider, signer, address } = await createOnchainWalletContext(
    configInput
  );

  if (!config.schemaUID) {
    throw new Error("Schema UID is required. Publish a schema first or paste an existing UID.");
  }

  const storage = new LocalStorageStorage(
    `${config.chainId}:${config.schemaUID.toLowerCase()}:${namespace}`
  );
  const store = await EASKeyStore.create({
    chainId: config.chainId,
    easContractAddress: config.easContractAddress,
    schemaUID: config.schemaUID,
    namespace,
    mode: "onchain",
    signer: signer as never,
    provider: provider as never,
    defaultRecipient: address,
    storage,
    indexer: config.graphqlEndpoint
      ? new EASScanIndexer({
          endpoint: config.graphqlEndpoint
        })
      : new MemoryIndexer()
  });

  return {
    store,
    signerAddress: address,
    storageLabel: "LocalStorageStorage",
    indexerLabel: config.graphqlEndpoint ? "EASScanIndexer" : "MemoryIndexer"
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

function getSchemaFieldCount(schema: string): number {
  return schema
    .split(",")
    .map((segment) => segment.trim())
    .filter(Boolean).length;
}

const STEP_META: Record<
  WorkspaceStep,
  { title: string; description: string; badge: string }
> = {
  setup: {
    title: "Network Setup",
    description: "Choose the target network and prepare a wallet-backed client.",
    badge: "1"
  },
  schema: {
    title: "Schema Builder",
    description: "Publish a schema or reuse an existing UID before writing records.",
    badge: "2"
  },
  records: {
    title: "Record Workspace",
    description: "Read, write, delete, and inspect attested key-value records.",
    badge: "3"
  }
};

export default function App() {
  const storeRef = useRef<DemoStore | null>(null);
  const [mode, setMode] = useState<StoreMode>("offchain");
  const [currentStep, setCurrentStep] = useState<WorkspaceStep>("records");
  const [outputView, setOutputView] = useState<OutputView>("latest");
  const [showAdvancedNetwork, setShowAdvancedNetwork] = useState(false);
  const [showAdvancedSchema, setShowAdvancedSchema] = useState(false);
  const [namespaceInput, setNamespaceInput] = useState(DEFAULT_NAMESPACE);
  const [activeNamespace, setActiveNamespace] = useState(DEFAULT_NAMESPACE);
  const [key, setKey] = useState(DEFAULT_KEY);
  const [valueText, setValueText] = useState(DEFAULT_VALUE);
  const [onchainConfig, setOnchainConfig] = useState<OnchainConfigInput>(getEnvConfig);
  const [schemaDefinition, setSchemaDefinition] = useState(DEFAULT_SCHEMA_DEFINITION);
  const [schemaDraft, setSchemaDraft] = useState<SchemaDraftInput>({
    resolverAddress: ZeroAddress,
    revocable: true
  });
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

  function clearOutputs(nextAction: string) {
    startTransition(() => {
      setLatestRecord("null");
      setHistoryRecords("[]");
      setQueryRecords("[]");
      setOutputView("query");
      setLastAction(nextAction);
    });
  }

  function applyDemoStore(nextStore: DemoStore, namespace: string, action: string) {
    storeRef.current = nextStore;
    setSignerAddress(nextStore.signerAddress);
    setStorageLabel(nextStore.storageLabel);
    setIndexerLabel(nextStore.indexerLabel);
    setActiveNamespace(namespace);
    clearOutputs(action);
    setStatus("Ready");
  }

  function invalidateOnchainClient(nextAction: string) {
    storeRef.current = null;
    setStorageLabel("LocalStorageStorage");
    setIndexerLabel(onchainConfig.graphqlEndpoint.trim() ? "EASScanIndexer" : "MemoryIndexer");
    setLatestRecord("null");
    setHistoryRecords("[]");
    setQueryRecords("[]");
    setLastAction(nextAction);
  }

  useEffect(() => {
    setCurrentStep(mode === "onchain" ? "setup" : "records");
  }, [mode]);

  useEffect(() => {
    if (schemaDefinition.trim() !== STORE_SCHEMA) {
      setShowAdvancedSchema(true);
    }
  }, [schemaDefinition]);

  useEffect(() => {
    let cancelled = false;

    async function bootOffchainMode() {
      if (mode !== "offchain") {
        setSignerAddress("");
        setStatus("Wallet connection required");
        invalidateOnchainClient(
          "Switch to onchain mode, complete setup, then connect a wallet before running record operations."
        );
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

        applyDemoStore(
          nextStore,
          namespace,
          "Offchain workspace initialized with a fresh random signer."
        );
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
    action: (store: EASKeyStore) => Promise<void>
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
      applyDemoStore(
        nextStore,
        namespace,
        "Offchain workspace reset. Memory storage and indexer were cleared."
      );
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
      applyDemoStore(
        nextStore,
        namespace,
        onchainConfig.graphqlEndpoint.trim()
          ? "Onchain client initialized with wallet + EASScan verified reads."
          : "Onchain client initialized with wallet + in-session memory indexing."
      );
      setCurrentStep("records");
    } catch (cause) {
      setStatus("Failed");
      setError(cause instanceof Error ? cause.message : String(cause));
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

      const resolverAddress = schemaDraft.resolverAddress.trim();

      if (resolverAddress && !isHexAddress(resolverAddress)) {
        throw new Error("Resolver address must be a 20-byte hex address.");
      }

      const { config, signer, address } = await createOnchainWalletContext(onchainConfig);
      const registered = await ensureSchema(
        {
          chainId: config.chainId,
          easContractAddress: config.easContractAddress,
          schemaRegistryAddress: config.schemaRegistryAddress,
          signer
        },
        {
          schema,
          resolverAddress: (
            resolverAddress ? resolverAddress : ZeroAddress
          ) as `0x${string}`,
          revocable: schemaDraft.revocable
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
      setCurrentStep("records");
    } catch (cause) {
      setStatus("Failed");
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  function handleNetworkChange(nextKey: KnownNetworkKey) {
    if (nextKey === "custom") {
      setShowAdvancedNetwork(true);
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
    setShowAdvancedNetwork(false);
  }

  const controlsDisabled = busy || !storeRef.current;
  const walletAvailable = Boolean(getInjectedProvider());
  const selectedPreset = resolvePreset(onchainConfig.networkKey);
  const schemaFieldCount = getSchemaFieldCount(schemaDefinition);
  const schemaReady = Boolean(onchainConfig.schemaUID.trim());
  const usesDefaultSchema = schemaDefinition.trim() === STORE_SCHEMA;
  const stepOrder =
    mode === "onchain"
      ? (["setup", "schema", "records"] as const)
      : (["records"] as const);

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

  return (
    <main className="playground-shell">
      <header className="playground-hero">
        <div className="hero-copy">
          <p className="brand-kicker">Steer Protocol</p>
          <h1>EAS Store Playground</h1>
          <p className="brand-copy">
            A compact operator desk for publishing an EAS schema, wiring a store,
            and pressure-testing record flows in the browser.
          </p>
        </div>

        <div className="hero-controls">
          <div className="status-chip" data-testid="demo-status">
            {busy ? "Running" : status}
          </div>
          <div className="mode-switch" data-testid="mode-switch">
            <button
              type="button"
              className={mode === "offchain" ? "mode-option active" : "mode-option"}
              data-testid="mode-offchain"
              disabled={busy}
              onClick={() => setMode("offchain")}
            >
              Offchain
            </button>
            <button
              type="button"
              className={mode === "onchain" ? "mode-option active" : "mode-option"}
              data-testid="mode-onchain"
              disabled={busy}
              onClick={() => setMode("onchain")}
            >
              Onchain
            </button>
          </div>
        </div>
      </header>

      <section className="runtime-strip">
        <article className="runtime-card">
          <span>Mode</span>
          <strong data-testid="mode-label">
            {mode === "onchain" ? "Onchain" : "Offchain"}
          </strong>
        </article>
        <article className="runtime-card">
          <span>Namespace</span>
          <strong data-testid="active-namespace">{activeNamespace}</strong>
        </article>
        <article className="runtime-card">
          <span>Signer</span>
          <strong data-testid="signer-address">
            {signerAddress || (mode === "onchain" ? "Wallet not connected" : "Preparing wallet...")}
          </strong>
        </article>
        <article className="runtime-card">
          <span>Storage / Indexer</span>
          <strong>
            {storageLabel} / {indexerLabel}
          </strong>
        </article>
      </section>

      <section className="step-dock">
        {stepOrder.map((step) => (
          <button
            key={step}
            type="button"
            className={currentStep === step ? "dock-step active" : "dock-step"}
            onClick={() => setCurrentStep(step)}
          >
            <span className="dock-step-badge">{STEP_META[step].badge}</span>
            <span className="dock-step-copy">
              <strong>{STEP_META[step].title}</strong>
              <small>{STEP_META[step].description}</small>
            </span>
          </button>
        ))}
      </section>

      <section className="workspace-frame">
        <div className="workspace-header">
          <div>
            <p className="stage-eyebrow">{STEP_META[currentStep].badge}</p>
            <h2>{STEP_META[currentStep].title}</h2>
            <p>{STEP_META[currentStep].description}</p>
          </div>
          <div className="workspace-meta">
            <div className="meta-card">
              <span>Schema Status</span>
              <strong>{mode === "onchain" ? (schemaReady ? "UID ready" : "Not published") : "Demo UID loaded"}</strong>
            </div>
            <div className="meta-card">
              <span>Wallet</span>
              <strong data-testid="wallet-help">
                {mode === "onchain"
                  ? walletAvailable
                    ? "Detected"
                    : "No injected wallet"
                  : "Ephemeral signer"}
              </strong>
            </div>
          </div>
        </div>

        {error ? (
          <div className="error-banner" data-testid="error-output">
            {error}
          </div>
        ) : null}

        {currentStep === "setup" && mode === "onchain" ? (
          <div className="workspace-grid workspace-grid-setup">
            <article className="workspace-card spotlight-card">
              <div className="card-head">
                <div>
                  <p className="rail-label">Quick Setup</p>
                  <h3>Start from a known network</h3>
                  <p>
                    Pick a preset, choose the namespace, and either paste an existing
                    UID or publish one in the next step.
                  </p>
                </div>
                <div className="status-stack">
                  <span>Preset</span>
                  <strong data-testid="selected-network-label">
                    {selectedPreset?.label ?? "Custom network"}
                  </strong>
                </div>
              </div>

              <div className="field-grid compact-grid">
                <label className="field">
                  <span>Network</span>
                  <select
                    data-testid="network-select"
                    value={onchainConfig.networkKey}
                    onChange={(event) =>
                      handleNetworkChange(event.target.value as KnownNetworkKey)
                    }
                  >
                    {KNOWN_EAS_NETWORKS.map((preset) => (
                      <option key={preset.key} value={preset.key}>
                        {preset.label}
                      </option>
                    ))}
                    <option value="custom">Custom</option>
                  </select>
                </label>

                <label className="field">
                  <span>Namespace</span>
                  <input
                    data-testid="namespace-input"
                    value={namespaceInput}
                    onChange={(event) => setNamespaceInput(event.target.value)}
                    placeholder="demo.profile"
                  />
                </label>

                <label className="field">
                  <span>Chain ID</span>
                  <input
                    data-testid="chain-id-input"
                    value={onchainConfig.chainId}
                    readOnly={onchainConfig.networkKey !== "custom"}
                    onChange={(event) =>
                      setOnchainConfig((current) => ({
                        ...current,
                        chainId: event.target.value,
                        networkKey: "custom"
                      }))
                    }
                  />
                </label>

                <label className="field">
                  <span>EAS Contract</span>
                  <input
                    data-testid="eas-address-input"
                    value={onchainConfig.easContractAddress}
                    readOnly={onchainConfig.networkKey !== "custom"}
                    onChange={(event) =>
                      setOnchainConfig((current) => ({
                        ...current,
                        easContractAddress: event.target.value,
                        networkKey: "custom"
                      }))
                    }
                  />
                </label>

                <label className="field">
                  <span>Schema Registry</span>
                  <input
                    data-testid="schema-registry-input"
                    value={onchainConfig.schemaRegistryAddress}
                    readOnly={onchainConfig.networkKey !== "custom"}
                    onChange={(event) =>
                      setOnchainConfig((current) => ({
                        ...current,
                        schemaRegistryAddress: event.target.value,
                        networkKey: "custom"
                      }))
                    }
                  />
                </label>

                <label className="field">
                  <span>EASScan GraphQL Endpoint</span>
                  <input
                    data-testid="graphql-endpoint-input"
                    value={onchainConfig.graphqlEndpoint}
                    onChange={(event) =>
                      setOnchainConfig((current) => ({
                        ...current,
                        graphqlEndpoint: event.target.value
                      }))
                    }
                  />
                </label>

                <label className="field field-span">
                  <span>Schema UID</span>
                  <input
                    data-testid="schema-uid-input"
                    value={onchainConfig.schemaUID}
                    onChange={(event) =>
                      setOnchainConfig((current) => ({
                        ...current,
                        schemaUID: event.target.value
                      }))
                    }
                    placeholder="Publish a schema or paste an existing UID"
                  />
                </label>
              </div>

              <div className="summary-row">
                <div className="summary-chip">
                  <span>EAS</span>
                  <strong data-testid="eas-address-summary">{onchainConfig.easContractAddress}</strong>
                </div>
                <div className="summary-chip">
                  <span>Registry</span>
                  <strong data-testid="schema-registry-summary">{onchainConfig.schemaRegistryAddress}</strong>
                </div>
                <div className="summary-chip">
                  <span>GraphQL</span>
                  <strong data-testid="graphql-endpoint-summary">{onchainConfig.graphqlEndpoint}</strong>
                </div>
              </div>

              <details
                className="advanced-panel"
                open={showAdvancedNetwork || onchainConfig.networkKey === "custom"}
                onToggle={(event) =>
                  setShowAdvancedNetwork((event.target as HTMLDetailsElement).open)
                }
              >
                <summary>Advanced network configuration</summary>
                <div className="field-grid compact-grid">
                  <label className="field">
                    <span>Chain ID</span>
                    <input
                      data-testid="chain-id-input"
                      value={onchainConfig.chainId}
                      readOnly={onchainConfig.networkKey !== "custom"}
                      onChange={(event) =>
                        setOnchainConfig((current) => ({
                          ...current,
                          chainId: event.target.value,
                          networkKey: "custom"
                        }))
                      }
                    />
                  </label>
                  <label className="field">
                    <span>EAS Contract</span>
                    <input
                      value={onchainConfig.easContractAddress}
                      readOnly={onchainConfig.networkKey !== "custom"}
                      onChange={(event) =>
                        setOnchainConfig((current) => ({
                          ...current,
                          easContractAddress: event.target.value,
                          networkKey: "custom"
                        }))
                      }
                    />
                  </label>
                  <label className="field">
                    <span>Schema Registry</span>
                    <input
                      value={onchainConfig.schemaRegistryAddress}
                      readOnly={onchainConfig.networkKey !== "custom"}
                      onChange={(event) =>
                        setOnchainConfig((current) => ({
                          ...current,
                          schemaRegistryAddress: event.target.value,
                          networkKey: "custom"
                        }))
                      }
                    />
                  </label>
                  <label className="field">
                    <span>EASScan GraphQL Endpoint</span>
                    <input
                      value={onchainConfig.graphqlEndpoint}
                      onChange={(event) =>
                        setOnchainConfig((current) => ({
                          ...current,
                          graphqlEndpoint: event.target.value
                        }))
                      }
                    />
                  </label>
                </div>
              </details>
            </article>

            <article className="workspace-card utility-card">
              <div className="card-head">
                <div>
                  <p className="rail-label">Connection</p>
                  <h3>Bring a wallet when ready</h3>
                  <p>
                    The demo can prep the network without a wallet. Connection only
                    matters when you publish or send writes.
                  </p>
                </div>
              </div>

              <div className="signal-list">
                <div>
                  <span>Wallet status</span>
                  <strong>
                    {walletAvailable
                      ? "Injected wallet detected"
                      : "No injected wallet in this browser"}
                  </strong>
                </div>
                <div>
                  <span>Readiness</span>
                  <strong>{schemaReady ? "Ready to connect" : "Publish or paste a UID first"}</strong>
                </div>
              </div>

              <div className="action-strip">
                <button
                  type="button"
                  className="primary-action"
                  data-testid="connect-wallet-button"
                  disabled={busy}
                  onClick={() => {
                    void handleConnectWallet();
                  }}
                >
                  Connect Wallet
                </button>
                <button
                  type="button"
                  className="secondary-action"
                  disabled={busy}
                  onClick={() => setCurrentStep("schema")}
                >
                  Continue To Schema
                </button>
              </div>
            </article>
          </div>
        ) : null}

        {currentStep === "schema" && mode === "onchain" ? (
          <div className="workspace-grid workspace-grid-schema">
            <article className="workspace-card spotlight-card">
              <div className="card-head">
                <div>
                  <p className="rail-label">Schema Design</p>
                  <h3>Publish the envelope once</h3>
                  <p>
                    Keep the attestation envelope lean. Use the schema to anchor the
                    store, then put richer JSON in the record value itself.
                  </p>
                </div>
              </div>

              {!showAdvancedSchema && usesDefaultSchema ? (
                <div className="schema-preset-card" data-testid="schema-preset-card">
                  <div className="schema-preset-copy">
                    <p className="panel-note">Recommended Default</p>
                    <h4>Steer Store v1</h4>
                    <p>
                      This is the SDK-native store envelope. Use it unless you have a
                      strong reason to own a custom EAS schema.
                    </p>
                  </div>

                  <div className="summary-row">
                    <div className="summary-chip">
                      <span>Purpose</span>
                      <strong>Namespace + key + value pointer</strong>
                    </div>
                    <div className="summary-chip">
                      <span>Fields</span>
                      <strong>{schemaFieldCount} infrastructure fields</strong>
                    </div>
                    <div className="summary-chip">
                      <span>Best for</span>
                      <strong>Verified key-value records</strong>
                    </div>
                  </div>

                  <div className="schema-preset-outline">
                    <span>Includes</span>
                    <strong>namespace, key, value hash, value URI, content type, version, operation, previous UID, extra</strong>
                  </div>

                  <div className="action-strip">
                    <button
                      type="button"
                      className="secondary-action"
                      data-testid="show-raw-schema-button"
                      disabled={busy}
                      onClick={() => setShowAdvancedSchema(true)}
                    >
                      Customize Raw Schema
                    </button>
                  </div>
                </div>
              ) : (
                <SchemaBuilder
                  value={schemaDefinition}
                  disabled={busy}
                  onChange={setSchemaDefinition}
                />
              )}
            </article>

            <article className="workspace-card utility-card">
              <div className="card-head">
                <div>
                  <p className="rail-label">Publishing</p>
                  <h3>Finalize registry settings</h3>
                  <p>
                    Resolver and revocability define how the schema behaves once
                    published on the chosen network.
                  </p>
                </div>
              </div>

              <div className="summary-row summary-row-tight">
                <div className="summary-chip">
                  <span>Field count</span>
                  <strong>{schemaFieldCount}</strong>
                </div>
                <div className="summary-chip">
                  <span>Network</span>
                  <strong>{selectedPreset?.label ?? "Custom"}</strong>
                </div>
              </div>

              {!showAdvancedSchema && usesDefaultSchema ? (
                <div className="signal-list">
                  <div>
                    <span>Schema mode</span>
                    <strong>Default SDK schema selected</strong>
                  </div>
                  <div>
                    <span>Why this matters</span>
                    <strong>The SDK encoder expects this exact envelope shape for writes.</strong>
                  </div>
                  {schemaReady ? (
                    <div>
                      <span>Existing UID</span>
                      <strong>A schema UID is already loaded. You can connect the client without publishing again.</strong>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="field-grid compact-grid">
                <label className="field">
                  <span>Resolver Address</span>
                  <input
                    data-testid="resolver-address-input"
                    value={schemaDraft.resolverAddress}
                    onChange={(event) =>
                      setSchemaDraft((current) => ({
                        ...current,
                        resolverAddress: event.target.value
                      }))
                    }
                    placeholder={ZeroAddress}
                  />
                </label>

                <label className="field toggle-field">
                  <span>Revocable</span>
                  <span className="toggle-row">
                    <input
                      data-testid="schema-revocable-toggle"
                      type="checkbox"
                      checked={schemaDraft.revocable}
                      onChange={(event) =>
                        setSchemaDraft((current) => ({
                          ...current,
                          revocable: event.target.checked
                        }))
                      }
                    />
                    <strong>{schemaDraft.revocable ? "Enabled" : "Disabled"}</strong>
                  </span>
                </label>

                <label className="field field-span">
                  <span>Published Schema UID</span>
                  <input
                    data-testid="schema-uid-input"
                    value={onchainConfig.schemaUID}
                    onChange={(event) =>
                      setOnchainConfig((current) => ({
                        ...current,
                        schemaUID: event.target.value
                      }))
                    }
                    placeholder="Publish a schema or paste an existing UID"
                  />
                </label>
              </div>

              <div className="action-strip">
                {showAdvancedSchema ? (
                  <button
                    type="button"
                    className="secondary-action"
                    disabled={busy}
                    onClick={() => {
                      setSchemaDefinition(STORE_SCHEMA);
                      setShowAdvancedSchema(false);
                    }}
                  >
                    Use Recommended Default
                  </button>
                ) : null}
                {schemaReady ? (
                  <button
                    type="button"
                    className="primary-action"
                    data-testid="connect-wallet-from-schema-button"
                    disabled={busy}
                    onClick={() => {
                      void handleConnectWallet();
                    }}
                  >
                    Connect Wallet
                  </button>
                ) : (
                  <button
                    type="button"
                    className="primary-action"
                    data-testid="publish-schema-button"
                    disabled={busy}
                    onClick={() => {
                      void handlePublishSchema();
                    }}
                  >
                    Publish Schema
                  </button>
                )}
                {schemaReady ? (
                  <button
                    type="button"
                    className="secondary-action"
                    data-testid="publish-another-schema-button"
                    disabled={busy}
                    onClick={() => {
                      void handlePublishSchema();
                    }}
                  >
                    Publish Another Schema
                  </button>
                ) : null}
                <button
                  type="button"
                  className="secondary-action"
                  disabled={busy}
                  onClick={() => setCurrentStep("records")}
                >
                  Continue To Records
                </button>
              </div>
            </article>
          </div>
        ) : null}

        {currentStep === "records" ? (
          <div className="workspace-grid workspace-grid-records">
            <article className="workspace-card spotlight-card">
              <div className="card-head">
                  <div>
                    <p className="rail-label">Workspace</p>
                    <h3>Key / value operations</h3>
                    <p>
                      Write records, tombstone them, and inspect how the SDK resolves
                      the canonical head for the active namespace.
                    </p>
                  </div>
                  <button
                    type="button"
                    className="secondary-action"
                    data-testid="reset-button"
                    disabled={busy}
                    onClick={() => {
                      void handleReset();
                    }}
                  >
                    {mode === "onchain" ? "Reconnect Client" : "Reset Workspace"}
                  </button>
              </div>

              <div className="field-grid">
                  <label className="field field-span">
                    <span>Namespace</span>
                    <input
                      data-testid="namespace-input"
                      value={namespaceInput}
                      onChange={(event) => setNamespaceInput(event.target.value)}
                      placeholder="demo.profile"
                    />
                  </label>

                  <label className="field field-span">
                    <span>Key</span>
                    <input
                      data-testid="key-input"
                      value={key}
                      onChange={(event) => setKey(event.target.value)}
                      placeholder="profile:alice"
                    />
                  </label>

                  <label className="field field-span">
                    <span>JSON Value</span>
                    <textarea
                      data-testid="value-input"
                      value={valueText}
                      onChange={(event) => setValueText(event.target.value)}
                      rows={10}
                      spellCheck={false}
                    />
                  </label>
              </div>

              <div className="record-actions">
                  <button
                    type="button"
                    data-testid="set-button"
                    disabled={controlsDisabled}
                    onClick={() => {
                      void runAction("Writing attestation...", async (store) => {
                        const parsed = JSON.parse(valueText) as unknown;
                        const record = await store.set(key, parsed);
                        setLastAction(`Saved ${record.key} at version ${record.version}.`);
                        setLatestRecord(summarizeRecord(record));
                        setOutputView("latest");
                      });
                    }}
                  >
                    Set
                  </button>
                  <button
                    type="button"
                    data-testid="get-button"
                    disabled={controlsDisabled}
                    onClick={() => {
                      void runAction("Resolving canonical head...", async (store) => {
                        const record = await store.get(key);
                        setLastAction(
                          record
                            ? `Loaded canonical head for ${record.key}.`
                            : `No live record for ${key}.`
                        );
                        setLatestRecord(summarizeRecord(record));
                        setOutputView("latest");
                      });
                    }}
                  >
                    Get
                  </button>
                  <button
                    type="button"
                    data-testid="history-button"
                    disabled={controlsDisabled}
                    onClick={() => {
                      void runAction("Loading verified history...", async (store) => {
                        const history = await store.history(key);
                        setLastAction(`Loaded ${history.length} verified record(s) for ${key}.`);
                        setHistoryRecords(formatPayload(history));
                        setOutputView("history");
                      });
                    }}
                  >
                    History
                  </button>
                  <button
                    type="button"
                    data-testid="query-button"
                    disabled={controlsDisabled}
                    onClick={() => {
                      void runAction("Querying canonical heads...", async (store) => {
                        const records = await store.query();
                        setLastAction(`Query returned ${records.length} canonical head(s).`);
                        setQueryRecords(formatPayload(records));
                        setOutputView("query");
                      });
                    }}
                  >
                    Query All
                  </button>
                  <button
                    type="button"
                    className="danger-action"
                    data-testid="delete-button"
                    disabled={controlsDisabled}
                    onClick={() => {
                      void runAction("Writing tombstone...", async (store) => {
                        const record = await store.delete(key);
                        setLastAction(`Deleted ${record.key} with tombstone version ${record.version}.`);
                        setLatestRecord(summarizeRecord(record));
                        setOutputView("latest");
                      });
                    }}
                  >
                    Delete
                  </button>
              </div>
            </article>

            <article className="workspace-card utility-card">
              <div className="card-head inspector-head">
                <div>
                  <p className="rail-label">Inspector</p>
                  <h3>{outputTitle}</h3>
                  <p>
                    Switch between the canonical head, full history, and current query
                    results without leaving the record workspace.
                  </p>
                </div>
                <div className="output-tabs">
                    <button
                      type="button"
                      className={outputView === "latest" ? "output-tab active" : "output-tab"}
                      onClick={() => setOutputView("latest")}
                    >
                      Latest
                    </button>
                    <button
                      type="button"
                      className={outputView === "history" ? "output-tab active" : "output-tab"}
                      onClick={() => setOutputView("history")}
                    >
                      History
                    </button>
                    <button
                      type="button"
                      className={outputView === "query" ? "output-tab active" : "output-tab"}
                      onClick={() => setOutputView("query")}
                    >
                      Query
                    </button>
                  </div>
              </div>

              <pre
                data-testid={
                  outputView === "latest"
                    ? "latest-record"
                    : outputView === "history"
                      ? "history-output"
                      : "query-output"
                }
              >
                {outputValue}
              </pre>

              <div className="activity-card">
                <p className="rail-label">Last Action</p>
                <p data-testid="last-action">{lastAction}</p>
              </div>
            </article>
          </div>
        ) : null}
      </section>
    </main>
  );
}
