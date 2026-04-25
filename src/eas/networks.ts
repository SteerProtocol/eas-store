import type { Address } from "../types";

export interface EASNetworkPreset {
  readonly key:
    | "ethereum"
    | "sepolia"
    | "arbitrum"
    | "arbitrum-nova"
    | "base"
    | "base-sepolia"
    | "optimism"
    | "optimism-sepolia"
    | "scroll"
    | "polygon"
    | "linea"
    | "celo";
  readonly label: string;
  readonly chainId: number;
  readonly easVersion: string;
  readonly easContractAddress: Address;
  readonly schemaRegistryAddress: Address;
  readonly graphqlEndpoint: string;
}

export const KNOWN_EAS_NETWORKS: readonly EASNetworkPreset[] = [
  {
    key: "ethereum",
    label: "Ethereum",
    chainId: 1,
    easVersion: "0.26",
    easContractAddress: "0xA1207F3BBa224E2c9c3c6D5aF63D0eb1582Ce587",
    schemaRegistryAddress: "0xA7b39296258348C78294F95B872b282326A97BDF",
    graphqlEndpoint: "https://easscan.org/graphql"
  },
  {
    key: "sepolia",
    label: "Sepolia",
    chainId: 11155111,
    easVersion: "0.26",
    easContractAddress: "0xC2679fBD37d54388Ce493F1DB75320D236e1815e",
    schemaRegistryAddress: "0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0",
    graphqlEndpoint: "https://sepolia.easscan.org/graphql"
  },
  {
    key: "arbitrum",
    label: "Arbitrum One",
    chainId: 42161,
    easVersion: "0.26",
    easContractAddress: "0xbD75f629A22Dc1ceD33dDA0b68c546A1c035c458",
    schemaRegistryAddress: "0xA310da9c5B885E7fb3fbA9D66E9Ba6Df512b78eB",
    graphqlEndpoint: "https://arbitrum.easscan.org/graphql"
  },
  {
    key: "arbitrum-nova",
    label: "Arbitrum Nova",
    chainId: 42170,
    easVersion: "1.3.0",
    easContractAddress: "0x6d3dC0Fe5351087E3Af3bDe8eB3F7350ed894fc3",
    schemaRegistryAddress: "0x49563d0DA8DF38ef2eBF9C1167270334D72cE0AE",
    graphqlEndpoint: "https://arbitrum-nova.easscan.org/graphql"
  },
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
  },
  {
    key: "optimism",
    label: "Optimism",
    chainId: 10,
    easVersion: "1.0.1",
    easContractAddress: "0x4200000000000000000000000000000000000021",
    schemaRegistryAddress: "0x4200000000000000000000000000000000000020",
    graphqlEndpoint: "https://optimism.easscan.org/graphql"
  },
  {
    key: "optimism-sepolia",
    label: "Optimism Sepolia",
    chainId: 11155420,
    easVersion: "1.0.2",
    easContractAddress: "0x4200000000000000000000000000000000000021",
    schemaRegistryAddress: "0x4200000000000000000000000000000000000020",
    graphqlEndpoint: "https://optimism-sepolia-bedrock.easscan.org/graphql"
  },
  {
    key: "scroll",
    label: "Scroll",
    chainId: 534352,
    easVersion: "1.3.0",
    easContractAddress: "0xC47300428b6AD2c7D03BB76D05A176058b47E6B0",
    schemaRegistryAddress: "0xD2CDF46556543316e7D34e8eDc4624e2bB95e3B6",
    graphqlEndpoint: "https://scroll.easscan.org/graphql"
  },
  {
    key: "polygon",
    label: "Polygon",
    chainId: 137,
    easVersion: "1.3.0",
    easContractAddress: "0x5E634ef5355f45A855d02D66eCD687b1502AF790",
    schemaRegistryAddress: "0x7876EEF51A891E737AF8ba5A5E0f0Fd29073D5a7",
    graphqlEndpoint: "https://polygon.easscan.org/graphql"
  },
  {
    key: "linea",
    label: "Linea",
    chainId: 59144,
    easVersion: "1.2.0",
    easContractAddress: "0xaEF4103A04090071165F78D45D83A0C0782c2B2a",
    schemaRegistryAddress: "0x55D26f9ae0203EF95494AE4C170eD35f4Cf77797",
    graphqlEndpoint: "https://linea.easscan.org/graphql"
  },
  {
    key: "celo",
    label: "Celo",
    chainId: 42220,
    easVersion: "1.3.0",
    easContractAddress: "0x72E1d8ccf5299fb36fEfD8CC4394B8ef7e98Af92",
    schemaRegistryAddress: "0x5ece93bE4BDCF293Ed61FA78698B594F2135AF34",
    graphqlEndpoint: "https://celo.easscan.org/graphql"
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
