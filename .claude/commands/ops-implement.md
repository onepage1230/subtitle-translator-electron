---
name: ops-implement
description: 派工模板：實作新功能或修 bug。含定位、派工、測試驗收、fresh-context 驗證的完整流程
argument-hint: [要實作什麼＋驗收條件]
---

# ops-implement — 實作派工模板

實作功能或修 bug 的標準流程。走本模板時不再另行觸發其他 process skills（裁決見 `docs/ops/03-judgment.md` §6）。

## 步驟

1. **定位**：用 codegraph（`codegraph_context`）確認要動的檔案與影響範圍。範圍不明就先走 `/ops-search`。改動 ≤10 行且位置明確 → 主對話直接改，跳到步驟 5 的驗證，不派工。

2. **填派工單**：

   ```text
   【目標與動機】實作：$ARGUMENTS
   為什麼要做：＿＿＿
   【範圍】要動的檔案：＿＿＿（來自步驟 1）
   明確不做的事：＿＿＿（防 scope creep，例如「不順手重構鄰近程式碼」）
   【驗收條件】（寫成可執行的指令與預期結果）
   - 針對此改動新增至少一個測試，並說明它驗證什麼行為
   - `npm test` 全綠，貼實際輸出的最後 10 行
   - 動到 UI：`npm run pree2e && npm run e2e` 也要綠
   - 額外條件：＿＿＿（從使用者原話逐句抄，不要改寫）
   【回報格式】(1) 結論 ≤5 行；(2) 改動清單：`檔案:行號 — 改了什麼`；
   (3) 測試輸出原文（最後 10 行）；(4) 做不到或未驗的部分明說。
   ```

3. **派工**：Agent tool，`subagent_type: general-purpose`，`model: sonnet`。失敗時的升降級照 `docs/ops/02-delegation.md` §5（Haiku 錯一次升 Sonnet；Sonnet 同一子任務連錯兩次帶完整軌跡升 Opus；同一件事最多重試兩輪）。

4. **收貨檢查**：測試輸出是實跑貼文，不是「應該會過」；`git diff --stat` 中每個檔案都能對應到任務。

5. **驗收（不自驗）**：另派一個 fresh-context subagent（`model: haiku` 即可），只給它「驗收條件清單＋要跑的指令」，不給實作過程。它實跑測試並逐條回報通過/未通過。動到 `electron/main/utils/translate.ts` 的改動，額外過 `translation-pipeline-reviewer`。

6. **驗收沒過** → 帶著驗收回報退回原做工者修（計入重試次數）。

## 注意事項

- 需求有兩種合理解讀且行為不同 → 先照 `docs/ops/03-judgment.md` §3 問使用者，不要選一個硬做。
- 執行期需要的新套件屬於「新增依賴」，是 Stop Condition，先問使用者。
