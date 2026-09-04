// Error slots — ranked, per kind, so one failure never clobbers another's remedy.
//
// `Spec-023 §Meridian, the design language` rule 8 fixes what a failure looks like — an
// _error_ is "a red-edged row with the code and the daemon's message text" — and rule 9
// puts a refusal on the control that produced it. THE RANKING IS THIS MODULE'S, because
// no committed document states it: every row group and every pane has an error boundary,
// errors render in ranked per-kind slots so a transient error never clobbers a live
// Retry, teardown reads are null-safe, and a row that fails projection renders red with
// the failure named.
//
// WHY RANKED SLOTS RATHER THAN A LIST. Four things in the ledger can fail
// independently and at different rates. A geometry read fails once and clears on
// the next frame; a row that cannot be projected fails every time it is rendered
// and needs a person to act. A single "last error" field lets the transient one
// overwrite the durable one a frame later, so the Retry a person was reaching for
// is replaced by a notice about something that has already fixed itself. One slot
// per kind, rendered in a fixed order, makes that unrepresentable.
//
// WHY THE BOUNDARY IS THE FRAME'S AND NOT A SECOND ONE. `frame/ErrorBoundary.tsx`
// already owns the console's only error boundary, and it reports through the
// tripwire registry so a caught render failure is counted rather than logged. This
// module supplies the LEDGER's fallback for it, and nothing else.
//
// WHY THAT IMPORT IS DEEP. `frame/index.ts` exports `ConsoleRoot`, which imports
// `console/families.ts`, which imports this family's door — so an edge from here to
// the frame's barrel closes a cycle the layering gate fails the build on.
// `ledger/index.ts` reaches `frame/surface-registry.js` deeply for exactly this
// reason and says so; `ErrorBoundary.tsx` imports nothing above `core/`, so this
// edge stays a strict descent through the DAG.

import { refuse, type ConsoleRefusal } from "../../core/index.js";
import { SurfaceErrorBoundary } from "../../frame/ErrorBoundary.js";
import { InlineRefusal, RefusalCard } from "../../primitives/index.js";

/**
 * The four things that fail independently in a ledger, in rank order.
 *
 * Highest first: a row nobody can project is a fact about the session that will not
 * clear on its own, and a geometry sample that failed once is gone by the next
 * frame. The order IS the policy — there is no severity field to disagree with it.
 */
export const LEDGER_ERROR_KINDS = ["row-projection", "reveal", "prune", "geometry"] as const;

/** One error slot. Derived from the enumeration, never restated. */
export type LedgerErrorKind = (typeof LEDGER_ERROR_KINDS)[number];

/** What one slot holds. */
export interface LedgerErrorEntry {
  readonly kind: LedgerErrorKind;
  readonly refusal: ConsoleRefusal;
}

/**
 * The ledger's error slots.
 *
 * A class rather than component state because the producers are not components:
 * the reveal engine's diagnostics, the window's prune outcome, and the scroll
 * controller's geometry all report from outside a render, and a `useState` setter
 * threaded to each of them would be four subscriptions to one fact.
 */
export class LedgerErrorSlots {
  readonly #refusalByKind = new Map<LedgerErrorKind, ConsoleRefusal>();

  public record(kind: LedgerErrorKind, refusal: ConsoleRefusal): void {
    this.#refusalByKind.set(kind, refusal);
  }

  /** Clear one slot. The others are untouched — that is the whole point of ranking. */
  public clear(kind: LedgerErrorKind): void {
    this.#refusalByKind.delete(kind);
  }

  /** Every occupied slot, in rank order. */
  public entries(): readonly LedgerErrorEntry[] {
    return LEDGER_ERROR_KINDS.flatMap((kind) => {
      const refusal = this.#refusalByKind.get(kind);
      return refusal === undefined ? [] : [{ kind, refusal }];
    });
  }

  /** The slot a surface with room for one renders. */
  public highest(): LedgerErrorEntry | undefined {
    return this.entries()[0];
  }

  public get occupiedSlotCount(): number {
    return this.#refusalByKind.size;
  }
}

export interface LedgerErrorSlotProps {
  readonly entries: readonly LedgerErrorEntry[];
  /** The operator's next move for the highest-ranked slot, when there is one. */
  readonly action?: React.ReactNode;
}

/**
 * The pane's error strip.
 *
 * The highest-ranked slot is a card, because it is the one a person is meant to
 * act on; the rest are inline, because they are context for it. Rendering four
 * cards would bury the log the pane exists to show.
 */
export function LedgerErrorSlot(props: LedgerErrorSlotProps): React.JSX.Element | null {
  const [highest, ...rest] = props.entries;
  if (highest === undefined) {
    return null;
  }
  return (
    <div className="meridian-ledger-errors">
      <RefusalCard
        code={highest.refusal.code}
        detail={highest.refusal.detail}
        action={props.action}
      />
      {rest.map((entry) => (
        <InlineRefusal key={entry.kind} code={entry.refusal.code} detail={entry.refusal.detail} />
      ))}
    </div>
  );
}

export interface LedgerRowGroupProps {
  /** What failed, in the person's words: "a run chapter", "the streaming message". */
  readonly groupLabel: string;
  readonly children: React.ReactNode;
}

/**
 * One row group's boundary.
 *
 * A group rather than the whole feed: a single row that throws must not blank the
 * log around it, which is the same reasoning `frame/ErrorBoundary.tsx` gives for
 * one boundary per surface rather than one per window, applied one level down.
 *
 * The failure is rendered RED and NAMED (rule 8) through the console's one refusal
 * grammar — the row's own place in the log, holding the reason it could not be
 * drawn, rather than a gap a reader would read as the session having nothing there.
 */
export function LedgerRowGroup(props: LedgerRowGroupProps): React.JSX.Element {
  return (
    <SurfaceErrorBoundary
      surfaceName={props.groupLabel}
      fallback={(error, retry) => (
        <div className="meridian-ledger-row-failure" role="alert">
          <RefusalCard
            {...rowProjectionRefusal(props.groupLabel, error)}
            action={
              <button type="button" className="meridian-ledger-retry" onClick={retry}>
                Try again
              </button>
            }
          />
        </div>
      )}
    >
      {props.children}
    </SurfaceErrorBoundary>
  );
}

/**
 * A render failure, as a refusal.
 *
 * Built through `refuse` rather than an object literal so this failure carries the
 * same three fields as every daemon refusal and reaches the same three renderers.
 * The code is renderer-local and says so in its own name: nothing here came off a
 * wire, and dressing it as a wire code would make a console defect look like the
 * daemon's answer.
 */
function rowProjectionRefusal(groupLabel: string, error: Error): ConsoleRefusal {
  return refuse(
    "ledger",
    "renderer.row_projection_failed",
    `${groupLabel} could not be drawn: ${error.message}`,
  );
}
