import fs from "node:fs";
import crypto from "node:crypto";
import type { AnalysisResult, GlossaryEntry } from "./translate";
import { analyzeSubtitlesForContext, synthesizePlotSummaries } from "./translate";

function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

const ANALYSIS_SECTIONS = 3;

function mergeGlossaries(
  glossaries: Array<GlossaryEntry[]>
): GlossaryEntry[] {
  const seen = new Set<string>();
  const merged: GlossaryEntry[] = [];
  for (const glossary of glossaries) {
    for (const entry of glossary) {
      const key = entry.term.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(entry);
      }
    }
  }
  return merged;
}

function formatAnalysisContext(analysis: AnalysisResult): string {
  const glossaryLines = analysis.glossary
    .map((g) => `- ${g.term}: ${g.translation}`)
    .join("\n");
  // 詞彙表必須是強制對照：劇情摘要是敘事文字，模型容易跟著它走（例如把
  // 只有名字的稱呼統一成全名），所以明確聲明衝突時以詞彙表為準。
  const glossarySection = glossaryLines
    ? `\n## Glossary\nThese translations are authoritative — if the Plot Summary renders a name differently, follow the glossary.\nWhen the source text uses only a given name (no family name), do not add the family name.\n${glossaryLines}`
    : "";
  return `[Context]\n## Plot Summary\n${analysis.plotSummary}${glossarySection}`;
}

// 每個 chunk 只送出現在該段文字中的詞條：誤含便宜、漏掉昂貴，匹配從寬——
// 首尾皆英數的 term 用 \b 邊界避免子字串誤中（Bae 不中 Baek，變格如
// Hyunwoo's 因界符為非字元仍命中），其他（CJK 等）用 substring。
// 連字號拼法變體（Hye-in vs Hyein、Hyun-woo vs Hyunwoo）：主匹配失敗時
// 兩邊都去掉連字號再比一次。
function filterGlossaryForText(
  glossary: GlossaryEntry[],
  texts: string[]
): GlossaryEntry[] {
  const haystack = texts.join("\n").toLowerCase();
  if (!haystack.trim() || glossary.length === 0) return [];
  const haystackNoHyphen = haystack.replace(/-/g, "");
  const boundMatch = (term: string, hay: string) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`).test(hay);
  };
  return glossary.filter((g) => {
    const term = g.term.trim().toLowerCase();
    if (!term) return false;
    if (/^[a-z0-9]/.test(term) && /[a-z0-9]$/.test(term)) {
      return (
        boundMatch(term, haystack) ||
        boundMatch(term.replace(/-/g, ""), haystackNoHyphen)
      );
    }
    return haystack.includes(term);
  });
}

// 分析快取的劇情摘要內嵌了當時的譯名；使用者事後在詞彙表改了譯名時，
// 摘要裡的舊譯名會與詞彙表互相矛盾、污染翻譯輸出。這裡在組合 [Context]
// 前做確定性替換（不回寫快取檔）。長字串優先避免部分重疊；單字譯名跳過
// 以免誤傷無關文字。
function alignPlotSummaryWithGlossary(
  plotSummary: string,
  cachedGlossary: GlossaryEntry[],
  finalGlossary: GlossaryEntry[]
): string {
  const finalByTerm = new Map(
    finalGlossary.map((g) => [g.term.toLowerCase(), g.translation])
  );
  const renames = cachedGlossary
    .map((g) => ({
      from: g.translation,
      to: finalByTerm.get(g.term.toLowerCase()),
    }))
    .filter(
      (r): r is { from: string; to: string } =>
        typeof r.to === "string" && r.to !== r.from && r.from.length >= 2
    )
    .sort((a, b) => b.from.length - a.from.length);
  let result = plotSummary;
  for (const { from, to } of renames) {
    result = result.replaceAll(from, to);
  }
  return result;
}

function analysisCachePath(filePath: string): string {
  return filePath.replace(/\.[^/.]+$/, "") + ".analysis.json";
}

// 模型回應格式錯誤時把原始回應附加到 <檔名>.analysis-failures.log，
// 失敗樣本才能留下來當回歸測試 fixture（console 跑完就沒了）
function appendAnalysisFailureLog(cacheFile: string, label: string, err: unknown): void {
  const raw = (err as any)?.text;
  const logFile = cacheFile.replace(/\.analysis\.json$/, "") + ".analysis-failures.log";
  const entry = [
    `=== ${new Date().toISOString()} ${label}`,
    `error: ${(err as any)?.message ?? String(err)}`,
    typeof raw === "string" ? `response:\n${raw}` : "response: (none)",
    "",
  ].join("\n");
  try {
    fs.appendFileSync(logFile, entry + "\n", "utf8");
  } catch {}
}

function readAnalysisCache(
  cacheFile: string,
  contentHash: string
): AnalysisResult | null {
  if (!fs.existsSync(cacheFile)) return null;
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    if (
      cached.contentHash === contentHash &&
      cached.analysis &&
      typeof cached.analysis === "object"
    ) {
      if (Array.isArray(cached.analysis.glossary)) {
        cached.analysis.glossary = cached.analysis.glossary.map((g: any) => ({
          ...g,
          category: g.category ?? "term",
        }));
      }
      return cached.analysis as AnalysisResult;
    }
  } catch {}
  return null;
}

async function getOrCreateAnalysis(opts: {
  texts: string[];
  cacheFile: string;
  contentHash: string;
  forceReanalyze: boolean;
  params: { apiKeys: string[]; apiHost: string; model: string; lang: string; disableThinking?: boolean; disableAuxThinking?: boolean };
  existingGlossary?: GlossaryEntry[];
  // 有段落失敗時回報（含全部失敗）；讀快取時不呼叫
  onSectionFailures?: (failed: number, total: number) => void;
}): Promise<AnalysisResult | null> {
  const { texts, cacheFile, contentHash, forceReanalyze, params, existingGlossary, onSectionFailures } = opts;

  if (!forceReanalyze) {
    const cached = readAnalysisCache(cacheFile, contentHash);
    if (cached) return cached;
  }

  const sectionSize = Math.ceil(texts.length / ANALYSIS_SECTIONS);
  const sections = Array.from({ length: ANALYSIS_SECTIONS }, (_, i) =>
    texts.slice(i * sectionSize, (i + 1) * sectionSize)
  ).filter((s) => s.length > 0);

  const sectionResults = await Promise.all(
    sections.map((section, i) =>
      analyzeSubtitlesForContext(section, {
        apiKeys: params.apiKeys,
        apiHost: params.apiHost,
        model: params.model,
        lang: params.lang,
        temperature: 0.3,
        // 只注入本段字幕實際出現的詞條：整份劇集詞彙表加上 "MUST reuse" 會讓模型把
        // 本段沒出場的角色寫進摘要（E02 童年篇被寫成 E01 的成年人名，2026-10-01 實驗）
        existingGlossary: existingGlossary && filterGlossaryForText(existingGlossary, section),
        disableThinking: params.disableThinking,
      }).catch((err) => {
        console.warn(`Analysis section ${i + 1}/${sections.length} failed:`, err);
        appendAnalysisFailureLog(cacheFile, `analysis section ${i + 1}/${sections.length}`, err);
        return null;
      })
    )
  );
  const validResults = sectionResults.filter((r): r is AnalysisResult => r !== null);
  if (validResults.length < sections.length) {
    onSectionFailures?.(sections.length - validResults.length, sections.length);
  }
  if (validResults.length === 0) return null;

  const mergedGlossary = mergeGlossaries(validResults.map((r) => r.glossary));
  const summaries = validResults.map((r) => r.plotSummary);

  let plotSummary: string;
  if (summaries.length === 1) {
    plotSummary = summaries[0];
  } else {
    try {
      plotSummary = await synthesizePlotSummaries(summaries, {
        apiKeys: params.apiKeys,
        apiHost: params.apiHost,
        model: params.model,
        lang: params.lang,
        temperature: 0.3,
        disableThinking: params.disableAuxThinking,
      });
    } catch {
      plotSummary = summaries.map((s, i) => `[Act ${i + 1}]\n${s}`).join("\n\n");
    }
  }

  const analysis: AnalysisResult = { plotSummary, glossary: mergedGlossary };
  try {
    fs.writeFileSync(cacheFile, JSON.stringify({ contentHash, analysis }), "utf8");
  } catch {}
  return analysis;
}

export {
  hashContent,
  mergeGlossaries,
  formatAnalysisContext,
  filterGlossaryForText,
  alignPlotSummaryWithGlossary,
  analysisCachePath,
  appendAnalysisFailureLog,
  readAnalysisCache,
  getOrCreateAnalysis,
};
