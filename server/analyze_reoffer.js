require('dotenv').config();

const db = require('./services/database');
const { analyzeReofferBenefit } = require('./services/analysis/reoffer');

async function fetchAll(table, orderColumn) {
  const supabase = db.getSupabase();
  if (!supabase) {
    throw new Error('Supabase 未設定，請先提供 .env 中的 SUPABASE_URL / SUPABASE_KEY');
  }

  const pageSize = 1000;
  let from = 0;
  const rows = [];

  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .order(orderColumn, { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }

  return rows;
}

function printSummary(result) {
  const s = result.summary;
  console.log('=== 自動降息重掛效益分析 ===');
  console.log(`樣本總 episode: ${s.totalEpisodes}`);
  console.log(`有發生降息重掛: ${s.reofferedEpisodes}`);
  console.log(`降息後最終成交: ${s.filledAfterReoffer}`);
  console.log(`降息後 ${6} 小時內成交: ${s.quickFilledAfterReoffer}`);
  console.log(`判定可能有幫助: ${s.helpfulCount}`);
  console.log(`判定可能有害: ${s.harmfulCount}`);
  console.log(`估計稅後讓利: ${s.estimatedNetRateSacrifice.toFixed(4)}`);
  console.log(`建議: ${s.recommendation}`);
  console.log(`結論: ${s.rationale}`);

  const topHarmful = result.details
    .filter(x => x.likelyHarmful)
    .sort((a, b) => (b.netRateSacrifice || 0) - (a.netRateSacrifice || 0))
    .slice(0, 5);

  if (topHarmful.length > 0) {
    console.log('\n最值得檢查的疑似無效重掛案例:');
    for (const item of topHarmful) {
      console.log(
        `- ${item.currency} offer#${item.initialOfferId} -> #${item.finalOfferId}` +
        ` | 降幅 ${(item.totalCutPct * 100).toFixed(2)}%` +
        ` | ${item.filled ? `重掛後 ${item.hoursToFillAfterReoffer?.toFixed(2)}h 成交` : '尚未找到成交'}` +
        ` | 估計稅後讓利 ${item.netRateSacrifice.toFixed(4)}`
      );
    }
  }
}

async function main() {
  const jsonOnly = process.argv.includes('--json');

  const [offers, loans, rateHistory] = await Promise.all([
    fetchAll('funding_offers', 'created_at'),
    fetchAll('funding_loans', 'opened_at'),
    fetchAll('rate_history', 'recorded_at'),
  ]);

  const result = analyzeReofferBenefit({ offers, loans, rateHistory });

  if (jsonOnly) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  printSummary(result);
}

main().catch((err) => {
  console.error('分析失敗:', err.message || err);
  process.exit(1);
});
