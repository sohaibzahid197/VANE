// The coin universe.
//
// The paywall promises signals across a broad market, so the free tier shows
// one coin and Pro unlocks the rest. Kept in one place so the app, the
// refresh job and the marketing copy cannot drift apart.
//
// Ordered by market significance, NOT by score: the app gates on symbol
// (BTC free, everything else Pro), so a reorder here must never change which
// coin is free.

export type CoinMeta = { symbol: string; sym: string; name: string };

/** The one coin a free user sees in full. */
export const FREE_SYMBOL = 'BTC';

export const UNIVERSE: CoinMeta[] = [
  { symbol: 'BTCUSDT', sym: 'BTC', name: 'Bitcoin' },
  { symbol: 'ETHUSDT', sym: 'ETH', name: 'Ethereum' },
  { symbol: 'SOLUSDT', sym: 'SOL', name: 'Solana' },
  { symbol: 'XRPUSDT', sym: 'XRP', name: 'XRP' },
  { symbol: 'BNBUSDT', sym: 'BNB', name: 'BNB' },
  { symbol: 'DOGEUSDT', sym: 'DOGE', name: 'Dogecoin' },
  { symbol: 'ADAUSDT', sym: 'ADA', name: 'Cardano' },
  { symbol: 'TRXUSDT', sym: 'TRX', name: 'TRON' },
  { symbol: 'LINKUSDT', sym: 'LINK', name: 'Chainlink' },
  { symbol: 'AVAXUSDT', sym: 'AVAX', name: 'Avalanche' },
  { symbol: 'SUIUSDT', sym: 'SUI', name: 'Sui' },
  { symbol: 'DOTUSDT', sym: 'DOT', name: 'Polkadot' },
  { symbol: 'LTCUSDT', sym: 'LTC', name: 'Litecoin' },
  { symbol: 'BCHUSDT', sym: 'BCH', name: 'Bitcoin Cash' },
  { symbol: 'NEARUSDT', sym: 'NEAR', name: 'NEAR Protocol' },
  { symbol: 'UNIUSDT', sym: 'UNI', name: 'Uniswap' },
  { symbol: 'APTUSDT', sym: 'APT', name: 'Aptos' },
  { symbol: 'ICPUSDT', sym: 'ICP', name: 'Internet Computer' },
  { symbol: 'ETCUSDT', sym: 'ETC', name: 'Ethereum Classic' },
  { symbol: 'XLMUSDT', sym: 'XLM', name: 'Stellar' },
  { symbol: 'FILUSDT', sym: 'FIL', name: 'Filecoin' },
  { symbol: 'ATOMUSDT', sym: 'ATOM', name: 'Cosmos' },
  { symbol: 'ARBUSDT', sym: 'ARB', name: 'Arbitrum' },
  { symbol: 'OPUSDT', sym: 'OP', name: 'Optimism' },
  { symbol: 'INJUSDT', sym: 'INJ', name: 'Injective' },
  { symbol: 'AAVEUSDT', sym: 'AAVE', name: 'Aave' },
  { symbol: 'RENDERUSDT', sym: 'RENDER', name: 'Render' },
  { symbol: 'SEIUSDT', sym: 'SEI', name: 'Sei' },
  { symbol: 'TIAUSDT', sym: 'TIA', name: 'Celestia' },
  { symbol: 'ALGOUSDT', sym: 'ALGO', name: 'Algorand' },
];
