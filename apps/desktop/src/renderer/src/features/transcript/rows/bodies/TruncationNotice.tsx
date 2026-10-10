// The notice a truncated body's prefix carries: "truncated at N of M bytes" and what is known of
// the rest. A prefix alone would read as a complete short answer.

import "./TruncationNotice.css";

import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { byteFigurePart, type FigureSentencePart } from "#renderer/lib/figure-sentence.js";
import { measureUtf8ByteLength } from "#renderer/lib/utf8-byte-length.js";

/**
 * What is known about the part of the body that is not here: whether the payload recorded a
 * pre-truncation length longer than the stored prefix.
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
 * Reads the disposition off the two recorded lengths. `none-recorded` covers a payload with no
 * pre-truncation length and one whose length does not exceed what was stored; naming zero
 * further bytes would report content that does not exist.
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
 * "Truncated at N of M bytes", and what became of the rest. N is measured from the stored
 * prefix, M is the recorded pre-truncation `contentLength`. With no recorded length the notice
 * does not invent a total: one computed from the prefix would be the prefix's own size twice.
 */
export function TruncationNotice(props: TruncationNoticeProps): React.JSX.Element {
  const storedByteCount = measureUtf8ByteLength(props.storedBody);
  // The stored size is the app's measure of the prefix, the original size is the row's record.
  const storedBytes = byteFigurePart("derived", storedByteCount);
  const remainder = truncatedRemainderDisposition(storedByteCount, props.preTruncationLength);
  // One sentence carrying both figures, not a headline plus `detail`: the badge form shows
  // `detail` only in its hover label, so the byte counts would show on hover alone.
  const measurement: readonly FigureSentencePart[] =
    props.preTruncationLength === undefined
      ? ["Truncated when recorded. Shown: ", storedBytes, "; the original size was not recorded."]
      : [
          "Truncated when recorded: ",
          storedBytes,
          " of ",
          byteFigurePart("wire", props.preTruncationLength),
          ".",
        ];

  return (
    <span className="meridian-truncation-notice">
      <Nothing
        kind="empty"
        placement="inline"
        title={[...measurement, " ", ...remainderSentence(remainder)]}
      />
    </span>
  );
}

/** What the notice says about the missing part, in one clause per disposition. */
function remainderSentence(
  remainder: TruncatedRemainderDisposition,
): readonly FigureSentencePart[] {
  switch (remainder.kind) {
    case "none-recorded":
      return ["No further content was recorded."];
    case "claimable":
      // The app's own difference of the two sizes.
      return [byteFigurePart("derived", remainder.remainderByteCount), " more was recorded."];
  }
}
