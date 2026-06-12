function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toTime(value) {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

function nearlyEqual(a, b, tolerance = 0.01) {
  if (a === null || b === null || a === undefined || b === undefined) return false;
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) / scale <= tolerance;
}

function normalizeOffer(row) {
  return {
    ...row,
    currency: row.currency,
    amount: Math.abs(toNumber(row.amount) || 0),
    rate: toNumber(row.rate) || 0,
    period: Number(row.period || 0),
    createdTs: toTime(row.created_at),
    updatedTs: toTime(row.updated_at),
    closedTs: toTime(row.closed_at),
  };
}

function normalizeLoan(row) {
  return {
    ...row,
    currency: row.currency,
    amount: Math.abs(toNumber(row.amount) || 0),
    rate: toNumber(row.rate) || 0,
    period: Number(row.period || 0),
    openedTs: toTime(row.opened_at),
    closedTs: toTime(row.closed_at),
    interestEarned: toNumber(row.interest_earned) || 0,
  };
}

function normalizeRate(row) {
  return {
    ...row,
    currency: row.currency,
    frr: toNumber(row.frr),
    avg_rate: toNumber(row.avg_rate),
    high_rate: toNumber(row.high_rate),
    low_rate: toNumber(row.low_rate),
    demand_supply_ratio: toNumber(row.demand_supply_ratio),
    recordedTs: toTime(row.recorded_at),
  };
}

function nearestSnapshot(history, currency, ts, windowMs = 30 * 60 * 1000) {
  let best = null;
  let bestDelta = Infinity;
  for (const row of history) {
    if (row.currency !== currency || row.recordedTs === null || ts === null) continue;
    const delta = Math.abs(row.recordedTs - ts);
    if (delta <= windowMs && delta < bestDelta) {
      best = row;
      bestDelta = delta;
    }
  }
  return best;
}

function buildOfferEpisodes(rawOffers, rawLoans, options = {}) {
  const reofferWindowMs = (options.reofferWindowMinutes || 20) * 60 * 1000;
  const loanMatchWindowMs = (options.loanMatchWindowMinutes || 30) * 60 * 1000;

  const offers = rawOffers
    .map(normalizeOffer)
    .filter(o => o.currency && o.createdTs)
    .sort((a, b) => a.createdTs - b.createdTs);

  const loans = rawLoans
    .map(normalizeLoan)
    .filter(l => l.currency && l.openedTs)
    .sort((a, b) => a.openedTs - b.openedTs);

  const usedAsSuccessor = new Set();
  const usedLoans = new Set();
  const episodes = [];

  function findSuccessor(current, startIndex) {
    const baseCloseTs = current.closedTs || current.updatedTs;
    if (!baseCloseTs) return null;

    let best = null;
    for (let j = startIndex + 1; j < offers.length; j++) {
      const candidate = offers[j];
      if (usedAsSuccessor.has(candidate.offer_id)) continue;
      if (candidate.currency !== current.currency) continue;
      if (!nearlyEqual(candidate.amount, current.amount, 0.02)) continue;
      if (candidate.period !== current.period) continue;
      if (candidate.createdTs < baseCloseTs) continue;
      if (candidate.createdTs - baseCloseTs > reofferWindowMs) break;
      if (!(candidate.rate < current.rate)) continue;

      const score =
        Math.abs(candidate.createdTs - baseCloseTs) +
        Math.abs(candidate.amount - current.amount) * 10_000_000 +
        Math.abs(candidate.rate - current.rate) * 10_000_000_000;

      if (!best || score < best.score) {
        best = { candidate, score };
      }
    }
    return best?.candidate || null;
  }

  function findLoanMatch(finalOffer) {
    const anchorTs = finalOffer.closedTs || finalOffer.updatedTs || finalOffer.createdTs;
    let best = null;
    for (const loan of loans) {
      if (usedLoans.has(loan.loan_id)) continue;
      if (loan.currency !== finalOffer.currency) continue;
      if (loan.period !== finalOffer.period) continue;
      if (!nearlyEqual(loan.amount, finalOffer.amount, 0.02)) continue;
      if (!nearlyEqual(loan.rate, finalOffer.rate, 0.001)) continue;
      const delta = Math.abs(loan.openedTs - anchorTs);
      if (delta > loanMatchWindowMs) continue;
      if (!best || delta < best.delta) best = { loan, delta };
    }
    if (best) usedLoans.add(best.loan.loan_id);
    return best?.loan || null;
  }

  for (let i = 0; i < offers.length; i++) {
    const offer = offers[i];
    if (usedAsSuccessor.has(offer.offer_id)) continue;

    const chain = [offer];
    let current = offer;
    while (true) {
      const successor = findSuccessor(current, i);
      if (!successor) break;
      usedAsSuccessor.add(successor.offer_id);
      chain.push(successor);
      current = successor;
    }

    const finalOffer = chain[chain.length - 1];
    const matchedLoan = findLoanMatch(finalOffer);

    episodes.push({
      currency: offer.currency,
      amount: offer.amount,
      period: offer.period,
      chain,
      initialOffer: offer,
      finalOffer,
      reofferCount: Math.max(0, chain.length - 1),
      matchedLoan,
      filled: Boolean(matchedLoan),
      startedTs: offer.createdTs,
      firstReofferTs: chain[1]?.createdTs || null,
      finalTs: matchedLoan?.openedTs || finalOffer.closedTs || finalOffer.updatedTs || finalOffer.createdTs,
    });
  }

  return episodes.sort((a, b) => a.startedTs - b.startedTs);
}

function analyzeReofferBenefit(data, options = {}) {
  const minReofferAgeHours = options.minReofferAgeHours || 3;
  const quickFillHours = options.quickFillHours || 6;
  const minSampleSize = options.minSampleSize || 5;

  const rateHistory = (data.rateHistory || []).map(normalizeRate).filter(r => r.currency && r.recordedTs);
  const episodes = buildOfferEpisodes(data.offers || [], data.loans || [], options);
  const reoffered = episodes.filter(e => e.reofferCount > 0);

  const details = reoffered.map((episode) => {
    const initial = episode.initialOffer;
    const firstReoffer = episode.chain[1];
    const finalOffer = episode.finalOffer;
    const startSnap = nearestSnapshot(rateHistory, episode.currency, initial.createdTs);
    const reofferSnap = nearestSnapshot(rateHistory, episode.currency, firstReoffer?.createdTs || null);

    const initialRate = initial.rate;
    const firstReofferRate = firstReoffer?.rate ?? initial.rate;
    const finalRate = finalOffer.rate;
    const firstCutPct = initialRate > 0 ? (initialRate - firstReofferRate) / initialRate : 0;
    const totalCutPct = initialRate > 0 ? (initialRate - finalRate) / initialRate : 0;
    const marketFrrMovePct = startSnap?.frr && reofferSnap?.frr
      ? (startSnap.frr - reofferSnap.frr) / startSnap.frr
      : null;

    const hoursBeforeReoffer = episode.firstReofferTs
      ? (episode.firstReofferTs - episode.startedTs) / 3600000
      : null;
    const hoursToFillAfterReoffer = episode.filled && episode.firstReofferTs
      ? (episode.matchedLoan.openedTs - episode.firstReofferTs) / 3600000
      : null;

    const quickFill = episode.filled && hoursToFillAfterReoffer !== null && hoursToFillAfterReoffer <= quickFillHours;
    const marketDropSupportsCut = marketFrrMovePct !== null && marketFrrMovePct >= firstCutPct * 0.8;
    const likelyHelpful = Boolean(quickFill && marketDropSupportsCut);
    const likelyHarmful = Boolean(
      (episode.filled && !marketDropSupportsCut) ||
      (!episode.filled) ||
      (hoursToFillAfterReoffer !== null && hoursToFillAfterReoffer > quickFillHours)
    );

    const grossRateSacrifice = episode.filled
      ? episode.amount * Math.max(0, initialRate - finalRate) * episode.period
      : 0;
    const netRateSacrifice = grossRateSacrifice * 0.85;

    return {
      currency: episode.currency,
      amount: episode.amount,
      period: episode.period,
      reofferCount: episode.reofferCount,
      hoursBeforeReoffer,
      hoursToFillAfterReoffer,
      filled: episode.filled,
      initialRate,
      finalRate,
      firstCutPct,
      totalCutPct,
      marketFrrMovePct,
      likelyHelpful,
      likelyHarmful,
      netRateSacrifice,
      initialOfferId: initial.offer_id,
      finalOfferId: finalOffer.offer_id,
      loanId: episode.matchedLoan?.loan_id || null,
    };
  }).filter(d => d.hoursBeforeReoffer === null || d.hoursBeforeReoffer >= minReofferAgeHours - 0.25);

  const helpfulCount = details.filter(d => d.likelyHelpful).length;
  const harmfulCount = details.filter(d => d.likelyHarmful).length;
  const filledCount = details.filter(d => d.filled).length;
  const quickFilledCount = details.filter(d => d.filled && d.hoursToFillAfterReoffer !== null && d.hoursToFillAfterReoffer <= quickFillHours).length;
  const totalSacrifice = details.reduce((sum, d) => sum + d.netRateSacrifice, 0);

  let recommendation = 'insufficient_data';
  let rationale = '樣本不足，先不要改策略。';

  if (details.length >= minSampleSize) {
    const helpfulRate = helpfulCount / details.length;
    const harmfulRate = harmfulCount / details.length;
    const quickFillRate = quickFilledCount / details.length;

    if (helpfulRate >= 0.6 && quickFillRate >= 0.6) {
      recommendation = 'keep_reoffer';
      rationale = '多數降息重掛後能在短時間成交，且市場利率下滑幅度大致支持這個降幅。';
    } else if (harmfulRate >= 0.5 || quickFillRate < 0.35) {
      recommendation = 'reconsider_reoffer';
      rationale = '降息後未明顯加快成交，或市場下滑幅度不足以支持降息，較像是犧牲利率並重排隊。';
    } else {
      recommendation = 'mixed';
      rationale = '有幫助但不穩定，建議改成條件式降息，而不是固定每 3 小時執行。';
    }
  }

  return {
    summary: {
      totalEpisodes: episodes.length,
      reofferedEpisodes: details.length,
      filledAfterReoffer: filledCount,
      quickFilledAfterReoffer: quickFilledCount,
      helpfulCount,
      harmfulCount,
      estimatedNetRateSacrifice: totalSacrifice,
      recommendation,
      rationale,
    },
    details,
    episodes,
  };
}

module.exports = {
  buildOfferEpisodes,
  analyzeReofferBenefit,
  nearestSnapshot,
};
