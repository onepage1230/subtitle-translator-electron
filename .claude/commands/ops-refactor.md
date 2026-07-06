---
name: ops-refactor
description: 派工模板：行為不變的重構。含 codegraph 影響面分析、前後測試比對、行為不變驗收
argument-hint: [要重構什麼＋動機]
---

# ops-refactor — 重構派工模板

重構的定義：**外部行為完全不變**，只改結構。任何會改變使用者可見行為的工作不走本模板，走 `/ops-implement`。

## 步驟

1. **影響面分析**：用 `codegraph_impact`（或 `codegraph_callers`）列出所有呼叫點。影響面超過 10 個檔案 → 先把清單回報使用者確認範圍再動工。

2. **基準線**：先跑 `npm test` 記下目前結果（幾個測試、全綠與否）。**基準線本來就有紅的測試要先回報使用者**，不要在紅的基準上重構。

3. **填派工單**：

   ```text
   【目標與動機】重構：$ARGUMENTS
   動機：＿＿＿（重複程式碼／抽象錯位／為了下一個功能鋪路）
   【範圍】要動的檔案：＿＿＿（來自步驟 1 的影響面清單）
   明確不做的事：不改任何外部行為、不改公開介面簽名（要改介面先問使用者）、不順手修不相關的壞味道
   【驗收條件】
   - `npm test` 結果與基準線完全一致（測試數量、通過數），貼實際輸出
   - 不新增依賴、不改 package.json
   - 每個被改的呼叫點都在回報清單中
   【回報格式】(1) 結論 ≤5 行；(2) 改動清單：`檔案:行號 — 改了什麼`；
   (3) 測試輸出與基準線的比對；(4) 發現但沒動的問題另列（不要動手）。
   ```

4. **派工**：Agent tool，`subagent_type: general-purpose`，`model: sonnet`。機械性的批次改名/搬移（模式已明確、逐檔套用）可用 `model: haiku`，錯一次立刻升 sonnet。

5. **驗收（不自驗）**：fresh-context subagent 實跑 `npm test` 比對基準線；動到 `translate.ts` 的過 `translation-pipeline-reviewer`。

## 注意事項

- 重構中途發現真 bug：記下位置回報，**不要在重構 commit 裡順手修**——行為改變會讓「測試結果不變」的驗收失效。
- 蹺蹺板訊號（修 A 壞 B）出現 → 停手換路，見 `docs/ops/03-judgment.md` §4。
