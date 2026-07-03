import fs from "node:fs";
import path from "node:path";
import type { GlossaryEntry } from "./translate";

export const SERIES_GLOSSARY_FILE = ".series-glossary.json";
export const SERIES_GLOSSARY_CAP = 100;

export type SeriesGlossaryEntry = GlossaryEntry & { userEdited?: boolean };

export interface SeriesGlossaryData {
  terms: SeriesGlossaryEntry[];
  excluded: string[];
}

const CATEGORY_PRIORITY: Record<string, number> = {
  person: 0,
  organization: 1,
  place: 2,
  term: 3,
};

export function loadSeriesGlossary(folder: string): SeriesGlossaryData {
  const file = path.join(folder, SERIES_GLOSSARY_FILE);
  if (!fs.existsSync(file)) return { terms: [], excluded: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const terms = Array.isArray(parsed.terms)
      ? parsed.terms
          .filter(
            (t: any) =>
              t && typeof t.term === "string" && typeof t.translation === "string"
          )
          .map((t: any) => ({ ...t, category: t.category ?? "term" }))
      : [];
    const excluded = Array.isArray(parsed.excluded)
      ? parsed.excluded.filter((t: any) => typeof t === "string")
      : [];
    return { terms, excluded };
  } catch {
    return { terms: [], excluded: [] };
  }
}

export function mergeIntoSeriesGlossary(
  existing: SeriesGlossaryEntry[],
  incoming: SeriesGlossaryEntry[],
  excluded: string[] = []
): SeriesGlossaryEntry[] {
  const excludedSet = new Set(excluded.map((t) => t.toLowerCase()));
  const seen = new Set<string>();
  const merged: SeriesGlossaryEntry[] = [];
  for (const entry of [...existing, ...incoming]) {
    if (!Object.hasOwn(CATEGORY_PRIORITY, entry.category)) continue; // 准入過濾
    const key = entry.term.toLowerCase();
    if (excludedSet.has(key)) continue; // 使用者刪除過的條目永久排除
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

export function saveSeriesGlossary(
  folder: string,
  terms: SeriesGlossaryEntry[],
  excluded: string[] = []
): boolean {
  try {
    fs.writeFileSync(
      path.join(folder, SERIES_GLOSSARY_FILE),
      JSON.stringify({ terms, excluded }, null, 2),
      "utf8"
    );
    return true;
  } catch {
    // 寫入失敗不阻斷翻譯（例如唯讀資料夾）；呼叫端可依回傳值決定是否上報
    return false;
  }
}

export type GlossaryOp =
  | { type: "edit"; term: string; translation: string }
  | { type: "delete"; term: string };

export function editGlossaryTranslation(
  data: SeriesGlossaryData,
  term: string,
  translation: string
): SeriesGlossaryData {
  const trimmed = translation.trim();
  if (!trimmed) return data; // 空譯名不套用
  const key = term.toLowerCase();
  const index = data.terms.findIndex((t) => t.term.toLowerCase() === key);
  if (index === -1) return data; // 找不到不套用
  const terms = data.terms.slice();
  terms[index] = { ...terms[index], translation: trimmed, userEdited: true };
  return { terms, excluded: data.excluded };
}

export function deleteGlossaryTerm(
  data: SeriesGlossaryData,
  term: string
): SeriesGlossaryData {
  const key = term.toLowerCase();
  const terms = data.terms.filter((t) => t.term.toLowerCase() !== key);
  const excluded = data.excluded.includes(key)
    ? data.excluded
    : [...data.excluded, key];
  return { terms, excluded };
}

// IPC handler 的完整流程：load → 套用 → save。驗證未通過時回傳現況、不寫檔；
// 寫檔失敗 throw 讓 renderer 顯示錯誤。
export function applyGlossaryOp(
  folder: string,
  op: GlossaryOp
): { terms: SeriesGlossaryEntry[] } {
  const data = loadSeriesGlossary(folder);
  const next =
    op.type === "edit"
      ? editGlossaryTranslation(data, op.term, op.translation)
      : deleteGlossaryTerm(data, op.term);
  if (next !== data) {
    if (!saveSeriesGlossary(folder, next.terms, next.excluded)) {
      throw new Error("Failed to write series glossary");
    }
  }
  return { terms: next.terms };
}
