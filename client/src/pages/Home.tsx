import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/_core/hooks/useAuth";
import { startLogin } from "@/const";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import {
  Activity,
  Boxes,
  ChevronDown,
  ChevronRight,
  Download,
  FileArchive,
  FileImage,
  FileJson2,
  ImageUp,
  Layers3,
  Loader2,
  Network,
  ScanSearch,
  Sparkles,
  TreePine,
  UploadCloud,
} from "lucide-react";
import React, { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

type Geometry = { boundingBox: number[]; centroid: number[]; area: number; perimeter: number; orientation: number; compactness: number };
type Entity = {
  id: string;
  type: string;
  level: number;
  scaleFactor: number;
  resolutionFactor?: number;
  geometry: Geometry;
  appearance: { meanRGB: number[]; brightness: number; varianceRGB: number[]; brightnessVariance?: number; meanGradient?: number; edgeDensity?: number; textureMeasure?: number };
  statistics: { memberPixelCount: number; complexity?: number; childAreaDistribution?: { min: number; max: number; mean: number; variance: number } };
  vector: { schema: string; dimension: number; values: number[]; provenance: string; aggregation: string; structured?: { geometry?: Record<string, number>; appearance?: Record<string, unknown>; structure?: Record<string, number>; shape?: Record<string, unknown> } };
  memberPixels?: number[][];
  children: string[];
  parentId: string | null;
  crossScaleMatchId?: string | null;
  lineage?: { operation: string; parents: string[] };
  appearanceModel?: { schema: string; model: "constant" | "affine" | "quadratic"; parameterCount: number; mseLab: number; selectionScore: number; boundaryResidual?: number; boundaryLeakage?: number; coefficients: number[][] };
};
type Relationship = {
  sourceId: string;
  targetId: string;
  distance: number;
  normalizedDistance: number;
  angle: number;
  sizeRatio: number;
  colorDistance: number;
  colorSimilarity: number;
  shapeSimilarity: number;
  textureSimilarity: number;
  brightnessDifference: number;
  brightnessRatio: number;
  normalizedDx: number;
  normalizedDy: number;
  boundaryContactRatio: number;
  containmentRatio: number;
  confidence: number;
  relationshipType: string[];
  primaryType: string;
  adjacent: boolean;
  overlapRatio: number;
  containment: string;
  affinity?: number;
  mergeAffinity?: number;
  logAreaRatio?: number;
  candidateSources?: string[];
};
type EdgeFilter = { relationshipTypes: string[]; adjacentOnly: boolean; minimumConfidence: number; maximumNormalizedDistance: number };
type Representation = {
  image: { width: number; height: number; sourceBytes: number };
  entities: Entity[];
  relationships: Relationship[];
  metrics: { mse: number; psnr: number; ssim: number; processingTimeMs: number; representationBytes: number; representationOverhead: number };
  hierarchy: { rootId: string };
  representation_version?: string;
  experiment?: { id: string; engineVersion: string; configHash: string; algorithm: string };
  feature_schema: { PixelVector: { fields: string[] }; RegionVector?: { fields: string[]; dimension: number }; EntityVector?: { schema: string; categories: string[] } };
  scales: Array<{ scaleFactor: number; entityCount: number; segmentationCharacteristics: { meanComplexity: number; actualSegments: number }; reconstructionError: { psnr: number; ssim: number } }>;
  reconstruction_metadata: { outputs: Record<string, { entityCount: number; mse: number; psnr: number; ssim: number; model?: string; artifactBytes?: number; residual?: { coverage: number; actualEncodedBytes?: number } }>; heuristicRateDistortion?: { basis: string; modes: Record<string, { distortion: number; estimatedBytes: number; normalizedRate: number; score: number }> }; rateDistortion?: Record<string, { distortion: number; estimatedBytes: number; normalizedRate: number; score: number }>; residual?: { coverage: number; actualEncodedBytes?: number; quantizationStep: number; artifactEmitted?: boolean } };
  scale_consistency: { status: string; centroidStability?: number; sizeRatioStability?: number; brightnessStability?: number; colorStability?: number; relationshipStability?: number };
  validity?: { connectivityScore: number; leafCoverage: number; parentAreaConservationError: number; hierarchyCycleCount: number; valid: boolean };
  graph_metadata?: { relationshipDensity: number; candidateSources: string[] };
  scale_correspondence?: { method: string; links: Array<{ sourceId: string; targetId: string; confidence: number; cost: number; iou: number; centroidDistance: number }> };
  segmentationDiagnostics?: Record<string, { strategy: string; entityCount: number; meanBoundaryEdgeStrength: number; requestedSegments: number }>;
  profiling: Record<string, number>;
  artifactStorage?: { basis: string; totalBytes: number; files: Record<string, number> };
  parameterSensitivity?: { schema: string; design: string; interpretation: string; records: Array<{ label: string; entityCountByType: Record<string, number>; relationshipCount: number; quality: { psnr: number; ssim: number; processingTimeMs: number }; artifactStorageBytes: number }> } | null;
};
type CacheRetentionTelemetry = { scope: "process_local_aggregate"; activeEntries: number; capacity: number; ttlMs: number; fillRatio: number; writes: number; lookups: number; hits: number; misses: number; hitRate: number; expiredEvictions: number; capacityEvictions: number; totalEvictions: number; processStartedAt: number; lastActivityAt: number | null };

const overlays = [
  { id: "none", label: "Native source" },
  { id: "brightness", label: "Brightness field" },
  { id: "edgeStrength", label: "Edge strength" },
  { id: "gradientX", label: "X gradient" },
  { id: "gradientY", label: "Y gradient" },
  { id: "complexity", label: "Complexity heatmap" },
  { id: "relationshipGraph", label: "Relationship graph" },
  { id: "normalizedDistanceGraph", label: "Normalized distance graph" },
  { id: "absolutePixelError", label: "Absolute error map" },
  { id: "parametricError", label: "Parametric error map" },
  { id: "perRegionError", label: "Per-region error" },
  { id: "residualEnergy", label: "Residual energy" },
] as const;

const availableScales = [1, 2, 4, 8];

export function filterRelationships(relationships: Relationship[], filters: EdgeFilter) {
  return relationships.filter(relationship => {
    const typeMatches = !filters.relationshipTypes.length || relationship.relationshipType.some(type => filters.relationshipTypes.includes(type));
    return typeMatches && (!filters.adjacentOnly || relationship.adjacent) && relationship.confidence >= filters.minimumConfidence && relationship.normalizedDistance <= filters.maximumNormalizedDistance;
  });
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

function getDataBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The image could not be read."));
    reader.onload = () => {
      const source = String(reader.result);
      resolve(source.split(",")[1] ?? "");
    };
    reader.readAsDataURL(file);
  });
}

function TreeNode({ entity, entities, selectedId, onSelect, depth = 0 }: { entity: Entity; entities: Map<string, Entity>; selectedId: string | null; onSelect: (id: string) => void; depth?: number }) {
  const [expanded, setExpanded] = useState(depth < 2);
  const children = entity.children.map(id => entities.get(id)).filter((item): item is Entity => Boolean(item));
  return (
    <div>
      <button
        type="button"
        onClick={() => onSelect(entity.id)}
        className={cn(
          "group flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
          selectedId === entity.id ? "bg-cyan-400/15 text-cyan-100 ring-1 ring-cyan-300/30" : "text-slate-300 hover:bg-white/5"
        )}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        {children.length ? (
          <span
            role="button"
            tabIndex={0}
            className="grid h-4 w-4 shrink-0 place-items-center text-slate-500"
            onClick={event => {
              event.stopPropagation();
              setExpanded(value => !value);
            }}
            onKeyDown={event => {
              if (event.key === "Enter" || event.key === " ") {
                event.stopPropagation();
                setExpanded(value => !value);
              }
            }}
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </span>
        ) : <span className="h-4 w-4 shrink-0" />}
        <span className="rounded bg-white/6 px-1.5 py-0.5 font-mono text-[10px] uppercase text-slate-400">L{entity.level}</span>
        <span className="truncate font-medium">{entity.type.replace("_", " ")}</span>
        <span className="ml-auto font-mono text-[10px] text-slate-500">{entity.geometry.area}</span>
      </button>
      {expanded && children.map(child => <TreeNode key={child.id} entity={child} entities={entities} selectedId={selectedId} onSelect={onSelect} depth={depth + 1} />)}
    </div>
  );
}

function GraphEdgeOverlay({ image, entities, relationships, distanceMode }: { image: Representation["image"]; entities: Map<string, Entity>; relationships: Relationship[]; distanceMode: boolean }) {
  if (!relationships.length) return <div role="status" className="pointer-events-none absolute inset-0 grid place-items-center bg-slate-950/55 p-6 text-center"><div className="rounded border border-amber-300/25 bg-slate-950/85 px-3 py-2"><p className="font-mono text-[10px] uppercase tracking-wider text-amber-200">No graph edges match</p><p className="mt-1 text-xs text-slate-300">Relax a type, confidence, adjacency, or distance filter.</p></div></div>;
  return <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${image.width} ${image.height}`} preserveAspectRatio="none" aria-label={`${relationships.length} filtered graph edges`}>
    {relationships.map(edge => {
      const source = entities.get(edge.sourceId);
      const target = entities.get(edge.targetId);
      if (!source || !target) return null;
      const color = distanceMode ? `hsl(${Math.round((1 - edge.normalizedDistance) * 135)}, 88%, 58%)` : edge.adjacent ? "#34d399" : "#fbbf24";
      return <line key={`${edge.sourceId}-${edge.targetId}`} x1={source.geometry.centroid[0]} y1={source.geometry.centroid[1]} x2={target.geometry.centroid[0]} y2={target.geometry.centroid[1]} stroke={color} strokeWidth={Math.max(0.7, edge.confidence * 2)} strokeOpacity={0.3 + edge.confidence * 0.65} />;
    })}
  </svg>;
}

function GraphEdgeFilterPanel({ representation, relationshipTypes, filteredCount, selectedTypes, setSelectedTypes, adjacentOnly, setAdjacentOnly, minimumConfidence, setMinimumConfidence, maximumNormalizedDistance, setMaximumNormalizedDistance }: { representation: Representation | null; relationshipTypes: string[]; filteredCount: number; selectedTypes: string[]; setSelectedTypes: React.Dispatch<React.SetStateAction<string[]>>; adjacentOnly: boolean; setAdjacentOnly: React.Dispatch<React.SetStateAction<boolean>>; minimumConfidence: number; setMinimumConfidence: React.Dispatch<React.SetStateAction<number>>; maximumNormalizedDistance: number; setMaximumNormalizedDistance: React.Dispatch<React.SetStateAction<number>> }) {
  const reset = () => { setSelectedTypes([]); setAdjacentOnly(false); setMinimumConfidence(0); setMaximumNormalizedDistance(1); };
  const clamp = (value: string, minimum: number) => Math.max(minimum, Math.min(1, Number(value) || 0));
  return <section className="rounded-xl border border-cyan-100/10 bg-slate-900/80 p-4" aria-labelledby="graph-edge-filter-title">
    <div className="mb-3 flex items-center justify-between gap-2"><div className="flex items-center gap-2 text-sm font-semibold text-slate-100"><Network className="h-4 w-4 text-cyan-300" /><span id="graph-edge-filter-title">Graph-edge filters</span></div>{representation ? <span className="font-mono text-[10px] text-cyan-200">{filteredCount}/{representation.relationships.length}</span> : null}</div>
    {representation ? <div className="space-y-4">
      <div><div className="mb-2 flex items-center justify-between"><Label className="text-xs text-slate-300">Relationship type</Label><span className="font-mono text-[9px] uppercase text-slate-500">{selectedTypes.length ? `${selectedTypes.length} selected` : "all types"}</span></div><div className="flex flex-wrap gap-1.5">{relationshipTypes.map(type => <Button key={type} type="button" variant="outline" size="sm" aria-pressed={selectedTypes.includes(type)} onClick={() => setSelectedTypes(current => current.includes(type) ? current.filter(item => item !== type) : [...current, type])} className={cn("h-7 border-white/10 bg-black/20 px-2 font-mono text-[9px] text-slate-500", selectedTypes.includes(type) && "border-cyan-300/45 bg-cyan-300/10 text-cyan-100")}>{type.replaceAll("_", " ")}</Button>)}</div></div>
      <div className="flex items-center justify-between rounded border border-white/8 bg-black/20 px-2.5 py-2"><span className="text-xs text-slate-300">Adjacent only</span><Button type="button" variant="outline" size="sm" aria-pressed={adjacentOnly} onClick={() => setAdjacentOnly(value => !value)} className={cn("h-6 border-white/10 bg-transparent px-2 font-mono text-[9px]", adjacentOnly ? "border-emerald-300/40 bg-emerald-300/10 text-emerald-100" : "text-slate-500")}>{adjacentOnly ? "ON" : "OFF"}</Button></div>
      <div><div className="mb-2 flex items-center justify-between gap-2"><Label className="text-xs text-slate-300">Minimum confidence</Label><Input aria-label="Minimum confidence" type="number" min="0" max="1" step="0.05" value={minimumConfidence} onChange={event => setMinimumConfidence(clamp(event.target.value, 0))} className="h-7 w-16 border-white/10 bg-black/20 px-1.5 text-right font-mono text-xs text-cyan-200" /></div><Slider value={[minimumConfidence]} onValueChange={value => setMinimumConfidence(value[0] ?? 0)} min={0} max={1} step={0.05} /></div>
      <div><div className="mb-2 flex items-center justify-between gap-2"><Label className="text-xs text-slate-300">Maximum normalized distance</Label><Input aria-label="Maximum normalized distance" type="number" min="0.05" max="1" step="0.05" value={maximumNormalizedDistance} onChange={event => setMaximumNormalizedDistance(clamp(event.target.value, 0.05))} className="h-7 w-16 border-white/10 bg-black/20 px-1.5 text-right font-mono text-xs text-cyan-200" /></div><Slider value={[maximumNormalizedDistance]} onValueChange={value => setMaximumNormalizedDistance(value[0] ?? 1)} min={0.05} max={1} step={0.05} /></div>
      {filteredCount === 0 ? <p className="rounded border border-amber-300/20 bg-amber-300/[0.04] p-2 text-xs text-amber-100">No edges match the active filters. Reset or relax a threshold to restore graph and inspector edges.</p> : null}
      <Button type="button" variant="outline" size="sm" onClick={reset} className="h-8 w-full border-white/10 bg-black/20 font-mono text-[10px] text-slate-400 hover:bg-white/5">Reset edge filters</Button>
    </div> : <p className="rounded border border-dashed border-white/10 p-3 text-xs leading-relaxed text-slate-500">Run an analysis to narrow sparse graph edges by relationship type, adjacency, confidence, or normalized distance.</p>}
  </section>;
}

function RuntimeTelemetryPanel({ telemetry, isLoading }: { telemetry: CacheRetentionTelemetry | null | undefined; isLoading: boolean }) {
  const capacityWarning = Boolean(telemetry && (telemetry.fillRatio >= 0.8 || telemetry.capacityEvictions > 0));
  return <section className={cn("rounded-xl border bg-slate-900/80 p-4", capacityWarning ? "border-amber-300/35" : "border-cyan-100/10")}><div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-100"><Activity className={cn("h-4 w-4", capacityWarning ? "text-amber-300" : "text-cyan-300")} /> Runtime telemetry</div>{isLoading ? <p className="text-xs text-slate-500">Loading aggregate cache telemetry…</p> : telemetry ? <div className="space-y-3 text-xs"><div className="grid grid-cols-2 gap-2"><div className="rounded border border-white/8 bg-black/20 p-2"><p className="font-mono text-[9px] uppercase text-slate-500">Active cache</p><p className="mt-1 font-mono text-sm text-cyan-100">{telemetry.activeEntries} / {telemetry.capacity}</p><p className="font-mono text-[9px] text-slate-500">{(telemetry.fillRatio * 100).toFixed(0)}% full</p></div><div className="rounded border border-white/8 bg-black/20 p-2"><p className="font-mono text-[9px] uppercase text-slate-500">Hit rate</p><p className="mt-1 font-mono text-sm text-emerald-100">{(telemetry.hitRate * 100).toFixed(1)}%</p><p className="font-mono text-[9px] text-slate-500">{telemetry.hits} hit · {telemetry.misses} miss</p></div><div className="rounded border border-white/8 bg-black/20 p-2"><p className="font-mono text-[9px] uppercase text-slate-500">TTL</p><p className="mt-1 font-mono text-sm text-slate-200">{(telemetry.ttlMs / 60_000).toFixed(0)} min</p><p className="font-mono text-[9px] text-slate-500">{telemetry.writes} writes</p></div><div className="rounded border border-white/8 bg-black/20 p-2"><p className="font-mono text-[9px] uppercase text-slate-500">Evictions</p><p className={cn("mt-1 font-mono text-sm", telemetry.totalEvictions ? "text-amber-100" : "text-slate-200")}>{telemetry.totalEvictions}</p><p className="font-mono text-[9px] text-slate-500">TTL {telemetry.expiredEvictions} · cap {telemetry.capacityEvictions}</p></div></div>{capacityWarning ? <p className="rounded border border-amber-300/20 bg-amber-300/[0.05] p-2 text-[11px] leading-relaxed text-amber-100">Cache capacity pressure is present. Review retention settings or expected concurrent analysis volume.</p> : <p className="text-[11px] leading-relaxed text-slate-500">Aggregate, process-local counters only. No inputs, result IDs, artifact URLs, or image data are retained here.</p>}<p className="font-mono text-[9px] text-slate-600">Last activity {telemetry.lastActivityAt ? new Date(telemetry.lastActivityAt).toLocaleTimeString() : "none"} · resets on server restart</p></div> : <p className="text-xs leading-relaxed text-slate-500">Cache telemetry is unavailable until the server initializes its completed-result cache.</p>}</section>;
}

function V03InspectionPanels({ representation, selectedEntity }: { representation: Representation | null; selectedEntity: Entity | null }) {
  const correspondence = representation?.scale_correspondence;
  const selectedLink = correspondence?.links.find(link => link.sourceId === selectedEntity?.id || link.targetId === selectedEntity?.id);
  return <><section className="rounded-xl border border-cyan-100/10 bg-slate-900/80 p-4"><div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-100"><TreePine className="h-4 w-4 text-cyan-300" /> Merge lineage</div>{selectedEntity ? <div className="space-y-2 text-xs"><div className="rounded border border-white/8 bg-black/20 p-3"><p className="font-mono text-[9px] uppercase tracking-wider text-slate-500">Operation</p><p className="mt-1 font-mono text-sm text-cyan-100">{selectedEntity.lineage?.operation ?? "legacy"}</p><p className="mt-2 font-mono text-[9px] uppercase tracking-wider text-slate-500">Derived from</p><p className="mt-1 break-all font-mono text-[10px] text-slate-400">{selectedEntity.lineage?.parents.length ? selectedEntity.lineage.parents.join(", ") : "initial segmentation"}</p></div><p className="text-[11px] leading-relaxed text-slate-500">Graph-driven groups retain child lineage while canonical geometry is recomputed from their union mask.</p></div> : <p className="text-xs leading-relaxed text-slate-500">Select an entity to inspect whether it was segmented, carried, merged, or established as the image root.</p>}</section><section className="rounded-xl border border-cyan-100/10 bg-slate-900/80 p-4"><div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-100"><Layers3 className="h-4 w-4 text-cyan-300" /> Cross-resolution correspondence</div>{representation ? <div className="space-y-2 text-xs"><p className="font-mono text-[9px] uppercase tracking-wider text-cyan-200">{correspondence?.method ?? "No correspondence record"}</p><div className="grid grid-cols-2 gap-2"><div className="rounded border border-white/8 bg-black/20 p-2"><p className="font-mono text-[9px] uppercase text-slate-500">Matches</p><p className="mt-1 font-mono text-sm text-slate-200">{correspondence?.links.length ?? 0}</p></div><div className="rounded border border-white/8 bg-black/20 p-2"><p className="font-mono text-[9px] uppercase text-slate-500">Selected conf.</p><p className="mt-1 font-mono text-sm text-slate-200">{selectedLink ? selectedLink.confidence.toFixed(3) : "—"}</p></div></div>{selectedLink ? <p className="rounded border border-cyan-200/10 bg-cyan-300/[0.03] p-2 font-mono text-[10px] text-slate-300">IoU {selectedLink.iou.toFixed(3)} · centroid {selectedLink.centroidDistance.toFixed(3)} · cost {selectedLink.cost.toFixed(3)}</p> : <p className="text-[11px] leading-relaxed text-slate-500">Select a native-resolution micro-region to inspect its matched coarser-resolution correspondence.</p>}</div> : <p className="text-xs leading-relaxed text-slate-500">Matches use a minimum-cost assignment across IoU, normalized centroid position, appearance, and area.</p>}</section></>;
}

/**
 * All content in this page are only for example, replace with your own feature implementation
 * When building pages, remember your instructions in Frontend Workflow, Frontend Best Practices, Design Guide and Common Pitfalls
 */
function V04ReconstructionPanel({ representation, selectedEntity }: { representation: Representation | null; selectedEntity: Entity | null }) {
  const model = selectedEntity?.appearanceModel;
  const heuristic = representation?.reconstruction_metadata.heuristicRateDistortion;
  const rates = heuristic?.modes ?? representation?.reconstruction_metadata.rateDistortion;
  const storage = representation?.artifactStorage;
  const boundaryResidual = model?.boundaryResidual ?? model?.boundaryLeakage;
  return <section className="rounded-xl border border-emerald-200/10 bg-slate-900/80 p-4"><div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-100"><Sparkles className="h-4 w-4 text-emerald-300" /> Adaptive reconstruction</div>{representation ? <div className="space-y-3 text-xs"><div className="grid grid-cols-3 gap-1.5">{(["constant", "parametric", "residual"] as const).map(mode => { const item = representation.reconstruction_metadata.outputs[mode]; return <div key={mode} className="rounded border border-white/8 bg-black/20 p-2"><p className="font-mono text-[8px] uppercase text-slate-500">{mode}</p><p className="mt-1 font-mono text-[11px] text-emerald-100">{item?.psnr?.toFixed(1) ?? "—"} dB</p><p className="font-mono text-[9px] text-slate-500">SSIM {item?.ssim?.toFixed(3) ?? "—"}</p></div>;})}</div><div className="rounded border border-white/8 bg-black/20 p-2.5"><p className="font-mono text-[9px] uppercase tracking-wider text-slate-500">Selected entity model</p>{model ? <><p className="mt-1 font-mono text-sm text-emerald-100">{model.model.toUpperCase()} · {model.parameterCount} parameters</p><p className="mt-1 font-mono text-[10px] text-slate-400">Lab MSE {model.mseLab.toExponential(2)} · boundary residual {(boundaryResidual ?? 0).toExponential(2)}</p></> : <p className="mt-1 text-xs text-slate-500">Select a micro-region to inspect its local appearance model.</p>}</div>{rates ? <div><p className="mb-1 font-mono text-[9px] uppercase tracking-wider text-slate-500">Heuristic model score</p><p className="mb-1 text-[10px] text-slate-500">Parameter-payload estimate; not serialized storage.</p><div className="space-y-1">{Object.entries(rates).map(([mode, value]) => <div key={mode} className="flex justify-between rounded border border-white/6 bg-black/15 px-2 py-1 font-mono text-[9px]"><span className="text-slate-400">{mode}</span><span className="text-cyan-200">{value.score.toFixed(4)} · {formatBytes(value.estimatedBytes)}</span></div>)}</div></div> : null}{storage ? <div className="rounded border border-white/8 bg-black/20 p-2.5"><p className="font-mono text-[9px] uppercase tracking-wider text-slate-500">Actual emitted storage</p><p className="mt-1 font-mono text-sm text-violet-100">{formatBytes(storage.totalBytes)}</p><p className="mt-1 font-mono text-[9px] text-slate-500">JSON {formatBytes(storage.files["representation.json"] ?? 0)} · features {formatBytes(storage.files["features.npz"] ?? 0)} · residuals {formatBytes(storage.files["residuals.npz"] ?? 0)}</p></div> : null}</div> : <p className="text-xs leading-relaxed text-slate-500">Run a v0.5 analysis to compare constant, adaptive-Lab, and bounded-residual outputs.</p>}</section>;
}

function SegmentationDiagnosticsPanel({ representation }: { representation: Representation | null }) {
  const diagnostics = Object.values(representation?.segmentationDiagnostics ?? {});
  return <section className="rounded-xl border border-cyan-100/10 bg-slate-900/80 p-4"><div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-100"><Layers3 className="h-4 w-4 text-cyan-300" /> Segmentation diagnostics</div>{representation ? diagnostics.length ? <div className="space-y-1.5"><p className="mb-2 text-[11px] leading-relaxed text-slate-500">The server measures baseline partitioning without moving image processing into the browser.</p>{diagnostics.map(item => <div key={item.strategy} className="grid grid-cols-[1fr_auto] gap-x-3 rounded border border-white/8 bg-black/20 px-2.5 py-2 font-mono text-[10px]"><span className="uppercase tracking-wider text-cyan-100">{item.strategy}</span><span className="text-slate-300">{item.entityCount} regions</span><span className="text-slate-500">requested {item.requestedSegments}</span><span className="text-emerald-200">edge {item.meanBoundaryEdgeStrength.toFixed(3)}</span></div>)}</div> : <p className="text-xs leading-relaxed text-slate-500">Enable baseline comparison before analysis to report SLIC, watershed, and Felzenszwalb partition diagnostics.</p> : <p className="text-xs leading-relaxed text-slate-500">Segmentation diagnostics become available after a v0.5 analysis.</p>}</section>;
}

export default function Home() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [file, setFile] = useState<File | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const sourceUrlRef = useRef<string | null>(null);
  const [representation, setRepresentation] = useState<Representation | null>(null);
  const [artifacts, setArtifacts] = useState<{ representationJson: string; featuresNpz: string; residualsNpz?: string; parameterSensitivity?: string; reconstructedPng: string; svg: string; overlays: Record<string, string>; reconstructions: Record<string, string>; errors: Record<string, string> } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedOverlay, setSelectedOverlay] = useState<(typeof overlays)[number]["id"]>("none");
  const [scaleLevels, setScaleLevels] = useState<number[]>([1, 2, 4, 8]);
  const [maxFileSizeMb, setMaxFileSizeMb] = useState(8);
  const [slicSegments, setSlicSegments] = useState(72);
  const [compactness, setCompactness] = useState(10);
  const [segmentationStrategy, setSegmentationStrategy] = useState<"slic" | "watershed" | "felzenszwalb">("slic");
  const [reconstructionProfile, setReconstructionProfile] = useState<"fast" | "balanced" | "accurate">("balanced");
  const [residualEnabled, setResidualEnabled] = useState(true);
  const [residualBudgetKb, setResidualBudgetKb] = useState(192);
  const [runParameterSensitivity, setRunParameterSensitivity] = useState(false);
  const [reconstructionLevel, setReconstructionLevel] = useState<string>("residual");
  const [selectedRelationshipTypes, setSelectedRelationshipTypes] = useState<string[]>([]);
  const [adjacentOnly, setAdjacentOnly] = useState(false);
  const [minimumConfidence, setMinimumConfidence] = useState(0);
  const [maximumNormalizedDistance, setMaximumNormalizedDistance] = useState(1);
  const processMutation = trpc.imageAnalysis.process.useMutation();
  const telemetryQuery = trpc.imageAnalysis.cacheTelemetry.useQuery(undefined, { enabled: isAdmin, refetchInterval: isAdmin ? 15_000 : false, refetchOnWindowFocus: false });

  const entities = useMemo(() => new Map((representation?.entities ?? []).map(entity => [entity.id, entity])), [representation]);
  const selectedEntity = selectedId ? entities.get(selectedId) ?? null : null;
  const relationshipTypes = useMemo(() => Array.from(new Set((representation?.relationships ?? []).flatMap(relationship => relationship.relationshipType))).sort(), [representation]);
  const filteredRelationships = useMemo(() => filterRelationships(representation?.relationships ?? [], { relationshipTypes: selectedRelationshipTypes, adjacentOnly, minimumConfidence, maximumNormalizedDistance }), [representation, selectedRelationshipTypes, adjacentOnly, minimumConfidence, maximumNormalizedDistance]);
  const entityRelationships = useMemo(
    () => filteredRelationships.filter(relationship => relationship.sourceId === selectedId || relationship.targetId === selectedId),
    [filteredRelationships, selectedId]
  );
  const root = representation ? entities.get(representation.hierarchy.rootId) ?? null : null;
  const relationshipOverlayActive = selectedOverlay === "relationshipGraph" || selectedOverlay === "normalizedDistanceGraph";
  const overlayUrl = selectedOverlay === "none" || relationshipOverlayActive ? null : selectedOverlay === "absolutePixelError" ? artifacts?.errors.absolutePixelError ?? null : selectedOverlay === "parametricError" ? artifacts?.errors.parametricError ?? null : selectedOverlay === "perRegionError" ? artifacts?.errors.perRegionError ?? null : selectedOverlay === "residualEnergy" ? artifacts?.errors.residualEnergy ?? null : artifacts?.overlays[selectedOverlay] ?? null;
  const reconstructionUrl = artifacts?.reconstructions[reconstructionLevel] ?? artifacts?.reconstructedPng ?? null;
  const parentChain = useMemo(() => {
    const chain: Entity[] = [];
    let current = selectedEntity?.parentId ? entities.get(selectedEntity.parentId) ?? null : null;
    while (current) { chain.push(current); current = current.parentId ? entities.get(current.parentId) ?? null : null; }
    return chain;
  }, [entities, selectedEntity]);
  const siblings = useMemo(() => selectedEntity?.parentId ? (entities.get(selectedEntity.parentId)?.children ?? []).filter(id => id !== selectedEntity.id) : [], [entities, selectedEntity]);

  useEffect(() => () => {
    if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
  }, []);

  function changeFile(event: ChangeEvent<HTMLInputElement>) {
    const incoming = event.target.files?.[0] ?? null;
    if (!incoming) return;
    if (!new Set(["image/png", "image/jpeg", "image/webp"]).has(incoming.type)) {
      toast.error("Upload a PNG, JPEG, or WebP image.");
      return;
    }
    if (incoming.size > maxFileSizeMb * 1024 * 1024) {
      toast.error(`The selected image is larger than the configured ${maxFileSizeMb} MB limit.`);
      return;
    }
    setFile(incoming);
    setRepresentation(null);
    setArtifacts(null);
    setSelectedId(null);
    setSelectedRelationshipTypes([]);
    setAdjacentOnly(false);
    setMinimumConfidence(0);
    setMaximumNormalizedDistance(1);
    if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
    const nextSourceUrl = URL.createObjectURL(incoming);
    sourceUrlRef.current = nextSourceUrl;
    setSourceUrl(nextSourceUrl);
  }

  async function runAnalysis() {
    if (!user) {
      toast.error("Sign in to run and inspect a private image analysis.");
      startLogin();
      return;
    }
    if (!file) {
      toast.error("Select an image before starting analysis.");
      return;
    }
    if (!scaleLevels.length) {
      toast.error("Choose at least one analysis scale.");
      return;
    }
    try {
      const result = await processMutation.mutateAsync({
        fileName: file.name,
        mimeType: file.type as "image/png" | "image/jpeg" | "image/webp",
        dataBase64: await getDataBase64(file),
        config: {
          maxFileSizeBytes: maxFileSizeMb * 1024 * 1024,
          maxImagePixels: 786432,
          groupingMethod: segmentationStrategy,
          segmentationStrategy,
          hierarchyMethod: "iterative_graph_agglomerative",
          maxAgglomerationIterations: 2048,
          scaleLevels,
          slicSegments,
          slicCompactness: compactness,
          minimumRegionPixels: 12,
          runScaleConsistency: true,
          maxConsistencyPixels: 786432,
          crossScaleOverlapThreshold: 0.20,
          graphK: 3,
          mergeThreshold: 0.58,
          edgeBarrierThreshold: 0.70,
          maxEntityAreaFraction: 0.72,
          complexityMergePenalty: 0.35,
          reconstructionProfile,
          appearanceModelCandidates: reconstructionProfile === "fast" ? ["constant", "affine"] : ["constant", "affine", "quadratic"],
          modelPenalty: reconstructionProfile === "accurate" ? 0.00025 : reconstructionProfile === "fast" ? 0.0008 : 0.00045,
          boundaryLeakagePenalty: 0.00015,
          residualEnabled,
          residualQuantization: reconstructionProfile === "accurate" ? 2 : reconstructionProfile === "fast" ? 8 : 4,
          residualBudgetBytes: residualEnabled ? residualBudgetKb * 1024 : 0,
          rateDistortionLambda: 0.0015,
          compareSegmentationBaselines: reconstructionProfile === "accurate",
          runParameterSensitivity,
          sensitivityVariantLimit: 5,
        },
      });
      const parsed = result.representation as unknown as Representation;
      setRepresentation(parsed);
      setArtifacts(result.artifactUrls);
      setSelectedId(parsed.entities.find(entity => entity.type === "micro_region")?.id ?? parsed.hierarchy.rootId);
      setSelectedRelationshipTypes([]);
      setAdjacentOnly(false);
      setMinimumConfidence(0);
      setMaximumNormalizedDistance(1);
      toast.success("Graph-driven relational entity analysis completed.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The analysis could not be completed.");
    }
  }

  function toggleScale(scale: number) {
    setScaleLevels(current => current.includes(scale) ? current.filter(value => value !== scale) : [...current, scale].sort((a, b) => a - b));
  }

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_80%_0%,rgba(21,185,207,0.10),transparent_30%)]">
      <header className="border-b border-cyan-200/10 bg-slate-950/70 px-4 py-3 backdrop-blur-xl sm:px-6">
        <div className="mx-auto flex max-w-[1680px] items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl border border-cyan-200/20 bg-cyan-300/10 text-cyan-200 shadow-[0_0_28px_rgba(34,211,238,0.13)]">
              <ScanSearch className="h-5 w-5" />
            </div>
            <div>
              <p className="font-mono text-[10px] font-medium uppercase tracking-[0.24em] text-cyan-300">Scientific visual computing</p>
              <h1 className="text-base font-semibold tracking-tight text-slate-100 sm:text-lg">Hierarchical Image Workbench</h1>
            </div>
          </div>
          <div className="hidden items-center gap-3 text-right sm:flex">
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-slate-500">analysis profile</div>
            <div className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-3 py-1 font-mono text-[10px] text-cyan-200">DETERMINISTIC · SLIC + GRAPH</div>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-[1680px] gap-4 p-4 sm:p-6 xl:grid-cols-[290px_minmax(0,1fr)_330px]">
        <aside className="space-y-4 xl:sticky xl:top-4 xl:self-start">
          <section className="rounded-xl border border-cyan-100/10 bg-slate-900/80 p-4 shadow-2xl shadow-slate-950/20">
            <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-slate-100"><UploadCloud className="h-4 w-4 text-cyan-300" /> Source image</div>
            <label className="group flex min-h-36 cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-cyan-300/25 bg-cyan-300/[0.035] px-4 text-center transition-colors hover:border-cyan-300/60 hover:bg-cyan-300/[0.08]">
              <ImageUp className="mb-2 h-6 w-6 text-cyan-300 transition-transform group-hover:-translate-y-0.5" />
              <span className="text-sm font-medium text-slate-200">Drop an image or browse</span>
              <span className="mt-1 font-mono text-[10px] uppercase tracking-wider text-slate-500">PNG · JPEG · WebP</span>
              <Input className="sr-only" type="file" accept="image/png,image/jpeg,image/webp" onChange={changeFile} />
            </label>
            {file ? <div className="mt-3 rounded-md border border-white/8 bg-black/20 px-3 py-2 text-xs"><p className="truncate font-medium text-slate-200">{file.name}</p><p className="mt-0.5 font-mono text-[10px] text-slate-500">{formatBytes(file.size)} · {file.type.replace("image/", "").toUpperCase()}</p></div> : null}
          </section>

          <section className="rounded-xl border border-cyan-100/10 bg-slate-900/80 p-4">
            <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-slate-100"><Activity className="h-4 w-4 text-cyan-300" /> Processing controls</div>
            <div className="space-y-5">
              <div>
                <div className="mb-2 flex justify-between"><Label className="text-xs text-slate-300">Upload limit</Label><span className="font-mono text-xs text-cyan-200">{maxFileSizeMb} MB</span></div>
                <Slider value={[maxFileSizeMb]} onValueChange={value => setMaxFileSizeMb(value[0] ?? 8)} min={1} max={8} step={1} />
              </div>
              <div>
                <div className="mb-2 flex justify-between"><Label className="text-xs text-slate-300">SLIC segments</Label><span className="font-mono text-xs text-cyan-200">{slicSegments}</span></div>
                <Slider value={[slicSegments]} onValueChange={value => setSlicSegments(value[0] ?? 72)} min={24} max={144} step={8} />
              </div>
              <div>
                <div className="mb-2 flex justify-between"><Label className="text-xs text-slate-300">Spatial compactness</Label><span className="font-mono text-xs text-cyan-200">{compactness}</span></div>
                <Slider value={[compactness]} onValueChange={value => setCompactness(value[0] ?? 10)} min={2} max={30} step={1} />
              </div>
              <div>
                <Label className="mb-2 block text-xs text-slate-300">Multi-scale levels</Label>
                <div className="grid grid-cols-4 gap-1.5">
                  {availableScales.map(scale => <Button key={scale} type="button" variant="outline" size="sm" onClick={() => toggleScale(scale)} className={cn("border-white/10 bg-white/[0.025] font-mono text-xs text-slate-400 hover:bg-white/10", scaleLevels.includes(scale) && "border-cyan-300/50 bg-cyan-300/10 text-cyan-100")}>{scale}×</Button>)}
                </div>
              </div>
              <div><Label className="mb-2 block text-xs text-slate-300">Segmentation baseline</Label><div className="grid grid-cols-3 gap-1">{(["slic", "watershed", "felzenszwalb"] as const).map(strategy => <Button key={strategy} type="button" variant="outline" size="sm" onClick={() => setSegmentationStrategy(strategy)} className={cn("h-7 border-white/10 bg-black/20 px-1 font-mono text-[9px] text-slate-500", segmentationStrategy === strategy && "border-cyan-300/45 bg-cyan-300/10 text-cyan-100")}>{strategy === "felzenszwalb" ? "GRAPH" : strategy.toUpperCase()}</Button>)}</div></div>
              <div><Label className="mb-2 block text-xs text-slate-300">Reconstruction profile</Label><div className="grid grid-cols-3 gap-1">{(["fast", "balanced", "accurate"] as const).map(profile => <Button key={profile} type="button" variant="outline" size="sm" onClick={() => setReconstructionProfile(profile)} className={cn("h-7 border-white/10 bg-black/20 px-1 font-mono text-[9px] text-slate-500", reconstructionProfile === profile && "border-emerald-300/45 bg-emerald-300/10 text-emerald-100")}>{profile.toUpperCase()}</Button>)}</div></div>
              <div><div className="mb-2 flex items-center justify-between"><Label className="text-xs text-slate-300">Residual detail</Label><Button type="button" variant="outline" size="sm" onClick={() => setResidualEnabled(value => !value)} className={cn("h-6 border-white/10 bg-black/20 px-2 font-mono text-[9px]", residualEnabled ? "border-emerald-300/40 bg-emerald-300/10 text-emerald-100" : "text-slate-500")}>{residualEnabled ? "ON" : "OFF"}</Button></div><div className={cn(!residualEnabled && "opacity-40")}><div className="mb-1 flex justify-between font-mono text-[9px] text-slate-500"><span>Residual budget</span><span>{residualBudgetKb} KB</span></div><Slider value={[residualBudgetKb]} onValueChange={value => setResidualBudgetKb(value[0] ?? 192)} min={0} max={512} step={16} disabled={!residualEnabled} /></div></div>
              <div><div className="mb-1 flex items-center justify-between"><Label className="text-xs text-slate-300">Sensitivity evidence</Label><Button type="button" variant="outline" size="sm" onClick={() => setRunParameterSensitivity(value => !value)} className={cn("h-6 border-white/10 bg-black/20 px-2 font-mono text-[9px]", runParameterSensitivity ? "border-violet-300/40 bg-violet-300/10 text-violet-100" : "text-slate-500")}>{runParameterSensitivity ? "5 VARIANTS" : "OFF"}</Button></div><p className="text-[10px] leading-relaxed text-slate-500">Runs a bounded server-side parameter sweep for internal dependence evidence, not semantic invariance.</p></div>
              <Button className="h-10 w-full bg-cyan-300 text-slate-950 hover:bg-cyan-200" onClick={runAnalysis} disabled={!file || processMutation.isPending}>
                {processMutation.isPending ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Building hierarchy…</> : <><Sparkles className="mr-2 h-4 w-4" /> Run analysis</>}
              </Button>
            </div>
          </section>

          <section className="rounded-xl border border-cyan-100/10 bg-slate-900/80 p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-100"><Layers3 className="h-4 w-4 text-cyan-300" /> Feature overlay</div>
            <div className="space-y-1">
              {overlays.map(overlay => <button type="button" key={overlay.id} onClick={() => setSelectedOverlay(overlay.id)} disabled={overlay.id !== "none" && !artifacts} className={cn("flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-xs transition-colors", selectedOverlay === overlay.id ? "bg-cyan-300/10 text-cyan-100" : "text-slate-400 hover:bg-white/5 hover:text-slate-200", !artifacts && overlay.id !== "none" && "cursor-not-allowed opacity-40")}><span>{overlay.label}</span>{selectedOverlay === overlay.id ? <span className="h-1.5 w-1.5 rounded-full bg-cyan-300" /> : null}</button>)}
            </div>
          </section>
          <section className="rounded-xl border border-emerald-200/10 bg-slate-900/80 p-4"><div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-100"><Sparkles className="h-4 w-4 text-emerald-300" /> Advanced outputs</div><div className="grid grid-cols-3 gap-1.5">{(["constant", "parametric", "residual"] as const).map(mode => <Button key={mode} type="button" variant="outline" size="sm" disabled={!artifacts} onClick={() => setReconstructionLevel(mode)} className={cn("h-8 border-white/10 bg-black/20 px-1 font-mono text-[9px] text-slate-500", reconstructionLevel === mode && "border-emerald-300/45 bg-emerald-300/10 text-emerald-100")}>{mode === "constant" ? "BASE" : mode === "parametric" ? "MODEL" : "DETAIL"}</Button>)}</div><p className="mt-2 text-[11px] leading-relaxed text-slate-500">Compare flat region colour, local Lab models, and the bounded residual reconstruction.</p>{artifacts?.residualsNpz ? <a href={artifacts.residualsNpz} className="mt-3 flex items-center gap-2 rounded border border-emerald-300/15 bg-emerald-300/[0.04] px-2 py-2 font-mono text-[10px] text-emerald-100 hover:bg-emerald-300/[0.09]"><FileArchive className="h-3.5 w-3.5" /> Download residual NPZ <Download className="ml-auto h-3 w-3" /></a> : null}</section>
          <GraphEdgeFilterPanel representation={representation} relationshipTypes={relationshipTypes} filteredCount={filteredRelationships.length} selectedTypes={selectedRelationshipTypes} setSelectedTypes={setSelectedRelationshipTypes} adjacentOnly={adjacentOnly} setAdjacentOnly={setAdjacentOnly} minimumConfidence={minimumConfidence} setMinimumConfidence={setMinimumConfidence} maximumNormalizedDistance={maximumNormalizedDistance} setMaximumNormalizedDistance={setMaximumNormalizedDistance} />
        </aside>

        <section className="min-w-0 space-y-4">
          <section className="overflow-hidden rounded-xl border border-cyan-100/10 bg-slate-900/80 shadow-2xl shadow-slate-950/20">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/8 px-4 py-3"><div><h2 className="text-sm font-semibold text-slate-100">Comparative reconstruction</h2><p className="mt-0.5 font-mono text-[10px] uppercase tracking-widest text-slate-500">Source · feature field · hierarchical decoding</p></div><div className="flex flex-wrap items-center gap-1"><div className="mr-1 hidden font-mono text-[9px] uppercase tracking-wider text-slate-600 sm:block">decode</div>{(["level1", "level2", "level3", "level4", "full"] as const).map(level => <Button key={level} type="button" variant="outline" size="sm" disabled={!artifacts} onClick={() => setReconstructionLevel(level)} className={cn("h-7 border-white/10 bg-black/20 px-2 font-mono text-[9px] text-slate-500", reconstructionLevel === level && "border-emerald-300/40 bg-emerald-300/10 text-emerald-100")}>{level === "full" ? "FULL" : level.toUpperCase()}</Button>)}<div className="ml-1 rounded border border-white/10 bg-black/20 px-2 py-1 font-mono text-[10px] text-slate-400">{representation ? `${representation.image.width} × ${representation.image.height}` : "WAITING"}</div></div></div>
            <div className="grid gap-px bg-white/10 md:grid-cols-2">
              <div className="relative min-h-72 bg-slate-950 p-3"><div className="mb-2 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.16em] text-slate-500"><span>Original / overlay</span><span className="text-cyan-300">{selectedOverlay === "none" ? "RGB" : selectedOverlay}</span></div>{sourceUrl ? <div className="relative overflow-hidden rounded border border-white/8 bg-black"><img src={sourceUrl} alt="Uploaded source" className="max-h-[480px] w-full object-contain" />{relationshipOverlayActive && representation ? <><GraphEdgeOverlay image={representation.image} entities={entities} relationships={filteredRelationships} distanceMode={selectedOverlay === "normalizedDistanceGraph"} /><div className="absolute bottom-2 left-2 rounded border border-cyan-300/25 bg-slate-950/80 px-2 py-1 font-mono text-[9px] uppercase tracking-wider text-cyan-100">{filteredRelationships.length} filtered edges</div></> : overlayUrl ? <img src={overlayUrl} alt="Selected feature overlay" className="absolute inset-0 h-full w-full object-contain opacity-60 mix-blend-screen" /> : null}</div> : <div className="relative grid h-72 place-items-center overflow-hidden rounded border border-dashed border-cyan-300/15 bg-[linear-gradient(rgba(34,211,238,0.035)_1px,transparent_1px),linear-gradient(90deg,rgba(34,211,238,0.035)_1px,transparent_1px)] bg-[size:24px_24px] text-center"><div className="absolute inset-6 rounded-[38%_62%_55%_45%/45%_38%_62%_55%] border border-cyan-300/10" /><div className="absolute inset-16 rounded-[46%_54%_35%_65%/60%_42%_58%_40%] border border-violet-300/10" /><div className="relative"><Boxes className="mx-auto mb-3 h-8 w-8 text-cyan-500/60" /><p className="text-sm font-medium text-slate-400">Load an image to sample feature fields.</p><p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-slate-600">RGB → gradients → microregions</p></div></div>}</div>
              <div className="min-h-72 bg-slate-950 p-3"><div className="mb-2 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.16em] text-slate-500"><span>Reconstructed output</span><span className="text-emerald-300">{reconstructionLevel === "full" ? "MICRO-REGION MEAN" : reconstructionLevel.toUpperCase()}</span></div>{reconstructionUrl ? <div className="overflow-hidden rounded border border-white/8 bg-black"><img src={reconstructionUrl} alt="Hierarchically reconstructed image" className="max-h-[480px] w-full object-contain" /></div> : <div className="relative grid h-72 place-items-center overflow-hidden rounded border border-dashed border-emerald-300/15 bg-[radial-gradient(circle_at_50%_50%,rgba(16,185,129,0.07),transparent_42%)] text-center"><div className="absolute grid h-32 w-44 grid-cols-4 gap-1 opacity-35">{Array.from({ length: 16 }).map((_, index) => <span key={index} className="rounded-sm border border-emerald-300/30" style={{ transform: `translate(${(index % 3) - 1}px, ${Math.floor(index / 4) % 2 ? 2 : -2}px)` }} />)}</div><div className="relative"><Network className="mx-auto mb-3 h-8 w-8 text-emerald-500/60" /><p className="text-sm font-medium text-slate-400">Decode a region hierarchy to inspect fidelity.</p><p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-slate-600">Regions → mean appearance → PNG / SVG</p></div></div>}</div>
            </div>
          </section>

          <section className="grid gap-4 lg:grid-cols-[1.25fr_0.75fr]">
            <div className="rounded-xl border border-cyan-100/10 bg-slate-900/80 p-4"><div className="mb-4 flex items-center gap-2 text-sm font-semibold text-slate-100"><TreePine className="h-4 w-4 text-cyan-300" /> Hierarchy navigator</div>{root ? <div className="max-h-[365px] overflow-auto pr-1"><TreeNode entity={root} entities={entities} selectedId={selectedId} onSelect={setSelectedId} /></div> : <div className="flex h-48 items-center justify-center rounded border border-dashed border-white/10 font-mono text-xs text-slate-600">NO ENTITY TREE LOADED</div>}</div>
            <div className="rounded-xl border border-cyan-100/10 bg-slate-900/80 p-4"><div className="mb-4 flex items-center gap-2 text-sm font-semibold text-slate-100"><Download className="h-4 w-4 text-cyan-300" /> Exports</div><div className="space-y-2">{artifacts ? <><a href={artifacts.representationJson} className="flex items-center gap-3 rounded-md border border-white/8 bg-white/[0.025] px-3 py-2.5 text-xs text-slate-300 hover:border-cyan-300/30 hover:bg-cyan-300/[0.06]"><FileJson2 className="h-4 w-4 text-amber-300" /><span>Representation JSON</span><Download className="ml-auto h-3.5 w-3.5 text-slate-500" /></a><a href={artifacts.featuresNpz} className="flex items-center gap-3 rounded-md border border-white/8 bg-white/[0.025] px-3 py-2.5 text-xs text-slate-300 hover:border-cyan-300/30 hover:bg-cyan-300/[0.06]"><FileArchive className="h-4 w-4 text-violet-300" /><span>Feature arrays (.npz)</span><Download className="ml-auto h-3.5 w-3.5 text-slate-500" /></a><a href={artifacts.reconstructedPng} className="flex items-center gap-3 rounded-md border border-white/8 bg-white/[0.025] px-3 py-2.5 text-xs text-slate-300 hover:border-cyan-300/30 hover:bg-cyan-300/[0.06]"><FileImage className="h-4 w-4 text-emerald-300" /><span>Reconstructed PNG</span><Download className="ml-auto h-3.5 w-3.5 text-slate-500" /></a><a href={artifacts.svg} className="flex items-center gap-3 rounded-md border border-white/8 bg-white/[0.025] px-3 py-2.5 text-xs text-slate-300 hover:border-cyan-300/30 hover:bg-cyan-300/[0.06]"><FileImage className="h-4 w-4 text-cyan-300" /><span>Region-boundary SVG</span><Download className="ml-auto h-3.5 w-3.5 text-slate-500" /></a></> : <p className="rounded border border-dashed border-white/10 p-4 text-xs leading-relaxed text-slate-500">Artifact exports are generated after a successful run.</p>}</div></div>
          </section>
        </section>

        <aside className="space-y-4 xl:sticky xl:top-4 xl:self-start">
          {isAdmin ? <RuntimeTelemetryPanel telemetry={telemetryQuery.data as CacheRetentionTelemetry | undefined} isLoading={telemetryQuery.isLoading} /> : null}
          <V03InspectionPanels representation={representation} selectedEntity={selectedEntity} />
          <V04ReconstructionPanel representation={representation} selectedEntity={selectedEntity} />
          <SegmentationDiagnosticsPanel representation={representation} />
          {representation?.parameterSensitivity ? <section className="rounded-xl border border-violet-200/10 bg-slate-900/80 p-4"><div className="mb-3 flex items-center gap-2 text-sm font-semibold text-violet-100"><Activity className="h-4 w-4 text-violet-300" /> Parameter sensitivity</div><p className="text-[11px] leading-relaxed text-slate-500">{representation.parameterSensitivity.interpretation}</p><div className="mt-3 space-y-1.5">{representation.parameterSensitivity.records.map(record => <div key={record.label} className="grid grid-cols-[1fr_auto] gap-x-3 rounded border border-white/8 bg-black/20 px-2.5 py-2 font-mono text-[10px]"><span className="uppercase tracking-wider text-violet-100">{record.label.replace(/_/g, " ")}</span><span className="text-slate-300">{record.relationshipCount} edges</span><span className="text-slate-500">PSNR {record.quality.psnr.toFixed(2)}</span><span className="text-emerald-200">{formatBytes(record.artifactStorageBytes)}</span></div>)}</div>{artifacts?.parameterSensitivity ? <a href={artifacts.parameterSensitivity} className="mt-3 flex items-center gap-2 rounded border border-violet-300/15 bg-violet-300/[0.04] px-2 py-2 font-mono text-[10px] text-violet-100 hover:bg-violet-300/[0.09]"><FileJson2 className="h-3.5 w-3.5" /> Download sensitivity report <Download className="ml-auto h-3 w-3" /></a> : null}</section> : null}
          <section className="rounded-xl border border-cyan-100/10 bg-slate-900/80 p-4"><div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-100"><Network className="h-4 w-4 text-cyan-300" /> Graph hierarchy evidence</div>{representation ? <div className="space-y-3 text-xs"><div className="rounded border border-white/8 bg-black/20 p-2.5"><p className="font-mono text-[9px] uppercase tracking-wider text-slate-500">Experiment</p><p className="mt-1 font-mono text-xs text-cyan-100">{representation.experiment?.engineVersion ?? representation.representation_version ?? "legacy"} · {representation.experiment?.algorithm ?? "deterministic hierarchy"}</p><p className="mt-1 break-all font-mono text-[9px] text-slate-500">{representation.experiment?.configHash ?? "configuration hash unavailable"}</p></div><div className="grid grid-cols-2 gap-2">{[["Connectivity", representation.validity?.connectivityScore ?? 0], ["Leaf coverage", representation.validity?.leafCoverage ?? 0], ["Area error", representation.validity?.parentAreaConservationError ?? 0], ["Graph density", representation.graph_metadata?.relationshipDensity ?? 0]].map(([label, value]) => <div key={String(label)} className="rounded border border-white/8 bg-black/20 p-2"><p className="font-mono text-[9px] uppercase text-slate-500">{label}</p><p className="mt-1 font-mono text-sm text-slate-200">{Number(value).toFixed(3)}</p></div>)}</div><p className={cn("font-mono text-[10px] uppercase tracking-wider", representation.validity?.valid ? "text-emerald-200" : "text-amber-200")}>{representation.validity?.valid ? "Invariant checks passed" : "Review representation invariants"}</p></div> : <p className="text-xs leading-relaxed text-slate-500">v0.5 reports deterministic fixed-depth grouping, graph affinity, connectivity, coverage, and canonical geometry invariants after analysis.</p>}</section>
          <section className="rounded-xl border border-cyan-100/10 bg-slate-900/80 p-4"><div className="mb-4 flex items-center gap-2 text-sm font-semibold text-slate-100"><Activity className="h-4 w-4 text-cyan-300" /> Quality metrics</div>{representation ? <div className="grid grid-cols-2 gap-2">{[["PSNR", `${representation.metrics.psnr.toFixed(2)} dB`, "cyan"], ["SSIM", representation.metrics.ssim.toFixed(4), "emerald"], ["MSE", representation.metrics.mse.toFixed(2), "amber"], ["Overhead", `${representation.metrics.representationOverhead.toFixed(1)}×`, "violet"], ["Runtime", `${representation.metrics.processingTimeMs.toFixed(0)} ms`, "cyan"], ["Artifact", formatBytes(representation.metrics.representationBytes), "slate"]].map(([label, value, tone]) => <div key={label} className="rounded-md border border-white/8 bg-black/20 p-2.5"><p className="font-mono text-[9px] uppercase tracking-[0.13em] text-slate-500">{label}</p><p className={cn("mt-1 font-mono text-sm font-semibold", tone === "cyan" ? "text-cyan-200" : tone === "emerald" ? "text-emerald-200" : tone === "amber" ? "text-amber-200" : tone === "violet" ? "text-violet-200" : "text-slate-200")}>{value}</p></div>)}</div> : <p className="rounded border border-dashed border-white/10 p-4 text-xs leading-relaxed text-slate-500">Fidelity and artifact metrics appear after region decoding.</p>}</section>
          <section className="rounded-xl border border-cyan-100/10 bg-slate-900/80 p-4"><div className="mb-4 flex items-center gap-2 text-sm font-semibold text-slate-100"><Boxes className="h-4 w-4 text-cyan-300" /> Entity inspector</div>{selectedEntity ? <div className="space-y-4 text-xs"><div><p className="font-mono text-[10px] uppercase tracking-[0.15em] text-cyan-300">{selectedEntity.type.replace("_", " ")} · L{selectedEntity.level}</p><p className="mt-1 break-all font-mono text-[10px] text-slate-500">{selectedEntity.id}</p></div><div className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-md border border-white/8 bg-black/20 p-3"><span className="text-slate-500">Bounding box</span><span className="font-mono text-right text-slate-200">[{selectedEntity.geometry.boundingBox.join(", ")}]</span><span className="text-slate-500">Centroid</span><span className="font-mono text-right text-slate-200">({selectedEntity.geometry.centroid.map(value => value.toFixed(1)).join(", ")})</span><span className="text-slate-500">Area</span><span className="font-mono text-right text-slate-200">{selectedEntity.geometry.area} px</span><span className="text-slate-500">Perimeter</span><span className="font-mono text-right text-slate-200">{selectedEntity.geometry.perimeter.toFixed(1)}</span><span className="text-slate-500">Orientation</span><span className="font-mono text-right text-slate-200">{selectedEntity.geometry.orientation.toFixed(1)}°</span><span className="text-slate-500">Mean RGB</span><span className="font-mono text-right text-slate-200">{selectedEntity.appearance.meanRGB.map(value => value.toFixed(0)).join(", ")}</span><span className="text-slate-500">Brightness</span><span className="font-mono text-right text-slate-200">{selectedEntity.appearance.brightness.toFixed(3)}</span><span className="text-slate-500">Members</span><span className="font-mono text-right text-slate-200">{selectedEntity.statistics.memberPixelCount}</span></div><div><p className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">Relationships · {entityRelationships.length}</p><div className="max-h-40 space-y-1 overflow-auto pr-1">{entityRelationships.slice(0, 12).map(relationship => <div key={`${relationship.sourceId}-${relationship.targetId}`} className="rounded border border-white/7 bg-black/15 p-2 font-mono text-[10px] text-slate-400"><span className={relationship.adjacent ? "text-emerald-300" : "text-slate-500"}>{relationship.primaryType.toUpperCase()}</span> · d {relationship.normalizedDistance.toFixed(3)} · Δc {relationship.colorDistance.toFixed(1)} · θ {relationship.angle.toFixed(1)}°</div>) || <p className="text-slate-600">No sparse relationships for this entity.</p>}</div></div></div> : <p className="rounded border border-dashed border-white/10 p-4 text-xs leading-relaxed text-slate-500">Choose an entity in the hierarchy to inspect its exact geometry, appearance, vectors, and graph relationships.</p>}</section>
          <section className="rounded-xl border border-cyan-100/10 bg-slate-900/80 p-4"><div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-100"><Network className="h-4 w-4 text-cyan-300" /> Relational context</div>{selectedEntity ? <div className="space-y-3 text-xs"><div className="rounded border border-white/8 bg-black/20 p-3"><div className="flex items-center justify-between"><span className="text-slate-500">Vector</span><span className="font-mono text-cyan-200">{selectedEntity.vector.dimension}D</span></div><p className="mt-1 font-mono text-[10px] text-slate-500">{selectedEntity.vector.provenance}</p><p className="mt-2 line-clamp-2 font-mono text-[10px] text-slate-400">[{selectedEntity.vector.values.slice(0, 8).map(value => value.toFixed(3)).join(", ")}, …]</p></div><div className="grid grid-cols-2 gap-2"><div className="rounded border border-white/8 bg-black/20 p-2"><p className="font-mono text-[9px] uppercase text-slate-500">Parent chain</p><p className="mt-1 font-mono text-sm text-slate-200">{parentChain.length}</p></div><div className="rounded border border-white/8 bg-black/20 p-2"><p className="font-mono text-[9px] uppercase text-slate-500">Siblings</p><p className="mt-1 font-mono text-sm text-slate-200">{siblings.length}</p></div><div className="rounded border border-white/8 bg-black/20 p-2"><p className="font-mono text-[9px] uppercase text-slate-500">Complexity</p><p className="mt-1 font-mono text-sm text-slate-200">{(selectedEntity.statistics.complexity ?? 0).toFixed(3)}</p></div><div className="rounded border border-white/8 bg-black/20 p-2"><p className="font-mono text-[9px] uppercase text-slate-500">Texture</p><p className="mt-1 font-mono text-sm text-slate-200">{(selectedEntity.appearance.textureMeasure ?? 0).toFixed(3)}</p></div></div><div><p className="mb-2 font-mono text-[9px] uppercase tracking-wider text-slate-500">Relationship matrix · strongest edges</p><div className="overflow-hidden rounded border border-white/8"><table className="w-full text-left font-mono text-[9px]"><thead className="bg-white/[0.04] text-slate-500"><tr><th className="px-2 py-1.5">Type</th><th className="px-2 py-1.5">d′</th><th className="px-2 py-1.5">Color</th><th className="px-2 py-1.5">Conf.</th></tr></thead><tbody>{entityRelationships.slice(0, 6).map(edge => <tr key={`${edge.sourceId}-${edge.targetId}`} className="border-t border-white/5 text-slate-300"><td className="px-2 py-1.5 text-cyan-200">{edge.primaryType}</td><td className="px-2 py-1.5">{edge.normalizedDistance.toFixed(3)}</td><td className="px-2 py-1.5">{edge.colorSimilarity.toFixed(2)}</td><td className="px-2 py-1.5">{edge.confidence.toFixed(2)}</td></tr>)}</tbody></table></div></div></div> : <p className="text-xs leading-relaxed text-slate-500">Select an entity to inspect its explicit numerical vector and sparse graph neighborhood.</p>}</section>
          <section className="rounded-xl border border-cyan-100/10 bg-slate-900/80 p-4"><div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-100"><Activity className="h-4 w-4 text-cyan-300" /> Scale consistency</div>{representation ? <div className="space-y-3 text-xs"><p className="font-mono text-[10px] uppercase tracking-wider text-cyan-200">{representation.scale_consistency.status}</p>{representation.scale_consistency.status === "completed" ? <div className="grid grid-cols-2 gap-2">{[["Centroid", representation.scale_consistency.centroidStability], ["Area", representation.scale_consistency.sizeRatioStability], ["Brightness", representation.scale_consistency.brightnessStability], ["Color", representation.scale_consistency.colorStability], ["Neighbors", representation.scale_consistency.relationshipStability]].map(([label, value]) => <div key={String(label)} className="rounded border border-white/8 bg-black/20 p-2"><p className="font-mono text-[9px] uppercase text-slate-500">{label}</p><p className="mt-1 font-mono text-sm text-slate-200">{Number(value ?? 0).toFixed(3)}</p></div>)}</div> : <p className="text-slate-500">The 2× normalized correspondence experiment was skipped for this input.</p>}<div className="border-t border-white/8 pt-2"><p className="font-mono text-[9px] uppercase text-slate-500">Sparse graph timing</p><p className="mt-1 font-mono text-xs text-slate-300">{(representation.profiling.relationshipConstructionMs ?? 0).toFixed(1)} ms · {representation.relationships.length} relevant edges</p></div></div> : <p className="text-xs leading-relaxed text-slate-500">A normalized 2× experiment is recorded with each compatible analysis.</p>}</section>
        </aside>
      </main>
    </div>
  );
}
