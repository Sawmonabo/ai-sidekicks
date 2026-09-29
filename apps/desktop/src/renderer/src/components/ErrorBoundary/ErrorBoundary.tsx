// Error boundaries — one per region, not one per window.
//
// A single boundary at the root would mean one pane's render throw blanks the whole
// window: three other panes were fine and the person loses them. So the frame nests
// boundaries — one around the frame itself as a last resort, one around each region —
// and a failed region renders its failure card in its own footprint while its
// neighbors keep working.
//
// This is a class because React's error-boundary contract has no hook form:
// `getDerivedStateFromError` and `componentDidCatch` exist only on classes.

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
    // Routed through the tripwire registry rather than `console.error` so a render
    // failure is counted and retained the way every other runtime tripwire is, and
    // so the diagnostic capture carries it.
    //
    // Under its OWN kind. This used to report `apply-chokepoint-bypass`, which says
    // a store was mutated outside its single `apply` — and a component that threw
    // while rendering mutated nothing at all. The two readings are acted on
    // differently (one is a state-write defect, the other a rendering one), so
    // folding a crash into the store's count made the store invariant read as
    // broken every time any pane hit a rendering bug.
    reportTripwire(
      "surface-render-failure",
      `ErrorBoundary(${this.props.regionName})`,
      `${error.message}${describeComponentStack(errorInfo)}`,
    );
  }

  public override render(): ReactNode {
    const { error, attempt } = this.state;
    if (error === undefined) {
      // `display: contents`, not a plain div. The element exists only to carry the `key` that
      // remounts the subtree on retry, and a box in the tree is a box a region's layout has to
      // survive: an unstyled `height: auto` div between the frame's screen and its child breaks
      // every percentage-height chain through it, which pins a full-height screen to the top of the
      // window. `display: contents` keeps the remount and removes the box. Safe on a bare div,
      // which has no implicit ARIA role to lose.
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

/**
 * The innermost component from React's stack, or nothing.
 *
 * Only the first frame is kept: the full stack is dozens of lines and the tripwire
 * report is read in a list, where one useful name beats a wall of provider
 * wrappers. The whole stack is still in the browser console, which is where a
 * person goes when the name is not enough.
 */
function describeComponentStack(errorInfo: ErrorInfo): string {
  const componentStack = errorInfo.componentStack;
  if (componentStack === null || componentStack === undefined) {
    return "";
  }
  const innermost = componentStack.trim().split("\n")[0];
  return innermost === undefined ? "" : ` — in ${innermost.trim()}`;
}
