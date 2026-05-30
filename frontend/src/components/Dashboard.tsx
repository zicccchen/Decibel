import { useState } from "react";
import { useDecibel } from "../hooks/useDecibel";

export function Dashboard() {
  const { status, generateApiWallet } = useDecibel();
  const [apiWallet, setApiWallet] = useState<{
    privateKey: string;
    address: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  if (!status.hasSubaccount) return null;

  const handleGenerate = () => {
    const wallet = generateApiWallet();
    setApiWallet(wallet);
  };

  const handleCopy = () => {
    if (!apiWallet) return;
    const text = `API_WALLET_PRIVATE_KEY=${apiWallet.privateKey}\nAPI_WALLET_ADDRESS=${apiWallet.address}\nSUBACCOUNT_ADDRESS=${status.subaccountAddr}`;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="card dashboard-card">
      <h3>API Wallet</h3>
      <p className="hint">
        Generate an API wallet keypair for the trading bot.
        You'll need to register it at{" "}
        <a href="https://app.decibel.trade/api" target="_blank" rel="noreferrer">
          app.decibel.trade/api
        </a>{" "}
        after generating.
      </p>

      {!apiWallet ? (
        <button className="btn btn-primary" onClick={handleGenerate}>
          Generate API Wallet
        </button>
      ) : (
        <div className="api-wallet-info">
          <div className="field">
            <label>Address</label>
            <code>{apiWallet.address}</code>
          </div>
          <div className="field">
            <label>Private Key</label>
            <code className="secret">{apiWallet.privateKey}</code>
          </div>
          <div className="field">
            <label>Subaccount</label>
            <code>{status.subaccountAddr}</code>
          </div>
          <div className="actions">
            <button className="btn btn-primary" onClick={handleCopy}>
              {copied ? "Copied!" : "Copy .env Config"}
            </button>
          </div>
          <p className="warning">
            Save the private key securely. It will NOT be shown again after you leave this page.
          </p>
        </div>
      )}
    </div>
  );
}
