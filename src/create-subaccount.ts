import "dotenv/config";
import {
  DecibelReadDex,
  DecibelWriteDex,
  MAINNET_CONFIG,
} from "@decibeltrade/sdk";
import { Account, Ed25519PrivateKey } from "@aptos-labs/ts-sdk";
import { CONFIG } from "./config.js";

async function main() {
  const privateKey = new Ed25519PrivateKey(CONFIG.API_WALLET_PRIVATE_KEY);
  const account = Account.fromPrivateKey({ privateKey });

  console.log("API 钱包地址:", account.accountAddress.toString());

  const decibelConfig = {
    ...MAINNET_CONFIG,
    fullnodeUrl: CONFIG.FULLNODE_URL,
    tradingHttpUrl: CONFIG.DECIBEL_REST_URL,
    tradingWsUrl: CONFIG.DECIBEL_WS_URL,
    gasStationApiKey: CONFIG.GAS_STATION_API_KEY,
  };

  const readDex = new DecibelReadDex(decibelConfig, {
    nodeApiKey: CONFIG.API_BEARER_TOKEN || undefined,
  });

  // 先查看是否已有子账户
  console.log("\n查询现有子账户...");
  try {
    const existing = await readDex.userSubaccounts.getByAddr({
      ownerAddr: account.accountAddress.toString(),
    });
    if (existing.length > 0) {
      console.log("已有子账户:");
      existing.forEach((sub: any, i: number) => {
        console.log(`  [${i}]`, JSON.stringify(sub));
      });
      return;
    }
    console.log("无现有子账户，准备创建...");
  } catch (e: any) {
    console.log("查询失败 (可能是新账户):", e?.message);
  }

  // 创建子账户
  console.log("\n创建子账户...");
  const writeDex = new DecibelWriteDex(decibelConfig, account, {
    nodeApiKey: CONFIG.API_BEARER_TOKEN || undefined,
  });

  try {
    const result = await writeDex.createSubaccount();
    console.log("创建结果:", JSON.stringify(result, null, 2));
  } catch (e: any) {
    console.error("创建失败:", e?.message);
  }

  // 再次查询
  console.log("\n再次查询子账户...");
  try {
    const subs = await readDex.userSubaccounts.getByAddr({
      ownerAddr: account.accountAddress.toString(),
    });
    console.log("子账户列表:");
    subs.forEach((sub: any, i: number) => {
      console.log(`  [${i}]`, JSON.stringify(sub));
    });
    console.log("\n请将子账户地址填入 .env 的 SUBACCOUNT_ADDRESS");
  } catch (e: any) {
    console.error("查询失败:", e?.message);
  }
}

main().catch(console.error);
