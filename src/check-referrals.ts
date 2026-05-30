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

  for (const [name, addr] of [
    ["Owner", CONFIG.OWNER_ADDRESS],
    ["Subaccount", CONFIG.SUBACCOUNT_ADDRESS],
    ["API Wallet", CONFIG.API_WALLET_ADDRESS],
  ]) {
    if (!addr) continue;
    console.log(`\n=== ${name}: ${addr.slice(0, 12)}... ===`);
    try {
      const codes = await readDex.referrals.getAffiliateCodes(addr);
      console.log("Affiliate codes:", JSON.stringify(codes, null, 2));
    } catch (e: any) {
      console.log("Error:", e?.message?.slice(0, 120));
    }
  }
}

main().catch(console.error);
