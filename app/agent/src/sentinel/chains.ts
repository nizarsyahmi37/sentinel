/** Supported EVM chains for token verification (read-only JSON-RPC). */
export interface ChainInfo {
  id: string;
  label: string;
  rpcs: string[];
  explorer: string;
  env: string;
  testnet: boolean;
}

export const CHAINS: Record<string, ChainInfo> = {
  bsc: { id: "bsc", label: "BNB Smart Chain", rpcs: ["https://bsc-dataseed.bnbchain.org", "https://bsc-rpc.publicnode.com"], explorer: "https://bscscan.com", env: "SENTINEL_BSC_RPC", testnet: false },
  "bsc-testnet": { id: "bsc-testnet", label: "BSC testnet", rpcs: ["https://data-seed-prebsc-1-s1.bnbchain.org:8545", "https://bsc-testnet-rpc.publicnode.com"], explorer: "https://testnet.bscscan.com", env: "SENTINEL_BSC_TESTNET_RPC", testnet: true },
  ethereum: { id: "ethereum", label: "Ethereum", rpcs: ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com"], explorer: "https://etherscan.io", env: "SENTINEL_ETHEREUM_RPC", testnet: false },
  arbitrum: { id: "arbitrum", label: "Arbitrum One", rpcs: ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com"], explorer: "https://arbiscan.io", env: "SENTINEL_ARBITRUM_RPC", testnet: false },
  base: { id: "base", label: "Base", rpcs: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"], explorer: "https://basescan.org", env: "SENTINEL_BASE_RPC", testnet: false },
  polygon: { id: "polygon", label: "Polygon PoS", rpcs: ["https://polygon-bor-rpc.publicnode.com", "https://polygon-rpc.com"], explorer: "https://polygonscan.com", env: "SENTINEL_POLYGON_RPC", testnet: false },
};

export const CHAIN_IDS = Object.keys(CHAINS) as [string, ...string[]];
export const explorerUrl = (chain: string, kind: "address" | "tx", v: string) => `${CHAINS[chain]?.explorer ?? CHAINS.bsc!.explorer}/${kind}/${v}`;
export const chainLabel = (chain: string) => CHAINS[chain]?.label ?? chain;
