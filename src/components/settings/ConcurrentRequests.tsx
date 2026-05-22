import Title from "../Title";
import { useTranslation } from "react-i18next";
import { useLocalStorage } from "usehooks-ts";

export default function ConcurrentRequests() {
  const [concurrentRequests, setConcurrentRequests] = useLocalStorage<
    number | undefined
  >("concurrent_requests", undefined);
  const { t } = useTranslation();

  return (
    <div className="bg-white rounded flex justify-between items-center border border-slate-200 p-4 gap-8">
      <div className="flex flex-col">
        <Title>{t("concurrent_requests.title")}</Title>
        <div className="text-sm text-slate-600">
          {t("concurrent_requests.description")}
        </div>
      </div>
      <div className="flex items-center gap-4 w-80 shrink-0">
        <input
          type="number"
          value={concurrentRequests?.toString() ?? ""}
          onChange={(e) => {
            const val = e.target.valueAsNumber;
            setConcurrentRequests(
              isNaN(val) ? undefined : Math.max(1, Math.min(20, val))
            );
          }}
          className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-500 focus:border-slate-500"
          placeholder="auto"
          min="1"
          max="20"
          step="1"
        />
      </div>
    </div>
  );
}
