import { render, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./pages/Home", () => ({ default: () => <main>Workbench content</main> }));
vi.mock("./components/ErrorBoundary", () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("./contexts/ThemeContext", () => ({ ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("./components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("./components/ui/tooltip", () => ({ TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

import App from "./App";

describe("application startup acknowledgement", () => {
  const markReady = vi.fn();

  beforeEach(() => {
    markReady.mockReset();
    (window as Window & { __HIR_BOOTSTRAP__?: { markReady: () => void; fail: (category?: string) => void } }).__HIR_BOOTSTRAP__ = { markReady, fail: vi.fn() };
  });

  it("acknowledges the static fallback only after the application tree commits", async () => {
    render(<App />);
    await waitFor(() => expect(markReady).toHaveBeenCalledTimes(1));
  });
});
