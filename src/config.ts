import "dotenv/config";

// ============================================================
// 交易机器人配置
// ============================================================

export const CONFIG = {
  // ---- Aptos 网络配置 ----
  NETWORK: (process.env.NETWORK || "mainnet") as "mainnet" | "testnet",
  FULLNODE_URL:
    process.env.FULLNODE_URL || "https://api.mainnet.aptoslabs.com/v1",

  // ---- Decibel API 配置 ----
  DECIBEL_REST_URL: process.env.DECIBEL_REST_URL || "https://api.mainnet.aptoslabs.com/decibel",
  DECIBEL_WS_URL: process.env.DECIBEL_WS_URL || "wss://api.mainnet.aptoslabs.com/decibel/ws",

  // ---- Owner 钱包 ----
  OWNER_PRIVATE_KEY: process.env.OWNER_PRIVATE_KEY || "",
  OWNER_ADDRESS: process.env.OWNER_ADDRESS || "",

  // ---- API 钱包 (用于日常交易签名) ----
  API_WALLET_PRIVATE_KEY: process.env.API_WALLET_PRIVATE_KEY || "",
  API_WALLET_ADDRESS: process.env.API_WALLET_ADDRESS || "",
  API_BEARER_TOKEN: process.env.API_BEARER_TOKEN || "",
  GAS_STATION_API_KEY: process.env.GAS_STATION_API_KEY || "",
  SUBACCOUNT_ADDRESS: process.env.SUBACCOUNT_ADDRESS || "",

  // ---- Builder 归因 (必填，所有订单必须包含) ----
  BUILDER_ADDRESS: process.env.BUILDER_ADDRESS || "",
  BUILDER_FEE_BPS: Number(process.env.BUILDER_FEE_BPS || "1"),

  // ---- 平台邀请码 ----
  REFERRAL_CODE: process.env.REFERRAL_CODE || "",

  // ---- 交易市场 ----
  MARKET_NAME: process.env.MARKET_NAME || "BTC/USD",

  // ---- 策略参数 ----
  ORDER_SIZE_USD: Number(process.env.ORDER_SIZE_USD || "10"),
  PRICE_OFFSET: Number(process.env.PRICE_OFFSET || "10"),
  DIRECTION: (process.env.DIRECTION || "Both") as "Both" | "Long_Only" | "Short_Only",
  TOTAL_VOLUME_LIMIT: Number(process.env.TOTAL_VOLUME_LIMIT || "0"),

  // ---- 运行参数 ----
  POLL_INTERVAL_MS: Number(process.env.POLL_INTERVAL_MS || "5000"),
  STALE_ORDER_TIMEOUT_MS: Number(process.env.STALE_ORDER_TIMEOUT_MS || "20000"),
};
