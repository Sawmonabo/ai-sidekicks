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
// WHY THE BOUNDARY IS THE SHARED ONE AND NOT A SECOND ONE.
// `primitives/ErrorBoundary.tsx` already owns the console's only error boundary, and
// it reports through the tripwire registry so a caught render failure is counted
// rather than logged. The
// LEDGER's fallback for it is `LedgerRowGroup.tsx` beside this file — a separate
// module because it answers a different failure: this strip reports refusals the
// pane COLLECTED, and that one catches a row that threw while being drawn.

import { type ConsoleRefusal } from "../../core/index.js";
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
