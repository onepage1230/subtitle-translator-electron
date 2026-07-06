# 05 — 給未來 session 的信

寫於 2026-07-06，ops-setup 完成時。讀者是未來在這個環境工作的模型（多半是 Sonnet 或 Haiku）。前面五份檔案是規則；這封信講規則沒涵蓋、但你遲早會撞到的事。

## 接手指引（30 秒版）

制度入口只有一個：專案 `CLAUDE.md` 的任務路由表。開場先看它，照表找檔，不要憑記憶。制度演變史：`git log --oneline -- docs/ops/ CLAUDE.md .claude/commands/`。

## 三件使用者沒問、但對這個環境最重要的事

### 1. CLAUDE.md 是整套制度的單點故障

docs/ops/ 的五份檔案**不會自動進入任何 session 的 context**——你之所以讀到它們，唯一原因是 CLAUDE.md 的路由指過去。這意味著：(a) 路由表壞一行（檔案改名、路徑打錯），那條制度就等於不存在，而且沒有任何報錯；(b) 誰能改 CLAUDE.md，誰就能讓整套制度靜默失效。所以 `04-maintenance.md` 才把 CLAUDE.md 列為「要先問」等級，且每次 ops commit 前要驗路由路徑存在。**如果你發現自己在做任務時完全沒被路由到任何 ops 檔——先回頭檢查 CLAUDE.md 是不是被改壞了。**

### 2. 這個專案最缺的護欄是「翻譯品質的客觀測試」，制度補不了

制度能保證流程（有測試、有驗收、有第二意見），但這個 app 的核心價值是翻譯品質——那是品味題。歷史證據：2026-07-03 的 glossary UI 工作，流程全走完之後，靠人手 smoke test 才抓到 4 個 bug（見 auto-memory `project-glossary-ui-editing.md`）。目前唯一接近客觀護欄的是 `tests/unit/` 的 fixtures。**值得主動向使用者提案**：建立 golden-file 快照測試（固定字幕輸入 → 預期輸出的結構與行數對齊），讓弱模型改 `pipeline.ts`／`translate.ts` 時有機器可判的回歸保護。在那之前，凡動翻譯核心，`translation-pipeline-reviewer` 審查是不可省略的最後防線。

### 3. auto-memory 與 docs/ops 是兩套記憶，會分叉

auto-memory（`~/.claude/projects/.../memory/`）記個人偏好與跨專案教訓；docs/ops 與 `10-architecture.md` 記 repo 內可版控的事實。今天起的分工：**repo 的事實以 repo 檔案為準**，memory 裡的舊 pipeline 描述若與 `10-architecture.md` 或程式碼衝突，信 repo、更新 memory。另外兩個權限層的既知矛盾，制度管不到、只有使用者能修：(a) `settings.local.json` 有 `git *` 白名單，破壞性 git 操作實際上免確認，與 Stop Conditions 打架；(b) `.claude/hooks/audit.log` 與 `.claude/worktrees/` 下兩個 5/21 的殘留 worktree 無人清理。已在 `01-diagnosis.md` 建議，若使用者尚未處理，適時再提醒一次。

## 這套制度最可能的退化方式與預防

| 退化方式 | 早期訊號 | 預防／解法 |
|---|---|---|
| 教訓區只加不刪，制度檔膨脹回當初 96 行 CLAUDE.md 的老路 | 單檔超過 150 行、教訓超過 5 條 | `04-maintenance.md` §3 的精簡門檻，加教訓時順手檢查行數 |
| 路由失聯：檔案改名搬家，CLAUDE.md 沒跟上 | 照路由找檔案 404 | 每次 ops commit 前跑 §5 驗證；發現斷鏈當場修，用 `ops:` commit |
| 模板疲乏：「這次很簡單」跳過 /ops-*，逐漸回到主對話下場全做 | 主對話單輪讀了 3 個以上檔案全文 | 這正是 `02-delegation.md` §1 的判準線；跳過模板要在回報裡明說並給理由 |
| 驗收橡皮圖章化：把做工者的摘要餵給驗收者，fresh-context 名存實亡 | 驗收回報和做工回報措辭雷同 | `02-delegation.md` §6 明文「只給需求清單與檔案路徑」；發現雷同就重驗 |
| 型號字串過時：模型改版後，02 的 model 表與 00 §7 失效 | Agent 呼叫報 model 不存在、或官方文件更新 | 00 §7 附了出處 URL；照 `04-maintenance.md` §1「事實錯誤」流程自行更新 |
| 制度與 skills 衝突擴大：新裝的 plugin skill 帶強制條款 | 兩套流程都聲稱必須先走 | 優先序已裁決（docs/ops > skills）；新衝突寫進 `03-judgment.md` §6 裁決表 |

## 誠實條款（這套做法的極限）

拆解、驗證、fresh-context 評審能補的是**執行品質**：少漏步驟、少假完成、少自欺。補不了的是：

- **模糊題**：需求本身多義時，rubric 只能教你「停下來問」，不能替使用者決定。
- **品味題**：翻譯語感、命名美感、UI 文案。弱模型加 checklist 不會變出品味；處置只有三種——升級模型、找第二意見、或明說「這是品味判斷，我給的是底線合格版」。見 `03-judgment.md` §7。

不確定的事就查（context7、官方文件、實跑），查不到就寫「未確認」。這個環境裡最貴的錯誤不是慢，是**自信地編造**——一個編造的路徑或型號會讓後續每個照章辦事的弱模型跟著撞牆。

## 本次未完成事項

無。交付清單 A–G 全數完成並 commit；對抗審查與 read-back 驗證的結果見收尾 commit。
