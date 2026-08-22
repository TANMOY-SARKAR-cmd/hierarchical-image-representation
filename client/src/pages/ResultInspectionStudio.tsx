import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Activity, Boxes, Layers3, Network, Sparkles, TreePine } from "lucide-react";
import * as React from "react";
import { useState } from "react";
import type { Entity, Representation } from "./Home";

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

function TreeNode({ entity, entities, selectedId, onSelect, depth = 0 }: { entity: Entity; entities: Map<string, Entity>; selectedId: string | null; onSelect: (id: string) => void; depth?: number }) {
  const [expanded, setExpanded] = useState(depth < 2);
  const children = entity.children.map(id => entities.get(id)).filter((item): item is Entity => Boolean(item));
  return <div role="treeitem" aria-level={depth + 1} aria-selected={selectedId === entity.id} aria-expanded={children.length ? expanded : undefined}>
    <div className="flex items-center" style={{ paddingLeft: `${8 + depth * 14}px` }}>
      {children.length ? <button type="button" aria-label={`${expanded ? "Collapse" : "Expand"} ${entity.type.replace("_", " ")}`} aria-expanded={expanded} onClick={() => setExpanded(value => !value)} className="grid h-7 w-7 shrink-0 place-items-center rounded text-slate-500 transition-colors hover:bg-white/8 hover:text-cyan-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-300">{expanded ? "−" : "+"}</button> : <span className="w-7 shrink-0" aria-hidden="true" />}
      <button type="button" onClick={() => onSelect(entity.id)} className={cn("group flex min-w-0 flex-1 items-center gap-1 rounded-md px-2 py-1.5 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-300", selectedId === entity.id ? "bg-cyan-400/15 text-cyan-100 ring-1 ring-cyan-300/30" : "text-slate-300 hover:bg-white/5")}>
        <span className="rounded bg-white/6 px-1.5 py-0.5 font-mono text-[10px] uppercase text-slate-400">L{entity.level}</span><span className="truncate font-medium">{entity.type.replace("_", " ")}</span><span className="ml-auto font-mono text-[10px] text-slate-500">{entity.geometry.area}</span>
      </button>
    </div>
    {expanded && children.length ? <div role="group">{children.map(child => <TreeNode key={child.id} entity={child} entities={entities} selectedId={selectedId} onSelect={onSelect} depth={depth + 1} />)}</div> : null}
  </div>;
}

type Props = {
  representation: Representation;
  selectedId: string | null;
  onSelect: (id: string) => void;
  activeCut: "full" | "region" | "composite" | "entity";
  onCutChange: (cut: "full" | "region" | "composite" | "entity") => void;
  parameterSensitivityUrl?: string;
};

export default function ResultInspectionStudio({ representation, selectedId, onSelect, activeCut, onCutChange, parameterSensitivityUrl }: Props) {
  const entities = new Map(representation.entities.map(entity => [entity.id, entity]));
  const selectedEntity = selectedId ? entities.get(selectedId) ?? null : null;
  const root = entities.get(representation.hierarchy.rootId) ?? null;
  const selectedRelationships = representation.relationships.filter(edge => edge.sourceId === selectedId || edge.targetId === selectedId).slice(0, 8);
  const cuts = representation.hierarchy.cuts;
  const activeDerivedCut = activeCut === "full" ? null : cuts?.[activeCut];
  const energy = selectedEntity?.lineage?.mergeEvidence?.energy;
  const model = selectedEntity?.appearanceModel;
  const diagnostics = Object.values(representation.segmentationDiagnostics ?? {});
  const correspondence = representation.scale_correspondence;
  const selectedLink = correspondence?.links.find(link => link.sourceId === selectedId || link.targetId === selectedId);
  const views: Array<{ id: Props["activeCut"]; label: string; count: number }> = [
    { id: "full", label: "Full tree", count: representation.hierarchy.treeNodeIds?.length ?? 0 },
    { id: "region", label: "Region", count: cuts?.region.targetNodeCount ?? 0 },
    { id: "composite", label: "Composite", count: cuts?.composite.targetNodeCount ?? 0 },
    { id: "entity", label: "Entity", count: cuts?.entity.targetNodeCount ?? 0 },
  ];

  return <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_330px]">
    <div className="space-y-4">
      <section className="rounded-xl border border-cyan-100/10 bg-slate-900/80 p-4"><div className="mb-4 flex items-center gap-2 text-sm font-semibold text-slate-100"><TreePine className="h-4 w-4 text-cyan-300" /> Hierarchy navigator</div>{root ? <div role="tree" className="max-h-[420px] overflow-auto pr-1"><TreeNode entity={root} entities={entities} selectedId={selectedId} onSelect={onSelect} /></div> : <p className="text-xs text-slate-500">No hierarchy is available for this retained result.</p>}</section>
      <section className="rounded-xl border border-cyan-100/10 bg-slate-900/80 p-4"><div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-100"><TreePine className="h-4 w-4 text-cyan-300" /> Global merge tree</div><div className="grid grid-cols-2 gap-1.5">{views.map(view => <Button key={view.id} type="button" variant="outline" size="sm" aria-pressed={activeCut === view.id} onClick={() => onCutChange(view.id)} className={cn("h-auto min-h-9 justify-between border-white/10 bg-black/20 px-2 py-1.5 font-mono text-[9px] text-slate-400", activeCut === view.id && "border-cyan-300/45 bg-cyan-300/10 text-cyan-100")}><span>{view.label}</span><span>{view.count}</span></Button>)}</div>{activeDerivedCut ? <div className="mt-3 rounded border border-white/8 bg-black/20 p-2"><p className="font-mono text-[9px] uppercase tracking-wider text-slate-500">Derived-cut nodes · target {activeDerivedCut.targetNodeCount}</p><div className="mt-2 flex max-h-24 flex-wrap gap-1 overflow-auto">{activeDerivedCut.nodeIds.map(id => <button key={id} type="button" onClick={() => onSelect(id)} className={cn("rounded border px-1.5 py-1 font-mono text-[8px]", selectedId === id ? "border-cyan-300/50 bg-cyan-300/10 text-cyan-100" : "border-white/10 bg-white/[0.025] text-slate-400")}>{id.split("-").slice(-1)[0]}</button>)}</div></div> : <p className="mt-3 text-[11px] leading-relaxed text-slate-500">Derived cuts expose selected nodes from the persistent deterministic merge tree.</p>}{energy ? <p className="mt-3 rounded border border-violet-300/20 bg-violet-300/[0.04] p-2 font-mono text-[10px] text-violet-100">Selected merge energy · ΔJ {energy.deltaJ.toFixed(5)} · ΔD {energy.deltaDistortion.toFixed(4)} · ΔR {energy.deltaRate.toFixed(4)}</p> : null}</section>
      <section className="rounded-xl border border-cyan-100/10 bg-slate-900/80 p-4"><div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-100"><Network className="h-4 w-4 text-cyan-300" /> Relational context</div>{selectedEntity ? <div className="space-y-3 text-xs"><div className="rounded border border-white/8 bg-black/20 p-3"><p className="font-mono text-[10px] text-cyan-200">{selectedEntity.type.replace("_", " ")} · L{selectedEntity.level}</p><p className="mt-1 break-all font-mono text-[9px] text-slate-500">{selectedEntity.id}</p><p className="mt-2 text-slate-400">Vector {selectedEntity.vector.dimension}D · {selectedEntity.vector.provenance}</p></div>{selectedRelationships.length ? <div className="overflow-hidden rounded border border-white/8"><table className="w-full text-left font-mono text-[9px]"><thead className="bg-white/[0.04] text-slate-500"><tr><th className="px-2 py-1.5">Type</th><th className="px-2 py-1.5">d′</th><th className="px-2 py-1.5">Color</th><th className="px-2 py-1.5">Conf.</th></tr></thead><tbody>{selectedRelationships.map((edge, index) => <tr key={`${edge.sourceId}-${edge.targetId}-${edge.primaryType}-${index}`} className="border-t border-white/5 text-slate-300"><td className="px-2 py-1.5 text-cyan-200">{edge.primaryType}</td><td className="px-2 py-1.5">{edge.normalizedDistance.toFixed(3)}</td><td className="px-2 py-1.5">{edge.colorSimilarity.toFixed(2)}</td><td className="px-2 py-1.5">{edge.confidence.toFixed(2)}</td></tr>)}</tbody></table></div> : <p className="text-slate-500">No sparse relationships are retained for this entity.</p>}</div> : <p className="text-xs leading-relaxed text-slate-500">Choose an entity in the hierarchy to inspect its exact geometry, vectors, and sparse graph neighborhood.</p>}</section>
    </div>
    <aside className="space-y-4">
      <section className="rounded-xl border border-emerald-200/10 bg-slate-900/80 p-4"><div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-100"><Sparkles className="h-4 w-4 text-emerald-300" /> Adaptive reconstruction</div><div className="grid grid-cols-3 gap-1.5">{(["constant", "parametric", "residual"] as const).map(mode => { const output = representation.reconstruction_metadata.outputs[mode]; return <div key={mode} className="rounded border border-white/8 bg-black/20 p-2"><p className="font-mono text-[8px] uppercase text-slate-500">{mode}</p><p className="mt-1 font-mono text-[11px] text-emerald-100">{output?.psnr?.toFixed(1) ?? "—"} dB</p><p className="font-mono text-[9px] text-slate-500">SSIM {output?.ssim?.toFixed(3) ?? "—"}</p></div>; })}</div>{model ? <p className="mt-3 rounded border border-white/8 bg-black/20 p-2 font-mono text-[10px] text-slate-300">{model.model.toUpperCase()} · {model.parameterCount} parameters · CIELAB MSE {model.mseLab.toExponential(2)}</p> : <p className="mt-3 text-[11px] text-slate-500">Select a micro-region for its local appearance-model evidence.</p>}</section>
      <section className="rounded-xl border border-cyan-100/10 bg-slate-900/80 p-4"><div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-100"><Layers3 className="h-4 w-4 text-cyan-300" /> Segmentation diagnostics</div>{diagnostics.length ? <div className="space-y-1.5">{diagnostics.map(item => <div key={item.strategy} className="grid grid-cols-[1fr_auto] gap-x-3 rounded border border-white/8 bg-black/20 px-2.5 py-2 font-mono text-[10px]"><span className="uppercase text-cyan-100">{item.strategy}</span><span className="text-slate-300">{item.entityCount} regions</span><span className="text-slate-500">requested {item.requestedSegments}</span><span className="text-emerald-200">edge {item.meanBoundaryEdgeStrength.toFixed(3)}</span></div>)}</div> : <p className="text-xs text-slate-500">No baseline segmentation diagnostics were retained.</p>}</section>
      <section className="rounded-xl border border-cyan-100/10 bg-slate-900/80 p-4"><div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-100"><Layers3 className="h-4 w-4 text-cyan-300" /> Cross-resolution correspondence</div><p className="font-mono text-[9px] uppercase tracking-wider text-cyan-200">{correspondence?.method ?? "No correspondence record"}</p>{selectedLink ? <p className="mt-2 rounded border border-cyan-200/10 bg-cyan-300/[0.03] p-2 font-mono text-[10px] text-slate-300">IoU {selectedLink.iou.toFixed(3)} · centroid {selectedLink.centroidDistance.toFixed(3)} · cost {selectedLink.cost.toFixed(3)}</p> : <p className="mt-2 text-[11px] text-slate-500">Select a matching entity to inspect correspondence evidence.</p>}</section>
      <section className="rounded-xl border border-cyan-100/10 bg-slate-900/80 p-4"><div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-100"><Activity className="h-4 w-4 text-cyan-300" /> Quality metrics</div><div className="grid grid-cols-2 gap-2">{[["PSNR", `${representation.metrics.psnr.toFixed(2)} dB`], ["SSIM", representation.metrics.ssim.toFixed(4)], ["Runtime", `${representation.metrics.processingTimeMs.toFixed(0)} ms`], ["Artifact", formatBytes(representation.metrics.representationBytes)]].map(([label, value]) => <div key={label} className="rounded border border-white/8 bg-black/20 p-2"><p className="font-mono text-[9px] uppercase text-slate-500">{label}</p><p className="mt-1 font-mono text-sm text-slate-200">{value}</p></div>)}</div></section>
      {representation.parameterSensitivity ? <section className="rounded-xl border border-violet-200/10 bg-slate-900/80 p-4"><div className="mb-3 flex items-center gap-2 text-sm font-semibold text-violet-100"><Activity className="h-4 w-4 text-violet-300" /> Parameter sensitivity</div><p className="text-[11px] leading-relaxed text-slate-500">{representation.parameterSensitivity.interpretation}</p><div className="mt-3 space-y-1.5">{representation.parameterSensitivity.records.map(record => <div key={record.label} className="grid grid-cols-[1fr_auto] gap-x-3 rounded border border-white/8 bg-black/20 px-2.5 py-2 font-mono text-[10px]"><span className="uppercase text-violet-100">{record.label.replace(/_/g, " ")}</span><span className="text-slate-300">{record.relationshipCount} edges</span><span className="text-slate-500">PSNR {record.quality.psnr.toFixed(2)}</span><span className="text-emerald-200">{formatBytes(record.artifactStorageBytes)}</span></div>)}</div>{parameterSensitivityUrl ? <a href={parameterSensitivityUrl} className="mt-3 block font-mono text-[10px] text-violet-100 underline decoration-violet-300/40 underline-offset-4">Download sensitivity report</a> : null}</section> : null}
      <section className="rounded-xl border border-cyan-100/10 bg-slate-900/80 p-4"><div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-100"><Boxes className="h-4 w-4 text-cyan-300" /> Scale consistency</div><p className="font-mono text-[10px] uppercase tracking-wider text-cyan-200">{representation.scale_consistency.status}</p><p className="mt-2 text-[11px] text-slate-500">Sparse graph timing {Number(representation.profiling.relationshipConstructionMs ?? 0).toFixed(1)} ms · {representation.relationships.length} relevant edges</p></section>
    </aside>
  </div>;
}
