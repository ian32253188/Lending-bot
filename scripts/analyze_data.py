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
    url = f"{supabase_url}/rest/v1/rate_history?select=*&order=recorded_at.desc&limit=1000"
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
        # rate_history 是目前保留的公開市場歷史來源；IBRR 歷史表已移除。
        frrs = [r['frr'] for r in records if r.get('frr') is not None]
        avg_rates = [r['avg_rate'] for r in records if r.get('avg_rate') is not None]
        high_rates = [r['high_rate'] for r in records if r.get('high_rate') is not None]
        low_rates = [r['low_rate'] for r in records if r.get('low_rate') is not None]

        if not frrs:
            print(f"=== {cur} LENDING DATA ANALYSIS ({len(records)} records) ===")
            print("  * No FRR data available.")
            print()
            continue
        
        # 轉成 numpy 陣列
        frrs = np.array(frrs)
        avg_rates = np.array(avg_rates)
        high_rates = np.array(high_rates)
        low_rates = np.array(low_rates)
        
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
        if len(avg_rates):
            print(f"  * Mean Market Rate APY: {np.mean(avg_rates) * 365 * 100:.3f}%")
        if len(high_rates) and len(low_rates):
            print(f"  * Market Rate Range APY: {np.min(low_rates) * 365 * 100:.3f}% ~ {np.max(high_rates) * 365 * 100:.3f}%")
        print(f"  * FRR Rate Trend: Rising {rising_count} times | Falling {falling_count} times | Stable {stable_count} times")
        print()

if __name__ == "__main__":
    analyze()
