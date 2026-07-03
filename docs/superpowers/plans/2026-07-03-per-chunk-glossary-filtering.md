# 詞彙表按 chunk 過濾 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每個翻譯請求只附帶該段文字中實際出現的詞彙表條目,省 token 並提高譯名遵從度。

**Architecture:** 純函式 `filterGlossaryForText`(`analysis.ts`)做匹配;`pipeline.ts` 移除一次性組 `combinedAdditional`,改為 `contextFor(texts)` helper 在三個呼叫點(chunk 翻譯、視窗內逐行修補、檔尾 fallback)各自過濾。劇情摘要維持全量。`translate.ts` 介面完全不動。

**Tech Stack:** TypeScript、Vitest。

**Spec:** `docs/superpowers/specs/2026-07-03-per-chunk-glossary-filtering-design.md`(需求依據,歧義以 spec 為準)。

## Global Constraints

- `translate.ts` 介面不動(仍收 `additional` 字串);既有 mock 測試不得需要修改。
- 匹配原則「誤含便宜、漏掉昂貴」:term 首尾皆英數 → `\b` regex(大小寫不敏感);否則 substring。term 一律 regex-escape。
- 劇情摘要每個請求全量附帶;`analysisData`(進度事件、modal、快取)維持全量詞彙表。
- 零命中時沿用 `formatAnalysisContext` 既有行為(省略整個 Glossary 區段)。
- 刻意不做 matcher 預編譯。
- 單元測試在 `tests/unit/`,`npm test`(Vitest);型別檢查 `npx tsc --noEmit`。
- Commit 訊息結尾附:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01FE8AQDuh46eYKWEF53vSEk`

---

### Task 1: filterGlossaryForText 純函式

**Files:**
- Modify: `electron/main/utils/analysis.ts`(`formatAnalysisContext` 之後新增;export 區補名)
- Test: `tests/unit/analysis.test.ts`

**Interfaces:**
- Consumes: 既有 `GlossaryEntry`(`{ term, translation, category }`)
- Produces(Task 2 依賴):`filterGlossaryForText(glossary: GlossaryEntry[], texts: string[]): GlossaryEntry[]` — 回傳命中的子集,維持原順序

- [ ] **Step 1: 寫失敗測試**

`tests/unit/analysis.test.ts` 的 import 區補上 `filterGlossaryForText`,檔尾新增:

```ts
describe("filterGlossaryForText", () => {
  const g = (term: string, category: any = "person") => ({
    term,
    translation: `譯${term}`,
    category,
  });

  it("keeps only terms that appear in the texts, preserving order", () => {
    const result = filterGlossaryForText(
      [g("Neo"), g("Trinity"), g("Morpheus")],
      ["Neo talks to Trinity.", "another line"]
    );
    expect(result.map((x) => x.term)).toEqual(["Neo", "Trinity"]);
  });

  it("matches case-insensitively", () => {
    expect(filterGlossaryForText([g("Neo")], ["NEO!"])).toHaveLength(1);
  });

  it("does not match inside longer words (Bae vs Baek)", () => {
    expect(filterGlossaryForText([g("Bae")], ["Baek Hyun-woo appears"])).toEqual([]);
  });

  it("matches inflected forms separated by non-word characters", () => {
    expect(filterGlossaryForText([g("Hyunwoo")], ["Hyunwoo's plan"])).toHaveLength(1);
    expect(filterGlossaryForText([g("Hyein")], ["Hyein-ah, come here"])).toHaveLength(1);
  });

  it("matches CJK terms by substring", () => {
    expect(
      filterGlossaryForText([g("女王集團", "organization")], ["歡迎來到女王集團總部"])
    ).toHaveLength(1);
  });

  it("escapes regex special characters inside terms", () => {
    // 未 escape 時 'Mr. Kim' 的 '.' 會誤中 'Mrs Kim'
    expect(filterGlossaryForText([g("Mr. Kim")], ["Mrs Kim arrived"])).toEqual([]);
    expect(filterGlossaryForText([g("Mr. Kim")], ["Mr. Kim arrived"])).toHaveLength(1);
    // 首尾非英數的 term 走 substring，特殊字元不得炸掉
    expect(
      filterGlossaryForText([g("J Hotel (Seoul)", "place")], ["at J Hotel (Seoul) tonight"])
    ).toHaveLength(1);
  });

  it("returns empty for empty glossary or blank texts", () => {
    expect(filterGlossaryForText([], ["Neo"])).toEqual([]);
    expect(filterGlossaryForText([g("Neo")], ["", "  "])).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm test -- tests/unit/analysis.test.ts`
Expected: FAIL——`filterGlossaryForText is not a function`(或 import error)。

- [ ] **Step 3: 實作**

`electron/main/utils/analysis.ts`,放在 `formatAnalysisContext` 之後:

```ts
// 每個 chunk 只送出現在該段文字中的詞條：誤含便宜、漏掉昂貴，匹配從寬——
// 首尾皆英數的 term 用 \b 邊界避免子字串誤中（Bae 不中 Baek，變格如
// Hyunwoo's 因界符為非字元仍命中），其他（CJK 等）用 substring。
function filterGlossaryForText(
  glossary: GlossaryEntry[],
  texts: string[]
): GlossaryEntry[] {
  const haystack = texts.join("\n").toLowerCase();
  if (!haystack.trim() || glossary.length === 0) return [];
  return glossary.filter((g) => {
    const term = g.term.trim().toLowerCase();
    if (!term) return false;
    if (/^[a-z0-9]/.test(term) && /[a-z0-9]$/.test(term)) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`\\b${escaped}\\b`).test(haystack);
    }
    return haystack.includes(term);
  });
}
```

export 區(現有 `formatAnalysisContext,` 之後)加一行 `filterGlossaryForText,`。

- [ ] **Step 4: 跑測試確認通過**

Run: `npm test -- tests/unit/analysis.test.ts`
Expected: 全數 PASS。

- [ ] **Step 5: Commit**

```bash
git add electron/main/utils/analysis.ts tests/unit/analysis.test.ts
git commit -m "feat(analyze): add filterGlossaryForText for per-chunk glossary filtering"
```

---

### Task 2: pipeline 三個接線點改用 contextFor

**Files:**
- Modify: `electron/main/utils/pipeline.ts`(import、line 180 附近、line 238 附近、三個 `additional:` 呼叫點)
- Test: `tests/unit/pipeline.characterization.test.ts`(新增 describe)

**Interfaces:**
- Consumes: Task 1 的 `filterGlossaryForText(glossary, texts)`;既有 `formatAnalysisContext(analysis)`
- Produces: 行為變更——每個翻譯請求的 `additional` 只含命中詞條;無對外新介面

- [ ] **Step 1: 寫失敗測試**

`tests/unit/pipeline.characterization.test.ts` 檔尾新增(沿用檔內既有 mock 佈置;glossary 用 term/place 類別,避開 person 的調和路徑——此檔的 module mock 沒有提供 `reconcileGlossary`):

```ts
describe("per-chunk glossary filtering", () => {
  const NUM = 30; // 兩個 chunk：core 0-19（window 0-24）與 core 20-29（window 15-29）

  function makeLongSrt(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stx-filter-"));
    const blocks: string[] = [];
    for (let i = 0; i < NUM; i++) {
      const text =
        i === 0 ? "Neo appears" : i === NUM - 1 ? "Trinity appears" : `filler line ${i}`;
      const s = String(i + 1).padStart(2, "0");
      blocks.push(`${i + 1}\n00:00:${s},000 --> 00:00:${s},500\n${text}`);
    }
    const p = path.join(dir, "long.srt");
    fs.writeFileSync(p, blocks.join("\n\n") + "\n", "utf8");
    return p;
  }

  function mockAnalysisWithTwoTerms() {
    vi.mocked(translate.analyzeSubtitlesForContext).mockReset().mockResolvedValue({
      plotSummary: "part-summary",
      glossary: [
        { term: "Neo", translation: "尼歐", category: "term" },
        { term: "Trinity", translation: "崔妮蒂", category: "place" },
      ],
    } as any);
  }

  it("sends each chunk only the glossary terms present in its window", async () => {
    const file = makeLongSrt();
    mockAnalysisWithTwoTerms();

    await translateFile({ path: file, name: "long.srt" }, BASE_PARAMS, () => {});

    const calls = vi.mocked(translate.translateSubtitleChunk).mock.calls;
    expect(calls).toHaveLength(2);
    const additionals = calls.map((c: any) => c[1].additional as string);
    const withNeo = additionals.find((a) => a.includes("- Neo:"))!;
    const withTrinity = additionals.find((a) => a.includes("- Trinity:"))!;
    expect(withNeo).toBeDefined();
    expect(withTrinity).toBeDefined();
    expect(withNeo).not.toContain("- Trinity:"); // chunk1 視窗（0-24）沒有句 30
    expect(withTrinity).not.toContain("- Neo:"); // chunk2 視窗（15-29）沒有句 1
    // 摘要全量：兩個 chunk 都要有合成後的 plotSummary
    expect(withNeo).toContain("combined-summary");
    expect(withTrinity).toContain("combined-summary");
  });

  it("filters per line in the end-of-file fallback and omits glossary on zero hits", async () => {
    const file = makeLongSrt();
    mockAnalysisWithTwoTerms();
    // 路徑說明：chunk 失敗後句子會先走「視窗內逐行修補」（341），修補也失敗
    // 才會落到檔尾 fallback（444）。讓單行翻譯「每個文字第一次失敗、之後成功」：
    // 修補階段全數失敗，檔尾 fallback 的第二次呼叫成功——對每句而言，
    // 「最後一次」的 translateSubtitleSingle 呼叫即來自檔尾 fallback。
    vi.mocked(translate.translateSubtitleChunk).mockReset()
      .mockRejectedValue(new Error("boom")); // 非網路錯誤 → retryTranslate 不重試
    const seen = new Set<string>();
    vi.mocked(translate.translateSubtitleSingle).mockReset()
      .mockImplementation(async (s: string) => {
        if (!seen.has(s)) {
          seen.add(s);
          throw new Error("first-try boom");
        }
        return `T:${s}`;
      });

    await translateFile({ path: file, name: "long.srt" }, BASE_PARAMS, () => {});

    const calls = vi.mocked(translate.translateSubtitleSingle).mock.calls;
    // 「Neo appears」是句 1，只在 chunk1 視窗內 → 修補失敗一次 + 檔尾一次，
    // 取最後一次呼叫（檔尾 fallback，pipeline.ts:444 路徑）
    const neoCalls = calls.filter((c: any) => c[0] === "Neo appears");
    expect(neoCalls.length).toBeGreaterThanOrEqual(2);
    const lastNeo = neoCalls[neoCalls.length - 1] as any;
    expect(lastNeo[1].additional).toContain("- Neo:");
    expect(lastNeo[1].additional).not.toContain("- Trinity:");
    const fillerCalls = calls.filter((c: any) => c[0] === "filler line 5");
    const lastFiller = fillerCalls[fillerCalls.length - 1] as any;
    expect(lastFiller[1].additional).not.toContain("## Glossary"); // 零命中省略整區
    expect(lastFiller[1].additional).toContain("combined-summary");
  });

  it("filters per line in the window-repair path after misaligned chunks", async () => {
    const file = makeLongSrt();
    mockAnalysisWithTwoTerms();
    // chunk 回傳長度不符 → 視窗內逐行修補（pipeline.ts:341 路徑）
    vi.mocked(translate.translateSubtitleChunk).mockReset()
      .mockImplementation(async () => ["misaligned"]);

    await translateFile({ path: file, name: "long.srt" }, BASE_PARAMS, () => {});

    const calls = vi.mocked(translate.translateSubtitleSingle).mock.calls;
    const neoCall = calls.find((c: any) => c[0] === "Neo appears")!;
    expect(neoCall).toBeDefined();
    expect(neoCall[1].additional).toContain("- Neo:");
    expect(neoCall[1].additional).not.toContain("- Trinity:");
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm test -- tests/unit/pipeline.characterization.test.ts`
Expected: 三個新測試 FAIL——現行每個請求的 `additional` 是全量詞彙表(`withNeo` 也含 `- Trinity:`)。

- [ ] **Step 3: 改 `pipeline.ts`**

import 區(line 8)改為:

```ts
import { hashContent, analysisCachePath, getOrCreateAnalysis, formatAnalysisContext, alignPlotSummaryWithGlossary, filterGlossaryForText } from "./analysis";
```

line 180 附近,`let combinedAdditional = params.additional || "";` 改為:

```ts
const baseAdditional = params.additional || "";
```

line 238 附近,刪除這一行(`analysisData` 重指派與 `onProgress` 保留不動):

```ts
combinedAdditional = `${combinedAdditional ? combinedAdditional + "\n\n" : ""}${formatAnalysisContext(analysisData)}`;
```

在分析的 try/catch 結束後、`// Translate` 註解之前,新增:

```ts
    // 每個請求只送命中的詞條：摘要全量，詞彙表按該段文字過濾（spec:
    // docs/superpowers/specs/2026-07-03-per-chunk-glossary-filtering-design.md）
    const contextFor = (texts: string[]) =>
      analysisData
        ? `${baseAdditional ? baseAdditional + "\n\n" : ""}${formatAnalysisContext({
            plotSummary: analysisData.plotSummary,
            glossary: filterGlossaryForText(analysisData.glossary, texts),
          })}`
        : baseAdditional;
```

三個呼叫點的 `additional: combinedAdditional || "",` 分別改為:

1. chunk 翻譯(原 line 302,chunkProcessor 內 `translateSubtitleChunk` 的參數):
   `additional: contextFor(windowText),`
2. 視窗內逐行修補(原 line 341,`translateSubtitleSingle` 的參數,該處單行變數名為 `lineText`):
   `additional: contextFor([lineText]),`
3. 檔尾未翻譯行 fallback(原 line 444,`translateSubtitleSingle` 的參數,該處翻譯的文字是 `cue.data.text`):
   `additional: contextFor([cue.data.text]),`

改完後 `combinedAdditional` 不應再出現於檔案中(`grep combinedAdditional` 應為空)。

- [ ] **Step 4: 跑全部測試與型別檢查**

Run: `npm test`
Expected: 全數 PASS(新增 3 個;既有測試不得需要修改——若有測試因此失敗,先檢查是否漏改呼叫點,而不是改既有測試)。

Run: `npx tsc --noEmit`
Expected: 無錯誤。

- [ ] **Step 5: Commit**

```bash
git add electron/main/utils/pipeline.ts tests/unit/pipeline.characterization.test.ts
git commit -m "feat(pipeline): filter glossary per chunk window instead of sending all entries"
```

---

### Task 3: 手動實測(E01 重翻)

**Files:** 無修改;純驗證。

**Interfaces:**
- Consumes: Task 1-2 全部成果。

- [ ] **Step 1: 重啟 dev server 並重翻**

停掉現有 `npm run dev`(舊 main bundle 不會自動重建),重新啟動後重翻
《淚之女王》E01(分析快取照用)。完成檔重翻會自動全量重做(既有行為)。

- [ ] **Step 2: 譯名正確率不退步**

Run(於字幕資料夾):

```bash
grep -c "慧仁" *.en.translated.srt   # Expected: 0
grep -c "海仁" *.en.translated.srt   # Expected: > 0
```

確認單獨 "Hyunwoo"(原文無 Baek)的句子沒有被譯成全名(於字幕資料夾執行):

```bash
python3 -c "
import re
def blocks(t):
    out={}
    for b in re.split(r'\n\s*\n', t.strip()):
        l=b.strip().split('\n')
        if len(l)>=3: out[l[1].strip()]=' '.join(l[2:])
    return out
s=blocks(open('Queen.of.Tears.Miraculous.Record.zip.S01E01.1080p.TVING.WEB-DL.AAC2.0.H.264-PandaMoon.en.srt',encoding='utf-8',errors='replace').read())
d=blocks(open('Queen.of.Tears.Miraculous.Record.zip.S01E01.1080p.TVING.WEB-DL.AAC2.0.H.264-PandaMoon.en.translated.srt',encoding='utf-8',errors='replace').read())
bad=sum(1 for k,v in s.items() if re.search(r'\bHyun-?woo\b',v,re.I) and not re.search(r'Baek',v,re.I) and k in d and '白賢祐' in d[k])
tot=sum(1 for v in s.values() if re.search(r'\bHyun-?woo\b',v,re.I) and not re.search(r'Baek',v,re.I))
print(f'誤加姓: {bad}/{tot}')  # Expected: 0/31
"
```

- [ ] **Step 3: token 用量下降**

比對 dev log 中翻譯請求的 `inputTokens`(或整體用量)相對過濾前明顯下降
(詞彙表部分預期省 85-90%)。

- [ ] **Step 4: 完成處理**

驗證通過後,使用 superpowers:finishing-a-development-branch 決定合併方式。
