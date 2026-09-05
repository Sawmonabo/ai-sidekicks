// The notice a stored body's prefix carries — "truncated at N of M bytes".
//
// Its own module for the one-component rule. The other half of the honest-body pair
// `MachineBody` composes: a truncated body renders its prefix AND says so, because a
// prefix alone reads as a complete short answer.

import type { DeclaredLossKind } from "@ai-sidekicks/contracts";

import { Nothing, WireFigure, formatByteQuantity } from "../../../primitives/index.js";
import { measureUtf8ByteLength } from "../markdown/index.js";

/**
 * The loss this console names when a stored body is a prefix.
 *
 * Typed as `DeclaredLossKind` rather than inferred as its own literal: that is what
 * makes the binding load-bearing. A member renamed in the contract fails here.
 */
const TRUNCATED_LOSS_KIND: DeclaredLossKind = "turn_content_truncated";

export interface TruncationNoticeProps {
  readonly storedBody: string;
  readonly preTruncationLength: number | undefined;
}

/**
 * "Truncated at N of M bytes."
 *
 * N is measured from the stored prefix and M is the contract's pre-truncation
 * `contentLength`, echoed from the signed payload. When the payload carries no length —
 * legal, since the descriptive members are optional — the notice says what it knows and
 * does not invent the total, because a total computed from the prefix would be the
 * prefix's own size stated twice.
 */
export function TruncationNotice(props: TruncationNoticeProps): React.JSX.Element {
  const storedBytes = formatByteQuantity(measureUtf8ByteLength(props.storedBody));
  // ONE SENTENCE CARRYING BOTH FIGURES, rather than a headline and a `detail`. The
  // badge form renders `detail` as a `title` attribute, so the byte counts — which are
  // the substance of the truncation notice, not an elaboration of it — would reach a reader
  // only on hover. The badge is still the right shape here, because unlike an
  // unavailable body this one IS present and the notice qualifies it.
  const title =
    props.preTruncationLength === undefined
      ? `Truncated when recorded. Shown: ${storedBytes.text}; the original size was not recorded.`
      : `Truncated when recorded: ${storedBytes.text} of ${formatByteQuantity(props.preTruncationLength).text}.`;

  return (
    <Nothing
      kind="empty"
      placement="inline"
      title={title}
      action={<WireFigure value={TRUNCATED_LOSS_KIND} title="Declared loss" />}
    />
  );
}
