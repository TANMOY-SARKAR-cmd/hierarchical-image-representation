import { cn } from "@/lib/utils";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Component, ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error) {
    console.error("[Workbench render recovery]", error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-slate-950 p-8 text-slate-100">
          <div className="flex w-full max-w-2xl flex-col items-center rounded-xl border border-amber-300/25 bg-slate-900/90 p-8 shadow-2xl shadow-black/30">
            <AlertTriangle
              size={48}
              className="text-destructive mb-6 flex-shrink-0"
            />

            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-cyan-200">Workbench recovery</p>
            <h2 className="mb-4 mt-2 text-xl font-semibold">The workbench could not finish loading.</h2>

            <div className="mb-6 w-full overflow-auto rounded border border-white/10 bg-black/20 p-4">
              <pre className="whitespace-break-spaces text-sm text-slate-400">
                {this.state.error?.message || "Refresh the page to retry loading the workbench."}
              </pre>
            </div>

            <button
              onClick={() => window.location.reload()}
              className={cn(
                "flex items-center gap-2 px-4 py-2 rounded-lg",
                "bg-cyan-300 text-slate-950",
                "hover:opacity-90 cursor-pointer"
              )}
            >
              <RotateCcw size={16} />
              Reload Page
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
