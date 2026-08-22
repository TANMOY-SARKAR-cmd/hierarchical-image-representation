import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { Download, FileJson2, TableProperties, Timer } from "lucide-react";
import { useMemo, useState } from "react";

export type TimingHistoryRecord = {
  jobId: string;
  completedAt: number | null;
  expiresAt: number;
  image: { width: number | null; height: number | null };
  configuration: { segmentationStrategy: string; reconstructionProfile: string };
  processingTimeMs: number;
  totalDurationMs: number;
  sensitivityVariantCount: number;
  stages: Array<{ stage: string; label: string; durationMs: number }>;
};

const formatDuration = (value: number) => value < 60_000 ? `${Math.round(value / 1000)}s` : `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1000)}s`;
const escapeCsv = (value: string | number | null) => `"${String(value ?? "").replaceAll('"', '""')}"`;

export function buildTimingComparisonCsv(records: TimingHistoryRecord[]) {
  const stageLabels = Array.from(new Set(records.flatMap(record => record.stages.map(stage => stage.label))));
  const header = ["job_id", "completed_at", "width", "height", "segmentation", "profile", "processing_ms", "total_duration_ms", "sensitivity_variants", ...stageLabels.map(label => `${label}_ms`)];
  const rows = records.map(record => {
    const stages = new Map(record.stages.map(stage => [stage.label, stage.durationMs]));
    return [record.jobId, record.completedAt ? new Date(record.completedAt).toISOString() : null, record.image.width, record.image.height, record.configuration.segmentationStrategy, record.configuration.reconstructionProfile, record.processingTimeMs, record.totalDurationMs, record.sensitivityVariantCount, ...stageLabels.map(label => stages.get(label) ?? 0)].map(escapeCsv).join(",");
  });
  return [header.map(escapeCsv).join(","), ...rows].join("\n");
}

export function buildTimingComparisonJson(records: TimingHistoryRecord[]) {
  return JSON.stringify({ schema: "hir.execution-timing-comparison.v1", generatedAt: new Date().toISOString(), retention: "Contains only currently accessible analyses owned by this browser or account. Discarded and expired analyses are intentionally excluded.", records }, null, 2);
}

function download(filename: string, body: string, type: string) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export default function TimingHistoryExport() {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const historyQuery = trpc.imageAnalysis.timingHistory.useQuery({ limit: 25 }, { refetchOnWindowFocus: false, retry: false });
  const records = (historyQuery.data ?? []) as TimingHistoryRecord[];
  const selectedRecords = useMemo(() => records.filter(record => !selectedIds.length || selectedIds.includes(record.jobId)), [records, selectedIds]);
  const dateStamp = new Date().toISOString().slice(0, 10);
  const toggle = (jobId: string) => setSelectedIds(current => current.includes(jobId) ? current.filter(id => id !== jobId) : [...current, jobId]);
  const selectAll = () => setSelectedIds(current => current.length === records.length ? [] : records.map(record => record.jobId));

  return <section className="rounded-xl border border-cyan-100/10 bg-slate-900/80 p-4" aria-labelledby="timing-history-title">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2 text-sm font-semibold text-slate-100"><Timer className="h-4 w-4 text-cyan-300" /><h2 id="timing-history-title">Execution timing history</h2></div><p className="mt-1 max-w-2xl text-[11px] leading-relaxed text-slate-500">Compare retained completed analyses owned by this browser or account. Discarded and expired runs are omitted and cannot be restored by this report.</p></div>{records.length ? <Button type="button" variant="outline" size="sm" onClick={selectAll} className="border-white/10 bg-black/20 font-mono text-[10px] text-slate-300">{selectedIds.length === records.length ? "Clear selection" : "Select all"}</Button> : null}</div>
    {historyQuery.isLoading ? <p role="status" className="mt-3 text-xs text-cyan-100">Loading retained timing records…</p> : null}
    {historyQuery.isError ? <p role="alert" className="mt-3 rounded border border-amber-300/20 bg-amber-300/[0.04] p-3 text-xs text-amber-100">Timing history is unavailable in this browser right now. Your completed result remains private and unaffected.</p> : null}
    {!historyQuery.isLoading && !historyQuery.isError && !records.length ? <p className="mt-3 rounded border border-dashed border-white/10 p-3 text-xs text-slate-500">No retained completed timing records are available yet. Complete an analysis to create a private comparison entry.</p> : null}
    {records.length ? <><div className="mt-3 overflow-x-auto rounded border border-white/8"><table className="w-full min-w-[700px] text-left text-xs"><thead className="bg-white/[0.04] font-mono text-[9px] uppercase tracking-wider text-slate-500"><tr><th className="px-3 py-2">Select</th><th className="px-3 py-2">Completed</th><th className="px-3 py-2">Configuration</th><th className="px-3 py-2">Runtime</th><th className="px-3 py-2">Stages</th></tr></thead><tbody>{records.map(record => <tr key={record.jobId} className="border-t border-white/6 text-slate-300"><td className="px-3 py-2"><input type="checkbox" checked={!selectedIds.length || selectedIds.includes(record.jobId)} onChange={() => toggle(record.jobId)} aria-label={`Include run ${record.jobId.slice(0, 8)} in comparison export`} className="accent-cyan-300" /></td><td className="px-3 py-2 font-mono text-[10px] text-slate-400">{record.completedAt ? new Date(record.completedAt).toLocaleString() : "Unknown"}</td><td className="px-3 py-2"><span className="font-mono text-[10px] text-cyan-100">{record.configuration.segmentationStrategy}</span><span className="ml-2 text-slate-500">{record.configuration.reconstructionProfile} · {record.image.width ?? "?"}×{record.image.height ?? "?"}</span></td><td className="px-3 py-2 font-mono text-cyan-100">{formatDuration(record.totalDurationMs || record.processingTimeMs)}</td><td className="px-3 py-2 text-slate-500">{record.stages.length} · sensitivity {record.sensitivityVariantCount}</td></tr>)}</tbody></table></div><div className="mt-3 flex flex-wrap gap-2"><Button type="button" size="sm" onClick={() => download(`hierarchical-image-timing-comparison-${dateStamp}.csv`, buildTimingComparisonCsv(selectedRecords), "text/csv;charset=utf-8")} className="bg-cyan-300 text-slate-950 hover:bg-cyan-200"><TableProperties className="mr-2 h-3.5 w-3.5" /> Download CSV</Button><Button type="button" variant="outline" size="sm" onClick={() => download(`hierarchical-image-timing-comparison-${dateStamp}.json`, buildTimingComparisonJson(selectedRecords), "application/json;charset=utf-8")} className="border-cyan-300/25 bg-cyan-300/[0.04] text-cyan-100 hover:bg-cyan-300/[0.12]"><FileJson2 className="mr-2 h-3.5 w-3.5" /> Download JSON <Download className="ml-2 h-3 w-3" /></Button></div></> : null}
  </section>;
}
