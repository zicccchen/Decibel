import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AptosWalletAdapterProvider } from "@aptos-labs/wallet-adapter-react";
import { Network } from "@aptos-labs/ts-sdk";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AptosWalletAdapterProvider
      autoConnect={true}
      dappConfig={{
        network: Network.MAINNET,
        aptosApiKeys: import.meta.env.VITE_APTOS_API_KEY ? { [Network.MAINNET]: import.meta.env.VITE_APTOS_API_KEY } : undefined,
      }}
      onError={(error) => console.error("Wallet error:", error)}
    >
      <App />
    </AptosWalletAdapterProvider>
  </StrictMode>
);
