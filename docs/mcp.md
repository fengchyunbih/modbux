# Modbux MCP 使用說明

Modbux 內嵌 MCP server，讓本機的 AI agent 操作 Client 與 Server。設計見 `docs/design/json-config-and-mcp.md`。

## 啟用

1. Home 畫面按設定（`home-settings-btn`），開啟 MCP 設定頁。
2. 打開「Enable MCP」。狀態顯示 Running 即表示在監聽。
3. 預設關閉。「Allow writes to devices」是另一個開關，關閉時所有會寫入裝置的 tool 一律拒絕。
4. MCP 只在 main window 開著時運作。

## URL 與 token

- URL：`http://127.0.0.1:15502/mcp`（只綁 127.0.0.1，port 固定）。
- 每個請求都要帶 `Authorization: Bearer <token>`。token 顯示在設定頁，按「Regenerate token」會換一個，舊的立即失效。
- token 存在 `<userData>/mcp.json`（權限 0600）。`<userData>` 依平台：
  - Linux：`~/.config/Modbux`（從原始碼執行時為 `~/.config/modbux`）
  - macOS：`~/Library/Application Support/Modbux`
  - Windows：`%APPDATA%\Modbux`

## Claude Code（HTTP）

設定頁「Claude Code」欄位有完整指令，token 已帶入：

```sh
claude mcp add --transport http modbux http://127.0.0.1:15502/mcp --header "Authorization: Bearer <token>"
```

## stdio shim

給只支援 stdio 的 MCP client。shim 不宣告任何 tool，只把訊息轉送到上面的 HTTP 端點，所以端點有什麼，client 就看到什麼。

- 建置輸出：`out/main/mcpStdio.js`（`electron-vite build` 產生）。
- 從原始碼執行：`node out/main/mcpStdio.js`。
- 打包後的 app：`ELECTRON_RUN_AS_NODE=1 <Modbux 執行檔> <resources>/app.asar/out/main/mcpStdio.js`。
- 設定頁會顯示本機實際的路徑與完整的 `claude mcp add modbux ... -- ...` 指令。
- token 取得順序：環境變數 `MODBUX_MCP_TOKEN`，否則讀 `<userData>/mcp.json`。以 `--user-data-dir` 啟動 Modbux 時，用 `MODBUX_USER_DATA` 指向該目錄。
- 端點網址預設為 `http://127.0.0.1:15502/mcp`，可用 `MODBUX_MCP_URL` 覆寫。
- Modbux 沒開或 MCP 沒啟用時，shim 對每個請求回 JSON-RPC 錯誤 `-32000`，訊息以 `Modbux endpoint:` 開頭。

## Prompts

三個 prompt 都只有一個必填參數 `pointTable`：點表的文字（從規格書貼上的列、CSV 或 Markdown 表格皆可）。

- `point_table_to_client`：讀 `client_get_config`，必要時 `client_set_connection`，先 `client_apply_point_table` 做 `dryRun: true` 並修正被拒絕的點，再正式套用，接著 `client_connect`、`client_read_points`。用數值合理性檢查 word order 與比例；數值不合理時，依 `modbux://encoding` 試其他 byte order。
- `point_table_to_simulator`：`server_list` / `server_create` 建立 Server，`server_apply_point_table` 先 `dryRun` 再套用，每個點給固定值或產生器範圍，最後用 `server_get_values` 確認。
- `closed_loop_test`：用點表建立 Server，把 Client 指向 `127.0.0.1` 與該 Server 的 port，套用同一份點表，讀取後逐點與 `server_get_values` 比對並回報不一致的點。通過只代表兩端一致，不代表點表與真實裝置相符。

## 掃描 tools

兩個都是 `readOnlyHint`，掃描期間 Modbux 視窗會顯示進度與結果。Poll、讀取、寫入或另一個掃描進行中時拒絕。超過 120 秒會停止並回報已找到的部分（`stopped: true`）。

- `client_scan_registers`：`startAddress`（PDU 位址）、`count`（1 到 10000）、`registerType`（省略時用 Client 目前的類型）、`chunkSize`（預設 100）、`timeoutMs`（100 到 5000，預設 500）。回傳非零的 word（或為 1 的 bit）。
- `client_scan_unit_ids`：`startUnitId`、`endUnitId`、`registerTypes`（預設 `holding_registers`）、`address`（預設 0）、`length`（預設 1）、`timeoutMs`。unit id 數量乘以 register type 數量最多 1000。回傳有回應的 unit，回 Modbus exception 也算有回應。
