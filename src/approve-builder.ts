import "dotenv/config";
import { DecibelWriteDex, MAINNET_CONFIG } from "@decibeltrade/sdk";
import { Account, Ed25519PrivateKey } from "@aptos-labs/ts-sdk";
import { CONFIG } from "./config.js";

async function main() {
  // 1. 用 Owner 私钥构建账户
  const privateKey = new Ed25519PrivateKey(CONFIG.OWNER_PRIVATE_KEY);
  const ownerAccount = Account.fromPrivateKey({ privateKey });
  const ownerAddr = ownerAccount.accountAddress.toString();

  console.log("=== 地址验证 ===");
  console.log("Owner 地址 (推导):", ownerAddr);
  console.log("Owner 地址 (.env):", CONFIG.OWNER_ADDRESS);
  console.log("地址匹配:", ownerAddr.toLowerCase() === CONFIG.OWNER_ADDRESS.toLowerCase());

  // 2. 构建 Decibel SDK
  const decibelConfig = {
    ...MAINNET_CONFIG,
    fullnodeUrl: CONFIG.FULLNODE_URL,
    tradingHttpUrl: CONFIG.DECIBEL_REST_URL,
    tradingWsUrl: CONFIG.DECIBEL_WS_URL,
    gasStationApiKey: CONFIG.GAS_STATION_API_KEY,
  };

  const writeDex = new DecibelWriteDex(decibelConfig, ownerAccount, {
    nodeApiKey: CONFIG.API_BEARER_TOKEN || undefined,
  });

  // 3. 批准 Builder Fee
  console.log("\n=== 批准 Builder Fee ===");
  console.log("子账户:", CONFIG.SUBACCOUNT_ADDRESS);
  console.log("Builder:", CONFIG.BUILDER_ADDRESS);
  console.log("Fee:", CONFIG.BUILDER_FEE_BPS, "bps");

  try {
    const result = await writeDex.approveMaxBuilderFee({
      builderAddr: CONFIG.BUILDER_ADDRESS,
      maxFee: CONFIG.BUILDER_FEE_BPS,
      subaccountAddr: CONFIG.SUBACCOUNT_ADDRESS,
    });
    console.log("\n批准成功! TX:", result.hash);
  } catch (e: any) {
    console.error("\n批准失败:", e?.message);
  }
}

main().catch(console.error);
