// ============================================
// BOT A.K.R.A.M. TRADING v2.0
// Motore di trading automatico per TradingView + BitGet
// Basato su claude-tradingview-mcp-trading
// Integra ccxt, freqtrade e best practices
// ============================================

import dotenv from 'dotenv';
import fs from 'fs';
import crypto from 'crypto';
import fetch from 'node-fetch';
import { createServer } from 'http';
import moment from 'moment';

dotenv.config();

// ==================== CONFIGURAZIONE ====================

const CONFIG = {
    exchange: process.env.EXCHANGE || 'bitget',
    apiKey: process.env.BITGET_API_KEY,
    secretKey: process.env.BITGET_SECRET_KEY,
    passphrase: process.env.BITGET_PASSPHRASE,
    portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD) || 1000,
    maxTradeSize: parseFloat(process.env.MAX_TRADE_SIZE_USD) || 50,
    maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY) || 3,
    maxPositions: parseInt(process.env.MAX_POSITIONS) || 2,
    maxDrawdown: parseFloat(process.env.MAX_DRAWDOWN_PERCENT) || 20,
    symbol: process.env.SYMBOL || 'BTCUSDT',
    timeframe: process.env.TIMEFRAME || '1h',
    paperTrading: process.env.PAPER_TRADING === 'true',
    tradeMode: process.env.TRADE_MODE || 'spot',
    leverage: parseInt(process.env.LEVERAGE) || 1,
    mcpPort: parseInt(process.env.MCP_SERVER_PORT) || 9222,
    mcpHost: process.env.MCP_HOST || 'localhost',
    webhookPort: parseInt(process.env.WEBHOOK_PORT) || 3000,
    webhookPath: process.env.WEBHOOK_PATH || '/webhook',
    logLevel: process.env.LOG_LEVEL || 'info',
    logFile: process.env.LOG_FILE || 'bot.log',
    tradesFile: process.env.TRADES_FILE || 'trades.csv',
    safetyLogFile: process.env.SAFETY_LOG_FILE || 'safety-check-log.json'
};

// ==================== SISTEMA DI LOGGING AVANZATO ====================

class Logger {
    constructor() {
        this.levels = {
            error: 0,
            warn: 1,
            info: 2,
            debug: 3,
            trade: 4
        };
        this.level = CONFIG.logLevel;
        this.logFile = CONFIG.logFile;
        this.tradesFile = CONFIG.tradesFile;

        // Inizializza file di log se non esistono
        if (!fs.existsSync(this.logFile)) {
            fs.writeFileSync(this.logFile, '');
        }
        if (!fs.existsSync(this.tradesFile)) {
            fs.writeFileSync(this.tradesFile, 'Timestamp,Type,Symbol,Action,Price,Size,Fee,Net,Status\n');
        }
    }

    log(message, type = 'info', data = null) {
        const timestamp = moment().format('YYYY-MM-DD HH:mm:ss.SSS');
        const logEntry = {
            timestamp,
            type: type.toUpperCase(),
            message,
            data: data || null
        };

        // Log a console
        const colorMap = {
            error: '\x1b[31m',
            warn: '\x1b[33m',
            info: '\x1b[36m',
            debug: '\x1b[35m',
            trade: '\x1b[32m'
        };
        const color = colorMap[type] || '\x1b[0m';
        console.log(`${color}[${timestamp}] [${type.toUpperCase()}] ${message}\x1b[0m`);

        // Log a file
        fs.appendFileSync(this.logFile, `[${timestamp}] [${type.toUpperCase()}] ${message}${data ? ' | ' + JSON.stringify(data) : ''}\n`);

        // Log trade separato
        if (type === 'trade') {
            const tradeLine = `${timestamp},${data.type || 'PAPER'},${data.symbol || ''},${data.action || ''},${data.price || 0},${data.size || 0},${data.fee || 0},${data.net || 0},${data.status || 'OK'}\n`;
            fs.appendFileSync(this.tradesFile, tradeLine);
        }
    }

    error(message, data = null) { this.log(message, 'error', data); }
    warn(message, data = null) { this.log(message, 'warn', data); }
    info(message, data = null) { this.log(message, 'info', data); }
    debug(message, data = null) { this.log(message, 'debug', data); }
    trade(message, data = null) { this.log(message, 'trade', data); }
}

const logger = new Logger();

// ==================== CARICAMENTO STRATEGIA ====================

let rules = {};
let currentPositions = [];

function loadRules() {
    try {
        const raw = fs.readFileSync('rules.json', 'utf8');
        rules = JSON.parse(raw);
        logger.info('✅ Strategia caricata da rules.json', { name: rules.name, version: rules.version });
        return true;
    } catch (e) {
        logger.error('❌ Errore caricamento rules.json', e.message);
        return false;
    }
}

function loadPositions() {
    try {
        if (fs.existsSync('positions.json')) {
            const raw = fs.readFileSync('positions.json', 'utf8');
            currentPositions = JSON.parse(raw);
            logger.info(`📊 Caricate ${currentPositions.length} posizioni aperte`);
        }
    } catch (e) {
        logger.warn('⚠️ Nessuna posizione aperta trovata');
        currentPositions = [];
    }
}

function savePositions() {
    fs.writeFileSync('positions.json', JSON.stringify(currentPositions, null, 2));
}

// ==================== API BITGET ====================

function signBitGet(timestamp, method, requestPath, body = '') {
    const message = timestamp + method + requestPath + body;
    const hmac = crypto.createHmac('sha256', CONFIG.secretKey);
    const signature = hmac.update(message).digest('base64');
    return signature;
}

async function bitGetRequest(method, endpoint, body = null) {
    const timestamp = Date.now().toString();
    const requestPath = endpoint;
    const bodyStr = body ? JSON.stringify(body) : '';

    const signature = signBitGet(timestamp, method, requestPath, bodyStr);

    const headers = {
        'ACCESS-KEY': CONFIG.apiKey,
        'ACCESS-SIGN': signature,
        'ACCESS-TIMESTAMP': timestamp,
        'ACCESS-PASSPHRASE': CONFIG.passphrase,
        'Content-Type': 'application/json'
    };

    const url = `https://api.bitget.com${endpoint}`;

    try {
        const fetchOptions = { method, headers };
        if (bodyStr) fetchOptions.body = bodyStr;
        const response = await fetch(url, fetchOptions);
        const data = await response.json();

        if (data.code !== '00000') {
            logger.error(`❌ Errore API BitGet: ${data.msg}`, { code: data.code });
            throw new Error(`BitGet API error: ${data.msg}`);
        }

        return data.data;
    } catch (error) {
        logger.error('❌ Errore richiesta BitGet', error.message);
        throw error;
    }
}

// ==================== INDICATORI TECNICI ====================

function calculateRSI(closes, period = 14) {
    if (closes.length < period + 1) return [];

    let gains = 0, losses = 0;
    const rsi = [];

    // Prima media
    for (let i = 1; i <= period; i++) {
        const diff = closes[i] - closes[i-1];
        if (diff >= 0) gains += diff;
        else losses += Math.abs(diff);
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;
    rsi.push(100 - (100 / (1 + avgGain / (avgLoss || 0.001))));

    // Smoothing
    for (let i = period + 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i-1];
        if (diff >= 0) {
            avgGain = (avgGain * (period - 1) + diff) / period;
            avgLoss = (avgLoss * (period - 1)) / period;
        } else {
            avgGain = (avgGain * (period - 1)) / period;
            avgLoss = (avgLoss * (period - 1) + Math.abs(diff)) / period;
        }
        rsi.push(100 - (100 / (1 + avgGain / (avgLoss || 0.001))));
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

    // Prima EMA = SMA
    let sum = 0;
    for (let i = 0; i < period; i++) {
        sum += closes[i];
    }
    ema.push(sum / period);

    // EMA successiva
    for (let i = period; i < closes.length; i++) {
        ema.push((closes[i] - ema[ema.length - 1]) * multiplier + ema[ema.length - 1]);
    }

    return ema;
}

function calculateATR(highs, lows, closes, period = 14) {
    if (highs.length < period + 1) return [];

    const tr = [];
    const atr = [];

    // True Range
    for (let i = 1; i < highs.length; i++) {
        const hl = highs[i] - lows[i];
        const hc = Math.abs(highs[i] - closes[i-1]);
        const lc = Math.abs(lows[i] - closes[i-1]);
        tr.push(Math.max(hl, hc, lc));
    }

    // Prima ATR = SMA
    let sum = 0;
    for (let i = 0; i < period; i++) {
        sum += tr[i];
    }
    atr.push(sum / period);

    // ATR successiva
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

// ==================== MARKET DATA ====================

async function getMarketData(symbol, timeframe) {
    // Prima prova MCP (TradingView)
    try {
        const mcpData = await getDataFromMCP(symbol, timeframe);
        if (mcpData) {
            logger.debug('📊 Dati ottenuti da MCP', { symbol, timeframe });
            return mcpData;
        }
    } catch (e) {
        logger.debug('⚠️ MCP non disponibile, uso API BitGet');
    }

    // Fallback: API BitGet
    const granularity = timeframeToGranularity(timeframe);
    const endpoint = `/api/v2/spot/market/candles?symbol=${symbol}&granularity=${granularity}&limit=500`;
    const data = await bitGetRequest('GET', endpoint);

    if (!data || data.length === 0) {
        throw new Error('Nessun dato ricevuto da BitGet');
    }

    return processCandles(data, symbol, timeframe);
}

function timeframeToGranularity(timeframe) {
    const map = {
        '1m': '60',
        '5m': '300',
        '15m': '900',
        '30m': '1800',
        '1h': '3600',
        '4h': '14400',
        '1d': '86400',
        '1w': '604800'
    };
    return map[timeframe] || '3600';
}

function processCandles(candleData, symbol, timeframe) {
    // Estrai dati OHLCV
    const opens = candleData.map(c => parseFloat(c[1]));
    const highs = candleData.map(c => parseFloat(c[2]));
    const lows = candleData.map(c => parseFloat(c[3]));
    const closes = candleData.map(c => parseFloat(c[4]));
    const volumes = candleData.map(c => parseFloat(c[5]));

    const currentPrice = closes[closes.length - 1];
    const currentHigh = highs[highs.length - 1];
    const currentLow = lows[lows.length - 1];
    const currentVolume = volumes[volumes.length - 1];

    // Calcola indicatori
    const rsi = calculateRSI(closes, rules.indicators?.rsi?.length || 14);
    const bb = calculateBB(closes, rules.indicators?.bollinger_bands?.length || 20, rules.indicators?.bollinger_bands?.stddev || 2.0);
    const ema20 = calculateEMA(closes, rules.indicators?.ema?.fast || 20);
    const ema50 = calculateEMA(closes, rules.indicators?.ema?.medium || 50);
    const ema200 = calculateEMA(closes, rules.indicators?.ema?.slow || 200);
    const atr = calculateATR(highs, lows, closes, rules.indicators?.atr?.length || 14);
    const volumeMA = calculateSMA(volumes, rules.indicators?.volume?.ma_length || 20);

    // Prendi gli ultimi valori
    const idx = closes.length - 1;
    const bbIdx = bb.upper.length - 1;
    const emaIdx = ema200.length - 1;
    const atrIdx = atr.length - 1;
    const volIdx = volumeMA.length - 1;

    return {
        symbol,
        timeframe,
        timestamp: new Date().toISOString(),
        open: opens[idx],
        high: currentHigh,
        low: currentLow,
        close: currentPrice,
        volume: currentVolume,
        rsi: rsi.length > 0 ? rsi[rsi.length - 1] : 50,
        bb_upper: bb.upper.length > 0 ? bb.upper[bbIdx] : currentPrice * 1.02,
        bb_middle: bb.middle.length > 0 ? bb.middle[bbIdx] : currentPrice,
        bb_lower: bb.lower.length > 0 ? bb.lower[bbIdx] : currentPrice * 0.98,
        ema_20: ema20.length > 0 ? ema20[emaIdx] : currentPrice,
        ema_50: ema50.length > 0 ? ema50[emaIdx] : currentPrice,
        ema_200: ema200.length > 0 ? ema200[emaIdx] : currentPrice,
        atr: atr.length > 0 ? atr[atrIdx] : currentPrice * 0.01,
        volume_ma_20: volumeMA.length > 0 ? volumeMA[volIdx] : currentVolume,
        closes: closes.slice(-50),
        highs: highs.slice(-50),
        lows: lows.slice(-50),
        volumes: volumes.slice(-50)
    };
}

// ==================== MCP INTEGRAZIONE ====================

async function getDataFromMCP(symbol, timeframe) {
    try {
        const response = await fetch(`http://${CONFIG.mcpHost}:${CONFIG.mcpPort}/chart-data`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbol, timeframe }),
            timeout: 5000
        });

        if (!response.ok) return null;
        return await response.json();
    } catch (e) {
        return null;
    }
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

    // 1. Controlla limite giornaliero
    if (tradeLimits.tradesExecutedToday >= CONFIG.maxTradesPerDay) {
        result.passed = false;
        result.reason = `❌ Limite giornaliero raggiunto (${CONFIG.maxTradesPerDay}/${CONFIG.maxTradesPerDay})`;
        return result;
    }

    // 2. Controlla massimo posizioni aperte
    if (currentPositions.length >= CONFIG.maxPositions) {
        result.passed = false;
        result.reason = `❌ Massimo posizioni aperte (${currentPositions.length}/${CONFIG.maxPositions})`;
        return result;
    }

    // 3. Valuta regole di entrata LONG
    let longScore = 0;
    const longRules = rules.entry_rules?.long || [];
    const longResults = [];

    for (const rule of longRules) {
        const conditionMet = evaluateCondition(rule.condition, marketData);
        longResults.push({
            id: rule.id,
            description: rule.description,
            condition: rule.condition,
            passed: conditionMet,
            weight: rule.weight || 1,
            actualValues: extractValues(rule.condition, marketData)
        });
        if (conditionMet) longScore += (rule.weight || 1);
    }

    // 4. Valuta regole di entrata SHORT
    let shortScore = 0;
    const shortRules = rules.entry_rules?.short || [];
    const shortResults = [];

    for (const rule of shortRules) {
        const conditionMet = evaluateCondition(rule.condition, marketData);
        shortResults.push({
            id: rule.id,
            description: rule.description,
            condition: rule.condition,
            passed: conditionMet,
            weight: rule.weight || 1,
            actualValues: extractValues(rule.condition, marketData)
        });
        if (conditionMet) shortScore += (rule.weight || 1);
    }

    // 5. Calcola punteggio massimo possibile
    const maxLongScore = longRules.reduce((sum, r) => sum + (r.weight || 1), 0);
    const maxShortScore = shortRules.reduce((sum, r) => sum + (r.weight || 1), 0);

    const longThreshold = maxLongScore * 0.6; // 60% delle condizioni
    const shortThreshold = maxShortScore * 0.6;

    // 6. Determina azione
    result.conditions = [...longResults, ...shortResults];

    if (longScore >= longThreshold && longScore >= shortScore) {
        result.action = 'ENTER_LONG';
        result.tradeSize = calculatePositionSize(marketData, 'long');
        result.reason = `📈 Segnale LONG: ${longScore}/${maxLongScore} condizioni`;
        logger.info(`📈 Segnale LONG rilevato`, { score: longScore, max: maxLongScore });
    } else if (shortScore >= shortThreshold && shortScore > longScore) {
        result.action = 'ENTER_SHORT';
        result.tradeSize = calculatePositionSize(marketData, 'short');
        result.reason = `📉 Segnale SHORT: ${shortScore}/${maxShortScore} condizioni`;
        logger.info(`📉 Segnale SHORT rilevato`, { score: shortScore, max: maxShortScore });
    } else {
        result.passed = false;
        result.reason = `⚠️ Nessun segnale valido (LONG: ${longScore}/${maxLongScore}, SHORT: ${shortScore}/${maxShortScore})`;
        result.action = 'NO_TRADE';
        return result;
    }

    // 7. Applica limite massimo per trade
    if (result.tradeSize > CONFIG.maxTradeSize) {
        result.tradeSize = CONFIG.maxTradeSize;
        logger.info(`💰 Dimensione trade limitata a $${CONFIG.maxTradeSize}`);
    }

    // 8. Controlla drawdown
    const currentDrawdown = calculateDrawdown();
    if (currentDrawdown > CONFIG.maxDrawdown) {
        result.passed = false;
        result.reason = `❌ Drawdown superato (${currentDrawdown.toFixed(2)}% > ${CONFIG.maxDrawdown}%)`;
        result.action = 'NO_TRADE';
        return result;
    }

    return result;
}

function evaluateCondition(condition, data) {
    try {
        // Sostituisci variabili
        const context = {
            rsi: data.rsi || 50,
            close: data.close || 0,
            price: data.close || 0,
            bb_upper: data.bb_upper || 0,
            bb_lower: data.bb_lower || 0,
            ema_20: data.ema_20 || 0,
            ema_50: data.ema_50 || 0,
            ema_200: data.ema_200 || 0,
            atr: data.atr || 0,
            high: data.high || 0,
            low: data.low || 0,
            volume: data.volume || 0,
            volume_ma_20: data.volume_ma_20 || 0,
            entry_price: data.entry_price || 0
        };

        // Pattern matching per condizioni comuni
        if (condition.includes('rsi <')) {
            const threshold = parseFloat(condition.match(/\d+/)[0]);
            return context.rsi < threshold;
        }
        if (condition.includes('rsi >')) {
            const threshold = parseFloat(condition.match(/\d+/)[0]);
            return context.rsi > threshold;
        }
        if (condition.includes('price <= bb_lower')) {
            return context.price <= context.bb_lower;
        }
        if (condition.includes('price >= bb_upper')) {
            return context.price >= context.bb_upper;
        }
        if (condition.includes('close > ema_200')) {
            return context.close > context.ema_200;
        }
        if (condition.includes('close < ema_200')) {
            return context.close < context.ema_200;
        }
        if (condition.includes('close >= ema_20')) {
            return context.close >= context.ema_20;
        }
        if (condition.includes('close <= ema_20')) {
            return context.close <= context.ema_20;
        }
        if (condition.includes('close > ema_50')) {
            return context.close > context.ema_50;
        }
        if (condition.includes('close < ema_50')) {
            return context.close < context.ema_50;
        }
        if (condition.includes('volume > volume_ma_20')) {
            return context.volume > context.volume_ma_20 * 1.2;
        }
        if (condition.includes('volume < volume_ma_20')) {
            return context.volume < context.volume_ma_20 * 0.8;
        }
        if (condition.includes('price <= entry_price - (atr *')) {
            const mult = parseFloat(condition.match(/\d+\.?\d*/)[0]);
            return context.price <= context.entry_price - (context.atr * mult);
        }
        if (condition.includes('price >= entry_price + (atr *')) {
            const mult = parseFloat(condition.match(/\d+\.?\d*/)[0]);
            return context.price >= context.entry_price + (context.atr * mult);
        }

        return false;
    } catch (e) {
        logger.error(`❌ Errore valutazione condizione "${condition}"`, e.message);
        return false;
    }
}

function extractValues(condition, data) {
    const values = {};
    const patterns = {
        rsi: /rsi/g,
        close: /close/g,
        price: /price/g,
        bb_upper: /bb_upper/g,
        bb_lower: /bb_lower/g,
        ema_20: /ema_20/g,
        ema_50: /ema_50/g,
        ema_200: /ema_200/g,
        atr: /atr/g,
        volume: /volume/g,
        volume_ma_20: /volume_ma_20/g
    };

    for (const [key, pattern] of Object.entries(patterns)) {
        if (condition.match(pattern)) {
            values[key] = data[key];
        }
    }
    return values;
}

function calculatePositionSize(marketData, direction) {
    const riskPercent = rules.risk_management?.max_risk_per_trade_percent || 1.0;
    const atrMultiplier = rules.risk_management?.stop_loss_atr_multiplier || 1.5;

    const riskAmount = CONFIG.portfolioValue * (riskPercent / 100);
    const stopDistance = marketData.atr * atrMultiplier;
    let positionSize = riskAmount / stopDistance * marketData.close;

    // Applica leverage
    if (CONFIG.leverage > 1) {
        positionSize = positionSize * CONFIG.leverage;
    }

    // Limita a maxTradeSize
    positionSize = Math.min(positionSize, CONFIG.maxTradeSize);

    return positionSize;
}

function calculateDrawdown() {
    try {
        if (!fs.existsSync(CONFIG.tradesFile)) return 0;

        const content = fs.readFileSync(CONFIG.tradesFile, 'utf8');
        const lines = content.split('\n').filter(line => line.trim());
        if (lines.length < 2) return 0;

        let peak = 0;
        let equity = CONFIG.portfolioValue;
        let maxDrawdown = 0;

        for (let i = 1; i < lines.length; i++) {
            const parts = lines[i].split(',');
            if (parts.length < 8) continue;

            const net = parseFloat(parts[7]) || 0;
            equity += net;

            if (equity > peak) peak = equity;
            const drawdown = ((peak - equity) / peak) * 100;
            if (drawdown > maxDrawdown) maxDrawdown = drawdown;
        }

        return maxDrawdown;
    } catch (e) {
        return 0;
    }
}

// ==================== ESECUZIONE TRADE ====================

async function executeTrade(action, marketData, tradeSize) {
    const timestamp = moment().toISOString();
    let status = 'PENDING';
    let orderId = null;

    try {
        if (CONFIG.paperTrading) {
            // Simulazione trade
            const simulatedOrder = {
                id: `PAPER-${Date.now()}`,
                symbol: marketData.symbol,
                side: action === 'ENTER_LONG' ? 'buy' : 'sell',
                price: marketData.close,
                size: tradeSize,
                timestamp: timestamp,
                status: 'FILLED'
            };

            // Aggiorna posizioni
            const position = {
                id: simulatedOrder.id,
                symbol: marketData.symbol,
                side: action === 'ENTER_LONG' ? 'long' : 'short',
                entryPrice: marketData.close,
                size: tradeSize,
                timestamp: timestamp,
                stopLoss: action === 'ENTER_LONG'
                    ? marketData.close - (marketData.atr * (rules.risk_management?.stop_loss_atr_multiplier || 1.5))
                    : marketData.close + (marketData.atr * (rules.risk_management?.stop_loss_atr_multiplier || 1.5)),
                takeProfit: action === 'ENTER_LONG'
                    ? marketData.close + (marketData.atr * (rules.risk_management?.take_profit_atr_multiplier || 3.0))
                    : marketData.close - (marketData.atr * (rules.risk_management?.take_profit_atr_multiplier || 3.0))
            };

            currentPositions.push(position);
            savePositions();

            status = 'FILLED';
            orderId = simulatedOrder.id;

            logger.trade(`📝 [PAPER] ${action} su ${marketData.symbol}`, {
                type: 'PAPER',
                symbol: marketData.symbol,
                action: action,
                price: marketData.close,
                size: tradeSize,
                status: status
            });

            return { success: true, orderId, simulated: true, position };
        }

        // LIVE TRADING su BitGet
        const endpoint = `/api/v2/spot/trade/place-order`;
        const body = {
            symbol: marketData.symbol,
            side: action === 'ENTER_LONG' ? 'buy' : 'sell',
            orderType: 'market',
            size: (tradeSize / marketData.close).toFixed(6),
            clientOrderId: `BOT-${Date.now()}`
        };

        const result = await bitGetRequest('POST', endpoint, body);
        orderId = result.orderId;
        status = 'FILLED';

        // Aggiorna posizioni
        const position = {
            id: orderId,
            symbol: marketData.symbol,
            side: action === 'ENTER_LONG' ? 'long' : 'short',
            entryPrice: result.price || marketData.close,
            size: tradeSize,
            timestamp: timestamp,
            orderId: orderId
        };
        currentPositions.push(position);
        savePositions();

        logger.trade(`✅ [LIVE] ${action} eseguito su ${marketData.symbol}`, {
            type: 'LIVE',
            symbol: marketData.symbol,
            action: action,
            price: result.price || marketData.close,
            size: tradeSize,
            fee: result.fee || 0,
            net: result.netAmount || 0,
            orderId: orderId,
            status: status
        });

        return { success: true, orderId, simulated: false, position };

    } catch (error) {
        status = 'FAILED';
        logger.error(`❌ Errore esecuzione trade: ${error.message}`, { action, symbol: marketData.symbol });
        return { success: false, error: error.message, status };
    }
}

// ==================== CHIUSURA POSIZIONI ====================

async function closePosition(position, marketData, reason = 'EXIT') {
    try {
        const action = position.side === 'long' ? 'SELL' : 'BUY';
        const size = position.size;
        const priceChangePct = (marketData.close - position.entryPrice) / position.entryPrice;
        const direction = position.side === 'long' ? 1 : -1;
        const grossPnl = priceChangePct * size * direction;

        if (CONFIG.paperTrading) {
            // Rimuovi posizione
            const index = currentPositions.findIndex(p => p.id === position.id);
            if (index > -1) {
                currentPositions.splice(index, 1);
                savePositions();
            }

            logger.trade(`📝 [PAPER] Chiusura ${position.side} ${position.symbol} - ${reason}`, {
                type: 'PAPER',
                symbol: position.symbol,
                action: action,
                price: marketData.close,
                size: size,
                net: grossPnl,
                status: 'CLOSED'
            });

            return { success: true };
        }

        // LIVE closing su BitGet
        const endpoint = `/api/v2/spot/trade/place-order`;
        const body = {
            symbol: position.symbol,
            side: position.side === 'long' ? 'sell' : 'buy',
            orderType: 'market',
            size: (size / marketData.close).toFixed(6),
            clientOrderId: `CLOSE-${Date.now()}`
        };

        const result = await bitGetRequest('POST', endpoint, body);

        // Rimuovi posizione
        const index = currentPositions.findIndex(p => p.id === position.id);
        if (index > -1) {
            currentPositions.splice(index, 1);
            savePositions();
        }

        const fee = result.fee || 0;

        logger.trade(`✅ [LIVE] Chiusura ${position.side} ${position.symbol} - ${reason}`, {
            type: 'LIVE',
            symbol: position.symbol,
            action: action,
            price: result.price || marketData.close,
            size: size,
            fee: fee,
            net: grossPnl - fee,
            status: 'CLOSED'
        });

        return { success: true };

    } catch (error) {
        logger.error(`❌ Errore chiusura posizione: ${error.message}`);
        return { success: false, error: error.message };
    }
}

// ==================== CHECK EXIT CONDITIONS ====================

async function checkExitConditions(marketData) {
    const positionsToClose = [];

    for (const position of currentPositions) {
        const exitRules = position.side === 'long'
            ? rules.exit_rules?.long || []
            : rules.exit_rules?.short || [];

        let shouldClose = false;
        let reason = '';

        for (const rule of exitRules) {
            const conditionMet = evaluateCondition(rule.condition, {
                ...marketData,
                entry_price: position.entryPrice
            });

            if (conditionMet) {
                shouldClose = true;
                reason = rule.description;
                break;
            }
        }

        // Stop loss e take profit
        if (position.side === 'long') {
            if (marketData.close <= position.entryPrice - (marketData.atr * (rules.risk_management?.stop_loss_atr_multiplier || 1.5))) {
                shouldClose = true;
                reason = 'Stop Loss Long';
            }
            if (marketData.close >= position.entryPrice + (marketData.atr * (rules.risk_management?.take_profit_atr_multiplier || 3.0))) {
                shouldClose = true;
                reason = 'Take Profit Long';
            }
        } else {
            if (marketData.close >= position.entryPrice + (marketData.atr * (rules.risk_management?.stop_loss_atr_multiplier || 1.5))) {
                shouldClose = true;
                reason = 'Stop Loss Short';
            }
            if (marketData.close <= position.entryPrice - (marketData.atr * (rules.risk_management?.take_profit_atr_multiplier || 3.0))) {
                shouldClose = true;
                reason = 'Take Profit Short';
            }
        }

        if (shouldClose) {
            positionsToClose.push({ position, reason });
        }
    }

    for (const { position, reason } of positionsToClose) {
        await closePosition(position, marketData, reason);
    }
}

// ==================== WEBHOOK SERVER ====================

function startWebhookServer() {
    const server = createServer(async (req, res) => {
        if (req.url === CONFIG.webhookPath && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => { body += chunk.toString(); });
            req.on('end', async () => {
                try {
                    const data = JSON.parse(body);
                    logger.info('📨 Webhook ricevuto', data);

                    // Processa webhook
                    const marketData = await getMarketData(data.ticker || CONFIG.symbol, data.timeframe || CONFIG.timeframe);

                    // Safety check
                    const tradeLimits = getTradeLimits();
                    const safetyResult = evaluateSafetyCheck(marketData, tradeLimits);

                    // Salva log
                    saveSafetyLog(safetyResult);

                    if (safetyResult.passed && safetyResult.action !== 'NO_TRADE') {
                        await executeTrade(safetyResult.action, marketData, safetyResult.tradeSize);
                    }

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'OK', action: safetyResult.action }));
                } catch (error) {
                    logger.error('❌ Errore webhook', error.message);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'ERROR', message: error.message }));
                }
            });
        } else {
            res.writeHead(404);
            res.end();
        }
    });

    server.listen(CONFIG.webhookPort, () => {
        logger.info(`🌐 Webhook server in ascolto su port ${CONFIG.webhookPort}${CONFIG.webhookPath}`);
    });
}

// ==================== FUNZIONI UTILITY ====================

function getTradeLimits() {
    let tradesExecutedToday = 0;
    try {
        if (fs.existsSync(CONFIG.safetyLogFile)) {
            const logs = JSON.parse(fs.readFileSync(CONFIG.safetyLogFile, 'utf8'));
            const today = moment().format('YYYY-MM-DD');
            tradesExecutedToday = logs.filter(l =>
                l.timestamp.startsWith(today) &&
                l.action !== 'NO_TRADE' &&
                l.passed === true
            ).length;
        }
    } catch (e) {
        // Ignora
    }
    return { tradesExecutedToday };
}

function saveSafetyLog(result) {
    let logs = [];
    try {
        if (fs.existsSync(CONFIG.safetyLogFile)) {
            logs = JSON.parse(fs.readFileSync(CONFIG.safetyLogFile, 'utf8'));
        }
    } catch (e) {
        logs = [];
    }
    logs.push(result);
    fs.writeFileSync(CONFIG.safetyLogFile, JSON.stringify(logs, null, 2));
}

// ==================== FUNZIONE PRINCIPALE ====================

async function main() {
    logger.info('🚀 Avvio bot AKRAM Trading v2.0');
    logger.info(`📊 Simbolo: ${CONFIG.symbol} | Timeframe: ${CONFIG.timeframe}`);
    logger.info(`💰 Portafoglio: $${CONFIG.portfolioValue} | Max Trade: $${CONFIG.maxTradeSize}`);
    logger.info(`📈 Modalità: ${CONFIG.paperTrading ? 'PAPER (simulazione)' : 'LIVE'}`);
    logger.info(`🔒 Leverage: ${CONFIG.leverage}x`);
    logger.info(`📊 Max posizioni: ${CONFIG.maxPositions}`);

    // Carica configurazione
    if (!loadRules()) {
        logger.error('❌ Impossibile caricare rules.json. Uscita.');
        return;
    }

    loadPositions();

    // Avvia webhook server
    startWebhookServer();

    // Avvia monitoraggio continuo
    let cycleCount = 0;
    setInterval(async () => {
        cycleCount++;
        logger.info(`🔄 Ciclo ${cycleCount} - ${moment().format('HH:mm:ss')}`);

        try {
            // Ottieni dati di mercato
            const marketData = await getMarketData(CONFIG.symbol, CONFIG.timeframe);
            logger.debug(`📊 Prezzo: $${marketData.close} | RSI: ${marketData.rsi.toFixed(2)} | ATR: $${marketData.atr.toFixed(2)}`);

            // Controlla condizioni di uscita
            await checkExitConditions(marketData);

            // Ottieni limiti di trading
            const tradeLimits = getTradeLimits();
            logger.debug(`📊 Trade oggi: ${tradeLimits.tradesExecutedToday}/${CONFIG.maxTradesPerDay}`);

            // Safety check
            const safetyResult = evaluateSafetyCheck(marketData, tradeLimits);
            saveSafetyLog(safetyResult);

            // Esegui trade se approvato
            if (safetyResult.passed && safetyResult.action !== 'NO_TRADE') {
                await executeTrade(safetyResult.action, marketData, safetyResult.tradeSize);
            } else if (safetyResult.reason) {
                logger.debug(safetyResult.reason);
            }

            // Mostra riepilogo posizioni
            if (currentPositions.length > 0) {
                logger.info(`📊 Posizioni aperte: ${currentPositions.length}`);
                for (const pos of currentPositions) {
                    const pnl = ((marketData.close - pos.entryPrice) / pos.entryPrice * 100) * (pos.side === 'long' ? 1 : -1);
                    logger.info(`   ${pos.side.toUpperCase()} ${pos.symbol} @ $${pos.entryPrice.toFixed(2)} | PnL: ${pnl.toFixed(2)}%`);
                }
            }

        } catch (error) {
            logger.error('❌ Errore nel ciclo principale', error.message);
        }
    }, 60000); // Esegui ogni minuto

    logger.info('✅ Bot avviato con successo. In attesa di segnali...');
}

// ==================== AVVIO ====================

// Gestione arresto graceful
process.on('SIGINT', () => {
    logger.info('🛑 Arresto bot...');
    savePositions();
    process.exit(0);
});

process.on('SIGTERM', () => {
    logger.info('🛑 Arresto bot...');
    savePositions();
    process.exit(0);
});

// Avvia il bot
main().catch(error => {
    logger.error('❌ Errore fatale', error.message);
    process.exit(1);
});

// ==================== ESPORTAZIONI ====================

export {
    main,
    getMarketData,
    evaluateSafetyCheck,
    executeTrade,
    loadRules,
    currentPositions
};
