import "dotenv/config";
import { DecibelReadDex, MAINNET_CONFIG } from "@decibeltrade/sdk";
import { CONFIG } from "./config.js";

async function main() {
  const decibelConfig = {
    ...MAINNET_CONFIG,
    fullnodeUrl: CONFIG.FULLNODE_URL,
    tradingHttpUrl: CONFIG.DECIBEL_REST_URL,
    tradingWsUrl: CONFIG.DECIBEL_WS_URL,
  };
  const readDex = new DecibelReadDex(decibelConfig, {
    nodeApiKey: CONFIG.API_BEARER_TOKEN || undefined,
  });

  // 查用户子账户的订单历史 (看 builder 归因)
  const userSub = "0xdf36b3fd3b0780943a380124e88e6c172975d2f806384a8595211dff7be1afac";

  console.log("=== 用户订单历史 ===");
  const orders = await readDex.userOrderHistory.getByAddr({ subAddr: userSub, limit: 5 });
  console.log(JSON.stringify(orders, null, 2));

  console.log("\n=== 用户交易历史 ===");
  const trades = await readDex.userTradeHistory.getByAddr({ subAddr: userSub, limit: 5 });
  console.log(JSON.stringify(trades, null, 2));
}

main().catch(console.error);
