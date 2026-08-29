const baseUrl = (process.argv[2] || process.env.SMOKE_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

const endpoints = ['/api/health', '/api/auth/config'];
for (const endpoint of endpoints) {
  const response = await fetch(`${baseUrl}${endpoint}`);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${endpoint} returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  console.log(`OK ${endpoint} HTTP ${response.status}`);
}

const health = await (await fetch(`${baseUrl}/api/health`)).json();
if (health.status !== 'ok' || !health.timestamp) {
  throw new Error(`健康檢查回應缺少必要欄位: ${JSON.stringify(health)}`);
}
console.log(`健康檢查通過: activeEngineCount=${health.activeEngineCount ?? 'n/a'}, publicWsConnected=${health.publicWsConnected ?? 'n/a'}`);
