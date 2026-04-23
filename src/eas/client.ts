import {
  EAS,
  Offchain,
  OffchainAttestationVersion,
  type TransactionProvider,
  type TransactionSigner
} from "@ethereum-attestation-service/eas-sdk";

import { ConfigurationError } from "../errors";
import type { EASRuntimeConfig, StoreSigner } from "../types";

function isTransactionSigner(value: unknown): value is TransactionSigner {
  return (
    typeof value === "object" &&
    value !== null &&
    "sendTransaction" in value &&
    typeof value.sendTransaction === "function" &&
    "estimateGas" in value &&
    typeof value.estimateGas === "function" &&
    "call" in value &&
    typeof value.call === "function" &&
    "resolveName" in value &&
    typeof value.resolveName === "function"
  );
}

function isTransactionProvider(value: unknown): value is TransactionProvider {
  return (
    typeof value === "object" &&
    value !== null &&
    "estimateGas" in value &&
    typeof value.estimateGas === "function" &&
    "call" in value &&
    typeof value.call === "function" &&
    "resolveName" in value &&
    typeof value.resolveName === "function"
  );
}

export function getTransactionSigner(
  signer?: StoreSigner
): TransactionSigner | undefined {
  return signer && isTransactionSigner(signer) ? signer : undefined;
}

export function getTransport(
  config: EASRuntimeConfig
): TransactionSigner | TransactionProvider | undefined {
  return getTransactionSigner(config.signer) ?? config.provider;
}

export function requireTypedDataSigner(signer?: StoreSigner): StoreSigner {
  if (!signer) {
    throw new ConfigurationError("A signer is required for write operations.");
  }

  return signer;
}

export function requireTransactionSigner(signer?: StoreSigner): TransactionSigner {
  const transactionSigner = getTransactionSigner(signer);

  if (!transactionSigner) {
    throw new ConfigurationError(
      "An onchain signer with sendTransaction/estimateGas/call support is required."
    );
  }

  return transactionSigner;
}

export function createEASClient(config: EASRuntimeConfig): EAS {
  const eas = new EAS(config.easContractAddress);
  const transport = getTransport(config);

  if (transport) {
    eas.connect(transport);
  }

  return eas;
}

export async function createOffchainClient(config: EASRuntimeConfig): Promise<Offchain> {
  const eas = createEASClient(config);

  if (config.easVersion) {
    return new Offchain(
      {
        address: config.easContractAddress,
        chainId: BigInt(config.chainId),
        version: config.easVersion
      },
      OffchainAttestationVersion.Version2,
      eas
    );
  }

  if (!getTransport(config)) {
    throw new ConfigurationError(
      "Offchain mode requires either a provider/signer connected to the EAS contract or an explicit easVersion."
    );
  }

  return (await eas.getOffchain()) as Offchain;
}

export function hasProvider(config: EASRuntimeConfig): boolean {
  return Boolean(getTransport(config));
}

export function hasTransactionProvider(value: unknown): value is TransactionProvider {
  return isTransactionProvider(value);
}
