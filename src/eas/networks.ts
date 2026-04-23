import type { Address } from "../types";

export interface EASNetworkPreset {
  readonly key: "base" | "base-sepolia";
  readonly label: string;
  readonly chainId: number;
  readonly easVersion: "1.3.0";
  readonly easContractAddress: Address;
  readonly schemaRegistryAddress: Address;
  readonly graphqlEndpoint: string;
}

export const KNOWN_EAS_NETWORKS: readonly EASNetworkPreset[] = [
  {
    key: "base",
    label: "Base",
    chainId: 8453,
    easVersion: "1.3.0",
    easContractAddress: "0x4200000000000000000000000000000000000021",
    schemaRegistryAddress: "0x4200000000000000000000000000000000000020",
    graphqlEndpoint: "https://base.easscan.org/graphql"
  },
  {
    key: "base-sepolia",
    label: "Base Sepolia",
    chainId: 84532,
    easVersion: "1.3.0",
    easContractAddress: "0x4200000000000000000000000000000000000021",
    schemaRegistryAddress: "0x4200000000000000000000000000000000000020",
    graphqlEndpoint: "https://base-sepolia.easscan.org/graphql"
  }
] as const;

export function getEASNetworkPreset(
  chainId: number
): EASNetworkPreset | undefined {
  return KNOWN_EAS_NETWORKS.find((preset) => preset.chainId === chainId);
}

export function getEASNetworkPresetByKey(
  key: EASNetworkPreset["key"]
): EASNetworkPreset | undefined {
  return KNOWN_EAS_NETWORKS.find((preset) => preset.key === key);
}
