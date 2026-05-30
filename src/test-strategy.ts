import "dotenv/config";
import { GridEngine } from "./grid-engine.js";
import { CONFIG } from "./config.js";

async function main() {
  const engine = new GridEngine({
    apiWalletPrivateKey: CONFIG.API_WALLET_PRIVATE_KEY,
    subaccountAddress: CONFIG.SUBACCOUNT_ADDRESS,
    bearerToken: CONFIG.API_BEARER_TOKEN,
    marketName: CONFIG.MARKET_NAME,
    orderSizeUsd: CONFIG.ORDER_SIZE_USD,
    priceOffset: CONFIG.PRICE_OFFSET,
    direction: CONFIG.DIRECTION,
    totalVolumeLimit: CONFIG.TOTAL_VOLUME_LIMIT,
    pollIntervalMs: CONFIG.POLL_INTERVAL_MS,
  });

  engine.onLog = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);

  // 捕获 Ctrl+C 优雅退出
  process.on("SIGINT", async () => {
    console.log("\n收到停止信号...");
    await engine.stop();
    process.exit(0);
  });

  await engine.start();
}

main().catch(console.error);
