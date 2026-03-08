// services/tradePlan.js

function round(n, dp = 2) {
  if (!Number.isFinite(n)) return null;
  const m = 10 ** dp;
  return Math.round(n * m) / m;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

// Simple ATR(14) from candles (uses true range)
function calcATR(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 2) return null;

  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    const tr = Math.max(
      c.h - c.l,
      Math.abs(c.h - p.c),
      Math.abs(c.l - p.c)
    );
    trs.push(tr);
  }

  if (trs.length < period) return null;

  // Wilder smoothing
  let atr = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

// Picks nearest support below price and nearest resistance above price
function pickLevels(zones, price) {
  const supports = (zones || [])
    .filter((z) => z.type === "support")
    .sort((a, b) => b.high - a.high);

  const resistances = (zones || [])
    .filter((z) => z.type === "resistance")
    .sort((a, b) => a.low - b.low);

  const nearestSupport = supports.find((z) => z.high <= price) || supports[0] || null;
  const nearestResistance =
    resistances.find((z) => z.low >= price) || resistances[0] || null;

  return { nearestSupport, nearestResistance };
}
const MAX_LEVEL_DISTANCE = 0.05; // 5%

function within(price, level) {
  return Math.abs(level - price) / price <= MAX_LEVEL_DISTANCE;
}

/**
 * Trade plan is NOT “must-take”. It’s a structured setup suggestion:
 * - direction: long/short/none
 * - entry: price level suggestion
 * - sl: stop loss
 * - tps: take profits
 * - rr: reward/risk
 * - invalidation: “bias breaks if…”
 * - conditions: what must be true before entry
 */
export function buildTradePlan({
  candles,
  price,
  structure,
  zones,
  emaDist,
  vwapDist,
  rsiValue,
  invalidation
}) {
  if (!Number.isFinite(price) || !structure) {
    return {
      decision: "none",
      reason: "Missing price or structure",
      entry: null,
      sl: null,
      tps: [],
      rr: null,
      invalidation: invalidation || null,
      conditions: []
    };
  }

  const bias = String(structure.bias || "range").toLowerCase();
  const isBull = bias.includes("bull");
  const isBear = bias.includes("bear");
  const isRange = !isBull && !isBear;

  const { nearestSupport, nearestResistance } = pickLevels(zones, price);
  const atr = calcATR(candles, 14);

  // “Regime” filter from EMA/VWAP distances
  // (You already compute these; pass them in)
  const trendSupport =
    (Number.isFinite(emaDist) ? emaDist : 0) > 0 &&
    (Number.isFinite(vwapDist) ? vwapDist : 0) > 0;

  const trendPressure =
    (Number.isFinite(emaDist) ? emaDist : 0) < 0 &&
    (Number.isFinite(vwapDist) ? vwapDist : 0) < 0;

  // Momentum (not signal) – just helps avoid fighting obvious pressure
  const rsi = Number.isFinite(rsiValue) ? rsiValue : 50;

  const conditions = [];
  let decision = "none";
  let entry = null;
  let sl = null;
  let tps = [];
  let reason = "";

  // Build SL padding using ATR if available, else 0.35% fallback
  const slPad = atr ? atr * 0.8 : price * 0.0035;

  if (nearestSupport && !within(price, nearestSupport.high, 0.01) &&
      nearestResistance && !within(price, nearestResistance.low, 0.01)) {
    return {
      decision: "none",
      reason: "Price not near support/resistance zone",
      entry: null,
      sl: null,
      tps: [],
      rr: null,
      invalidation: invalidation || null,
      conditions: ["Wait for price to reach a key zone"]
    };
  }

  // RANGE logic: fade extremes (support -> long, resistance -> short)
  if (isRange) {
    if (nearestSupport && Math.abs((price - nearestSupport.high) / price) < 0.01) {
      decision = "long";
      entry = nearestSupport.high; // buy at top of support zone
      sl = nearestSupport.low - slPad;

      const tp1 = price + (price - sl) * 1.0;
      const tp2 = price + (price - sl) * 1.8;

      tps = [
        { label: "TP1", price: tp1 },
        { label: "TP2", price: tp2 }
      ];

      reason = "Range regime: price near support liquidity zone.";
      conditions.push("Wait for rejection candle / bounce from support");
      conditions.push("Avoid entry if strong bearish BOS triggers");
    } else if (
      nearestResistance &&
      Math.abs((nearestResistance.low - price) / price) < 0.01
    ) {
      decision = "short";
      entry = nearestResistance.low; // sell at bottom of resistance zone
      sl = nearestResistance.high + slPad;

      const tp1 = price - (sl - price) * 1.0;
      const tp2 = price - (sl - price) * 1.8;

      tps = [
        { label: "TP1", price: tp1 },
        { label: "TP2", price: tp2 }
      ];

      reason = "Range regime: price near resistance liquidity zone.";
      conditions.push("Wait for rejection candle / drop from resistance");
      conditions.push("Avoid entry if strong bullish BOS triggers");
    } else {
      decision = "none";
      reason = "Range regime: price not near a high-quality boundary zone.";
      conditions.push("Wait for price to reach support or resistance zone");
    }
  }

  // TREND logic: trade WITH bias, prefer pullbacks into zones
  if (!isRange) {
    if (isBull) {
      // Prefer long if price not under heavy pressure + RSI not collapsing
      const ok = !trendPressure && rsi >= 40;

      if (ok && nearestSupport) {
        decision = "long";
        entry = Math.min(price, nearestSupport.high);
        sl = nearestSupport.low - slPad;

        const risk = Math.abs(entry - sl);
        const tp1 = entry - risk * 1.2;
        const tp2 = entry - risk * 2.2;

        tps = [
          { label: "TP1", price: tp1 },
          { label: "TP2", price: tp2 }
        ];

        reason = "Bullish structure: long pullback into support zone.";
        conditions.push("Confirm bullish hold above support zone");
        conditions.push("Avoid entry if bearish CHoCH prints");
      } else {
        decision = "none";
        reason =
          "Bullish structure but conditions not favorable (pressure or no support zone).";
        conditions.push("Wait for pullback into support zone or reduce risk size");
      }
    }

    if (isBear) {
      const ok = !trendSupport && rsi <= 60;

      if (ok && nearestResistance) {
        decision = "short";
        entry = Math.max(price, nearestResistance.low);
        sl = nearestResistance.high + slPad;

        const risk = Math.abs(entry - sl);
        const tp1 = entry + risk * 1.2;
        const tp2 = entry + risk * 2.2;

        tps = [
          { label: "TP1", price: tp1 },
          { label: "TP2", price: tp2 }
        ];

        reason = "Bearish structure: short pullback into resistance zone.";
        conditions.push("Confirm bearish rejection at resistance zone");
        conditions.push("Avoid entry if bullish CHoCH prints");
      } else {
        decision = "none";
        reason =
          "Bearish structure but conditions not favorable (supportive regime or no resistance zone).";
        conditions.push("Wait for bounce into resistance zone or reduce risk size");
      }
    }
  }

  // RR
  let rr = null;
  if (decision !== "none" && entry !== null && sl !== null && tps?.length) {
    const risk = Math.abs(entry - sl);
    const reward = Math.abs(tps[0].price - entry);
    rr = risk > 0 ? reward / risk : null;
  }

  return {
    decision,
    reason,
    entry: round(entry, 2),
    sl: round(sl, 2),
    tps: tps.map((tp) => ({ ...tp, price: round(tp.price, 2) })),
    rr: rr ? round(rr, 2) : null,
    invalidation: invalidation || null,
    conditions
  };
}
