import { useState, useCallback } from "react";
import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { DecibelReadDex } from "@decibeltrade/sdk";
import { Account, Ed25519PrivateKey } from "@aptos-labs/ts-sdk";
import {
  DECIBEL_CONFIG,
  BUILDER_ADDRESS,
  BUILDER_FEE_BPS,
  REFERRAL_CODE,
  API_KEY,
} from "../config";

export type OnboardingStatus = {
  hasReferral: boolean;
  hasSubaccount: boolean;
  hasBuilderApproval: boolean;
  subaccountAddr: string | null;
};

export function useDecibel() {
  const { account, signAndSubmitTransaction } = useWallet();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<OnboardingStatus>({
    hasReferral: false,
    hasSubaccount: false,
    hasBuilderApproval: false,
    subaccountAddr: null,
  });

  const getReadDex = useCallback(() => {
    return new DecibelReadDex(DECIBEL_CONFIG, {
      nodeApiKey: API_KEY || undefined,
    });
  }, []);

  const getAddr = () => account?.address?.toString() ?? "";

  // Step 1: Redeem referral code (offchain, no signature)
  const redeemReferral = useCallback(async () => {
    if (!account?.address) throw new Error("Wallet not connected");
    setLoading(true);
    setError(null);
    try {
      const readDex = getReadDex();
      await readDex.referrals.redeemCode({
        referralCode: REFERRAL_CODE,
        account: getAddr(),
      });
      setStatus((s) => ({ ...s, hasReferral: true }));
    } catch (e: any) {
      if (e?.message?.includes("already") || e?.message?.includes("Already")) {
        setStatus((s) => ({ ...s, hasReferral: true }));
      } else {
        setError(`Redeem failed: ${e?.message}`);
        throw e;
      }
    } finally {
      setLoading(false);
    }
  }, [account, getReadDex]);

  // Step 2: Create subaccount (on-chain, needs wallet signature)
  const createSubaccount = useCallback(async () => {
    if (!account?.address) throw new Error("Wallet not connected");
    setLoading(true);
    setError(null);
    try {
      const PACKAGE = DECIBEL_CONFIG.deployment.package;
      const response = await signAndSubmitTransaction({
        data: {
          function: `${PACKAGE}::dex_accounts_entry::create_new_subaccount`,
          typeArguments: [],
          functionArguments: [],
        },
      });
      console.log("Create subaccount TX:", response);

      // Query to get the new subaccount address
      const readDex = getReadDex();
      const subs = await readDex.userSubaccounts.getByAddr({
        ownerAddr: getAddr(),
      });
      if (subs.length > 0) {
        const subAddr = subs[0].subaccount_address;
        setStatus((s) => ({
          ...s,
          hasSubaccount: true,
          subaccountAddr: subAddr,
        }));
      }
    } catch (e: any) {
      setError(`Create subaccount failed: ${e?.message}`);
      throw e;
    } finally {
      setLoading(false);
    }
  }, [account, signAndSubmitTransaction, getReadDex]);

  // Step 3: Approve builder fee (on-chain, needs wallet signature)
  const approveBuilderFee = useCallback(async () => {
    if (!account?.address) throw new Error("Wallet not connected");
    if (!status.subaccountAddr) throw new Error("No subaccount");
    setLoading(true);
    setError(null);
    try {
      const PACKAGE = DECIBEL_CONFIG.deployment.package;
      const response = await signAndSubmitTransaction({
        data: {
          function: `${PACKAGE}::dex_accounts_entry::approve_max_builder_fee_for_subaccount`,
          typeArguments: [],
          functionArguments: [
            status.subaccountAddr,
            BUILDER_ADDRESS,
            BUILDER_FEE_BPS,
          ],
        },
      });
      console.log("Approve builder fee TX:", response);
      setStatus((s) => ({ ...s, hasBuilderApproval: true }));
    } catch (e: any) {
      setError(`Approve builder fee failed: ${e?.message}`);
      throw e;
    } finally {
      setLoading(false);
    }
  }, [account, signAndSubmitTransaction, status.subaccountAddr]);

  // Generate API wallet keypair (client-side, no signature needed)
  const generateApiWallet = useCallback(() => {
    const keyPair = Ed25519PrivateKey.generate();
    const apiAccount = Account.fromPrivateKey({ privateKey: keyPair });
    return {
      privateKey: keyPair.toString(),
      address: apiAccount.accountAddress.toString(),
    };
  }, []);

  // Check existing status for a connected wallet
  const checkStatus = useCallback(async () => {
    if (!account?.address) return;
    setLoading(true);
    try {
      const readDex = getReadDex();
      const subs = await readDex.userSubaccounts.getByAddr({
        ownerAddr: getAddr(),
      });
      if (subs.length > 0) {
        const subAddr = subs[0].subaccount_address;
        setStatus((s) => ({
          ...s,
          hasSubaccount: true,
          hasReferral: true,
          subaccountAddr: subAddr,
        }));
      }
    } catch {
      // New user, no subaccount
    } finally {
      setLoading(false);
    }
  }, [account, getReadDex]);

  return {
    status,
    loading,
    error,
    redeemReferral,
    createSubaccount,
    approveBuilderFee,
    generateApiWallet,
    checkStatus,
    clearError: () => setError(null),
  };
}
