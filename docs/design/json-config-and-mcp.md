# JSON 設定檔與 MCP：目標與大方向

狀態：草案，待對齊。對齊前不動工。

## 目標

依優先順序：

1. **AI 連線實機讀值。** 拿到點表（例如電表點位表）後，AI 透過 MCP 建立對應的 Client 設定，連上裝置讀回各點的值，並用讀值檢查 word order 與比例是否正確。這是剛需。
2. **AI 建立 Server 模擬器。** AI 透過 MCP 依點表建立 Server，給出固定值或變動範圍，當作模擬器使用。
3. **閉環測試。** 同一個 app 裡的 Client 連到自己的 Server，驗證模擬器的點表與 Client 的 mapping 一致。屬於附加功能。
4. **JSON 設定檔完整化。** Server 與 Client 的設定都能以 JSON 完整匯出、匯入，包含連線設定。

MCP 以本機 Local 方式運作。

## 現況

- 兩邊都已有 JSON 匯出／匯入，但只能在 renderer 裡用：Client 在 `RegisterGridToolbar/SaveButton.tsx` 與 `LoadButton.tsx`，Server 在 `server/OpenSaveClear.tsx`。寫檔走 `downloadJson`，讀檔走 `<input type=file>`。版本遷移在 `@shared` 的 `migrateClientConfig` 與 `migrateServerConfig`。
- Client 檔（`RegisterMapConfigSchema`）不含連線設定與讀取設定，unitId 只出現在檔名。Server 檔（`ServerConfigSchema`）不含 port、serverMode、serialConfig，一次只存一台。
- 設定以 renderer 的 zustand store 為準，持久化在 localStorage。main 的 `AppState` 與 `ModbusServer` 是 renderer 透過 IPC 推過去的副本，main 不讀寫設定檔。
- 比例與內插的換算只在 renderer 的 `columns/convertedValue.tsx`。`ModbusClient._read` 不回傳資料，讀值只以 `register_data` 事件送給 main window。
- Byte order 是整份設定共用一個 `littleEndian`，語意是 word swap（ABCD 或 CDAB），見 `src/shared/littleBigEndian.md`。

## 架構決策

### MCP 的變更寫到哪裡

MCP server 放在 main。

- **設定變更**（連線、mapping、server registers）由 main 轉成命令送到 renderer，交給 store 既有的 action 執行，再把結果回傳 main。畫面、undo、持久化、同步回 main 都沿用既有路徑。每次 MCP 變更是一個 undo 步驟。
- **讀寫裝置**直接呼叫 main 的 `ModbusClient`。

不採用的作法：

- MCP 直接改 main 的狀態。main 只是副本，renderer 下一次同步就會蓋掉，畫面與 undo 也不知道有這次變更。
- 把設定的真實來源搬到 main。這是 headless 模式的前提，但要重寫 store、undo、遷移三層，列為長期選項。

### JSON 與 MCP 的關係

Save／Open 按鈕的邏輯抽成共用函式，按鈕與 MCP tool 呼叫同一份。MCP 交換的是 JSON 內容，不是檔案路徑：匯出回傳 JSON 字串，匯入接收 JSON 字串，存檔由 agent 自己決定。main 不開放寫入任意路徑。

### 傳輸

- 主要：main 內嵌 MCP Streamable HTTP server，只綁 `127.0.0.1`，Bearer token 認證，驗證 `Origin` header（MCP 規範要求，見 <https://modelcontextprotocol.io/specification/2025-06-18/basic/transports>）。
- 補充：stdio shim，給只支援 stdio 的 MCP client 使用，轉送到上面的 HTTP 端點。
- 預設關閉。「啟用 MCP」與「允許寫入裝置」是兩個開關，寫入類 tool 標註 `destructiveHint`。

## MCP 介面草案

設計原則：

- 粗粒度、批次：一次套用一整份點表。
- `dryRun` 與逐點報告：每個點回報 accepted 或 rejected，rejected 附原因。
- 確定性換算由 tool 做：位址記法（`pdu0`、`one_based`、`modicon`）由 tool 換算成 PDU 位址；Server 端接受工程值加比例，由 tool 算出 raw 值。
- 輸入 schema 沿用 `@shared` 的 Zod schema。

Client tools：`client_get_config`、`client_set_connection`、`client_apply_point_table`、`client_connect`、`client_disconnect`、`client_read_points`、`client_write`、`client_export_config`、`client_import_config`。

Server tools：`server_list`、`server_create`、`server_delete`、`server_apply_point_table`、`server_set_values`、`server_get_values`、`server_export_config`、`server_import_config`。

Resources：設定檔的 JSON Schema、目前的 Client 設定、Server 清單與各台設定、編碼說明（data type 寬度、word order、address base）。

Prompts：`point_table_to_client`、`point_table_to_simulator`、閉環測試。

## 步驟

每一步是一個 PR，遵守 CONTRIBUTING 的「一個 PR 只處理一件事」。

| 步驟 | 內容                                                                          | 服務的目標                       |
| ---- | ----------------------------------------------------------------------------- | -------------------------------- |
| 1    | 存檔／讀檔邏輯抽成 shared 函式與 store action，行為不變                       | 4，也是 MCP 套用點表與匯出的基礎 |
| 2    | Client 設定檔升版加入連線與讀取設定，Server 設定檔升版加入 port，含遷移與測試 | 4                                |
| 3    | `_read` 回傳資料；比例與內插換算移到 shared                                   | 1 的前提                         |
| 4    | main 到 renderer 的命令通道                                                   | 1、2 的前提                      |
| 5    | MCP server 骨架與設定頁，加上 Client tools                                    | 1                                |
| 6    | Server tools                                                                  | 2                                |
| 7    | 閉環測試 prompt、stdio shim、scan tools                                       | 3                                |

步驟 1 到 2 與步驟 3 到 4 互不依賴，可以平行進行。

## 已知限制

點表裡有這些內容時，tool 回報 rejected，不默默套用：

- byte swap（BADC、DCBA），或同一份點表內 word order 不一致。
- 同一條 RS485 上的多個 unit id：一份 Client 設定只有一個 unitId。

## 待對齊

1. **回饋 upstream，或只留在 fork？** 步驟 5 要新增 `@modelcontextprotocol/sdk`，產生 JSON Schema 要新增 `zod-to-json-schema` 或升級 zod v4。CONTRIBUTING 規定新依賴要先在 upstream（`ploxc/modbux`）討論；只留在 fork 則不受此限。
2. **byte swap 與逐點 word order 要不要支援？** 要的話是設定檔格式與編碼層的變更，應排在步驟 2 一併處理。
3. **要不要 project 檔**（一個 Client 加多台 Server 存成一份）？
4. **MCP 要求 main window 開著**，這個前提是否可接受？
5. **MCP 的 port** 固定，還是可在設定頁調整？
6. **本文件的語言。** 專案規則是 repository 內一律英文，本草案以正體中文撰寫以便對齊；合併前是否要改寫成英文？
