import { MAINNET_CONFIG } from "@decibeltrade/sdk";

export const DECIBEL_CONFIG = {
  ...MAINNET_CONFIG,
  fullnodeUrl: "https://api.mainnet.aptoslabs.com/v1",
  tradingHttpUrl: "https://api.mainnet.aptoslabs.com/decibel",
  tradingWsUrl: "wss://api.mainnet.aptoslabs.com/decibel/ws",
};

// Builder 配置 (你的平台收费地址)
export const BUILDER_ADDRESS =
  "0xf009cb347d41e28fc4afcaa57331a2f5a390b0d48b90afd1ae4ada0eb1804d48";
export const BUILDER_FEE_BPS = 10; // 0.1%

// 平台邀请码
export const REFERRAL_CODE = "your_referral_code_here";

// Geomi API Key (用于读取市场数据)
export const API_KEY = import.meta.env.VITE_API_KEY || "";
