import { generateText, type LanguageModel } from "ai";
import type { SharedV2ProviderOptions } from "@ai-sdk/provider";
import type { z } from "zod";

// 本機 openai-compatible 模型不支援 structuredOutputs；generateObject 會退而
// 送出 response_format: json_object，而 oMLX 的 JSON 模式在某些輸入上會穩定
// 退化成 "[1.0]"（2026-09-30 實驗重現）。所以結構化輸出一律改走 generateText
// 不送 response_format，靠 prompt 描述形狀，這裡從寬解析、再用 zod 驗證。

class JsonOutputError extends Error {
  name = "JsonOutputError";
  constructor(message: string, readonly text: string) {
    super(message);
  }
}

// 取出回應中第一個完整的 JSON 值：去掉 <think> 區塊與 code fence，
// 從第一個 { 或 [ 起做括號配對（略過字串內容），忽略前後多餘文字。
function extractJson(text: string): unknown {
  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/```(?:json)?/gi, "");
  const start = cleaned.search(/[{[]/);
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(cleaned.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

// 解析 + 形狀修正 + zod 驗證；normalize 用來把已知的錯誤形狀轉成 schema 形狀
function parseJsonOutput<T>(
  text: string,
  schema: z.ZodType<T>,
  normalize?: (value: unknown) => unknown
): T {
  const value = extractJson(text);
  if (value === undefined) {
    throw new JsonOutputError("No JSON value found in model response", text);
  }
  const result = schema.safeParse(normalize ? normalize(value) : value);
  if (!result.success) {
    throw new JsonOutputError(
      `Model response did not match schema: ${result.error.message}`,
      text
    );
  }
  return result.data;
}

// 格式錯誤（JsonOutputError）重試到 attempts 次；網路/API 錯誤直接拋出。
// maxOutputTokens 預設不設：推理模型的 thinking 也計入輸出（實測 Qwen3 分析一段
// 約 2 萬 token 的 reasoning + 1 千 token 的答案），設小了會在思考中途截斷。
async function generateJson<T>({
  model,
  system,
  prompt,
  schema,
  normalize,
  temperature,
  maxOutputTokens,
  providerOptions,
  attempts = 2,
  label = "JSON output",
}: {
  model: LanguageModel;
  system?: string;
  prompt: string;
  schema: z.ZodType<T>;
  normalize?: (value: unknown) => unknown;
  temperature?: number;
  maxOutputTokens?: number;
  providerOptions?: SharedV2ProviderOptions;
  attempts?: number;
  label?: string;
}): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const { text } = await generateText({
      model,
      temperature,
      system,
      prompt,
      maxOutputTokens,
      providerOptions,
      maxRetries: 2,
    });
    try {
      return parseJsonOutput(text, schema, normalize);
    } catch (err) {
      lastErr = err;
      console.warn(`${label} attempt ${attempt} returned wrong shape`);
    }
  }
  throw lastErr;
}

export { JsonOutputError, extractJson, parseJsonOutput, generateJson };
