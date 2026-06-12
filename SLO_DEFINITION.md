# Lending Bot Service Level Objectives (SLO) 定義文件

本文件依據 SRE (Site Reliability Engineering) 規範，定義本放貸系統的服務品質指標 (SLI) 與服務品質目標 (SLO)。所有指標均透過 `/metrics` 端點暴露，並可被 Prometheus 收集。

---

## 1. 服務品質指標 (SLI) 與目標 (SLO)

### SLO 1: API 呼叫成功率 (Availability SLO)
*   **定義 (SLI)**：`(成功回應的 API 請求數) / (總 API 請求數)`
*   **Prometheus 公式**：
    ```promql
    sum(rate(lending_bot_api_requests_total{status=~"2.."}[5m])) 
    / 
    sum(rate(lending_bot_api_requests_total[5m]))
    ```
*   **目標 (SLO)**：**99.9%** (過去 30 天滾動視窗)
*   **說明**：與 Bitfinex 的 API 互動必須保持極高的成功率，以防放貸機會流失。排除因 Bitfinex 停機或維護所造成的 5xx 錯誤。

### SLO 2: API 響應時間 (Latency SLO)
*   **定義 (SLI)**：`(響應時間 <= 1.0 秒的 API 請求數) / (總 API 請求數)`
*   **Prometheus 公式**：
    ```promql
    sum(rate(lending_bot_request_duration_seconds_bucket{le="1"}[5m])) 
    / 
    sum(rate(lending_bot_request_duration_seconds_count[5m]))
    ```
*   **目標 (SLO)**：**95%** 的請求應在 1.0 秒內完成。
*   **說明**：保證在網路波動時能快速回傳，避免防釣魚阻力牆偵測失效。

### SLO 3: 決策心跳間隔 (Freshness SLO)
*   **定義 (SLI)**：放貸決策核心 `_decisionCycle` 的執行間隔時間。
*   **Prometheus 公式**：
    ```promql
    time() - lending_bot_last_decision_timestamp_seconds
    ```
*   **目標 (SLO)**：每種幣種的心跳時間差應 **< 600 秒 (10 分鐘)**。
*   **說明**：若超過 10 分鐘沒有進行任何決策計算，表示後端引擎或連線掛掉，應觸發 PagerDuty/Telegram 告警。

---

## 2. 監控指標對照表 (Metrics Directory)

| 指標名稱 | 類型 | 標籤 (Labels) | 說明 |
| :--- | :--- | :--- | :--- |
| `lending_bot_balance_usd` | Gauge | `currency`, `type` | 帳戶餘額 (type 為 `total` 或 `available`) |
| `lending_bot_active_loans_count` | Gauge | `currency` | 當前已成交且放貸中的合約數量 |
| `lending_bot_active_loans_amount` | Gauge | `currency` | 當前已成交且放貸中的總金額 |
| `lending_bot_api_requests_total` | Counter | `method`, `endpoint`, `status` | 呼叫 Bitfinex API 總次數 |
| `lending_bot_api_errors_total` | Counter | `method`, `endpoint`, `error_type` | 呼叫 Bitfinex API 失敗次數 |
| `lending_bot_request_duration_seconds`| Histogram| `method`, `endpoint` | API 請求耗時分佈 |
| `lending_bot_last_decision_timestamp_seconds`| Gauge| `currency` | 放貸核心最後一次執行決策的時間戳 |
