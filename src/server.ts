import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import path from "path";
import { fileURLToPath } from "url";
import {
  DecibelReadDex,
  DecibelWriteDex,
  MAINNET_CONFIG,
  TESTNET_CONFIG,
  TimeInForce,
  getMarketAddr,
} from "@decibeltrade/sdk";
import type { DecibelConfig } from "@decibeltrade/sdk";
import {
  Account,
  Ed25519PrivateKey,
  Aptos,
  AptosConfig,
  SimpleTransaction,
  Deserializer,
  AccountAuthenticator,
} from "@aptos-labs/ts-sdk";
import { GasStationClient } from "@aptos-labs/gas-station-client";
import { GridEngine } from "./grid-engine.js";
import type { UserBotConfig } from "./grid-engine.js";
import { GridStrategy } from "./grid-strategy.js";
import type { GridStrategyConfig } from "./grid-strategy.js";
import { CONFIG } from "./config.js";
import { ReferralManager } from "./referral-manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// ============================================================
// 平台级 SDK (用于用户引导: 兑换邀请码等)
// ============================================================

function getDecibelConfig(): DecibelConfig {
  const baseConfig = CONFIG.NETWORK === "mainnet" ? MAINNET_CONFIG : TESTNET_CONFIG;
  return {
    ...baseConfig,
    fullnodeUrl: CONFIG.FULLNODE_URL,
    tradingHttpUrl: CONFIG.DECIBEL_REST_URL,
    tradingWsUrl: CONFIG.DECIBEL_WS_URL,
    gasStationApiKey: CONFIG.GAS_STATION_API_KEY || undefined,
  };
}

let platformReadDex: DecibelReadDex | null = null;
let referralManager: ReferralManager | null = null;

function getPlatformReadDex(): DecibelReadDex {
  if (!platformReadDex) {
    platformReadDex = new DecibelReadDex(getDecibelConfig(), {
      nodeApiKey: CONFIG.API_BEARER_TOKEN || undefined,
    });
  }
  return platformReadDex;
}

function getReferralManager(): ReferralManager {
  if (!referralManager) {
    const readDex = getPlatformReadDex();
    referralManager = new ReferralManager(readDex, CONFIG.API_WALLET_ADDRESS);
  }
  return referralManager;
}

function getUserDex(privateKeyHex: string, bearerToken?: string): {
  readDex: DecibelReadDex;
  writeDex: DecibelWriteDex;
  account: Account;
} {
  const privateKey = new Ed25519PrivateKey(privateKeyHex);
  const account = Account.fromPrivateKey({ privateKey });
  const dexConfig = getDecibelConfig();
  const nodeApiKey = bearerToken || CONFIG.API_BEARER_TOKEN || undefined;
  return {
    readDex: new DecibelReadDex(dexConfig, { nodeApiKey }),
    writeDex: new DecibelWriteDex(dexConfig, account, { nodeApiKey }),
    account,
  };
}

async function getMarketMeta(readDex: DecibelReadDex, marketName: string): Promise<{
  marketAddr?: string;
  tickSize: number;
  lotSize: number;
  minSize: number;
  pxDecimals: number;
  szDecimals: number;
  currentPrice: number;
}> {
  const markets = await readDex.markets.getAll();
  const market = (markets as any[]).find((item: any) => (item.market_name || item.name) === marketName);
  if (!market) {
    throw new Error(`未找到市场 ${marketName}`);
  }

  const priceRows = await (readDex as any).marketPrices.getByName({ marketName });
  if (!Array.isArray(priceRows) || priceRows.length === 0) {
    throw new Error(`无法获取 ${marketName} 实时价格`);
  }

  const currentPrice = Number(priceRows[0]?.mid_px || priceRows[0]?.mark_px || priceRows[0]?.oracle_px || 0);
  if (!(currentPrice > 0)) {
    throw new Error(`无效市场价格 ${marketName}`);
  }

  return {
    marketAddr: market.market_addr,
    tickSize: Number(market.ticker_size || market.tick_size || 100000),
    lotSize: Number(market.lot_size || 1000),
    minSize: Number(market.min_size || 1000),
    pxDecimals: Number(market.px_decimals ?? 6),
    szDecimals: Number(market.sz_precision?.decimals ?? market.sz_decimals ?? 8),
    currentPrice,
  };
}

function priceToChain(humanPrice: number, pxDecimals: number, tickSize: number): number {
  const raw = Math.round(humanPrice * Math.pow(10, pxDecimals));
  return Math.round(raw / tickSize) * tickSize;
}

function sizeToChain(humanSize: number, szDecimals: number, lotSize: number, minSize: number): number {
  const raw = Math.round(humanSize * Math.pow(10, szDecimals));
  return Math.max(Math.floor(raw / lotSize) * lotSize, minSize);
}

function finiteNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseLeverageMultiplier(value: unknown): number {
  const raw = String(value || "").trim().toLowerCase();
  const normalized = raw.endsWith("x") ? raw.slice(0, -1) : raw;
  const multiple = Number(normalized);
  if (!Number.isFinite(multiple) || multiple <= 0) return 1;
  return Math.round(multiple);
}

async function getMarketNetPosition(
  readDex: DecibelReadDex,
  subaccountAddress: string,
  marketName: string,
  marketAddr?: string,
): Promise<number> {
  const positions = await (readDex as any).userPositions.getByAddr({ subAddr: subaccountAddress });
  const items = positions.items || positions || [];
  const marketPosition = items.find((item: any) => {
    const marketId = item.market_id || item.market || "";
    if (marketAddr && marketId) return marketId === marketAddr;
    return (item.market_name || marketName) === marketName;
  }) || items.find((item: any) => (item.market_name || marketName) === marketName);

  return Number(marketPosition?.position_size || marketPosition?.size || 0);
}

async function inspectManualOrder(
  readDex: DecibelReadDex,
  subaccountAddress: string,
  marketName: string,
  marketAddr: string | undefined,
  orderId: string | undefined,
): Promise<{
  observedOpen: boolean;
  observedHistory: boolean;
  historyStatus: string;
}> {
  let observedOpen = false;
  let observedHistory = false;
  let historyStatus = "";

  if (orderId) {
    try {
      const openOrders = await (readDex as any).userOpenOrders.getByAddr({ subAddr: subaccountAddress });
      const openItems = openOrders.items || openOrders || [];
      observedOpen = openItems.some((item: any) => item.order_id === orderId);
    } catch {
      // ignore
    }

    try {
      const history = await (readDex as any).userOrderHistory.getByAddr({
        subAddr: subaccountAddress,
        limit: 50,
      });
      const items = history.items || history || [];
      const entry = items.find((item: any) => item.order_id === orderId);
      observedHistory = !!entry;
      historyStatus = String(entry?.status || "").toLowerCase();
    } catch {
      // ignore
    }
  }

  if (!marketAddr && !marketName) {
    return { observedOpen, observedHistory, historyStatus };
  }

  return { observedOpen, observedHistory, historyStatus };
}

// ============================================================
// 多用户会话管理
// ============================================================

interface UserSession {
  walletAddress: string;
  engine: GridEngine | GridStrategy | null;
  logs: string[];
  wsClients: Set<WebSocket>;
}

const sessions = new Map<string, UserSession>();
const MAX_LOGS = 200;

function getOrCreateSession(walletAddress: string): UserSession {
  const key = walletAddress.toLowerCase();
  let session = sessions.get(key);
  if (!session) {
    session = { walletAddress, engine: null, logs: [], wsClients: new Set() };
    sessions.set(key, session);
  }
  return session;
}

function broadcastToUser(session: UserSession, data: object): void {
  const msg = JSON.stringify(data);
  session.wsClients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

function logManualTrade(event: string, payload: Record<string, unknown>): void {
  console.log(`[manual-trade] ${event} ${JSON.stringify(payload)}`);
}

async function triggerMarketMatching(
  writeDex: DecibelWriteDex,
  marketAddr?: string,
): Promise<void> {
  if (!marketAddr) return;
  await writeDex.triggerMatching({
    marketAddr,
    maxWorkUnit: 200,
  });
}

// 静态文件 & JSON 解析
app.use(express.static(path.join(__dirname, "../public")));
app.use(express.json());

// ---- REST API ----

// 获取平台配置 (公开)
app.get("/api/platform", (_req, res) => {
  res.json({
    network: CONFIG.NETWORK,
    hasBuilder: !!CONFIG.BUILDER_ADDRESS,
    builderAddress: CONFIG.BUILDER_ADDRESS || "",
    builderFeeBps: CONFIG.BUILDER_FEE_BPS,
    referralCode: CONFIG.REFERRAL_CODE || "",
  });
});

// ---- 用户引导 API ----

// 检查用户是否已有 Decibel 账户 (是否已兑换邀请码)
app.get("/api/onboard/check/:wallet", async (req, res) => {
  try {
    const readDex = getPlatformReadDex();
    const referral = await readDex.referrals.getAccountReferral(
      req.params.wallet
    );
    res.json({ registered: true, referral });
  } catch {
    res.json({ registered: false });
  }
});

// 兑换邀请码 (使用平台的邀请码自动为用户注册)
app.post("/api/onboard/redeem", async (req, res) => {
  const { walletAddress } = req.body as Record<string, any>;
  if (!walletAddress) {
    res.status(400).json({ error: "缺少钱包地址" });
    return;
  }

  const referralCode = CONFIG.REFERRAL_CODE;
  if (!referralCode) {
    res.status(500).json({ error: "平台未配置邀请码，请联系管理员" });
    return;
  }

  try {
    const readDex = getPlatformReadDex();

    // 先检查用户是否已注册
    try {
      await readDex.referrals.getAccountReferral(walletAddress);
      res.json({ success: true, message: "该账户已注册，无需重复兑换" });
      return;
    } catch {
      // 未注册，继续兑换
    }

    // 验证邀请码有效性
    const codeInfo = await readDex.referrals.validateCode(referralCode);
    if (!codeInfo.is_valid || !codeInfo.is_active) {
      res.status(400).json({ error: "邀请码无效或已过期" });
      return;
    }

    // 兑换邀请码
    await readDex.referrals.redeemCode({
      referralCode,
      account: walletAddress,
    });

    res.json({ success: true, message: "邀请码兑换成功" });
  } catch (error: any) {
    res.status(500).json({ error: `兑换失败: ${error?.message}` });
  }
});

// 创建 API 钱包和子账户 (旧接口, 需手动输入私钥)
app.post("/api/onboard/setup", async (req, res) => {
  const { apiWalletPrivateKey } = req.body as Record<string, any>;
  if (!apiWalletPrivateKey) {
    res.status(400).json({ error: "请提供 API 钱包私钥" });
    return;
  }

  try {
    const privateKey = new Ed25519PrivateKey(apiWalletPrivateKey);
    const account = Account.fromPrivateKey({ privateKey });

    const writeDex = new DecibelWriteDex(getDecibelConfig(), account, {
      nodeApiKey: CONFIG.API_BEARER_TOKEN || undefined,
    });

    // 创建子账户
    const txResult = await writeDex.createSubaccount();

    // 获取子账户地址
    const readDex = getPlatformReadDex();
    const subaccounts = await readDex.userSubaccounts.getByAddr({
      ownerAddr: account.accountAddress.toString(),
    });

    const latestSubaccount = subaccounts.length > 0
      ? subaccounts[subaccounts.length - 1]
      : null;

    res.json({
      success: true,
      walletAddress: account.accountAddress.toString(),
      subaccountAddress: latestSubaccount
        ? (latestSubaccount as any).address || (latestSubaccount as any).subaccount_address
        : null,
      transactionHash: txResult.hash,
    });
  } catch (error: any) {
    res.status(500).json({ error: `创建子账户失败: ${error?.message}` });
  }
});

// ---- 自动 API 钱包: 后端生成密钥, 用户只需签名授权 ----

// 用户已生成的 API 钱包 (ownerAddress -> { privateKey, address })
const userApiWallets = new Map<string, { privateKeyHex: string; address: string }>();

// Step 1: 后端自动生成 API 钱包
app.post("/api/onboard/generate-api-wallet", (req, res) => {
  const { ownerAddress } = req.body as Record<string, any>;
  if (!ownerAddress) {
    res.status(400).json({ error: "缺少钱包地址" });
    return;
  }

  try {
    const apiAccount = Account.generate();
    const privateKeyHex = apiAccount.privateKey.toString();
    const address = apiAccount.accountAddress.toString();

    userApiWallets.set(ownerAddress.toLowerCase(), { privateKeyHex, address });

    res.json({
      success: true,
      apiWalletAddress: address,
    });
  } catch (error: any) {
    res.status(500).json({ error: `生成 API 钱包失败: ${error?.message}` });
  }
});

// Step 2: 构建 delegate_trading_to 交易 (用户签名授权 API 钱包)
app.post("/api/onboard/build-delegate", async (req, res) => {
  const { ownerAddress, subaccountAddress } = req.body as Record<string, any>;
  if (!ownerAddress || !subaccountAddress) {
    res.status(400).json({ error: "缺少钱包地址或子账户地址" });
    return;
  }

  const apiWallet = userApiWallets.get(ownerAddress.toLowerCase());
  if (!apiWallet) {
    res.status(400).json({ error: "请先生成 API 钱包" });
    return;
  }

  try {
    const config = getDecibelConfig();
    const aptos = new Aptos(new AptosConfig({
      network: config.network,
      fullnode: config.fullnodeUrl,
      clientConfig: CONFIG.API_BEARER_TOKEN
        ? { API_KEY: CONFIG.API_BEARER_TOKEN }
        : undefined,
    }));

    const transaction = await aptos.transaction.build.simple({
      sender: ownerAddress,
      data: {
        function: `${config.deployment.package}::dex_accounts_entry::delegate_trading_to_for_subaccount`,
        functionArguments: [subaccountAddress, apiWallet.address, null],
      },
      withFeePayer: true,
    });

    const txId = crypto.randomUUID();
    pendingTxs.set(txId, transaction);
    setTimeout(() => pendingTxs.delete(txId), 300000);

    const rawTxHex = Buffer.from(transaction.bcsToBytes()).toString("hex");
    res.json({ txId, rawTransactionHex: rawTxHex, apiWalletAddress: apiWallet.address });
  } catch (error: any) {
    res.status(500).json({ error: `构建委托交易失败: ${error?.message}` });
  }
});

// 获取用户的 API 钱包信息 (给 start 接口用)
app.get("/api/onboard/api-wallet/:owner", (req, res) => {
  const apiWallet = userApiWallets.get(req.params.owner.toLowerCase());
  if (!apiWallet) {
    res.json({ exists: false });
    return;
  }
  res.json({
    exists: true,
    apiWalletAddress: apiWallet.address,
    apiWalletPrivateKey: apiWallet.privateKeyHex,
  });
});

// ---- Sponsored Transactions (用户签名, Gas Station 代付) ----

const pendingTxs = new Map<string, SimpleTransaction>();

// 构建创建子账户交易 (用户签名)
app.post("/api/onboard/build-create-subaccount", async (req, res) => {
  const { ownerAddress } = req.body as Record<string, any>;
  if (!ownerAddress) {
    res.status(400).json({ error: "缺少钱包地址" });
    return;
  }

  try {
    const config = getDecibelConfig();
    const aptos = new Aptos(new AptosConfig({
      network: config.network,
      fullnode: config.fullnodeUrl,
      clientConfig: CONFIG.API_BEARER_TOKEN
        ? { API_KEY: CONFIG.API_BEARER_TOKEN }
        : undefined,
    }));

    const transaction = await aptos.transaction.build.simple({
      sender: ownerAddress,
      data: {
        function: `${config.deployment.package}::dex_accounts_entry::create_new_subaccount`,
        functionArguments: [],
      },
      withFeePayer: true,
    });

    const txId = crypto.randomUUID();
    pendingTxs.set(txId, transaction);
    setTimeout(() => pendingTxs.delete(txId), 300000);

    const rawTxHex = Buffer.from(transaction.bcsToBytes()).toString("hex");
    res.json({ txId, rawTransactionHex: rawTxHex });
  } catch (error: any) {
    res.status(500).json({ error: `构建交易失败: ${error?.message}` });
  }
});

// Step 1: 构建 fee-payer 交易, 返回序列化字节
app.post("/api/onboard/build-approve-builder", async (req, res) => {
  const { ownerAddress, subaccountAddress } = req.body as Record<string, any>;
  if (!ownerAddress || !subaccountAddress) {
    res.status(400).json({ error: "缺少钱包地址或子账户地址" });
    return;
  }
  if (!CONFIG.BUILDER_ADDRESS) {
    res.status(500).json({ error: "平台未配置 BUILDER_ADDRESS" });
    return;
  }

  try {
    const config = getDecibelConfig();
    const aptos = new Aptos(new AptosConfig({
      network: config.network,
      fullnode: config.fullnodeUrl,
      clientConfig: CONFIG.API_BEARER_TOKEN
        ? { API_KEY: CONFIG.API_BEARER_TOKEN }
        : undefined,
    }));

    const transaction = await aptos.transaction.build.simple({
      sender: ownerAddress,
      data: {
        function: `${config.deployment.package}::dex_accounts_entry::approve_max_builder_fee_for_subaccount`,
        functionArguments: [subaccountAddress, CONFIG.BUILDER_ADDRESS, String(CONFIG.BUILDER_FEE_BPS)],
      },
      withFeePayer: true,
    });

    const txId = crypto.randomUUID();
    pendingTxs.set(txId, transaction);
    setTimeout(() => pendingTxs.delete(txId), 300000); // 5 min expiry

    const rawTxHex = Buffer.from(transaction.bcsToBytes()).toString("hex");
    res.json({ txId, rawTransactionHex: rawTxHex });
  } catch (error: any) {
    res.status(500).json({ error: `构建交易失败: ${error?.message}` });
  }
});

// Step 2: 接收用户签名, 通过 Gas Station 提交 (用户无需付 gas)
app.post("/api/onboard/submit-sponsored", async (req, res) => {
  const { txId, senderAuthHex } = req.body as Record<string, any>;
  if (!txId || !senderAuthHex) {
    res.status(400).json({ error: "缺少交易 ID 或签名" });
    return;
  }

  const transaction = pendingTxs.get(txId);
  if (!transaction) {
    res.status(400).json({ error: "交易已过期或不存在，请重新发起" });
    return;
  }
  pendingTxs.delete(txId);

  try {
    const senderAuth = AccountAuthenticator.deserialize(
      new Deserializer(Buffer.from(senderAuthHex, "hex"))
    );

    const gasStation = new GasStationClient({
      network: getDecibelConfig().network,
      apiKey: CONFIG.GAS_STATION_API_KEY,
    });

    const { transactionHash } = await gasStation.signAndSubmitTransaction({
      transaction,
      senderAuthenticator: senderAuth,
    });

    res.json({
      success: true,
      txHash: transactionHash,
      builderAddress: CONFIG.BUILDER_ADDRESS,
      feeBps: CONFIG.BUILDER_FEE_BPS,
    });
  } catch (error: any) {
    res.status(500).json({ error: `提交失败: ${error?.message}` });
  }
});

// 审批 Builder Fee (使用 Owner 私钥签名, 备用方案)
app.post("/api/onboard/approve-builder", async (req, res) => {
  const { ownerPrivateKey, subaccountAddress } = req.body as Record<string, any>;
  if (!ownerPrivateKey || !subaccountAddress) {
    res.status(400).json({ error: "请提供 Owner 私钥和子账户地址" });
    return;
  }
  if (!CONFIG.BUILDER_ADDRESS) {
    res.status(500).json({ error: "平台未配置 BUILDER_ADDRESS" });
    return;
  }

  try {
    const privateKey = new Ed25519PrivateKey(ownerPrivateKey);
    const ownerAccount = Account.fromPrivateKey({ privateKey });

    const decibelConfig = {
      ...getDecibelConfig(),
      gasStationApiKey: CONFIG.GAS_STATION_API_KEY,
    };

    const writeDex = new DecibelWriteDex(decibelConfig, ownerAccount, {
      nodeApiKey: CONFIG.API_BEARER_TOKEN || undefined,
    });

    const result = await writeDex.approveMaxBuilderFee({
      builderAddr: CONFIG.BUILDER_ADDRESS,
      maxFee: CONFIG.BUILDER_FEE_BPS,
      subaccountAddr: subaccountAddress,
    });

    res.json({
      success: true,
      transactionHash: result.hash,
      builderAddress: CONFIG.BUILDER_ADDRESS,
      feeBps: CONFIG.BUILDER_FEE_BPS,
    });
  } catch (error: any) {
    res.status(500).json({ error: `审批失败: ${error?.message}` });
  }
});

// ---- 一键开户: Owner 私钥签名, 创建子账户 + 授权 API 钱包 + 审批 Builder Fee ----
app.post("/api/onboard/one-click-setup", async (req, res) => {
  const { ownerPrivateKey, walletAddress } = req.body as Record<string, any>;
  if (!ownerPrivateKey) {
    res.status(400).json({ error: "请提供 Owner 钱包私钥" });
    return;
  }

  try {
    const privateKey = new Ed25519PrivateKey(ownerPrivateKey);
    const ownerAccount = Account.fromPrivateKey({ privateKey });
    const ownerAddr = ownerAccount.accountAddress.toString();

    const decibelConfig = getDecibelConfig();
    const writeDex = new DecibelWriteDex(decibelConfig, ownerAccount, {
      nodeApiKey: CONFIG.API_BEARER_TOKEN || undefined,
    });
    const readDex = getPlatformReadDex();

    // Step 1: 检查 / 创建子账户
    let subaccountAddr = "";
    const existingSubs = await readDex.userSubaccounts.getByAddr({ ownerAddr });
    if (existingSubs.length > 0) {
      subaccountAddr = (existingSubs[0] as any).subaccount_address || (existingSubs[0] as any).address;
      console.log(`[OneClick] 已有子账户: ${subaccountAddr}`);
    } else {
      console.log("[OneClick] 创建子账户...");
      await writeDex.createSubaccount();
      // 等待链上确认
      await new Promise(r => setTimeout(r, 3000));
      const subs = await readDex.userSubaccounts.getByAddr({ ownerAddr });
      if (subs.length === 0) throw new Error("子账户创建失败，请重试");
      subaccountAddr = (subs[0] as any).subaccount_address || (subs[0] as any).address;
      console.log(`[OneClick] 子账户创建成功: ${subaccountAddr}`);
    }

    // Step 2: 生成 API 钱包
    const apiAccount = Account.generate();
    const apiPrivateKeyHex = apiAccount.privateKey.toString();
    const apiAddr = apiAccount.accountAddress.toString();
    userApiWallets.set(ownerAddr.toLowerCase(), { privateKeyHex: apiPrivateKeyHex, address: apiAddr });
    console.log(`[OneClick] API 钱包: ${apiAddr}`);

    // Step 3: 授权 API 钱包 (delegate trading)
    console.log("[OneClick] 授权 API 钱包...");
    await writeDex.delegateTradingToForSubaccount({
      subaccountAddr,
      accountToDelegateTo: apiAddr,
    });
    await new Promise(r => setTimeout(r, 2000));

    // Step 4: 审批 Builder Fee
    if (CONFIG.BUILDER_ADDRESS) {
      console.log("[OneClick] 审批 Builder Fee...");
      await writeDex.approveMaxBuilderFee({
        builderAddr: CONFIG.BUILDER_ADDRESS,
        maxFee: CONFIG.BUILDER_FEE_BPS,
        subaccountAddr,
      });
    }

    res.json({
      success: true,
      subaccountAddress: subaccountAddr,
      apiWalletAddress: apiAddr,
      apiWalletPrivateKey: apiPrivateKeyHex,
    });
  } catch (error: any) {
    res.status(500).json({ error: `开户失败: ${error?.message}` });
  }
});

// ---- 通用交易构建 (返回 BCS rawTransaction, 用于 AIP-62 Wallet Standard) ----
app.post("/api/onboard/build-tx", async (req, res) => {
  const { senderAddress, func, typeArguments, functionArguments } = req.body as Record<string, any>;
  if (!senderAddress || !func) {
    res.status(400).json({ error: "缺少 senderAddress 或 func" });
    return;
  }

  try {
    const config = getDecibelConfig();
    const aptos = new Aptos(new AptosConfig({
      network: config.network,
      fullnode: config.fullnodeUrl,
      clientConfig: CONFIG.API_BEARER_TOKEN
        ? { API_KEY: CONFIG.API_BEARER_TOKEN }
        : undefined,
    }));

    const transaction = await aptos.transaction.build.simple({
      sender: senderAddress,
      data: {
        function: func,
        typeArguments: typeArguments || [],
        functionArguments: functionArguments || [],
      },
    });

    // 提取 rawTransaction 的 BCS 字节 (AIP-62 要求)
    const rawTxBytes = transaction.rawTransaction.bcsToBytes();
    const rawTransactionHex = Buffer.from(rawTxBytes).toString("hex");
    // 同时返回完整 SimpleTransaction 字节 (某些钱包需要)
    const fullTxBytes = transaction.bcsToBytes();
    const fullTransactionHex = Buffer.from(fullTxBytes).toString("hex");
    res.json({ rawTransactionHex, fullTransactionHex });
  } catch (error: any) {
    res.status(500).json({ error: `构建交易失败: ${error?.message}` });
  }
});

// 查询用户已有子账户
app.get("/api/onboard/subaccounts/:wallet", async (req, res) => {
  try {
    const readDex = getPlatformReadDex();
    const subaccounts = await readDex.userSubaccounts.getByAddr({
      ownerAddr: req.params.wallet,
    });
    res.json({ subaccounts });
  } catch (error: any) {
    res.status(500).json({ error: `查询失败: ${error?.message}` });
  }
});

// ---- 用户资产查询 ----

// 获取用户余额和 AMPs
app.get("/api/account/:wallet", async (req, res) => {
  try {
    const readDex = getPlatformReadDex();
    const ownerAddr = req.params.wallet;

    // 查询子账户
    const subaccounts = await readDex.userSubaccounts.getByAddr({ ownerAddr });

    let balance = 0;
    let subaccountAddr = "";

    if (subaccounts.length > 0) {
      subaccountAddr = (subaccounts[0] as any).subaccount_address || (subaccounts[0] as any).address;
      // 查询账户余额
      try {
        const overview = await (readDex as any).accountOverview.getByAddr({ subAddr: subaccountAddr });
        balance = Number(overview?.perp_equity_balance || overview?.usdc_cross_withdrawable_balance || 0);
      } catch { /* 子账户可能没有余额 */ }
    }

    // 查询 AMPs
    let amps = 0;
    try {
      const ampsData = await (readDex as any).tradingAmps.getByOwner({ ownerAddr });
      amps = Number(ampsData?.total_amps || 0);
    } catch { /* AMPs 查询可能失败 */ }

    res.json({ balance, amps, subaccountAddr });
  } catch (error: any) {
    res.json({ balance: 0, amps: 0, subaccountAddr: "", error: error?.message });
  }
});

// ---- K线 & 持仓 & 价格 API ----

// 获取市场价格（通过 Decibel 实时市场价格）
app.get("/api/prices", async (_req, res) => {
  try {
    const readDex = getPlatformReadDex();
    const markets = ["BTC/USD", "ETH/USD", "APT/USD", "SOL/USD"];
    const prices: Record<string, number> = {};
    await Promise.all(
      markets.map(async (m) => {
        try {
          const marketPrices = await (readDex as any).marketPrices.getByName({
            marketName: m,
          });
          if (Array.isArray(marketPrices) && marketPrices.length > 0) {
            const price = marketPrices[0]?.mid_px || marketPrices[0]?.mark_px || marketPrices[0]?.oracle_px;
            if (price && Number(price) > 0) {
              prices[m] = Number(price);
            }
          }
        } catch {}
      })
    );
    res.json(prices);
  } catch (error: any) {
    res.status(500).json({ error: error?.message });
  }
});

// 获取 K 线数据
app.get("/api/candles/:market", async (req, res) => {
  try {
    const readDex = getPlatformReadDex();
    const marketName = decodeURIComponent(req.params.market);
    const interval = (req.query.interval as string) || "15m";
    const now = Date.now();
    const hours = Number(req.query.hours || 24);
    const startTime = Number(req.query.start || now - hours * 3600 * 1000);
    const endTime = Number(req.query.end || now);

    const candles = await (readDex as any).candlesticks.getByName({
      marketName,
      interval,
      startTime,
      endTime,
    });
    res.json(candles || []);
  } catch (error: any) {
    res.status(500).json({ error: `获取K线失败: ${error?.message}` });
  }
});

// 获取用户持仓
app.get("/api/positions/:subaccount", async (req, res) => {
  try {
    const readDex = getPlatformReadDex();
    const positions = await (readDex as any).userPositions.getByAddr({
      subAddr: req.params.subaccount,
    });
    const items = positions?.items || positions || [];
    const markets = await readDex.markets.getAll();
    const marketMap = new Map<string, any>();
    for (const market of markets as any[]) {
      const marketAddr = String(market.market_addr || market.market || "");
      if (marketAddr) marketMap.set(marketAddr, market);
    }

    const normalized = await Promise.all((items as any[]).map(async (item: any) => {
      const marketAddr = String(item.market || item.market_id || "");
      const marketMeta = marketMap.get(marketAddr);
      const marketName = String(item.market_name || marketMeta?.market_name || marketMeta?.name || marketAddr || "--");

      let markPrice = 0;
      try {
        const priceRows = await (readDex as any).marketPrices.getByName({ marketName });
        const priceRow = Array.isArray(priceRows) ? priceRows[0] : priceRows?.items?.[0];
        markPrice = finiteNumber(priceRow?.mid_px || priceRow?.mark_px || priceRow?.oracle_px, 0);
      } catch {
        markPrice = 0;
      }

      const size = finiteNumber(item.size ?? item.position_size, 0);
      const entryPrice = finiteNumber(item.entry_price, 0);

      return {
        market: marketAddr,
        market_name: marketName,
        size,
        entry_price: entryPrice,
        mark_price: markPrice,
        unrealized_pnl: (markPrice > 0 && entryPrice > 0) ? (markPrice - entryPrice) * size : 0,
        estimated_liquidation_price: finiteNumber(item.estimated_liquidation_price, 0),
        user_leverage: finiteNumber(item.user_leverage, 0),
        is_isolated: !!item.is_isolated,
      };
    }));

    res.json(normalized);
  } catch (error: any) {
    res.status(500).json({ error: `获取持仓失败: ${error?.message}` });
  }
});

const handleManualOrder = async (req: express.Request, res: express.Response) => {
  try {
    const {
      apiWalletPrivateKey,
      bearerToken,
      subaccountAddress,
      marketName,
      side,
      orderType,
      action,
      leverage,
      orderSizeUsd,
      size,
      price,
    } = req.body as Record<string, any>;

    if (!apiWalletPrivateKey || !subaccountAddress || !marketName) {
      res.status(400).json({ error: "缺少 API 私钥、子账户或市场" });
      return;
    }
    if (side !== "buy" && side !== "sell") {
      res.status(400).json({ error: "side 必须为 buy 或 sell" });
      return;
    }
    if (orderType !== "market" && orderType !== "limit") {
      res.status(400).json({ error: "orderType 必须为 market 或 limit" });
      return;
    }
    if (action !== "open" && action !== "close") {
      res.status(400).json({ error: "action 必须为 open 或 close" });
      return;
    }

    logManualTrade("request", {
      marketName,
      subaccountAddress,
      side,
      orderType,
      action,
      size,
      orderSizeUsd,
      price,
    });

    const { readDex, writeDex } = getUserDex(apiWalletPrivateKey, bearerToken);
    const meta = await getMarketMeta(readDex, marketName);
    const beforeNet = await getMarketNetPosition(readDex, subaccountAddress, marketName, meta.marketAddr);
    const leverageValue = parseLeverageMultiplier(leverage);

    const sizeCoin = finiteNumber(size, 0);
    const sizeUsd = finiteNumber(orderSizeUsd, 0);
    if (sizeCoin > 0 && sizeUsd > 0) {
      res.status(400).json({ error: "Size (Coin) 和 Order Size (USD) 只能填写一个" });
      return;
    }

    const humanSize = sizeCoin > 0
      ? sizeCoin
      : sizeUsd > 0
        ? sizeUsd / meta.currentPrice
        : 0;
    if (!(humanSize > 0)) {
      res.status(400).json({ error: "请输入有效下单数量或下单金额" });
      return;
    }

    const configuredMarketAddr = getMarketAddr(marketName, getDecibelConfig().deployment.perpEngineGlobal).toString();
    if (Math.abs(beforeNet) <= 0.000001) {
      try {
        await writeDex.configureUserSettingsForMarket({
          marketAddr: configuredMarketAddr,
          subaccountAddr: subaccountAddress,
          isCross: true,
          userLeverage: leverageValue,
        });

        logManualTrade("leverage_configured", {
          marketName,
          subaccountAddress,
          leverage,
          leverageValue,
          marketAddr: configuredMarketAddr,
          isCross: true,
        });
      } catch (error: any) {
        const message = String(error?.message || error);
        if (message.includes("ECANNOT_MODIFY_SETTINGS_WHILE_HOLDING_POSITION")) {
          logManualTrade("leverage_skipped_existing_position", {
            marketName,
            subaccountAddress,
            leverage,
            leverageValue,
            beforeNet,
            marketAddr: configuredMarketAddr,
          });
        } else {
          throw error;
        }
      }
    } else {
      logManualTrade("leverage_skipped_existing_position", {
        marketName,
        subaccountAddress,
        leverage,
        leverageValue,
        beforeNet,
        marketAddr: configuredMarketAddr,
      });
    }

    const isReduceOnly = action === "close";
    const chainSize = sizeToChain(humanSize, meta.szDecimals, meta.lotSize, meta.minSize);
    const actualHumanSize = chainSize / Math.pow(10, meta.szDecimals);
    const minHumanSize = meta.minSize / Math.pow(10, meta.szDecimals);
    let humanPrice = Number(price || 0);
    let timeInForce: TimeInForce = TimeInForce.GoodTillCanceled;

    if (orderType === "market") {
      const slippage = meta.currentPrice * 0.01;
      humanPrice = side === "buy" ? meta.currentPrice + slippage : meta.currentPrice - slippage;
      timeInForce = TimeInForce.ImmediateOrCancel;
    } else {
      if (!(humanPrice > 0)) {
        res.status(400).json({ error: "限价单必须填写价格" });
        return;
      }
    }

    const result = await writeDex.placeOrder({
      marketName,
      price: priceToChain(humanPrice, meta.pxDecimals, meta.tickSize),
      size: chainSize,
      isBuy: side === "buy",
      timeInForce,
      isReduceOnly,
      subaccountAddr: subaccountAddress,
      ...(CONFIG.BUILDER_ADDRESS
        ? { builderAddr: CONFIG.BUILDER_ADDRESS, builderFee: CONFIG.BUILDER_FEE_BPS }
        : {}),
    });

    if (!result?.success) {
      const rawError = result?.error
        || (typeof result === "object" ? JSON.stringify(result) : String(result))
        || "Unknown order failure";
      logManualTrade("result", {
        marketName,
        subaccountAddress,
        side,
        orderType,
        action,
        requestedSize: humanSize,
        actualSize: actualHumanSize,
        success: false,
        error: rawError,
        rawResult: result,
      });
      res.status(400).json({
        error: rawError || "Decibel 下单失败",
        success: false,
        marketName,
        side,
        action,
        orderType,
        requestedSize: humanSize,
        actualSize: actualHumanSize,
        minSize: minHumanSize,
      });
      return;
    }

    if (orderType === "market") {
      try {
        await triggerMarketMatching(writeDex, meta.marketAddr);
        logManualTrade("matching", {
          marketName,
          subaccountAddress,
          action,
          side,
          marketAddr: meta.marketAddr,
        });
      } catch (matchError: any) {
        logManualTrade("matching_error", {
          marketName,
          subaccountAddress,
          action,
          side,
          message: matchError?.message || String(matchError),
        });
      }
    }

    let afterNet = beforeNet;
    if (orderType === "market") {
      for (let i = 0; i < 8; i++) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        afterNet = await getMarketNetPosition(readDex, subaccountAddress, marketName, meta.marketAddr);
        if (Math.abs(afterNet - beforeNet) > 0.000001) break;
      }
    }

    const safeBeforeNet = finiteNumber(beforeNet, 0);
    const safeAfterNet = finiteNumber(afterNet, safeBeforeNet);
    const netDelta = safeAfterNet - safeBeforeNet;
    const fillConfirmed = orderType === "limit"
      ? false
      : Math.abs(netDelta) > 0.000001;
    const inspection = await inspectManualOrder(
      readDex,
      subaccountAddress,
      marketName,
      meta.marketAddr,
      result.success ? result.orderId : undefined,
    );
    const executionState = fillConfirmed
      ? "filled"
        : inspection.observedOpen
          ? "resting"
          : inspection.observedHistory
            ? `history:${inspection.historyStatus || "unknown"}`
            : "not_observed";

    logManualTrade("result", {
      marketName,
      subaccountAddress,
      side,
      orderType,
      action,
      beforeNet: safeBeforeNet,
      afterNet: safeAfterNet,
      netDelta,
      requestedSize: humanSize,
      actualSize: actualHumanSize,
      success: true,
      orderId: result.success ? result.orderId : null,
      transactionHash: result.success ? result.transactionHash : null,
      executionState,
      observedOpen: inspection.observedOpen,
      observedHistory: inspection.observedHistory,
      historyStatus: inspection.historyStatus,
    });

    res.json({
      success: !!result?.success,
      orderId: result.success ? result.orderId : null,
      transactionHash: result.success ? result.transactionHash : null,
      marketName,
      side,
      action,
      orderType,
      leverage,
      leverageValue,
      isReduceOnly,
      price: humanPrice,
      size: humanSize,
      currentPrice: meta.currentPrice,
      fillConfirmed,
      beforeNet: safeBeforeNet,
      afterNet: safeAfterNet,
      netDelta,
      requestedSize: humanSize,
      actualSize: actualHumanSize,
      minSize: minHumanSize,
      executionState,
      observedOpen: inspection.observedOpen,
      observedHistory: inspection.observedHistory,
      historyStatus: inspection.historyStatus,
    });
  } catch (error: any) {
    logManualTrade("error", { message: error?.message || String(error) });
    res.status(500).json({ error: `手动下单失败: ${error?.message}` });
  }
};

app.post("/api/manual/order", handleManualOrder);
app.post("/api/manual-order", handleManualOrder);

const handleManualCloseAll = async (req: express.Request, res: express.Response) => {
  try {
    const {
      apiWalletPrivateKey,
      bearerToken,
      subaccountAddress,
      marketName,
    } = req.body as Record<string, any>;

    if (!apiWalletPrivateKey || !subaccountAddress || !marketName) {
      res.status(400).json({ error: "缺少 API 私钥、子账户或市场" });
      return;
    }

    const { readDex, writeDex } = getUserDex(apiWalletPrivateKey, bearerToken);
    const meta = await getMarketMeta(readDex, marketName);
    const netSize = await getMarketNetPosition(readDex, subaccountAddress, marketName, meta.marketAddr);
    if (Math.abs(netSize) <= 0.000001) {
      res.json({ success: true, closed: false, message: "当前市场无持仓" });
      return;
    }

    const closeSide = netSize > 0 ? "sell" : "buy";
    const slippage = meta.currentPrice * 0.01;
    const humanPrice = closeSide === "buy" ? meta.currentPrice + slippage : meta.currentPrice - slippage;

    const result = await writeDex.placeOrder({
      marketName,
      price: priceToChain(humanPrice, meta.pxDecimals, meta.tickSize),
      size: sizeToChain(Math.abs(netSize), meta.szDecimals, meta.lotSize, meta.minSize),
      isBuy: closeSide === "buy",
      timeInForce: TimeInForce.ImmediateOrCancel,
      isReduceOnly: true,
      subaccountAddr: subaccountAddress,
      ...(CONFIG.BUILDER_ADDRESS
        ? { builderAddr: CONFIG.BUILDER_ADDRESS, builderFee: CONFIG.BUILDER_FEE_BPS }
        : {}),
    });

    if (result.success) {
      try {
        await triggerMarketMatching(writeDex, meta.marketAddr);
        logManualTrade("close_matching", {
          marketName,
          subaccountAddress,
          closeSide,
          marketAddr: meta.marketAddr,
        });
      } catch (matchError: any) {
        logManualTrade("close_matching_error", {
          marketName,
          subaccountAddress,
          closeSide,
          message: matchError?.message || String(matchError),
        });
      }
    }

    let afterNet = netSize;
    if (result.success) {
      for (let i = 0; i < 8; i++) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        afterNet = await getMarketNetPosition(readDex, subaccountAddress, marketName, meta.marketAddr);
        if (Math.abs(afterNet) < Math.abs(netSize) - 0.000001) break;
      }
    }

    const safeBeforeNet = finiteNumber(netSize, 0);
    const safeAfterNet = finiteNumber(afterNet, safeBeforeNet);
    const fillConfirmed = Math.abs(safeAfterNet) < Math.abs(safeBeforeNet) - 0.000001;

    res.json({
      success: !!result?.success,
      closed: true,
      orderId: result.success ? result.orderId : null,
      side: closeSide,
      size: Math.abs(netSize),
      price: humanPrice,
      fillConfirmed,
      beforeNet: safeBeforeNet,
      afterNet: safeAfterNet,
    });
  } catch (error: any) {
    res.status(500).json({ error: `市价平仓失败: ${error?.message}` });
  }
};

app.post("/api/manual/close-all", handleManualCloseAll);
app.post("/api/manual-close-all", handleManualCloseAll);

const handleManualCancelAll = async (req: express.Request, res: express.Response) => {
  try {
    const {
      apiWalletPrivateKey,
      bearerToken,
      subaccountAddress,
      marketName,
    } = req.body as Record<string, any>;

    if (!apiWalletPrivateKey || !subaccountAddress || !marketName) {
      res.status(400).json({ error: "缺少 API 私钥、子账户或市场" });
      return;
    }

    const { writeDex } = getUserDex(apiWalletPrivateKey, bearerToken);
    await writeDex.cancelBulkOrder({
      marketName,
      subaccountAddr: subaccountAddress,
    });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: `撤销挂单失败: ${error?.message}` });
  }
};

app.post("/api/manual/cancel-all", handleManualCancelAll);
app.post("/api/manual-cancel-all", handleManualCancelAll);

// ---- 交易机器人 API ----

// 获取用户机器人状态
app.get("/api/status/:wallet", (req, res) => {
  const session = sessions.get(req.params.wallet.toLowerCase());
  if (session?.engine) {
    res.json(session.engine.getStatus());
  } else {
    res.json({ running: false, totalRounds: 0, totalVolume: 0, totalProfit: 0, uptime: 0 });
  }
});

// 获取用户日志
app.get("/api/logs/:wallet", (req, res) => {
  const session = sessions.get(req.params.wallet.toLowerCase());
  res.json(session?.logs || []);
});

// 启动机器人
app.post("/api/start", async (req, res) => {
  try {
    const {
      walletAddress,
      apiWalletPrivateKey,
      subaccountAddress,
      bearerToken,
      marketName,
      orderSizeUsd,
      priceOffset,
      direction,
      totalVolumeLimit,
      staleOrderTimeoutMs,
      strategy,
      upperPrice,
      lowerPrice,
      gridCount,
    } = req.body as Record<string, any>;

    if (!walletAddress || !apiWalletPrivateKey || !subaccountAddress) {
      res.status(400).json({ error: "请填写钱包地址、API 私钥和子账户地址" });
      return;
    }
    if (!orderSizeUsd || orderSizeUsd <= 0) {
      res.status(400).json({ error: "下单金额必须大于 0" });
      return;
    }

    const session = getOrCreateSession(walletAddress);
    if (session.engine) {
      res.status(400).json({ error: "机器人已在运行中" });
      return;
    }

    let engine: GridEngine | GridStrategy;
    if (strategy === "grid") {
      if (!upperPrice || !lowerPrice || !gridCount) {
        res.status(400).json({ error: "网格策略需要设置上限价格、下限价格和网格数量" });
        return;
      }
      engine = new GridStrategy({
        apiWalletPrivateKey,
        subaccountAddress,
        bearerToken: bearerToken || CONFIG.API_BEARER_TOKEN,
        marketName: marketName || "BTC/USD",
        orderSizeUsd: Number(orderSizeUsd),
        direction: direction || "Both",
        totalVolumeLimit: Number(totalVolumeLimit || 0),
        upperPrice: Number(upperPrice),
        lowerPrice: Number(lowerPrice),
        gridCount: Number(gridCount),
      });
    } else {
      engine = new GridEngine({
        apiWalletPrivateKey,
        subaccountAddress,
        bearerToken: bearerToken || CONFIG.API_BEARER_TOKEN,
        marketName: marketName || "BTC/USD",
        orderSizeUsd: Number(orderSizeUsd),
        priceOffset: Number(priceOffset || 10),
        direction: direction || "Both",
        totalVolumeLimit: Number(totalVolumeLimit || 0),
        staleOrderTimeoutMs: Number(staleOrderTimeoutMs || CONFIG.STALE_ORDER_TIMEOUT_MS),
      });
    }

    engine.onStatusUpdate = (status: any) => {
      broadcastToUser(session, { type: "status", data: status });
      if (status.running === false && session.engine === engine) {
        session.engine = null;
      }
    };
    engine.onLog = (msg) => {
      const entry = `[${new Date().toLocaleTimeString()}] ${msg}`;
      session.logs.push(entry);
      if (session.logs.length > MAX_LOGS) session.logs.shift();
      broadcastToUser(session, { type: "log", data: entry });
    };

    session.engine = engine;
    res.json({ message: "机器人启动中..." });

    engine.start().catch((error) => {
      const msg = `启动失败: ${error?.message}`;
      console.error(msg);
      const entry = `[${new Date().toLocaleTimeString()}] ${msg}`;
      session.logs.push(entry);
      broadcastToUser(session, { type: "log", data: entry });
      broadcastToUser(session, { type: "status", data: { running: false } });
      session.engine = null;
    });
  } catch (error: any) {
    res.status(500).json({ error: `启动接口异常: ${error?.message}` });
  }
});

// 停止机器人
app.post("/api/stop", async (req, res) => {
  try {
    const { walletAddress } = req.body as Record<string, any>;
    if (!walletAddress) {
      res.status(400).json({ error: "缺少钱包地址" });
      return;
    }

    const session = sessions.get(walletAddress.toLowerCase());
    if (!session?.engine) {
      res.status(400).json({ error: "机器人未在运行" });
      return;
    }

    await session.engine.stop();
    session.engine = null;
    broadcastToUser(session, { type: "status", data: { running: false, totalRounds: 0, totalVolume: 0, totalProfit: 0, uptime: 0 } });
    res.json({ message: "机器人已停止" });
  } catch (error: any) {
    res.status(500).json({ error: `停止接口异常: ${error?.message}` });
  }
});

// ---- WebSocket ----

wss.on("connection", (ws, req) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const wallet = url.searchParams.get("wallet");

  if (!wallet) {
    ws.send(JSON.stringify({ type: "error", data: "请先连接钱包" }));
    ws.close();
    return;
  }

  const session = getOrCreateSession(wallet);
  session.wsClients.add(ws);

  if (session.engine) {
    ws.send(JSON.stringify({ type: "status", data: session.engine.getStatus() }));
  }
  if (session.logs.length > 0) {
    ws.send(JSON.stringify({ type: "logs", data: session.logs }));
  }

  ws.on("close", () => {
    session.wsClients.delete(ws);
  });
});

// ---- 启动服务器 ----

const PORT = Number(process.env.PORT || 3000);

server.listen(PORT, () => {
  console.log(`\n  Decibel 网格交易机器人 (多用户版)`);
  console.log(`  http://localhost:${PORT}\n`);
});

const shutdown = async () => {
  for (const session of sessions.values()) {
    if (session.engine) await session.engine.stop();
  }
  server.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
