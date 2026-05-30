import "dotenv/config";
import { DecibelWriteDex, MAINNET_CONFIG } from "@decibeltrade/sdk";
import { Account, Ed25519PrivateKey } from "@aptos-labs/ts-sdk";
import { CONFIG } from "./config.js";

async function main() {
  const privateKey = new Ed25519PrivateKey(CONFIG.API_WALLET_PRIVATE_KEY);
  const account = Account.fromPrivateKey({ privateKey });

  const decibelConfig = {
    ...MAINNET_CONFIG,
    fullnodeUrl: CONFIG.FULLNODE_URL,
    tradingHttpUrl: CONFIG.DECIBEL_REST_URL,
    tradingWsUrl: CONFIG.DECIBEL_WS_URL,
    gasStationApiKey: CONFIG.GAS_STATION_API_KEY,
  };

  const writeDex = new DecibelWriteDex(decibelConfig, account, {
    nodeApiKey: CONFIG.API_BEARER_TOKEN || undefined,
  });

  console.log("签名钱包:", account.accountAddress.toString());
  console.log("子账户:", CONFIG.SUBACCOUNT_ADDRESS);
  console.log("Builder:", CONFIG.BUILDER_ADDRESS);
  console.log("Fee:", CONFIG.BUILDER_FEE_BPS, "bps");

  // Step 1: 批准 Builder 最大费用
  console.log("\n=== 批准 Builder 最大费用 ===");
  try {
    const result = await writeDex.approveMaxBuilderFee({
      builderAddr: CONFIG.BUILDER_ADDRESS,
      maxFee: CONFIG.BUILDER_FEE_BPS,
      subaccountAddr: CONFIG.SUBACCOUNT_ADDRESS,
    });
    console.log("批准成功! TX:", result.hash);
  } catch (e: any) {
    console.error("批准失败:", e?.message);
  }
}

main().catch(console.error);
