# 詞彙表按 chunk 過濾 — 設計文件

日期:2026-07-03
狀態:已與使用者逐段確認通過

## 背景與目的

目前 `[Context]`(劇情摘要 + 詞彙表)在 `translateFile` 開頭組一次,之後每個
chunk 請求全量附帶。以《淚之女王》E01 為例:50 條詞彙表 × 約 65 個 chunk,
絕大多數詞條與該 chunk 無關——浪費 token,且訊號稀釋會降低模型對詞彙表的
遵從度(對本地小模型影響最大,見 2026-07-03 smoke test 的譯名污染事件)。

本功能改為:**每個 chunk 只送該 chunk 視窗文字中實際出現的詞條**。
劇情摘要維持全量(提供劇情脈絡、語氣與全域一致性錨,使用者確認)。

## 架構總覽

採「pipeline 端每 chunk 重組」:純函式 `filterGlossaryForText` 放在
`analysis.ts`(與 `formatAnalysisContext` 同家),`pipeline.ts` 的
chunkProcessor 與單行 fallback 各自以自己的文字過濾後組 context。
`translate.ts` 介面完全不動(仍收 `additional` 字串),既有 mock 測試不受影響。

## 1. 過濾函式(`electron/main/utils/analysis.ts`)

```ts
function filterGlossaryForText(
  glossary: GlossaryEntry[],
  texts: string[]
): GlossaryEntry[]
```

- `texts` join 成 haystack 後 lowercase 匹配;回傳命中的子集,維持原順序。
- 匹配規則(原則:**誤含便宜、漏掉昂貴**,邊界寬鬆處理):
  - term 首尾皆為英數字元 → `\b<escaped term>\b` 大小寫不敏感 regex。
    `Bae` 不誤中 `Baek`;`Hyunwoo's`、`Hyein-ah` 等變格因界符為非字元仍命中。
  - 其他(CJK 等)→ 大小寫不敏感 substring。
  - term 一律 regex-escape(`J Hotel`、含 `.` 的詞條不會構成非法 regex)。
- 空 glossary 或零命中回空陣列。

## 2. pipeline 接線(`electron/main/utils/pipeline.ts`)

- `analysisData` 維持全量(合併詞彙表 + 對齊後摘要)——進度事件、modal 顯示、
  series glossary 讀寫、`.analysis.json` 快取全部不動;只有送給翻譯請求的
  context 變瘦。
- 移除一次性組 `combinedAdditional` 的做法(`baseAdditional = params.additional || ""`
  取代其「使用者自訂指示」部分),改為 pipeline 內 helper:

```ts
const contextFor = (texts: string[]) =>
  analysisData
    ? `${baseAdditional ? baseAdditional + "\n\n" : ""}${formatAnalysisContext({
        plotSummary: analysisData.plotSummary, // 摘要全量
        glossary: filterGlossaryForText(analysisData.glossary, texts),
      })}`
    : baseAdditional;
```

- chunkProcessor:`additional: contextFor(windowText)`(windowText = 核心 ±5 句)。
- 單行 fallback 與失敗行重試:`additional: contextFor([該行原文])`。
- 零詞條命中時 `formatAnalysisContext` 既有行為省略整個 Glossary 區段
  (含權威性指示),只送摘要——已有測試鎖住。

## 3. 邊界與風險

- **跨 chunk 一致性不受影響**:詞條只對「原文出現該 term」的句子有約束力;
  全域一致性的錨是全量摘要(譯名已對齊)+ 詞彙表 LOCKED 機制。
- **效益估算**:每 chunk 通常命中 0-6 條(原本 50 條全帶),詞彙表 token
  省約 85-90%,訊號更集中。
- **不動的東西**:分析、調和、series glossary、GlossaryEditor、快取格式。

## 4. 測試

**單元測試**(`tests/unit/analysis.test.ts`):

- 基本命中/未命中、大小寫不敏感
- word-boundary:`Bae` 不誤中 `Baek`;`Hyunwoo's` / `Hyein-ah` 變格命中
- CJK term substring 命中
- 多句 window 合併匹配;空 glossary 回空
- regex 特殊字元 term 不拋例外

**pipeline 特徵測試**(`tests/unit/pipeline.characterization.test.ts` 擴充):
mock `translateSubtitleChunk`,兩個 chunk 含不同名字 → 各自收到的
`additional` 只含自己命中的詞條、摘要皆在。

**實測成功標準**:重翻 E01——譯名正確率不退步(慧仁 0、Hyunwoo 誤加姓 0/31);
log 的 `inputTokens` 明顯下降。

## 已知限制

- term 未出現於原文但譯者仍需要的情境不存在(詞彙表以原文 term 為鍵)。
- 變格超出界符規則(如黏著詞尾直接相連 `Hyeinah`)會漏配——罕見,
  且該句沒有詞條時仍有摘要提供一致性。
