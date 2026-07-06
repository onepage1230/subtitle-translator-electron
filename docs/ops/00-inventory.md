# 00 — 環境盤點（2026-07-06）

本檔是 ops 制度的事實基礎。後續 01–05 各檔引用的環境事實以本檔為準。
資料來源：本 session 實際執行 `ls`、`wc -l`、`claude mcp list`，以及 Claude Code 官方文件查證（出處見 §7）。

## 1. CLAUDE.md 現況（ops-setup **重寫前**的快照；重寫後狀態見 §9 後記）

| 檔案 | 行數 | 內容摘要 |
|---|---|---|
| 專案 `CLAUDE.md` | 96 行（重寫前） | 指令、架構（main/renderer/IPC）、翻譯 pipeline 九步驟、劇集模式、settings 持久化、字幕格式、build 輸出、agent skills 路由 |
| `~/.claude/CLAUDE.md` | 13 行 | 語言（繁中）、git 必用、Python 用 pyenv+uv、pnpm 11 打包教訓 |

問題點（詳見 `01-diagnosis.md`）：專案 CLAUDE.md 有大量「可從程式碼推導」的架構細節，且 pipeline 描述每次改功能都要同步維護，容易過時。

## 2. .claude/agents/（專案層，共 2 個）

| 檔案 | model 欄位 | tools 欄位 | 用途 |
|---|---|---|---|
| `e2e-writer.md`（58 行） | **未設定**（＝inherit） | 未設定（All tools） | 讀 src/pages、src/components 產生 Playwright E2E 測試 |
| `translation-pipeline-reviewer.md`（58 行） | **未設定**（＝inherit） | 未設定（All tools） | 審查 translate.ts 修改（三層 fallback、重試、atomic write） |

`~/.claude/agents/`：空。

## 3. .claude/commands/

- 專案 `.claude/commands/`：盤點時不存在；**ops-setup 已建立五個派工模板**（`ops-search`、`ops-research`、`ops-implement`、`ops-refactor`、`ops-review`），已進版控
- `~/.claude/commands/`：不存在

## 4. Skills

### 專案 `.claude/skills/`（17 個；15 個為 symlink 至 `.agents/skills/`，i18n-sync 與 release-check 為實體目錄）

| name | 觸發描述（截錄） |
|---|---|
| caveman | 極簡溝通模式，省 ~75% token |
| diagnose | 難 bug 的紀律化診斷循環：reproduce → minimise → hypothesise → instrument → fix |
| grill-me | 對計畫/設計連環拷問直到達成共識 |
| grill-with-docs | 拷問 + 對照 CONTEXT.md/ADR，邊決策邊更新文件 |
| handoff | 把當前對話壓縮成交接文件 |
| i18n-sync | 比對 src/locales/ 三語言檔 key 缺漏 |
| improve-codebase-architecture | 依 CONTEXT.md/ADR 找架構深化機會 |
| prototype | 拋棄式 prototype 探索設計 |
| release-check | build 前檢查：版本號、型別、i18n、pnpm 打包 |
| setup-matt-pocock-skills | 建 docs/agents/ 骨架（`disable-model-invocation: true`，僅手動） |
| tdd | red-green-refactor 循環 |
| to-issues | 把計畫拆成 tracer-bullet issues |
| to-prd | 對話轉 PRD 發到 issue tracker |
| triage | issue 分流狀態機 |
| write-a-skill | 建新 skill |
| zoom-out | 拉高視角（`disable-model-invocation: true`，僅手動） |

### `~/.claude/skills/`（3 個 skill）

code-review、mikeon-buffett-investing（367 行，投資分析，與本專案無關）、process-billing（帳單處理，與本專案無關）。另有 `mikeon-buffett-investing-workspace/` 資料目錄（非 skill）。

### Plugin skills（隨 plugin 安裝，非目錄檔案）

superpowers 系列（brainstorming、systematic-debugging、test-driven-development、writing-plans、executing-plans、subagent-driven-development、verification-before-completion、requesting/receiving-code-review、using-git-worktrees、dispatching-parallel-agents、finishing-a-development-branch、writing-skills、using-superpowers）、codex 系列（rescue、setup 等）、skill-creator、karpathy-guidelines、claude-automation-recommender、dataviz、artifact-design、update-config、keybindings-help、claude-api、claude-in-chrome、verify、simplify、fewer-permission-prompts、loop、schedule、run、init、review、security-review、code-review、handoff。

## 5. Hooks 與 settings

### `.claude/settings.json`（35 行，內嵌 shell hook，無獨立腳本檔）

1. **PostToolUse**（Edit|Write）：`.ts/.tsx` 檔改動後跑 `npx tsc --noEmit`（取前 30 行）；`package.json` 改動後印出「執行期套件要放 dependencies」提醒。
2. **PreToolUse**（Edit|Write）：目標在 `dist/`、`dist-electron/`、`release/` 下直接 exit 1 阻擋。

### `.claude/settings.local.json`（85 行）

僅 `permissions.allow` 約 70 條白名單（git、npm/pnpm、npx tsc/vitest、gh issue、superpowers 腳本等），無金鑰。屬歷次核准累積，非精心設計。

### 其他觀察

- `.claude/hooks/` 下只有 `audit.log`（966 行歷史日誌，非腳本；目前 settings.json 看不出寫入來源，疑似舊 hook 遺留）。
- `.claude/worktrees/` 有 2 個 5/21 殘留的 agent worktree 未清理。

## 6. MCP servers（`claude mcp list`，全部 Connected）

| 名稱 | 來源 | 用途 |
|---|---|---|
| claude.ai Google Calendar / Gmail / Google Drive | claude.ai 連接器 | 個人服務，與本專案開發無關 |
| context7 | `npx -y @upstash/context7-mcp` | 抓函式庫最新文件 |
| codegraph | `codegraph serve --mcp` | 本 repo 符號索引（context/callers/impact） |

另有 claude-in-chrome（瀏覽器自動化，經 extension 提供，不在 `claude mcp list` 內）。

## 7. 模型名稱（官方文件查證，2026-07-04 版）

以下為**已查證**的字串，寫規則時照抄，不要自創：

- `.claude/agents/*.md` frontmatter `model` 欄位合法值：`sonnet`、`opus`、`haiku`、`fable`、完整 model ID（如 `claude-opus-4-8`）、`inherit`（預設）。出處：https://code.claude.com/docs/en/sub-agents.md
- `/model` 可選別名：`default`、`best`、`fable`、`sonnet`、`opus`、`haiku`、`sonnet[1m]`、`opus[1m]`、`opusplan`，或完整 model ID。出處：https://code.claude.com/docs/en/model-config.md
- 完整 model ID（本 session 環境資訊）：Fable 5 = `claude-fable-5`、Opus 4.8 = `claude-opus-4-8`、Sonnet 5 = `claude-sonnet-5`、Haiku 4.5 = `claude-haiku-4-5-20251001`。
- subagent model 解析優先序：`CLAUDE_CODE_SUBAGENT_MODEL` 環境變數 → Agent tool 呼叫參數 `model` → agent 定義檔 frontmatter `model` → 主對話模型。出處同 sub-agents.md。
- slash command / skill frontmatter 支援欄位（節錄常用）：`name`、`description`、`argument-hint`、`allowed-tools`、`model`、`disable-model-invocation`、`context`、`agent`。佔位符：`$ARGUMENTS`（全部參數）、`$0`/`$1`（位置參數）。出處：https://code.claude.com/docs/en/skills.md

## 8. 其他環境事實

- 平台 darwin（macOS）、shell zsh、git repo（主分支 `main`，作業分支 `ops-setup`）。
- Issue tracker：GitHub Issues（`onepage1230/subtitle-translator-electron`），流程見 `docs/agents/issue-tracker.md`。
- 記憶系統：`~/.claude/projects/-Users-onepage-Documents-github-subtitle-translator-electron/memory/`（MEMORY.md 索引 + 單事實檔）。
- 測試：`npm test`（Vitest，tests/unit/）、`npm run e2e`（Playwright，需先 `npm run pree2e`）。

## 9. 後記（ops-setup 完成後的狀態，2026-07-06）

本檔 §1–§6 是 ops-setup **動工前**的快照，作為診斷依據保留原文。動工後的變化：

- 專案 `CLAUDE.md` 已重寫為 ≤60 行的路由表（實測 47 行），原架構細節移至 `docs/ops/10-architecture.md`。
- `.claude/commands/` 已建立五個 `ops-*` 派工模板並進版控（`.gitignore` 改為 `/.claude/*` + `!/.claude/commands/`）。
- 新增制度檔：`docs/ops/00`–`05` 與 `10-architecture.md`。

未來更新本檔時：環境事實（skills、agents、MCP、hooks）以最新現況覆寫對應小節即可，不必保留歷史快照；唯 §1 的重寫前行數保留，供 `01-diagnosis.md` 引用。
