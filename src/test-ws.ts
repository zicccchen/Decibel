import "dotenv/config";
import WebSocket from "ws";
import { CONFIG } from "./config.js";

const subAddr = "0xdf36b3fd3b0780943a380124e88e6c172975d2f806384a8595211dff7be1afac";
const wsUrl = CONFIG.DECIBEL_WS_URL;
const apiKey = CONFIG.API_BEARER_TOKEN;

console.log("WS URL:", wsUrl);
console.log("Connecting with header auth...");

const ws = new WebSocket(wsUrl, {
  headers: { "Authorization": `Bearer ${apiKey}` },
});

ws.on("open", () => {
  console.log("Connected!");
  const msg = JSON.stringify({ method: "subscribe", topic: `order_updates:${subAddr}` });
  console.log("Subscribing:", msg);
  ws.send(msg);
});

ws.on("message", (data) => {
  console.log("Message:", data.toString().slice(0, 500));
});

ws.on("error", (err) => {
  console.log("Error:", err.message);
});

ws.on("close", (code, reason) => {
  console.log("Closed:", code, reason.toString());
});

console.log("Waiting 30s for messages...");
setTimeout(() => {
  ws.close();
  process.exit(0);
}, 30000);
