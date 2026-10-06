const rest = require('../bitfinex/rest');
const { getBitfinexPublicWS, isPublicTickerFresh } = require('../bitfinex/ws');
const db = require('../database');
const logger = require('../../utils/logger');
const { decryptWithFallback } = require('../../utils/crypto');
const { SINGLE_ACCOUNT_USER_ID } = require('../../config/single-account');
const { buildFeatureVector } = require('./features');
const { loadArtifact, collectCandidatePredictions, makeDecisions } = require('./models');

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const RETENTION_DAYS = 180;
const SIMULATED_OFFERS = 14;
const SIMULATED_OFFER_AMOUNT = 500;
const PRIVATE_FILL_LIMIT = 1000;
const TRADE_STALE_AFTER_MS = Math.max(1, Number(process.env.RESEARCH_TRADE_STALE_AFTER_MINUTES || 15)) * MINUTE_MS;

let timer = null;
let inFlight = false;
let lastCollection = { state: 'idle', lastAttemptAt: null, lastSuccessAt: null, error: null };
let lastPrivateSync = { state: 'not_checked', lastAttemptAt: null, lastSuccessAt: null, error: null };
let lockedHorizonApplied = false;
let researchStartRecorded = false;

function n(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function summarizeTrades(trades) {
    const valid = trades.filter(trade => n(trade.timestamp) !== null && n(trade.rate) !== null
        && n(trade.amount) !== null && n(trade.period) !== null);
    const volume = valid.reduce((sum, trade) => sum + Math.abs(Number(trade.amount)), 0);
    const vwap = volume ? valid.reduce((sum, trade) => sum + Math.abs(Number(trade.amount)) * Number(trade.rate), 0) / volume : null;
    const tenorDistribution = {};
    for (const trade of valid) {
        const period = String(Number(trade.period));
        tenorDistribution[period] = (tenorDistribution[period] || 0) + Math.abs(Number(trade.amount));
    }
    const latestTradeAt = valid.reduce((latest, trade) => Math.max(latest, Number(trade.timestamp)), 0) || null;
    return { fundingVwap: vwap, tradeVolume: volume, tradeCount: valid.length, tenorDistribution, latestTradeAt };
}

function topLevels(rows) {
    return (Array.isArray(rows) ? rows : []).slice(0, 5).map(row => ({
        rate: n(row.rate), amount: n(row.amount), count: n(row.count), period: n(row.period),
    })).filter(row => row.rate !== null && row.amount !== null);
}

function buildMarketBar(marketData, trades, now) {
    const tradeSummary = summarizeTrades(trades);
    const bids = topLevels(marketData?.bids);
    const asks = topLevels(marketData?.asks);
    const tickerAt = n(marketData?.tickerLastUpdate);
    const bookAt = n(marketData?.lastUpdate);
    const dataQuality = {
        tickerFresh: isPublicTickerFresh(marketData, now),
        bookFresh: bookAt !== null && bookAt > 0 && bookAt <= now && now - bookAt <= 180_000,
        fundingTradesAvailable: tradeSummary.tradeCount > 0,
    };
    return {
        frr: n(marketData?.frr),
        tickerBid: n(marketData?.bid),
        tickerAsk: n(marketData?.ask),
        tickerLastPrice: n(marketData?.lastPrice),
        tickerVolume: n(marketData?.volume),
        tickerAt,
        bookAt,
        bookBids: bids,
        bookAsks: asks,
        bestBid: bids[0]?.rate ?? n(marketData?.bid),
        bestAsk: asks[0]?.rate ?? n(marketData?.ask),
        bidDepth5: bids.slice(0, 5).reduce((sum, row) => sum + row.amount, 0),
        askDepth5: asks.slice(0, 5).reduce((sum, row) => sum + row.amount, 0),
        ...tradeSummary,
        dataQuality,
    };
}

async function getIndependentMarketSnapshot(publicWs, now) {
    const marketData = { ...(publicWs.getMarketData('USD') || {}) };
    if (!isPublicTickerFresh(marketData, now)) {
        const ticker = await rest.getFundingTicker('USD');
        if (Array.isArray(ticker) && ticker.length >= 16) {
            Object.assign(marketData, {
                frr: ticker[0], bid: ticker[1], bidSize: ticker[2], bidPeriod: ticker[3],
                ask: ticker[4], askSize: ticker[5], askPeriod: ticker[6], dailyChange: ticker[7],
                dailyChangePerc: ticker[8], lastPrice: ticker[9], volume: ticker[10],
                high: ticker[11], low: ticker[12], frrAmountAvailable: ticker[15], tickerLastUpdate: now,
            });
        }
    }
    const bookAge = now - Number(marketData.lastUpdate || 0);
    if (!Array.isArray(marketData.bids) || !marketData.bids.length || !Array.isArray(marketData.asks)
        || !marketData.asks.length || bookAge > 180_000) {
        const book = await rest.getFundingBook('USD', 'P0');
        if (Array.isArray(book)) {
            const bids = [];
            const asks = [];
            for (const row of book) {
                if (!Array.isArray(row) || row.length < 4) continue;
                const [rate, period, count, signedAmount] = row;
                const level = { rate: Number(rate), period: Number(period), count: Number(count), amount: Math.abs(Number(signedAmount)) };
                if (signedAmount > 0) bids.push(level);
                else if (signedAmount < 0) asks.push(level);
            }
            bids.sort((a, b) => b.rate - a.rate);
            asks.sort((a, b) => a.rate - b.rate);
            Object.assign(marketData, { bids, asks, lastUpdate: now });
        }
    }
    return marketData;
}

async function syncPrivateFundingFills(now) {
    lastPrivateSync = { ...lastPrivateSync, state: 'running', lastAttemptAt: new Date(now).toISOString(), error: null };
    try {
        const settings = await db.getUserSettings(SINGLE_ACCOUNT_USER_ID);
        if (!settings?.bitfinex_api_key || !settings?.bitfinex_api_secret) {
            lastPrivateSync = { ...lastPrivateSync, state: 'not_configured', error: null };
            return 0;
        }
        const credentials = {
            apiKey: decryptWithFallback(settings.bitfinex_api_key),
            apiSecret: decryptWithFallback(settings.bitfinex_api_secret),
        };
        const latest = await db.getLatestResearchFillTimestamp();
        const overlapStart = latest === null ? now - DAY_MS : Math.max(0, latest - MINUTE_MS);
        const trades = await rest.getUserFundingTrades('USD', {
            start: overlapStart,
            end: now,
            limit: PRIVATE_FILL_LIMIT,
        }, credentials);
        await db.upsertResearchFundingFills(trades);
        lastPrivateSync = { state: 'connected', lastAttemptAt: new Date(now).toISOString(), lastSuccessAt: new Date(now).toISOString(), error: null };
        return trades.length;
    } catch (error) {
        // Do not expose response bodies, credentials, or raw private endpoint errors in API status.
        lastPrivateSync = {
            state: 'error', lastAttemptAt: new Date(now).toISOString(),
            lastSuccessAt: lastPrivateSync.lastSuccessAt, error: 'private_funding_trades_unavailable',
        };
        logger.warn('research', '讀取私有 Funding Trades 失敗，已保留未配對狀態');
        return 0;
    }
}

async function resolveHorizon(status, now) {
    const savedStart = await db.getResearchSetting('usd_research_started_at');
    const firstAtValue = savedStart || status.market?.firstAt;
    const firstAt = firstAtValue ? new Date(firstAtValue).getTime() : null;
    if (firstAt === null || now < firstAt + 30 * DAY_MS) {
        return { minutes: 24 * 60, locked: false, source: 'provisional_24h', stage: 'warmup' };
    }
    let locked = await db.getResearchSetting('usd_forecast_horizon');
    if (!locked) {
        const calibrationEnd = firstAt + 30 * DAY_MS;
        const durations = await db.getResearchHorizonDurations(new Date(firstAt).toISOString(), new Date(calibrationEnd).toISOString());
        const source = durations.length < 50 ? 'fallback_under_50_linked_fills' : 'linked_fill_duration_p75';
        let minutes = 24 * 60;
        if (durations.length >= 50) {
            const sorted = durations.slice().sort((a, b) => a - b);
            minutes = Math.max(1, Math.round(sorted[Math.ceil(sorted.length * 0.75) - 1]));
        }
        const lockedValue = { minutes, source, linkedFills: durations.length,
            lockedAt: new Date(now).toISOString(), calibrationStart: new Date(firstAt).toISOString(),
            calibrationEnd: new Date(calibrationEnd).toISOString() };
        await db.saveResearchSetting('usd_forecast_horizon', lockedValue);
        locked = await db.getResearchSetting('usd_forecast_horizon') || lockedValue;
    }
    return { ...locked, locked: true,
        stage: now < firstAt + 45 * DAY_MS ? 'validation' : now < firstAt + 60 * DAY_MS ? 'sealed_initial_review' : 'initial_review' };
}

async function collectAndScore() {
    if (inFlight) return;
    inFlight = true;
    const now = Date.now();
    lastCollection = { ...lastCollection, state: 'running', lastAttemptAt: new Date(now).toISOString(), error: null };
    try {
        if (!db.isPostgresConfigured() || !(await db.ensureResearchTables())) {
            throw new Error('postgres_research_storage_unavailable');
        }
        const publicWs = getBitfinexPublicWS();
        const minuteMs = Math.floor(now / MINUTE_MS) * MINUTE_MS;
        const trades = await db.getFundingTrades('USD', new Date(minuteMs), new Date(now));
        const snapshot = await getIndependentMarketSnapshot(publicWs, now);
        const data = buildMarketBar(snapshot, trades, now);
        const recentBars = await db.getResearchMarketBars(new Date(now - TRADE_STALE_AFTER_MS).toISOString(), new Date(minuteMs - 1).toISOString(), 30);
        const latestTradeAt = [data.latestTradeAt, ...recentBars.map(row => Number(row.features?.latestTradeAt))]
            .filter(Number.isFinite).reduce((latest, value) => Math.max(latest, value), 0);
        data.dataQuality.tradeFresh = latestTradeAt > 0 && now - latestTradeAt <= TRADE_STALE_AFTER_MS;
        const saved = await db.saveResearchMarketBar({ minuteAt: new Date(minuteMs).toISOString(), currency: 'USD', features: data });
        if (!saved) throw new Error('research_bar_write_failed');
        if (!researchStartRecorded) {
            const existingStart = await db.getResearchSetting('usd_research_started_at');
            if (!existingStart) await db.saveResearchSetting('usd_research_started_at', new Date(minuteMs).toISOString());
            researchStartRecorded = true;
        }

        const history = await db.getResearchMarketBars(new Date(minuteMs - 360 * MINUTE_MS).toISOString(), new Date(minuteMs).toISOString(), 400);
        const featureVector = buildFeatureVector(history, minuteMs);
        const status = await db.getResearchStatus();
        const horizon = await resolveHorizon(status, now);
        if (horizon.locked && !lockedHorizonApplied) {
            await db.setUnlabeledResearchHorizon(horizon.minutes);
            lockedHorizonApplied = true;
        }
        const artifact = await db.getActiveResearchModelArtifact().catch(() => null) || loadArtifact();
        const offerPeriodDays = await db.getResearchOfferPeriodDays(SINGLE_ACCOUNT_USER_ID);
        const predictions = collectCandidatePredictions(history, featureVector, artifact);
        const marketFresh = data.dataQuality.tickerFresh && data.dataQuality.bookFresh && data.dataQuality.tradeFresh;
        const decisions = makeDecisions(predictions, {
            decisionAt: new Date(minuteMs).toISOString(), features: featureVector,
            frr: data.frr, horizonMinutes: horizon.minutes, marketFresh,
            minimumOfferAmount: Number(process.env.MIN_OFFER_AMOUNT || 150),
        }).map(decision => ({ ...decision, simulatedOfferPeriodDays: offerPeriodDays }));
        await db.saveResearchDecisions(decisions);
        if (horizon.locked) await db.finalizeResearchLabels(new Date(now));
        const fillCount = await syncPrivateFundingFills(now);
        await db.reconcileResearchFundingFillLinks();
        lastCollection = {
            state: marketFresh ? 'healthy' : 'incomplete',
            lastAttemptAt: new Date(now).toISOString(), lastSuccessAt: new Date(now).toISOString(),
            error: marketFresh ? null : 'market_inputs_stale',
            lastBarAt: new Date(minuteMs).toISOString(),
            dataQuality: data.dataQuality,
            horizon,
            modelArtifactLoaded: Boolean(artifact),
            offerPeriodDays,
            fillsFetched: fillCount,
            decisionsWritten: decisions.length,
        };
        await db.recordResearchCollectionRun({ attemptedAt: new Date(now).toISOString(),
            status: lastCollection.state, errorCode: lastCollection.error });
    } catch (error) {
        lastCollection = { ...lastCollection, state: 'error', error: error.message === 'postgres_research_storage_unavailable'
            ? error.message : 'market_collection_failed' };
        try {
            await db.recordResearchCollectionRun({ attemptedAt: new Date(now).toISOString(),
                status: 'error', errorCode: lastCollection.error });
        } catch {}
        logger.warn('research', `USD 影子研究收集失敗: ${lastCollection.error}`);
    } finally {
        inFlight = false;
    }
}

function startShadowResearch() {
    if (timer || !db.isPostgresConfigured()) return;
    void collectAndScore();
    timer = setInterval(() => { void collectAndScore(); }, MINUTE_MS);
}

function stopShadowResearch() {
    if (timer) clearInterval(timer);
    timer = null;
}

async function getShadowResearchStatus() {
    const status = await db.getResearchStatus();
    const horizon = lastCollection.horizon || await resolveHorizon(status, Date.now());
    const savedStart = await db.getResearchSetting('usd_research_started_at');
    const firstAtValue = savedStart || status.market?.firstAt;
    const firstAt = firstAtValue ? new Date(firstAtValue).getTime() : null;
    const elapsedDays = firstAt === null ? 0 : Math.max(0, (Date.now() - firstAt) / DAY_MS);
    const enoughCoverage = Number(status.market?.coverage60Days || 0) >= 0.9;
    const enoughFills = Number(status.fills?.matched || 0) >= 50;
    const sealedTestComplete = (status.experiments || []).some(row => row.stage === 'sealed_test' && row.status === 'completed');
    return {
        ...status,
        collection: lastCollection,
        privateTrades: lastPrivateSync,
        retentionDays: RETENTION_DAYS,
        simulation: { offersPerModel: SIMULATED_OFFERS, amountPerOffer: SIMULATED_OFFER_AMOUNT,
            nominalPerModel: SIMULATED_OFFERS * SIMULATED_OFFER_AMOUNT,
            periodDays: lastCollection.offerPeriodDays || 2 },
        horizon,
        evaluation: {
            elapsedDays: Number(elapsedDays.toFixed(1)),
            stage: horizon.stage,
            initialReviewReady: elapsedDays >= 60 && enoughCoverage && enoughFills && sealedTestComplete,
            insufficientData: elapsedDays >= 60 && (!enoughCoverage || !enoughFills),
            pendingSealedReview: elapsedDays >= 60 && enoughCoverage && enoughFills && !sealedTestComplete,
            coverageGate: 0.9,
            minimumMatchedFills: 50,
        },
    };
}

module.exports = { startShadowResearch, stopShadowResearch, collectAndScore, getShadowResearchStatus };
