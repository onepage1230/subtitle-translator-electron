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
  const glossarySection = glossaryLines ? `\n## Glossary\n${glossaryLines}` : "";
  return `[Context]\n## Plot Summary\n${analysis.plotSummary}${glossarySection}`;
}

function analysisCachePath(filePath: string): string {
  return filePath.replace(/\.[^/.]+$/, "") + ".analysis.json";
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
  params: { apiKeys: string[]; apiHost: string; model: string; lang: string };
  existingGlossary?: GlossaryEntry[];
}): Promise<AnalysisResult | null> {
  const { texts, cacheFile, contentHash, forceReanalyze, params, existingGlossary } = opts;

  if (!forceReanalyze) {
    const cached = readAnalysisCache(cacheFile, contentHash);
    if (cached) return cached;
  }

  const sectionSize = Math.ceil(texts.length / ANALYSIS_SECTIONS);
  const sections = Array.from({ length: ANALYSIS_SECTIONS }, (_, i) =>
    texts.slice(i * sectionSize, (i + 1) * sectionSize)
  ).filter((s) => s.length > 0);

  const sectionResults = await Promise.all(
    sections.map((section) =>
      analyzeSubtitlesForContext(section, {
        apiKeys: params.apiKeys,
        apiHost: params.apiHost,
        model: params.model,
        lang: params.lang,
        temperature: 0.3,
        existingGlossary,
      }).catch(() => null)
    )
  );
  const validResults = sectionResults.filter((r): r is AnalysisResult => r !== null);
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
  analysisCachePath,
  readAnalysisCache,
  getOrCreateAnalysis,
};
