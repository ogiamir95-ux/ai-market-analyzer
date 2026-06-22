const fetch = require('node-fetch');

// ==========================================================================
// ⚙️ KONFIGURASI UTAMA (INPUT SEKALI SAJA DI SINI)
// ==========================================================================
const TWELVEDATA_API_KEY = "567eb758d8124f24aa2d5a81c6e46916"; 
const TELEGRAM_TOKEN = "8621769166:AAEOmvsZZkUYR8mzbZPnPowTU7DXG_8SZZs";
const TELEGRAM_CHAT_ID = "-1003724360349";

const ASSETS_TO_WATCH = [
    { symbol: "XAU/USD", mode: "swing", interval: "1day" },
    { symbol: "AUD/USD", mode: "intraday", interval: "1h" },
    { symbol: "EUR/USD", mode: "intraday", interval: "1h" }
];
// ==========================================================================

const TD_BASE = 'https://api.twelvedata.com';
const tradingModes = {
    scalping: { atrMultiplier: 1.5 },
    intraday: { atrMultiplier: 2.0 },
    swing: { atrMultiplier: 2.5 }
};

function calcRSI(closes, p = 14) {
    if (closes.length < p + 1) return null;
    let gains = 0, losses = 0;
    for (let i = 1; i <= p; i++) {
        let diff = closes[i] - closes[i - 1];
        if (diff > 0) gains += diff; else losses -= diff;
    }
    let avgGain = gains / p, avgLoss = losses / p;
    for (let i = p + 1; i < closes.length; i++) {
        let diff = closes[i] - closes[i - 1];
        avgGain = (avgGain * (p - 1) + (diff > 0 ? diff : 0)) / p;
        avgLoss = (avgLoss * (p - 1) + (diff < 0 ? -diff : 0)) / p;
    }
    return avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));
}

function calcSMA(d, p) {
    if (!d || d.length < p) return null;
    return d.slice(-p).reduce((s, v) => s + v, 0) / p;
}

function calcMACD(c) {
    if (c.length < 35) return null;
    let ema12Arr = [], ema26Arr = [], macdArr = [];
    let k12 = 2 / 13, k26 = 2 / 27;
    let ema12 = c.slice(0, 12).reduce((a, b) => a + b, 0) / 12;
    let ema26 = c.slice(0, 26).reduce((a, b) => a + b, 0) / 26;
    for (let i = 0; i < c.length; i++) {
        if (i >= 12) ema12 = c[i] * k12 + ema12 * (1 - k12);
        if (i >= 26) ema26 = c[i] * k26 + ema26 * (1 - k26);
        if (i >= 26) macdArr.push(ema12 - ema26);
    }
    if (macdArr.length < 9) return null;
    let k9 = 2 / 10;
    let signal = macdArr.slice(0, 9).reduce((a, b) => a + b, 0) / 9;
    for (let i = 9; i < macdArr.length; i++) signal = macdArr[i] * k9 + signal * (1 - k9);
    return { histogram: macdArr[macdArr.length - 1] - signal };
}

function calcBoll(c, p = 20) {
    if (c.length < p) return null;
    const s = calcSMA(c, p);
    const v = c.slice(-p).reduce((a, v) => a + (v - s) ** 2, 0) / p;
    const std = Math.sqrt(v);
    return { middle: s, upper: s + 2 * std, lower: s - 2 * std };
}

function calcRiskAndTargets(price, highs, lows, closes, modeStr, signalType, p = 14) {
    if (closes.length < p + 1 || !tradingModes[modeStr]) return null;
    let tr = 0;
    for (let i = closes.length - p; i < closes.length; i++) {
        tr += Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    }
    const atr = tr / p;
    const multiplier = tradingModes[modeStr].atrMultiplier;
    const atrDistance = atr * multiplier;
    let stopLoss = price, takeProfit = price;

    if (signalType === 'BUY') { stopLoss = price - atrDistance; takeProfit = price + (atrDistance * 2); }
    else if (signalType === 'SELL') { stopLoss = price + atrDistance; takeProfit = price - (atrDistance * 2); }
    else return null;

    const riskPct = (Math.abs(price - stopLoss) / price) * 100;
    const dec = price > 100 ? 2 : 5;
    return { atr: atr.toFixed(dec), sl: stopLoss.toFixed(dec), tp: takeProfit.toFixed(dec), stopPct: riskPct.toFixed(2) };
}

async function fetchCandles(symbol, interval) {
    const url = `${TD_BASE}/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=100&apikey=${TWELVEDATA_API_KEY}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.status === 'error') throw new Error(data.message);
    return data.values.map(c => ({
        open: parseFloat(c.open), high: parseFloat(c.high), low: parseFloat(c.low), close: parseFloat(c.close)
    })).reverse();
}

function analyzeMarket(candles, modeStr) {
    const o = candles.map(d => d.open);
    const h = candles.map(d => d.high);
    const l = candles.map(d => d.low);
    const c = candles.map(d => d.close);

    const rsi = calcRSI(c);
    const macd = calcMACD(c);
    const boll = calcBoll(c);
    const price = c[c.length - 1];

    let bull = 0, bear = 0;
    if (rsi !== null) { if (rsi < 35) bull += 2; else if (rsi > 65) bear += 2; }
    if (macd) { if (macd.histogram > 0) bull++; else bear++; }
    if (boll) { if (price <= boll.lower * 1.002) bull++; else if (price >= boll.upper * 0.998) bear++; }

    let signal = 'HOLD';
    if (bull >= bear + 2 && bull >= 3) signal = 'BUY';
    else if (bear >= bull + 2 && bear >= 3) signal = 'SELL';

    const targets = calcRiskAndTargets(price, h, l, c, modeStr, signal);
    return { signal, price, targets };
}

async function sendTelegram(symbol, mode, interval, result) {
    // Pada sistem ini, robot HANYA mengirim notifikasi jika mendeteksi sinyal aksi (BUY/SELL)
    if (result.signal === 'HOLD') {
        console.log(`[ℹ️ HOLD] ${symbol} berada di zona aman (Tidak kirim telegram).`);
        return; 
    }

    const dec = result.price > 100 ? 2 : 5;
    let statusLabel = result.signal === 'BUY' ? '🟢 BUY SIGNAL' : '🔴 SELL SIGNAL';

    let message = `📊 *AI GITHUB ACTIONS REPORT*\n───────────────────\n🔹 *Asset:* ${symbol}\n🔹 *Mode:* ${mode.toUpperCase()}\n🔹 *TF:* ${interval}\n\n📢 *STATUS:* ${statusLabel}\n💵 *Harga:* ${result.price.toFixed(dec)}\n───────────────────\n`;
    
    if (result.targets) {
        message += `📍 *SETUP EXECUTION:*\n🟢 *Entry:* ${result.price.toFixed(dec)}\n🎯 *TP:* ${result.targets.tp}\n🛑 *SL:* ${result.targets.sl}\n📐 *Risk/ATR:* ${result.targets.atr} (${result.targets.stopPct}%)\n\n`;
    }
    message += `⚡ _Engine dieksekusi otomatis oleh GitHub Actions_`;

    try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'Markdown' })
        });
        console.log(`[🚀 SENT] Sinyal ${symbol} sukses dikirim ke Telegram.`);
    } catch (err) {
        console.error("Gagal mengirim Telegram:", err);
    }
}

async function runEngine() {
    console.log("🏁 Memulai scanning pasar...");
    for (const asset of ASSETS_TO_WATCH) {
        try {
            const candles = await fetchCandles(asset.symbol, asset.interval);
            const analysis = analyzeMarket(candles, asset.mode);
            console.log(`▶️ ${asset.symbol}: ${analysis.signal} @ ${analysis.price}`);
            await sendTelegram(asset.symbol, asset.mode, asset.interval, analysis);
        } catch (e) {
            console.error(`❌ Gagal analisa ${asset.symbol}:`, e.message);
        }
    }
    console.log("✅ Scanning selesai.");
}

runEngine();
