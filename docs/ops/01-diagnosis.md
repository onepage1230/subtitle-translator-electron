# 01 — 快速診斷（2026-07-06）

依據 `00-inventory.md` 的盤點結果，列出本環境三大問題，按危害排序。後續交付（CLAUDE.md 重寫、02–05 各檔）均以本檔為依據。

---

## 第 1 名（最漏 token）：固定成本肥大——CLAUDE.md 塞架構細節 + 主對話自己下場讀檔

### 症狀
- 專案 CLAUDE.md 96 行，其中約 60 行是「可從程式碼推導」的架構描述（pipeline 九步驟、模組分工、localStorage key 清單）。每個 session 無論任務大小都全額載入。
- 沒有任何調度規則檔：過往 session 主對話自己 grep、自己整檔讀 `translate.ts`（600+ 行）、`pipeline.ts`，讀完的全文永久佔用主 context，即使後續任務用不到。
- PostToolUse hook 對**每一次** `.ts/.tsx` Edit 都跑全專案 `npx tsc --noEmit`：連續小修改時，同樣的型別錯誤輸出（最多 30 行）重複進入 context 多次。

### 判斷依據
- `wc -l` 實測：CLAUDE.md 96 行；對照最近 commit `fb84dcd docs: note per-request glossary filtering...`——**每次改 pipeline 功能都要同步改 CLAUDE.md 描述**，證明這些行既佔 token 又是維護負債。
- 本 repo 已裝 codegraph MCP（索引全 repo 符號），「符號在哪、誰呼叫誰」有次毫秒級查詢可用，主對話整檔閱讀是重複支出。

### 具體修法
1. CLAUDE.md 重寫為 ≤60 行路由表：一行任務類型 → 指向檔案；架構細節留在程式碼與 `docs/ops/`（→ 交付項目 B，完成後見專案 CLAUDE.md）。
2. 建立派工守則：搜尋/掃描/大量閱讀一律派 subagent，主對話只收「結論 + 檔案:行號」（→ `02-delegation.md`）。
3. 查「某符號在哪、誰呼叫誰」先用 codegraph（`codegraph_context` / `codegraph_callers`），不要 grep + 整檔讀。
4. （建議、未執行）tsc hook 可改為只在該檔所屬 tsconfig 範圍跑或加 debounce；因修改 `settings.json` 屬 stop condition，留給使用者決定。

---

## 第 2 名（最容易失焦）：50+ 個 skills 與多層強制條款疊加，弱模型在「該走哪個流程」上繞圈

### 症狀
- 可用 skills 超過 50 個（專案 17 + 使用者 3 + plugin 30+），其中 superpowers 的 `using-superpowers` 帶著 EXTREMELY-IMPORTANT 級別的「回應前必須檢查 skill」條款，而 caveman、diagnose、tdd、systematic-debugging、brainstorming 的觸發描述互相重疊（同一句「幫我修這個 bug」可同時命中 diagnose、systematic-debugging、tdd 三個）。
- Sonnet/Haiku 面對疊加條款的典型失敗模式：花好幾輪思考「該不該觸發 skill」、觸發了不合用的重流程 skill（例如小修改也走完整 brainstorming），或在兩個相似 skill 間反覆。
- 與本專案無關的 skills（投資分析、帳單處理）也在觸發清單裡，增加誤觸發面。

### 判斷依據
- `00-inventory.md` §4 的實際清單；`using-superpowers` 原文「1% 機率適用就必須觸發」對弱模型是失焦放大器——它沒有「哪個 skill 贏」的裁決規則。
- 使用者已裁決：**docs/ops 制度優先於 skills**（2026-07-06 開場問答）。

### 具體修法
1. CLAUDE.md 路由表明訂優先序：使用者指示 > CLAUDE.md/docs/ops > skills > 預設行為，並給「常見任務 → 用哪個流程」對照表，弱模型照表走、不自行裁決（→ 交付項目 B）。
2. skill 撞名裁決 rubric：兩個 skill 都像時怎麼選（→ `03-judgment.md`）。
3. 派工模板（`.claude/commands/ops-*`）本身就是「已裁決好的流程」：走模板時不再重新考慮 process skills（→ 交付項目 E）。

---

## 第 3 名（最容易出錯）：驗證與權限缺口——自己改自己驗、`git *` 全開、文件雙源

### 症狀
三個彼此獨立的出錯面：

1. **無驗證合約**：兩個現有 agents（e2e-writer、translation-pipeline-reviewer）沒有 model、tools、回報格式約定；過往流程是「改完自己宣稱完成」，沒有 fresh-context 驗收。弱模型自驗的通病是「跑過 ≠ 對」——tsc 過了就說完成，實際行為沒驗。
2. **`settings.local.json` 有 `git *` 白名單**：`git reset --hard`、`git push --force` 都免確認直接放行，與本制度 Stop Conditions（破壞性 git 操作先問）直接打架。制度寫了但權限層放行，弱模型一個手滑就繞過。
3. **文件雙源**：CLAUDE.md 的 pipeline 描述與程式碼是兩份真相，歷史上靠人工同步（見第 1 名判斷依據），過時的描述會直接誤導照文件辦事的弱模型。

### 判斷依據
- `00-inventory.md` §2（agents 無 model/tools 欄位）、§5（`git *` 在 allow 清單原文）。
- 記憶檔 `project-glossary-ui-editing.md` 記載：上次 smoke test 才抓到 4 個自驗沒抓到的 bug——自驗漏檢在本專案有實績。

### 具體修法
1. 驗證不自驗：驗收一律派 fresh-context subagent，檔案用 read-back、程式碼用測試或實跑（→ `02-delegation.md` §6）。
2. （建議、未執行）請使用者把 `git *` 從 allow 清單收斂為明確子命令白名單（`git add`、`git commit` 等已各自有條目，`git *` 可直接刪）；修改 settings 屬 stop condition，本次不動手。
3. 文件單一來源：pipeline 行為描述以程式碼為準，CLAUDE.md 只留指向；改功能時不再要求同步散文描述（→ 交付項目 B）。

---

## 診斷的極限

本診斷基於靜態盤點與 git 歷史，未實測「Sonnet 在此環境跑一個真任務」的行為記錄。第 2 名的失焦模式是從 skills 清單結構推斷的已知弱模型通病，不是本環境的實測觀察；若未來 session 發現實際失焦點不同，依 `04-maintenance.md` 的 post-mortem 格式修正本檔。
