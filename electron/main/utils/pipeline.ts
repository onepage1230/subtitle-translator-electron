import fs from "node:fs";
import path from "node:path";
import pool from "tiny-async-pool";
import { makeKey } from "../../shared/subtitleKey";
import type { AnalysisResult } from "./translate";
import { translateSubtitleChunk, translateSubtitleSingle, reconcileGlossary } from "./translate";
import { splitIntoChunk, parseSubtitle, saveTranslated, normalizeCues } from "./subtitle";
import { hashContent, analysisCachePath, appendAnalysisFailureLog, getOrCreateAnalysis, formatAnalysisContext, alignPlotSummaryWithGlossary, filterGlossaryForText } from "./analysis";
import { planReconciliation } from "./nameMatch";
import { detectCodeIssues, isTraditionalChineseTarget, isChineseTarget, checkWithJev, chooseWithJev, needsJevChoice, pickRetranslation } from "./quality";
import {
  loadSeriesGlossary,
  mergeIntoSeriesGlossary,
  saveSeriesGlossary,
  enforceReconciliation,
} from "./seriesGlossary";

function isLocalModel(apiHost: string): boolean {
  return /localhost|127\.0\.0\.1|0\.0\.0\.0|::1/.test(apiHost);
}

async function retryTranslate(fn, params, maxRetries = 5, delay = 1000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn(params);
    } catch (error) {
      if (attempt === maxRetries) {
        throw error;
      }
      // 判斷是否可重試（涵蓋 schema 不符、未產生物件 等訊息）
      const errObj: any = error || {};
      const msgParts = [
        errObj.message,
        typeof errObj.toString === "function" ? errObj.toString() : "",
        errObj.cause?.message,
      ].filter(Boolean);
      const errorMessage = msgParts.join(" | ");
      const status = errObj.status || errObj.response?.status;
      const name = errObj.name || errObj.cause?.name;
      const msgLower = (errorMessage || "").toLowerCase();

      const isRetryable =
        msgLower.includes("network") ||
        msgLower.includes("timeout") ||
        msgLower.includes("rate limit") ||
        msgLower.includes("no object generated") ||
        msgLower.includes("did not match schema") ||
        msgLower.includes("match schema") ||
        msgLower.includes("validation") ||
        name === "NoObjectGeneratedError" ||
        name === "TypeValidationError" ||
        (typeof status === "number" && (status >= 429 || status >= 500));

      if (isRetryable) {
        // 指數退避 + 輕微抖動
        const backoff =
          Math.max(0, delay) * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 250);
        console.warn(
          `Translation attempt ${attempt} failed: ${errorMessage || name || "unknown error"}. Retrying in ${backoff}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, backoff));
      } else {
        throw error; // 不可重試錯誤，直接拋出
      }
    }
  }
}

export type AnalysisThinkingMode = "keep" | "light" | "off";

export interface TranslateParams {
  apiKeys: string[];
  apiHost?: string;
  model?: string;
  prompt?: string;
  lang?: string;
  additional?: string;
  temperature?: number;
  multiLangSave?: string;
  delay?: number;
  contextSize?: number;
  concurrentRequests?: number;
  forceReanalyze?: boolean;
  typesafeApiKey?: string;
  // 分析步驟的推理模型 thinking：keep 全保留；light 只在摘要合成與詞彙表調和關閉
  // （段落分析需要推理人物關係，關閉時 E02 摘要錯置人物，2026-10-01 實驗）；off 全關
  analysisThinkingMode?: AnalysisThinkingMode;
}

export interface ProgressEvent {
  filePath: string;
  progress: number;
  status: "translating" | "analyzing" | "done" | "error";
  totalCues?: number;
  currentCue?: number;
  analysis?: AnalysisResult | null;
  error?: string;
  failedCues?: number;
  failedKeys?: string[];
  qualityFlagged?: number;
  analysisFailed?: boolean;
  // 部分段落分析失敗（仍有結果）；全部失敗時只設 analysisFailed
  analysisPartial?: { failed: number; total: number };
}

export async function translateFile(
  file: { path: string; name: string },
  params: TranslateParams,
  onProgress: (data: ProgressEvent) => void
): Promise<void> {
  try {
    onProgress({
      filePath: file.path,
      progress: 0,
      status: "translating",
      totalCues: 0,
    });
    const ext = path.extname(file.path).slice(1).toLowerCase();
    const content = fs.readFileSync(file.path, "utf8");
    const fileHash = hashContent(content);
    const cacheFile = analysisCachePath(file.path);
    let parsed = parseSubtitle(content, ext);
    const subtitle = normalizeCues(parsed);
    const totalCues = subtitle.length;

    // 建立原始索引對照，供後續「上下文視窗」策略使用
    const indexMap = new Map<any, number>();
    subtitle.forEach((cue: any, idx: number) => indexMap.set(cue, idx));

    onProgress({
      filePath: file.path,
      progress: 1,
      status: "analyzing",
      totalCues,
      currentCue: 0,
    });

    // Prepare output path early so we can write partial updates during translation
    const outputPath = path.join(
      path.dirname(file.path),
      file.name.replace(/\.[^/.]+$/, "") + ".translated." + ext
    );

    // Resume: pre-populate translatedText from existing translated file
    // Skip when multiLangSave is active — saved text is a combined string, not pure translation
    const canResume = !params.multiLangSave || params.multiLangSave === "none";
    if (canResume && fs.existsSync(outputPath)) {
      try {
        const existingContent = fs.readFileSync(outputPath, "utf8");
        let existingParsed = parseSubtitle(existingContent, ext);
        const existingCues: any[] = normalizeCues(existingParsed);
        const resumeMap = new Map<string, string>();
        existingCues.forEach((cue: any) => {
          if (cue.data) {
            resumeMap.set(makeKey(cue.data.start, cue.data.end), cue.data.text || "");
          }
        });
        subtitle.forEach((cue: any) => {
          const key = makeKey(cue.data.start, cue.data.end);
          const existingText = resumeMap.get(key);
          // Only pre-populate if translated text differs from original (avoids treating __FAILED__ lines as done)
          if (existingText !== undefined && existingText !== cue.data.text) {
            cue.data.translatedText = existingText;
          }
        });
        // 完成檔重翻 = 全新重翻：resume 只服務「中斷續翻」。若預填後已無待翻句，
        // 代表使用者對已完成的檔案再次按下翻譯，意圖是重做（例如套用編輯後的
        // 詞彙表），清掉預填讓整份重翻；否則會因 splitIntoChunk 跳過已翻句而
        // 變成 no-op。（邊界：譯文恰好等於原文的句子不算已翻，含此類句子的
        // 完成檔仍走 resume——罕見，遇到可刪 .translated 檔強制重翻。）
        const remaining = subtitle.filter(
          (cue: any) =>
            cue?.data &&
            String(cue.data.text ?? "").trim() &&
            !cue.data.translatedText
        ).length;
        if (remaining === 0) {
          subtitle.forEach((cue: any) => {
            if (cue?.data) delete cue.data.translatedText;
          });
        }
      } catch (resumeErr) {
        console.warn("Resume pre-population failed, starting fresh:", resumeErr);
      }
    }

    // Build analysis context (plot summary + glossary) and attach to all requests
    const allTexts = subtitle
      .map((cue: any) => (cue && cue.data ? cue.data.text : ""))
      .filter((t: string) => t && t.length > 0);

    const baseAdditional = params.additional || "";
    let analysisData: AnalysisResult | null = null;
    let analysisFailed = false;
    let analysisPartial: { failed: number; total: number } | undefined;

    const folder = path.dirname(file.path);
    const { terms: seriesTerms, excluded: seriesExcluded } = loadSeriesGlossary(folder);

    try {
      analysisData = await getOrCreateAnalysis({
        texts: allTexts,
        cacheFile,
        contentHash: fileHash,
        forceReanalyze: !!params.forceReanalyze,
        params: {
          apiKeys: params.apiKeys || [],
          apiHost: params.apiHost || "https://api.openai.com/v1",
          model: params.model || "",
          lang: params.lang || "",
          disableThinking: params.analysisThinkingMode === "off",
          disableAuxThinking: (params.analysisThinkingMode ?? "light") !== "keep",
          userNotes: params.additional || "",
        },
        existingGlossary: seriesTerms,
        onSectionFailures: (failed, total) => {
          if (failed < total) analysisPartial = { failed, total };
        },
      });
      if (analysisData) {
        // 詞彙表調和：讓模型認出同一人物的變體（羅馬拼音差異、全名/簡稱），
        // enforceReconciliation 確保 LOCKED 譯名不被改、漏項補回、發明項丟棄。
        // 調和失敗不阻斷翻譯，退回原始詞彙表。
        let episodeGlossary = analysisData.glossary;
        const newPersons = episodeGlossary.filter((g) => g.category === "person");
        let shouldReconcile =
          newPersons.length > 0 &&
          (newPersons.length >= 2 ||
            seriesTerms.some((g) => g.category === "person"));
        // 有 Jev key 時改由人名配對篩選決定：只有「同一人且譯名不一致」或證據不足
        // 才呼叫 LLM 調和；Jev 失敗則沿用上面的啟發式規則
        let hints: [string, string][] = [];
        if (shouldReconcile && params.typesafeApiKey) {
          try {
            const plan = await planReconciliation(episodeGlossary, seriesTerms, allTexts, params.typesafeApiKey);
            shouldReconcile = plan.reconcile;
            hints = plan.hints;
            console.log(
              `Name matching: ${plan.reconcile ? "reconcile" : "skip reconciliation"} (Jev same-person pairs: ${plan.hints.map((h) => h.join(" = ")).join(", ") || "none"})`
            );
          } catch (planErr) {
            console.warn("Jev name matching failed, falling back to heuristic:", planErr);
          }
        }
        if (shouldReconcile) {
          try {
            const reconciled = await reconcileGlossary(episodeGlossary, seriesTerms, {
              apiKeys: params.apiKeys || [],
              apiHost: params.apiHost || "https://api.openai.com/v1",
              model: params.model || "",
              lang: params.lang || "",
              temperature: 0.3,
              disableThinking: (params.analysisThinkingMode ?? "light") !== "keep",
              hints,
            });
            episodeGlossary = enforceReconciliation(
              reconciled,
              analysisData.glossary,
              seriesTerms
            );
          } catch (reconcileErr) {
            console.warn("Glossary reconciliation failed, using raw glossary:", reconcileErr);
            appendAnalysisFailureLog(cacheFile, "glossary reconciliation", reconcileErr);
          }
        }
        const combinedGlossary = mergeIntoSeriesGlossary(seriesTerms, episodeGlossary, seriesExcluded);
        saveSeriesGlossary(folder, combinedGlossary, seriesExcluded);
        // [Context] 與進度事件都使用合併後的完整詞彙表；
        // 快取摘要可能內嵌舊譯名（使用者事後編輯過詞彙表），先依最終詞彙表做確定性替換
        const alignedSummary = alignPlotSummaryWithGlossary(
          analysisData.plotSummary,
          analysisData.glossary,
          combinedGlossary
        );
        analysisData = { plotSummary: alignedSummary, glossary: combinedGlossary };
        onProgress({ filePath: file.path, progress: 4, status: "analyzing", totalCues, currentCue: 0, analysis: analysisData });
      } else {
        analysisFailed = true;
        console.warn("Context analysis returned no result, continue without it");
      }
    } catch (analysisErr) {
      analysisFailed = true;
      console.warn("Context analysis failed, continue without it:", analysisErr);
    }

    // 每個請求只送命中的詞條：摘要全量，詞彙表按該段文字過濾（spec:
    // docs/superpowers/specs/2026-07-03-per-chunk-glossary-filtering-design.md）
    const contextFor = (texts: string[]) =>
      analysisData
        ? `${baseAdditional ? baseAdditional + "\n\n" : ""}${formatAnalysisContext({
            plotSummary: analysisData.plotSummary,
            glossary: filterGlossaryForText(analysisData.glossary, texts),
          })}`
        : baseAdditional;

    onProgress({
      filePath: file.path,
      progress: 5,
      status: "translating",
      totalCues,
      currentCue: 0,
      analysis: analysisData,
      analysisFailed,
      analysisPartial,
    });

    // Translate
    const failedKeys = new Set<string>();
    let chunks = splitIntoChunk(subtitle, 20);

    let completedCues = 0;

    const chunkProcessor = async (block) => {
      try {
        // 以原始索引建立「核心段」和「上下文視窗」
        const contextSize =
          typeof params.contextSize === "number" ? params.contextSize : 5;

        const coreIndices = block
          .map((cue: any) => indexMap.get(cue) as number)
          .filter((n: number) => typeof n === "number")
          .sort((a: number, b: number) => a - b);

        if (coreIndices.length === 0) return;

        const coreStart = coreIndices[0];
        const coreEnd = coreIndices[coreIndices.length - 1];

        const contextStart = Math.max(0, coreStart - contextSize);
        const contextEnd = Math.min(subtitle.length - 1, coreEnd + contextSize);

        const windowCues = subtitle.slice(contextStart, contextEnd + 1);
        const windowText = windowCues.map((c: any) =>
          c && c.data ? String(c.data.text).replaceAll(/\n/g, " ").trim() : ""
        );

        let translatedWindow: string[] | null = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          const baseTemp =
            typeof params.temperature === "number" ? params.temperature : 1;
          const attemptTemp = Math.max(
            0.1,
            Math.min(2, baseTemp + (Math.random() - 0.5) * 0.4)
          );
          try {
            const attemptResult = await retryTranslate(
              async (chunkText) =>
                translateSubtitleChunk(chunkText, {
                  ...params,
                  apiKeys: params.apiKeys || [],
                  apiHost: params.apiHost || "https://api.openai.com/v1",
                  model: params.model || "",
                  prompt: params.prompt || "",
                  lang: params.lang || "",
                  additional: contextFor(windowText),
                  temperature: attemptTemp,
                }),
              windowText
            );
            if (attempt > 1) {
              console.log(
                `Chunk attempt ${attempt} (context window) done, temp=${attemptTemp}`
              );
            }
            if (
              Array.isArray(attemptResult) &&
              attemptResult.length === windowText.length
            ) {
              translatedWindow = attemptResult;
              break;
            }
          } catch {
            // attempt failed, try next or fall through to line-by-line
          }
        }

        // 逐句 fallback：僅翻譯核心行，並填回對應視窗位置
        if (!translatedWindow) {
          translatedWindow = new Array(windowText.length).fill(null);
          for (let i = 0; i < coreIndices.length; i++) {
            const idx = coreIndices[i];
            const lineText =
              subtitle[idx] && subtitle[idx].data ? subtitle[idx].data.text : "";
            try {
              const single = await retryTranslate(
                async (singleText) =>
                  translateSubtitleSingle(singleText, {
                    ...params,
                    apiKeys: params.apiKeys || [],
                    apiHost: params.apiHost || "https://api.openai.com/v1",
                    model: params.model || "",
                    prompt: params.prompt || "",
                    lang: params.lang || "",
                    additional: contextFor([lineText]),
                    temperature:
                      typeof params.temperature === "number"
                        ? params.temperature
                        : 1,
                  }),
                lineText
              );
              translatedWindow[idx - contextStart] = single;
            } catch {
              translatedWindow[idx - contextStart] = null;
            }
          }
        }

        // 只回寫核心段的翻譯（丟棄上下文前後行）
        let chunkCompleted = 0;
        for (const cue of block) {
          const idx = indexMap.get(cue) as number;
          if (typeof idx !== "number") continue;
          const offset = idx - contextStart;
          const t =
            translatedWindow &&
            translatedWindow[offset] != null &&
            typeof translatedWindow[offset] === "string"
              ? translatedWindow[offset]
              : "";
          if (cue && cue.data) {
            cue.data.translatedText = t;
            chunkCompleted++;
          }
        }

        completedCues += chunkCompleted;
        const progress = 10 + (completedCues / totalCues) * 90;
        const currentCue = Math.min(completedCues, totalCues);
        onProgress({
          filePath: file.path,
          progress: Math.min(progress, 90),
          status: "translating",
          totalCues,
          currentCue,
          analysis: analysisData,
        });

        // 寫入部分成果供即時預覽
        try {
          saveTranslated(
            outputPath,
            parsed,
            ext,
            params.multiLangSave || "none"
          );
        } catch (e) {
          console.warn("Failed to write partial translated file:", e);
        }

        // Delay between chunks
        if (params.delay && params.delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, params.delay));
        }
      } catch (chunkErr) {
        // Chunk-level isolation: mark all lines in this block as failed
        console.warn("Chunk failed, marking lines as __FAILED__:", chunkErr);
        for (const cue of block) {
          if (cue && cue.data) {
            cue.data.translatedText = "__FAILED__";
            failedKeys.add(makeKey(cue.data.start, cue.data.end));
          }
        }
        try {
          saveTranslated(outputPath, parsed, ext, params.multiLangSave || "none");
        } catch {}
      }
    };

    const defaultConcurrency = isLocalModel(params.apiHost || "") ? 3 : 10;
    const concurrency =
      typeof params.concurrentRequests === "number"
        ? Math.max(1, Math.min(20, params.concurrentRequests))
        : defaultConcurrency;

    // 記下 resume 預填（已有譯文）的句子：品質檢查只針對本次新翻的句子
    const prefilled = new Set<any>(
      subtitle.filter((c: any) => c?.data?.translatedText)
    );

    for await (const _ of pool(concurrency, chunks, chunkProcessor)) {
      // Process chunks in parallel
    }

    // 翻譯後品質檢查：把硬傷句清空，交給下方逐句 fallback 重翻（僅一次）
    const originalTranslations = new Map<any, string>();
    const reasons = new Map<any, string[]>();
    const traditional = isTraditionalChineseTarget(params.lang || "");
    const chinese = traditional || isChineseTarget(params.lang || "");
    const glossary = analysisData?.glossary ?? [];
    const jevEnabled = !!params.typesafeApiKey;
    let codeFlagged = 0;
    let jevFlagged = 0;
    try {
      const candidates = subtitle.filter((c: any) => {
        const tt = c?.data?.translatedText;
        return (
          !prefilled.has(c) &&
          String(c?.data?.text ?? "").trim() &&
          typeof tt === "string" &&
          tt.trim() &&
          tt !== "__FAILED__"
        );
      });
      const flagged = new Set<any>();
      for (const c of candidates) {
        const issues = detectCodeIssues(c.data.text, c.data.translatedText, { traditional, chinese, glossary });
        if (issues.length > 0) {
          flagged.add(c);
          reasons.set(c, issues);
          codeFlagged++;
        }
      }
      if (jevEnabled && candidates.length > 0) {
        const verdicts = await checkWithJev(
          candidates.map((c: any) => ({ source: c.data.text, translation: c.data.translatedText })),
          params.typesafeApiKey
        );
        candidates.forEach((c: any, i: number) => {
          if (verdicts[i]) {
            jevFlagged++;
            flagged.add(c);
            reasons.set(c, [...(reasons.get(c) ?? []), "jev"]);
          }
        });
      }
      for (const c of flagged) {
        originalTranslations.set(c, c.data.translatedText);
        c.data.translatedText = "";
      }
      // Jev 未設定時明示 skipped，避免與「有檢查但 0 句」混淆
      console.log(
        `Quality check: ${flagged.size} flagged for retranslation (code issues: ${codeFlagged}, Jev: ${jevEnabled ? jevFlagged : "skipped (no TypeSafe API key)"})`
      );
      for (const c of flagged) {
        console.log(
          `  [${(reasons.get(c) ?? []).join(", ")}] ${JSON.stringify(c.data.text)} → ${JSON.stringify(originalTranslations.get(c))}`
        );
      }
    } catch (qualityErr) {
      console.warn("Quality check failed, skipping:", qualityErr);
    }

    // Fallback for untranslated
    const untranslated = subtitle.filter(
      (line: any) => !line.data.translatedText
    );
    for (let k = 0; k < untranslated.length; k++) {
      const cue = untranslated[k];
      if (cue && cue.data) {
        try {
          cue.data.translatedText = await retryTranslate(
            async (singleText) =>
              translateSubtitleSingle(singleText, {
                ...params,
                apiKeys: params.apiKeys || [],
                apiHost: params.apiHost || "https://api.openai.com/v1",
                model: params.model || "",
                prompt: params.prompt || "",
                lang: params.lang || "",
                additional: contextFor([cue.data.text]),
                temperature: params.temperature || 1,
              }),
            cue.data.text
          );
        } catch (lineErr) {
          const original = originalTranslations.get(cue);
          if (original !== undefined) {
            console.warn("Quality retranslation failed, keeping original translation:", lineErr);
            cue.data.translatedText = original;
          } else {
            console.warn("Line-level fallback failed, marking as __FAILED__:", lineErr);
            cue.data.translatedText = "__FAILED__";
            failedKeys.add(makeKey(cue.data.start, cue.data.end));
          }
        }
        const currentCueIndex = subtitle.findIndex((c: any) => c === cue);
        if (currentCueIndex !== -1) {
          completedCues++;
          const progress =
            90 +
            ((completedCues - subtitle.length + untranslated.length) /
              untranslated.length) *
              10;
          const currentCue = completedCues;
          onProgress({
            filePath: file.path,
            progress: Math.min(100, progress),
            status: "translating",
            totalCues,
            currentCue,
            analysis: analysisData,
          });

          // Write partial translated file after single-line fallback updates
          try {
            saveTranslated(
              outputPath,
              parsed,
              ext,
              params.multiLangSave || "none"
            );
          } catch (e) {
            console.warn(
              "Failed to write partial translated file (fallback):",
              e
            );
          }
        }
      }
    }

    // 重翻句選版本：重翻成功（譯文已變）的句子，比較原譯與新譯決定採用哪個
    try {
      const retranslated = Array.from(originalTranslations.keys()).filter(
        (c: any) =>
          c.data.translatedText !== originalTranslations.get(c) &&
          c.data.translatedText !== "__FAILED__"
      );
      const issuesOf = (c: any, text: string) =>
        detectCodeIssues(c.data.text, text, { traditional, chinese, glossary });
      const decisions = retranslated.map((c: any) => ({
        cue: c,
        origIssues: (reasons.get(c) ?? []).filter((r) => r !== "jev"),
        newIssues: issuesOf(c, c.data.translatedText),
      }));
      const ask = jevEnabled
        ? decisions.filter((d) => needsJevChoice(d.origIssues, d.newIssues))
        : [];
      const choices = ask.length
        ? await chooseWithJev(
            ask.map((d) => ({
              source: d.cue.data.text,
              original: originalTranslations.get(d.cue)!,
              retranslation: d.cue.data.translatedText,
            })),
            params.typesafeApiKey!
          )
        : [];
      const choiceOf = new Map(ask.map((d, i) => [d.cue, choices[i]]));
      let keptOriginal = 0;
      for (const d of decisions) {
        if (pickRetranslation(d.origIssues, d.newIssues, choiceOf.get(d.cue) ?? null) === "original") {
          d.cue.data.translatedText = originalTranslations.get(d.cue);
          keptOriginal++;
        }
      }
      if (decisions.length) {
        console.log(
          `Retranslation choice: ${decisions.length - keptOriginal} retranslated kept, ${keptOriginal} reverted to original (Jev asked: ${ask.length})`
        );
      }
    } catch (choiceErr) {
      console.warn("Retranslation choice failed, keeping retranslations:", choiceErr);
    }

    // Final write
    saveTranslated(outputPath, parsed, ext, params.multiLangSave || "none");
    console.log(`Saved translated file to: ${outputPath}`);
    onProgress({
      filePath: file.path,
      progress: 100,
      status: "done",
      totalCues,
      currentCue: totalCues,
      analysis: analysisData,
      failedCues: failedKeys.size,
      failedKeys: Array.from(failedKeys),
      qualityFlagged: originalTranslations.size,
      analysisFailed,
      analysisPartial,
    });
  } catch (e) {
    console.error(`Batch translation error for ${file.path}:`, e);
    onProgress({
      filePath: file.path,
      progress: 0,
      status: "error",
      error: e.message,
    });
  }
}

export function groupFilesByFolder(
  files: Array<{ path: string; name: string }>
): Array<Array<{ path: string; name: string }>> {
  const groups = new Map<string, Array<{ path: string; name: string }>>();
  for (const f of files) {
    const dir = path.dirname(f.path);
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir)!.push(f);
  }
  for (const group of groups.values()) {
    group.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
    );
  }
  return [...groups.values()];
}

export { isLocalModel, retryTranslate };
