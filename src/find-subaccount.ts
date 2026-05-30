import "dotenv/config";
import { DecibelReadDex, DecibelWriteDex, MAINNET_CONFIG } from "@decibeltrade/sdk";
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

  // 推导各个地址的主子账户
  const addresses = [
    { name: "签名钱包 (0x4dd3)", addr: "0x4dd31244d8945ac3af014f9673d4f353bad68ba14a5574cb203db4435d51f560" },
    { name: "主账户 (0x6b3f)", addr: "0x6b3f53236e24d40e0aae1d4b26657c91828f0a7885207c22a62925c0eea857eb" },
    { name: "API钱包 (0xe457)", addr: "0xe457695f13d3be4b91f255496a7da1ef7541e110b08d88a30fbb1b92a042b1a0" },
  ];

  console.log("=== 推导主子账户地址 ===\n");
  for (const { name, addr } of addresses) {
    const subAddr = writeDex.getPrimarySubaccountAddress(addr);
    console.log(`${name}:`);
    console.log(`  owner:      ${addr}`);
    console.log(`  subaccount: ${subAddr}`);
    console.log();
  }

  // 检查哪个子账户真实存在
  console.log("=== 检查子账户是否存在 ===\n");
  const readDex = new DecibelReadDex(decibelConfig, {
    nodeApiKey: CONFIG.API_BEARER_TOKEN || undefined,
  });

  for (const { name, addr } of addresses) {
    const subAddr = writeDex.getPrimarySubaccountAddress(addr);
    try {
      const orders = await readDex.userOpenOrders.getByAddr({ subAddr });
      console.log(`${name} 子账户 ${subAddr.slice(0,10)}... => ✅ 存在 (orders: ${orders.items.length})`);
    } catch (e: any) {
      console.log(`${name} 子账户 ${subAddr.slice(0,10)}... => ❌ ${e?.message?.slice(0, 80)}`);
    }
  }
}

main().catch(console.error);
