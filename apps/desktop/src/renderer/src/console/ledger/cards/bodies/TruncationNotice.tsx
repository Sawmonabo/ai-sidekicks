// The notice a stored body's prefix carries — "truncated at N of M bytes", and
// whether the rest of it is anywhere a reader could ask for.
//
// Its own module for the one-component rule. The other half of the honest-body pair
// `MachineBody` composes: a truncated body renders its prefix AND says so, because a
// prefix alone reads as a complete short answer.
//
// AND IT NOW ANSWERS THE QUESTION THE OLD NOTICE RAISED AND LEFT OPEN. "Truncated
// when recorded" tells a reader the body is a prefix and says nothing about whether
// the remainder can be had — so somebody who wanted the rest had to guess, and the
// design's own answer to that ("show all") had no home. The notice is now total over
// three dispositions of the remainder, and the one this build always reaches is the
// honest negative: the read that would carry the rest is not registered, so the
// notice SAYS the remainder was not carried rather than implying it might be.
//
// THE GATE IS THE SLATE ROW AND NOT A FLAG OF THIS FAMILY'S OWN. `markdown-rules.ts`
// gates clickable path links the same way and for the same reason: the growth slate
// is the one place a wire's owner and live status are stated, and a boolean declared
// here would be a second claim that stops agreeing with it the day the wire lands.
// The row is `hydrated-event-read`, whose own `consumingSurface` names ledger rows.
//
// WHY THE DISPOSITION IS A VALUE AND THE GATE IS A CALL. Split, both arms of every
// branch are drivable: the gate is asserted against the ledger it reads, and the
// three dispositions are computed by a pure function a test drives with either
// answer — with no mutation of a frozen ledger anywhere, which is what a single
// fused predicate would have forced a test to attempt.

import type { DeclaredLossKind } from "@ai-sidekicks/contracts";

import { growthSlateRow, type GrowthSlateRow } from "../../../bridge/index.js";
import { Nothing, WireFigure, formatByteQuantity } from "../../../primitives/index.js";
import { measureUtf8ByteLength } from "../markdown/index.js";

/**
 * The loss this console names when a stored body is a prefix.
 *
 * Typed as `DeclaredLossKind` rather than inferred as its own literal: that is what
 * makes the binding load-bearing. A member renamed in the contract fails here.
 */
const TRUNCATED_LOSS_KIND: DeclaredLossKind = "turn_content_truncated";

/**
 * The slate row that would make a truncated body's remainder obtainable.
 *
 * Read off the ledger through its own accessor rather than spelled as a literal, so
 * the absence points at the row's owner rather than at a shrug. The lookup is total
 * over the id union, so the row is a value and never a maybe.
 */
export const RECOVERABLE_TRUNCATION_SLATE_ROW: GrowthSlateRow =
  growthSlateRow("hydrated-event-read");

/**
 * Whether this console could obtain the rest of a truncated body.
 *
 * A function over the ledger rather than a constant `false`, so the day
 * `hydrated-event-read` flips `wireRegistered` the answer changes with it. It is
 * fail-closed by construction: a row the ledger does not carry could not make this
 * true, and neither can anything a body contains.
 */
export function isTruncatedRemainderRecoverable(): boolean {
  return RECOVERABLE_TRUNCATION_SLATE_ROW.wireRegistered;
}

/**
 * What can be done about the part of the body that is not here.
 *
 * Three arms and no fourth, because the two questions are independent and both are
 * answerable from what the row already carries: can this console fetch a remainder
 * at all, and did the payload record one. `not-carried` is the build's own answer
 * and outranks the second question — with no read to make, whether a remainder was
 * recorded decides nothing a reader could act on.
 */
export type TruncatedRemainderDisposition =
  | { readonly kind: "not-carried" }
  | { readonly kind: "none-recorded" }
  | { readonly kind: "claimable"; readonly remainderByteCount: number };

/**
 * Read the disposition off the gate and the two recorded lengths.
 *
 * Pure and total, taking the gate as an argument rather than calling it: that is
 * what lets a test drive all three arms without reaching into the growth ledger,
 * whose rows are frozen on purpose.
 *
 * `none-recorded` covers both shapes of "nothing to ask for" — a payload that
 * recorded no pre-truncation length, and one whose recorded length does not exceed
 * what was stored. Neither can name a remainder, and a control that fetched zero
 * further bytes would report work that did not happen.
 */
export function truncatedRemainderDisposition(
  isRecoverable: boolean,
  storedByteCount: number,
  preTruncationLength: number | undefined,
): TruncatedRemainderDisposition {
  if (!isRecoverable) {
    return { kind: "not-carried" };
  }
  if (preTruncationLength === undefined || preTruncationLength <= storedByteCount) {
    return { kind: "none-recorded" };
  }
  return { kind: "claimable", remainderByteCount: preTruncationLength - storedByteCount };
}

export interface TruncationNoticeProps {
  readonly storedBody: string;
  readonly preTruncationLength: number | undefined;
  /**
   * Ask for the rest of the body.
   *
   * OPTIONAL, WHICH IS THIS TREE'S EXCEPTION AND NOT ITS RULE — a slot elsewhere in
   * these cards is required and carries `undefined`, so a caller cannot forget it
   * silently. It cannot be that here: no caller on this build can supply one, since
   * the read that would serve a remainder is exactly the wire the gate above says is
   * unregistered. The control it drives is rendered only on the `claimable`
   * disposition, which needs both this handler and that wire, so an absent handler
   * can hide nothing a reader would otherwise have been offered.
   */
  readonly onShowAll?: (() => void) | undefined;
}

/**
 * "Truncated at N of M bytes", and what became of the rest.
 *
 * N is measured from the stored prefix and M is the contract's pre-truncation
 * `contentLength`, echoed from the signed payload. When the payload carries no length —
 * legal, since the descriptive members are optional — the notice says what it knows and
 * does not invent the total, because a total computed from the prefix would be the
 * prefix's own size stated twice.
 */
export function TruncationNotice(props: TruncationNoticeProps): React.JSX.Element {
  const storedByteCount = measureUtf8ByteLength(props.storedBody);
  const storedBytes = formatByteQuantity(storedByteCount);
  const remainder = truncatedRemainderDisposition(
    isTruncatedRemainderRecoverable(),
    storedByteCount,
    props.preTruncationLength,
  );
  // ONE SENTENCE CARRYING BOTH FIGURES, rather than a headline and a `detail`. The
  // badge form renders `detail` as a `title` attribute, so the byte counts — which are
  // the substance of the truncation notice, not an elaboration of it — would reach a reader
  // only on hover. The badge is still the right shape here, because unlike an
  // unavailable body this one IS present and the notice qualifies it.
  const measurement =
    props.preTruncationLength === undefined
      ? `Truncated when recorded. Shown: ${storedBytes.text}; the original size was not recorded.`
      : `Truncated when recorded: ${storedBytes.text} of ${formatByteQuantity(props.preTruncationLength).text}.`;

  return (
    <Nothing
      kind="empty"
      placement="inline"
      title={`${measurement} ${remainderSentence(remainder)}`}
      action={
        <>
          {remainder.kind === "claimable" && props.onShowAll !== undefined ? (
            <button
              type="button"
              className="meridian-truncation-notice__show-all"
              onClick={props.onShowAll}
            >
              Show all
            </button>
          ) : null}
          <WireFigure value={TRUNCATED_LOSS_KIND} title="Declared loss" />
        </>
      }
    />
  );
}

/**
 * What the notice says about the missing part, in one clause per disposition.
 *
 * The `not-carried` clause is deliberately about the BUILD and not about the body:
 * the bytes may well exist in the daemon's own column, and claiming they are gone
 * would be as wrong as implying they are one press away.
 */
function remainderSentence(remainder: TruncatedRemainderDisposition): string {
  switch (remainder.kind) {
    case "not-carried":
      return "The rest of it is not carried to this window.";
    case "none-recorded":
      return "No further content was recorded.";
    case "claimable":
      return `${formatByteQuantity(remainder.remainderByteCount).text} more was recorded.`;
  }
}
