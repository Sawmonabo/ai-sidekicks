// The configuration a sidekick was attached under, drawn as the card reads it.
//
// Split out of `AgentCard.tsx` because it answers a different question: the card
// draws an agent's LIVE state — its binding, its run, the axes it is switching — and
// this draws the snapshot taken once at attach and never re-read. The two change for
// different reasons, and the file that held both was long enough that a reader
// looking for one had to scroll past the other.
//
// THE ECHO IS NEVER RE-READ FROM THE DEFINITION REGISTRY. The attach echo is the
// only read: the registry row may already have moved, and an echo naming NO
// definition is never attributed to one, because an inline attach resolves a
// configuration too.

import { WireFigure, formatCount } from "../primitives/index.js";
import { RESOLVED_PROSE_INLINE_CAP, TOOL_ALLOWLIST_NAMED_CAP } from "../core/index.js";
import type { AgentResolvedConfiguration } from "../bridge/index.js";

/**
 * The echo captured at attach. Fixed for the agent's life; never re-read.
 *
 * The definition row and the note turn on whether one was NAMED, because the echo is
 * present either way and an inline attach has no row to edit or delete.
 *
 * THE NOTE SITS OUTSIDE THE LIST. A `<dl>` admits `<dt>`/`<dd>` pairs and the
 * `<div>` groups that wrap them, and nothing else — a `<p>` among them is content an
 * accessibility validator flags and a screen reader may fold into the preceding
 * description, so the note would be heard as part of the goal it follows. It is
 * prose ABOUT the list rather than a term in it, which is why it becomes a sibling
 * rather than a term/description group: inventing a `<dt>` to hold it would be
 * naming a definition nothing defines.
 */
export function ResolvedConfigurationEcho(props: {
  readonly resolved: AgentResolvedConfiguration;
  readonly definitionId: string | undefined;
}): React.JSX.Element {
  const { resolved } = props;
  return (
    <>
      <dl className="meridian-agent-card__resolved">
        {props.definitionId === undefined ? null : (
          <div className="meridian-agent-card__resolved-row">
            <dt>Definition</dt>
            <dd>
              <WireFigure value={props.definitionId} />
            </dd>
          </div>
        )}
        <div className="meridian-agent-card__resolved-row">
          <dt>Execution posture</dt>
          <dd>
            {resolved.executionPostureMode === undefined ? (
              <span className="meridian-agent-card__axis-absent">not reported</span>
            ) : (
              <WireFigure value={resolved.executionPostureMode} />
            )}
          </dd>
        </div>
        <div className="meridian-agent-card__resolved-row">
          <dt>Tools</dt>
          <dd>
            <ToolAllowlist allowlist={resolved.toolAllowlist} />
          </dd>
        </div>
        <ProseRow label="Instructions" text={resolved.instructions} />
        <ProseRow label="Goal" text={resolved.goal} />
      </dl>
      <p className="meridian-agent-card__snapshot-note">
        {props.definitionId === undefined
          ? "This is what the attach resolved to, captured then. No definition was named, so there is none to edit, and no update carries these four axes."
          : "This is a snapshot taken when the agent was attached. Editing or deleting the definition afterwards reaches this agent never, and no update carries these four axes."}
      </p>
    </>
  );
}

/**
 * The tool allowlist as applied — presence first, emptiness second.
 *
 * An ABSENT member is the daemon not reporting the axis. A PRESENT empty array is
 * the applied configuration "no tools at all", which is a restriction somebody chose
 * and the strictest posture this agent can have. Rendering them alike would be the
 * conflation the whole card exists to refuse. The empty case is a derived sentence
 * rather than a wire figure because there is no wire value to print.
 */
function ToolAllowlist(props: {
  readonly allowlist: readonly string[] | undefined;
}): React.JSX.Element {
  const { allowlist } = props;
  if (allowlist === undefined) {
    return <span className="meridian-agent-card__axis-absent">not reported</span>;
  }
  if (allowlist.length === 0) {
    return (
      <span className="meridian-agent-card__axis-derived">
        No tools. This agent was attached with an empty allowlist.
      </span>
    );
  }
  return (
    <>
      {allowlist.slice(0, TOOL_ALLOWLIST_NAMED_CAP).map((toolName) => (
        <WireFigure key={toolName} value={toolName} />
      ))}
      {allowlist.length > TOOL_ALLOWLIST_NAMED_CAP
        ? ` and ${formatCount(allowlist.length - TOOL_ALLOWLIST_NAMED_CAP)} more`
        : null}
    </>
  );
}

function ProseRow(props: {
  readonly label: string;
  readonly text: string | undefined;
}): React.JSX.Element {
  return (
    <div className="meridian-agent-card__resolved-row">
      <dt>{props.label}</dt>
      <dd>
        {props.text === undefined ? (
          <span className="meridian-agent-card__axis-absent">not reported</span>
        ) : (
          clampProse(props.text)
        )}
      </dd>
    </div>
  );
}

/** Leading prose, clamped at the named bound. Never re-wrapped and never summarized. */
function clampProse(text: string): string {
  return text.length <= RESOLVED_PROSE_INLINE_CAP
    ? text
    : `${text.slice(0, RESOLVED_PROSE_INLINE_CAP)}…`;
}
