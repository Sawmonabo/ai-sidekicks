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
//
// AND THE THIRD DISPOSITION IS THE ONE THE WIRE ASKED FOR. `AssistantOutputPayload`
// carries `contentType` — the producer's own media type, set by the layer that knows what
// it emitted — and this module read none of it: the renderer was chosen from the bytes
// alone, so a `text/plain` reply carrying `*literal*` was reformatted into emphasis and a
// markdown reply carrying one escape sequence went through the terminal renderer whole.
// The declaration decides where there is one, and the byte reading answers for the rows
// that carry none, which is the whole tool trio.

import type { HydratedSessionEventContent } from "@ai-sidekicks/contracts";

import { Nothing } from "../../../primitives/index.js";
import { AnsiOutput } from "../ansi/AnsiOutput.js";
import { carriesAnsiEscapes, withoutResidualEscapes } from "../ansi/escape-sequences.js";
import { StreamingMarkdown } from "./StreamingMarkdown.js";
import { TruncationNotice } from "./TruncationNotice.js";
import { UnavailableBody } from "./UnavailableBody.js";
import { type FootnoteRegistry } from "../markdown/index.js";

/**
 * How a body is drawn once its bytes are in hand.
 *
 * THREE MEMBERS, one per renderer this module can reach: `prose` is markdown,
 * `command-output` is ANSI, and `plain-text` is the arm that interprets nothing — the
 * honest disposition for a body whose producer declared a media type this console has no
 * renderer for, and for `text/plain`, where reformatting is itself the defect.
 *
 * `plain-text` IS NOT A THIRD GUESS. Nothing infers it: it is reached only from a
 * DECLARED media type, so the kind grows without widening what the console invents about
 * a body nobody described — deriving a shape from a tool's name stays the invention
 * `card-family.ts` refuses.
 */
export const MACHINE_BODY_KINDS = ["prose", "plain-text", "command-output"] as const;

/** One body shape. Derived from the enumeration, never restated. */
export type MachineBodyKind = (typeof MACHINE_BODY_KINDS)[number];

/**
 * The declared media types this console renders as markdown.
 *
 * Both spellings, because `text/x-markdown` is what producers predating the media type's
 * registration still emit and a reader cannot tell the two apart by looking at the body.
 */
const MARKDOWN_MEDIA_TYPES: readonly string[] = ["text/markdown", "text/x-markdown"];

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
  /**
   * The media type the PRODUCER declared for this body, where it declared one.
   *
   * `AssistantOutputPayload.contentType` and nothing else: the tool trio carries no such
   * member, so a tool card passes nothing here and the body's bytes decide instead. It is
   * a free-form wire string rather than a closed union, which is why the reading above
   * normalises it rather than switching on it.
   */
  readonly contentType?: string | undefined;
  /** The row this body belongs to — the footnote registry's first key half. */
  readonly sourceId: string;
  readonly footnotes: FootnoteRegistry;
  /** What a screen reader calls a command-output block. */
  readonly label: string;
}

/**
 * Which renderer a body takes — its producer's declaration first, then its bytes.
 *
 * THE DECLARATION WINS WHERE THERE IS ONE, and the ordering is the decision. A producer
 * that says `text/markdown` knows what it emitted; the ANSI bytes that can ride along
 * inside such a body are terminal residue the declared type does not cover, so they are
 * stripped by the caller and the markdown structure is still drawn. Reading them instead
 * as "this is command output" throws that structure away for one stray byte, which is the
 * defect this reading exists to remove.
 *
 * AN UNRECOGNISED DECLARATION TAKES THE PLAIN ARM rather than falling back to the byte
 * reading. `application/json` is not prose and is not a terminal stream, and a console
 * that guessed at it would be interpreting a body its producer described precisely.
 *
 * AN ABSENT DECLARATION TAKES THE BYTES, which is the whole tool trio: `ToolActivityPayload`
 * carries a tool name, a call id, a duration and the content descriptors and no content
 * type, and `HydratedSessionEventContent` carries the bytes and no type either. There the
 * bytes are the only reading the wire supplies — a body carrying an escape IS command
 * output, and one carrying none renders as prose.
 */
export function machineBodyKindOf(
  body: string,
  declaredMediaType?: string | undefined,
): MachineBodyKind {
  if (declaredMediaType !== undefined) {
    // Markdown is the one declared type with a renderer of its own. `text/plain` and
    // every unrecognised declaration land on the same arm deliberately: both mean "do
    // not interpret these bytes", and splitting them would be two names for one act.
    return MARKDOWN_MEDIA_TYPES.includes(declaredEssence(declaredMediaType))
      ? "prose"
      : "plain-text";
  }
  return carriesAnsiEscapes(body) ? "command-output" : "prose";
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

/**
 * The essence of a declared media type — its type and subtype, lowercased.
 *
 * `contentType` is a free-form wire string, so the value arrives as the producer spelled
 * it: `text/markdown; charset=utf-8` and `TEXT/MARKDOWN` are the same declaration, and a
 * comparison against the raw member would answer "unrecognised" for both. Parameters are
 * dropped rather than parsed — none of them bears on which renderer the body takes.
 */
function declaredEssence(declaredMediaType: string): string {
  const [essence = ""] = declaredMediaType.split(";");
  return essence.trim().toLowerCase();
}

/**
 * The body's bytes, through whichever renderer its shape names.
 *
 * THE STRIP RUNS FOR THE TWO DECLARED ARMS AND NEVER FOR THE ANSI ONE, which is the
 * ordering `escape-sequences.ts` states from its own side: the terminal pipeline removes
 * residue AFTER `anser` has parsed the styling out of it, and a pre-pass over the source
 * would take the sequences carrying that styling with it and render a build log in one
 * colour. A body whose producer declared markdown or plain text is not a terminal stream
 * at all, so the control bytes that rode along with it are residue in the same sense and
 * are removed before the renderer that cannot interpret them ever sees them. A body
 * carrying no escape comes back by identity, so ordinary prose pays nothing.
 */
function renderBodyText(
  props: MachineBodyProps,
  body: string,
  isComplete: boolean,
): React.JSX.Element {
  const kind = machineBodyKindOf(body, props.contentType);
  if (kind === "command-output") {
    return <AnsiOutput source={body} label={props.label} />;
  }
  const declaredText = withoutResidualEscapes(body);
  if (kind === "plain-text") {
    // No footnote registration and no parse: a plain-text body is its own bytes, and the
    // sheet is what keeps its line breaks and its runs of spaces.
    return <p className="meridian-machine-body__plain">{declaredText}</p>;
  }
  return (
    <StreamingMarkdown
      publishedText={declaredText}
      sourceId={props.sourceId}
      footnotes={props.footnotes}
      isComplete={isComplete}
    />
  );
}
