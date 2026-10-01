import { z } from "zod";
import { generateText, tool } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateJson } from "./jsonOutput";

const glossaryCategorySchema = z.enum(["person", "place", "organization", "term"]);

const glossaryEntrySchema = z.object({
  term: z.string(),
  translation: z.string(),
  category: glossaryCategorySchema,
});

const analysisSchema = z.object({
  plotSummary: z.string(),
  glossary: z.array(glossaryEntrySchema),
});

type AnalysisResult = z.infer<typeof analysisSchema>;
type GlossaryCategory = z.infer<typeof glossaryCategorySchema>;
type GlossaryEntry = z.infer<typeof glossaryEntrySchema>;

// Qwen3 等推理模型在 oMLX/vLLM 上可用 chat_template_kwargs 關閉 thinking。
// 實測分析一段：thinking 開 1003 秒（2 萬 token reasoning），關 17–30 秒，輸出品質相近。
// openai-compatible provider 會把 providerOptions.openai 的鍵原樣放進 request body；
// 非 Qwen 系伺服器可能忽略或拒絕此欄位，所以由設定開關控制。
function noThinkingOptions(disableThinking?: boolean) {
  return disableThinking
    ? { openai: { chat_template_kwargs: { enable_thinking: false } } }
    : undefined;
}

function getAi({ apiKey, apiHost }: { apiKey: string; apiHost: string }) {
  return createOpenAICompatible({
    name: "openai",
    apiKey: apiKey,
    baseURL: apiHost,
    headers: {
      // OpenRouter Headers
      "HTTP-Referer": "https://github.com/gnehs/subtitle-translator-electron",
      "X-Title": "Subtitle Translator",
    },
  });
}

function parseNumberedList(text: string, expectedCount: number): string[] | null {
  const lines: string[] = [];
  const regex = /^\d+\.\s*(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    lines.push(match[1].trim());
  }
  return lines.length === expectedCount ? lines : null;
}

async function translateSubtitleChunk(
  subtitles: string[],
  {
    apiKeys,
    apiHost,
    model,
    prompt,
    lang,
    additional,
    temperature,
  }: {
    apiKeys: string[];
    apiHost: string;
    model: string;
    prompt: string;
    lang: string;
    additional: string;
    temperature: number;
  }
) {
  if (apiKeys.length === 0) {
    throw new Error("No valid API keys provided");
  }

  const ai = getAi({ apiKey: apiKeys[0], apiHost });

  const systemPrompt = prompt
    .replaceAll("{{lang}}", lang)
    .replaceAll("{{additional}}", additional);

  // Layer 1: Tool calling
  // Note: catch {} swallows all errors including network/rate-limit.
  // retryTranslate handles those at the outer level via layer 3.
  // Acceptable tradeoff for local LLM use case (oMLX has no rate limits).
  let toolTranslated: string[] | null = null;
  try {
    const tools = {
      submit_translation: tool({
        description:
          "Provide the final translated subtitles. Keep order and length identical to input.",
        inputSchema: z
          .object({
            translated: z.array(
              z.string().describe("Translated subtitle at the same index")
            ),
          })
          .strict(),
        execute: async ({ translated }) => {
          toolTranslated = translated;
          return JSON.stringify(translated);
        },
      }),
    } as const;

    await generateText({
      model: ai(model),
      temperature,
      tools,
      toolChoice: "required",
      system:
        systemPrompt +
        "\nReturn ONLY using the tool, do not include any extra text.",
      prompt:
        "Translate the following subtitles. Return the result via the tool as an array of strings with the exact same length and order as input.\n\n" +
        JSON.stringify(subtitles),
      maxRetries: 2,
    });
  } catch {
    // Layer 1 failed silently, fall through to layer 2
  }

  if (
    toolTranslated &&
    Array.isArray(toolTranslated) &&
    toolTranslated.length === subtitles.length
  ) {
    return toolTranslated;
  }

  // Layer 2: JSON object generation
  try {
    const object = await generateJson({
      model: ai(model),
      temperature,
      schema: z.array(z.string()),
      prompt:
        systemPrompt +
        "\nOutput must be valid json. Reply ONLY with a JSON array of translated strings, same length and order as the input.\n\n" +
        JSON.stringify(subtitles),
      attempts: 1,
      label: "Chunk translation JSON",
    });
    if (Array.isArray(object) && object.length === subtitles.length) {
      return object;
    }
  } catch {
    // Layer 2 failed silently, fall through to layer 3
  }

  // Layer 3: Plain text numbered list
  const numberedResult = await generateText({
    model: ai(model),
    temperature,
    system:
      systemPrompt +
      "\nYou MUST reply ONLY with a numbered list. No explanations, no extra text.",
    prompt:
      "Translate each subtitle line. Reply ONLY in this exact format:\n1. [translation]\n2. [translation]\n...\n\nLines to translate:\n" +
      subtitles.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    maxRetries: 2,
  });

  const parsed = parseNumberedList(numberedResult.text, subtitles.length);
  if (parsed) return parsed;

  throw new Error(
    `Translation validation failed: all three layers produced wrong line count (expected ${subtitles.length})`
  );
}

async function translateSubtitleSingle(
  subtitle: string,
  {
    apiKeys,
    apiHost,
    model,
    prompt,
    lang,
    additional,
    temperature,
  }: {
    apiKeys: string[];
    apiHost: string;
    model: string;
    prompt: string;
    lang: string;
    additional: string;
    temperature: number;
  }
) {
  if (apiKeys.length === 0) {
    throw new Error("No valid API keys provided");
  }

  const ai = getAi({ apiKey: apiKeys[0], apiHost });

  const systemPrompt = prompt
    .replaceAll("{{lang}}", lang)
    .replaceAll("{{additional}}", additional);

  try {
    // tool calling
    let toolSingle: string | null = null;
    const tools = {
      submit_single_translation: tool({
        description: "Provide the final translated text only.",
        inputSchema: z.object({ result: z.string() }).strict(),
        execute: async ({ result }) => {
          toolSingle = result;
          return result;
        },
      }),
    } as const;

    await generateText({
      model: ai(model),
      temperature,
      tools,
      toolChoice: "required",
      system:
        systemPrompt +
        "\nReturn ONLY using the tool, do not include any extra text.",
      prompt:
        "Translate the following subtitle. Return the result via the tool as plain text only.\n\n" +
        JSON.stringify(subtitle),
      maxRetries: 2,
    });

    if (typeof toolSingle === "string") {
      return toolSingle;
    }

    // Fallback 2: JSON object generation
    const object = await generateJson({
      model: ai(model),
      temperature,
      schema: z.object({ result: z.string() }),
      prompt:
        systemPrompt +
        '\nOutput must be valid json. Reply ONLY with a JSON object of this shape: {"result": "<translation>"}\n\n' +
        JSON.stringify(subtitle),
      attempts: 1,
      label: "Single translation JSON",
    });
    return object.result;
  } catch (e: any) {
    throw e;
  }
}

function unwrapSingleElementArray(value: unknown): unknown {
  if (
    Array.isArray(value) &&
    value.length === 1 &&
    value[0] &&
    typeof value[0] === "object" &&
    !Array.isArray(value[0])
  ) {
    return value[0];
  }
  return value;
}

async function analyzeSubtitlesForContext(
  subtitles: string[],
  {
    apiKeys,
    apiHost,
    model,
    lang,
    temperature = 0.3,
    existingGlossary,
    disableThinking,
  }: {
    apiKeys: string[];
    apiHost: string;
    model: string;
    lang: string;
    temperature?: number;
    existingGlossary?: GlossaryEntry[];
    disableThinking?: boolean;
  }
): Promise<AnalysisResult> {
  if (apiKeys.length === 0) {
    throw new Error("No valid API keys provided");
  }
  const ai = getAi({ apiKey: apiKeys[0], apiHost });

  const existingSection =
    existingGlossary && existingGlossary.length > 0
      ? `\n\nAn established glossary already exists for this series. You MUST reuse these exact translations whenever these terms appear. Do NOT repeat them in your glossary output:\n${existingGlossary
          .map((g) => `- ${g.term}: ${g.translation}`)
          .join("\n")}\nIf a new term appears to be a shorter form, alias, or romanization variant of an established term (e.g. the given name of an established full name), derive its translation from the established translation instead of creating an unrelated one.`
      : "";

  // 本機模型（openai-compatible 未開 structuredOutputs）不會收到 JSON schema，
  // 只看得到 prompt；沒寫明格式時曾回傳 ["plotSummary","glossary"] 或把輸入
  // 字幕原樣當陣列回傳。所以在 system prompt 明寫輸出形狀，格式錯時再試一次。
  const system = `You are a subtitle content analyst for a translation system.
Analyze the provided subtitle sample and return:
1. plotSummary: A ${lang} narrative (5–10 sentences) describing what happens. Write naturally, not as a literal stitch of subtitles. Describe only characters who actually appear in this sample, and do not guess relationships the dialogue does not support.
2. glossary: Up to 15 entries of proper nouns ONLY — person names (category "person"), place names ("place"), organization or group names ("organization"), and titles, fictional terms or domain-specific jargon ("term"). Do NOT include common nouns, everyday vocabulary, or full sentences. For each entry provide the term as it appears, its preferred ${lang} translation or rendering (repeat the original term if no translation exists), and its category. If you recognize the work and an official or widely-used ${lang} translation of a name exists (e.g. from official subtitles or publications), prefer it over inventing a new rendering. When the same person appears under multiple forms (full name, given name only, nickname, romanization variants), create one entry per form and keep their translations mutually consistent: romanization variants of the same name must share the identical translation, and a shorter form's translation must be the corresponding part of the full name's translation — never render the same person's name two different ways.${existingSection}

Output format: reply with ONE JSON object and nothing else, exactly this shape:
{"plotSummary": "<${lang} summary>", "glossary": [{"term": "<as in subtitles>", "translation": "<${lang} rendering>", "category": "person" | "place" | "organization" | "term"}]}
Do NOT return a JSON array. Do NOT echo or translate the subtitle lines.`;

  return generateJson({
    model: ai(model),
    temperature,
    schema: analysisSchema,
    system,
    prompt: `Analyze this subtitle sample:\n\n` + subtitles.join("\n"),
    // 模型有時把物件包成單元素陣列 [{...}]，拆掉外層再驗證
    normalize: unwrapSingleElementArray,
    providerOptions: noThinkingOptions(disableThinking),
    label: "Analysis",
  });
}

async function synthesizePlotSummaries(
  summaries: string[],
  {
    apiKeys,
    apiHost,
    model,
    lang,
    temperature = 0.3,
    disableThinking,
  }: {
    apiKeys: string[];
    apiHost: string;
    model: string;
    lang: string;
    temperature?: number;
    disableThinking?: boolean;
  }
): Promise<string> {
  if (apiKeys.length === 0 || summaries.length === 0) {
    return summaries.join("\n\n");
  }
  const ai = getAi({ apiKey: apiKeys[0], apiHost });

  const numbered = summaries
    .map((s, i) => `[Part ${i + 1}]\n${s}`)
    .join("\n\n");

  const result = await generateText({
    model: ai(model),
    temperature,
    system: `You are a plot summarizer. Combine the provided partial summaries into one coherent ${lang} narrative. Preserve chronological order. Do not introduce information not present in the parts.`,
    prompt: `Synthesize these partial summaries into one coherent summary:\n\n${numbered}`,
    providerOptions: noThinkingOptions(disableThinking),
    maxRetries: 2,
  });

  return result.text;
}

// 本機模型看不到 schema，調和結果的形狀每次都可能不同。實測過的形狀：
// { glossary: [...] }（正確）、裸條目陣列、扁平 map {"term": "譯名 (category)"}、
// 字串陣列 ["term: 譯名 (category)"]、包在單元素陣列裡的扁平 map、
// 欄位名稱不同的條目 {"entry", "translation", "type"}。這裡全部轉成條目陣列；
// 結果仍會經過 enforceReconciliation 的防護（LOCKED 還原、發明條目丟棄），
// 所以寬鬆解析是安全的。無法辨識時回傳 null。
const CATEGORY_SUFFIX = /^(.*?)\s*[（(]\s*(person|place|organization|term)\s*[）)]$/i;

function repairReconciledGlossary(
  value: unknown,
  knownEntries: GlossaryEntry[]
): GlossaryEntry[] | null {
  const categoryByTerm = new Map(
    knownEntries.map((e) => [e.term.toLowerCase(), e.category])
  );
  const toCategory = (raw: unknown, term: string): GlossaryCategory => {
    const c = typeof raw === "string" ? raw.toLowerCase() : "";
    return glossaryCategorySchema.safeParse(c).success
      ? (c as GlossaryCategory)
      : categoryByTerm.get(term.toLowerCase()) ?? "term";
  };
  const fromPair = (term: string, raw: unknown): GlossaryEntry | null => {
    if (typeof raw !== "string" || !raw.trim() || !term.trim()) return null;
    const m = raw.trim().match(CATEGORY_SUFFIX);
    const translation = (m ? m[1] : raw).trim();
    if (!translation) return null;
    return { term: term.trim(), translation, category: toCategory(m?.[2], term) };
  };

  let parsed = value;
  // 有 glossary 包裹 → 拆掉外層
  if (
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    (parsed as Record<string, unknown>).glossary !== undefined
  ) {
    parsed = (parsed as Record<string, unknown>).glossary;
  }

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return null;
    // 字串陣列：["Jae-Ha: 宰河 (person)", ...]
    if (parsed.every((e) => typeof e === "string")) {
      const entries: GlossaryEntry[] = [];
      for (const line of parsed as string[]) {
        const idx = line.indexOf(":");
        const entry = idx > 0 ? fromPair(line.slice(0, idx), line.slice(idx + 1)) : null;
        if (!entry) return null;
        entries.push(entry);
      }
      return entries;
    }
    // 條目陣列（欄位名稱可能是 term/entry/name 與 category/type）
    const items = parsed as any[];
    const asEntries = items
      .map((e) => {
        if (!e || typeof e !== "object") return null;
        const term = e.term ?? e.entry ?? e.name;
        if (typeof term !== "string" || typeof e.translation !== "string") return null;
        if (!term.trim() || !e.translation.trim()) return null;
        return {
          term: term.trim(),
          translation: e.translation.trim(),
          category: toCategory(e.category ?? e.type, term),
        };
      })
      .filter((e): e is GlossaryEntry => e !== null);
    if (asEntries.length) return asEntries;
    // 包在單元素陣列裡的扁平 map：[{"Jae-Ha": "宰河", ...}]
    if (items.length === 1 && items[0] && typeof items[0] === "object") {
      parsed = items[0];
    } else {
      return null;
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  // 扁平 map：值為「譯名」或「譯名 (category)」
  const entries: GlossaryEntry[] = [];
  for (const [term, raw] of Object.entries(parsed as Record<string, unknown>)) {
    const entry = fromPair(term, raw);
    if (!entry) return null;
    entries.push(entry);
  }
  return entries.length ? entries : null;
}

async function reconcileGlossary(
  newEntries: GlossaryEntry[],
  lockedEntries: GlossaryEntry[],
  {
    apiKeys,
    apiHost,
    model,
    lang,
    temperature = 0.3,
    disableThinking,
  }: {
    apiKeys: string[];
    apiHost: string;
    model: string;
    lang: string;
    temperature?: number;
    disableThinking?: boolean;
  }
): Promise<GlossaryEntry[]> {
  if (apiKeys.length === 0) {
    throw new Error("No valid API keys provided");
  }
  const ai = getAi({ apiKey: apiKeys[0], apiHost });

  const formatEntries = (entries: GlossaryEntry[]) =>
    entries.map((g) => `- ${g.term}: ${g.translation} (${g.category})`).join("\n");

  const lockedSection = lockedEntries.length
    ? `LOCKED entries (translations are final, do NOT change them):\n${formatEntries(lockedEntries)}\n\n`
    : "";

  const knownEntries = [...lockedEntries, ...newEntries];
  const { glossary } = await generateJson({
    model: ai(model),
    temperature,
    schema: z.object({ glossary: z.array(glossaryEntrySchema) }),
    normalize: (value) => {
      const repaired = repairReconciledGlossary(value, knownEntries);
      return repaired ? { glossary: repaired } : value;
    },
    system: `You are a glossary reconciler for a subtitle translation system.
Different surface forms often refer to the same person: romanization variants of the same name, a full name vs. a given name only, or nicknames.
Rules:
1. Never change the translation of a LOCKED entry.
2. Romanization variants of the same name must share the identical translation.
3. A given-name-only or nickname form must match the corresponding part of the full name's ${lang} translation.
4. Return ALL provided entries with corrected translations. Do NOT invent entries that were not provided.

Output format: reply with ONE JSON object and nothing else, exactly this shape:
{"glossary": [{"term": "<term as provided>", "translation": "<${lang} rendering>", "category": "person" | "place" | "organization" | "term"}]}`,
    prompt: `${lockedSection}NEW entries to reconcile:\n${formatEntries(newEntries)}`,
    providerOptions: noThinkingOptions(disableThinking),
    label: "Glossary reconciliation",
  });
  return glossary;
}

export type { AnalysisResult, GlossaryCategory, GlossaryEntry };
export {
  translateSubtitleChunk,
  translateSubtitleSingle,
  analyzeSubtitlesForContext,
  synthesizePlotSummaries,
  reconcileGlossary,
  parseNumberedList,
  unwrapSingleElementArray,
};
