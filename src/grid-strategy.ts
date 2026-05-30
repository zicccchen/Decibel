import {
  DecibelReadDex,
  DecibelWriteDex,
  MAINNET_CONFIG,
  TESTNET_CONFIG,
  TimeInForce,
} from "@decibeltrade/sdk";
import type { DecibelConfig } from "@decibeltrade/sdk";
import { Account, Ed25519PrivateKey } from "@aptos-labs/ts-sdk";
import { CONFIG } from "./config.js";

export type Direction = "Both" | "Long_Only" | "Short_Only";

export interface GridStrategyConfig {
  apiWalletPrivateKey: string;
  subaccountAddress: string;
  bearerToken: string;
  marketName: string;
  orderSizeUsd: number;
  direction: Direction;
  totalVolumeLimit: number;
  upperPrice: number;
  lowerPrice: number;
  gridCount: number;
  pollIntervalMs?: number;
}

export interface ActiveOrder {
  side: "buy" | "sell";
  price: number;
  size: number;
  orderId?: string;
  status: "pending" | "placed" | "filled" | "error";
}

export interface GridBotStatus {
  running: boolean;
  strategy: "grid";
  market: string;
  currentPrice: number;
  upperPrice: number;
  lowerPrice: number;
  gridCount: number;
  gridSpacing: number;
  orderSizeUsd: number;
  orderSizeBtc: number;
  direction: Direction;
  activeBuyOrders: number;
  activeSellOrders: number;
  totalOrders: number;
  totalRounds: number;
  totalVolume: number;
  totalVolumeLimit: number;
  totalProfit: number;
  uptime: number;
  buyOrder: ActiveOrder | null;
  sellOrder: ActiveOrder | null;
  priceOffset: number;
}

interface GridLevel {
  index: number;
  price: number;
}

interface TrackedGridOrder {
  orderId: string;
  levelIndex: number;
  side: "buy" | "sell";
  price: number;
  size: number;
  placedAt: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GridStrategy {
  private readDex!: DecibelReadDex;
  private writeDex!: DecibelWriteDex;
  private account!: Account;
  private readonly cfg: GridStrategyConfig;

  private isRunning = false;
  private startTime = 0;
  private currentPrice = 0;
  private lastPriceUpdateAt = 0;
  private totalRounds = 0;
  private totalVolume = 0;
  private totalProfit = 0;

  private unsubPrice?: () => void;
  private unsubOrders?: () => void;
  private unsubTrades?: () => void;

  private marketAddr?: string;
  private gridLevels: GridLevel[] = [];
  private gridSpacing = 0;
  private activeOrders = new Map<string, TrackedGridOrder>();
  private levelOrderIds = new Map<number, string>();
  private seenTradeIds = new Set<string>();

  private syncInFlight = false;
  private syncQueued = false;
  private remoteReconcileInFlight = false;

  private PX_DECIMALS = 6;
  private SZ_DECIMALS = 8;
  private TICK_SIZE = 100000;
  private LOT_SIZE = 1000;
  private MIN_SIZE = 2000;

  onStatusUpdate?: (status: GridBotStatus) => void;
  onLog?: (message: string) => void;

  constructor(config: GridStrategyConfig) {
    this.cfg = config;
  }

  private log(message: string): void {
    console.log(message);
    this.onLog?.(message);
  }

  getStatus(): GridBotStatus {
    let activeBuyOrders = 0;
    let activeSellOrders = 0;
    let nearestBuy: ActiveOrder | null = null;
    let nearestSell: ActiveOrder | null = null;

    for (const order of this.activeOrders.values()) {
      if (order.side === "buy") {
        activeBuyOrders++;
        if (!nearestBuy || order.price > nearestBuy.price) {
          nearestBuy = { side: "buy", price: order.price, size: order.size, orderId: order.orderId, status: "placed" };
        }
      } else {
        activeSellOrders++;
        if (!nearestSell || order.price < nearestSell.price) {
          nearestSell = { side: "sell", price: order.price, size: order.size, orderId: order.orderId, status: "placed" };
        }
      }
    }

    return {
      running: this.isRunning,
      strategy: "grid",
      market: this.cfg.marketName,
      currentPrice: this.currentPrice,
      upperPrice: this.cfg.upperPrice,
      lowerPrice: this.cfg.lowerPrice,
      gridCount: this.cfg.gridCount,
      gridSpacing: this.gridSpacing,
      orderSizeUsd: this.cfg.orderSizeUsd,
      orderSizeBtc: this.currentPrice > 0 ? this.cfg.orderSizeUsd / this.currentPrice : 0,
      direction: this.cfg.direction,
      activeBuyOrders,
      activeSellOrders,
      totalOrders: this.activeOrders.size,
      totalRounds: this.totalRounds,
      totalVolume: this.totalVolume,
      totalVolumeLimit: this.cfg.totalVolumeLimit,
      totalProfit: this.totalProfit,
      uptime: this.startTime > 0 ? Date.now() - this.startTime : 0,
      buyOrder: nearestBuy,
      sellOrder: nearestSell,
      priceOffset: this.gridSpacing,
    };
  }

  private emitStatus(): void {
    this.onStatusUpdate?.(this.getStatus());
  }

  private isVolumeLimitReached(): boolean {
    return this.cfg.totalVolumeLimit > 0 && this.totalVolume >= this.cfg.totalVolumeLimit;
  }

  async initialize(): Promise<void> {
    this.log("=== 初始化网格交易策略 ===");

    if (this.cfg.upperPrice <= this.cfg.lowerPrice) {
      throw new Error("上限价格必须大于下限价格");
    }
    if (this.cfg.gridCount < 2) {
      throw new Error("网格数量至少为 2");
    }

    this.gridSpacing = (this.cfg.upperPrice - this.cfg.lowerPrice) / (this.cfg.gridCount - 1);
    this.gridLevels = Array.from({ length: this.cfg.gridCount }, (_, index) => ({
      index,
      price: this.cfg.lowerPrice + index * this.gridSpacing,
    }));

    this.log(`价格区间: $${this.cfg.lowerPrice} ~ $${this.cfg.upperPrice}`);
    this.log(`网格层数: ${this.cfg.gridCount} | 层间距: $${this.gridSpacing.toFixed(2)}`);
    this.log("策略模型: 固定价格层 + 目标订单集同步");
    this.log(`单笔金额: $${this.cfg.orderSizeUsd} | 方向: ${this.cfg.direction}`);
    this.log(`流水目标: ${this.cfg.totalVolumeLimit > 0 ? "$" + this.cfg.totalVolumeLimit : "无限"}`);

    const privateKey = new Ed25519PrivateKey(this.cfg.apiWalletPrivateKey);
    this.account = Account.fromPrivateKey({ privateKey });

    const baseConfig: DecibelConfig = CONFIG.NETWORK === "mainnet" ? MAINNET_CONFIG : TESTNET_CONFIG;
    const decibelConfig: DecibelConfig = {
      ...baseConfig,
      fullnodeUrl: CONFIG.FULLNODE_URL,
      tradingHttpUrl: CONFIG.DECIBEL_REST_URL,
      tradingWsUrl: CONFIG.DECIBEL_WS_URL,
      gasStationApiKey: CONFIG.GAS_STATION_API_KEY,
    };

    this.readDex = new DecibelReadDex(decibelConfig, {
      nodeApiKey: this.cfg.bearerToken || undefined,
    });
    this.writeDex = new DecibelWriteDex(decibelConfig, this.account, {
      nodeApiKey: this.cfg.bearerToken || undefined,
    });

    try {
      const markets = await this.readDex.markets.getAll();
      const market = (markets as any[]).find(
        (item: any) => (item.market_name || item.name) === this.cfg.marketName,
      );
      if (market) {
        this.marketAddr = market.market_addr;
        this.LOT_SIZE = Number(market.lot_size || this.LOT_SIZE);
        this.MIN_SIZE = Number(market.min_size || this.MIN_SIZE);
        this.TICK_SIZE = Number(market.ticker_size || market.tick_size || this.TICK_SIZE);
        this.SZ_DECIMALS = Number(market.sz_precision?.decimals ?? market.sz_decimals ?? this.SZ_DECIMALS);
        this.PX_DECIMALS = Number(market.px_decimals ?? this.PX_DECIMALS);
        this.log(`市场参数: addr=${this.marketAddr} lot=${this.LOT_SIZE} min=${this.MIN_SIZE} tick=${this.TICK_SIZE} pxDec=${this.PX_DECIMALS} szDec=${this.SZ_DECIMALS}`);
      }
    } catch {
      // ignore
    }

    this.log(`钱包: ${this.account.accountAddress.toString()}`);
    this.log(`子账户: ${this.cfg.subaccountAddress}`);
    this.log("初始化完成");
  }

  private priceToChain(humanPrice: number): number {
    const raw = Math.round(humanPrice * Math.pow(10, this.PX_DECIMALS));
    return Math.round(raw / this.TICK_SIZE) * this.TICK_SIZE;
  }

  private sizeToChain(humanSize: number): number {
    const raw = Math.round(humanSize * Math.pow(10, this.SZ_DECIMALS));
    return Math.max(Math.floor(raw / this.LOT_SIZE) * this.LOT_SIZE, this.MIN_SIZE);
  }

  private getBuilderParams(): Record<string, any> {
    if (!CONFIG.BUILDER_ADDRESS) {
      throw new Error("BUILDER_ADDRESS 未配置");
    }
    return {
      builderAddr: CONFIG.BUILDER_ADDRESS,
      builderFee: CONFIG.BUILDER_FEE_BPS,
    };
  }

  private async fetchCurrentPrice(): Promise<number> {
    const prices = await this.readDex.marketPrices.getByName({ marketName: this.cfg.marketName });
    if (!prices?.length) {
      throw new Error(`无法获取 ${this.cfg.marketName} 价格`);
    }
    return prices[0].mid_px || prices[0].mark_px || prices[0].oracle_px;
  }

  private async waitForWsPrice(timeoutMs = 5000): Promise<number> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (this.currentPrice > 0 && this.lastPriceUpdateAt > 0) {
        return this.currentPrice;
      }
      await sleep(50);
    }
    this.currentPrice = await this.fetchCurrentPrice();
    return this.currentPrice;
  }

  private getOrderSizeBtc(): number {
    if (this.currentPrice <= 0) return 0;
    return Math.floor((this.cfg.orderSizeUsd / this.currentPrice) * 1e8) / 1e8;
  }

  private getDesiredSideForLevel(levelPrice: number): "buy" | "sell" | null {
    const distance = Math.abs(levelPrice - this.currentPrice);
    if (distance < Math.max(this.gridSpacing * 0.2, 0.01)) return null;
    if (levelPrice < this.currentPrice) {
      return this.cfg.direction === "Both" || this.cfg.direction === "Long_Only" ? "buy" : null;
    }
    if (levelPrice > this.currentPrice) {
      return this.cfg.direction === "Both" || this.cfg.direction === "Short_Only" ? "sell" : null;
    }
    return null;
  }

  private findOrderByLevel(levelIndex: number): TrackedGridOrder | undefined {
    const orderId = this.levelOrderIds.get(levelIndex);
    return orderId ? this.activeOrders.get(orderId) : undefined;
  }

  private trackOrder(order: TrackedGridOrder): void {
    this.activeOrders.set(order.orderId, order);
    this.levelOrderIds.set(order.levelIndex, order.orderId);
  }

  private untrackOrder(orderId: string): TrackedGridOrder | undefined {
    const tracked = this.activeOrders.get(orderId);
    if (!tracked) return undefined;
    this.activeOrders.delete(orderId);
    const currentLevelOrderId = this.levelOrderIds.get(tracked.levelIndex);
    if (currentLevelOrderId === orderId) {
      this.levelOrderIds.delete(tracked.levelIndex);
    }
    return tracked;
  }

  private subscribePriceUpdates(): void {
    this.unsubPrice = this.readDex.marketPrices.subscribeByName(this.cfg.marketName, (data: any) => {
      const payload = data.price || data;
      const price = payload.mid_px || payload.mark_px || payload.oracle_px;
      if (!price || price <= 0) return;
      this.currentPrice = price;
      this.lastPriceUpdateAt = Date.now();
    });
    this.log("[WS] 已订阅价格实时推送");
  }

  private subscribeOrderUpdates(): void {
    this.unsubOrders = this.readDex.userOpenOrders.subscribeByAddr(this.cfg.subaccountAddress, (data: any) => {
      if (!this.isRunning) return;
      const orders = data.orders || [];
      this.log(`[WS订单] 当前远端挂单 ${orders.length} 个 | 本地跟踪 ${this.activeOrders.size} 个`);
      void this.reconcileRemoteOrders(orders).catch((e: any) => {
        this.log(`[WS订单对账异常] ${e?.message}`);
      });
    });
    this.log("[WS] 已订阅订单实时推送");
  }

  private subscribeTradeUpdates(): void {
    this.unsubTrades = this.readDex.userTradeHistory.subscribeByAddr(this.cfg.subaccountAddress, (data: any) => {
      const trades = data.trades || [];
      for (const trade of trades) {
        void this.processTradeEvent(trade).catch((e: any) => {
          this.log(`[WS成交处理异常] ${e?.message}`);
        });
      }
    });
    this.log("[WS] 已订阅用户成交推送");
  }

  private async processTradeEvent(trade: any): Promise<void> {
    if (!this.isRunning) return;
    if (!trade?.trade_id || this.seenTradeIds.has(trade.trade_id)) return;
    if (this.marketAddr && trade.market && trade.market !== this.marketAddr) return;
    if (trade.source !== "OrderFill") return;

    const orderId = trade.order_id;
    if (!orderId || !this.activeOrders.has(orderId)) return;

    this.seenTradeIds.add(trade.trade_id);

    const tracked = this.untrackOrder(orderId);
    if (!tracked) return;

    const fillPrice = Number(trade.price || tracked.price);
    const fillSize = Number(trade.size || tracked.size);
    const volume = fillPrice * fillSize;

    this.totalRounds++;
    this.totalVolume += volume;

    this.log(`[成交] ${tracked.side === "buy" ? "买" : "卖"}单成交 level=${tracked.levelIndex} @ $${fillPrice.toFixed(2)} | ${fillSize} BTC | 本次成交额: $${volume.toFixed(2)}`);

    if (this.isVolumeLimitReached()) {
      this.log(`[达到流水目标] $${this.totalVolume.toFixed(2)} / $${this.cfg.totalVolumeLimit}`);
      await this.stop();
      return;
    }

    this.emitStatus();
    void this.scheduleSync("fill");
  }

  private async placeOrderForLevel(level: GridLevel, side: "buy" | "sell"): Promise<void> {
    if (!this.isRunning) return;
    if (this.findOrderByLevel(level.index)) return;

    const price = level.price;
    const size = this.getOrderSizeBtc();
    const chainSize = this.sizeToChain(size);
    const builderParams = this.getBuilderParams();

    const result = await this.writeDex.placeOrder({
      marketName: this.cfg.marketName,
      price: this.priceToChain(price),
      size: chainSize,
      isBuy: side === "buy",
      timeInForce: TimeInForce.GoodTillCanceled,
      isReduceOnly: false,
      subaccountAddr: this.cfg.subaccountAddress,
      ...builderParams,
    });

    if (!result.success || !result.orderId) {
      throw new Error(`挂单失败 level=${level.index} side=${side}`);
    }

    this.trackOrder({
      orderId: result.orderId,
      levelIndex: level.index,
      side,
      price,
      size,
      placedAt: Date.now(),
    });

    this.log(`[挂单] level=${level.index} ${side === "buy" ? "买" : "卖"} @ $${price.toFixed(2)} | ${size} BTC | 总挂单 ${this.activeOrders.size}/${this.cfg.gridCount}`);
  }

  private async cancelTrackedOrder(order: TrackedGridOrder, reason: string): Promise<void> {
    try {
      await this.writeDex.cancelOrder({
        orderId: order.orderId,
        marketName: this.cfg.marketName,
        subaccountAddr: this.cfg.subaccountAddress,
      });
    } catch (e: any) {
      const message = e?.message || "";
      if (!message.includes("EORDER_NOT_FOUND")) {
        this.log(`[撤单异常] ${order.orderId.slice(0, 12)}... ${message}`);
      }
    } finally {
      this.untrackOrder(order.orderId);
      this.log(`[撤单] level=${order.levelIndex} ${order.side} @ $${order.price.toFixed(2)} | reason=${reason}`);
    }
  }

  private async syncGrid(reason: string): Promise<void> {
    if (!this.isRunning) return;
    if (this.currentPrice <= 0) {
      await this.waitForWsPrice();
    }

    if (this.currentPrice < this.cfg.lowerPrice || this.currentPrice > this.cfg.upperPrice) {
      this.log(`[网格同步] 当前价 $${this.currentPrice.toFixed(2)} 超出区间，暂停补新单`);
    }

    const desired = new Map<number, "buy" | "sell">();
    for (const level of this.gridLevels) {
      const side = this.getDesiredSideForLevel(level.price);
      if (side) desired.set(level.index, side);
    }

    for (const order of [...this.activeOrders.values()]) {
      const expectedSide = desired.get(order.levelIndex);
      const level = this.gridLevels[order.levelIndex];
      const priceMatches = level ? Math.abs(order.price - level.price) < 0.01 : false;
      if (!expectedSide || expectedSide !== order.side || !priceMatches) {
        await this.cancelTrackedOrder(order, `sync:${reason}`);
      }
    }

    for (const level of this.gridLevels) {
      const desiredSide = desired.get(level.index);
      if (!desiredSide) continue;
      if (this.findOrderByLevel(level.index)) continue;
      await this.placeOrderForLevel(level, desiredSide);
      await sleep(80);
    }

    this.log(`[网格同步完成] reason=${reason} | 当前价=$${this.currentPrice.toFixed(2)} | 活跃挂单=${this.activeOrders.size}/${this.cfg.gridCount}`);
    this.emitStatus();
  }

  private async scheduleSync(reason: string): Promise<void> {
    if (this.syncInFlight) {
      this.syncQueued = true;
      return;
    }

    this.syncInFlight = true;
    try {
      do {
        this.syncQueued = false;
        await this.syncGrid(reason);
      } while (this.syncQueued && this.isRunning);
    } finally {
      this.syncInFlight = false;
    }
  }

  private async reconcileRemoteOrders(wsOrders?: any[]): Promise<void> {
    if (!this.isRunning || this.remoteReconcileInFlight) return;
    this.remoteReconcileInFlight = true;

    try {
      const openOrdersResponse = wsOrders
        ? { items: wsOrders }
        : await this.readDex.userOpenOrders.getByAddr({ subAddr: this.cfg.subaccountAddress });
      const openItems = (openOrdersResponse as any).items || wsOrders || [];
      const openIds = new Set(openItems.map((item: any) => item.order_id));

      let needsSync = false;

      for (const order of [...this.activeOrders.values()]) {
        if (openIds.has(order.orderId)) continue;

        const history = await this.readDex.userOrderHistory.getByAddr({
          subAddr: this.cfg.subaccountAddress,
          limit: 100,
        });
        const historyItem = (history.items || []).find((item: any) => item.order_id === order.orderId);
        const status = String(historyItem?.status || "").toLowerCase();

        if (status.includes("filled")) {
          this.untrackOrder(order.orderId);
          const fillPrice = Number(historyItem?.price || order.price);
          const fillSize = Number(historyItem?.orig_size || order.size);
          const volume = fillPrice * fillSize;
          this.totalRounds++;
          this.totalVolume += volume;
          this.log(`[远端对账成交] level=${order.levelIndex} ${order.side} @ $${fillPrice.toFixed(2)} | 本次成交额: $${volume.toFixed(2)}`);

          if (this.isVolumeLimitReached()) {
            this.log(`[达到流水目标] $${this.totalVolume.toFixed(2)} / $${this.cfg.totalVolumeLimit}`);
            await this.stop();
            return;
          }

          needsSync = true;
          continue;
        }

        if (!status || status.includes("open") || status.includes("pending") || status.includes("partial")) {
          continue;
        }

        this.untrackOrder(order.orderId);
        this.log(`[远端对账移除] level=${order.levelIndex} ${order.side} 状态=${status || "unknown"}`);
        needsSync = true;
      }

      if (needsSync) {
        await this.scheduleSync("remote_reconcile");
      }
    } catch (e: any) {
      this.log(`[远端对账异常] ${e?.message}`);
    } finally {
      this.remoteReconcileInFlight = false;
    }
  }

  async cancelAllOrders(): Promise<void> {
    this.log("--- 取消所有网格挂单 ---");
    try {
      await this.writeDex.cancelBulkOrder({
        marketName: this.cfg.marketName,
        subaccountAddr: this.cfg.subaccountAddress,
      });
    } catch (e: any) {
      this.log(`[批量撤单异常] ${e?.message}`);
    }

    try {
      const openOrders = await this.readDex.userOpenOrders.getByAddr({
        subAddr: this.cfg.subaccountAddress,
      });
      for (const order of openOrders.items || []) {
        try {
          await this.writeDex.cancelOrder({
            orderId: order.order_id,
            marketName: this.cfg.marketName,
            subaccountAddr: this.cfg.subaccountAddress,
          });
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }

    this.activeOrders.clear();
    this.levelOrderIds.clear();
    this.emitStatus();
  }

  private async pollRemoteReconcile(): Promise<void> {
    while (this.isRunning) {
      await sleep(this.cfg.pollIntervalMs ?? 3000);
      if (!this.isRunning) continue;
      await this.reconcileRemoteOrders();
    }
  }

  async start(): Promise<void> {
    await this.initialize();

    this.isRunning = true;
    this.startTime = Date.now();

    this.subscribePriceUpdates();
    this.subscribeOrderUpdates();
    this.subscribeTradeUpdates();

    await this.waitForWsPrice();
    await this.cancelAllOrders();
    await this.scheduleSync("startup");

    this.log(`=== 网格交易已启动 (${this.cfg.gridCount} 层, 最多 ${this.cfg.gridCount} 个活跃挂单) ===`);
    this.emitStatus();

    this.pollRemoteReconcile().catch((e: any) => this.log(`[网格轮询异常] ${e?.message}`));

    while (this.isRunning) {
      this.emitStatus();
      await sleep(2000);
    }
  }

  async stop(): Promise<void> {
    this.log("=== 正在停止网格交易 ===");
    this.isRunning = false;

    this.unsubPrice?.();
    this.unsubOrders?.();
    this.unsubTrades?.();
    this.unsubPrice = undefined;
    this.unsubOrders = undefined;
    this.unsubTrades = undefined;

    await this.cancelAllOrders();
    this.log(`=== 网格已停止 | 轮数: ${this.totalRounds} | 流水: $${this.totalVolume.toFixed(2)} | 利润: $${this.totalProfit.toFixed(4)} ===`);
    this.emitStatus();
  }
}
