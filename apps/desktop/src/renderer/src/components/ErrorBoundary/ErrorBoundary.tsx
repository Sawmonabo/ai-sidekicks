// One boundary per region so a render throw in one pane does not blank the window. A class,
// because `getDerivedStateFromError` and `componentDidCatch` have no hook form.

import "./ErrorBoundary.css";

import { Component, type ErrorInfo, type ReactNode } from "react";

import { RenderFailureCard } from "./RenderFailureCard.js";
import { reportTripwire } from "@renderer/lib/tripwires.js";

/** What a boundary wraps, what to call it when it fails, and an optional fallback. */
export interface ErrorBoundaryProps {
  /** What failed, in the person's words: "the transcript", "the inspector". */
  readonly regionName: string;
  readonly children: ReactNode;
  /** Rendered instead of the default card, when a region wants its own. */
  readonly fallback?: (error: Error, retry: () => void) => ReactNode;
}

/** Catches a render failure in its subtree, reports it, and offers a retry in place. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: undefined, attempt: 0 };
  }

  public static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  public override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // Its own tripwire kind: a render throw mutated no store, so it must not count as a
    // store write outside `apply`.
    reportTripwire(
      "region-render-failure",
      `ErrorBoundary(${this.props.regionName})`,
      `${error.message}${describeComponentStack(errorInfo)}`,
    );
  }

  public override render(): ReactNode {
    const { error, attempt } = this.state;
    if (error === undefined) {
      // The div only carries the remount `key`; `display: contents` keeps it from breaking
      // percentage-height chains through the region.
      return (
        <div key={attempt} className="meridian-render-region">
          {this.props.children}
        </div>
      );
    }
    const retry = (): void => {
      this.setState((previous) => ({ error: undefined, attempt: previous.attempt + 1 }));
    };
    if (this.props.fallback !== undefined) {
      return this.props.fallback(error, retry);
    }
    return <RenderFailureCard regionName={this.props.regionName} error={error} onRetry={retry} />;
  }
}

interface ErrorBoundaryState {
  readonly error: Error | undefined;
  /** Bumped by `retry`, remounting the subtree so a transient failure can clear. */
  readonly attempt: number;
}

/** The innermost component from React's stack, or nothing; the report is read in a list. */
function describeComponentStack(errorInfo: ErrorInfo): string {
  const componentStack = errorInfo.componentStack;
  if (componentStack === null || componentStack === undefined) {
    return "";
  }
  const innermost = componentStack.trim().split("\n")[0];
  return innermost === undefined ? "" : ` — in ${innermost.trim()}`;
}
