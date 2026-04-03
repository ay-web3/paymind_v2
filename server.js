import dotenv from "dotenv";
dotenv.config();
import { buildTradePlan } from "./services/tradePlan.js";
import express from "express";
import { analyzeMarketStructure } from "./services/marketStructure.js";
import { ethers } from "ethers";
import fs from "fs";
import fetch from "node-fetch";
import cors from "cors";
import crypto from "crypto";
import { GoogleAuth } from "google-auth-library";
import { resolvePreset } from "./coin/cryptoPresets.js";
import {
  indexProducts,
  findProductIdsFromText,
  findBestProductId
} from "./productRegistry.js";
import { getCoinPrice, searchCoin } from "./services/coingecko.js";
import { loadMemeCoins } from "./coin/loadMemeCoins.js";
import { setMemeCoins } from "./coin/presets.js";
import { MEME_COINS } from "./coin/presets.js";
import { getMultiCoinPricesLarge } from "./services/coingecko.js";
import {
  getMarketChart,
  getMarketCandles,
  getLivePrice
} from "./services/cryptoChart.js";
import { calculateSupportResistance, detectTrend } from "./services/technicalAnalysis.js";
import {
  calculateEMA,
  calculateRSI,
  calculateVWAP
} from "./services/indicators.js";
import {
  calculateZonesFromVolume,
  rankZonesByStrength
} from "./services/zoneAnalysis.js";


const USDC_ADDRESS = process.env.USDC_ADDRESS;


/* =======================
   CONFIG
======================= */
const PRODUCT_PRICE = "0.001";
const PORT = 3000;
const ARC_RPC_URL = process.env.ARC_RPC_URL;
if (!ARC_RPC_URL) throw new Error("Missing ARC_RPC_URL in env");


const X402_CONTRACT_ADDRESS = "0x12d6DaaD7d9f86221e5920E7117d5848EC0528e6";
const AGENT_MANAGER_ADDRESS = process.env.AGENT_MANAGER_ADDRESS;

/* =======================
   BLOCKCHAIN
======================= */

const provider = new ethers.JsonRpcProvider(ARC_RPC_URL);
const signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

const agentProvider = new ethers.JsonRpcProvider(ARC_RPC_URL);



const agentSigner = new ethers.Wallet(
  process.env.AGENT_PRIVATE_KEY,
  agentProvider
);
const AGENT_MANAGER_ABI = [
  "function userToAgent(address) view returns (address)"
];

const AGENT_WALLET_ABI = [
  "function execute(address target,uint256 value,bytes data,uint256 amountUSDC)"
];

const X402_ABI = [
  "function pay(uint256 datasetId)"
];



/* =======================
   PRODUCT CACHE
======================= */

let PRODUCT_CACHE = [];
let PRODUCT_MAP = {};

async function fetchAllProducts() {
  let all = [];
  let skip = 0;
  const limit = 100;

  while (true) {
    const res = await fetch(`https://dummyjson.com/products?limit=${limit}&skip=${skip}`);
    const data = await res.json();

    all.push(...data.products);
    if (data.products.length < limit) break;
    skip += limit;
  }
  return all;
}

async function ensureApproval(agentWalletAddress) {
  const iface = new ethers.Interface([
    "function approve(address spender,uint256 amount)",
  ]);

  // approve a big amount once (1,000,000 USDC)
  const amount = ethers.parseUnits("1000000", 6);

  const calldata = iface.encodeFunctionData("approve", [
    X402_CONTRACT_ADDRESS,
    amount,
  ]);

  const managerWrite = new ethers.Contract(
    AGENT_MANAGER_ADDRESS,
    ["function executeFromAgent(address,address,uint256,bytes,uint256)"],
    signer
  );

  const tx = await managerWrite.executeFromAgent(
    agentWalletAddress,
    USDC_ADDRESS, // token contract
    0,
    calldata,
    0
  );

  await tx.wait();
}


async function initProducts() {
  PRODUCT_CACHE = await fetchAllProducts();
  PRODUCT_MAP = {};
  for (const p of PRODUCT_CACHE) PRODUCT_MAP[p.id] = p.title;
  console.log(`✅ Loaded ${PRODUCT_CACHE.length} products`);
}

async function ensureApprovalIfNeeded(agentWalletAddress, neededUSDC) {
  const tokenRead = new ethers.Contract(
    USDC_ADDRESS,
    ["function allowance(address owner,address spender) view returns (uint256)"],
    provider
  );

  const current = await tokenRead.allowance(agentWalletAddress, X402_CONTRACT_ADDRESS);

  // If allowance is already enough, do nothing
  if (current >= neededUSDC) {
    return { approved: false, current };
  }

  // Otherwise approve a big amount once
  const approveIface = new ethers.Interface([
    "function approve(address spender,uint256 amount)",
  ]);

  const approveAmount = ethers.parseUnits("1000000", 6); // 1,000,000 USDC

  const calldata = approveIface.encodeFunctionData("approve", [
    X402_CONTRACT_ADDRESS,
    approveAmount,
  ]);

  const managerWrite = new ethers.Contract(
    AGENT_MANAGER_ADDRESS,
    ["function executeFromAgent(address,address,uint256,bytes,uint256)"],
    signer
  );

  const tx = await managerWrite.executeFromAgent(
    agentWalletAddress,
    USDC_ADDRESS,
    0,
    calldata,
    0
  );

  await tx.wait();
  return { approved: true, current, txHash: tx.hash };
}

async function agentPayForAccess(userAddress, productId, task, priceUSDC) {

  const managerRead = new ethers.Contract(
    AGENT_MANAGER_ADDRESS,
    AGENT_MANAGER_ABI,
    provider
  );

  const agentWalletAddress = await managerRead.userToAgent(userAddress);
  if (agentWalletAddress === ethers.ZeroAddress) {
    throw new Error("User has no agent wallet");
  }

  const iface = new ethers.Interface([
    "function payForProduct(uint256,string,bytes32)"
  ]);

  const receiptId = ethers.id(Date.now().toString());

  const calldata = iface.encodeFunctionData("payForProduct", [
    productId,
    task,
    receiptId
  ]);

  const managerWrite = new ethers.Contract(
    AGENT_MANAGER_ADDRESS,
    ["function executeFromAgent(address,address,uint256,bytes,uint256)"],
    signer
  );

  const price = ethers.parseUnits(priceUSDC.toString(), 6);
  await ensureApprovalIfNeeded(agentWalletAddress, price);

  

  // ✅ 2. Agent pays X402 contract
  const tx = await managerWrite.executeFromAgent(
    agentWalletAddress,
    X402_CONTRACT_ADDRESS,
    0,
    calldata,
    price
  );

  await tx.wait();

  return tx.hash;
}



/* =======================
   GEMINI
======================= */

const auth = new GoogleAuth({
  credentials: JSON.parse(process.env.GEMINI_SA_JSON),
  scopes: [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/generative-language"
  ],
});

async function getAccessToken() {
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  return tokenResponse.token;
}

async function callGemini(prompt) {
  const token = await getAccessToken();

  const PROJECT_ID = "my-project-ay-63015";
  const LOCATION = "us-central1"; 
  const MODEL_ID = "gemini-1.5-flash";

  const host = `${LOCATION}-aiplatform.googleapis.com`;
  const url = `https://${host}/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${MODEL_ID}:generateContent`;
  const safePrompt = String(prompt || "").slice(0, 12000);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        maxOutputTokens: 8192,
        temperature: 0.7,
      },
    }),
  });

  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts;
const text = Array.isArray(parts) ? parts.map(p => p?.text || "").join("").trim() : "";

  if (!res.ok) {
    throw new Error(
      `Gemini failed (${res.status}): ${JSON.stringify(data)}`
    );
  }

  
  if (!text) {
    throw new Error(
      "Gemini returned no text: " + JSON.stringify(data)
    );
  }

  return text;
}


async function initMemeCoins() {
  const coins = await loadMemeCoins(300);
  setMemeCoins(coins);
  console.log("✅ Loaded meme coins:", coins.length);
}

await initMemeCoins();

async function resolveCoinGeckoId(query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return null;

  const url = `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(q)}`;

  const res = await fetch(url, {
    headers: { "x-cg-demo-api-key": process.env.COINGECKO_API_KEY },
  });
  if (!res.ok) throw new Error("CoinGecko search failed");

  const data = await res.json();
  const coins = data?.coins || [];
  if (!coins.length) return null;

  const exact =
    coins.find(c => String(c.symbol || "").toLowerCase() === q) ||
    coins.find(c => String(c.name || "").toLowerCase() === q);

  const top = exact || coins[0];

  return {
    coinId: top.id,
    name: top.name,
    symbol: top.symbol,
    rank: top.market_cap_rank ?? null,
  };
}


/* =======================
   EXPRESS
======================= */

const app = express();
app.use(cors());
app.use(express.json());



app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "paymind-api",
    time: new Date().toISOString(),
  });
});



app.get("/", (_, res) => res.send("Agentic Commerce AI API running"));


/* =======================
   AGENT ON-CHAIN PAYMENT
======================= */


/* =======================
   LIVE PRICE (NO x402)
======================= */

app.get("/crypto/live-price", async (req, res) => {
  try {
    const coin = req.query.coin || "ethereum";
    const price = await getCoinPrice(coin);

    res.json({
      coin,
      price
    });
  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});

app.get("/crypto/resolve", async (req, res) => {
  try {
    const query = (req.query.query || "").trim();
    if (!query) return res.status(400).json({ error: "Missing query" });

    const result = await resolveCoinGeckoId(query);
    if (!result) return res.status(404).json({ error: "Coin not found" });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || "Resolve failed" });
  }
});
/* =======================
   X402 VERIFICATION
======================= */

async function verifyContractPayment(txHash, expectedId, minAmount) {
  const receipt = await provider.waitForTransaction(txHash, 1);
  if (!receipt || receipt.status !== 1) return false;

  const iface = new ethers.Interface([
    "event ProductPaid(address indexed buyer, uint256 indexed productId, uint256 amount)"
  ]);

  const expectedAmount = ethers.parseUnits(minAmount.toString(), 6);

  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log);

      if (parsed.name !== "ProductPaid") continue;

      const productId = parsed.args.productId;
      const amount = parsed.args.amount;

      console.log("FOUND EVENT:", {
        productId: productId.toString(),
        amount: amount.toString()
      });

      if (
        productId.toString() === expectedId.toString() &&
        amount >= expectedAmount
      ) {
        return true;
      }

    } catch {}
  }

  return false;
}

function round(n, dp = 2) {
  return Number.isFinite(n) ? Number(n.toFixed(dp)) : null;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function computeInvalidation(structure) {
  if (!structure) return null;

  if (structure.bias === "bullish" && structure.lastLow?.price) {
    return {
      side: "bullish",
      level: structure.lastLow.price,
      text: "Bias breaks if price closes below the last swing low."
    };
  }

  if (structure.bias === "bearish" && structure.lastHigh?.price) {
    return {
      side: "bearish",
      level: structure.lastHigh.price,
      text: "Bias breaks if price closes above the last swing high."
    };
  }

  if (structure.lastHigh?.price && structure.lastLow?.price) {
    return {
      side: "range",
      upper: structure.lastHigh.price,
      lower: structure.lastLow.price,
      text: "Range breaks if price closes above the last swing high or below the last swing low."
    };
  }

  return null;
}

function computeConfidence({ structure, nearestZone, emaDist, vwapDist, rsi, mtf }) {
  let score = 45;

  if (structure?.bias === "bullish" || structure?.bias === "bearish") {
    score += 10;
  }

  if (structure?.event?.type === "BOS") score += 15;
  if (structure?.event?.type === "CHoCH") score += 8;

  if (nearestZone?.strength) {
    score += clamp(nearestZone.strength * 18, 0, 18);
  }

  const bothAbove = emaDist > 1 && vwapDist > 1;
  const bothBelow = emaDist < -1 && vwapDist < -1;
  if (bothAbove || bothBelow) score += 10;

  if (Number.isFinite(rsi)) {
    if (rsi > 60 || rsi < 40) score += 5;
  }
  if (mtf?.enabled) {
  if (mtf.status === "aligned") score += 12;
  if (mtf.status === "conflict") score -= 18;
  if (mtf.status === "htf_range") score += 4;
  if (mtf.status === "ltf_range") score -= 6;
}

  return clamp(Math.round(score), 0, 100);
}

async function narrateFacts(callGemini, facts) {
  const prompt = `
You are a calm professional trader. Write a short human summary of the facts below.

STRICT RULES:
- Use ONLY the facts from JSON. Do NOT invent targets, predictions, extra indicators, or extra numbers.
- If something is null/unknown, skip it.
- 4–7 short lines max.
- Avoid repetitive phrasing. Vary wording naturally.
- Mention confidence and invalidation when provided.
- If mtf is present, include one line about alignment/conflict.
- If tradePlan exists, include Entry, SL, TP1, and the invalidation in 2 lines max.

FACTS(JSON):
${JSON.stringify(facts)}
`.trim();

  const text = await callGemini(prompt);
  return String(text || "").trim();
}

/* =======================
   PAID DATASET
======================= */

app.get("/dataset", async (req, res) => {
  let payment;
  try {
    payment = JSON.parse(req.headers["x-payment"]);
  } catch {
    return res.status(402).json({ error: "Invalid payment header" });
  }

  const valid = await verifyContractPayment(payment.txHash, payment.datasetId, payment.amount);
  if (!valid) return res.status(402).json({ error: "Payment not verified" });

  const data = await fetch(`https://dummyjson.com/products/${payment.datasetId}`).then(r => r.json());
  res.json(data);
});

app.get("/search-product", (req, res) => {
  const q = req.query.q || "";

  if (!q.trim()) {
    return res.status(400).json({ error: "Missing query param q" });
  }

  const ids = findProductIdsFromText(q);

  res.json({
    query: q,
    ids
  });
});


app.post("/analysis", async (req, res) => {
  try {
    const { userAddress, coin = "bitcoin", tf = "1h" } = req.body;

    if (!userAddress) {
      return res.status(400).json({ error: "Missing userAddress" });
    }

    /* 1) FETCH MARKET DATA */
    const rawCandles = await getMarketCandles(coin, tf);
    const { limit } = getTfConfig(tf);

    if (!Array.isArray(rawCandles) || rawCandles.length < 60) {
      return res.status(400).json({
        error: "Insufficient candle data for analysis"
      });
    }

    const MAX_CANDLES = Math.min(limit, rawCandles.length);
    let candles = rawCandles.slice(-MAX_CANDLES);

    /* 2) LIVE PRICE INJECTION (BEFORE INDICATORS) */
    const livePrice = await getLivePrice(coin);
    const lastIndex = candles.length - 1;
    const last = candles[lastIndex];

    candles[lastIndex] = {
      ...last,
      c: livePrice,
      h: Math.max(last.h, livePrice),
      l: Math.min(last.l, livePrice)
    };

    const tfClose = livePrice;

    /* 3) INDICATORS (SERIES) — FIXED */

    const closes = candles.map(c => c.c);
    const ema50Series = calculateEMA(candles, 50);
    const rsiSeries = calculateRSI(closes, 14);
    const vwapSeries = calculateVWAP(candles);

    const ema50 = ema50Series.at(-1);
    


const validRSI = rsiSeries.filter(v => Number.isFinite(v));
if (!validRSI.length) {
  throw new Error("RSI calculation failed");
}

const rsi = validRSI.at(-1);
    const vwap = vwapSeries.at(-1);

    /* 4) PAYMENT (x402) */
    const PRODUCT_ID = 4;
    const PRICE = "0.001";

    const txHash = await agentPayForAccess(
      userAddress,
      PRODUCT_ID,
      `market-analysis:${coin}:${tf}`,
      PRICE
    );

    const isValid = await verifyContractPayment(txHash, PRODUCT_ID, PRICE);

    if (!isValid) {
      return res.status(402).json({ error: "Payment verification failed" });
    }

    /* 5) STRUCTURE + ZONES */
    const structure = analyzeMarketStructure(candles);
    /* 5.1) MTF STRUCTURE (HTF) */
const htfTf = getHigherTf(tf);

let htfStructure = null;
let mtf = {
  enabled: false,
  htfTf: null,
  status: "none",
  aligned: null
};

if (htfTf) {
  const rawHtfCandles = await getMarketCandles(coin, htfTf);
  const { limit: htfLimit } = getTfConfig(htfTf);

  const MAX_HTF = Math.min(htfLimit, rawHtfCandles?.length || 0);
  const htfCandles = (rawHtfCandles || []).slice(-MAX_HTF);

  if (htfCandles.length >= 10) {
    // Optional: inject HTF live price only when HTF candle matches current day
    // (safe to skip for now)
    htfStructure = analyzeMarketStructure(htfCandles);

    const alignment = computeMtfAlignment(
      structure?.bias,
      htfStructure?.bias
    );

    mtf = {
      enabled: true,
      htfTf,
      status: alignment.status, // aligned | conflict | htf_range | ltf_range
      aligned: alignment.aligned,
      ltfBias: normalizeBias(structure?.bias),
      htfBias: normalizeBias(htfStructure?.bias),
      ltfEvent: structure?.event || null,
      htfEvent: htfStructure?.event || null
    };
  }
}


    const rawZones = calculateZonesFromVolume(candles);
    const rankedZones = rankZonesByStrength(rawZones, candles);

    const normalizedZones = rankedZones.map(z => ({
      ...z,
      type: z.high < tfClose ? "support" : "resistance"
    }));

    // Nearest zone (by mid distance to current price)
    const nearestZone = normalizedZones?.length
      ? normalizedZones
          .map(z => {
            const mid = (z.low + z.high) / 2;
            const distancePct = ((livePrice - mid) / livePrice) * 100;
            return { ...z, distancePct };
          })
          .sort((a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct))[0]
      : null;

    // Distances
    const price = livePrice;

    const emaValue = Number.isFinite(ema50) ? ema50 : null;
    const vwapValue = Number.isFinite(vwap) ? vwap : null;

    const distanceToEMA =
      emaValue ? ((price - emaValue) / emaValue) * 100 : 0;

    const distanceToVWAP =
      vwapValue ? ((price - vwapValue) / vwapValue) * 100 : 0;

    const rsiState =
      rsi === null ? "unknown" :
      rsi > 60 ? "strong" :
      rsi < 40 ? "weak" :
      "neutral";

    /* 6) CONFIDENCE + INVALIDATION (CODE DECIDES) */
    const invalidation = computeInvalidation(structure);

    const confidence = computeConfidence({
      structure,
      nearestZone,
      emaDist: distanceToEMA,
      vwapDist: distanceToVWAP,
      rsi,
      mtf
    });
    
    const tradePlan = buildTradePlan({
  candles,
  price: livePrice,
  structure,
  zones: normalizedZones,
  emaDist: distanceToEMA,
  vwapDist: distanceToVWAP,
  rsiValue: rsi,
  invalidation
});

    function getHigherTf(tf) {
  // LTF -> HTF mapping
  if (tf === "1h") return "1d";
  if (tf === "1d") return "7d";
  return null; // for 7d or unknown
}



function normalizeBias(bias) {
  if (!bias) return "range";

  const b = String(bias).toLowerCase();

  if (b.includes("bull")) return "bullish";
  if (b.includes("bear")) return "bearish";

  return "range";
}

function computeMtfAlignment(ltfBias, htfBias) {
  const l = normalizeBias(ltfBias);
  const h = normalizeBias(htfBias);

  // HTF range = neutral context (not a conflict)
  if (h === "range") {
    return { status: "htf_range", aligned: true };
  }

  // LTF range while HTF trending = indecision
  if (l === "range" && h !== "range") {
    return { status: "ltf_range", aligned: false };
  }

  // Same trend direction
  if (l === h) {
    return { status: "aligned", aligned: true };
  }

  // Opposite directions
  return { status: "conflict", aligned: false };
}

    /* 7) FACTS PACKET (ONLY TRUTH) */
    const facts = {
      coin,
      timeframe: tf,
      price: round(price, 2),

      mtf: mtf.enabled ? mtf : null,

      structure: structure ? {
        bias: structure.bias,
        event: structure.event ? {
          type: structure.event.type,
          direction: structure.event.direction,
          price: round(structure.event.price, 2)
        } : null,
        lastHigh: structure.lastHigh?.price ? round(structure.lastHigh.price, 2) : null,
        lastLow: structure.lastLow?.price ? round(structure.lastLow.price, 2) : null
      } : null,

      nearestZone: nearestZone ? {
        type: nearestZone.type,
        low: round(nearestZone.low, 2),
        high: round(nearestZone.high, 2),
        strength: round(nearestZone.strength, 2),
        distancePct: round(nearestZone.distancePct, 2)
      } : null,

      confluence: {
        ema50: emaValue ? {
          value: round(emaValue, 2),
          distancePct: round(distanceToEMA, 2)
        } : null,
        vwap: vwapValue ? {
          value: round(vwapValue, 2),
          distancePct: round(distanceToVWAP, 2)
        } : null,
        rsi14: rsi !== null ? {
          value: round(rsi, 1),
          state: rsiState
        } : { value: null, state: "unknown" }
      },

      confidence,
      invalidation
    };

    facts.tradePlan = tradePlan;

    /* 8) AI NARRATION (FLEXIBLE WORDING, NO INVENTING) */
    const explanation = await narrateFacts(callGemini, facts);

    /* 9) RESPONSE */
    res.json({
      paid: true,
      txHash,
      coin,
      timeframe: tf,
      prices: { live: livePrice, tfClose },
      analysis: {
        facts,                 // ✅ structured truth for UI
        explanation,           // ✅ human narration

        // keep your chart series too:
        structure,
        htfStructure,   // ✅ add this
        mtf,            // ✅ add this
        confidence,
        invalidation,
        tradePlan,
        zones: normalizedZones,
        nearestZone,

        ema50,
        ema50Series,

        vwap: vwapValue,
        vwapSeries,

        rsi,
        rsiSeries
      }
    });

  } catch (err) {
    console.error("Paid analysis error:", err);
    res.status(500).json({ error: err.message });
  }
});


app.get("/prices/meme-coins", async (req, res) => {
  try {
    const data = await getMultiCoinPricesLarge(MEME_COINS);
    res.json({
      count: MEME_COINS.length,
      data
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch meme coins" });
  }
});


/* =======================
   PRODUCT PICKER
======================= */

app.post("/pick-product", (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "Prompt required" });

  const productId = findBestProductId(prompt) || 1;

  res.json({ productId });
});

app.post("/crypto/preset", async (req, res) => {
  try {
    const { preset, userCoins, limit } = req.body;

    const result = await resolvePreset({
      preset,
      userCoins,
      limit
    });

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

app.get("/crypto/chart/:coinId", async (req, res) => {
  try {
    const { coinId } = req.params;

    const prices = await getMarketChart(coinId, 7);

    const { support, resistance } = calculateSupportResistance(prices);
    const trend = detectTrend(prices);

    res.json({
      coinId,
      prices,
      support,
      resistance,
      trend
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



function getTfConfig(tf) {
  switch (tf) {
    case "1h":
      return {
        interval: "1h",
        limit: 400   // 👈 THIS FIXES THE SCANTY CHART
      };

    case "1d":
      return {
        interval: "1d",
        limit: 180
      };

    case "7d":
      return {
        interval: "1d",
        limit: 110
      };

    default:
      return {
        interval: "1h",
        limit: 100
      };
  }
}

app.get("/crypto/chart", async (req, res) => {
  try {
    const coin = req.query.coin || "bitcoin";
    const tf = req.query.tf || "1h";

    const { limit } = getTfConfig(tf);

    // Fetch raw candles
    const rawCandles = await getMarketCandles(coin, tf);

    if (!Array.isArray(rawCandles) || rawCandles.length === 0) {
      return res.status(400).json({ error: "No candle data" });
    }

    // 🔑 Keep only the most recent candles for this timeframe
    const candles = rawCandles.slice(-limit);

    const closes = candles.map(c => c.c);

    const ema20 = calculateEMA(closes, 20);
    const ema50 = calculateEMA(closes, 50);
    const rsi = calculateRSI(closes, 14);

    return res.json({
      candles,
      ema20,
      ema50,
      rsi
    });
  } catch (err) {
    console.error("Crypto chart error:", err);
    return res.status(500).json({ error: err.message });
  }
});



app.get("/crypto/search", async (req, res) => {
  try {
    const q = (req.query.q || "").toLowerCase();
    const preset = req.query.preset || "coins";

    if (!q) return res.json({ coins: [] });

    let coins = [];

    if (preset === "coins") {
      coins = await getTopCoins(22);
    } 
    else if (preset === "meme_coins") {
      coins = MEME_COINS;
    } 
    else {
      // user_custom → all coins
      coins = await searchCoin(q); // existing CoinGecko search
    }

    const filtered = coins
      .filter(c =>
        c.name.toLowerCase().includes(q) ||
        c.symbol.toLowerCase().includes(q)
      )
      .slice(0, 8);

    res.json({ coins: filtered });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


/* =======================
   AI ANALYSIS
======================= */

app.post("/ai/ai-query", async (req, res) => {
  try {
    const { productId, task, userAddress, mode, customQuery } = req.body;

    if (!productId || !userAddress) {
      return res.status(400).json({ error: "Missing productId or userAddress" });
    }

    const finalMode = mode || task || "analysis";

    if (finalMode === "Custom research" && (!customQuery || !customQuery.trim())) {
      return res.status(400).json({ error: "Custom research query is empty" });
    }

    // 1. Pay
    const txHash = await agentPayForAccess(
      userAddress,
      productId,
      finalMode,
      PRODUCT_PRICE
    );

    // 2. Verify
    const isValid = await verifyContractPayment(txHash, productId, PRODUCT_PRICE);
    if (!isValid) return res.status(402).json({ error: "Payment failed" });

    // 3. Load data
    const product = await fetch(
      `https://dummyjson.com/products/${productId}`
    ).then(r => r.json());

    const comments = await fetch(
      `https://dummyjson.com/comments?limit=20`
    ).then(r => r.json());

    // ===============================
// STRICT SYSTEM RULES (GLOBAL)
// ===============================
const SYSTEM_RULES = `
You are an AI analyst operating inside a professional terminal UI.

STRICT OUTPUT RULES (MANDATORY):
- Plain text only (NO markdown, NO **, NO emojis)
- Max 8 lines total
- Each line under 120 characters
- Short, direct, professional tone
- No introductions, no conclusions, no filler
- Do NOT restate the product JSON
- Do NOT explain your reasoning

FORMAT (must match exactly):

SUMMARY:
<one sentence>

KEY POINTS:
- <short point>
- <short point>
- <short point>

RISK:
<one short sentence>

ACTION:
<one short sentence>
`;

// ===============================
// PROMPT BUILDER
// ===============================
let prompt = "";

if (finalMode === "Analyze profitability") {
  prompt = `
${SYSTEM_RULES}

TASK:
Assess product profitability using pricing, reviews, demand signals, and risk.

Focus on:
- Revenue potential
- Margin or cost pressure
- Scalability constraints

Product Data:
${JSON.stringify(product)}
`;
}

else if (finalMode === "Analyze sentiment") {
  prompt = `
${SYSTEM_RULES}

TASK:
Assess customer sentiment and reputation risk.

Focus on:
- Overall satisfaction
- Repeated complaints
- Trust or quality signals

Product Data:
${JSON.stringify(product)}
`;
}

else if (finalMode === "Generate marketing ideas") {
  prompt = `
${SYSTEM_RULES}

TASK:
Generate practical marketing angles for this product.

Focus on:
- Target audience
- Core selling angle
- One clear campaign idea

Product Data:
${JSON.stringify(product)}
`;
}

else if (finalMode === "Custom research") {
  prompt = `
${SYSTEM_RULES}

TASK:
Answer the user's request using ONLY the product data.

User Request:
${customQuery}

Constraints:
- Do not speculate
- If data is insufficient, say so clearly

Product Data:
${JSON.stringify(product)}
`;
}

else {
  prompt = `
${SYSTEM_RULES}

TASK:
Perform the requested analysis.

User Task:
${finalMode}

Product Data:
${JSON.stringify(product)}
`;
}


    // 5. AI
    const analysis = await callGemini(prompt);

    res.json({
      txHash,
      productId,
      mode: finalMode,
      analysis
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "AI failed" });
  }
});


app.get("/price/:coin", async (req, res) => {  
  try {  
    const coinId = req.params.coin.toLowerCase();  
    const price = await getCoinPrice(coinId);  
  
    res.json({  
      coin: coinId,  
      usd: price  
    });  
  } catch (err) {  
    res.status(400).json({ error: err.message });  
  }  
});  

app.post("/ai/crypto-analyze", async (req, res) => {
  // Trace collector (frontend can render like a console)
  const trace = [];
  const t0 = Date.now();

  const log = (m) => {
    // keep trace lightweight + safe
    const msg = String(m ?? "");
    trace.push({ t: Date.now(), dt: Date.now() - t0, m: msg.slice(0, 240) });
    if (trace.length > 80) trace.shift(); // prevent unbounded growth
  };

  let txHash = "";

  try {
    const {
      userAddress,
      coinId,
      mode = "general",
      preset,
      portfolio,
      customQuery,
    } = req.body || {};

    log("Request received");

    if (!userAddress) {
      log("Missing userAddress");
      return res.status(400).json({ error: "Missing userAddress", trace });
    }

    if (!coinId && mode !== "portfolio") {
      log("coinId required (mode is not portfolio)");
      return res.status(400).json({ error: "coinId required", trace });
    }

    /* =========================
       1) Charge user via x402
    ========================= */

    const PRODUCT_ID = 3; // virtual product id for crypto AI
    log("Paying x402...");

    txHash = await agentPayForAccess(
      userAddress,
      PRODUCT_ID,
      `crypto:${mode}`,
      PRODUCT_PRICE
    );

    log(`Paid. tx=${txHash}`);

    /* =========================
       2) Verify payment
    ========================= */

    log("Verifying payment...");
    const isValid = await verifyContractPayment(
      txHash,
      PRODUCT_ID,
      PRODUCT_PRICE
    );

    if (!isValid) {
      log("Payment verification failed");
      return res.status(402).json({ error: "Payment failed", txHash, trace });
    }

    log("Payment verified ✅");

    /* =========================
       3) Build context
    ========================= */

    log("Getting market info...");
    let context = "";

    if (mode === "portfolio") {
      const list = Array.isArray(portfolio) ? portfolio.filter(Boolean) : [];

      if (!list.length) {
        log("Portfolio is empty");
        return res
          .status(400)
          .json({ error: "Portfolio is empty", txHash, trace });
      }

      context = `PORTFOLIO_IDS=${list.join(",")}`;
      log(`Portfolio loaded (${list.length} coins)`);
    } else {
      const price = await getCoinPrice(coinId);
      const safePrice = Number.isFinite(Number(price))
        ? Number(price).toFixed(6)
        : String(price);

      context = `COIN_ID=${coinId}\nPRICE_USD=${safePrice}`;
      log(`Price fetched: ${safePrice} USD`);
    }

    /* =========================
       4) Strict terminal rules
    ========================= */

    const SYSTEM_RULES = `
You are an AI analyst operating inside a professional terminal UI.

STRICT OUTPUT RULES (MANDATORY):
- Plain text only (NO markdown, NO **, NO emojis)
- Max 8 lines total
- Each line under 120 characters
- Short, direct, professional tone
- No introductions, no conclusions, no filler
- Do NOT explain your reasoning
- If data is insufficient, say "INSUFFICIENT_DATA" on the SUMMARY line

FORMAT (must match exactly):

SUMMARY:
<one sentence>

KEY POINTS:
- <short point>
- <short point>
- <short point>

RISK:
<one short sentence>

ACTION:
<one short sentence>
`.trim();

    /* =========================
       5) Mode-specific task
    ========================= */

    function buildTask(mode) {
      switch (mode) {
        case "general":
          return "Assess current market state and give a clean trade plan with conditions.";
        case "volatility":
          return "Assess volatility regime and risk conditions. Focus on position sizing.";
        case "crash":
          return "Assess crash-risk signals and downside scenarios. Focus on defense.";
        case "longterm":
          return "Assess long-term regime. Focus on accumulate vs wait.";
        case "meme":
          return "Assess meme-coin risk: hype cycles, liquidity risk, sharp drawdowns.";
        case "portfolio":
          return "Assess portfolio-level risk: diversification and overlap. No price targets.";
        case "debate":
          return "Provide bull vs bear view with one decisive action.";
        case "backtest":
          return "Propose a simple testable ruleset without claiming results.";
        case "custom":
          return "Answer the user request using only the provided context.";
        default:
          return "Assess market state and give a clean plan.";
      }
    }

    const task = buildTask(mode);

    /* =========================
       6) Prompt
    ========================= */

    const prompt = `
${SYSTEM_RULES}

TASK:
${task}

CONTEXT:
Mode=${mode}
Preset=${preset || "unknown"}
${context}
${
  customQuery
    ? `UserRequest=${String(customQuery).replace(/\s+/g, " ").slice(0, 400)}`
    : ""
}
`.trim();

    /* =========================
       7) AI call
    ========================= */

    log("Running AI...");
    const raw = await callGemini(prompt);
    log("AI completed ✅");

    /* =========================
       8) Hard sanitize output
    ========================= */

    function sanitizeTerminalText(text) {
      return String(text || "")
        .replace(/\r/g, "")
        .replace(/\*\*/g, "")
        .replace(/\*/g, "")
        .replace(/#+/g, "")
        .replace(/[•]/g, "-")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .slice(0, 1400);
    }

    const analysis = sanitizeTerminalText(raw);

    log("Done");
    return res.json({ txHash, analysis, trace });
  } catch (err) {
    const msg = err?.reason || err?.message || "Unknown error";
    log(`Error: ${msg}`);
    console.error("Crypto AI error:", err);
    return res.status(500).json({ error: msg, txHash, trace });
  }
});



/* =======================
   EXTRA AI ENDPOINTS 
======================= */

app.post("/ai/ai-profit-check", async (req, res) => {
  const { productId } = req.body;

  const product = await fetch(`https://dummyjson.com/products/${productId}`).then(r => r.json());

  const prompt = `
You are a dropshipping analyst.

Return JSON:

{
  "costPrice": number,
  "sellPrice": number,
  "adsCost": number,
  "shipping": number,
  "profit": number,
  "marginPercent": number,
  "verdict": "good | risky | bad"
}

Product:
${JSON.stringify(product, null, 2)}
`;

  const ai = await callGemini(prompt);
  res.json(JSON.parse(ai));
});


app.post("/ai-sentiment", async (req, res) => {
  const comments = await fetch("https://dummyjson.com/comments?limit=30").then(r => r.json());

  const prompt = `
Analyze customer sentiment and risk.

Return JSON:

{
  "score": 0-100,
  "riskLevel": "low | medium | high",
  "commonComplaints": [],
  "summary": ""
}

Comments:
${JSON.stringify(comments.comments, null, 2)}
`;

  const ai = await callGemini(prompt);
  res.json(JSON.parse(ai));
});


app.post("/ai-cart", async (req, res) => {
  const { budget } = req.body;

  const products = PRODUCT_CACHE.slice(0, 50).map(p => ({
    id: p.id,
    title: p.title,
    price: p.price,
    category: p.category
  }));

  const prompt = `
Select products to build a cart under $${budget}.

Return JSON:

{
  "items": [{ "id": number, "qty": number }],
  "total": number,
  "reasoning": "..."
}

Products:
${JSON.stringify(products, null, 2)}
`;

  const ai = await callGemini(prompt);
  res.json({ cart: JSON.parse(ai) });
});


app.post("/ai-users-persona", async (req, res) => {
  const users = await fetch("https://dummyjson.com/users?limit=50").then(r => r.json());

  const prompt = `
You are a marketing analyst.

Build 3 buyer personas.

Return JSON:
[
  {
    "name": "",
    "ageRange": "",
    "interests": [],
    "buyingBehavior": "",
    "recommendedProducts": []
  }
]

Users:
${JSON.stringify(users.users, null, 2)}
`;

  const ai = await callGemini(prompt);
  res.json(JSON.parse(ai));
});


app.post("/ai-marketing-content", async (req, res) => {
  const { productName } = req.body;

  const posts = await fetch("https://dummyjson.com/posts?limit=50").then(r => r.json());

  const prompt = `
Generate marketing copy for product "${productName}".

Return JSON:
{
  "headline": "",
  "shortAd": "",
  "longDescription": "",
  "cta": ""
}

Posts style reference:
${JSON.stringify(posts.posts.slice(0, 10), null, 2)}
`;

  const ai = await callGemini(prompt);
  res.json(JSON.parse(ai));
});


app.post("/ai-business-tasks", async (req, res) => {
  const { businessType } = req.body;

  const todos = await fetch("https://dummyjson.com/todos?limit=50").then(r => r.json());

  const prompt = `
You are an ecommerce operations manager.

Create a task plan for: ${businessType}

Return JSON:
{
  "today": [],
  "thisWeek": [],
  "automationCandidates": []
}

Reference tasks:
${JSON.stringify(todos.todos, null, 2)}
`;

  const ai = await callGemini(prompt);
  res.json(JSON.parse(ai));
});


app.post("/ai-meal-planner", async (req, res) => {
  const { diet } = req.body;

  const recipes = await fetch("https://dummyjson.com/recipes?limit=50").then(r => r.json());

  const prompt = `
Create a 3-day meal plan for diet: ${diet}

Return JSON:
{
  "day1": [],
  "day2": [],
  "day3": [],
  "shoppingList": []
}

Recipes:
${JSON.stringify(recipes.recipes.slice(0, 20), null, 2)}
`;

  const ai = await callGemini(prompt);
  res.json(JSON.parse(ai));
});


/* =======================
   START
======================= */

/* =======================
   START (DEBUG VERSION)
======================= */

(async () => {
  console.log("Step 1: Starting initProducts...");

  try {
    await initProducts();
    console.log("Step 2: Products initialized. Indexing...");

    indexProducts(PRODUCT_CACHE);

    console.log("Step 3: Starting Express on PORT", PORT);

    const server = app.listen(PORT, () => {
      console.log(`🚀 Server finally running on ${PORT}`);
    });

    server.on("error", e => {
      console.error("EXPRESS SERVER ERROR:", e);
    });
  } catch (error) {
    console.error("❌ CRASHED DURING STARTUP:", error);
    process.exit(1);
  }
})();
