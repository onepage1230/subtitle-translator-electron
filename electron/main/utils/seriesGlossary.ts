import fs from "node:fs";
import path from "node:path";
import type { GlossaryEntry } from "./translate";

export const SERIES_GLOSSARY_FILE = ".series-glossary.json";
export const SERIES_GLOSSARY_CAP = 100;

const CATEGORY_PRIORITY: Record<string, number> = {
  person: 0,
  organization: 1,
  place: 2,
  term: 3,
};

export function loadSeriesGlossary(folder: string): GlossaryEntry[] {
  const file = path.join(folder, SERIES_GLOSSARY_FILE);
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(parsed.terms)) return [];
    return parsed.terms
      .filter((t: any) => t && typeof t.term === "string" && typeof t.translation === "string")
      .map((t: any) => ({ ...t, category: t.category ?? "term" }));
  } catch {
    return [];
  }
}

export function mergeIntoSeriesGlossary(
  existing: GlossaryEntry[],
  incoming: GlossaryEntry[]
): GlossaryEntry[] {
  const seen = new Set<string>();
  const merged: GlossaryEntry[] = [];
  for (const entry of [...existing, ...incoming]) {
    if (!Object.hasOwn(CATEGORY_PRIORITY, entry.category)) continue; // 准入過濾
    const key = entry.term.toLowerCase();
    if (seen.has(key)) continue; // 先到者勝
    seen.add(key);
    merged.push(entry);
  }
  if (merged.length <= SERIES_GLOSSARY_CAP) return merged;
  return merged
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        CATEGORY_PRIORITY[a.entry.category] - CATEGORY_PRIORITY[b.entry.category] ||
        a.index - b.index
    )
    .slice(0, SERIES_GLOSSARY_CAP)
    .map(({ entry }) => entry);
}

// 調和結果的確定性防護：LOCKED 譯名強制還原、模型漏掉的條目補回、
// 憑空發明的條目丟棄。模型只負責「認出變體」，一致性由這裡保證。
export function enforceReconciliation(
  reconciled: GlossaryEntry[],
  originals: GlossaryEntry[],
  locked: GlossaryEntry[]
): GlossaryEntry[] {
  const lockedMap = new Map(locked.map((e) => [e.term.toLowerCase(), e]));
  const allowed = new Set([
    ...originals.map((e) => e.term.toLowerCase()),
    ...lockedMap.keys(),
  ]);
  const seen = new Set<string>();
  const result: GlossaryEntry[] = [];
  const push = (entry: GlossaryEntry) => {
    const key = entry.term.toLowerCase();
    if (!allowed.has(key) || seen.has(key)) return;
    seen.add(key);
    const lockedEntry = lockedMap.get(key);
    result.push(lockedEntry ? { ...lockedEntry } : entry);
  };
  for (const entry of reconciled) push(entry);
  for (const entry of originals) push(entry); // 模型漏掉的原始條目補回
  return result;
}

export function saveSeriesGlossary(folder: string, terms: GlossaryEntry[]): void {
  try {
    fs.writeFileSync(
      path.join(folder, SERIES_GLOSSARY_FILE),
      JSON.stringify({ terms }, null, 2),
      "utf8"
    );
  } catch {
    // 寫入失敗不阻斷翻譯（例如唯讀資料夾）
  }
}
