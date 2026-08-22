import { Timer } from "lucide-react";
import React, { useState } from "react";

export type ExecutionStageTiming = {
  stage: string;
  label: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  messages?: Array<{ message: string; at: number; offsetMs: number }>;
};

export type ExecutionTiming = {
  schema: string;
  totalDurationMs: number;
  stages: ExecutionStageTiming[];
  interpretation: string;
};

function formatDuration(valueMs: number) {
  const seconds = Math.max(0, Math.round(valueMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function TimelineStageRow({ stage, index, maximumDuration }: { stage: ExecutionStageTiming; index: number; maximumDuration: number }) {
  const [expanded, setExpanded] = useState(false);
  const detailId = `timeline-stage-${stage.stage}-${stage.startedAt}`;
  const messages = stage.messages ?? [];
  return <li className="rounded border border-white/8 bg-black/20"><button type="button" aria-expanded={expanded} aria-controls={detailId} onClick={() => setExpanded(value => !value)} className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-2.5 py-2 text-left transition-colors hover:bg-white/[0.035] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-violet-300"><div className="min-w-0"><div className="flex items-center justify-between gap-2"><span className="truncate text-xs text-slate-200">{stage.label}</span><span className="font-mono text-[9px] text-slate-600">{index + 1} · {expanded ? "HIDE" : "DETAIL"}</span></div><div className="mt-1 h-1 overflow-hidden rounded bg-slate-950"><div className="h-full rounded bg-violet-300/75" style={{ width: `${Math.max(3, Math.round((stage.durationMs / maximumDuration) * 100))}%` }} /></div></div><span className="font-mono text-[10px] text-violet-100">{formatDuration(stage.durationMs)}</span></button>{expanded ? <div id={detailId} className="border-t border-white/8 px-2.5 py-2"><p className="font-mono text-[9px] uppercase tracking-wider text-violet-200">Stage progress details</p>{messages.length ? <ol className="mt-1.5 space-y-1">{messages.map(entry => <li key={`${entry.offsetMs}-${entry.message}`} className="grid grid-cols-[auto_minmax(0,1fr)] gap-2 font-mono text-[10px]"><span className="text-violet-200/70">+{formatDuration(entry.offsetMs)}</span><span className="text-slate-300">{entry.message}</span></li>)}</ol> : <p className="mt-1 text-[10px] leading-relaxed text-slate-500">This restored timing entry contains duration evidence only; no stage messages were emitted.</p>}</div> : null}</li>;
}

export default function ExecutionTimeline({ timing }: { timing: ExecutionTiming | undefined }) {
  if (!timing?.stages.length) return null;
  const maximumDuration = Math.max(1, ...timing.stages.map(stage => stage.durationMs));
  return <section className="rounded-xl border border-violet-300/20 bg-violet-300/[0.035] p-4" aria-labelledby="execution-timeline-title"><h2 id="execution-timeline-title" className="mb-1 flex items-center gap-2 text-sm font-semibold text-violet-100"><Timer className="h-4 w-4 text-violet-300" /><span>Execution timeline</span></h2><p className="text-[11px] leading-relaxed text-slate-400">Total server-observed time <span className="font-mono text-violet-100">{formatDuration(timing.totalDurationMs)}</span>. Includes orchestration and artifact work; it is not a performance guarantee.</p><ol className="mt-3 space-y-2" aria-label="Analysis stage durations">{timing.stages.map((stage, index) => <TimelineStageRow key={`${stage.stage}-${stage.startedAt}`} stage={stage} index={index} maximumDuration={maximumDuration} />)}</ol></section>;
}
