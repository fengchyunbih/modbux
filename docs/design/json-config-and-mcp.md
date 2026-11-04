# JSON 設定檔與 MCP：目標與大方向

狀態：方向已對齊，見「已決定」。只在 fork 開發，不回饋 upstream。

## 目標

依優先順序：

1. **AI 連線實機讀值。** 拿到點表（例如電表點位表）後，AI 透過 MCP 建立對應的 Client 設定，連上裝置讀回各點的值，並用讀值檢查 word order 與比例是否正確。這是剛需。
2. **AI 建立 Server 模擬器。** AI 透過 MCP 依點表建立 Server，給出固定值或變動範圍，當作模擬器使用。
3. **閉環測試。** 同一個 app 裡的 Client 連到自己的 Server，驗證模擬器的點表與 Client 的 mapping 一致。屬於附加功能。
4. **JSON 設定檔完整化。** Server 與 Client 的設定都能以 JSON 完整匯出、匯入，包含連線設定。另有 project 檔，把一個 Client 與多台 Server 存成一份。

MCP 以本機 Local 方式運作。

## 用語

- **main**：Electron 的主程序，程式碼在 `src/main`。負責 Modbus 連線、Server、IPC。不是 git 分支。
- **renderer**：Electron 的畫面程序，程式碼在 `src/renderer`。React UI 與 zustand store 在這裡。
- **main window**：主視窗。另一個視窗是 split view 拆出來的 server window。
- **git 分支**：本文件提到分支時一律寫全名，例如 `main` 分支、`feature/json-config-and-mcp` 分支。

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
- Port 固定為 `15502`，不提供設定。理由見「已決定」。
- 補充：stdio shim，給只支援 stdio 的 MCP client 使用，轉送到上面的 HTTP 端點。
- 預設關閉。「啟用 MCP」與「允許寫入裝置」是兩個開關，寫入類 tool 標註 `destructiveHint`。
- MCP 只在 main window 開著時運作；沒開時，tool 回傳錯誤。

## MCP 介面草案

設計原則：

- 粗粒度、批次：一次套用一整份點表。
- `dryRun` 與逐點報告：每個點回報 accepted 或 rejected，rejected 附原因。
- 確定性換算由 tool 做：位址記法（`pdu0`、`one_based`、`modicon`）由 tool 換算成 PDU 位址；Server 端接受工程值加比例，由 tool 算出 raw 值。
- 輸入 schema 沿用 `@shared` 的 Zod schema。

Client tools：`client_get_config`、`client_set_connection`、`client_apply_point_table`、`client_connect`、`client_disconnect`、`client_read_points`、`client_write`、`client_export_config`、`client_import_config`。

Server tools：`server_list`、`server_create`、`server_delete`、`server_apply_point_table`、`server_set_values`、`server_get_values`、`server_export_config`、`server_import_config`。

Project tools：`project_export`、`project_import`。

Resources：設定檔的 JSON Schema、目前的 Client 設定、Server 清單與各台設定、編碼說明（data type 寬度、word order、address base）。

Prompts：`point_table_to_client`、`point_table_to_simulator`、閉環測試。

## 步驟

每一步是一個 PR，遵守 CONTRIBUTING 的「一個 PR 只處理一件事」。

| 步驟 | 內容                                                                                                  | 服務的目標                       |
| ---- | ----------------------------------------------------------------------------------------------------- | -------------------------------- |
| 1    | 存檔／讀檔邏輯抽成 shared 函式與 store action，行為不變                                               | 4，也是 MCP 套用點表與匯出的基礎 |
| 2    | Client 設定檔升版加入連線與讀取設定，Server 設定檔升版加入 port，兩者都預留 `byteSwap`；含遷移與測試  | 4                                |
| 3    | Project 檔：一個 Client 設定、多台 Server 設定、serverMode 與 serialConfig，存成一份；UI 加匯出與匯入 | 4                                |
| 4    | `_read` 回傳資料；比例與內插換算移到 shared                                                           | 1 的前提                         |
| 5    | main 到 renderer 的命令通道                                                                           | 1、2 的前提                      |
| 6    | Byte swap：`byteSwap` 開放 `true`，Client 與 Server 的 byte order 選項改成 ABCD、CDAB、BADC、DCBA     | 1                                |
| 7    | MCP server 骨架與設定頁，加上 Client tools                                                            | 1                                |
| 8    | Server tools 與 Project tools                                                                         | 2                                |
| 9    | 閉環測試 prompt、stdio shim、scan tools                                                               | 3                                |

步驟 1 到 3 與步驟 4 到 5 互不依賴，可以平行進行。步驟 6 依賴步驟 2 預留的欄位。

## Byte swap

- **表示法。** 保留 `littleEndian`（word swap），新增 `byteSwap`（每個 16-bit word 內的高低 byte 對調）。兩者組合成四種順序：

  | `littleEndian` | `byteSwap` | 順序 |
  | -------------- | ---------- | ---- |
  | `false`        | `false`    | ABCD |
  | `true`         | `false`    | CDAB |
  | `false`        | `true`     | BADC |
  | `true`         | `true`     | DCBA |

  `littleEndian` 不改名，舊檔與 localStorage 不需要遷移。

- **步驟 2 先預留。** `byteSwap` 選填，沒寫等於 `false`，schema 只接受 `false`。設定檔的 schema 是 `z.object`，會丟掉不認得的欄位；預留之後，步驟 6 開放 `true` 時不必再升版，未開放的版本讀到 `true` 會報錯並拒絕載入，不會照 ABCD 或 CDAB 默默解錯。
- **只套用在 32 位元與 64 位元類型：** `int32`、`uint32`、`float`、`unix`、`int64`、`uint64`、`double`、`datetime`。`int16`、`uint16`、`bitmap`、`utf8` 不受影響。
- **要改的編解碼位置：** `createRegisters`（`shared/encoding.ts`）、`convertRegisterData`（`shared/conversion.ts`）、`foldWordIntoComposite`（`renderer/src/context/server.zustand.helpers.ts`）。byte 對調寫成一個 shared 函式，三處共用。
- **工作量的大宗是傳遞路徑：** `byteSwap` 要沿 `littleEndian` 走過的路走一遍，包括 Client 的 registerConfig、`AppState`、Server store、`set_server_endianness` 的 schema、`registry.ts`、`valueGenerator.ts`、localStorage 的 schema、undo、設定檔。
- **測試：** 四種順序在每個 32 與 64 位元類型上編碼後解碼還原；master 寫入單一 word 後重算的值；一條 e2e。

## 已知限制

點表裡有這些內容時，tool 回報 rejected，不默默套用：

- 同一份點表內 byte order 不一致：一份設定只有一個 byte order。
- 16 位元類型或 `utf8` 的 byte swap：`byteSwap` 只套用在 32 與 64 位元類型。
- 步驟 6 完成前的 byte swap（BADC、DCBA）。
- 同一條 RS485 上的多個 unit id：一份 Client 設定只有一個 unitId。

## 已決定

1. **只留在 fork，不回饋 upstream。** CONTRIBUTING 要求新依賴先在 upstream 討論，這條在 fork 不適用。步驟 7 新增 `@modelcontextprotocol/sdk`；產生 JSON Schema 新增 `zod-to-json-schema` 或升級 zod v4，到該步驟時再選。
2. **Byte swap 要做，逐點 byte order 不做。** 步驟 2 預留欄位，步驟 6 實作，排在 MCP 之前；只套用在 32 與 64 位元類型。見「Byte swap」。
3. **做 project 檔。** 排在步驟 3。
4. **MCP 運作時 main window 必須開著。**
5. **MCP port 固定為 `15502`。**
   - 不在 `findAvailablePort` 自動配給 Modbus server 的範圍（`502` 到 `10502`），Modbux 自己開的 server 不會佔到它。
   - 低於 Linux 的 ephemeral port 範圍：本機 `cat /proc/sys/net/ipv4/ip_local_port_range` 印出 `32768	60999`。也低於 Windows 與 macOS 預設的 dynamic port 範圍 `49152` 到 `65535`（Windows 見 <https://learn.microsoft.com/en-us/troubleshoot/windows-server/networking/default-dynamic-port-range-tcpip-chang>）。對外連線的來源 port 不會佔到它。
   - 不在本機 `/etc/services`：`grep 15502 /etc/services` 沒有輸出。
   - 被佔用時 MCP 不啟動，設定頁顯示錯誤，不自動改用別的 port，因為 MCP client 端寫死了這個 URL。
   - 使用者手動把 Modbus server 的 port 設成 `15502` 時，要拒絕。
6. **文件使用正體中文。**
7. **步驟 2 的設定檔格式。** Client 檔升到 v3，新增選填的 `connectionConfig`（`ConnectionConfigSchema`）與 `registerConfig`（`RegisterConfigSchema` 去掉 `littleEndian`，byte order 仍放在最上層）。Server 檔升到 v4，新增選填的 `port`。兩者都有 `byteSwap`，只接受 `false`。
   - 舊檔沒有這些欄位，開檔時沿用目前 store 裡的值，不套用預設值：開一份 v2 的 Client 檔不會改掉使用者現在的連線設定。v2 到 v3、v3 到 v4 的遷移會丟掉手改舊檔裡多出來的這些欄位。
   - 開 v3 Client 檔時，連線設定與目前不同而 Client 正連著線，整份拒絕；main 拒絕其中一個欄位或 mapping 時，已寫入的欄位還原。
   - 開 v4 Server 檔時，port 走 `setPort`；被拒絕時照樣載入其餘內容並提示。RTU 模式不套用 port。復原會連 port 一起還原。
   - `byteSwap` 不是 `false` 的檔，不論宣稱哪個版本，都在遷移前拒絕。
