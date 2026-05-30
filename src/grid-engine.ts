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
type BotPhase = "idle" | "placing" | "waiting_fill" | "closing" | "stopping";

export interface UserBotConfig {
  apiWalletPrivateKey: string;
  subaccountAddress: string;
  bearerToken: string;
  marketName: string;
  orderSizeUsd: number;
  priceOffset: number;
  direction: Direction;
  totalVolumeLimit: number;
  pollIntervalMs?: number;
  staleOrderTimeoutMs?: number;
}

export interface ActiveOrder {
  side: "buy" | "sell";
  price: number;
  size: number;
  orderId?: string;
  status: "pending" | "placed" | "filled" | "error";
  placedAt?: number;
}

export interface BotStatus {
  running: boolean;
  market: string;
  currentPrice: number;
  priceOffset: number;
  orderSizeUsd: number;
  orderSizeBtc: number;
  direction: Direction;
  buyOrder: ActiveOrder | null;
  sellOrder: ActiveOrder | null;
  totalRounds: number;
  totalVolume: number;
  totalVolumeLimit: number;
  totalProfit: number;
  uptime: number;
}

interface FillEvent {
  orderId?: string;
  side: "buy" | "sell";
  size: number;
  price: number;
  source: "trade_ws" | "trade_poll" | "position_guard";
}

interface CloseAttemptResult {
  reducedSize: number;
  reducedNotional: number;
}

interface CloseSubmitResult {
  submitted: boolean;
  submittedSize: number;
  submittedNotional: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GridEngine {
  private readDex!: DecibelReadDex;
  private writeDex!: DecibelWriteDex;
  private account!: Account;
  private readonly cfg: UserBotConfig;

  private isRunning = false;
  private phase: BotPhase = "idle";
  private startTime = 0;
  private currentPrice = 0;
  private totalRounds = 0;
  private totalVolume = 0;
  private totalProfit = 0;
  private buyOrder: ActiveOrder | null = null;
  private sellOrder: ActiveOrder | null = null;
  private marketAddr?: string;
  private lastPriceUpdateAt = 0;

  private unsubPrice?: () => void;
  private unsubOrders?: () => void;
  private unsubTrades?: () => void;

  private seenTradeIds = new Set<string>();

  private PX_DECIMALS = 6;
  private SZ_DECIMALS = 8;
  private TICK_SIZE = 100000;
  private LOT_SIZE = 1000;
  private MIN_SIZE = 1000;

  onStatusUpdate?: (status: BotStatus) => void;
  onLog?: (message: string) => void;

  constructor(userConfig: UserBotConfig) {
    this.cfg = userConfig;
  }

  private log(msg: string): void {
    console.log(msg);
    this.onLog?.(msg);
  }

  getStatus(): BotStatus {
    return {
      running: this.isRunning,
      market: this.cfg.marketName,
      currentPrice: this.currentPrice,
      priceOffset: this.cfg.priceOffset,
      orderSizeUsd: this.cfg.orderSizeUsd,
      orderSizeBtc: this.currentPrice > 0 ? this.cfg.orderSizeUsd / this.currentPrice : 0,
      direction: this.cfg.direction,
      buyOrder: this.buyOrder ? { ...this.buyOrder } : null,
      sellOrder: this.sellOrder ? { ...this.sellOrder } : null,
      totalRounds: this.totalRounds,
      totalVolume: this.totalVolume,
      totalVolumeLimit: this.cfg.totalVolumeLimit,
      totalProfit: this.totalProfit,
      uptime: this.startTime ? Date.now() - this.startTime : 0,
    };
  }

  private emitStatus(): void {
    this.onStatusUpdate?.(this.getStatus());
  }

  private isVolumeLimitReached(): boolean {
    return this.cfg.totalVolumeLimit > 0 && this.totalVolume >= this.cfg.totalVolumeLimit;
  }

  async initialize(): Promise<void> {
    this.log("=== 初始化交易机器人 ===");
    this.log(`市场: ${this.cfg.marketName} | 策略: 双边单组挂单 -> 单边成交 -> 立即平仓`);
    this.log(`价格偏移: ${this.cfg.priceOffset} USD | 方向: ${this.cfg.direction}`);
    this.log(`单笔金额: $${this.cfg.orderSizeUsd} | 流水目标: ${this.cfg.totalVolumeLimit > 0 ? "$" + this.cfg.totalVolumeLimit : "无限"}`);

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
        (m: any) => (m.market_name || m.name) === this.cfg.marketName,
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

  private async fetchCurrentPrice(): Promise<number> {
    const prices = await this.readDex.marketPrices.getByName({ marketName: this.cfg.marketName });
    if (!prices?.length) throw new Error(`无法获取 ${this.cfg.marketName} 价格`);
    return prices[0].mid_px || prices[0].mark_px || prices[0].oracle_px;
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
    if (!CONFIG.BUILDER_ADDRESS) throw new Error("BUILDER_ADDRESS 未配置");
    return {
      builderAddr: CONFIG.BUILDER_ADDRESS,
      builderFee: CONFIG.BUILDER_FEE_BPS,
    };
  }

  private isTrackedMarketPosition(pos: any): boolean {
    const marketId = pos.market_id || pos.market || "";
    if (!marketId) return false;
    return this.marketAddr ? marketId === this.marketAddr : true;
  }

  private getTrackedOrder(side: "buy" | "sell"): ActiveOrder | null {
    return side === "buy" ? this.buyOrder : this.sellOrder;
  }

  private setTrackedOrder(side: "buy" | "sell", order: ActiveOrder | null): void {
    if (side === "buy") this.buyOrder = order;
    else this.sellOrder = order;
  }

  private clearTrackedOrders(): void {
    this.buyOrder = null;
    this.sellOrder = null;
  }

  private subscribePriceUpdates(): void {
    this.unsubPrice = this.readDex.marketPrices.subscribeByName(
      this.cfg.marketName,
      (data: any) => {
        const p = data.price || data;
        const nextPrice = p.mid_px || p.mark_px || p.oracle_px;
        if (nextPrice && nextPrice > 0) {
          this.currentPrice = nextPrice;
          this.lastPriceUpdateAt = Date.now();
        }
      },
    );
    this.log("[WS] 已订阅价格实时推送");
  }

  private async waitForWsPrice(timeoutMs = 5000): Promise<number> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (this.currentPrice > 0 && this.lastPriceUpdateAt > 0) {
        return this.currentPrice;
      }
      await sleep(50);
    }

    throw new Error("等待 WS 价格超时");
  }

  private subscribeOrderUpdates(): void {
    this.unsubOrders = this.readDex.userOpenOrders.subscribeByAddr(
      this.cfg.subaccountAddress,
      (data: any) => {
        if (!this.isRunning) return;

        const orders = data.orders || [];
        const openIds = new Set(orders.map((o: any) => o.order_id));

        if (this.phase === "waiting_fill") {
          const tracked = [this.buyOrder, this.sellOrder]
            .filter((order): order is ActiveOrder => !!order?.orderId)
            .map((order) => ({
              side: order.side,
              orderId: order.orderId!,
              open: openIds.has(order.orderId!),
            }));

          const summary = tracked.map((item) => `${item.side}:${item.open ? "open" : "gone"}`).join(" ");
          this.log(`[WS订单] ${summary || "无跟踪订单"}`);
        }
      },
    );
    this.log("[WS] 已订阅订单实时推送");
  }

  private subscribeTradeUpdates(): void {
    this.unsubTrades = this.readDex.userTradeHistory.subscribeByAddr(
      this.cfg.subaccountAddress,
      (data: any) => {
        const trades = data.trades || [];
        for (const trade of trades) {
          this.processTradeEvent(trade, "trade_ws").catch((e) =>
            this.log(`[WS成交处理异常] ${e?.message}`),
          );
        }
      },
    );
    this.log("[WS] 已订阅用户成交推送");
  }

  private async pollForStaleEntryOrder(): Promise<void> {
    while (this.isRunning) {
      await sleep(1000);
      if (!this.isRunning || this.phase !== "waiting_fill") continue;
      if (this.cfg.direction === "Both") continue;

      const side: "buy" | "sell" = this.cfg.direction === "Long_Only" ? "buy" : "sell";
      const order = this.getTrackedOrder(side);
      if (!order || order.status !== "placed" || !order.placedAt) continue;

      const staleTimeoutMs = this.cfg.staleOrderTimeoutMs ?? 20000;
      if (Date.now() - order.placedAt < staleTimeoutMs) continue;

      this.log(`[超时重挂] ${side === "buy" ? "买" : "卖"}单 ${Math.round(staleTimeoutMs / 1000)} 秒未成交，撤单并按最新价格重挂`);
      this.phase = "placing";

      try {
        await this.cancelOrder(order);
        this.clearTrackedOrders();
        await this.placeBracketOrders();
      } catch (e: any) {
        this.phase = "idle";
        this.log(`[超时重挂异常] ${e?.message}`);
      }
    }
  }

  private async pollForTradeHistory(): Promise<void> {
    while (this.isRunning) {
      await sleep(this.cfg.pollIntervalMs ?? 1000);
      if (!this.isRunning || this.phase !== "waiting_fill") continue;

      try {
        const history = await this.readDex.userTradeHistory.getByAddr({
          subAddr: this.cfg.subaccountAddress,
          limit: 10,
        });
        for (const trade of history.items || []) {
          await this.processTradeEvent(trade, "trade_poll");
        }
      } catch {
        // ignore
      }
    }
  }

  private async pollForPositionGuard(): Promise<void> {
    while (this.isRunning) {
      await sleep(1000);
      if (!this.isRunning) continue;

      try {
        const net = await this.getNetPositionSize();
        if (Math.abs(net) <= 0.000001) continue;
        if (this.phase === "closing") continue;

        this.log(`[持仓保护] 检测到残留净持仓 ${net > 0 ? "多" : "空"} ${Math.abs(net)} BTC`);
        await this.handleFill({
          side: net > 0 ? "buy" : "sell",
          size: Math.abs(net),
          price: this.currentPrice || await this.fetchCurrentPrice(),
          source: "position_guard",
        });
      } catch (e: any) {
        this.log(`[持仓保护异常] ${e?.message}`);
      }
    }
  }

  private async processTradeEvent(trade: any, source: "trade_ws" | "trade_poll"): Promise<void> {
    if (!this.isRunning || this.phase !== "waiting_fill") return;
    if (!trade?.trade_id || this.seenTradeIds.has(trade.trade_id)) return;

    this.seenTradeIds.add(trade.trade_id);

    if (typeof trade.transaction_unix_ms === "number" && this.startTime > 0 && trade.transaction_unix_ms < this.startTime - 1000) {
      return;
    }

    if (this.marketAddr && trade.market !== this.marketAddr) return;
    if (trade.source !== "OrderFill") return;
    if (trade.action !== "OpenLong" && trade.action !== "OpenShort") return;

    const side: "buy" | "sell" = trade.action === "OpenLong" ? "buy" : "sell";
    const trackedOrder = this.getTrackedOrder(side);
    if (!trackedOrder?.orderId) return;
    if (trade.order_id && trade.order_id !== trackedOrder.orderId) return;

    await this.handleFill({
      orderId: trade.order_id,
      side,
      size: trade.size || trackedOrder.size,
      price: trade.price || trackedOrder.price,
      source,
    });
  }

  private async placeBracketOrders(): Promise<void> {
    if (!this.isRunning) return;

    this.phase = "placing";
    this.clearTrackedOrders();

    if (this.currentPrice <= 0 || this.lastPriceUpdateAt <= 0) {
      this.currentPrice = await this.waitForWsPrice();
    }

    const price = this.currentPrice;
    const btcSize = Math.floor((this.cfg.orderSizeUsd / price) * 1e8) / 1e8;
    const chainSize = this.sizeToChain(btcSize);
    const builderParams = this.getBuilderParams();
    const buyPrice = price - this.cfg.priceOffset;
    const sellPrice = price + this.cfg.priceOffset;

    this.log(`当前中间价: $${price.toFixed(2)} | $${this.cfg.orderSizeUsd} ≈ ${btcSize} BTC`);

    const tasks: Promise<void>[] = [];
    if (this.cfg.direction === "Both" || this.cfg.direction === "Long_Only") {
      tasks.push(this.placeSingleOrder("buy", buyPrice, btcSize, chainSize, builderParams));
    }
    if (this.cfg.direction === "Both" || this.cfg.direction === "Short_Only") {
      tasks.push(this.placeSingleOrder("sell", sellPrice, btcSize, chainSize, builderParams));
    }

    await Promise.all(tasks);

    const expectedBuy = this.cfg.direction === "Both" || this.cfg.direction === "Long_Only";
    const expectedSell = this.cfg.direction === "Both" || this.cfg.direction === "Short_Only";
    if ((expectedBuy && this.buyOrder?.status !== "placed") || (expectedSell && this.sellOrder?.status !== "placed")) {
      this.phase = "idle";
      await this.cancelAllOrders();
      throw new Error("双边挂单未完整建立");
    }

    this.phase = "waiting_fill";
    this.emitStatus();
  }

  private async placeSingleOrder(
    side: "buy" | "sell",
    price: number,
    btcSize: number,
    chainSize: number,
    builderParams: Record<string, any>,
  ): Promise<void> {
    const order: ActiveOrder = { side, price, size: btcSize, status: "pending" };
    this.setTrackedOrder(side, order);

    try {
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
        order.status = "error";
        this.log(`[${side === "buy" ? "买" : "卖"}单失败]`);
        return;
      }

      order.orderId = result.orderId;
      order.status = "placed";
      order.placedAt = Date.now();
      this.log(`[${side === "buy" ? "买" : "卖"}单已挂] ${btcSize} BTC @ $${price.toFixed(2)} | ID: ${result.orderId.slice(0, 16)}...`);
    } catch (e: any) {
      order.status = "error";
      this.log(`[${side === "buy" ? "买" : "卖"}单异常] ${e?.message}`);
    }
  }

  private async handleFill(fill: FillEvent): Promise<void> {
    if (!this.isRunning || this.phase === "closing" || this.phase === "stopping") return;

    this.phase = "closing";
    const filledOrder = this.getTrackedOrder(fill.side);
    const oppositeSide: "buy" | "sell" = fill.side === "buy" ? "sell" : "buy";
    const oppositeOrder = this.getTrackedOrder(oppositeSide);

    if (filledOrder) filledOrder.status = "filled";
    this.currentPrice = fill.price || this.currentPrice;
    this.log(`[成交] ${fill.side === "buy" ? "买" : "卖"}单成交 ${fill.size} BTC @ $${fill.price.toFixed(2)} | source=${fill.source}`);

    try {
      const closeSubmit = await this.marketCloseFast(fill.side, fill.size, fill.price);

      if (!closeSubmit.submitted) {
        throw new Error("首个平仓指令发送失败");
      }

      const openNotional = fill.price * fill.size;
      this.clearTrackedOrders();
      this.emitStatus();

      if (oppositeOrder?.status === "placed") {
        void this.cancelOrder(oppositeOrder).catch((e: any) => {
          this.log(`[异步撤单异常] ${e?.message}`);
        });
      }

      void this.reconcileAfterFastClose(fill, openNotional).catch((e) => {
        this.log(`[异步对账异常] ${e?.message}`);
        void this.recoverFromStuckState();
      });
      return;
    } catch (e: any) {
      this.log(`[成交处理异常] ${e?.message}`);
      await this.recoverFromStuckState();
    } finally {
      this.emitStatus();
    }
  }

  private async reconcileAfterFastClose(fill: FillEvent, openNotional: number): Promise<void> {
    await sleep(50);

    let net = await this.getNetPositionSize();
    let closeNotional = Math.max(0, fill.size - Math.abs(net)) * (this.currentPrice || fill.price);

    if (Math.abs(net) > 0.000001) {
      this.log(`[异步补平] 首次平仓后仍有残仓 ${net > 0 ? "多" : "空"} ${Math.abs(net)} BTC`);
      closeNotional += await this.flattenResidualPosition(this.currentPrice || fill.price);
      net = await this.getNetPositionSize();
    }

    if (Math.abs(net) > 0.000001) {
      throw new Error(`异步补平后仍残留 ${Math.abs(net)} BTC`);
    }

    const roundVolume = openNotional + closeNotional;
    this.totalVolume += roundVolume;
    this.totalRounds++;
    this.totalProfit += 0;
    this.log(`[第 ${this.totalRounds} 轮完成] 已完成开仓->平仓 | 本轮流水: $${roundVolume.toFixed(2)} | 累计: $${this.totalVolume.toFixed(2)}`);

    if (this.isVolumeLimitReached()) {
      this.log(`[达到流水目标] 累计: $${this.totalVolume.toFixed(2)} / $${this.cfg.totalVolumeLimit}`);
      await this.stop();
      return;
    }

    if (!this.isRunning || this.phase === "stopping") return;
    this.phase = "idle";
    await this.placeBracketOrders();
  }

  private async flattenResidualPosition(referencePrice: number): Promise<number> {
    let net = await this.getNetPositionSize();
    let totalReducedNotional = 0;

    for (let attempt = 1; attempt <= 4; attempt++) {
      if (Math.abs(net) <= 0.000001) return totalReducedNotional;

      this.log(`[平仓闭环] 第 ${attempt}/4 次，当前净仓位: ${net > 0 ? "多" : "空"} ${Math.abs(net)} BTC`);
      const result = await this.marketClose(net > 0 ? "buy" : "sell", Math.abs(net), referencePrice);
      totalReducedNotional += result.reducedNotional;

      if (result.reducedSize <= 0) {
        await sleep(200);
      }

      net = await this.getNetPositionSize();
    }

    throw new Error(`平仓后仍残留 ${Math.abs(net)} BTC`);
  }

  private async marketCloseFast(
    filledSide: "buy" | "sell",
    size: number,
    referencePrice?: number,
  ): Promise<CloseSubmitResult> {
    const closeSide = filledSide === "buy" ? "sell" : "buy";
    const closeLabel = closeSide === "buy" ? "市价买入平仓" : "市价卖出平仓";
    const builderParams = this.getBuilderParams();
    const basePrice = referencePrice || this.currentPrice;

    if (!basePrice || basePrice <= 0) {
      throw new Error("当前没有可用的 WS 价格，无法执行平仓");
    }

    const slippage = basePrice * 0.01;
    const marketPrice = closeSide === "buy"
      ? basePrice + slippage
      : basePrice - slippage;

    this.log(`[${closeLabel}] ${size} BTC`);

    try {
      const result = await this.writeDex.placeOrder({
        marketName: this.cfg.marketName,
        price: this.priceToChain(marketPrice),
        size: this.sizeToChain(size),
        isBuy: closeSide === "buy",
        timeInForce: TimeInForce.ImmediateOrCancel,
        isReduceOnly: true,
        subaccountAddr: this.cfg.subaccountAddress,
        ...builderParams,
      });

      if (result.success) {
        const submittedNotional = size * basePrice;
        this.log(`[平仓指令已发出] ${closeLabel} ${size} BTC @ ~$${marketPrice.toFixed(2)}`);
        return { submitted: true, submittedSize: size, submittedNotional };
      }
    } catch (e: any) {
      this.log(`[平仓指令异常] ${e?.message}`);
    }

    return { submitted: false, submittedSize: 0, submittedNotional: 0 };
  }

  private async recoverFromStuckState(): Promise<void> {
    if (!this.isRunning || this.phase === "stopping") return;

    this.log("[恢复] 进入应急恢复流程");

    try {
      await this.cancelAllOrders();
      await this.closeAllPositions();

      const net = await this.getNetPositionSize();
      if (Math.abs(net) > 0.000001) {
        this.log(`[恢复失败] 仍有残留仓位 ${Math.abs(net)} BTC，暂停重挂`);
        return;
      }

      this.currentPrice = this.currentPrice > 0 ? this.currentPrice : await this.waitForWsPrice();
      await this.placeBracketOrders();
      this.log("[恢复] 已重新建立双边挂单");
    } catch (e: any) {
      this.log(`[恢复异常] ${e?.message}`);
    }
  }

  private async marketClose(
    filledSide: "buy" | "sell",
    size: number,
    referencePrice?: number,
  ): Promise<CloseAttemptResult> {
    const closeSide = filledSide === "buy" ? "sell" : "buy";
    const closeLabel = closeSide === "buy" ? "市价买入平仓" : "市价卖出平仓";
    const builderParams = this.getBuilderParams();
    const basePrice = referencePrice || this.currentPrice;

    if (!basePrice || basePrice <= 0) {
      throw new Error("当前没有可用的 WS 价格，无法执行平仓");
    }

    this.log(`[${closeLabel}] ${size} BTC`);

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const beforeNet = await this.getNetPositionSize();
        const beforeAbs = Math.abs(beforeNet);
        const slippage = basePrice * 0.01;
        const marketPrice = closeSide === "buy"
          ? basePrice + slippage
          : basePrice - slippage;

        const result = await this.writeDex.placeOrder({
          marketName: this.cfg.marketName,
          price: this.priceToChain(marketPrice),
          size: this.sizeToChain(size),
          isBuy: closeSide === "buy",
          timeInForce: TimeInForce.ImmediateOrCancel,
          isReduceOnly: true,
          subaccountAddr: this.cfg.subaccountAddress,
          ...builderParams,
        });

        if (result.success) {
          let afterAbs = beforeAbs;
          for (let i = 0; i < 6; i++) {
            await sleep(100);
            afterAbs = Math.abs(await this.getNetPositionSize());
            if (afterAbs < beforeAbs - 0.000001) break;
          }

          const reducedSize = Math.max(0, beforeAbs - afterAbs);
          const reducedNotional = reducedSize * basePrice;

          if (reducedSize > 0.000001) {
            this.log(`[平仓成功] ${closeLabel} 实际减少 ${reducedSize} BTC @ ~$${marketPrice.toFixed(2)} | 本次平仓额: $${reducedNotional.toFixed(2)}`);
            return { reducedSize, reducedNotional };
          }

          this.log(`[平仓未确认] ${closeLabel} 指令已发出，但未观察到仓位减少`);
          return { reducedSize: 0, reducedNotional: 0 };
        }

        this.log(`[平仓未成交] 第 ${attempt}/3 次`);
      } catch (e: any) {
        this.log(`[平仓异常] 第 ${attempt}/3 次: ${e?.message}`);
      }

      if (attempt < 3) await sleep(150);
    }

    this.log("[平仓失败] 3 次尝试均未成功，请手动检查持仓");
    return { reducedSize: 0, reducedNotional: 0 };
  }

  private async getNetPositionSize(): Promise<number> {
    try {
      const positions = await (this.readDex as any).userPositions.getByAddr({
        subAddr: this.cfg.subaccountAddress,
      });
      const items = positions.items || positions || [];
      for (const pos of items) {
        if (!this.isTrackedMarketPosition(pos)) continue;
        const size = parseFloat(pos.position_size || pos.size || "0");
        if (Math.abs(size) > 0.000001) return size;
      }
      return 0;
    } catch {
      return 0;
    }
  }

  private async cancelOrder(order: ActiveOrder): Promise<void> {
    if (order.status !== "placed" || !order.orderId) return;
    try {
      await this.writeDex.cancelOrder({
        orderId: order.orderId,
        marketName: this.cfg.marketName,
        subaccountAddr: this.cfg.subaccountAddress,
      });
      order.status = "error";
      this.log(`[已取消] ${order.side} @ $${order.price.toFixed(2)}`);
    } catch (e: any) {
      const msg = e?.message || "";
      if (msg.includes("EORDER_NOT_FOUND")) {
        order.status = "error";
        this.log(`[已取消] ${order.side} @ $${order.price.toFixed(2)} (订单已不存在)`);
      } else {
        this.log(`[取消失败] ${order.side}: ${msg}`);
      }
    }
  }

  async cancelAllOrders(): Promise<void> {
    this.log("--- 取消所有挂单 ---");
    await Promise.all([
      this.buyOrder ? this.cancelOrder(this.buyOrder) : Promise.resolve(),
      this.sellOrder ? this.cancelOrder(this.sellOrder) : Promise.resolve(),
    ]);

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

    this.clearTrackedOrders();
    this.emitStatus();
  }

  async start(): Promise<void> {
    await this.initialize();

    this.isRunning = true;
    this.startTime = Date.now();

    this.subscribePriceUpdates();
    this.subscribeOrderUpdates();
    this.subscribeTradeUpdates();

    this.currentPrice = await this.waitForWsPrice();

    await this.cancelAllOrders();
    await this.closeAllPositions();

    await this.placeBracketOrders();
    this.log("=== 交易机器人已启动 (成交推送优先，轮询仅兜底) ===");

    this.pollForTradeHistory().catch((e) => this.log(`[成交轮询异常] ${e?.message}`));
    this.pollForPositionGuard().catch((e) => this.log(`[持仓轮询异常] ${e?.message}`));
    this.pollForStaleEntryOrder().catch((e) => this.log(`[超时挂单轮询异常] ${e?.message}`));

    while (this.isRunning) {
      this.emitStatus();
      await sleep(2000);
    }
  }

  async stop(): Promise<void> {
    this.log("=== 正在停止机器人 ===");
    this.isRunning = false;
    this.phase = "stopping";

    this.unsubPrice?.();
    this.unsubOrders?.();
    this.unsubTrades?.();
    this.unsubPrice = undefined;
    this.unsubOrders = undefined;
    this.unsubTrades = undefined;

    await this.closeAllPositions();
    await this.cancelAllOrders();

    this.phase = "idle";
    this.log(`=== 机器人已停止 | 总轮数: ${this.totalRounds} | 总流水: $${this.totalVolume.toFixed(2)} | 总利润: $${this.totalProfit.toFixed(4)} ===`);
    this.emitStatus();
  }

  async closeAllPositions(): Promise<void> {
    try {
      const net = await this.getNetPositionSize();
      if (Math.abs(net) <= 0.000001) {
        this.log("[关闭持仓] 无持仓，跳过");
        return;
      }

      this.log(`[关闭持仓] ${net > 0 ? "多" : "空"}仓 ${Math.abs(net)} BTC`);
      await this.marketClose(net > 0 ? "buy" : "sell", Math.abs(net), this.currentPrice || undefined);
    } catch (e: any) {
      this.log(`[关闭持仓异常] ${e?.message}`);
    }
  }
}
