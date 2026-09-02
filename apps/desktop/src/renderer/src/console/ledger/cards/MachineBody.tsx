// A machine-authored body, rendered honestly — the two dispositions of §5.18.
//
// `Spec-023 §Console Design (Meridian)` §5.18 is short and both halves of it are here:
// a TRUNCATED body renders its prefix and says "truncated at N of M bytes", naming the
// declared loss; an UNREADABLE body renders the turn AT ITS POSITION with an empty body
// and the unavailable marker. Neither disposition is silent, and that is the whole
// point — an empty body alone reads as "the author said nothing" and a dropped row
// reads as "the turn never happened", and both are false.
//
// THE TWO MARKER NAMES ARE WIRE VALUES, so they render as wire figures: mono, verbatim,
// exactly the string `DeclaredLossKind` carries. They are bound to that union below
// rather than typed as strings, so a vocabulary rename fails to compile here instead of
// leaving the console displaying a token the daemon stopped using.
//
// WHY THIS IS ONE COMPONENT AND NOT A BRANCH IN EACH CARD. `MessageCard` and `ToolCard`
// both render machine-authored bodies, and §5.18 is a rule about the BODY rather than
// about either card. Two copies would drift the first time a reason was added to
// `HydratedContentUnavailableReason` — which is a closed union precisely so a consumer
// can be made total over it, as `REASON_SENTENCES` below is.

import type {
  DeclaredLossKind,
  HydratedContentUnavailableReason,
  HydratedSessionEventContent,
} from "@ai-sidekicks/contracts";

import { Nothing, WireFigure, formatByteQuantity } from "../../primitives/index.js";
import { AnsiOutput } from "./AnsiOutput.js";
import { StreamingMarkdown } from "./StreamingMarkdown.js";
import { measureUtf8ByteLength, type FootnoteRegistry } from "./markdown/index.js";

/**
 * The loss this console names when a stored body is a prefix.
 *
 * Typed as `DeclaredLossKind` rather than inferred as its own literal: that is what
 * makes the binding load-bearing. A member renamed in the contract fails here.
 */
const TRUNCATED_LOSS_KIND: DeclaredLossKind = "turn_content_truncated";

/** The loss this console names when a stored body could not be read. */
const UNAVAILABLE_LOSS_KIND: DeclaredLossKind = "turn_content_unavailable";

/**
 * How a body is drawn once its bytes are in hand.
 *
 * Two members because the ledger has two machine-authored body shapes and no third:
 * assistant prose, which is markdown, and command output, which is ANSI. A tool whose
 * result is neither still renders as prose — that is the honest default for text whose
 * shape the wire does not declare, and inventing a third kind from the tool's name is
 * the same invention `card-family.ts` refuses.
 */
export const MACHINE_BODY_KINDS = ["prose", "command-output"] as const;

/** One body shape. Derived from the enumeration, never restated. */
export type MachineBodyKind = (typeof MACHINE_BODY_KINDS)[number];

export interface MachineBodyProps {
  /**
   * The hydrated body as the read projection reports it, or `undefined` when this row's
   * body has not been asked for. The three states are distinct and none is the others:
   * not asked, asked and unavailable, asked and available.
   */
  readonly content: HydratedSessionEventContent | undefined;
  /**
   * Text the reveal engine is publishing for this row right now.
   *
   * Present only while the turn streams. It takes precedence over `content` because a
   * live turn HAS no stored body yet, and it carries no truncation marker because
   * nothing has been truncated: the ceiling is applied at append, which has not
   * happened.
   */
  readonly liveText?: string | undefined;
  readonly kind: MachineBodyKind;
  /** The row this body belongs to — the footnote registry's first key half. */
  readonly sourceId: string;
  readonly footnotes: FootnoteRegistry;
  /** What a screen reader calls a command-output block. */
  readonly label: string;
}

export function MachineBody(props: MachineBodyProps): React.JSX.Element {
  if (props.liveText !== undefined) {
    return renderBodyText(props, props.liveText, false);
  }

  if (props.content === undefined) {
    return (
      // `not-checked` and NOT `not-loaded`: the two say different things and only one
      // of them is true here. `not-loaded` is a read in flight — it carries `role`
      // `status`, `aria-busy`, and a skeleton bar, all of which promise a body a beat
      // later. `undefined` content means the body was never ASKED for, so nothing is
      // arriving and a skeleton would be a spinner for work nobody started.
      <Nothing kind="not-checked" placement="inline" title="This body has not been read." />
    );
  }

  if (props.content.status === "unavailable") {
    return <UnavailableBody reason={props.content.reason} />;
  }

  const body = props.content.body;
  const isTruncated = props.content.contentTruncated === true;

  return (
    <div className="meridian-machine-body">
      {renderBodyText(props, body, true)}
      {isTruncated ? (
        <TruncationNotice storedBody={body} preTruncationLength={props.content.contentLength} />
      ) : null}
    </div>
  );
}

/** The body's bytes, through whichever renderer this kind names. */
function renderBodyText(
  props: MachineBodyProps,
  body: string,
  isComplete: boolean,
): React.JSX.Element {
  if (props.kind === "command-output") {
    return <AnsiOutput source={body} label={props.label} />;
  }
  return (
    <StreamingMarkdown
      publishedText={body}
      sourceId={props.sourceId}
      footnotes={props.footnotes}
      isComplete={isComplete}
    />
  );
}

/**
 * A sentence per unavailability reason. Total over the union by construction, so a
 * reason added to the contract fails to compile here rather than reaching a card that
 * renders it as blank space.
 *
 * The sentences say what happened and never what the reader should do about it: three
 * of these six are node-operator conditions and one is a tamper finding, and a card that
 * offered a remedy for any of them would be guessing at a cause it cannot see.
 */
const REASON_SENTENCES: Readonly<Record<HydratedContentUnavailableReason, string>> = {
  absent: "This turn was recorded without a body.",
  compacted: "This turn's body was destroyed when the session was compacted.",
  master_key_unavailable: "This turn's body is sealed and the key could not be obtained.",
  wrapped_key_missing: "This turn's body is sealed and this session holds no key for it.",
  digest_unbound: "This turn's stored body does not match what its signature covers.",
  decrypt_failed: "This turn's body is sealed and did not open.",
};

/**
 * Which reasons are a failure rather than a loss.
 *
 * `digest_unbound` alone: it means the stored bytes disagree with what the row's
 * signature commits to, which is the two-hue rule's red — an integrity finding a reader
 * must not mistake for retention doing its job.
 */
const INTEGRITY_FAILURE_REASONS: ReadonlySet<HydratedContentUnavailableReason> =
  new Set<HydratedContentUnavailableReason>(["digest_unbound"]);

function UnavailableBody(props: {
  readonly reason: HydratedContentUnavailableReason;
}): React.JSX.Element {
  return (
    <div className="meridian-machine-body meridian-machine-body--unavailable">
      {/* The empty body, at its position. Present as an element rather than omitted so
          the row keeps the height and the structure a turn has, which is what "renders
          the turn at its position" means in a list. */}
      <p className="meridian-machine-body__empty" aria-hidden="true" />
      {/* The BLOCK placement, deliberately: the badge form renders `detail` as a
          `title` attribute and nothing else, so both the reason and the disposition
          would be a tooltip — unreachable by touch, by keyboard, and by a reader who
          never hovers. §5.18's requirement is that the console SAYS what happened,
          and an absence occupying the body's own region is a surface rather than a
          value-adjacent badge. */}
      <Nothing
        kind={INTEGRITY_FAILURE_REASONS.has(props.reason) ? "error" : "empty"}
        placement="surface"
        title={REASON_SENTENCES[props.reason]}
        detail="The turn is shown at its position with an empty body."
        action={<WireFigure value={UNAVAILABLE_LOSS_KIND} title="Declared loss" />}
      />
    </div>
  );
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
function TruncationNotice(props: {
  readonly storedBody: string;
  readonly preTruncationLength: number | undefined;
}): React.JSX.Element {
  const storedBytes = formatByteQuantity(measureUtf8ByteLength(props.storedBody));
  // ONE SENTENCE CARRYING BOTH FIGURES, rather than a headline and a `detail`. The
  // badge form renders `detail` as a `title` attribute, so the byte counts — which are
  // the substance of §5.18's notice, not an elaboration of it — would reach a reader
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
