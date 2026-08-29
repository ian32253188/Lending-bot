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

def fetch_supabase_data(env):
    raise RuntimeError("IBRR 歷史資料表已移除；此舊版 ML 訓練流程已停用。")

def sigmoid(x):
    return 1 / (1 + np.exp(-np.clip(x, -50, 50)))

def relu(x):
    return np.maximum(0, x)

def train_mlp():
    print("[INFO] IBRR 歷史資料表已移除，舊版 ML 訓練流程不再執行。")
    return

    print(f"[INFO] Loaded {len(raw_data)} data snapshots for training.")
    
    # 1. 整理特徵與標記
    # 特徵: [frr, spread, obi, frr_slope, volume_slope, spread_slope, demand_supply_ratio, last_price]
    X_raw = []
    Y_raw = []
    
    # 計算時序特徵
    for i in range(len(raw_data) - 5 - 1):
        window = raw_data[i+1 : i+6]  # 最近 5 筆
        current = raw_data[i]         # 當前筆
        future = raw_data[i-1]        # 未來一筆 (預測目標)
        
        # 確保 frr 存在且不為 None
        curr_frr = current.get('frr')
        fut_frr = future.get('frr')
        if curr_frr is None or fut_frr is None:
            continue
            
        # 計算 Slope
        frrs = [w.get('frr') for w in window if w.get('frr') is not None]
        if len(frrs) < 5:
            continue
        frr_slope = np.polyfit(range(5), frrs, 1)[0]
        
        total_demand = current.get('total_demand') if current.get('total_demand') is not None else 0
        total_supply = current.get('total_supply') if current.get('total_supply') is not None else 0
        obi = (total_demand - total_supply) / (total_demand + total_supply + 1)
        
        best_ask = current.get('best_ask_rate') if current.get('best_ask_rate') is not None else curr_frr
        best_bid = current.get('best_bid_rate') if current.get('best_bid_rate') is not None else curr_frr
        spread = best_ask - best_bid
        
        ratio = current.get('demand_supply_ratio')
        ds_ratio = ratio if ratio is not None else 1.0
        
        last_price = current.get('last_price')
        l_price = last_price if last_price is not None else curr_frr
        
        x = [
            curr_frr,
            spread,
            obi,
            frr_slope,
            0.0, # volume slope
            0.0, # spread slope
            ds_ratio,
            l_price
        ]
        
        # 標記：未來利率變化
        future_delta = fut_frr - curr_frr
        # 信心度：未來是否真的上漲 (1 = 上漲，0 = 持平/下跌)
        confidence_label = 1.0 if future_delta > 0 else 0.0
        
        X_raw.append(x)
        Y_raw.append([future_delta, confidence_label])

    X_raw = np.array(X_raw)
    Y_raw = np.array(Y_raw)
    
    if len(X_raw) < 10:
        print("[ERROR] Data size too small to train model.")
        return

    # 2. 特徵標準化
    means = np.mean(X_raw, axis=0)
    stds = np.std(X_raw, axis=0)
    stds[stds == 0] = 1.0 # 避免除以 0
    X_scaled = (X_raw - means) / stds

    # 3. 初始化 2 層 MLP (D_in=8, H=8, D_out=2)
    np.random.seed(42)
    W1 = np.random.randn(8, 8) * 0.1
    b1 = np.zeros(8)
    W2 = np.random.randn(2, 8) * 0.1
    b2 = np.zeros(2)

    # 4. 訓練迴圈 (NumPy Backpropagation)
    lr = 0.01
    epochs = 200
    print("[INFO] Training Neural Network...")
    for epoch in range(epochs):
        loss_epoch = 0
        for i in range(len(X_scaled)):
            x = X_scaled[i]
            y = Y_raw[i]
            
            # Forward pass
            z1 = np.dot(W1, x) + b1
            h = relu(z1)
            z2 = np.dot(W2, h) + b2
            
            # out[0] is delta, out[1] is confidence logit
            pred_delta = z2[0]
            pred_conf_prob = sigmoid(z2[1])
            
            # Loss computation
            loss = 0.5 * (pred_delta - y[0])**2 - (y[1] * np.log(pred_conf_prob + 1e-15) + (1 - y[1]) * np.log(1 - pred_conf_prob + 1e-15))
            loss_epoch += loss
            
            # Backward pass (gradients)
            dz2 = np.zeros(2)
            dz2[0] = pred_delta - y[0]
            dz2[1] = pred_conf_prob - y[1]
            
            dW2 = np.outer(dz2, h)
            db2 = dz2
            
            dh = np.dot(W2.T, dz2)
            dz1 = dh * (z1 > 0) # ReLU derivative
            
            dW1 = np.outer(dz1, x)
            db1 = dz1
            
            # Update weights
            W1 -= lr * dW1
            b1 -= lr * db1
            W2 -= lr * dW2
            b2 -= lr * db2
            
        if epoch % 50 == 0:
            print(f"Epoch {epoch}/{epochs} | Avg Loss: {loss_epoch / len(X_scaled):.6f}")

    # 5. 導出權重
    weights_json = {
        "means": list(means),
        "stds": list(stds),
        "W1": W1.tolist(),
        "b1": b1.tolist(),
        "W2": W2.tolist(),
        "b2": b2.tolist()
    }
    
    output_path = os.path.join(os.path.dirname(__file__), '..', 'server', 'services', 'engine', 'model_weights.json')
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(weights_json, f, indent=2)
        
    print(f"[SUCCESS] Model weights trained successfully and saved to: {output_path}")

if __name__ == "__main__":
    train_mlp()
