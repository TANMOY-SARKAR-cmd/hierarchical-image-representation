import { render, screen } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it } from "vitest";
import ResultInspectionStudio from "./ResultInspectionStudio";
import type { Representation } from "./Home";

describe("ResultInspectionStudio", () => {
  it("renders incomplete retained fields without calling toFixed on undefined", () => {
    const representation = {
      entities: [{ id: "root", type: "image", level: 0, children: [], geometry: {}, vector: {} }],
      relationships: [{ sourceId: "root", targetId: "other", primaryType: "adjacent" }],
      hierarchy: { rootId: "root" },
      reconstruction_metadata: { outputs: {} },
      segmentationDiagnostics: { slic: { strategy: "slic" } },
      scale_correspondence: { method: "partial", links: [{ sourceId: "root", targetId: "other" }] },
      metrics: {},
      parameterSensitivity: { interpretation: "partial", records: [{ label: "variant", quality: {} }] },
      scale_consistency: {},
      profiling: {},
    } as unknown as Representation;

    render(<ResultInspectionStudio representation={representation} selectedId="root" onSelect={() => undefined} activeCut="full" onCutChange={() => undefined} />);

    expect(screen.queryByText(/Selected merge energy/i)).toBeNull();
    expect(screen.getAllByText("— dB").length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText(/edge —/i)).toBeTruthy();
    expect(screen.getByText(/Sparse graph timing — ms/i)).toBeTruthy();
  });
});
