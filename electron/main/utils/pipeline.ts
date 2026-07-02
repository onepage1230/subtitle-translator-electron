import fs from "node:fs";
import path from "node:path";
import pool from "tiny-async-pool";
import { makeKey } from "../../shared/subtitleKey";
import type { AnalysisResult } from "./translate";
import { translateSubtitleChunk, translateSubtitleSingle } from "./translate";
import { splitIntoChunk, parseSubtitle, saveTranslated, normalizeCues } from "./subtitle";
import { hashContent, analysisCachePath, getOrCreateAnalysis, formatAnalysisContext } from "./analysis";

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
      } catch (resumeErr) {
        console.warn("Resume pre-population failed, starting fresh:", resumeErr);
      }
    }

    // Build analysis context (plot summary + glossary) and attach to all requests
    const allTexts = subtitle
      .map((cue: any) => (cue && cue.data ? cue.data.text : ""))
      .filter((t: string) => t && t.length > 0);

    let combinedAdditional = params.additional || "";
    let analysisData: AnalysisResult | null = null;

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
        },
      });
      if (analysisData) {
        combinedAdditional = `${combinedAdditional ? combinedAdditional + "\n\n" : ""}${formatAnalysisContext(analysisData)}`;
        onProgress({ filePath: file.path, progress: 4, status: "analyzing", totalCues, currentCue: 0, analysis: analysisData });
      }
    } catch (analysisErr) {
      console.warn("Context analysis failed, continue without it:", analysisErr);
    }

    onProgress({
      filePath: file.path,
      progress: 5,
      status: "translating",
      totalCues,
      currentCue: 0,
      analysis: analysisData,
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
                  additional: combinedAdditional || "",
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
                    additional: combinedAdditional || "",
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

    for await (const _ of pool(concurrency, chunks, chunkProcessor)) {
      // Process chunks in parallel
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
                additional: combinedAdditional || "",
                temperature: params.temperature || 1,
              }),
            cue.data.text
          );
        } catch (lineErr) {
          console.warn("Line-level fallback failed, marking as __FAILED__:", lineErr);
          cue.data.translatedText = "__FAILED__";
          failedKeys.add(makeKey(cue.data.start, cue.data.end));
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

export { isLocalModel, retryTranslate };
