const fs = require('fs');
const path = require('path');

const DEFAULT_ARTIFACT_PATH = path.join(__dirname, '..', '..', 'data', 'research-models.json');
const MIN_RATE = Number(process.env.RESEARCH_MIN_RATE || 0.0002);
const FRR_MULTIPLIER = Number(process.env.RESEARCH_FRR_MULTIPLIER || 1);

function loadArtifact(filePath = process.env.RESEARCH_MODEL_PATH || DEFAULT_ARTIFACT_PATH) {
    try {
        const artifact = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return artifact?.schemaVersion === 1 && artifact.models ? artifact : null;
    } catch {
        return null;
    }
}

function standardizedLinear(model, features, names) {
    const values = names.map(name => Number.isFinite(Number(features[name])) ? Number(features[name]) : 0);
    const means = model.mean || [];
    const scales = model.scale || [];
    const coefficients = model.coefficients || [];
    return Number(model.intercept || 0) + values.reduce((sum, value, index) => {
        const scale = Number(scales[index]);
        const normalized = (value - (Number(means[index]) || 0)) / (Number.isFinite(scale) && scale !== 0 ? scale : 1);
        return sum + normalized * (Number(coefficients[index]) || 0);
    }, 0);
}

function scoreTree(tree, features, names) {
    if (Array.isArray(tree)) {
        let index = 0;
        while (index >= 0 && index < tree.length) {
            const node = tree[index];
            if (node.isLeaf || node.feature < 0) return Number(node.value) || 0;
            const feature = Number(features[names[node.feature]]) || 0;
            index = feature <= node.threshold ? node.left : node.right;
        }
        return 0;
    }
    return 0;
}

function scoreHistogram(model, features, names) {
    const trees = Array.isArray(model.trees) ? model.trees : [];
    // HistGradientBoosting exports each leaf after sklearn has already applied
    // learning_rate (grower.shrinkage). Scaling the tree sum here would apply
    // the shrinkage a second time and flatten every prediction toward baseline.
    return Number(model.baseline || 0) + trees.reduce((sum, tree) => sum + scoreTree(tree, features, names), 0);
}

function collectCandidatePredictions(history, features, artifact = loadArtifact()) {
    const ordered = (history || []).slice().sort((a, b) => new Date(a.minute_at ?? a.minuteAt ?? a.timestamp).getTime() - new Date(b.minute_at ?? b.minuteAt ?? b.timestamp).getTime());
    const latestBar = ordered.at(-1);
    const current = latestBar?.features || latestBar || {};
    const currentRate = Number(current.fundingVwap);
    const latestKnown = ordered.slice().reverse().map(row => (row.features || row).fundingVwap)
        .find(value => value !== null && value !== undefined && Number.isFinite(Number(value)) && Number(value) > 0);
    const persistedRate = Number.isFinite(currentRate) && currentRate > 0 ? currentRate : Number(latestKnown);
    const referenceTime = new Date(latestBar?.minute_at ?? latestBar?.minuteAt ?? latestBar?.timestamp ?? Date.now()).getTime();
    const oneHour = ordered.filter(row => new Date(row.minute_at ?? row.minuteAt ?? row.timestamp).getTime() >= referenceTime - 60 * 60_000);
    const hourVolume = oneHour.reduce((sum, row) => sum + (Number((row.features || row).tradeVolume) || 0), 0);
    const hourMean = hourVolume > 0
        ? oneHour.reduce((sum, row) => sum + (Number((row.features || row).fundingVwap || 0) * (Number((row.features || row).tradeVolume) || 0)), 0) / hourVolume
        : null;

    const predictions = [];
    if (Number.isFinite(persistedRate) && persistedRate > 0) {
        predictions.push({ modelId: 'persistence', modelVersion: 'baseline-v1', predictedRate: persistedRate });
    }
    if (Number.isFinite(hourMean) && hourMean > 0) {
        predictions.push({ modelId: 'hour_mean', modelVersion: 'baseline-v1', predictedRate: hourMean });
    }

    const names = artifact?.featureNames || [];
    if (artifact && names.length && features) {
        for (const modelId of ['ridge', 'huber']) {
            const model = artifact.models[modelId];
            if (model && model.kind === 'linear') predictions.push({
                modelId, modelVersion: model.version || artifact.version,
                predictedRate: standardizedLinear(model, features, names),
            });
        }
        const forest = artifact.models.hist_gradient_boosting;
        if (forest && forest.kind === 'histGradientBoosting') predictions.push({
            modelId: 'hist_gradient_boosting', modelVersion: forest.version || artifact.version,
            predictedRate: scoreHistogram(forest, features, names),
        });
        const quantile = artifact.models.quantile;
        if (quantile && quantile.kind === 'quantile') predictions.push({
            modelId: 'quantile', modelVersion: quantile.version || artifact.version,
            predictedRate: standardizedLinear(quantile.models.p50, features, names),
            p10Rate: standardizedLinear(quantile.models.p10, features, names),
            p90Rate: standardizedLinear(quantile.models.p90, features, names),
        });
    }
    return predictions;
}

function makeDecisions(predictions, { decisionAt, features, frr, horizonMinutes, marketFresh, minimumOfferAmount = 150 }) {
    const floorRate = Math.max((Number(frr) || 0) * FRR_MULTIPLIER, MIN_RATE);
    const meetsMinimumOrder = 500 >= Number(minimumOfferAmount || 150);
    return predictions.map(prediction => {
        let recommendation = 'wait';
        let reason = 'below_rate_floor';
        const rate = Number(prediction.predictedRate);
        if (!marketFresh) reason = 'stale_market_data';
        else if (!Number.isFinite(rate) || rate <= 0) reason = 'model_not_ready';
        else if (!meetsMinimumOrder) reason = 'below_minimum_order';
        else if (rate >= floorRate) {
            recommendation = 'offer';
            reason = 'rate_at_or_above_floor';
        }
        return {
            decisionAt, modelId: prediction.modelId, modelVersion: prediction.modelVersion,
            horizonMinutes, features, predictedRate: Number.isFinite(rate) ? rate : null,
            p10Rate: Number.isFinite(Number(prediction.p10Rate)) ? Number(prediction.p10Rate) : null,
            p90Rate: Number.isFinite(Number(prediction.p90Rate)) ? Number(prediction.p90Rate) : null,
            floorRate, recommendation, reason, meetsMinimumOrder,
        };
    });
}

module.exports = { loadArtifact, collectCandidatePredictions, makeDecisions, MIN_RATE, FRR_MULTIPLIER };
