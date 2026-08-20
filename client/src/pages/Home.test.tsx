import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/trpc", () => ({
  trpc: {
    imageAnalysis: {
      process: {
        useMutation: () => ({ isPending: false, mutateAsync: vi.fn() }),
      },
    },
  },
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import Home from "./Home";

describe("Hierarchy workbench UI", () => {
  beforeEach(() => {
    class TestResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:fixture"), revokeObjectURL: vi.fn() });
  });

  it("renders the analytical empty state and enables analysis after a supported image is selected", () => {
    const { container } = render(<Home />);
    const analysisButton = screen.getByRole("button", { name: /run analysis/i });
    expect(screen.getByRole("heading", { name: /hierarchical image workbench/i })).toBeInTheDocument();
    expect(screen.getByText("NO ENTITY TREE LOADED")).toBeInTheDocument();
    expect(analysisButton).toBeDisabled();

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const image = new File(["fixture"], "specimen.png", { type: "image/png" });
    fireEvent.change(fileInput, { target: { files: [image] } });

    expect(screen.getByText("specimen.png")).toBeInTheDocument();
    expect(analysisButton).toBeEnabled();
  });
});
