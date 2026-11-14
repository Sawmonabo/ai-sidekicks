// One boundary per region so a render throw in one pane does not blank the window. A class,
// because `getDerivedStateFromError` and `componentDidCatch` have no hook form.

import "./ErrorBoundary.css";

import { Component, type ErrorInfo, type ReactNode } from "react";

import { InlineRefusal } from "../Refusal/InlineRefusal.js";
import { LoadingNotice } from "../LoadingNotice/LoadingNotice.js";
import { RenderFailureCard } from "./RenderFailureCard.js";
import type { Clock } from "#renderer/lib/clock.js";
import { RereadableRefusalError } from "#renderer/lib/refusal/contract.js";
import { reportTripwire } from "#renderer/lib/tripwires/registry.js";
import { wireRejectionToError } from "#renderer/lib/wire/errors.js";

/** What a boundary wraps, what to call it when it fails, and the chrome its failure line wears. */
export interface ErrorBoundaryProps {
  /** What failed, in the person's words: "The transcript", "The inspector". */
  readonly regionName: string;
  readonly children: ReactNode;
  /**
   * Draws the region's own chrome around the line that stands in for it, so a pane that failed
   * keeps its header and its close; absent, the line stands alone.
   */
  readonly frame?: (line: ReactNode) => ReactNode;
  /** The window's clock, from `useClock()`, which delays a read asked again's loading line. */
  readonly clock: Clock;
  /**
   * What the region draws, for a region that moves between subjects while mounted: a failure line
   * is dropped when it changes, so it never outlives the subject that threw, and a region drawing
   * well is not remounted by the change.
   */
  readonly subjectKey?: string;
}

/**
 * Catches a render failure in its subtree, reports it, and offers a retry in place; a read that
 * failed draws its own line with `Try again`, and its loading line while it is asked again.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  /** Stops waiting on the read asked again, while one is out. */
  #stopReadingAgain: (() => void) | undefined;

  public constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      error: undefined,
      attempt: 0,
      isReadingAgain: false,
      subjectKey: props.subjectKey,
    };
  }

  public static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { error: wireRejectionToError(error) };
  }

  public static getDerivedStateFromProps(
    props: ErrorBoundaryProps,
    state: ErrorBoundaryState,
  ): Partial<ErrorBoundaryState> | null {
    if (props.subjectKey === state.subjectKey) {
      return null;
    }
    // A new subject draws afresh: the failure line, and any read asked again, were the last one's.
    return state.error === undefined
      ? { subjectKey: props.subjectKey }
      : {
          subjectKey: props.subjectKey,
          error: undefined,
          attempt: state.attempt + 1,
          isReadingAgain: false,
        };
  }

  public override componentDidUpdate(previousProps: ErrorBoundaryProps): void {
    if (previousProps.subjectKey !== this.props.subjectKey) {
      this.#stopReadingAgain?.();
      this.#stopReadingAgain = undefined;
    }
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

  public override componentWillUnmount(): void {
    this.#stopReadingAgain?.();
    this.#stopReadingAgain = undefined;
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
    const line = this.#lineFor(error);
    return this.props.frame === undefined ? line : this.props.frame(line);
  }

  // A read that failed is asked again, and the region drawn again once it has answered; any other
  // throw reads as the region's failure line with its `Retry`.
  #lineFor(error: Error): ReactNode {
    if (error instanceof RereadableRefusalError) {
      if (this.state.isReadingAgain) {
        return <LoadingNotice clock={this.props.clock} title={READING_AGAIN_WORDS} />;
      }
      return (
        <InlineRefusal
          code={error.refusal.code}
          detail={error.refusal.detail}
          onTryAgain={() => {
            this.#readAgain(error);
          }}
        />
      );
    }
    return (
      <RenderFailureCard
        regionName={this.props.regionName}
        onRetry={() => {
          this.setState((previous) => ({ error: undefined, attempt: previous.attempt + 1 }));
        }}
      />
    );
  }

  // One read asked again at a time; its answer draws the region again.
  #readAgain(error: RereadableRefusalError): void {
    if (this.#stopReadingAgain !== undefined) {
      return;
    }
    this.setState({ isReadingAgain: true });
    this.#stopReadingAgain = error.readAgain(() => {
      this.#stopReadingAgain = undefined;
      this.setState((previous) => ({
        error: undefined,
        attempt: previous.attempt + 1,
        isReadingAgain: false,
      }));
    });
  }
}

/** The loading line a read asked again draws once it runs past the delay. */
const READING_AGAIN_WORDS = "Loading…";

interface ErrorBoundaryState {
  readonly error: Error | undefined;
  /** Bumped by `retry`, remounting the subtree so a transient failure can clear. */
  readonly attempt: number;
  /** Whether a failed read was asked again and has not answered yet. */
  readonly isReadingAgain: boolean;
  /** The subject the state was derived for, from `subjectKey`. */
  readonly subjectKey: string | undefined;
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
