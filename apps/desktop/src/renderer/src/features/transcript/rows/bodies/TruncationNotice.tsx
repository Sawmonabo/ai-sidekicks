// The notice a stored body's prefix carries — "truncated at N of M bytes", and how much
// of the rest the payload recorded.
//
// Its own module for the one-component rule. The other half of the honest-body pair
// `MachineBody` composes: a truncated body renders its prefix AND says so, because a
// prefix alone reads as a complete short answer.
//
// AND IT SAYS WHAT IS KNOWN OF THE REST OF THE BODY. "Truncated when recorded" tells a
// reader the body is a prefix and says nothing about the remainder, so the notice is
// total over two dispositions of it: the payload recorded a longer original and names how
// much more, or it recorded no remainder.
//
// WHY THE DISPOSITION IS A VALUE. It is computed by a pure function over the stored
// prefix's byte count and the recorded pre-truncation length, so both arms are drivable
// without rendering.

import type { DeclaredLossKind } from "@ai-sidekicks/contracts";

import { Nothing, WireFigure, formatByteQuantity } from "@renderer/console/primitives/index.js";
import { measureUtf8ByteLength } from "@renderer/lib/utf8-byte-length.js";

/**
 * The loss this console names when a stored body is a prefix.
 *
 * Typed as `DeclaredLossKind` rather than inferred as its own literal: that is what
 * makes the binding load-bearing. A member renamed in the contract fails here.
 */
const TRUNCATED_LOSS_KIND: DeclaredLossKind = "turn_content_truncated";

/**
 * What is known about the part of the body that is not here.
 *
 * Two arms and no third, both answerable from what the row already carries: whether the
 * payload recorded a pre-truncation length longer than the stored prefix.
 */
export type TruncatedRemainderDisposition =
  | { readonly kind: "none-recorded" }
  | { readonly kind: "claimable"; readonly remainderByteCount: number };

/** What a truncated stored body carries: the prefix itself and the recorded original length. */
export interface TruncationNoticeProps {
  readonly storedBody: string;
  readonly preTruncationLength: number | undefined;
}

/**
 * Read the disposition off the two recorded lengths.
 *
 * `none-recorded` covers both shapes of "no remainder" — a payload that recorded no
 * pre-truncation length, and one whose recorded length does not exceed what was stored.
 * Neither can name a remainder, and naming zero further bytes would report content that
 * does not exist.
 */
export function truncatedRemainderDisposition(
  storedByteCount: number,
  preTruncationLength: number | undefined,
): TruncatedRemainderDisposition {
  if (preTruncationLength === undefined || preTruncationLength <= storedByteCount) {
    return { kind: "none-recorded" };
  }
  return { kind: "claimable", remainderByteCount: preTruncationLength - storedByteCount };
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
  const remainder = truncatedRemainderDisposition(storedByteCount, props.preTruncationLength);
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
      action={<WireFigure value={TRUNCATED_LOSS_KIND} title="Declared loss" />}
    />
  );
}

/** What the notice says about the missing part, in one clause per disposition. */
function remainderSentence(remainder: TruncatedRemainderDisposition): string {
  switch (remainder.kind) {
    case "none-recorded":
      return "No further content was recorded.";
    case "claimable":
      return `${formatByteQuantity(remainder.remainderByteCount).text} more was recorded.`;
  }
}
