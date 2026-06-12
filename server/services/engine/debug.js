"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const strategy_1 = require("./strategy");
const engine = new strategy_1.StrategyEngine();
// 1. Debug 拆單
const mockMarketData = {
    frr: 0.00035,
    lastPrice: 0.00035,
    high: 0.0004,
    low: 0.0003,
    volume: 50000,
    bidSize: 1000,
    askSize: 1000,
    bid: 0.00034,
    ask: 0.00036,
    asks: [
        { rate: 0.00035, amount: 5000, timestamp: Date.now() - 15 * 60 * 1000 }
    ],
    bids: [
        { rate: 0.00034, amount: 2000, timestamp: Date.now() - 15 * 60 * 1000 }
    ]
};
const result = engine.calculateOptimalRate(mockMarketData, 'USD', 1250);
console.log('--- GRID ORDERS ---');
console.log('Orders length:', result.orders.length);
console.log('Orders:', JSON.stringify(result.orders, null, 2));
// 2. Debug 過濾
const now = Date.now();
const mockMarketData2 = {
    frr: 0.00035,
    lastPrice: 0.00036,
    high: 0.00045,
    low: 0.00030,
    volume: 100000,
    bidSize: 5000,
    askSize: 8000,
    bid: 0.00034,
    ask: 0.00036,
    asks: [
        { rate: 0.00030, amount: 4000, timestamp: now - 15 * 60 * 1000 },
        { rate: 0.00032, amount: 4000, timestamp: now - 1 * 60 * 1000 },
        { rate: 0.00035, amount: 4000, timestamp: now - 15 * 60 * 1000 },
        { rate: 0.00038, amount: 4000, timestamp: now - 15 * 60 * 1000 }
    ],
    bids: [
        { rate: 0.00034, amount: 4000, timestamp: now - 15 * 60 * 1000 }
    ]
};
const result2 = engine.calculateIBRR(mockMarketData2, 5, 'USD');
console.log('--- IBRR ---');
console.log('Total Supply:', result2.totalSupply);
console.log('Equilibrium Rate:', result2.equilibriumRate);
