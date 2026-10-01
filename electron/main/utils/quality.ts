import type { GlossaryEntry } from "./translate";
import { filterGlossaryForText } from "./analysis";

// 只收「繁體中不會出現」的簡體專用字；同形歧義字（后 干 只 台 里 面 发 etc.）一律不收，寧可漏抓不要誤報。
const SIMPLIFIED_ONLY =
  "这们说时会对过还么应该让没为样请问关开门见长东车书买卖电话钱从气听爱头儿难实现点进边远选条办动学习经结给红级约纸线练组终绝统际陆阳队险随双岁历厅园圆图团专业丽乐乔义乱争亏亚产亩亲亿仅仓仪价众优伙伞伟传伤伦伪体佣侠侣侥侦侧侨侬俭债倾偿储兑党兰兴兹养兽册写军农冯决况冻净凉减凑凛凤凭凯击凿刍刘则刚创删别刹刽刿剀剂剐剑剥剧劝务劢励劲劳势勋勚匀匦匮区医华协单卢卤卫厂厉压厌厍厕厢厣厦厨厩厮县叁参双变叙叠叶号叹叽吓吕吗吨启吴呐呓呕呖呗员呙呛呜咏咙咛咝咤响哑哒哓哔哕哗哙哜哝哟唛唝唠唡唢唤啧啬啭啮啰啴啸喷喽喾嗫嗳嘘嘤嘱噜嚣";
const SIMPLIFIED_SET = new Set(Array.from(SIMPLIFIED_ONLY));

const HANGUL = /[가-힯]/;
const CJK = /[㐀-䶿一-鿿豈-﫿]/;
const INTERJECTIONS = new Set([
  "oh", "ah", "uh", "um", "hm", "hmm", "huh", "hey", "wow", "ok", "okay", "yes", "no", "ha", "haha", "eh", "aw", "ow", "ugh", "shh",
]);

export function isTraditionalChineseTarget(lang: string): boolean {
  return /繁體|正體|繁中|traditional|zh[-_]?(tw|hant|hk)/i.test(lang || "");
}

function looksUntranslated(source: string, translation: string): boolean {
  if (HANGUL.test(translation)) return true;
  const words = source.match(/[A-Za-z]+/g);
  if (!words) return false;
  const letters = words.join("");
  if (letters.length <= 3) return false;
  if (words.length === 1 && INTERJECTIONS.has(words[0].toLowerCase())) return false;
  const nonSpace = Array.from(translation.replace(/\s+/g, ""));
  if (nonSpace.length === 0) return false;
  const cjk = nonSpace.filter((c) => CJK.test(c)).length;
  return cjk / nonSpace.length < 0.3;
}

// 「未翻／殘留韓文」檢查以譯文中文字比例判斷，只對中文目標語言有意義
export function isChineseTarget(lang: string): boolean {
  return /中文|漢語|汉语|繁|簡|简|正體|chinese|mandarin|cantonese|^zh\b|zh[-_]/i.test(lang || "");
}

export function detectCodeIssues(
  source: string,
  translation: string,
  opts: { traditional: boolean; chinese: boolean; glossary: GlossaryEntry[] }
): string[] {
  const issues: string[] = [];
  if (!translation || !translation.trim()) return issues;
  // 原文沒有任何字母（純數字/標點）不判
  const hasLetters = /\p{L}/u.test(source);

  if (opts.traditional && Array.from(translation).some((c) => SIMPLIFIED_SET.has(c))) {
    issues.push("simplified");
  }
  if (opts.chinese && hasLetters && looksUntranslated(source, translation)) {
    issues.push("untranslated");
  }
  const persons = (opts.glossary || []).filter((g) => g.category === "person");
  if (persons.length > 0) {
    for (const g of filterGlossaryForText(persons, [source])) {
      if (g.translation && !translation.includes(g.translation)) {
        issues.push(`glossary:${g.term}`);
      }
    }
  }
  return issues;
}

const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const CHUNK = 20;

function buildQuestions(n: number) {
  const questions: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) {
    questions[`l${i}`] = {
      type: "noul",
      instructions: `Is \`lines[${i}].translation\` a faithful translation of \`lines[${i}].source\`? Neighbouring lines are context only; subtitles may be condensed or rephrased naturally.`,
      criteria: {
        true: "Conveys the same meaning as its own source line (natural condensation, idiom, or tone changes are fine).",
        false:
          "Missing, left untranslated, meaning changed or reversed, or actually translates a different line.",
      },
    };
  }
  return questions;
}

export async function checkWithJev(
  pairs: { source: string; translation: string }[],
  apiKey: string,
  opts: { threshold?: number; fetchImpl?: typeof fetch } = {}
): Promise<boolean[]> {
  const threshold = opts.threshold ?? 0.3;
  const doFetch = opts.fetchImpl ?? fetch;
  const result: boolean[] = new Array(pairs.length).fill(false);
  const eligible: number[] = [];
  pairs.forEach((p, i) => {
    if (p.translation && p.translation.trim() && p.translation !== "__FAILED__") eligible.push(i);
  });
  const groups: number[][] = [];
  for (let i = 0; i < eligible.length; i += CHUNK) groups.push(eligible.slice(i, i + CHUNK));

  await Promise.all(
    groups.map(async (idxs) => {
      try {
        const res = await doFetch(JEV_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "jev-latest",
            state: {
              lines: idxs.map((i) => ({ source: pairs[i].source, translation: pairs[i].translation })),
            },
            questions: buildQuestions(idxs.length),
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json: any = await res.json();
        const flags = idxs.map((_, k) => {
          const v = json?.answers?.[`l${k}`]?.noul;
          if (typeof v !== "number") throw new Error(`missing answer l${k}`);
          return v < threshold;
        });
        idxs.forEach((orig, k) => {
          result[orig] = flags[k];
        });
      } catch (err) {
        console.warn("Jev quality check failed for a chunk, skipping:", err);
      }
    })
  );
  return result;
}

export type RetranslationChoice = "original" | "retranslation" | "same";

// 重翻後由 Jev 在原譯與新譯間選較忠實者；請求失敗的組回 null（由呼叫端採預設）
export async function chooseWithJev(
  items: { source: string; original: string; retranslation: string }[],
  apiKey: string,
  opts: { fetchImpl?: typeof fetch } = {}
): Promise<(RetranslationChoice | null)[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const result: (RetranslationChoice | null)[] = new Array(items.length).fill(null);
  const groups: number[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) {
    groups.push(Array.from({ length: Math.min(CHUNK, items.length - i) }, (_, k) => i + k));
  }

  await Promise.all(
    groups.map(async (idxs) => {
      try {
        const questions: Record<string, unknown> = {};
        idxs.forEach((_, k) => {
          questions[`c${k}`] = {
            type: "choice",
            instructions: `Which translation of \`pairs[${k}].source\` is more faithful: \`pairs[${k}].original\` or \`pairs[${k}].retranslation\`? Subtitles may be condensed or rephrased naturally.`,
            criteria: {
              original: "`original` conveys the source meaning clearly better than `retranslation`.",
              retranslation: "`retranslation` conveys the source meaning clearly better than `original`.",
              same: "Both are about equally faithful (both fine, or both flawed to a similar degree).",
            },
          };
        });
        const res = await doFetch(JEV_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "jev-latest",
            state: { pairs: idxs.map((i) => items[i]) },
            questions,
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json: any = await res.json();
        idxs.forEach((orig, k) => {
          const c = json?.answers?.[`c${k}`]?.choice;
          if (c === "original" || c === "retranslation" || c === "same") result[orig] = c;
        });
      } catch (err) {
        console.warn("Jev retranslation choice failed for a chunk, using defaults:", err);
      }
    })
  );
  return result;
}

// 決定重翻句要採用哪個版本。程式規則判得準的先用規則；語意比較才交給 Jev。
// 預設（Jev 未設定、失敗或回答 same）採用新譯文：原譯已被標記過至少一個疑點。
// - 原譯因程式規則被標記：新譯文規則乾淨 → 新譯；仍有問題 → 問 Jev
// - 原譯只因 Jev 被標記：新譯文反而出現規則問題 → 原譯；否則 → 問 Jev
export function needsJevChoice(origCodeIssues: string[], newCodeIssues: string[]): boolean {
  if (origCodeIssues.length > 0) return newCodeIssues.length > 0;
  return newCodeIssues.length === 0;
}

export function pickRetranslation(
  origCodeIssues: string[],
  newCodeIssues: string[],
  jevChoice: RetranslationChoice | null
): "original" | "retranslation" {
  if (origCodeIssues.length > 0 && newCodeIssues.length === 0) return "retranslation";
  if (origCodeIssues.length === 0 && newCodeIssues.length > 0) return "original";
  return jevChoice === "original" ? "original" : "retranslation";
}
