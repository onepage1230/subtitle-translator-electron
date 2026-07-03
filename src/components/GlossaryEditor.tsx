import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ipcRenderer } from "electron";

interface GlossaryEntry {
  term: string;
  translation: string;
  category?: string;
  userEdited?: boolean;
}

type GlossaryOp =
  | { type: "edit"; term: string; translation: string }
  | { type: "delete"; term: string };

interface GlossaryEditorProps {
  filePath: string;
  isTranslating: boolean;
  /** series glossary 為空時退回唯讀顯示的該檔分析詞彙表 */
  fallbackGlossary: GlossaryEntry[];
}

export default function GlossaryEditor({
  filePath,
  isTranslating,
  fallbackGlossary,
}: GlossaryEditorProps) {
  const { t } = useTranslation();
  const [terms, setTerms] = useState<GlossaryEntry[]>([]);
  const [editingTerm, setEditingTerm] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [confirmTerm, setConfirmTerm] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState(false);

  const reload = async () => {
    try {
      const result = await ipcRenderer.invoke("get-series-glossary", filePath);
      setTerms(result.terms);
    } catch {
      setTerms([]);
    }
  };

  useEffect(() => {
    reload();
  }, [filePath]);

  // 翻譯結束時重新讀取——pipeline 過程中會合併寫入新條目
  const prevTranslating = useRef(isTranslating);
  useEffect(() => {
    if (prevTranslating.current && !isTranslating) reload();
    prevTranslating.current = isTranslating;
  }, [isTranslating]);

  const applyOp = async (op: GlossaryOp) => {
    setError(false);
    try {
      const result = await ipcRenderer.invoke("update-series-glossary", {
        filePath,
        op,
      });
      setTerms(result.terms);
      setDirty(true);
    } catch {
      setError(true);
    }
  };

  const commitEdit = (term: string) => {
    const value = editValue.trim();
    const current = terms.find((x) => x.term === term);
    setEditingTerm(null);
    if (!value || !current || value === current.translation) return;
    applyOp({ type: "edit", term, translation: value });
  };

  // series glossary 為空 → 退回現行唯讀顯示（行為與改動前相同）
  if (terms.length === 0) {
    if (fallbackGlossary.length === 0) return null;
    return (
      <>
        <div className="text-sm font-medium text-slate-700">
          {t("translate.context.glossary")}
        </div>
        <ul className="text-sm mt-1 space-y-0.5">
          {fallbackGlossary.map((g, i) => (
            <li key={i}>
              <span className="font-medium">{g.term}</span>: {g.translation}
            </li>
          ))}
        </ul>
      </>
    );
  }

  return (
    <>
      <div className="text-sm font-medium text-slate-700">
        {t("translate.context.series_glossary")}
      </div>
      <ul className="text-sm mt-1 space-y-0.5">
        {terms.map((g) => (
          <li
            key={g.term}
            className="flex items-center gap-1"
            onMouseLeave={() => setConfirmTerm(null)}
          >
            <span className="font-medium">{g.term}</span>
            {g.userEdited && (
              <i
                className="bx bx-lock-alt text-slate-400"
                title={t("translate.context.user_edited")}
              />
            )}
            <span>:</span>
            {editingTerm === g.term ? (
              <input
                autoFocus
                className="border border-gray-300 rounded px-1 text-sm"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitEdit(g.term);
                  if (e.key === "Escape") setEditingTerm(null);
                }}
                onBlur={() => commitEdit(g.term)}
              />
            ) : (
              <span
                className={
                  isTranslating ? "opacity-50" : "cursor-pointer hover:underline"
                }
                onClick={() => {
                  if (isTranslating) return;
                  setEditingTerm(g.term);
                  setEditValue(g.translation);
                }}
              >
                {g.translation}
              </span>
            )}
            {confirmTerm === g.term ? (
              <button
                className="text-red-500 text-xs font-medium"
                onClick={() => {
                  setConfirmTerm(null);
                  applyOp({ type: "delete", term: g.term });
                }}
              >
                {t("translate.context.confirm_delete")}
              </button>
            ) : (
              <button
                disabled={isTranslating}
                className="text-slate-400 hover:text-red-500 disabled:opacity-30 disabled:hover:text-slate-400"
                onClick={() => setConfirmTerm(g.term)}
              >
                <i className="bx bx-trash" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {dirty && (
        <p className="text-xs text-slate-500 mt-1">
          {t("translate.context.retranslate_hint")}
        </p>
      )}
      {error && (
        <p className="text-xs text-red-500 mt-1">
          {t("translate.context.save_error")}
        </p>
      )}
    </>
  );
}
