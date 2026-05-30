import { DecibelReadDex } from "@decibeltrade/sdk";

// ============================================================
// 邀请码自动管理器
// 从 Decibel 平台拉取所有已创建的邀请码，智能分配给新用户
// ============================================================

export interface AffiliateCode {
  referral_code: string;
  owner_account: string;
  max_usage: number;
  usage_count: number;
  is_active: boolean;
  is_affiliate: boolean;
  source: string;
  created_at_ms: number;
}

export interface ReferralManagerStatus {
  totalCodes: number;
  activeCodes: number;
  totalCapacity: number;
  totalUsed: number;
  remainingSlots: number;
  codes: Array<{
    code: string;
    used: number;
    max: number;
    active: boolean;
  }>;
  lastRefreshed: number;
}

export class ReferralManager {
  private codes: AffiliateCode[] = [];
  private readDex: DecibelReadDex;
  private ownerAccount: string;
  private lastRefreshed = 0;
  private refreshIntervalMs = 5 * 60 * 1000; // 每 5 分钟刷新一次

  constructor(readDex: DecibelReadDex, ownerAccount: string) {
    this.readDex = readDex;
    this.ownerAccount = ownerAccount;
  }

  /** 从 Decibel API 拉取所有邀请码 */
  async refresh(): Promise<void> {
    try {
      const response = await this.readDex.referrals.getAffiliateCodes(
        this.ownerAccount
      );
      this.codes = (response.codes || []) as AffiliateCode[];
      this.lastRefreshed = Date.now();
      console.log(
        `[ReferralManager] 已加载 ${this.codes.length} 个邀请码 (活跃: ${this.getActiveCodes().length})`
      );
    } catch (error: any) {
      console.error(`[ReferralManager] 拉取邀请码失败: ${error?.message}`);
      // 如果已有缓存数据就继续使用
      if (this.codes.length === 0) {
        throw new Error(`无法获取邀请码: ${error?.message}`);
      }
    }
  }

  /** 确保数据是最新的 */
  private async ensureFresh(): Promise<void> {
    if (
      this.codes.length === 0 ||
      Date.now() - this.lastRefreshed > this.refreshIntervalMs
    ) {
      await this.refresh();
    }
  }

  /** 获取所有活跃且有剩余容量的邀请码 */
  private getActiveCodes(): AffiliateCode[] {
    return this.codes.filter(
      (c) => c.is_active && c.usage_count < c.max_usage
    );
  }

  /**
   * 智能选取一个可用的邀请码
   * 策略: 优先使用剩余容量最多的码，实现均匀分配
   */
  async pickCode(): Promise<string | null> {
    await this.ensureFresh();

    const available = this.getActiveCodes();
    if (available.length === 0) return null;

    // 按剩余容量降序排列，选择剩余最多的
    available.sort(
      (a, b) => b.max_usage - b.usage_count - (a.max_usage - a.usage_count)
    );

    return available[0].referral_code;
  }

  /**
   * 为新用户兑换邀请码
   * 自动选择可用码并调用 redeemCode
   */
  async redeemForUser(userAccount: string): Promise<{
    success: boolean;
    code?: string;
    error?: string;
  }> {
    // 先检查用户是否已注册
    try {
      await this.readDex.referrals.getAccountReferral(userAccount);
      return { success: true, code: "already_registered" };
    } catch {
      // 未注册，继续
    }

    const code = await this.pickCode();
    if (!code) {
      return {
        success: false,
        error: "没有可用的邀请码，请在 Decibel Partner Dashboard 生成更多邀请码",
      };
    }

    try {
      await this.readDex.referrals.redeemCode({
        referralCode: code,
        account: userAccount,
      });

      // 兑换成功后刷新数据
      await this.refresh();

      return { success: true, code };
    } catch (error: any) {
      return {
        success: false,
        error: `兑换失败 (code=${code}): ${error?.message}`,
      };
    }
  }

  /** 获取管理状态 */
  async getStatus(): Promise<ReferralManagerStatus> {
    await this.ensureFresh();

    const activeCodes = this.getActiveCodes();
    const totalCapacity = this.codes.reduce((sum, c) => sum + c.max_usage, 0);
    const totalUsed = this.codes.reduce((sum, c) => sum + c.usage_count, 0);

    return {
      totalCodes: this.codes.length,
      activeCodes: activeCodes.length,
      totalCapacity,
      totalUsed,
      remainingSlots: totalCapacity - totalUsed,
      codes: this.codes.map((c) => ({
        code: c.referral_code,
        used: c.usage_count,
        max: c.max_usage,
        active: c.is_active,
      })),
      lastRefreshed: this.lastRefreshed,
    };
  }
}
