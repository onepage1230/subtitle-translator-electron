---
name: ops-research
description: 派工模板：外部研究（文件、函式庫、方案比較）。派 general-purpose subagent，結論必附來源
argument-hint: [要研究的問題＋研究結果要用來決定什麼]
---

# ops-research — 研究派工模板

查外部資料（函式庫文件、API 行為、方案比較）的標準流程。原則：**結論必附來源，查不到就標註「未確認」，不編造**。

## 步驟

1. **先判斷工具**：單一函式庫的 API 用法問題，先試 context7 MCP（`resolve-library-id` → `query-docs`），一兩次呼叫能答完就不派工。Claude Code / Claude API 本身的問題派 `claude-code-guide` agent。

2. **填派工單**：

   ```text
   【目標與動機】研究：$ARGUMENTS
   這個研究要支撐的決策：＿＿＿（例如「決定要不要升級 ai SDK 到 v5」）
   【必答問題】＿＿＿（列點，每點都要有答案或「未確認」）
   【驗收條件】
   - 每個結論附來源 URL 或文件名＋版本
   - 區分「官方文件說的」與「社群文章/推測」，後者要標明
   - 查不到的明確寫「未確認」，禁止用訓練記憶充當查證結果
   【回報格式】每個必答問題一段：結論（可直接引用的措辭）→ 來源。
   超過 40 行的完整筆記寫到 scratchpad 檔案，回報給路徑＋摘要。
   ```

3. **派工**：Agent tool，`subagent_type: general-purpose`，`model: sonnet`（研究品質吃理解力，不用 haiku）。

4. **收貨檢查**：逐條核對必答問題——每題都有「結論＋來源」或「未確認」嗎？有來源缺失的退回。

## 注意事項

- 研究結論若與 repo 現況有關（例如「此版本已修掉某 bug」），要對照 `package.json` 實際版本再採信。
- 「未確認」的事項如果影響決策，照 `docs/ops/03-judgment.md` §3 回報使用者，不要賭一邊。
