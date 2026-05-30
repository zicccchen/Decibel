import "dotenv/config";
import {
  DecibelReadDex,
  DecibelWriteDex,
  MAINNET_CONFIG,
  TimeInForce,
} from "@decibeltrade/sdk";
import { Account, Ed25519PrivateKey } from "@aptos-labs/ts-sdk";
import { CONFIG } from "./config.js";

async function main() {
  const privateKey = new Ed25519PrivateKey(CONFIG.API_WALLET_PRIVATE_KEY);
  const account = Account.fromPrivateKey({ privateKey });
  const walletAddr = account.accountAddress.toString();

  console.log("签名钱包地址:", walletAddr);
  console.log("API_WALLET_ADDRESS (.env):", CONFIG.API_WALLET_ADDRESS);
  console.log("SUBACCOUNT_ADDRESS (.env):", CONFIG.SUBACCOUNT_ADDRESS);
  console.log("BUILDER_ADDRESS (.env):", CONFIG.BUILDER_ADDRESS);

  const decibelConfig = {
    ...MAINNET_CONFIG,
    fullnodeUrl: CONFIG.FULLNODE_URL,
    tradingHttpUrl: CONFIG.DECIBEL_REST_URL,
    tradingWsUrl: CONFIG.DECIBEL_WS_URL,
    gasStationApiKey: CONFIG.GAS_STATION_API_KEY, // Gas Station 代付 Gas
  };

  const readDex = new DecibelReadDex(decibelConfig, {
    nodeApiKey: CONFIG.API_BEARER_TOKEN || undefined,
  });

  // 1. 查询所有可能的子账户
  console.log("\n=== 查询子账户 ===");
  for (const addr of [walletAddr, CONFIG.API_WALLET_ADDRESS, CONFIG.SUBACCOUNT_ADDRESS]) {
    if (!addr) continue;
    try {
      const subs = await readDex.userSubaccounts.getByAddr({ ownerAddr: addr });
      console.log(`owner=${addr.slice(0, 10)}... => ${JSON.stringify(subs)}`);
    } catch (e: any) {
      console.log(`owner=${addr.slice(0, 10)}... => 错误: ${e?.message}`);
    }
  }

  // 2. 获取当前价格
  console.log("\n=== 获取 BTC/USD 价格 ===");
  let currentPrice = 0;
  try {
    const prices = await readDex.marketPrices.getByName({ marketName: "BTC/USD" });
    console.log("价格数据:", JSON.stringify(prices));
    if (prices && prices.length > 0) {
      currentPrice = prices[0].mid_px || prices[0].mark_px || prices[0].oracle_px;
      console.log("当前价格:", currentPrice);
    }
  } catch (e: any) {
    console.log("获取价格失败:", e?.message);
  }

  if (!currentPrice) {
    console.log("无法获取价格，退出");
    return;
  }

  // 3. 尝试下一笔带 Builder Code 的限价单 (远离市价，不会成交)
  console.log("\n=== 下测试单 (PostOnly 限价单) ===");
  // BTC/USD: px_decimals=6, sz_decimals=8, min_size=2000, tick_size=100000
  const pxDecimals = 6;
  const szDecimals = 8;
  const humanPrice = Math.round(currentPrice * 0.95); // 低于市价 5%
  const humanSize = 0.001; // 0.001 BTC
  const testPrice = humanPrice * Math.pow(10, pxDecimals); // 链上整数
  const testSize = humanSize * Math.pow(10, szDecimals);   // 链上整数

  console.log(`测试: BUY ${humanSize} BTC @ $${humanPrice} (PostOnly)`);
  console.log(`Builder: ${CONFIG.BUILDER_ADDRESS} (${CONFIG.BUILDER_FEE_BPS} bps)`);

  const writeDex = new DecibelWriteDex(decibelConfig, account, {
    nodeApiKey: CONFIG.API_BEARER_TOKEN || undefined,
  });

  try {
    const result = await writeDex.placeOrder({
      marketName: "BTC/USD",
      price: testPrice,
      size: testSize,
      isBuy: true,
      timeInForce: TimeInForce.PostOnly,
      isReduceOnly: false,
      subaccountAddr: CONFIG.SUBACCOUNT_ADDRESS,
      ...(CONFIG.BUILDER_ADDRESS
        ? { builderAddr: CONFIG.BUILDER_ADDRESS, builderFee: CONFIG.BUILDER_FEE_BPS }
        : {}),
    });
    console.log("\n下单结果:", JSON.stringify(result, null, 2));
  } catch (e: any) {
    console.error("\n下单失败:", e?.message);
    if (e?.message?.includes("INSUFFICIENT")) {
      console.log("\n提示: 子账户余额不足，需要先充值 USDC");
    }
  }
}

main().catch(console.error);
