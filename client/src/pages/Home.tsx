import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import React, { ChangeEvent, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

type Geometry = { boundingBox: number[]; centroid: number[]; area: number; perimeter: number; orientation: number; compactness: number };
type Entity = {
  id: string;
  type: string;
  level: number;
  scaleFactor: number;
  geometry: Geometry;
  appearance: { meanRGB: number[]; brightness: number; varianceRGB: number[] };
  statistics: { memberPixelCount: number };
  memberPixels: number[][];
  children: string[];
  parentId: string | null;
  crossScaleParentId: string | null;
};
type Relationship = {
  sourceId: string;
  targetId: string;
  distance: number;
  normalizedDistance: number;
  angle: number;
  sizeRatio: number;
  colorDifference: number;
  brightnessDifference: number;
  adjacent: boolean;
  overlap: number;
  containment: boolean;
};
type Representation = {
  image: { width: number; height: number; sourceBytes: number };
  entities: Entity[];
  relationships: Relationship[];
  metrics: { mse: number; psnr: number; ssim: number; compressionRatio: number; processingTimeMs: number; representationBytes: number };
  hierarchy: { rootId: string };
};

const overlays = [
  { id: "none", label: "Native source" },
  { id: "brightness", label: "Brightness field" },
  { id: "edgeStrength", label: "Edge strength" },
  { id: "gradientX", label: "X gradient" },
  { id: "gradientY", label: "Y gradient" },
] as const;

const availableScales = [1, 2, 4, 8];

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

/**
 * All content in this page are only for example, replace with your own feature implementation
 * When building pages, remember your instructions in Frontend Workflow, Frontend Best Practices, Design Guide and Common Pitfalls
 */
export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [representation, setRepresentation] = useState<Representation | null>(null);
  const [artifacts, setArtifacts] = useState<{ representationJson: string; featuresNpz: string; reconstructedPng: string; svg: string; overlays: Record<string, string> } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedOverlay, setSelectedOverlay] = useState<(typeof overlays)[number]["id"]>("none");
  const [scaleLevels, setScaleLevels] = useState<number[]>([1, 2, 4, 8]);
  const [maxFileSizeMb, setMaxFileSizeMb] = useState(8);
  const [slicSegments, setSlicSegments] = useState(72);
  const [compactness, setCompactness] = useState(10);
  const processMutation = trpc.imageAnalysis.process.useMutation();

  const entities = useMemo(() => new Map((representation?.entities ?? []).map(entity => [entity.id, entity])), [representation]);
  const selectedEntity = selectedId ? entities.get(selectedId) ?? null : null;
  const entityRelationships = useMemo(
    () => (representation?.relationships ?? []).filter(relationship => relationship.sourceId === selectedId || relationship.targetId === selectedId),
    [representation, selectedId]
  );
  const root = representation ? entities.get(representation.hierarchy.rootId) ?? null : null;
  const overlayUrl = selectedOverlay === "none" ? null : artifacts?.overlays[selectedOverlay] ?? null;

  useEffect(() => () => {
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  }, [sourceUrl]);

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
    setSourceUrl(URL.createObjectURL(incoming));
  }

  async function runAnalysis() {
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
          groupingMethod: "slic",
          scaleLevels,
          slicSegments,
          slicCompactness: compactness,
          minimumRegionPixels: 12,
          hierarchyGroupSize: 3,
        },
      });
      const parsed = result.representation as unknown as Representation;
      setRepresentation(parsed);
      setArtifacts(result.artifactUrls);
      setSelectedId(parsed.hierarchy.rootId);
      toast.success("Deterministic region analysis completed.");
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
            <div className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-3 py-1 font-mono text-[10px] text-cyan-200">DETERMINISTIC · SLIC</div>
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
        </aside>

        <section className="min-w-0 space-y-4">
          <section className="overflow-hidden rounded-xl border border-cyan-100/10 bg-slate-900/80 shadow-2xl shadow-slate-950/20">
            <div className="flex items-center justify-between border-b border-white/8 px-4 py-3"><div><h2 className="text-sm font-semibold text-slate-100">Comparative reconstruction</h2><p className="mt-0.5 font-mono text-[10px] uppercase tracking-widest text-slate-500">Source · feature field · hierarchical decoding</p></div><div className="rounded border border-white/10 bg-black/20 px-2 py-1 font-mono text-[10px] text-slate-400">{representation ? `${representation.image.width} × ${representation.image.height}` : "WAITING FOR INPUT"}</div></div>
            <div className="grid gap-px bg-white/10 md:grid-cols-2">
              <div className="relative min-h-72 bg-slate-950 p-3"><div className="mb-2 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.16em] text-slate-500"><span>Original / overlay</span><span className="text-cyan-300">{selectedOverlay === "none" ? "RGB" : selectedOverlay}</span></div>{sourceUrl ? <div className="relative overflow-hidden rounded border border-white/8 bg-black"><img src={sourceUrl} alt="Uploaded source" className="max-h-[480px] w-full object-contain" />{overlayUrl ? <img src={overlayUrl} alt="Selected feature overlay" className="absolute inset-0 h-full w-full object-contain opacity-60 mix-blend-screen" /> : null}</div> : <div className="relative grid h-72 place-items-center overflow-hidden rounded border border-dashed border-cyan-300/15 bg-[linear-gradient(rgba(34,211,238,0.035)_1px,transparent_1px),linear-gradient(90deg,rgba(34,211,238,0.035)_1px,transparent_1px)] bg-[size:24px_24px] text-center"><div className="absolute inset-6 rounded-[38%_62%_55%_45%/45%_38%_62%_55%] border border-cyan-300/10" /><div className="absolute inset-16 rounded-[46%_54%_35%_65%/60%_42%_58%_40%] border border-violet-300/10" /><div className="relative"><Boxes className="mx-auto mb-3 h-8 w-8 text-cyan-500/60" /><p className="text-sm font-medium text-slate-400">Load an image to sample feature fields.</p><p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-slate-600">RGB → gradients → microregions</p></div></div>}</div>
              <div className="min-h-72 bg-slate-950 p-3"><div className="mb-2 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.16em] text-slate-500"><span>Reconstructed output</span><span className="text-emerald-300">REGION MEAN</span></div>{artifacts ? <div className="overflow-hidden rounded border border-white/8 bg-black"><img src={artifacts.reconstructedPng} alt="Hierarchically reconstructed image" className="max-h-[480px] w-full object-contain" /></div> : <div className="relative grid h-72 place-items-center overflow-hidden rounded border border-dashed border-emerald-300/15 bg-[radial-gradient(circle_at_50%_50%,rgba(16,185,129,0.07),transparent_42%)] text-center"><div className="absolute grid h-32 w-44 grid-cols-4 gap-1 opacity-35">{Array.from({ length: 16 }).map((_, index) => <span key={index} className="rounded-sm border border-emerald-300/30" style={{ transform: `translate(${(index % 3) - 1}px, ${Math.floor(index / 4) % 2 ? 2 : -2}px)` }} />)}</div><div className="relative"><Network className="mx-auto mb-3 h-8 w-8 text-emerald-500/60" /><p className="text-sm font-medium text-slate-400">Decode a region hierarchy to inspect fidelity.</p><p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-slate-600">Regions → mean appearance → PNG / SVG</p></div></div>}</div>
            </div>
          </section>

          <section className="grid gap-4 lg:grid-cols-[1.25fr_0.75fr]">
            <div className="rounded-xl border border-cyan-100/10 bg-slate-900/80 p-4"><div className="mb-4 flex items-center gap-2 text-sm font-semibold text-slate-100"><TreePine className="h-4 w-4 text-cyan-300" /> Hierarchy navigator</div>{root ? <div className="max-h-[365px] overflow-auto pr-1"><TreeNode entity={root} entities={entities} selectedId={selectedId} onSelect={setSelectedId} /></div> : <div className="flex h-48 items-center justify-center rounded border border-dashed border-white/10 font-mono text-xs text-slate-600">NO ENTITY TREE LOADED</div>}</div>
            <div className="rounded-xl border border-cyan-100/10 bg-slate-900/80 p-4"><div className="mb-4 flex items-center gap-2 text-sm font-semibold text-slate-100"><Download className="h-4 w-4 text-cyan-300" /> Exports</div><div className="space-y-2">{artifacts ? <><a href={artifacts.representationJson} className="flex items-center gap-3 rounded-md border border-white/8 bg-white/[0.025] px-3 py-2.5 text-xs text-slate-300 hover:border-cyan-300/30 hover:bg-cyan-300/[0.06]"><FileJson2 className="h-4 w-4 text-amber-300" /><span>Representation JSON</span><Download className="ml-auto h-3.5 w-3.5 text-slate-500" /></a><a href={artifacts.featuresNpz} className="flex items-center gap-3 rounded-md border border-white/8 bg-white/[0.025] px-3 py-2.5 text-xs text-slate-300 hover:border-cyan-300/30 hover:bg-cyan-300/[0.06]"><FileArchive className="h-4 w-4 text-violet-300" /><span>Feature arrays (.npz)</span><Download className="ml-auto h-3.5 w-3.5 text-slate-500" /></a><a href={artifacts.reconstructedPng} className="flex items-center gap-3 rounded-md border border-white/8 bg-white/[0.025] px-3 py-2.5 text-xs text-slate-300 hover:border-cyan-300/30 hover:bg-cyan-300/[0.06]"><FileImage className="h-4 w-4 text-emerald-300" /><span>Reconstructed PNG</span><Download className="ml-auto h-3.5 w-3.5 text-slate-500" /></a><a href={artifacts.svg} className="flex items-center gap-3 rounded-md border border-white/8 bg-white/[0.025] px-3 py-2.5 text-xs text-slate-300 hover:border-cyan-300/30 hover:bg-cyan-300/[0.06]"><FileImage className="h-4 w-4 text-cyan-300" /><span>Region-boundary SVG</span><Download className="ml-auto h-3.5 w-3.5 text-slate-500" /></a></> : <p className="rounded border border-dashed border-white/10 p-4 text-xs leading-relaxed text-slate-500">Artifact exports are generated after a successful run.</p>}</div></div>
          </section>
        </section>

        <aside className="space-y-4 xl:sticky xl:top-4 xl:self-start">
          <section className="rounded-xl border border-cyan-100/10 bg-slate-900/80 p-4"><div className="mb-4 flex items-center gap-2 text-sm font-semibold text-slate-100"><Activity className="h-4 w-4 text-cyan-300" /> Quality metrics</div>{representation ? <div className="grid grid-cols-2 gap-2">{[["PSNR", `${representation.metrics.psnr.toFixed(2)} dB`, "cyan"], ["SSIM", representation.metrics.ssim.toFixed(4), "emerald"], ["MSE", representation.metrics.mse.toFixed(2), "amber"], ["Ratio", `${representation.metrics.compressionRatio.toFixed(3)}×`, "violet"], ["Runtime", `${representation.metrics.processingTimeMs.toFixed(0)} ms`, "cyan"], ["Artifact", formatBytes(representation.metrics.representationBytes), "slate"]].map(([label, value, tone]) => <div key={label} className="rounded-md border border-white/8 bg-black/20 p-2.5"><p className="font-mono text-[9px] uppercase tracking-[0.13em] text-slate-500">{label}</p><p className={cn("mt-1 font-mono text-sm font-semibold", tone === "cyan" ? "text-cyan-200" : tone === "emerald" ? "text-emerald-200" : tone === "amber" ? "text-amber-200" : tone === "violet" ? "text-violet-200" : "text-slate-200")}>{value}</p></div>)}</div> : <p className="rounded border border-dashed border-white/10 p-4 text-xs leading-relaxed text-slate-500">Fidelity and artifact metrics appear after region decoding.</p>}</section>
          <section className="rounded-xl border border-cyan-100/10 bg-slate-900/80 p-4"><div className="mb-4 flex items-center gap-2 text-sm font-semibold text-slate-100"><Boxes className="h-4 w-4 text-cyan-300" /> Entity inspector</div>{selectedEntity ? <div className="space-y-4 text-xs"><div><p className="font-mono text-[10px] uppercase tracking-[0.15em] text-cyan-300">{selectedEntity.type.replace("_", " ")} · L{selectedEntity.level}</p><p className="mt-1 break-all font-mono text-[10px] text-slate-500">{selectedEntity.id}</p></div><div className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-md border border-white/8 bg-black/20 p-3"><span className="text-slate-500">Bounding box</span><span className="font-mono text-right text-slate-200">[{selectedEntity.geometry.boundingBox.join(", ")}]</span><span className="text-slate-500">Centroid</span><span className="font-mono text-right text-slate-200">({selectedEntity.geometry.centroid.map(value => value.toFixed(1)).join(", ")})</span><span className="text-slate-500">Area</span><span className="font-mono text-right text-slate-200">{selectedEntity.geometry.area} px</span><span className="text-slate-500">Perimeter</span><span className="font-mono text-right text-slate-200">{selectedEntity.geometry.perimeter.toFixed(1)}</span><span className="text-slate-500">Orientation</span><span className="font-mono text-right text-slate-200">{selectedEntity.geometry.orientation.toFixed(1)}°</span><span className="text-slate-500">Mean RGB</span><span className="font-mono text-right text-slate-200">{selectedEntity.appearance.meanRGB.map(value => value.toFixed(0)).join(", ")}</span><span className="text-slate-500">Brightness</span><span className="font-mono text-right text-slate-200">{selectedEntity.appearance.brightness.toFixed(3)}</span><span className="text-slate-500">Members</span><span className="font-mono text-right text-slate-200">{selectedEntity.statistics.memberPixelCount}</span></div><div><p className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-slate-500">Relationships · {entityRelationships.length}</p><div className="max-h-40 space-y-1 overflow-auto pr-1">{entityRelationships.slice(0, 12).map(relationship => <div key={`${relationship.sourceId}-${relationship.targetId}`} className="rounded border border-white/7 bg-black/15 p-2 font-mono text-[10px] text-slate-400"><span className={relationship.adjacent ? "text-emerald-300" : "text-slate-500"}>{relationship.adjacent ? "ADJ" : "PAIR"}</span> · d {relationship.normalizedDistance.toFixed(3)} · Δc {relationship.colorDifference.toFixed(1)} · θ {relationship.angle.toFixed(1)}°</div>) || <p className="text-slate-600">No base-region relationships.</p>}</div></div></div> : <p className="rounded border border-dashed border-white/10 p-4 text-xs leading-relaxed text-slate-500">Choose an entity in the hierarchy to inspect its exact geometry, appearance, and graph relationships.</p>}</section>
        </aside>
      </main>
    </div>
  );
}
