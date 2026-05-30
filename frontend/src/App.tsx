import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { WalletConnect } from "./components/WalletConnect";
import { OnboardingFlow } from "./components/OnboardingFlow";
import { Dashboard } from "./components/Dashboard";
import "./App.css";

function App() {
  const { connected } = useWallet();

  return (
    <div className="app">
      <header className="app-header">
        <h1>Decibel Grid Bot</h1>
        <WalletConnect />
      </header>
      <main className="app-main">
        {!connected ? (
          <div className="welcome">
            <h2>Connect your wallet to get started</h2>
            <p>Support Petra, OKX, and other Aptos wallets</p>
          </div>
        ) : (
          <ContentArea />
        )}
      </main>
    </div>
  );
}

function ContentArea() {
  return (
    <div className="content">
      <OnboardingFlow />
      <Dashboard />
    </div>
  );
}

export default App;
