// Error boundaries — one per surface, not one per window.
//
// A single boundary at the root would mean one pane's render throw blanks the whole
// console, which is the opposite of what the deck is for: three other panes were
// fine and the person loses them. So the frame nests boundaries — one around the
// frame itself as a last resort, one around each surface — and a failed surface
// renders the "error" kind of nothing in its own footprint while its neighbours
// keep working.
//
// IT LIVES IN `primitives/` AND NOT IN `frame/`, WHERE IT WAS. Its only input is
// `core`'s tripwire report and React itself, and its readers are the frame's chrome
// and a view family's row group — and a view family cannot import `frame/index.ts`,
// whose barrel reaches `ConsoleRoot` and through it every family, so that edge closes
// a cycle. The row group therefore wrote a deep specifier and said so in a comment,
// which is exactly the shape `console-cross-family-deep-import` reports; its remedy is
// this move, to the lowest family that owns the inputs. Its two class stems are
// already family-neutral (`meridian-surface-mount`, `meridian-surface-failure`), so
// they travel unchanged with the sheet beside this file.
//
// This is a class because React's error-boundary contract has no hook form:
// `getDerivedStateFromError` and `componentDidCatch` exist only on classes. The
// repo's function-components rule is about views; this is the framework's only
// mechanism, and the boundary renders through a function component anyway.

import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportTripwire } from "../core/index.js";

export interface SurfaceErrorBoundaryProps {
  /** What failed, in the person's words: "the timeline", "the approvals pane". */
  readonly surfaceName: string;
  readonly children: ReactNode;
  /** Rendered instead of the default card, when a surface wants its own. */
  readonly fallback?: (error: Error, retry: () => void) => ReactNode;
}

interface SurfaceErrorBoundaryState {
  readonly error: Error | undefined;
  /** Bumped by `retry`, remounting the subtree so a transient failure can clear. */
  readonly attempt: number;
}

export class SurfaceErrorBoundary extends Component<
  SurfaceErrorBoundaryProps,
  SurfaceErrorBoundaryState
> {
  public constructor(props: SurfaceErrorBoundaryProps) {
    super(props);
    this.state = { error: undefined, attempt: 0 };
  }

  public static getDerivedStateFromError(error: unknown): Partial<SurfaceErrorBoundaryState> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  public override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // Routed through the tripwire registry rather than `console.error` so a render
    // failure is counted and retained the way every other runtime tripwire is, and
    // so the diagnostics surface can show it.
    //
    // Under its OWN kind. This used to report `apply-chokepoint-bypass`, which says
    // a store was mutated outside its single `apply` — and a component that threw
    // while rendering mutated nothing at all. The two readings are acted on
    // differently (one is a state-write defect, the other a rendering one), so
    // folding a crash into the store's count made the store invariant read as
    // broken every time any pane hit a rendering bug.
    reportTripwire(
      "surface-render-failure",
      `SurfaceErrorBoundary(${this.props.surfaceName})`,
      `${error.message}${describeComponentStack(errorInfo)}`,
    );
  }

  public override render(): ReactNode {
    const { error, attempt } = this.state;
    if (error === undefined) {
      // `display: contents`, not a plain div. The element exists only to carry the
      // `key` that remounts the subtree on retry, and a box in the tree is a box a
      // surface's layout has to survive: an unstyled `height: auto` div between the
      // frame's surface slot and its child breaks every percentage-height chain
      // through it, which is exactly how the first full-height surface came out
      // pinned to the top of the window. `display: contents` keeps the remount and
      // removes the box. Safe on a bare div, which has no implicit ARIA role to
      // lose.
      return (
        <div key={attempt} className="meridian-surface-mount">
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
    return <SurfaceFailure surfaceName={this.props.surfaceName} error={error} onRetry={retry} />;
  }
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

interface SurfaceFailureProps {
  readonly surfaceName: string;
  readonly error: Error;
  readonly onRetry: () => void;
}

/**
 * The default fallback. Calm-authority copy: what stopped working, and the one
 * thing that might fix it. The error message is shown because a person who reports
 * a bug needs it, and hiding it would only mean asking them for a screenshot later.
 */
function SurfaceFailure(props: SurfaceFailureProps): React.JSX.Element {
  return (
    <div className="meridian-surface-failure" role="alert">
      <p className="meridian-surface-failure__title">{props.surfaceName} stopped rendering.</p>
      <p className="meridian-surface-failure__detail">{props.error.message}</p>
      <button className="meridian-surface-failure__action" type="button" onClick={props.onRetry}>
        Try again
      </button>
    </div>
  );
}
