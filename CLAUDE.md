# CLAUDE.md

字幕翻譯桌面應用（Electron + React + Vite）。本檔只做路由：先看指令與硬規則，其餘照下表找檔案，不要憑印象作答。

## 指令

```bash
npm run dev                    # 開發（Vite + Electron 同啟）
npm run build                  # 打包（writeVersion.js → tsc → vite build → electron-builder）
npm test                       # 單元測試（Vitest，tests/unit/）
npm run pree2e && npm run e2e  # E2E（Playwright，先建測試版）
```

沒有 lint script；型別檢查靠 `tsc`（Edit/Write `.ts/.tsx` 後 hook 會自動跑 `npx tsc --noEmit`）。

## 規則優先序

使用者當下指示 > 本檔與 `docs/ops/` 制度檔 > skills（superpowers 等）> 預設行為。
skills 只在不與制度檔衝突時使用；多個 skill 都像時，查 `docs/ops/03-judgment.md` 的裁決表。

## 任務路由（任務類型 → 先讀哪個檔 / 先用什麼）

| 任務類型 | 先讀 / 先用 |
|---|---|
| 了解架構、pipeline、IPC、localStorage keys、劇集模式 | `docs/ops/10-architecture.md`（行為以程式碼為準） |
| 查符號定義、誰呼叫誰、改動影響範圍 | codegraph MCP（`codegraph_context`），不要 grep + 整檔讀 |
| 搜尋、掃 repo、大量讀檔、研究 | 派 subagent：`docs/ops/02-delegation.md`；模板 `/ops-search`、`/ops-research` |
| 實作、重構、審查 | 模板 `/ops-implement`、`/ops-refactor`、`/ops-review` |
| 判斷猶豫：該升級模型？算完成嗎？該問使用者嗎？ | `docs/ops/03-judgment.md` |
| 修改 `docs/ops/` 制度檔、踩坑後寫教訓 | `docs/ops/04-maintenance.md` |
| 環境有哪些 agents / skills / MCP / hooks | `docs/ops/00-inventory.md` |
| 發布前檢查 | `/release-check` |
| i18n key 缺漏 | `/i18n-sync` |

## 硬規則（違反會直接出錯）

- `dist/`、`dist-electron/`、`release/` 是建置產物，禁止編輯（PreToolUse hook 會擋）。
- 執行期需要的套件放 `dependencies`，不放 `devDependencies`（pnpm 11 + electron-builder 打包教訓）。
- renderer 是 `nodeIntegration: true`、`contextIsolation: false`，可直接 `import { ipcRenderer } from "electron"`。
- 字幕輸出檔名固定 `<原檔名>.translated.<副檔名>`；支援 `.srt/.vtt/.ass/.ssa`。
- 制度檔（`docs/ops/`、本檔、`.claude/commands/ops-*`）的 commit 一律用 `ops:` 前綴。

## Agent skills

- Issue tracker：GitHub Issues（`onepage1230/subtitle-translator-electron`），見 `docs/agents/issue-tracker.md`
- Triage labels：預設五角色標籤，見 `docs/agents/triage-labels.md`
- Domain docs：單一 `CONTEXT.md` + `docs/adr/`，見 `docs/agents/domain.md`
