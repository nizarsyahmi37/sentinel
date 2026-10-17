/**
 * Known tokenized-equity contracts. PROVENANCE: addresses were taken from the
 * CoinGecko coin list (a third-party aggregator) and then verified on-chain by
 * Sentinel's own reader on 2026-10-16: the address has contract code and the
 * contract's own symbol() equals the listed symbol. They have NOT been
 * cross-checked against the issuers' official address lists — confirm with the
 * issuer before relying on one. Sentinel still verifies every token it assesses
 * on-chain at request time; this registry only saves typing.
 */
export interface KnownToken {
  underlying: string;
  issuer: string;
  chain: "bsc" | "ethereum" | "arbitrum";
  address: string;
  symbol: string;
  name: string;
  decimals: number | null;
}

export const TOKEN_REGISTRY_PROVENANCE = {
  summary: "third-party listing + on-chain symbol check; not issuer-confirmed",
  source: "CoinGecko coin list (api.coingecko.com/api/v3/coins/list?include_platform=true)",
  verified_on: "2026-10-16",
  checks: ["contract code present at the address", "on-chain symbol() equals the listed symbol"],
  issuer_list_confirmed: false,
  warning: "Always confirm the address against the issuer's official list before relying on it.",
};

export const KNOWN_TOKENS: KnownToken[] = [
  { underlying: "AAPL", issuer: "Ondo Global Markets", chain: "bsc", address: "0x390a684ef9cade28a7ad0dfa61ab1eb3842618c4", symbol: "AAPLon", name: "Apple (Ondo Tokenized)", decimals: 18 },
  { underlying: "AAPL", issuer: "Ondo Global Markets", chain: "ethereum", address: "0x14c3abf95cb9c93a8b82c1cdcb76d72cb87b2d4c", symbol: "AAPLon", name: "Apple (Ondo Tokenized)", decimals: 18 },
  { underlying: "AAPL", issuer: "xStocks (Backed Finance)", chain: "bsc", address: "0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a", symbol: "AAPLx", name: "Apple xStock", decimals: 18 },
  { underlying: "AAPL", issuer: "xStocks (Backed Finance)", chain: "ethereum", address: "0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a", symbol: "AAPLx", name: "Apple xStock", decimals: 18 },
  { underlying: "AAPL", issuer: "xStocks (Backed Finance)", chain: "arbitrum", address: "0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a", symbol: "AAPLx", name: "Apple xStock", decimals: 18 },
  { underlying: "GOOGL", issuer: "Ondo Global Markets", chain: "bsc", address: "0x091fc7778e6932d4009b087b191d1ee3bac5729a", symbol: "GOOGLon", name: "Alphabet Class A (Ondo Tokenized)", decimals: 18 },
  { underlying: "GOOGL", issuer: "Ondo Global Markets", chain: "ethereum", address: "0xba47214edd2bb43099611b208f75e4b42fdcfedc", symbol: "GOOGLon", name: "Alphabet Class A (Ondo Tokenized)", decimals: 18 },
  { underlying: "GOOGL", issuer: "xStocks (Backed Finance)", chain: "bsc", address: "0xe92f673ca36c5e2efd2de7628f815f84807e803f", symbol: "GOOGLx", name: "Alphabet xStock", decimals: 18 },
  { underlying: "GOOGL", issuer: "xStocks (Backed Finance)", chain: "ethereum", address: "0xe92f673ca36c5e2efd2de7628f815f84807e803f", symbol: "GOOGLx", name: "Alphabet xStock", decimals: 18 },
  { underlying: "GOOGL", issuer: "xStocks (Backed Finance)", chain: "arbitrum", address: "0xe92f673ca36c5e2efd2de7628f815f84807e803f", symbol: "GOOGLx", name: "Alphabet xStock", decimals: 18 },
  { underlying: "NVDA", issuer: "Ondo Global Markets", chain: "bsc", address: "0xa9ee28c80f960b889dfbd1902055218cba016f75", symbol: "NVDAon", name: "NVIDIA (Ondo Tokenized)", decimals: 18 },
  { underlying: "NVDA", issuer: "Ondo Global Markets", chain: "ethereum", address: "0x2d1f7226bd1f780af6b9a49dcc0ae00e8df4bdee", symbol: "NVDAon", name: "NVIDIA (Ondo Tokenized)", decimals: 18 },
  { underlying: "NVDA", issuer: "xStocks (Backed Finance)", chain: "bsc", address: "0xc845b2894dbddd03858fd2d643b4ef725fe0849d", symbol: "NVDAx", name: "NVIDIA xStock", decimals: 18 },
  { underlying: "NVDA", issuer: "xStocks (Backed Finance)", chain: "ethereum", address: "0xc845b2894dbddd03858fd2d643b4ef725fe0849d", symbol: "NVDAx", name: "NVIDIA xStock", decimals: 18 },
  { underlying: "NVDA", issuer: "xStocks (Backed Finance)", chain: "arbitrum", address: "0xc845b2894dbddd03858fd2d643b4ef725fe0849d", symbol: "NVDAx", name: "NVIDIA xStock", decimals: 18 },
  { underlying: "META", issuer: "Ondo Global Markets", chain: "bsc", address: "0xd7df5863a3e742f0c767768cdfcb63f09e0422f6", symbol: "METAon", name: "Meta Platforms (Ondo Tokenized)", decimals: 18 },
  { underlying: "META", issuer: "Ondo Global Markets", chain: "ethereum", address: "0x59644165402b611b350645555b50afb581c71eb2", symbol: "METAon", name: "Meta Platforms (Ondo Tokenized)", decimals: 18 },
  { underlying: "META", issuer: "xStocks (Backed Finance)", chain: "bsc", address: "0x96702be57cd9777f835117a809c7124fe4ec989a", symbol: "METAx", name: "Meta xStock", decimals: 18 },
  { underlying: "META", issuer: "xStocks (Backed Finance)", chain: "ethereum", address: "0x96702be57cd9777f835117a809c7124fe4ec989a", symbol: "METAx", name: "Meta xStock", decimals: 18 },
  { underlying: "META", issuer: "xStocks (Backed Finance)", chain: "arbitrum", address: "0x96702be57cd9777f835117a809c7124fe4ec989a", symbol: "METAx", name: "Meta xStock", decimals: 18 },
  { underlying: "TSLA", issuer: "Ondo Global Markets", chain: "bsc", address: "0x2494b603319d4d9f9715c9f4496d9e0364b59d93", symbol: "TSLAon", name: "Tesla (Ondo Tokenized)", decimals: 18 },
  { underlying: "TSLA", issuer: "Ondo Global Markets", chain: "ethereum", address: "0xf6b1117ec07684d3958cad8beb1b302bfd21103f", symbol: "TSLAon", name: "Tesla (Ondo Tokenized)", decimals: 18 },
  { underlying: "TSLA", issuer: "xStocks (Backed Finance)", chain: "bsc", address: "0x8ad3c73f833d3f9a523ab01476625f269aeb7cf0", symbol: "TSLAx", name: "Tesla xStock", decimals: 18 },
  { underlying: "TSLA", issuer: "xStocks (Backed Finance)", chain: "arbitrum", address: "0x8ad3c73f833d3f9a523ab01476625f269aeb7cf0", symbol: "TSLAx", name: "Tesla xStock", decimals: 18 },
  { underlying: "AMZN", issuer: "Ondo Global Markets", chain: "bsc", address: "0x4553cfe1c09f37f38b12dc509f676964e392f8fc", symbol: "AMZNon", name: "Amazon (Ondo Tokenized)", decimals: 18 },
  { underlying: "AMZN", issuer: "Ondo Global Markets", chain: "ethereum", address: "0xbb8774fb97436d23d74c1b882e8e9a69322cfd31", symbol: "AMZNon", name: "Amazon (Ondo Tokenized)", decimals: 18 },
  { underlying: "AMZN", issuer: "xStocks (Backed Finance)", chain: "bsc", address: "0x3557ba345b01efa20a1bddc61f573bfd87195081", symbol: "AMZNx", name: "Amazon.com xStock", decimals: 18 },
  { underlying: "AMZN", issuer: "xStocks (Backed Finance)", chain: "ethereum", address: "0x3557ba345b01efa20a1bddc61f573bfd87195081", symbol: "AMZNx", name: "Amazon.com xStock", decimals: 18 },
  { underlying: "AMZN", issuer: "xStocks (Backed Finance)", chain: "arbitrum", address: "0x3557ba345b01efa20a1bddc61f573bfd87195081", symbol: "AMZNx", name: "Amazon.com xStock", decimals: 18 },
  { underlying: "NFLX", issuer: "Ondo Global Markets", chain: "bsc", address: "0x7048f5227b032326cc8dbc53cf3fddd947a2c757", symbol: "NFLXon", name: "Netflix (Ondo Tokenized)", decimals: 18 },
  { underlying: "NFLX", issuer: "Ondo Global Markets", chain: "ethereum", address: "0x032dec3372f25c41ea8054b4987a7c4832cdb338", symbol: "NFLXon", name: "Netflix (Ondo Tokenized)", decimals: 18 },
  { underlying: "NFLX", issuer: "xStocks (Backed Finance)", chain: "bsc", address: "0xa6a65ac27e76cd53cb790473e4345c46e5ebf961", symbol: "NFLXx", name: "Netflix xStock", decimals: 18 },
  { underlying: "NFLX", issuer: "xStocks (Backed Finance)", chain: "arbitrum", address: "0xa6a65ac27e76cd53cb790473e4345c46e5ebf961", symbol: "NFLXx", name: "Netflix xStock", decimals: 18 },
  { underlying: "MSFT", issuer: "Ondo Global Markets", chain: "bsc", address: "0x6bfe75d1ad432050ea973c3a3dcd88f02e2444c3", symbol: "MSFTon", name: "Microsoft (Ondo Tokenized)", decimals: 18 },
  { underlying: "MSFT", issuer: "Ondo Global Markets", chain: "ethereum", address: "0xb812837b81a3a6b81d7cd74cfb19a7f2784555e5", symbol: "MSFTon", name: "Microsoft (Ondo Tokenized)", decimals: 18 },
  { underlying: "MSFT", issuer: "xStocks (Backed Finance)", chain: "bsc", address: "0x5621737f42dae558b81269fcb9e9e70c19aa6b35", symbol: "MSFTx", name: "Microsoft xStock", decimals: 18 },
  { underlying: "MSFT", issuer: "xStocks (Backed Finance)", chain: "ethereum", address: "0x5621737f42dae558b81269fcb9e9e70c19aa6b35", symbol: "MSFTx", name: "Microsoft xStock", decimals: 18 },
  { underlying: "MSFT", issuer: "xStocks (Backed Finance)", chain: "arbitrum", address: "0x5621737f42dae558b81269fcb9e9e70c19aa6b35", symbol: "MSFTx", name: "Microsoft xStock", decimals: 18 },
  { underlying: "QQQ", issuer: "Ondo Global Markets", chain: "bsc", address: "0x0cde6936d305d5b34667fc46425e852efd73559a", symbol: "QQQon", name: "Invesco QQQ (Ondo Tokenized)", decimals: 18 },
  { underlying: "QQQ", issuer: "Ondo Global Markets", chain: "ethereum", address: "0x0e397938c1aa0680954093495b70a9f5e2249aba", symbol: "QQQon", name: "Invesco QQQ (Ondo Tokenized)", decimals: 18 },
  { underlying: "QQQ", issuer: "xStocks (Backed Finance)", chain: "bsc", address: "0xa753a7395cae905cd615da0b82a53e0560f250af", symbol: "QQQx", name: "Nasdaq xStock", decimals: 18 },
  { underlying: "QQQ", issuer: "xStocks (Backed Finance)", chain: "ethereum", address: "0xa753a7395cae905cd615da0b82a53e0560f250af", symbol: "QQQx", name: "Nasdaq xStock", decimals: 18 },
  { underlying: "QQQ", issuer: "xStocks (Backed Finance)", chain: "arbitrum", address: "0xa753a7395cae905cd615da0b82a53e0560f250af", symbol: "QQQx", name: "Nasdaq xStock", decimals: 18 },
  { underlying: "SPY", issuer: "Ondo Global Markets", chain: "bsc", address: "0x6a708ead771238919d85930b5a0f10454e1c331a", symbol: "SPYon", name: "SPDR S&P 500 ETF (Ondo Tokenized)", decimals: 18 },
  { underlying: "SPY", issuer: "Ondo Global Markets", chain: "ethereum", address: "0xfedc5f4a6c38211c1338aa411018dfaf26612c08", symbol: "SPYon", name: "SPDR S&P 500 ETF (Ondo Tokenized)", decimals: 18 },
  { underlying: "SPY", issuer: "xStocks (Backed Finance)", chain: "bsc", address: "0x90a2a4c76b5d8c0bc892a69ea28aa775a8f2dd48", symbol: "SPYx", name: "SP500 xStock", decimals: 18 },
  { underlying: "SPY", issuer: "xStocks (Backed Finance)", chain: "ethereum", address: "0x90a2a4c76b5d8c0bc892a69ea28aa775a8f2dd48", symbol: "SPYx", name: "SP500 xStock", decimals: 18 },
  { underlying: "SPY", issuer: "xStocks (Backed Finance)", chain: "arbitrum", address: "0x90a2a4c76b5d8c0bc892a69ea28aa775a8f2dd48", symbol: "SPYx", name: "SP500 xStock", decimals: 18 },
];
