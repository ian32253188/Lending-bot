import os
import json
import urllib.request

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

def fetch_earliest(env, table, order_col):
    supabase_url = env.get('SUPABASE_URL')
    supabase_key = env.get('SUPABASE_KEY')
    url = f"{supabase_url}/rest/v1/{table}?select={order_col}&order={order_col}.asc&limit=1"
    req = urllib.request.Request(
        url,
        headers={'apikey': supabase_key, 'Authorization': f'Bearer {supabase_key}'}
    )
    try:
        with urllib.request.urlopen(req) as res:
            data = json.loads(res.read().decode('utf-8'))
            if data and len(data) > 0:
                return data[0].get(order_col)
    except Exception as e:
        return f"Error: {e}"
    return None

def fetch_total_count(env, table):
    supabase_url = env.get('SUPABASE_URL')
    supabase_key = env.get('SUPABASE_KEY')
    # Use Prefer header to count
    url = f"{supabase_url}/rest/v1/{table}?select=count"
    req = urllib.request.Request(
        url,
        headers={
            'apikey': supabase_key,
            'Authorization': f'Bearer {supabase_key}',
            'Prefer': 'count=exact'
        }
    )
    try:
        with urllib.request.urlopen(req) as res:
            content_range = res.getheader('Content-Range')
            if content_range:
                # Format: "0-0/total"
                return content_range.split('/')[-1]
    except Exception:
        pass
    return "Unknown"

def main():
    env = load_env()
    
    tables = {
        "ibrr_history": "recorded_at",
        "rate_history": "recorded_at",
        "funding_offers": "created_at",
        "funding_loans": "opened_at",
        "earnings": "earned_at",
        "operation_logs": "created_at"
    }
    
    print("=== Supabase Earliest Record Check ===")
    for table, col in tables.items():
        earliest = fetch_earliest(env, table, col)
        total = fetch_total_count(env, table)
        if earliest:
            print(f"  * Table '{table}': Earliest record on {earliest} (Total rows: {total})")
        else:
            print(f"  * Table '{table}': No records found")

if __name__ == "__main__":
    main()
