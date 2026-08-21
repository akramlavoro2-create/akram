// ============================================
// BOT A.K.R.A.M. TRADING v3.0
// Motore di trading automatico per TradingView + BitGet
// Multi-simbolo, con backtest, stato persistente e
// protezioni stop-loss/take-profit lato exchange.
// ============================================

import dotenv from 'dotenv';
import fs from 'fs';
import crypto from 'crypto';
import fetch from 'node-fetch';
import { createServer } from 'http';
import moment from 'moment';

dotenv.config();

// ==================== ARGOMENTI CLI ====================

const ARGV = process.argv.slice(2);
const hasFlag = (name) => ARGV.includes(name);
const flagValue = (name, fallback = null) => {
    const i = ARGV.indexOf(name);
    return i > -1 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--') ? ARGV[i + 1] : fallback;
};

const RUN_MODE = hasFlag('--backtest') ? 'backtest'
    : hasFlag('--test') ? 'test'
    : hasFlag('--once') ? 'once'
    : 'live';

// ==================== CONFIGURAZIONE ====================

function parseSymbols(raw) {
    if (!raw) return null;
    const list = raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    return list.length > 0 ? list : null;
}

const CONFIG = {
    exchange: process.env.EXCHANGE || 'bitget',
    apiKey: process.env.BITGET_API_KEY,
    secretKey: process.env.BITGET_SECRET_KEY,
    passphrase: process.env.BITGET_PASSPHRASE,
    portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD) || 1000,
    maxTradeSize: parseFloat(process.env.MAX_TRADE_SIZE_USD) || 50,
    maxTradesPerDayPerSymbol: parseInt(process.env.MAX_TRADES_PER_DAY_PER_SYMBOL || process.env.MAX_TRADES_PER_DAY) || 3,
    maxTradesPerDayTotal: parseInt(process.env.MAX_TRADES_PER_DAY_TOTAL) || 0, // 0 = nessun limite globale
    maxPositions: parseInt(process.env.MAX_POSITIONS) || 0,                    // 0 = calcolato dai simboli
    maxPositionsPerSymbol: parseInt(process.env.MAX_POSITIONS_PER_SYMBOL) || 1,
    maxDrawdown: parseFloat(process.env.MAX_DRAWDOWN_PERCENT) || 20,
    // SYMBOLS ha la precedenza; poi SYMBOL; altrimenti i simboli di rules.json
    symbols: parseSymbols(process.env.SYMBOLS) || parseSymbols(process.env.SYMBOL),
    timeframe: process.env.TIMEFRAME || '1h',
    paperTrading: process.env.PAPER_TRADING !== 'false',   // sicuro per default: solo "false" esplicito abilita il live
    tradeMode: process.env.TRADE_MODE || 'spot',
    leverage: parseInt(process.env.LEVERAGE) || 1,
    dataSource: process.env.DATA_SOURCE || 'bitget',        // bitget | synthetic
    minNotionalUsd: parseFloat(process.env.MIN_NOTIONAL_USD) || 5,
    mcpPort: parseInt(process.env.MCP_SERVER_PORT) || 9222,
    mcpHost: process.env.MCP_HOST || 'localhost',
    webhookPort: parseInt(process.env.WEBHOOK_PORT) || 3000,
    webhookPath: process.env.WEBHOOK_PATH || '/webhook',
    webhookToken: process.env.WEBHOOK_TOKEN || '',
    webhookEnabled: process.env.WEBHOOK_ENABLED !== 'false',
    cycleIntervalMs: parseInt(process.env.CYCLE_INTERVAL_MS) || 60000,
    logLevel: process.env.LOG_LEVEL || 'info',
    logFile: process.env.LOG_FILE || 'bot.log',
    tradesFile: process.env.TRADES_FILE || 'trades.csv',
    safetyLogFile: process.env.SAFETY_LOG_FILE || 'safety-check-log.json',
    stateFile: process.env.STATE_FILE || 'bot-state.json',
    positionsFile: process.env.POSITIONS_FILE || 'positions.json'
};

// ==================== SISTEMA DI LOGGING ====================

class Logger {
    constructor() {
        this.levels = { error: 0, warn: 1, info: 2, debug: 3, trade: 4 };
        this.level = CONFIG.logLevel;
        this.logFile = CONFIG.logFile;
        this.tradesFile = CONFIG.tradesFile;

        if (!fs.existsSync(this.logFile)) fs.writeFileSync(this.logFile, '');
        if (!fs.existsSync(this.tradesFile)) {
            fs.writeFileSync(this.tradesFile, 'Timestamp,Type,Symbol,Action,Price,SizeUsd,Fee,NetPnl,Status,Reason\n');
        }
    }

    log(message, type = 'info', data = null) {
        const timestamp = moment().format('YYYY-MM-DD HH:mm:ss.SSS');

        const colorMap = {
            error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m',
            debug: '\x1b[35m', trade: '\x1b[32m'
        };
        const color = colorMap[type] || '\x1b[0m';

        // Rispetta il livello di log configurato (prima veniva ignorato)
        const wanted = this.levels[this.level] ?? 2;
        const current = this.levels[type] ?? 2;
        if (type !== 'trade' && current > wanted) return;

        console.log(`${color}[${timestamp}] [${type.toUpperCase()}] ${message}\x1b[0m`);
        fs.appendFileSync(this.logFile, `[${timestamp}] [${type.toUpperCase()}] ${message}${data ? ' | ' + JSON.stringify(data) : ''}\n`);

        if (type === 'trade' && data) {
            const csv = [
                timestamp, data.type || 'PAPER', data.symbol || '', data.action || '',
                data.price ?? 0, data.sizeUsd ?? 0, data.fee ?? 0, data.net ?? 0,
                data.status || 'OK', (data.reason || '').replace(/,/g, ';')
            ].join(',');
            fs.appendFileSync(this.tradesFile, csv + '\n');
        }
    }

    error(m, d = null) { this.log(m, 'error', d); }
    warn(m, d = null) { this.log(m, 'warn', d); }
    info(m, d = null) { this.log(m, 'info', d); }
    debug(m, d = null) { this.log(m, 'debug', d); }
    trade(m, d = null) { this.log(m, 'trade', d); }
}

const logger = new Logger();

// ==================== STRATEGIA E STATO ====================

let rules = {};
let currentPositions = [];

// Costi reali applicati anche in paper trading.
let COSTS = { commissionPercent: 0.1, slippagePercent: 0.05 };

function loadRules() {
    try {
        rules = JSON.parse(fs.readFileSync('rules.json', 'utf8'));

        COSTS = {
            commissionPercent: rules.backtest?.commission ?? 0.1,
            slippagePercent: rules.backtest?.slippage ?? 0.05
        };

        // Se non e' stato indicato nessun simbolo via env, usa quelli della strategia
        if (!CONFIG.symbols || CONFIG.symbols.length === 0) {
            CONFIG.symbols = (rules.symbols && rules.symbols.length > 0) ? [...rules.symbols] : ['BTCUSDT'];
        }
        // Con N simboli servono almeno N slot, altrimenti i primi simboli
        // consumano tutte le posizioni e gli altri non aprono mai.
        if (!CONFIG.maxPositions || CONFIG.maxPositions < 1) {
            CONFIG.maxPositions = CONFIG.symbols.length * CONFIG.maxPositionsPerSymbol;
        }

        logger.info('✅ Strategia caricata da rules.json', {
            name: rules.name, version: rules.version, symbols: CONFIG.symbols
        });
        return true;
    } catch (e) {
        logger.error('❌ Errore caricamento rules.json', e.message);
        return false;
    }
}

function loadPositions() {
    try {
        if (fs.existsSync(CONFIG.positionsFile)) {
            currentPositions = JSON.parse(fs.readFileSync(CONFIG.positionsFile, 'utf8'));
            logger.info(`📊 Caricate ${currentPositions.length} posizioni aperte`);
        }
    } catch (e) {
        logger.warn('⚠️ positions.json illeggibile, riparto senza posizioni');
        currentPositions = [];
    }
}

function savePositions() {
    fs.writeFileSync(CONFIG.positionsFile, JSON.stringify(currentPositions, null, 2));
}

// Stato persistente: equity, picco, drawdown e conteggio trade per giorno/simbolo.
// Prima il drawdown veniva ricalcolato da trades.csv (file effimero): bastava
// ripartire da una macchina pulita per azzerare la protezione.
const DEFAULT_STATE = () => ({
    equity: CONFIG.portfolioValue,
    peakEquity: CONFIG.portfolioValue,
    realizedPnl: 0,
    maxDrawdownPercent: 0,
    tradesByDay: {},          // { "2026-08-21": { "BTCUSDT": 2, "_total": 5 } }
    createdAt: new Date().toISOString()
});

let state = DEFAULT_STATE();

function loadState() {
    try {
        if (fs.existsSync(CONFIG.stateFile)) {
            state = { ...DEFAULT_STATE(), ...JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf8')) };
            logger.info('📒 Stato caricato', {
                equity: state.equity.toFixed(2),
                peak: state.peakEquity.toFixed(2),
                maxDD: state.maxDrawdownPercent.toFixed(2) + '%'
            });
        }
    } catch (e) {
        logger.warn('⚠️ Stato illeggibile, riparto da zero');
        state = DEFAULT_STATE();
    }
}

function saveState() {
    fs.writeFileSync(CONFIG.stateFile, JSON.stringify(state, null, 2));
}

function recordFill(symbol) {
    const day = moment().format('YYYY-MM-DD');
    state.tradesByDay[day] = state.tradesByDay[day] || {};
    state.tradesByDay[day][symbol] = (state.tradesByDay[day][symbol] || 0) + 1;
    state.tradesByDay[day]._total = (state.tradesByDay[day]._total || 0) + 1;
    saveState();
}

function applyRealizedPnl(netPnl) {
    state.realizedPnl += netPnl;
    state.equity += netPnl;
    if (state.equity > state.peakEquity) state.peakEquity = state.equity;
    const dd = ((state.peakEquity - state.equity) / state.peakEquity) * 100;
    if (dd > state.maxDrawdownPercent) state.maxDrawdownPercent = dd;
    saveState();
}

function currentDrawdownPercent() {
    if (state.peakEquity <= 0) return 0;
    return Math.max(0, ((state.peakEquity - state.equity) / state.peakEquity) * 100);
}

function getTradeLimits(symbol) {
    const day = moment().format('YYYY-MM-DD');
    const today = state.tradesByDay[day] || {};
    return {
        tradesForSymbolToday: today[symbol] || 0,
        tradesTotalToday: today._total || 0
    };
}

// ==================== API BITGET ====================

function signBitGet(timestamp, method, requestPath, body = '') {
    if (!CONFIG.secretKey) throw new Error('BITGET_SECRET_KEY mancante: impossibile firmare la richiesta');
    return crypto.createHmac('sha256', CONFIG.secretKey)
        .update(timestamp + method + requestPath + body)
        .digest('base64');
}

async function bitGetRequest(method, endpoint, body = null, { signed = true } = {}) {
    const timestamp = Date.now().toString();
    const bodyStr = body ? JSON.stringify(body) : '';
    const headers = { 'Content-Type': 'application/json' };

    // Gli endpoint pubblici (candele) non richiedono firma: firmarli obbligava
    // ad avere le chiavi API anche solo per leggere i prezzi.
    if (signed) {
        headers['ACCESS-KEY'] = CONFIG.apiKey;
        headers['ACCESS-SIGN'] = signBitGet(timestamp, method, endpoint, bodyStr);
        headers['ACCESS-TIMESTAMP'] = timestamp;
        headers['ACCESS-PASSPHRASE'] = CONFIG.passphrase;
    }

    const url = `https://api.bitget.com${endpoint}`;
    const fetchOptions = { method, headers };
    if (bodyStr) fetchOptions.body = bodyStr;

    const response = await fetch(url, fetchOptions);
    const text = await response.text();

    let data;
    try {
        data = JSON.parse(text);
    } catch (e) {
        // Errori di rete/proxy restituiscono HTML o testo semplice: senza questo
        // il messaggio reale spariva dietro un "not valid JSON".
        throw new Error(`Risposta non-JSON da BitGet (HTTP ${response.status}): ${text.slice(0, 120)}`);
    }

    if (data.code !== '00000') {
        throw new Error(`BitGet API error [${data.code}]: ${data.msg}`);
    }
    return data.data;
}

// ==================== INDICATORI TECNICI ====================

// Su un mercato completamente fermo non c'e' ne' guadagno ne' perdita medi:
// la formula grezza restituiva 0, cioe' "ipervenduto estremo", facendo
// scattare un falso segnale LONG su un simbolo illiquido o con dati bloccati.
// Per convenzione in quel caso l'RSI e' neutro (50).
function rsiFrom(avgGain, avgLoss) {
    if (avgGain === 0 && avgLoss === 0) return 50;
    if (avgLoss === 0) return 100;
    return 100 - (100 / (1 + avgGain / avgLoss));
}

function calculateRSI(closes, period = 14) {
    if (closes.length < period + 1) return [];
    let gains = 0, losses = 0;
    const rsi = [];

    for (let i = 1; i <= period; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff >= 0) gains += diff; else losses += Math.abs(diff);
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;
    rsi.push(rsiFrom(avgGain, avgLoss));

    for (let i = period + 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff >= 0) {
            avgGain = (avgGain * (period - 1) + diff) / period;
            avgLoss = (avgLoss * (period - 1)) / period;
        } else {
            avgGain = (avgGain * (period - 1)) / period;
            avgLoss = (avgLoss * (period - 1) + Math.abs(diff)) / period;
        }
        rsi.push(rsiFrom(avgGain, avgLoss));
    }
    return rsi;
}

function calculateBB(closes, period = 20, stddev = 2.0) {
    const upper = [], middle = [], lower = [];
    for (let i = period - 1; i < closes.length; i++) {
        const slice = closes.slice(i - period + 1, i + 1);
        const mean = slice.reduce((a, b) => a + b, 0) / period;
        const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
        const std = Math.sqrt(variance);
        middle.push(mean);
        upper.push(mean + stddev * std);
        lower.push(mean - stddev * std);
    }
    return { upper, middle, lower };
}

function calculateEMA(closes, period) {
    if (closes.length < period) return [];
    const ema = [];
    const multiplier = 2 / (period + 1);
    let sum = 0;
    for (let i = 0; i < period; i++) sum += closes[i];
    ema.push(sum / period);
    for (let i = period; i < closes.length; i++) {
        ema.push((closes[i] - ema[ema.length - 1]) * multiplier + ema[ema.length - 1]);
    }
    return ema;
}

function calculateATR(highs, lows, closes, period = 14) {
    if (highs.length < period + 1) return [];
    const tr = [], atr = [];
    for (let i = 1; i < highs.length; i++) {
        const hl = highs[i] - lows[i];
        const hc = Math.abs(highs[i] - closes[i - 1]);
        const lc = Math.abs(lows[i] - closes[i - 1]);
        tr.push(Math.max(hl, hc, lc));
    }
    let sum = 0;
    for (let i = 0; i < period; i++) sum += tr[i];
    atr.push(sum / period);
    for (let i = period; i < tr.length; i++) {
        atr.push((tr[i] + (period - 1) * atr[atr.length - 1]) / period);
    }
    return atr;
}

function calculateSMA(values, period) {
    const sma = [];
    for (let i = period - 1; i < values.length; i++) {
        const slice = values.slice(i - period + 1, i + 1);
        sma.push(slice.reduce((a, b) => a + b, 0) / period);
    }
    return sma;
}

// Ultimo valore di una serie di indicatore.
// BUG STORICO: il codice precedente indicizzava ema_20 ed ema_50 con
// (ema_200.length - 1). Le serie EMA hanno lunghezze diverse (N-period+1),
// quindi ema_20 veniva letta ~180 candele indietro e ema_50 ~150: tutte le
// regole di uscita su ema_20 lavoravano su valori vecchi.
function last(series, fallback) {
    return series && series.length > 0 ? series[series.length - 1] : fallback;
}

// ==================== MARKET DATA ====================

function timeframeToGranularity(timeframe) {
    const map = {
        '1m': '1min', '5m': '5min', '15m': '15min', '30m': '30min',
        '1h': '1h', '4h': '4h', '1d': '1day', '1w': '1week'
    };
    return map[timeframe] || '1h';
}

function buildMarketData(candles, symbol, timeframe) {
    // candles: array [ts, open, high, low, close, volume] in ordine cronologico
    const opens = candles.map(c => parseFloat(c[1]));
    const highs = candles.map(c => parseFloat(c[2]));
    const lows = candles.map(c => parseFloat(c[3]));
    const closes = candles.map(c => parseFloat(c[4]));
    const volumes = candles.map(c => parseFloat(c[5]));

    const idx = closes.length - 1;
    const currentPrice = closes[idx];

    const rsi = calculateRSI(closes, rules.indicators?.rsi?.length || 14);
    const bb = calculateBB(closes, rules.indicators?.bollinger_bands?.length || 20, rules.indicators?.bollinger_bands?.stddev || 2.0);
    const ema20 = calculateEMA(closes, rules.indicators?.ema?.fast || 20);
    const ema50 = calculateEMA(closes, rules.indicators?.ema?.medium || 50);
    const ema200 = calculateEMA(closes, rules.indicators?.ema?.slow || 200);
    const atr = calculateATR(highs, lows, closes, rules.indicators?.atr?.length || 14);
    const volumeMA = calculateSMA(volumes, rules.indicators?.volume?.ma_length || 20);

    return {
        symbol,
        timeframe,
        timestamp: new Date().toISOString(),
        open: opens[idx],
        high: highs[idx],
        low: lows[idx],
        close: currentPrice,
        volume: volumes[idx],
        rsi: last(rsi, 50),
        bb_upper: last(bb.upper, currentPrice * 1.02),
        bb_middle: last(bb.middle, currentPrice),
        bb_lower: last(bb.lower, currentPrice * 0.98),
        ema_20: last(ema20, currentPrice),
        ema_50: last(ema50, currentPrice),
        ema_200: last(ema200, currentPrice),
        atr: last(atr, currentPrice * 0.01),
        volume_ma_20: last(volumeMA, volumes[idx]),
        candleCount: closes.length,
        // true solo se ci sono abbastanza candele per l'indicatore piu' lento
        indicatorsReady: ema200.length > 0 && atr.length > 0 && bb.upper.length > 0
    };
}

async function fetchCandles(symbol, timeframe, limit = 500) {
    const granularity = timeframeToGranularity(timeframe);
    const endpoint = `/api/v2/spot/market/candles?symbol=${symbol}&granularity=${granularity}&limit=${limit}`;
    const data = await bitGetRequest('GET', endpoint, null, { signed: false });
    if (!data || data.length === 0) throw new Error(`Nessuna candela ricevuta per ${symbol}`);
    return data;
}

async function getDataFromMCP(symbol, timeframe) {
    try {
        const response = await fetch(`http://${CONFIG.mcpHost}:${CONFIG.mcpPort}/chart-data`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbol, timeframe })
        });
        if (!response.ok) return null;
        return await response.json();
    } catch (e) {
        return null;
    }
}

// Serie sintetiche lunghe, generate una volta e poi consumate a finestra
// scorrevole: a ogni ciclo arriva una candela nuova, cosi' il mercato simulato
// avanza davvero (altrimenti i dati sarebbero identici a ogni ciclo e nessuna
// posizione si chiuderebbe mai).
const syntheticSeries = new Map();
const syntheticCursor = new Map();
const SYNTHETIC_WINDOW = 500;

function nextSyntheticWindow(symbol) {
    if (!syntheticSeries.has(symbol)) {
        syntheticSeries.set(symbol, syntheticCandles(symbol, 6000));
        syntheticCursor.set(symbol, SYNTHETIC_WINDOW);
    }
    const series = syntheticSeries.get(symbol);
    let cursor = syntheticCursor.get(symbol);
    // Ogni chiamata avanza di una candela; a fine serie riparte dall'inizio.
    if (cursor >= series.length) cursor = SYNTHETIC_WINDOW;
    syntheticCursor.set(symbol, cursor + 1);
    return series.slice(cursor - SYNTHETIC_WINDOW, cursor);
}

async function getMarketData(symbol, timeframe) {
    if (CONFIG.dataSource === 'synthetic') {
        return buildMarketData(nextSyntheticWindow(symbol), symbol, timeframe);
    }

    try {
        const mcpData = await getDataFromMCP(symbol, timeframe);
        if (mcpData && mcpData.close) {
            logger.debug(`📊 Dati da MCP per ${symbol}`);
            return mcpData;
        }
    } catch (e) {
        logger.debug('⚠️ MCP non disponibile, uso API BitGet');
    }

    return buildMarketData(await fetchCandles(symbol, timeframe), symbol, timeframe);
}

// ==================== SORGENTE DATI SINTETICA ====================
// Serve SOLO per test e dimostrazioni offline (DATA_SOURCE=synthetic).
// NON sono prezzi reali: non usare i risultati come misura di redditivita'.

const SYNTHETIC_BASE_PRICE = { BTCUSDT: 95000, ETHUSDT: 3200, SOLUSDT: 180 };

function mulberry32(seed) {
    return function () {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function syntheticCandles(symbol, count = 500, seedOffset = 0) {
    const seed = [...symbol].reduce((a, c) => a + c.charCodeAt(0), 0) + seedOffset;
    const rand = mulberry32(seed);
    const base = SYNTHETIC_BASE_PRICE[symbol] || 100;

    const candles = [];
    let price = base;
    let anchor = base;
    let ts = Date.now() - count * 3600_000;

    for (let i = 0; i < count; i++) {
        // Processo mean-reverting (Ornstein-Uhlenbeck) + rumore:
        // produce estremi di RSI e tocchi delle bande in modo realistico.
        anchor += (rand() - 0.5) * base * 0.002;
        const pull = (anchor - price) * 0.05;
        const shock = (rand() - 0.5) * base * 0.018;
        const open = price;
        price = Math.max(base * 0.4, price + pull + shock);
        const close = price;
        const wick = base * 0.004 * rand();
        const high = Math.max(open, close) + wick;
        const low = Math.min(open, close) - wick;
        const volume = 1_000_000 * (0.5 + rand() * 1.5);
        candles.push([String(ts), open, high, low, close, volume]);
        ts += 3600_000;
    }
    return candles;
}

// ==================== VALUTAZIONE CONDIZIONI ====================

function buildContext(data) {
    return {
        rsi: data.rsi ?? 50,
        close: data.close ?? 0,
        price: data.close ?? 0,
        bb_upper: data.bb_upper ?? 0,
        bb_lower: data.bb_lower ?? 0,
        ema_20: data.ema_20 ?? 0,
        ema_50: data.ema_50 ?? 0,
        ema_200: data.ema_200 ?? 0,
        atr: data.atr ?? 0,
        high: data.high ?? 0,
        low: data.low ?? 0,
        volume: data.volume ?? 0,
        volume_ma_20: data.volume_ma_20 ?? 0,
        entry_price: data.entry_price ?? 0
    };
}

function evaluateCondition(condition, data) {
    try {
        const c = buildContext(data);

        if (condition.includes('rsi <')) return c.rsi < parseFloat(condition.match(/[\d.]+/)[0]);
        if (condition.includes('rsi >')) return c.rsi > parseFloat(condition.match(/[\d.]+/)[0]);
        if (condition.includes('price <= bb_lower')) return c.price <= c.bb_lower;
        if (condition.includes('price >= bb_upper')) return c.price >= c.bb_upper;
        if (condition.includes('close > ema_200')) return c.close > c.ema_200;
        if (condition.includes('close < ema_200')) return c.close < c.ema_200;
        if (condition.includes('close >= ema_20')) return c.close >= c.ema_20;
        if (condition.includes('close <= ema_20')) return c.close <= c.ema_20;
        if (condition.includes('close > ema_50')) return c.close > c.ema_50;
        if (condition.includes('close < ema_50')) return c.close < c.ema_50;
        // La regola dice "volume > volume_ma_20": rispettala alla lettera.
        // Il codice precedente richiedeva di nascosto un +20%.
        if (condition.includes('volume > volume_ma_20')) return c.volume > c.volume_ma_20;
        if (condition.includes('volume < volume_ma_20')) return c.volume < c.volume_ma_20;
        if (condition.includes('price <= entry_price - (atr *')) {
            return c.price <= c.entry_price - (c.atr * parseFloat(condition.match(/atr \* ([\d.]+)/)[1]));
        }
        if (condition.includes('price >= entry_price + (atr *')) {
            return c.price >= c.entry_price + (c.atr * parseFloat(condition.match(/atr \* ([\d.]+)/)[1]));
        }

        logger.warn(`⚠️ Condizione non riconosciuta, ignorata: "${condition}"`);
        return false;
    } catch (e) {
        logger.error(`❌ Errore valutazione condizione "${condition}"`, e.message);
        return false;
    }
}

function extractValues(condition, data) {
    const keys = ['rsi', 'close', 'price', 'bb_upper', 'bb_lower', 'ema_20', 'ema_50',
                  'ema_200', 'atr', 'volume_ma_20', 'volume', 'entry_price'];
    const values = {};
    const ctx = buildContext(data);
    for (const key of keys) {
        if (condition.includes(key) && values[key] === undefined) {
            values[key] = typeof ctx[key] === 'number' ? Number(ctx[key].toFixed(4)) : ctx[key];
        }
    }
    return values;
}

// ==================== DIMENSIONAMENTO POSIZIONE ====================

function calculatePositionSize(marketData) {
    const riskPercent = rules.risk_management?.max_risk_per_trade_percent || 1.0;
    const atrMultiplier = rules.risk_management?.stop_loss_atr_multiplier || 1.5;

    // Rischia una percentuale dell'equity CORRENTE, non del capitale iniziale:
    // dopo una serie di perdite le size si riducono da sole.
    const riskAmount = state.equity * (riskPercent / 100);
    const stopDistance = marketData.atr * atrMultiplier;
    if (!(stopDistance > 0)) return { sizeUsd: 0, effectiveRiskPercent: 0, capped: false };

    const baseQty = (riskAmount / stopDistance) * CONFIG.leverage;
    let sizeUsd = baseQty * marketData.close;

    const capped = sizeUsd > CONFIG.maxTradeSize;
    if (capped) sizeUsd = CONFIG.maxTradeSize;

    // Il tetto MAX_TRADE_SIZE_USD riduce il rischio reale sotto la percentuale
    // dichiarata: rendilo esplicito invece di lasciarlo implicito.
    const effectiveRisk = (sizeUsd / marketData.close) * stopDistance;
    const effectiveRiskPercent = state.equity > 0 ? (effectiveRisk / state.equity) * 100 : 0;

    return { sizeUsd, effectiveRiskPercent, capped };
}

// ==================== SAFETY CHECK ====================

function evaluateSafetyCheck(marketData, tradeLimits) {
    const result = {
        passed: true,
        conditions: [],
        tradeSize: 0,
        action: 'NO_TRADE',
        reason: '',
        timestamp: new Date().toISOString(),
        symbol: marketData.symbol,
        price: marketData.close
    };

    const reject = (reason) => {
        result.passed = false;
        result.action = 'NO_TRADE';
        result.reason = reason;
        return result;
    };

    // 0. Indicatori affidabili? Con poche candele EMA200/ATR sono fallback
    //    inventati e genererebbero segnali senza senso.
    if (marketData.indicatorsReady === false) {
        return reject(`❌ Indicatori non pronti per ${marketData.symbol} (${marketData.candleCount} candele)`);
    }

    // 1. Drawdown: freno prima di tutto il resto.
    const dd = currentDrawdownPercent();
    if (dd >= CONFIG.maxDrawdown) {
        return reject(`🛑 Drawdown massimo raggiunto (${dd.toFixed(2)}% >= ${CONFIG.maxDrawdown}%) - trading sospeso`);
    }

    // 2. Limiti giornalieri (ora contano ordini eseguiti, non segnali generati).
    if (tradeLimits.tradesForSymbolToday >= CONFIG.maxTradesPerDayPerSymbol) {
        return reject(`❌ Limite giornaliero ${marketData.symbol} raggiunto (${tradeLimits.tradesForSymbolToday}/${CONFIG.maxTradesPerDayPerSymbol})`);
    }
    if (CONFIG.maxTradesPerDayTotal > 0 && tradeLimits.tradesTotalToday >= CONFIG.maxTradesPerDayTotal) {
        return reject(`❌ Limite giornaliero globale raggiunto (${tradeLimits.tradesTotalToday}/${CONFIG.maxTradesPerDayTotal})`);
    }

    // 3. Slot posizioni: globali e per simbolo.
    if (currentPositions.length >= CONFIG.maxPositions) {
        return reject(`❌ Massimo posizioni aperte (${currentPositions.length}/${CONFIG.maxPositions})`);
    }
    const openForSymbol = currentPositions.filter(p => p.symbol === marketData.symbol).length;
    if (openForSymbol >= CONFIG.maxPositionsPerSymbol) {
        return reject(`❌ ${marketData.symbol} ha gia' ${openForSymbol}/${CONFIG.maxPositionsPerSymbol} posizioni aperte`);
    }

    // 4. Punteggio regole di entrata.
    const scoreSide = (side) => {
        const sideRules = rules.entry_rules?.[side] || [];
        let score = 0;
        const details = sideRules.map(rule => {
            const passed = evaluateCondition(rule.condition, marketData);
            if (passed) score += (rule.weight || 1);
            return {
                id: rule.id, description: rule.description, condition: rule.condition,
                passed, weight: rule.weight || 1,
                actualValues: extractValues(rule.condition, marketData)
            };
        });
        const max = sideRules.reduce((sum, r) => sum + (r.weight || 1), 0);
        return { score, max, details };
    };

    const long = scoreSide('long');
    const short = scoreSide('short');
    result.conditions = [...long.details, ...short.details];

    const longThreshold = long.max * 0.6;
    const shortThreshold = short.max * 0.6;

    let direction = null;
    if (long.score >= longThreshold && long.score >= short.score) direction = 'long';
    else if (short.score >= shortThreshold && short.score > long.score) direction = 'short';

    if (!direction) {
        return reject(`⚠️ Nessun segnale (LONG ${long.score}/${long.max}, SHORT ${short.score}/${short.max})`);
    }

    // 5. Su spot non si puo' vendere allo scoperto: il codice precedente
    //    inviava comunque un market sell, che fallisce o liquida quello che hai.
    if (direction === 'short' && CONFIG.tradeMode === 'spot') {
        return reject(`⛔ Segnale SHORT su ${marketData.symbol} ignorato: TRADE_MODE=spot non permette vendite allo scoperto`);
    }

    // 6. Dimensionamento.
    const sizing = calculatePositionSize(marketData);
    if (sizing.sizeUsd < CONFIG.minNotionalUsd) {
        return reject(`❌ Size $${sizing.sizeUsd.toFixed(2)} sotto il minimo dell'exchange ($${CONFIG.minNotionalUsd})`);
    }

    result.action = direction === 'long' ? 'ENTER_LONG' : 'ENTER_SHORT';
    result.tradeSize = sizing.sizeUsd;
    result.effectiveRiskPercent = sizing.effectiveRiskPercent;
    result.reason = direction === 'long'
        ? `📈 Segnale LONG: ${long.score}/${long.max} condizioni`
        : `📉 Segnale SHORT: ${short.score}/${short.max} condizioni`;

    if (sizing.capped) {
        logger.info(`💰 ${marketData.symbol}: size limitata a $${CONFIG.maxTradeSize} - rischio reale ${sizing.effectiveRiskPercent.toFixed(3)}% invece di ${rules.risk_management?.max_risk_per_trade_percent}%`);
    }
    return result;
}

// ==================== SPECIFICHE SIMBOLI ====================
// Precisione e minimi reali dell'exchange: arrotondare a caso fa rifiutare
// gli ordini (o li fa passare con size sbagliata).

const symbolSpecs = new Map();

function defaultSpec() {
    return { basePrecision: 6, quotePrecision: 2, minTradeUsd: CONFIG.minNotionalUsd, minBaseQty: 0 };
}

async function loadSymbolSpecs() {
    if (CONFIG.dataSource === 'synthetic') return;
    try {
        const data = await bitGetRequest('GET', '/api/v2/spot/public/symbols', null, { signed: false });
        for (const s of data || []) {
            symbolSpecs.set(s.symbol, {
                basePrecision: parseInt(s.quantityPrecision ?? 6),
                quotePrecision: parseInt(s.quotePrecision ?? 2),
                minTradeUsd: parseFloat(s.minTradeUSDT ?? CONFIG.minNotionalUsd),
                minBaseQty: parseFloat(s.minTradeAmount ?? 0)
            });
        }
        logger.info(`📐 Specifiche caricate per ${symbolSpecs.size} simboli`);
    } catch (e) {
        logger.warn(`⚠️ Specifiche simboli non disponibili, uso i default: ${e.message}`);
    }
}

function specFor(symbol) {
    return symbolSpecs.get(symbol) || defaultSpec();
}

function roundDown(value, decimals) {
    const f = Math.pow(10, decimals);
    return Math.floor(value * f) / f;
}

// ==================== COSTI ====================

// Prezzo peggiorato dallo slippage, sempre a nostro sfavore.
function applySlippage(price, side) {
    const s = COSTS.slippagePercent / 100;
    return side === 'buy' ? price * (1 + s) : price * (1 - s);
}

function commissionOn(notionalUsd) {
    return Math.abs(notionalUsd) * (COSTS.commissionPercent / 100);
}

// ==================== PROTEZIONI SL/TP SULL'EXCHANGE ====================

async function placeProtectiveOrders(position) {
    const spec = specFor(position.symbol);
    const size = roundDown(position.baseQty, spec.basePrecision).toFixed(spec.basePrecision);
    const exitSide = position.side === 'long' ? 'sell' : 'buy';
    const ids = [];

    for (const [kind, triggerPrice] of [['STOP_LOSS', position.stopLoss], ['TAKE_PROFIT', position.takeProfit]]) {
        const body = {
            symbol: position.symbol,
            side: exitSide,
            orderType: 'market',
            planType: 'normal_plan',
            triggerType: 'fill_price',
            triggerPrice: String(roundDown(triggerPrice, spec.quotePrecision)),
            size,
            clientOid: `${kind === 'STOP_LOSS' ? 'SL' : 'TP'}-${position.id}`
        };
        const res = await bitGetRequest('POST', '/api/v2/spot/trade/place-plan-order', body);
        ids.push({ kind, orderId: res.orderId || res.planOrderId, clientOid: body.clientOid });
    }
    return ids;
}

// Restituisce true se TUTTI gli ordini di protezione risultano gia' spariti
// dall'exchange. In quel caso lo stop (o il take profit) e' verosimilmente gia'
// scattato e la posizione e' gia' chiusa: inviare un altro ordine market
// venderebbe una seconda volta, aprendo di fatto una posizione indesiderata.
async function cancelProtectiveOrders(position) {
    const protective = position.protectiveOrders || [];
    if (protective.length === 0) return false;

    let alreadyGone = 0;
    for (const p of protective) {
        try {
            await bitGetRequest('POST', '/api/v2/spot/trade/cancel-plan-order', {
                symbol: position.symbol, orderId: p.orderId
            });
        } catch (e) {
            logger.warn(`⚠️ Ordine ${p.kind} ${p.orderId} non annullabile: ${e.message}`);
            alreadyGone++;
        }
    }
    return alreadyGone === protective.length;
}

// ==================== ESECUZIONE TRADE ====================

async function executeTrade(action, marketData, sizeUsd) {
    const side = action === 'ENTER_LONG' ? 'long' : 'short';

    if (side === 'short' && CONFIG.tradeMode === 'spot') {
        logger.warn(`⛔ SHORT rifiutato su spot per ${marketData.symbol}`);
        return { success: false, error: 'short non supportato su spot' };
    }

    const spec = specFor(marketData.symbol);
    const entryPrice = applySlippage(marketData.close, side === 'long' ? 'buy' : 'sell');
    const baseQty = roundDown(sizeUsd / entryPrice, spec.basePrecision);
    const entryFee = commissionOn(baseQty * entryPrice);

    if (baseQty <= 0 || baseQty < spec.minBaseQty) {
        logger.warn(`⚠️ Quantita' ${baseQty} sotto il minimo per ${marketData.symbol}`);
        return { success: false, error: 'quantita sotto il minimo' };
    }

    const slMult = rules.risk_management?.stop_loss_atr_multiplier || 1.5;
    const tpMult = rules.risk_management?.take_profit_atr_multiplier || 3.0;
    const dir = side === 'long' ? 1 : -1;

    const position = {
        id: `${CONFIG.paperTrading ? 'PAPER' : 'LIVE'}-${marketData.symbol}-${Date.now()}`,
        symbol: marketData.symbol,
        side,
        entryPrice,
        baseQty,
        sizeUsd: baseQty * entryPrice,
        entryFee,
        openedAt: new Date().toISOString(),
        // SL/TP fissati all'apertura e MAI ricalcolati: prima venivano ridedotti
        // dall'ATR corrente a ogni controllo, quindi lo stop si spostava da solo.
        stopLoss: entryPrice - dir * (marketData.atr * slMult),
        takeProfit: entryPrice + dir * (marketData.atr * tpMult),
        protectiveOrders: []
    };

    try {
        if (CONFIG.paperTrading) {
            currentPositions.push(position);
            savePositions();
            recordFill(marketData.symbol);

            logger.trade(`📝 [PAPER] APERTURA ${side.toUpperCase()} ${marketData.symbol}`, {
                type: 'PAPER', symbol: marketData.symbol, action: `OPEN_${side.toUpperCase()}`,
                price: entryPrice.toFixed(4), sizeUsd: position.sizeUsd.toFixed(2),
                fee: entryFee.toFixed(4), net: (-entryFee).toFixed(4),
                status: 'FILLED', reason: `SL ${position.stopLoss.toFixed(2)} / TP ${position.takeProfit.toFixed(2)}`
            });
            return { success: true, simulated: true, position };
        }

        // --- LIVE ---
        // BitGet spot: per un market BUY il campo "size" e' l'importo in USDT
        // (valuta quote); per un market SELL e' la quantita' di base.
        // Il codice precedente inviava sempre quantita' base: gli acquisti
        // finivano con size sbagliata di ordini di grandezza.
        const isBuy = side === 'long';
        const body = {
            symbol: marketData.symbol,
            side: isBuy ? 'buy' : 'sell',
            orderType: 'market',
            force: 'gtc',
            size: isBuy
                ? String(roundDown(sizeUsd, spec.quotePrecision))
                : String(roundDown(baseQty, spec.basePrecision)),
            clientOid: `OPEN-${Date.now()}`   // BitGet v2 usa clientOid, non clientOrderId
        };

        const result = await bitGetRequest('POST', '/api/v2/spot/trade/place-order', body);
        position.id = result.orderId || position.id;
        position.orderId = result.orderId;

        // Le protezioni devono esistere sull'exchange PRIMA di considerare
        // la posizione aperta. Se non si riesce a piazzarle, si chiude subito:
        // meglio uscire in pari che restare esposti senza stop.
        try {
            position.protectiveOrders = await placeProtectiveOrders(position);
            logger.info(`🛡️ SL/TP piazzati sull'exchange per ${marketData.symbol}`);
        } catch (protErr) {
            logger.error(`🚨 SL/TP non piazzati per ${marketData.symbol}: ${protErr.message} - chiusura immediata`);
            await emergencyClose(position, marketData);
            return { success: false, error: `protezioni fallite: ${protErr.message}` };
        }

        currentPositions.push(position);
        savePositions();
        recordFill(marketData.symbol);

        logger.trade(`✅ [LIVE] APERTURA ${side.toUpperCase()} ${marketData.symbol}`, {
            type: 'LIVE', symbol: marketData.symbol, action: `OPEN_${side.toUpperCase()}`,
            price: entryPrice.toFixed(4), sizeUsd: position.sizeUsd.toFixed(2),
            fee: entryFee.toFixed(4), net: (-entryFee).toFixed(4),
            status: 'FILLED', reason: `SL ${position.stopLoss.toFixed(2)} / TP ${position.takeProfit.toFixed(2)}`
        });
        return { success: true, simulated: false, position };

    } catch (error) {
        logger.error(`❌ Errore apertura ${marketData.symbol}: ${error.message}`);
        return { success: false, error: error.message };
    }
}

async function emergencyClose(position, marketData) {
    try {
        const spec = specFor(position.symbol);
        await bitGetRequest('POST', '/api/v2/spot/trade/place-order', {
            symbol: position.symbol,
            side: position.side === 'long' ? 'sell' : 'buy',
            orderType: 'market',
            force: 'gtc',
            size: String(roundDown(position.baseQty, spec.basePrecision)),
            clientOid: `EMERGENCY-${Date.now()}`
        });
        logger.warn(`🚨 Posizione ${position.symbol} chiusa d'emergenza`);
    } catch (e) {
        logger.error(`🚨 CHIUSURA D'EMERGENZA FALLITA per ${position.symbol}: ${e.message} - INTERVENIRE A MANO`);
    }
}

// ==================== CHIUSURA POSIZIONI ====================

async function closePosition(position, marketData, reason = 'EXIT') {
    const dir = position.side === 'long' ? 1 : -1;
    const exitPrice = applySlippage(marketData.close, position.side === 'long' ? 'sell' : 'buy');
    const exitFee = commissionOn(position.baseQty * exitPrice);

    // PnL netto: prima veniva registrato il lordo, senza commissioni ne'
    // slippage, quindi il paper trading risultava sistematicamente migliore
    // della realta'.
    const grossPnl = (exitPrice - position.entryPrice) * position.baseQty * dir;
    const netPnl = grossPnl - (position.entryFee || 0) - exitFee;

    const finish = (type) => {
        const index = currentPositions.findIndex(p => p.id === position.id);
        if (index > -1) currentPositions.splice(index, 1);
        savePositions();
        applyRealizedPnl(netPnl);

        logger.trade(`${type === 'PAPER' ? '📝' : '✅'} [${type}] CHIUSURA ${position.side.toUpperCase()} ${position.symbol} - ${reason}`, {
            type, symbol: position.symbol, action: `CLOSE_${position.side.toUpperCase()}`,
            price: exitPrice.toFixed(4), sizeUsd: position.sizeUsd.toFixed(2),
            fee: ((position.entryFee || 0) + exitFee).toFixed(4), net: netPnl.toFixed(4),
            status: 'CLOSED', reason
        });
        logger.info(`   💵 PnL netto: $${netPnl.toFixed(2)} | Equity: $${state.equity.toFixed(2)} | DD: ${currentDrawdownPercent().toFixed(2)}%`);
        return { success: true, netPnl };
    };

    try {
        if (CONFIG.paperTrading) return finish('PAPER');

        const protectionsGone = await cancelProtectiveOrders(position);
        if (protectionsGone) {
            logger.warn(`⚠️ ${position.symbol}: le protezioni non esistono piu' sull'exchange, la posizione risulta gia' chiusa. Nessun nuovo ordine inviato.`);
            return finish('LIVE');
        }

        const spec = specFor(position.symbol);
        await bitGetRequest('POST', '/api/v2/spot/trade/place-order', {
            symbol: position.symbol,
            side: position.side === 'long' ? 'sell' : 'buy',
            orderType: 'market',
            force: 'gtc',
            // In chiusura vendiamo esattamente la quantita' base che abbiamo.
            size: String(roundDown(position.baseQty, spec.basePrecision)),
            clientOid: `CLOSE-${Date.now()}`
        });

        return finish('LIVE');
    } catch (error) {
        logger.error(`❌ Errore chiusura ${position.symbol}: ${error.message}`);
        return { success: false, error: error.message };
    }
}

// ==================== CONDIZIONI DI USCITA ====================

async function checkExitConditions(marketData) {
    const toClose = [];

    for (const position of currentPositions.filter(p => p.symbol === marketData.symbol)) {
        let reason = null;

        // 1. Stop loss / take profit memorizzati all'apertura.
        if (position.side === 'long') {
            if (marketData.low <= position.stopLoss) reason = 'Stop Loss';
            else if (marketData.high >= position.takeProfit) reason = 'Take Profit';
        } else {
            if (marketData.high >= position.stopLoss) reason = 'Stop Loss';
            else if (marketData.low <= position.takeProfit) reason = 'Take Profit';
        }

        // 2. Regole di uscita della strategia.
        if (!reason) {
            const exitRules = rules.exit_rules?.[position.side] || [];
            for (const rule of exitRules) {
                if (evaluateCondition(rule.condition, { ...marketData, entry_price: position.entryPrice })) {
                    reason = rule.description;
                    break;
                }
            }
        }

        if (reason) toClose.push({ position, reason });
    }

    for (const { position, reason } of toClose) {
        await closePosition(position, marketData, reason);
    }
    return toClose.length;
}

// ==================== BACKTEST ====================
// Prima esisteva lo script "npm run backtest" ma bot.js non leggeva
// process.argv: lanciava semplicemente il loop live. Nessuna strategia era
// quindi mai stata validata su dati storici.

function backtestSymbol(symbol, candles, opts) {
    const warmup = Math.max(250, (rules.indicators?.ema?.slow || 200) + 30);
    if (candles.length <= warmup + 10) {
        return { symbol, error: `servono almeno ${warmup + 10} candele, ricevute ${candles.length}` };
    }

    const slMult = rules.risk_management?.stop_loss_atr_multiplier || 1.5;
    const tpMult = rules.risk_management?.take_profit_atr_multiplier || 3.0;
    const riskPercent = rules.risk_management?.max_risk_per_trade_percent || 1.0;

    let equity = opts.initialCapital;
    let peak = equity;
    let maxDD = 0;
    let position = null;
    const trades = [];

    const closeAt = (price, reason, index) => {
        const dir = position.side === 'long' ? 1 : -1;
        const exitPrice = applySlippage(price, position.side === 'long' ? 'sell' : 'buy');
        const exitFee = commissionOn(position.baseQty * exitPrice);
        const gross = (exitPrice - position.entryPrice) * position.baseQty * dir;
        const net = gross - position.entryFee - exitFee;

        equity += net;
        if (equity > peak) peak = equity;
        maxDD = Math.max(maxDD, ((peak - equity) / peak) * 100);

        trades.push({
            side: position.side, entryPrice: position.entryPrice, exitPrice,
            net, gross, fees: position.entryFee + exitFee, reason,
            bars: index - position.openIndex
        });
        position = null;
    };

    for (let i = warmup; i < candles.length; i++) {
        const window = candles.slice(Math.max(0, i - 299), i + 1);
        const md = buildMarketData(window, symbol, opts.timeframe);
        if (!md.indicatorsReady) continue;

        const high = md.high, low = md.low;

        // 1. Gestione posizione aperta: prima SL/TP (intrabar), poi regole.
        if (position) {
            if (position.side === 'long') {
                // Ipotesi prudenziale: se una candela tocca sia SL che TP, si
                // assume che sia scattato prima lo stop.
                if (low <= position.stopLoss) { closeAt(position.stopLoss, 'Stop Loss', i); }
                else if (high >= position.takeProfit) { closeAt(position.takeProfit, 'Take Profit', i); }
            } else {
                if (high >= position.stopLoss) { closeAt(position.stopLoss, 'Stop Loss', i); }
                else if (low <= position.takeProfit) { closeAt(position.takeProfit, 'Take Profit', i); }
            }
        }
        if (position) {
            const exitRules = rules.exit_rules?.[position.side] || [];
            for (const rule of exitRules) {
                if (evaluateCondition(rule.condition, { ...md, entry_price: position.entryPrice })) {
                    closeAt(md.close, rule.description, i);
                    break;
                }
            }
        }

        // 2. Ingresso.
        if (!position && equity > 0) {
            const scoreSide = (side) => {
                const sideRules = rules.entry_rules?.[side] || [];
                let score = 0;
                for (const r of sideRules) if (evaluateCondition(r.condition, md)) score += (r.weight || 1);
                return { score, max: sideRules.reduce((s, r) => s + (r.weight || 1), 0) };
            };
            const long = scoreSide('long');
            const short = scoreSide('short');

            let side = null;
            if (long.score >= long.max * 0.6 && long.score >= short.score) side = 'long';
            else if (short.score >= short.max * 0.6 && short.score > long.score) side = 'short';
            if (side === 'short' && opts.tradeMode === 'spot') side = null;

            if (side) {
                const stopDistance = md.atr * slMult;
                const riskAmount = equity * (riskPercent / 100);
                if (stopDistance > 0) {
                    const dir = side === 'long' ? 1 : -1;
                    const entryPrice = applySlippage(md.close, side === 'long' ? 'buy' : 'sell');
                    let sizeUsd = Math.min((riskAmount / stopDistance) * entryPrice, opts.maxTradeSize);
                    if (sizeUsd >= CONFIG.minNotionalUsd) {
                        const baseQty = sizeUsd / entryPrice;
                        position = {
                            side, entryPrice, baseQty, openIndex: i,
                            entryFee: commissionOn(baseQty * entryPrice),
                            stopLoss: entryPrice - dir * stopDistance,
                            takeProfit: entryPrice + dir * (md.atr * tpMult)
                        };
                    }
                }
            }
        }
    }

    const wins = trades.filter(t => t.net > 0);
    const losses = trades.filter(t => t.net <= 0);
    const grossWin = wins.reduce((s, t) => s + t.net, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.net, 0));

    return {
        symbol,
        trades: trades.length,
        wins: wins.length,
        losses: losses.length,
        winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
        netPnl: equity - opts.initialCapital,
        returnPercent: ((equity - opts.initialCapital) / opts.initialCapital) * 100,
        totalFees: trades.reduce((s, t) => s + t.fees, 0),
        profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
        maxDrawdownPercent: maxDD,
        finalEquity: equity
    };
}

async function loadBacktestCandles(symbol) {
    const dataFile = flagValue('--data');
    if (dataFile) {
        const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
        const candles = Array.isArray(raw) ? raw : raw[symbol];
        if (!candles) throw new Error(`Nessuna candela per ${symbol} in ${dataFile}`);
        return candles;
    }
    if (CONFIG.dataSource === 'synthetic') {
        return syntheticCandles(symbol, parseInt(flagValue('--bars', '1500')));
    }
    return await fetchCandles(symbol, CONFIG.timeframe, 1000);
}

async function runBacktest() {
    const usingSynthetic = !flagValue('--data') && CONFIG.dataSource === 'synthetic';

    logger.info('🧪 BACKTEST - Strategia: ' + rules.name);
    if (usingSynthetic) {
        logger.warn('⚠️ ATTENZIONE: dati SINTETICI, non prezzi reali.');
        logger.warn('⚠️ Questo verifica solo che il motore funzioni. NON e\' una misura di redditivita\'.');
        logger.warn('⚠️ Per un backtest valido servono candele reali: --data candles.json');
    }

    const opts = {
        initialCapital: rules.backtest?.initial_capital || CONFIG.portfolioValue,
        maxTradeSize: CONFIG.maxTradeSize,
        tradeMode: CONFIG.tradeMode,
        timeframe: CONFIG.timeframe
    };

    const results = [];
    for (const symbol of CONFIG.symbols) {
        try {
            const candles = await loadBacktestCandles(symbol);
            const r = backtestSymbol(symbol, candles, opts);
            results.push(r);
        } catch (e) {
            results.push({ symbol, error: e.message });
        }
    }

    console.log('\n' + '='.repeat(78));
    console.log(`RISULTATI BACKTEST${usingSynthetic ? ' (DATI SINTETICI - NON REALI)' : ''}`);
    console.log(`Capitale iniziale per simbolo: $${opts.initialCapital} | Commissione ${COSTS.commissionPercent}% | Slippage ${COSTS.slippagePercent}%`);
    console.log('='.repeat(78));
    console.log('Simbolo    Trade   Win%    PnL netto   Rendim.   ProfitFactor   MaxDD');
    console.log('-'.repeat(78));

    for (const r of results) {
        if (r.error) {
            console.log(`${r.symbol.padEnd(10)} ERRORE: ${r.error}`);
            continue;
        }
        const pf = r.profitFactor === Infinity ? 'inf' : r.profitFactor.toFixed(2);
        console.log(
            r.symbol.padEnd(10) +
            String(r.trades).padEnd(8) +
            (r.winRate.toFixed(1) + '%').padEnd(8) +
            ('$' + r.netPnl.toFixed(2)).padEnd(12) +
            (r.returnPercent.toFixed(2) + '%').padEnd(10) +
            pf.padEnd(15) +
            r.maxDrawdownPercent.toFixed(2) + '%'
        );
    }
    console.log('='.repeat(78));

    const ok = results.filter(r => !r.error);
    const totalTrades = ok.reduce((s, r) => s + r.trades, 0);
    const totalPnl = ok.reduce((s, r) => s + r.netPnl, 0);
    const totalFees = ok.reduce((s, r) => s + r.totalFees, 0);
    console.log(`TOTALE: ${totalTrades} trade | PnL netto $${totalPnl.toFixed(2)} | Commissioni pagate $${totalFees.toFixed(2)}`);
    if (usingSynthetic) {
        console.log('\n⚠️  Numeri ottenuti su dati sintetici. Non predicono alcun risultato reale.');
    }
    console.log('');

    fs.writeFileSync('backtest-results.json', JSON.stringify({
        generatedAt: new Date().toISOString(),
        syntheticData: usingSynthetic,
        strategy: rules.name,
        costs: COSTS,
        options: opts,
        results
    }, null, 2));
    logger.info('💾 Risultati salvati in backtest-results.json');
    return results;
}

// ==================== WEBHOOK SERVER ====================

function saveSafetyLog(result) {
    let logs = [];
    try {
        if (fs.existsSync(CONFIG.safetyLogFile)) logs = JSON.parse(fs.readFileSync(CONFIG.safetyLogFile, 'utf8'));
    } catch (e) {
        logs = [];
    }
    logs.push(result);
    // Senza tetto il file cresceva all'infinito.
    if (logs.length > 2000) logs = logs.slice(-2000);
    fs.writeFileSync(CONFIG.safetyLogFile, JSON.stringify(logs, null, 2));
}

function startWebhookServer() {
    if (!CONFIG.webhookEnabled) {
        logger.info('🌐 Webhook disabilitato (WEBHOOK_ENABLED=false)');
        return null;
    }
    // Un webhook che apre ordini senza autenticazione significa che chiunque
    // raggiunga la porta puo' far operare il bot con i tuoi soldi.
    if (!CONFIG.webhookToken && !CONFIG.paperTrading) {
        logger.error('🚨 WEBHOOK_TOKEN non impostato in modalita LIVE: webhook non avviato');
        return null;
    }
    if (!CONFIG.webhookToken) {
        logger.warn('⚠️ WEBHOOK_TOKEN non impostato: webhook aperto (accettabile solo in paper trading)');
    }

    const server = createServer((req, res) => {
        const reply = (code, payload) => {
            res.writeHead(code, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(payload));
        };

        if (req.url !== CONFIG.webhookPath || req.method !== 'POST') return reply(404, { status: 'NOT_FOUND' });

        if (CONFIG.webhookToken) {
            const provided = req.headers['x-webhook-token'];
            if (provided !== CONFIG.webhookToken) {
                logger.warn('🚫 Webhook rifiutato: token non valido');
                return reply(401, { status: 'UNAUTHORIZED' });
            }
        }

        let body = '';
        req.on('data', chunk => {
            body += chunk;
            if (body.length > 64 * 1024) req.destroy();   // limite anti-abuso
        });
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const symbol = (data.ticker || data.symbol || CONFIG.symbols[0]).toUpperCase();

                if (!CONFIG.symbols.includes(symbol)) {
                    logger.warn(`🚫 Webhook per simbolo non configurato: ${symbol}`);
                    return reply(400, { status: 'SYMBOL_NOT_ALLOWED', symbol });
                }

                logger.info(`📨 Webhook ricevuto per ${symbol}`, data);
                const outcome = await processSymbol(symbol);
                reply(200, { status: 'OK', symbol, action: outcome.action, reason: outcome.reason });
            } catch (error) {
                logger.error('❌ Errore webhook', error.message);
                reply(500, { status: 'ERROR', message: error.message });
            }
        });
    });

    server.listen(CONFIG.webhookPort, () => {
        logger.info(`🌐 Webhook in ascolto su :${CONFIG.webhookPort}${CONFIG.webhookPath}${CONFIG.webhookToken ? ' (autenticato)' : ''}`);
    });
    return server;
}

// ==================== CICLO PER SIMBOLO ====================

async function processSymbol(symbol) {
    const marketData = await getMarketData(symbol, CONFIG.timeframe);

    logger.debug(`📊 ${symbol}: $${marketData.close.toFixed(2)} | RSI ${marketData.rsi.toFixed(1)} | BB ${marketData.bb_lower.toFixed(0)}-${marketData.bb_upper.toFixed(0)} | EMA20 ${marketData.ema_20.toFixed(0)} | ATR ${marketData.atr.toFixed(2)}`);

    const closed = await checkExitConditions(marketData);

    const limits = getTradeLimits(symbol);
    const safety = evaluateSafetyCheck(marketData, limits);
    saveSafetyLog(safety);

    if (safety.passed && safety.action !== 'NO_TRADE') {
        logger.info(`${safety.reason} su ${symbol}`);
        await executeTrade(safety.action, marketData, safety.tradeSize);
    } else {
        logger.debug(`${symbol}: ${safety.reason}`);
    }

    return { action: safety.action, reason: safety.reason, closed };
}

async function runCycle(cycleCount) {
    logger.info(`🔄 Ciclo ${cycleCount} - ${moment().format('HH:mm:ss')} - ${CONFIG.symbols.length} simboli`);

    for (const symbol of CONFIG.symbols) {
        try {
            await processSymbol(symbol);
        } catch (error) {
            // Un simbolo che fallisce non deve fermare gli altri: prima un
            // singolo errore interrompeva l'intero ciclo.
            logger.error(`❌ ${symbol}: ${error.message}`);
        }
    }

    if (currentPositions.length > 0) {
        logger.info(`📊 Posizioni aperte: ${currentPositions.length}/${CONFIG.maxPositions}`);
        for (const p of currentPositions) {
            logger.info(`   ${p.side.toUpperCase()} ${p.symbol} @ $${p.entryPrice.toFixed(2)} | SL $${p.stopLoss.toFixed(2)} | TP $${p.takeProfit.toFixed(2)}`);
        }
    }
    logger.info(`💰 Equity $${state.equity.toFixed(2)} | PnL realizzato $${state.realizedPnl.toFixed(2)} | DD ${currentDrawdownPercent().toFixed(2)}%`);
}

// ==================== SELF-TEST ====================

function runSelfTest() {
    let passed = 0, failed = 0;
    const check = (name, condition, detail = '') => {
        if (condition) { console.log(`  ✅ ${name}`); passed++; }
        else { console.log(`  ❌ ${name} ${detail}`); failed++; }
    };

    console.log('\n=== SELF-TEST ===\n');

    console.log('Indicatori:');
    const flat = Array.from({ length: 300 }, () => 100);
    check('RSI su serie piatta ~50', Math.abs(calculateRSI(flat)[0] - 50) < 1);
    const rising = Array.from({ length: 300 }, (_, i) => 100 + i);
    check('RSI su trend rialzista > 90', calculateRSI(rising).slice(-1)[0] > 90);
    check('EMA20 su serie piatta = 100', Math.abs(last(calculateEMA(flat, 20), 0) - 100) < 0.01);

    // Regressione del bug principale: ema_20 deve essere l'ULTIMO valore della
    // sua serie, non un valore indicizzato con la lunghezza di ema_200.
    console.log('\nRegressione indice EMA:');
    const candles = rising.map((c, i) => [String(i), c, c + 1, c - 1, c, 1000]);
    const md = buildMarketData(candles, 'TEST', '1h');
    const expectedEma20 = last(calculateEMA(rising, 20), 0);
    check('ema_20 e\' il valore corrente', Math.abs(md.ema_20 - expectedEma20) < 0.01,
          `(atteso ${expectedEma20.toFixed(2)}, ottenuto ${md.ema_20.toFixed(2)})`);
    check('ema_20 > ema_50 > ema_200 in trend rialzista',
          md.ema_20 > md.ema_50 && md.ema_50 > md.ema_200,
          `(${md.ema_20.toFixed(0)}, ${md.ema_50.toFixed(0)}, ${md.ema_200.toFixed(0)})`);

    console.log('\nCosti:');
    check('slippage in acquisto peggiora il prezzo', applySlippage(100, 'buy') > 100);
    check('slippage in vendita peggiora il prezzo', applySlippage(100, 'sell') < 100);
    check('commissione calcolata sul nozionale', Math.abs(commissionOn(1000) - 1) < 0.0001);

    console.log('\nSafety check:');
    const savedPositions = [...currentPositions];
    const savedMode = CONFIG.tradeMode;
    currentPositions = [];

    const base = {
        symbol: 'BTCUSDT', close: 95000, rsi: 22, bb_lower: 96000, bb_upper: 105000,
        ema_20: 99000, ema_50: 100000, ema_200: 90000, atr: 1200,
        volume: 5000, volume_ma_20: 3000, high: 95500, low: 94500, indicatorsReady: true
    };
    const longSignal = evaluateSafetyCheck(base, { tradesForSymbolToday: 0, tradesTotalToday: 0 });
    check('segnale LONG in ipervenduto', longSignal.action === 'ENTER_LONG', longSignal.reason);

    const shortData = { ...base, close: 110000, rsi: 78, bb_upper: 109000, bb_lower: 100000, ema_200: 115000, high: 110500, low: 109500 };
    CONFIG.tradeMode = 'spot';
    const shortOnSpot = evaluateSafetyCheck(shortData, { tradesForSymbolToday: 0, tradesTotalToday: 0 });
    check('SHORT bloccato su spot', shortOnSpot.action === 'NO_TRADE' && shortOnSpot.reason.includes('spot'), shortOnSpot.reason);

    CONFIG.tradeMode = 'futures';
    const shortOnFutures = evaluateSafetyCheck(shortData, { tradesForSymbolToday: 0, tradesTotalToday: 0 });
    check('SHORT permesso su futures', shortOnFutures.action === 'ENTER_SHORT', shortOnFutures.reason);
    CONFIG.tradeMode = savedMode;

    const limitHit = evaluateSafetyCheck(base, { tradesForSymbolToday: 99, tradesTotalToday: 99 });
    check('limite giornaliero per simbolo rispettato', limitHit.action === 'NO_TRADE');

    const notReady = evaluateSafetyCheck({ ...base, indicatorsReady: false, candleCount: 30 }, { tradesForSymbolToday: 0, tradesTotalToday: 0 });
    check('nessun segnale con indicatori non pronti', notReady.action === 'NO_TRADE');

    console.log('\nDrawdown:');
    const savedState = JSON.parse(JSON.stringify(state));
    state = DEFAULT_STATE();
    state.equity = 1000; state.peakEquity = 1000;
    applyRealizedPnl(-200);
    check('drawdown calcolato dopo una perdita', Math.abs(currentDrawdownPercent() - 20) < 0.01,
          `(${currentDrawdownPercent().toFixed(2)}%)`);
    const blocked = evaluateSafetyCheck(base, { tradesForSymbolToday: 0, tradesTotalToday: 0 });
    check('trading sospeso oltre il drawdown massimo', blocked.action === 'NO_TRADE' && blocked.reason.includes('Drawdown'), blocked.reason);
    state = savedState;
    currentPositions = savedPositions;
    saveState();

    console.log(`\n=== ${passed} superati, ${failed} falliti ===\n`);
    return failed === 0;
}

// ==================== MAIN ====================

async function main() {
    logger.info('🚀 Avvio bot AKRAM Trading v3.0');

    if (!loadRules()) {
        logger.error('❌ Impossibile caricare rules.json. Uscita.');
        process.exit(1);
    }

    if (RUN_MODE === 'test') {
        process.exit(runSelfTest() ? 0 : 1);
    }

    logger.info(`📊 Simboli: ${CONFIG.symbols.join(', ')} | Timeframe: ${CONFIG.timeframe}`);
    logger.info(`📈 Modalita': ${CONFIG.paperTrading ? 'PAPER (simulazione)' : '🔴 LIVE (denaro reale)'} | Mercato: ${CONFIG.tradeMode}`);
    logger.info(`💰 Equity iniziale: $${CONFIG.portfolioValue} | Max per trade: $${CONFIG.maxTradeSize}`);
    logger.info(`📊 Max posizioni: ${CONFIG.maxPositions} (max ${CONFIG.maxPositionsPerSymbol} per simbolo)`);
    logger.info(`💸 Costi applicati: commissione ${COSTS.commissionPercent}% + slippage ${COSTS.slippagePercent}%`);
    logger.info(`🗄️ Sorgente dati: ${CONFIG.dataSource}${CONFIG.dataSource === 'synthetic' ? ' ⚠️ SINTETICA - NON PREZZI REALI' : ''}`);

    if (!CONFIG.paperTrading) {
        if (!CONFIG.apiKey || !CONFIG.secretKey || !CONFIG.passphrase) {
            logger.error('❌ Modalita LIVE senza credenziali BitGet complete. Uscita.');
            process.exit(1);
        }
        if (CONFIG.dataSource === 'synthetic') {
            logger.error('❌ Modalita LIVE con dati sintetici: rifiuto di operare su prezzi finti. Uscita.');
            process.exit(1);
        }
        logger.warn('🔴 TRADING LIVE ATTIVO - il bot operera con denaro reale');
    }

    loadState();
    loadPositions();

    if (RUN_MODE === 'backtest') {
        await runBacktest();
        process.exit(0);
    }

    await loadSymbolSpecs();
    if (RUN_MODE !== 'once') startWebhookServer();

    let cycleCount = 0;
    const tick = async () => {
        cycleCount++;
        try {
            await runCycle(cycleCount);
        } catch (e) {
            logger.error('❌ Errore nel ciclo principale', e.message);
        }
    };

    // Primo ciclo subito: prima si aspettava un minuto senza fare nulla.
    await tick();

    if (RUN_MODE === 'once') {
        logger.info('✅ Ciclo singolo completato (--once)');
        process.exit(0);
    }

    setInterval(tick, CONFIG.cycleIntervalMs);
    logger.info(`✅ Bot avviato. Ciclo ogni ${CONFIG.cycleIntervalMs / 1000}s.`);
}

// ==================== ARRESTO ====================

let shuttingDown = false;
function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`🛑 Arresto bot (${signal})...`);
    savePositions();
    saveState();
    if (currentPositions.length > 0 && !CONFIG.paperTrading) {
        logger.warn(`⚠️ ${currentPositions.length} posizioni restano aperte sull'exchange, protette dagli ordini SL/TP.`);
    }
    process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch(error => {
    logger.error('❌ Errore fatale', error.message);
    console.error(error);
    process.exit(1);
});

// ==================== ESPORTAZIONI ====================

export {
    main, getMarketData, evaluateSafetyCheck, executeTrade, closePosition,
    loadRules, currentPositions, buildMarketData, backtestSymbol,
    syntheticCandles, calculateEMA, calculateRSI, CONFIG
};
