import "dotenv/config";
import WebSocket from "ws";
import { MAINNET_CONFIG, TESTNET_CONFIG, getMarketAddr } from "@decibeltrade/sdk";
import { CONFIG } from "./config.js";

const wsUrl = CONFIG.DECIBEL_WS_URL;
const baseConfig = CONFIG.NETWORK === "mainnet" ? MAINNET_CONFIG : TESTNET_CONFIG;
const marketAddr = getMarketAddr(CONFIG.MARKET_NAME, baseConfig.deployment.perpEngineGlobal).toString();
const subAddr = CONFIG.SUBACCOUNT_ADDRESS;
const bearerToken = CONFIG.API_BEARER_TOKEN;

function attachDebug(label: string, ws: WebSocket): void {
  ws.on("message", (data) => console.log(`[${label}] Message:`, data.toString().slice(0, 500)));
  ws.on("unexpected-response", (_req, res) => {
    let body = "";
    res.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    res.on("end", () => console.log(`[${label}] ${res.statusCode}: ${body}`));
  });
  ws.on("error", (err) => console.log(`[${label}] Error: ${err.message}`));
  ws.on("close", (code, reason) => console.log(`[${label}] Closed: ${code} ${reason.toString()}`));
}

console.log("=== Test: Bearer Token with Header Auth ===");
console.log("WS URL:", wsUrl);
console.log("Market:", CONFIG.MARKET_NAME);
console.log("Market Addr:", marketAddr);
console.log("Subaccount configured:", subAddr ? "yes" : "no");

const ws = new WebSocket(wsUrl, {
  headers: { Authorization: `Bearer ${bearerToken}` },
});

attachDebug("Bearer", ws);

ws.on("open", () => {
  console.log("[Bearer] Connected!");
  ws.send(JSON.stringify({ method: "subscribe", topic: `market_price:${marketAddr}` }));
  if (subAddr) {
    ws.send(JSON.stringify({ method: "subscribe", topic: `order_updates:${subAddr}` }));
    ws.send(JSON.stringify({ method: "subscribe", topic: `user_trades:${subAddr}` }));
  }
});

console.log("Waiting 15s for websocket messages...");
setTimeout(() => {
  ws.close();
  console.log("Done.");
  process.exit(0);
}, 15000);
