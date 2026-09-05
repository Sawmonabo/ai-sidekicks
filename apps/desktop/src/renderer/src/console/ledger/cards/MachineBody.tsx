// A machine-authored body, rendered honestly — its two dispositions, both here.
//
// THE RULE IS THIS MODULE'S, because no committed document states it: a TRUNCATED body
// renders its prefix and says "truncated at N of M bytes", naming the declared loss; an
// UNREADABLE body renders the turn AT ITS POSITION with an empty body and the
// unavailable marker. Neither disposition is silent, and that is the whole
// point — an empty body alone reads as "the author said nothing" and a dropped row
// reads as "the turn never happened", and both are false. `Spec-023 §Meridian, the
// design language` rule 6 is why they are both said out loud ("absences name their kind
// and their escape hatch") and rule 8 is why they are two and not one ("a renderer that
// collapses two of these into one is wrong").
//
// THE DISPOSITIONS ARE TWO MODULES AND THE CHOICE BETWEEN THEM IS THIS ONE.
// `UnavailableBody.tsx` and `TruncationNotice.tsx` each own one, with the marker name
// it names bound to `DeclaredLossKind` rather than typed as a string, so a vocabulary
// rename fails to compile there instead of leaving the console displaying a token the
// daemon stopped using. What stays here is the three-state read — not asked, asked and
// unavailable, asked and available — which is the decision neither notice can make.
//
// WHY THIS IS ONE COMPONENT AND NOT A BRANCH IN EACH CARD. `MessageCard` and `ToolCard`
// both render machine-authored bodies, and the rule above is about the BODY rather than
// about either card. Two copies would drift the first time a reason was added to
// `HydratedContentUnavailableReason` — which is a closed union precisely so a consumer
// can be made total over it, as `REASON_SENTENCES` below is.

import type { HydratedSessionEventContent } from "@ai-sidekicks/contracts";

import { Nothing } from "../../primitives/index.js";
import { AnsiOutput } from "./AnsiOutput.js";
import { StreamingMarkdown } from "./StreamingMarkdown.js";
import { TruncationNotice } from "./TruncationNotice.js";
import { UnavailableBody } from "./UnavailableBody.js";
import { type FootnoteRegistry } from "./markdown/index.js";

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
