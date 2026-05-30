import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { groupAndSortWallets } from "@aptos-labs/wallet-adapter-core";

export function WalletConnect() {
  const { connect, disconnect, account, connected, wallets } = useWallet();

  if (connected && account) {
    const addr = account.address.toString();
    return (
      <div className="wallet-info">
        <span className="wallet-addr">
          {addr.slice(0, 6)}...{addr.slice(-4)}
        </span>
        <button className="btn btn-sm" onClick={disconnect}>
          Disconnect
        </button>
      </div>
    );
  }

  const { availableWallets, installableWallets } = groupAndSortWallets(wallets);

  return (
    <div className="wallet-connect">
      {availableWallets
        .filter((w) => !w.name.toLowerCase().includes("petra web"))
        .map((w) => (
          <button
            key={w.name}
            className="btn btn-primary"
            onClick={() => connect(w.name)}
          >
            {w.icon && <img src={w.icon} alt="" width={20} height={20} />}
            Connect {w.name}
          </button>
        ))}

      {availableWallets.filter((w) => !w.name.toLowerCase().includes("petra web")).length === 0 &&
        installableWallets.length === 0 && (
          <p className="hint">
            No wallet extension detected. Please install Petra or OKX wallet.
          </p>
        )}

      {installableWallets
        .filter((w) => ["Petra", "OKX Wallet"].includes(w.name))
        .map((w) => (
          <a
            key={w.name}
            className="btn"
            href={w.url}
            target="_blank"
            rel="noreferrer"
          >
            Install {w.name}
          </a>
        ))}
    </div>
  );
}
