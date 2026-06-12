import os
import json
import urllib.request
import numpy as np

def load_env():
    env_vars = {}
    env_path = os.path.join(os.path.dirname(__file__), '..', '.env')
    if os.path.exists(env_path):
        with open(env_path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#'):
                    key, val = line.split('=', 1)
                    env_vars[key.strip()] = val.strip()
    return env_vars

def fetch_data(env):
    supabase_url = env.get('SUPABASE_URL')
    supabase_key = env.get('SUPABASE_KEY')
    url = f"{supabase_url}/rest/v1/ibrr_history?select=*&order=recorded_at.desc&limit=1000"
    req = urllib.request.Request(
        url,
        headers={'apikey': supabase_key, 'Authorization': f'Bearer {supabase_key}'}
    )
    with urllib.request.urlopen(req) as res:
        return json.loads(res.read().decode('utf-8'))

def analyze():
    env = load_env()
    data = fetch_data(env)
    
    # 按照幣種分類
    groups = {}
    for d in data:
        cur = d.get('currency')
        if not cur:
            continue
        if cur not in groups:
            groups[cur] = []
        groups[cur].append(d)
        
    for cur, records in groups.items():
        # 提取欄位
        frrs = [r['frr'] for r in records if r.get('frr') is not None]
        ibrrs = [r['ibrr'] for r in records if r.get('ibrr') is not None]
        eqs = [r['equilibrium_rate'] for r in records if r.get('equilibrium_rate') is not None]
        ratios = [r['demand_supply_ratio'] for r in records if r.get('demand_supply_ratio') is not None]
        bids = [r['best_bid_rate'] for r in records if r.get('best_bid_rate') is not None]
        asks = [r['best_ask_rate'] for r in records if r.get('best_ask_rate') is not None]
        prices = [r['last_price'] for r in records if r.get('last_price') is not None]
        
        # 轉成 numpy 陣列
        frrs = np.array(frrs)
        ibrrs = np.array(ibrrs)
        eqs = np.array(eqs)
        ratios = np.array(ratios)
        bids = np.array(bids)
        asks = np.array(asks)
        prices = np.array(prices)
        
        # 利率走勢變化分析 (時序是降序，所以前減後)
        deltas = []
        for i in range(len(frrs) - 1):
            deltas.append(frrs[i] - frrs[i+1])
        deltas = np.array(deltas)
        
        rising_count = np.sum(deltas > 0)
        falling_count = np.sum(deltas < 0)
        stable_count = np.sum(deltas == 0)
        
        print(f"=== {cur} LENDING DATA ANALYSIS ({len(records)} records) ===")
        print(f"  * Mean FRR Annual Rate (APY): {np.mean(frrs) * 365 * 100:.3f}% (Range: {np.min(frrs)*365*100:.3f}% ~ {np.max(frrs)*365*100:.3f}%)")
        print(f"  * Mean Best Bid APY: {np.mean(bids) * 365 * 100:.3f}%")
        print(f"  * Mean Best Ask APY: {np.mean(asks) * 365 * 100:.3f}%")
        print(f"  * Mean Equilibrium Rate APY: {np.mean(eqs) * 365 * 100:.3f}%")
        print(f"  * Mean Calculated Optimal Rate (IBRR APY): {np.mean(ibrrs) * 365 * 100:.3f}%")
        print(f"  * Mean Last Price APY: {np.mean(prices) * 365 * 100:.3f}%")
        print(f"  * Mean Demand/Supply Ratio: {np.mean(ratios):.4f}")
        print(f"  * FRR Rate Trend: Rising {rising_count} times | Falling {falling_count} times | Stable {stable_count} times")
        print()

if __name__ == "__main__":
    analyze()
