# 詞彙表 UI 編輯 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓使用者在 TranslatorPanel 的檔案 modal 內直接編輯 series glossary 的譯名與刪除條目,寫回資料夾層級的 `.series-glossary.json`。

**Architecture:** 細粒度操作型 IPC——renderer 每次操作發一個 op(`edit` / `delete`)給 main process,main 集中做 load → 修改 → save,回傳更新後的完整詞彙表,renderer 以回傳值重繪。刪除透過檔案內新增的 `excluded` 排除清單持久生效(擋住快取合併復活);編輯過的條目標記 `userEdited: true` 供 UI 顯示鎖頭。既有 LOCKED / 調和機制完全不動。

**Tech Stack:** Electron IPC(`ipcMain.handle` / `ipcRenderer.invoke`)、React 18 + Tailwind、react-i18next、Vitest。

**Spec:** `docs/superpowers/specs/2026-07-03-glossary-ui-editing-design.md`(本計畫的需求依據,實作時遇到歧義以 spec 為準)。

## Global Constraints

- 所有檔案 I/O 在 main process;renderer 只經 IPC(即使 `nodeIntegration: true` 技術上可直接 fs,不這麼做)。
- **不修改** `translate.ts` 的 zod schema(`glossaryEntrySchema`):`userEdited` 不得進入 AI 的 JSON schema。以 intersection type 在 `seriesGlossary.ts` 擴充。
- i18n 新字串必須同步加入 `src/locales/en-US.json`、`zh-TW.json`、`zh-CN.json` 三個檔案的 `translate.context` 區塊。
- term 比對一律 lowercase(與既有 `mergeIntoSeriesGlossary` 去重鍵一致);`excluded` 存 lowercase。
- 舊格式 `.series-glossary.json`(無 `excluded` 欄位)必須向後相容,視為 `excluded: []`。
- 單元測試放 `tests/unit/`,跑 `npm test`(Vitest);型別檢查 `npx tsc --noEmit`。
- 遵循既有程式碼風格:繁中註解、Tailwind class、boxicons(`bx bx-*`)。
- Commit 訊息結尾附:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01FE8AQDuh46eYKWEF53vSEk`

---

### Task 1: 資料層——excluded 排除清單與新檔案格式

**Files:**
- Modify: `electron/main/utils/seriesGlossary.ts`
- Modify: `electron/main/utils/pipeline.ts:168`(load 解構)、`pipeline.ts:212-213`(merge/save 傳遞 excluded)
- Test: `tests/unit/seriesGlossary.test.ts`(更新既有 + 新增)

**Interfaces:**
- Consumes: 既有 `GlossaryEntry`(from `./translate`,`{ term: string; translation: string; category: "person"|"place"|"organization"|"term" }`)
- Produces(後續 task 依賴的精確簽名):
  - `type SeriesGlossaryEntry = GlossaryEntry & { userEdited?: boolean }`
  - `interface SeriesGlossaryData { terms: SeriesGlossaryEntry[]; excluded: string[] }`
  - `loadSeriesGlossary(folder: string): SeriesGlossaryData`
  - `mergeIntoSeriesGlossary(existing, incoming, excluded?: string[]): SeriesGlossaryEntry[]`
  - `saveSeriesGlossary(folder: string, terms: SeriesGlossaryEntry[], excluded?: string[]): boolean`

- [ ] **Step 1: 更新既有測試至新簽名,並新增 excluded 行為測試**

`tests/unit/seriesGlossary.test.ts` 既有三處改成新回傳形狀:

```ts
// describe("load/save") 內,三個既有測試改為:
it("round-trips through the folder file", () => {
  const folder = tmpFolder();
  saveSeriesGlossary(folder, [e("Neo", "person")]);
  expect(fs.existsSync(path.join(folder, SERIES_GLOSSARY_FILE))).toBe(true);
  expect(loadSeriesGlossary(folder)).toEqual({
    terms: [e("Neo", "person")],
    excluded: [],
  });
});

it("returns empty data for missing or corrupted file", () => {
  const folder = tmpFolder();
  expect(loadSeriesGlossary(folder)).toEqual({ terms: [], excluded: [] });
  fs.writeFileSync(path.join(folder, SERIES_GLOSSARY_FILE), "{oops");
  expect(loadSeriesGlossary(folder)).toEqual({ terms: [], excluded: [] });
});

it("fills missing category as 'term' when loading legacy entries", () => {
  const folder = tmpFolder();
  fs.writeFileSync(
    path.join(folder, SERIES_GLOSSARY_FILE),
    JSON.stringify({ terms: [{ term: "Neo", translation: "尼歐" }] })
  );
  expect(loadSeriesGlossary(folder).terms[0].category).toBe("term");
});
```

同檔案新增:

```ts
describe("excluded list", () => {
  it("merge skips excluded terms case-insensitively", () => {
    const merged = mergeIntoSeriesGlossary(
      [e("Neo")],
      [e("Trinity"), e("Morpheus")],
      ["trinity", "neo"]
    );
    expect(merged.map((x) => x.term)).toEqual(["Morpheus"]);
  });

  it("merge without excluded param behaves as before", () => {
    const merged = mergeIntoSeriesGlossary([e("Neo")], [e("neo"), e("Trinity")]);
    expect(merged.map((x) => x.term)).toEqual(["Neo", "Trinity"]);
  });

  it("round-trips excluded through save/load", () => {
    const folder = tmpFolder();
    saveSeriesGlossary(folder, [e("Neo", "person")], ["trinity"]);
    expect(loadSeriesGlossary(folder)).toEqual({
      terms: [e("Neo", "person")],
      excluded: ["trinity"],
    });
  });

  it("legacy file without excluded field loads as empty excluded", () => {
    const folder = tmpFolder();
    fs.writeFileSync(
      path.join(folder, SERIES_GLOSSARY_FILE),
      JSON.stringify({ terms: [e("Neo", "person")] })
    );
    expect(loadSeriesGlossary(folder).excluded).toEqual([]);
  });

  it("save returns true on success and false on failure", () => {
    const folder = tmpFolder();
    expect(saveSeriesGlossary(folder, [e("Neo", "person")])).toBe(true);
    expect(
      saveSeriesGlossary(path.join(folder, "no-such-dir"), [e("Neo", "person")])
    ).toBe(false);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm test -- tests/unit/seriesGlossary.test.ts`
Expected: FAIL——`loadSeriesGlossary` 回傳陣列不是物件、`mergeIntoSeriesGlossary` 忽略第三參數、`saveSeriesGlossary` 回傳 `undefined`。

- [ ] **Step 3: 改寫 `seriesGlossary.ts` 的型別與三個函式**

型別區(檔案開頭,`import` 之後):

```ts
export type SeriesGlossaryEntry = GlossaryEntry & { userEdited?: boolean };

export interface SeriesGlossaryData {
  terms: SeriesGlossaryEntry[];
  excluded: string[];
}
```

`loadSeriesGlossary` 整個函式改為:

```ts
export function loadSeriesGlossary(folder: string): SeriesGlossaryData {
  const file = path.join(folder, SERIES_GLOSSARY_FILE);
  if (!fs.existsSync(file)) return { terms: [], excluded: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const terms = Array.isArray(parsed.terms)
      ? parsed.terms
          .filter(
            (t: any) =>
              t && typeof t.term === "string" && typeof t.translation === "string"
          )
          .map((t: any) => ({ ...t, category: t.category ?? "term" }))
      : [];
    const excluded = Array.isArray(parsed.excluded)
      ? parsed.excluded.filter((t: any) => typeof t === "string")
      : [];
    return { terms, excluded };
  } catch {
    return { terms: [], excluded: [] };
  }
}
```

`mergeIntoSeriesGlossary` 簽名加第三參數,迴圈開頭加排除判斷(其餘不動):

```ts
export function mergeIntoSeriesGlossary(
  existing: SeriesGlossaryEntry[],
  incoming: SeriesGlossaryEntry[],
  excluded: string[] = []
): SeriesGlossaryEntry[] {
  const excludedSet = new Set(excluded.map((t) => t.toLowerCase()));
  const seen = new Set<string>();
  const merged: SeriesGlossaryEntry[] = [];
  for (const entry of [...existing, ...incoming]) {
    if (!Object.hasOwn(CATEGORY_PRIORITY, entry.category)) continue; // 准入過濾
    const key = entry.term.toLowerCase();
    if (excludedSet.has(key)) continue; // 使用者刪除過的條目永久排除
    if (seen.has(key)) continue; // 先到者勝
    seen.add(key);
    merged.push(entry);
  }
  if (merged.length <= SERIES_GLOSSARY_CAP) return merged;
  return merged
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        CATEGORY_PRIORITY[a.entry.category] - CATEGORY_PRIORITY[b.entry.category] ||
        a.index - b.index
    )
    .slice(0, SERIES_GLOSSARY_CAP)
    .map(({ entry }) => entry);
}
```

(cap 裁切段與現行完全相同,僅簽名與迴圈開頭兩行有變。)

`saveSeriesGlossary` 改為:

```ts
export function saveSeriesGlossary(
  folder: string,
  terms: SeriesGlossaryEntry[],
  excluded: string[] = []
): boolean {
  try {
    fs.writeFileSync(
      path.join(folder, SERIES_GLOSSARY_FILE),
      JSON.stringify({ terms, excluded }, null, 2),
      "utf8"
    );
    return true;
  } catch {
    // 寫入失敗不阻斷翻譯（例如唯讀資料夾）；呼叫端可依回傳值決定是否上報
    return false;
  }
}
```

`enforceReconciliation` 完全不動。

- [ ] **Step 4: 更新 `pipeline.ts` 呼叫點,excluded 全程傳遞**

`pipeline.ts:168` 改為(解構後變數名不變,其餘使用點不受影響):

```ts
const { terms: seriesTerms, excluded: seriesExcluded } = loadSeriesGlossary(folder);
```

`pipeline.ts:212-213` 改為:

```ts
const combinedGlossary = mergeIntoSeriesGlossary(seriesTerms, episodeGlossary, seriesExcluded);
saveSeriesGlossary(folder, combinedGlossary, seriesExcluded);
```

- [ ] **Step 5: 更新 `tests/unit/pipeline.series.test.ts` 的四個呼叫點**

該檔以舊簽名讀取結果,四處 `loadSeriesGlossary(folder)` 後面補 `.terms`:

```ts
// line 57
expect(loadSeriesGlossary(folder).terms.map((t) => t.term)).toEqual(["Neo"]);
// line 70
const terms = loadSeriesGlossary(folder).terms.map((t) => t.term).sort();
// line 109-110
const glossary = loadSeriesGlossary(folder).terms;
const byTerm = Object.fromEntries(glossary.map((g) => [g.term, g.translation]));
// line 137
const terms = loadSeriesGlossary(folder).terms.map((t) => t.term).sort();
```

- [ ] **Step 6: 跑全部測試與型別檢查**

Run: `npm test`
Expected: 全數 PASS。

Run: `npx tsc --noEmit`
Expected: 無錯誤。

- [ ] **Step 7: Commit**

```bash
git add electron/main/utils/seriesGlossary.ts electron/main/utils/pipeline.ts tests/unit/seriesGlossary.test.ts tests/unit/pipeline.series.test.ts
git commit -m "feat(glossary): add excluded list and userEdited to series glossary format"
```

---

### Task 2: 操作函式——editGlossaryTranslation / deleteGlossaryTerm / applyGlossaryOp

**Files:**
- Modify: `electron/main/utils/seriesGlossary.ts`(檔尾新增)
- Test: `tests/unit/seriesGlossary.test.ts`(新增 describe)

**Interfaces:**
- Consumes: Task 1 的 `SeriesGlossaryData`、`loadSeriesGlossary`、`saveSeriesGlossary`
- Produces(Task 3 依賴):
  - `type GlossaryOp = { type: "edit"; term: string; translation: string } | { type: "delete"; term: string }`
  - `editGlossaryTranslation(data: SeriesGlossaryData, term: string, translation: string): SeriesGlossaryData`(未套用時回傳**同一個** `data` 物件參照)
  - `deleteGlossaryTerm(data: SeriesGlossaryData, term: string): SeriesGlossaryData`
  - `applyGlossaryOp(folder: string, op: GlossaryOp): { terms: SeriesGlossaryEntry[] }`(寫檔失敗 throw `Error("Failed to write series glossary")`)

- [ ] **Step 1: 寫失敗測試**

`tests/unit/seriesGlossary.test.ts` 新增(import 區補上三個新函式與 `applyGlossaryOp`):

```ts
describe("editGlossaryTranslation", () => {
  const data = () => ({
    terms: [{ term: "Baek Hyun-woo", translation: "白賢宇", category: "person" as const }],
    excluded: [] as string[],
  });

  it("updates translation and marks userEdited", () => {
    const next = editGlossaryTranslation(data(), "Baek Hyun-woo", "白賢祐");
    expect(next.terms[0]).toEqual({
      term: "Baek Hyun-woo",
      translation: "白賢祐",
      category: "person",
      userEdited: true,
    });
  });

  it("matches term case-insensitively", () => {
    const next = editGlossaryTranslation(data(), "baek hyun-woo", "白賢祐");
    expect(next.terms[0].translation).toBe("白賢祐");
  });

  it("returns same object when translation is blank", () => {
    const d = data();
    expect(editGlossaryTranslation(d, "Baek Hyun-woo", "   ")).toBe(d);
  });

  it("returns same object when term not found", () => {
    const d = data();
    expect(editGlossaryTranslation(d, "Nobody", "誰")).toBe(d);
  });

  it("trims the new translation", () => {
    const next = editGlossaryTranslation(data(), "Baek Hyun-woo", " 白賢祐 ");
    expect(next.terms[0].translation).toBe("白賢祐");
  });
});

describe("deleteGlossaryTerm", () => {
  it("removes the entry and records lowercase term in excluded", () => {
    const next = deleteGlossaryTerm(
      { terms: [e("Neo", "person"), e("Trinity", "person")], excluded: [] },
      "Neo"
    );
    expect(next.terms.map((x) => x.term)).toEqual(["Trinity"]);
    expect(next.excluded).toEqual(["neo"]);
  });

  it("is a no-op on repeated delete", () => {
    const once = deleteGlossaryTerm({ terms: [e("Neo")], excluded: [] }, "Neo");
    const twice = deleteGlossaryTerm(once, "neo");
    expect(twice.terms).toEqual([]);
    expect(twice.excluded).toEqual(["neo"]);
  });
});

describe("applyGlossaryOp", () => {
  it("edit op persists to the folder file", () => {
    const folder = tmpFolder();
    saveSeriesGlossary(folder, [{ ...e("Neo", "person"), translation: "尼奧" }]);
    const { terms } = applyGlossaryOp(folder, {
      type: "edit",
      term: "Neo",
      translation: "尼歐",
    });
    expect(terms[0].translation).toBe("尼歐");
    expect(loadSeriesGlossary(folder).terms[0]).toMatchObject({
      translation: "尼歐",
      userEdited: true,
    });
  });

  it("delete op persists terms and excluded", () => {
    const folder = tmpFolder();
    saveSeriesGlossary(folder, [e("Neo", "person")]);
    const { terms } = applyGlossaryOp(folder, { type: "delete", term: "Neo" });
    expect(terms).toEqual([]);
    expect(loadSeriesGlossary(folder).excluded).toEqual(["neo"]);
  });

  it("no-op edit does not rewrite the file", () => {
    const folder = tmpFolder();
    saveSeriesGlossary(folder, [e("Neo", "person")]);
    const before = fs.statSync(path.join(folder, SERIES_GLOSSARY_FILE)).mtimeMs;
    applyGlossaryOp(folder, { type: "edit", term: "Nobody", translation: "誰" });
    const after = fs.statSync(path.join(folder, SERIES_GLOSSARY_FILE)).mtimeMs;
    expect(after).toBe(before);
  });

  it("throws when the folder is not writable", () => {
    const folder = tmpFolder();
    saveSeriesGlossary(folder, [e("Neo", "person")]);
    fs.chmodSync(folder, 0o500); // 唯讀資料夾
    try {
      expect(() =>
        applyGlossaryOp(folder, { type: "delete", term: "Neo" })
      ).toThrow("Failed to write series glossary");
    } finally {
      fs.chmodSync(folder, 0o700);
    }
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm test -- tests/unit/seriesGlossary.test.ts`
Expected: FAIL——新函式尚未定義(import error 或 not a function)。

- [ ] **Step 3: 在 `seriesGlossary.ts` 檔尾實作**

```ts
export type GlossaryOp =
  | { type: "edit"; term: string; translation: string }
  | { type: "delete"; term: string };

export function editGlossaryTranslation(
  data: SeriesGlossaryData,
  term: string,
  translation: string
): SeriesGlossaryData {
  const trimmed = translation.trim();
  if (!trimmed) return data; // 空譯名不套用
  const key = term.toLowerCase();
  const index = data.terms.findIndex((t) => t.term.toLowerCase() === key);
  if (index === -1) return data; // 找不到不套用
  const terms = data.terms.slice();
  terms[index] = { ...terms[index], translation: trimmed, userEdited: true };
  return { terms, excluded: data.excluded };
}

export function deleteGlossaryTerm(
  data: SeriesGlossaryData,
  term: string
): SeriesGlossaryData {
  const key = term.toLowerCase();
  const terms = data.terms.filter((t) => t.term.toLowerCase() !== key);
  const excluded = data.excluded.includes(key)
    ? data.excluded
    : [...data.excluded, key];
  return { terms, excluded };
}

// IPC handler 的完整流程：load → 套用 → save。驗證未通過時回傳現況、不寫檔；
// 寫檔失敗 throw 讓 renderer 顯示錯誤。
export function applyGlossaryOp(
  folder: string,
  op: GlossaryOp
): { terms: SeriesGlossaryEntry[] } {
  const data = loadSeriesGlossary(folder);
  const next =
    op.type === "edit"
      ? editGlossaryTranslation(data, op.term, op.translation)
      : deleteGlossaryTerm(data, op.term);
  if (next !== data) {
    if (!saveSeriesGlossary(folder, next.terms, next.excluded)) {
      throw new Error("Failed to write series glossary");
    }
  }
  return { terms: next.terms };
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npm test -- tests/unit/seriesGlossary.test.ts`
Expected: 全數 PASS。

- [ ] **Step 5: Commit**

```bash
git add electron/main/utils/seriesGlossary.ts tests/unit/seriesGlossary.test.ts
git commit -m "feat(glossary): add edit/delete ops with applyGlossaryOp orchestration"
```

---

### Task 3: IPC handlers 接線

**Files:**
- Modify: `electron/main/index.ts`(import 區 + 檔尾 handler 區,緊接 `get-subtitle-preview` 之後)

**Interfaces:**
- Consumes: Task 1 `loadSeriesGlossary`、Task 2 `applyGlossaryOp` / `GlossaryOp`
- Produces(Task 4 依賴的 IPC 通道):
  - `ipcRenderer.invoke("get-series-glossary", filePath: string)` → `{ terms: SeriesGlossaryEntry[] }`
  - `ipcRenderer.invoke("update-series-glossary", { filePath: string, op: GlossaryOp })` → `{ terms: SeriesGlossaryEntry[] }`;寫檔失敗時 invoke 會 reject

- [ ] **Step 1: 加 import 與兩個 handler**

`electron/main/index.ts` import 區(第 9 行附近)加:

```ts
import { loadSeriesGlossary, applyGlossaryOp } from "./utils/seriesGlossary";
import type { GlossaryOp } from "./utils/seriesGlossary";
```

`get-subtitle-preview` handler 之後加:

```ts
// 系列詞彙表讀寫：renderer 傳檔案路徑，main 以其所在資料夾為準
ipcMain.handle("get-series-glossary", async (_, filePath: string) => {
  return { terms: loadSeriesGlossary(path.dirname(filePath)).terms };
});

ipcMain.handle(
  "update-series-glossary",
  async (_, { filePath, op }: { filePath: string; op: GlossaryOp }) => {
    return applyGlossaryOp(path.dirname(filePath), op);
  }
);
```

- [ ] **Step 2: 型別檢查**

Run: `npx tsc --noEmit`
Expected: 無錯誤。

- [ ] **Step 3: Commit**

```bash
git add electron/main/index.ts
git commit -m "feat(glossary): add get/update series glossary IPC handlers"
```

---

### Task 4: GlossaryEditor 元件 + TranslatorPanel 接入 + i18n

**Files:**
- Create: `src/components/GlossaryEditor.tsx`
- Modify: `src/components/TranslatorPanel.tsx`(import 區;modal 內 542-569 行的 context 區塊)
- Modify: `src/locales/en-US.json`、`src/locales/zh-TW.json`、`src/locales/zh-CN.json`(`translate.context` 區塊)

**Interfaces:**
- Consumes: Task 3 的兩個 IPC 通道
- Produces: `<GlossaryEditor filePath={string} isTranslating={boolean} fallbackGlossary={Array<{term, translation, category?}>} />`

- [ ] **Step 1: 三個語言檔的 `translate.context` 區塊各加五個 key**

`zh-TW.json`(`"glossary": "詞彙表"` 之後):

```json
"series_glossary": "系列詞彙表",
"user_edited": "使用者修改過，譯名已鎖定",
"confirm_delete": "確認刪除？",
"retranslate_hint": "已更新系列詞彙表；已翻譯的檔案需重新翻譯才會套用新譯名",
"save_error": "寫入詞彙表失敗，請檢查資料夾權限"
```

`zh-CN.json`:

```json
"series_glossary": "系列词汇表",
"user_edited": "用户修改过，译名已锁定",
"confirm_delete": "确认删除？",
"retranslate_hint": "已更新系列词汇表；已翻译的文件需重新翻译才会应用新译名",
"save_error": "写入词汇表失败，请检查文件夹权限"
```

`en-US.json`:

```json
"series_glossary": "Series glossary",
"user_edited": "Edited by user — translation locked",
"confirm_delete": "Delete?",
"retranslate_hint": "Series glossary updated; re-translate finished files to apply the new names",
"save_error": "Failed to write glossary file — check folder permissions"
```

- [ ] **Step 2: 建立 `src/components/GlossaryEditor.tsx`**

```tsx
import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ipcRenderer } from "electron";

interface GlossaryEntry {
  term: string;
  translation: string;
  category?: string;
  userEdited?: boolean;
}

type GlossaryOp =
  | { type: "edit"; term: string; translation: string }
  | { type: "delete"; term: string };

interface GlossaryEditorProps {
  filePath: string;
  isTranslating: boolean;
  /** series glossary 為空時退回唯讀顯示的該檔分析詞彙表 */
  fallbackGlossary: GlossaryEntry[];
}

export default function GlossaryEditor({
  filePath,
  isTranslating,
  fallbackGlossary,
}: GlossaryEditorProps) {
  const { t } = useTranslation();
  const [terms, setTerms] = useState<GlossaryEntry[]>([]);
  const [editingTerm, setEditingTerm] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [confirmTerm, setConfirmTerm] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState(false);

  const reload = async () => {
    try {
      const result = await ipcRenderer.invoke("get-series-glossary", filePath);
      setTerms(result.terms);
    } catch {
      setTerms([]);
    }
  };

  useEffect(() => {
    reload();
  }, [filePath]);

  // 翻譯結束時重新讀取——pipeline 過程中會合併寫入新條目
  const prevTranslating = useRef(isTranslating);
  useEffect(() => {
    if (prevTranslating.current && !isTranslating) reload();
    prevTranslating.current = isTranslating;
  }, [isTranslating]);

  const applyOp = async (op: GlossaryOp) => {
    setError(false);
    try {
      const result = await ipcRenderer.invoke("update-series-glossary", {
        filePath,
        op,
      });
      setTerms(result.terms);
      setDirty(true);
    } catch {
      setError(true);
    }
  };

  const commitEdit = (term: string) => {
    const value = editValue.trim();
    const current = terms.find((x) => x.term === term);
    setEditingTerm(null);
    if (!value || !current || value === current.translation) return;
    applyOp({ type: "edit", term, translation: value });
  };

  // series glossary 為空 → 退回現行唯讀顯示（行為與改動前相同）
  if (terms.length === 0) {
    if (fallbackGlossary.length === 0) return null;
    return (
      <>
        <div className="text-sm font-medium text-slate-700">
          {t("translate.context.glossary")}
        </div>
        <ul className="text-sm mt-1 space-y-0.5">
          {fallbackGlossary.map((g, i) => (
            <li key={i}>
              <span className="font-medium">{g.term}</span>: {g.translation}
            </li>
          ))}
        </ul>
      </>
    );
  }

  return (
    <>
      <div className="text-sm font-medium text-slate-700">
        {t("translate.context.series_glossary")}
      </div>
      <ul className="text-sm mt-1 space-y-0.5">
        {terms.map((g) => (
          <li
            key={g.term}
            className="flex items-center gap-1"
            onMouseLeave={() => setConfirmTerm(null)}
          >
            <span className="font-medium">{g.term}</span>
            {g.userEdited && (
              <i
                className="bx bx-lock-alt text-slate-400"
                title={t("translate.context.user_edited")}
              />
            )}
            <span>:</span>
            {editingTerm === g.term ? (
              <input
                autoFocus
                className="border border-gray-300 rounded px-1 text-sm"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitEdit(g.term);
                  if (e.key === "Escape") setEditingTerm(null);
                }}
                onBlur={() => commitEdit(g.term)}
              />
            ) : (
              <span
                className={
                  isTranslating ? "opacity-50" : "cursor-pointer hover:underline"
                }
                onClick={() => {
                  if (isTranslating) return;
                  setEditingTerm(g.term);
                  setEditValue(g.translation);
                }}
              >
                {g.translation}
              </span>
            )}
            {confirmTerm === g.term ? (
              <button
                className="text-red-500 text-xs font-medium"
                onClick={() => {
                  setConfirmTerm(null);
                  applyOp({ type: "delete", term: g.term });
                }}
              >
                {t("translate.context.confirm_delete")}
              </button>
            ) : (
              <button
                disabled={isTranslating}
                className="text-slate-400 hover:text-red-500 disabled:opacity-30 disabled:hover:text-slate-400"
                onClick={() => setConfirmTerm(g.term)}
              >
                <i className="bx bx-trash" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {dirty && (
        <p className="text-xs text-slate-500 mt-1">
          {t("translate.context.retranslate_hint")}
        </p>
      )}
      {error && (
        <p className="text-xs text-red-500 mt-1">
          {t("translate.context.save_error")}
        </p>
      )}
    </>
  );
}
```

- [ ] **Step 3: 接入 `TranslatorPanel.tsx`**

import 區加:

```tsx
import GlossaryEditor from "@/components/GlossaryEditor";
```

modal 內 542-569 行的區塊(`{selectedAnalysis && (...)}` 整段)改為——注意 GlossaryEditor 移到 `selectedAnalysis` 條件**之外**,因為 `get-analysis` 讀的是 main process 記憶體快取,重開 app 後為空,但 series glossary 檔案還在,必須照樣可編輯:

```tsx
<div className="mb-4">
  {selectedAnalysis && (
    <>
      <div className="text-md font-semibold mb-1">
        {t("translate.context.title")}
      </div>
      <div className="text-sm font-medium text-slate-700">
        {t("translate.context.plot_summary")}
      </div>
      <p className="text-sm whitespace-pre-wrap mb-2">
        {selectedAnalysis.plotSummary}
      </p>
    </>
  )}
  {selectedFile && (
    <GlossaryEditor
      filePath={selectedFile.path}
      isTranslating={isTranslating}
      fallbackGlossary={selectedAnalysis?.glossary ?? []}
    />
  )}
  <hr className="my-2" />
</div>
```

(`<hr>` 在無分析且無詞彙表時會單獨出現一條,屬可接受的邊角外觀;不為此增加狀態提升。)

- [ ] **Step 4: 型別檢查與全部測試**

Run: `npx tsc --noEmit`
Expected: 無錯誤。

Run: `npm test`
Expected: 全數 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/components/GlossaryEditor.tsx src/components/TranslatorPanel.tsx src/locales/en-US.json src/locales/zh-TW.json src/locales/zh-CN.json
git commit -m "feat(glossary): editable series glossary in file modal"
```

---

### Task 5: 整合驗證(手動 smoke test)

**Files:** 無新增修改;純驗證。

**Interfaces:**
- Consumes: Task 1-4 全部成果。

- [ ] **Step 1: 完整測試與型別檢查**

Run: `npm test && npx tsc --noEmit`
Expected: 全數 PASS、無型別錯誤。

- [ ] **Step 2: i18n key 同步檢查**

以 `/i18n-sync` 技能(或手動 diff 三個語言檔的 key)確認 `translate.context` 下五個新 key 三語齊全。
Expected: 無缺漏。

- [ ] **Step 3: 手動 smoke test(`npm run dev`)**

依序驗證,全部應成立:

1. 拖入曾翻譯過的字幕檔(所在資料夾有 `.series-glossary.json`),開 modal → 顯示「系列詞彙表」與條目。
2. 點擊某條譯名 → 變 input;改字後 Enter → 清單更新、出現重翻提示;開啟該資料夾的 `.series-glossary.json` 確認 `translation` 已改且該條目有 `"userEdited": true`;UI 該條目出現鎖頭 icon。
3. Esc 或改成空白 → 不寫入。
4. 點垃圾桶 → 變紅色「確認刪除?」;再點 → 條目消失;JSON 檔 `excluded` 出現該 term(小寫)。滑鼠移開後按鈕復原則為取消。
5. 對同資料夾另一集執行翻譯 → 翻譯完成後被刪條目**沒有**回到詞彙表(排除清單生效);編輯過的譯名維持使用者版本(LOCKED 生效)。
6. 翻譯進行中開 modal → 譯名不可點擊、垃圾桶 disabled;翻譯結束後(modal 開著)詞彙表自動更新為合併後內容。
7. 重開 app、拖入同一檔案開 modal(不翻譯)→ 沒有劇情摘要,但「系列詞彙表」照常顯示且可編輯。

- [ ] **Step 4: 完成處理**

驗證全數通過後,使用 superpowers:finishing-a-development-branch 技能決定合併方式。
