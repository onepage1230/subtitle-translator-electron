import { z } from "zod";
import { generateObject, generateText, tool } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

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
    const { object } = await generateObject({
      model: ai(model),
      temperature,
      schema: z.array(z.string().describe("The translated subtitles")),
      prompt:
        systemPrompt +
        "\nOutput must be valid json. Respond with a JSON object that matches the schema. Return only JSON.\n\n" +
        JSON.stringify(subtitles),
      maxRetries: 3,
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
    const { object } = await generateObject({
      model: ai(model),
      temperature,
      schema: z.object({ result: z.string() }),
      prompt:
        systemPrompt +
        "\nOutput must be valid json. Respond with a JSON object that matches the schema. Return only JSON.\n\n" +
        JSON.stringify(subtitle),
      maxRetries: 3,
    });
    return object.result;
  } catch (e: any) {
    throw e;
  }
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
  }: {
    apiKeys: string[];
    apiHost: string;
    model: string;
    lang: string;
    temperature?: number;
    existingGlossary?: GlossaryEntry[];
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
          .join("\n")}`
      : "";

  const { object } = await generateObject({
    model: ai(model),
    temperature,
    schema: analysisSchema,
    system: `You are a subtitle content analyst for a translation system.
Analyze the provided subtitle sample and return:
1. plotSummary: A ${lang} narrative (5–10 sentences) describing what happens. Write naturally, not as a literal stitch of subtitles.
2. glossary: Up to 15 entries of proper nouns ONLY — person names (category "person"), place names ("place"), organization or group names ("organization"), and titles, fictional terms or domain-specific jargon ("term"). Do NOT include common nouns, everyday vocabulary, or full sentences. For each entry provide the term as it appears, its preferred ${lang} translation or rendering (repeat the original term if no translation exists), and its category.${existingSection}`,
    prompt: `Analyze this subtitle sample:\n\n` + subtitles.join("\n"),
    maxRetries: 2,
  });

  return object;
}

async function synthesizePlotSummaries(
  summaries: string[],
  {
    apiKeys,
    apiHost,
    model,
    lang,
    temperature = 0.3,
  }: {
    apiKeys: string[];
    apiHost: string;
    model: string;
    lang: string;
    temperature?: number;
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
    maxRetries: 2,
  });

  return result.text;
}

export type { AnalysisResult, GlossaryCategory, GlossaryEntry };
export {
  translateSubtitleChunk,
  translateSubtitleSingle,
  analyzeSubtitlesForContext,
  synthesizePlotSummaries,
  parseNumberedList,
};
