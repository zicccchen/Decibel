import { useEffect } from "react";
import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { useDecibel } from "../hooks/useDecibel";

export function OnboardingFlow() {
  const { connected } = useWallet();
  const {
    status,
    loading,
    error,
    redeemReferral,
    createSubaccount,
    approveBuilderFee,
    checkStatus,
    clearError,
  } = useDecibel();

  useEffect(() => {
    if (connected) checkStatus();
  }, [connected, checkStatus]);

  // All steps done
  if (status.hasSubaccount && status.hasBuilderApproval) {
    return (
      <div className="card success-card">
        <h3>Account Ready</h3>
        <p>Subaccount: <code>{status.subaccountAddr}</code></p>
        <p>Builder Fee approved. You can start trading.</p>
      </div>
    );
  }

  const steps = [
    {
      label: "1. Redeem Referral Code",
      done: status.hasReferral,
      action: redeemReferral,
    },
    {
      label: "2. Create Trading Account",
      done: status.hasSubaccount,
      action: createSubaccount,
    },
    {
      label: "3. Approve Builder Fee (0.1%)",
      done: status.hasBuilderApproval,
      action: approveBuilderFee,
    },
  ];

  const currentStep = steps.findIndex((s) => !s.done);

  return (
    <div className="card onboarding-card">
      <h3>Account Setup</h3>
      {error && (
        <div className="error-msg">
          {error}
          <button className="btn btn-sm" onClick={clearError}>Dismiss</button>
        </div>
      )}
      <div className="steps">
        {steps.map((step, i) => (
          <div key={i} className={`step ${step.done ? "done" : i === currentStep ? "active" : ""}`}>
            <span className="step-icon">{step.done ? "\u2713" : i + 1}</span>
            <span className="step-label">{step.label}</span>
            {i === currentStep && !step.done && (
              <button
                className="btn btn-primary"
                disabled={loading}
                onClick={step.action}
              >
                {loading ? "Processing..." : "Confirm"}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
