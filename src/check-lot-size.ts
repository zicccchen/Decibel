import "dotenv/config";
import { DecibelReadDex, MAINNET_CONFIG } from "@decibeltrade/sdk";
import { CONFIG } from "./config.js";

async function main() {
  const readDex = new DecibelReadDex({
    ...MAINNET_CONFIG,
    fullnodeUrl: CONFIG.FULLNODE_URL,
    tradingHttpUrl: CONFIG.DECIBEL_REST_URL,
    tradingWsUrl: CONFIG.DECIBEL_WS_URL,
  }, { nodeApiKey: CONFIG.API_BEARER_TOKEN });

  const m = await readDex.markets.getByName("BTC/USD");
  if (!m) {
    throw new Error("Market BTC/USD not found");
  }

  console.log("lot_size:", m.lot_size);
  console.log("min_size:", m.min_size);
  console.log("sz_decimals:", m.sz_precision.decimals);
  console.log("tick_size:", m.ticker_size);
}
main();
