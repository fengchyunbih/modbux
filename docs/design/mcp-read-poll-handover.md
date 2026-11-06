# MCP：Client 的 Read 與 Poll tool（交接）

目標：Agent 能開始與停止 Client 的 poll，並讀一次 Client，視窗格子隨之更新，如同按 POLL 與 READ。

狀態：尚未開 issue，尚未寫任何程式碼。依 CONTRIBUTING，先開 issue 再動工。

## 為什麼需要

用點表建 Server 與 Client 後，要確認 Client 讀得到值。現在只有 `client_read_points` 一個一次性的讀取，沒有 poll 的 tool。要持續輪詢，使用者得在視窗按 POLL。

## 現況

以下都是讀原始碼或實測的結果。

- `src/main/modules/mcp/tools/client.ts` 的 `clientTools` 有 `client_get_config`、`client_connect`、`client_disconnect`、`client_read_points`、`client_set_connection`、`client_apply_point_table`、`client_write`。沒有 poll 的 tool。
- poll 的後端已存在。`start_polling`、`stop_polling` 是 `IPC_CHANNELS` 裡的兩個 channel，`main/ipc.ts` 的 handler 呼叫 `ModbusClient.startPolling` 與 `stopPolling`。`PollButton.tsx` 直接呼叫 `window.api.startPolling` 與 `stopPolling`。
- `McpToolContext.client`（`registry.ts`）是 `Pick<ModbusClient, ...>`，成員目前沒有 `startPolling` 與 `stopPolling`。
- `client_read_points` 呼叫 `context.client.read()`。poll 進行中，`clientOwner` 回 `a poll`，tool 回 `Cannot read during a poll. Try again once it has finished.`。這句是實測的輸出。
- `ModbusClient.startPolling` 回 `void`。被 `_requireClient('poll')` 拒絕時，它只送一則 warning snackbar，不回結果。
- `client_connect` 與 `client_disconnect` 經 `context.rendererCommands.send` 交給 renderer。`client_read_points` 與 `client_write` 直接用 `context.client`。

## 未解：`client_read_points` 後格子沒更新

原始碼說會更新：`ModbusClient._read` 讀完呼叫 `_sendData`，送出 `register_data`，renderer 的 `data.zustand.ts` 收到後 `setRegisterData`。

實測沒有：第一次 `client_read_points` 回了 34 點的值，緊接著使用者的 Client 格子全是 0。原因沒有查明。截圖可能早於那次讀取，格子也可能後來被清掉。

下一個人先重現，再決定 issue 的範圍：

1. 啟動 Modbux，Client 連上一個 Server，`client_apply_point_table` 套用點表。
2. 不按 POLL。呼叫 `client_read_points`。
3. 看格子。有更新，issue 只需要 poll 的兩個 tool。沒更新，這是 bug，先修它，read 的需求才成立。

## 設計

建議 A，不是定案。

- **A. tool 直接呼叫 `context.client`。** 把 `startPolling`、`stopPolling` 加進 `McpToolContext.client` 的 `Pick`，新增 `client_start_polling` 與 `client_stop_polling`。與 `client_read_points`、`client_write` 同一條路。poll 是 main 的狀態，`PollButton` 也直接呼叫 IPC，沒有 store 在中間。
- **B. 經 `rendererCommands`。** 像 `client_connect` 那樣在 `rendererCommandHandlers.ts` 與 `shared/types/rendererCommand.ts` 加兩個 command。多一層，換來的好處是 renderer 看到的 UI 狀態由它自己決定。poll 沒有這個需要。

A 的一個必要處理：`startPolling` 被拒絕時沒有回傳值。tool 在呼叫後讀 `context.client.state.polling`，沒變成 `true` 就用 `clientOwner(state)` 的字串回 `toolError`，不要回成功。

## 要做的

1. `registry.ts`：`McpToolContext.client` 的 `Pick` 加 `startPolling`、`stopPolling`。檢查 `main/index.ts` 組 context 的地方，確認傳入的物件有這兩個成員。
2. `tools/client.ts`：新增兩個 tool，加進 `clientTools`。`client_start_polling` 的 annotations 是 `readOnlyHint: false`、`destructiveHint: false`、`idempotentHint: true`、`openWorldHint: true`。它讀裝置，不寫，所以不受 "Allow writes to devices" 管。`client_stop_polling` 同樣冪等。已在 poll 中時再 start，回成功並說明，跟 `client_connect` 的 `Already connected` 一樣。
3. 未連線時 start 回 `toolError`，訊息指向 `client_connect`。`_requireConnected` 負責這個判斷，確認它對 tool 的行為。
4. 測試：
   - `__tests__/tools.test.ts` 的 tool 清單與 annotations 斷言加兩個 tool。
   - `__tests__/fakeContext.ts` 的 stand-in 加 `startPolling`、`stopPolling`。
   - 為兩個 tool 各寫一個測試，涵蓋：成功、已在 poll、被 scan 或 write 拒絕、未連線。拒絕的測試要能失敗：把 `state.polling` 的檢查拿掉，它要變紅。
5. `docs/mcp.md`：補兩個 tool，並寫明 poll 期間 `client_read_points` 會被拒絕。
6. `yarn lint && yarn typecheck && yarn test`。MCP 的 e2e 若有涵蓋 client tool，跑相關的 spec。

## 待驗證

- `stopPolling` 只清 timer 並遞增 generation，不等 poll 最後一次 read 結束。`modbusClient.ts` 裡 scan 會等 `_pollRead`，註解說明這是為了不讓請求與 poll 的最後一次 read 同時在線上。`client_stop_polling` 回傳後立刻 `client_read_points`，是否會與那次 read 重疊，沒有驗證。結論決定 stop tool 要不要等 `_pollRead`。
- poll 的讀取不經 `_readOwningTheClient`，所以 `reading` 旗標不會在 poll 的 read 期間為 `true`。`client_read_points` 在 poll 中被拒絕靠的是 `polling` 旗標，不是 `reading`。

## 不在範圍

- 調整 `pollRate`。`client_get_config` 能讀到它，要不要開 tool 改它是另一個 issue。
- 不新增 IPC channel。`conformance.test.ts` 管 channel 的規則不會被碰到。
