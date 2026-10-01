import type { GlossaryEntry } from "./translate";
import { JEV_URL } from "./quality";

// 詞彙表調和前的人名配對篩選：程式列出「可能是同一人」的候選對，Jev 判斷是否
// 同一人，只有「同一人且譯名不一致」才需要 LLM 調和（並把配對當提示）。
// 2026-10-01 實驗（Spring Waltz E01/E02，17 對）：AUC 0.938，門檻 0.5 時
// 不同人 8/8 全對；唯一漏判是兩邊各只有 1 句台詞的配對，且結果在不同批次間
// 不穩定，所以證據不足的配對不交給 Jev，直接要求 LLM 調和。

export const SAME_PERSON_THRESHOLD = 0.5;
const MIN_LINES = 2;
const MAX_LINES = 12;
const CHUNK = 20;

export interface NamePair {
  a: GlossaryEntry;
  b: GlossaryEntry;
}

const tokens = (s: string) => s.toLowerCase().split(/[-\s]+/).filter(Boolean);
const squash = (s: string) => s.toLowerCase().replace(/[-\s]/g, "");

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// 候選規則：短名字詞全在長名中（Jae-Ha / Yoon Jae-Ha）、去連字號空格後拼法相近、
// 譯名共用字。只取至少一邊是本集新條目的配對（LOCKED 之間不需調和）。
export function findCandidatePairs(
  newEntries: GlossaryEntry[],
  lockedEntries: GlossaryEntry[]
): NamePair[] {
  const persons = (list: GlossaryEntry[]) => list.filter((g) => g.category === "person");
  const fresh = persons(newEntries);
  const locked = persons(lockedEntries).filter(
    (l) => !fresh.some((f) => f.term.toLowerCase() === l.term.toLowerCase())
  );
  const all = [...fresh, ...locked];
  const pairs: NamePair[] = [];
  for (let i = 0; i < fresh.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i];
      const b = all[j];
      const [short, long] = tokens(a.term).length <= tokens(b.term).length ? [a, b] : [b, a];
      const subset = tokens(short.term).every((t) => tokens(long.term).includes(t));
      const sa = squash(a.term);
      const sb = squash(b.term);
      const similar =
        levenshtein(sa, sb) <= Math.max(1, Math.floor(Math.min(sa.length, sb.length) / 4));
      const sharedChar = Array.from(a.translation).some((c) => b.translation.includes(c));
      if (subset || similar || sharedChar) pairs.push({ a, b });
    }
  }
  return pairs;
}

// 同一人的兩個名字，譯名相同或其中一個包含另一個（在夏 ⊂ 尹在夏）即視為一致
export function translationsConsistent(a: string, b: string): boolean {
  const x = a.trim();
  const y = b.trim();
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

export function linesMentioning(term: string, texts: string[]): string[] {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[-\s]+/g, "[-\\s]?");
  const re = new RegExp(`\\b${escaped}\\b`, "i");
  return texts.filter((t) => re.test(t)).slice(0, MAX_LINES);
}

export async function judgeSamePersonWithJev(
  pairs: { a: { term: string; lines: string[] }; b: { term: string; lines: string[] } }[],
  apiKey: string,
  opts: { fetchImpl?: typeof fetch } = {}
): Promise<number[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const result: number[] = [];
  for (let start = 0; start < pairs.length; start += CHUNK) {
    const group = pairs.slice(start, start + CHUNK);
    const questions: Record<string, unknown> = {};
    group.forEach((_, k) => {
      questions[`p${k}`] = {
        type: "noul",
        instructions: `In this TV series, do \`pairs[${k}].a.term\` and \`pairs[${k}].b.term\` name the same character? Each comes with subtitle lines where it is mentioned. One may be a given name, full name, nickname or romanization variant of the other.`,
        criteria: {
          true: "Both names refer to the same character.",
          false:
            "They are different characters (e.g. relatives sharing a family name, or unrelated people with similar names).",
        },
      };
    });
    const res = await doFetch(JEV_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "jev-latest", state: { pairs: group }, questions }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json: any = await res.json();
    group.forEach((_, k) => {
      const v = json?.answers?.[`p${k}`]?.noul;
      if (typeof v !== "number") throw new Error(`missing answer p${k}`);
      result.push(v);
    });
  }
  return result;
}

export interface ReconciliationPlan {
  reconcile: boolean;
  // Jev 確認為同一人且譯名不一致的配對，寫進調和 prompt 當提示
  hints: [string, string][];
}

// 決定是否呼叫 LLM 調和。Jev 失敗時由呼叫端退回原本的啟發式規則。
export async function planReconciliation(
  newEntries: GlossaryEntry[],
  lockedEntries: GlossaryEntry[],
  texts: string[],
  apiKey: string,
  opts: { fetchImpl?: typeof fetch } = {}
): Promise<ReconciliationPlan> {
  const candidates = findCandidatePairs(newEntries, lockedEntries).filter(
    (p) => !translationsConsistent(p.a.translation, p.b.translation)
  );
  const withLines = candidates.map((p) => ({
    pair: p,
    a: { term: p.a.term, lines: linesMentioning(p.a.term, texts) },
    b: { term: p.b.term, lines: linesMentioning(p.b.term, texts) },
  }));
  const weak = withLines.filter((x) => x.a.lines.length < MIN_LINES || x.b.lines.length < MIN_LINES);
  const judged = withLines.filter((x) => !weak.includes(x));
  const scores = judged.length
    ? await judgeSamePersonWithJev(
        judged.map(({ a, b }) => ({ a, b })),
        apiKey,
        opts
      )
    : [];
  const hints = judged
    .filter((_, i) => scores[i] >= SAME_PERSON_THRESHOLD)
    .map((x) => [x.pair.a.term, x.pair.b.term] as [string, string]);
  return { reconcile: hints.length > 0 || weak.length > 0, hints };
}
