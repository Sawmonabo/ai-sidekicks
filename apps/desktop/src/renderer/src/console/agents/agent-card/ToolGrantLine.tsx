// The per-agent tool grant, on the card, with the ceiling it cannot raise named
// beside it.
//
// `Spec-023 §Console Design (Meridian)`'s tool-governance section puts the per-agent
// control here and the node-wide one in settings, and this line is the first place
// the two have ever been named together: the allowlist filters the browser's page
// tool set exactly as it filters any other tool source, and a node-wide switch
// withholds that set from every subsequent spawn on this node — which an allowlist
// cannot turn back on. Neither half is a control here. A person changes the first by
// attaching with a different definition and the second on the browser settings page.
//
// WHY THIS IS ITS OWN LINE AND NOT A ROW IN THE ECHO. The echo answers "what did the
// attach resolve to", and every axis in it is a provider axis a switch can later
// move. This answers "what may this agent reach", which is a governance question with
// a ceiling above it, and it is the only one of the two a reader needs without
// opening a disclosure. The tool NAMES stay in the echo and are not repeated here —
// `tool-grant.ts` records why the populated arm carries a count instead.
//
// THE SENTENCE IS UNCONDITIONAL AND THE POSITION IS NOT. Every position sits under
// the same two consequences, so the consequence is rendered once beneath the line
// rather than four times inside it, and a position this build does not recognise
// cannot lose it. It carries a class of its own rather than the echo's snapshot
// note: the two say different things and a shared selector would make the first
// one on the card answer for both.

import { Nothing, formatCount } from "../../primitives/index.js";
import { type AgentToolGrantPosition } from "./tool-grant.js";

/**
 * What each position says, in the console's own words.
 *
 * `not-reported` is deliberately absent: it renders an absence rather than a
 * sentence, because there is nothing to say about a list nobody sent.
 */
function positionSentence(position: AgentToolGrantPosition): React.JSX.Element {
  switch (position.kind) {
    case "not-reported":
      return (
        <Nothing
          kind="not-checked"
          placement="inline"
          title="Not reported"
          detail="This roster reply carried identity and lifecycle and no resolved configuration, so what this agent may reach was not answered."
        />
      );
    case "driver-default":
      // Muted, like every other axis whose absence MEANS something: nobody restricted
      // this agent, and the driver's own set is what it was spawned with.
      return (
        <span className="meridian-agent-card__axis-absent">
          The driver&apos;s default tool set. Nothing was withheld at attach.
        </span>
      );
    case "no-tools":
      // Full weight, because an empty allowlist is a restriction somebody chose and
      // is the strictest posture an agent can carry — never an absence.
      return (
        <span className="meridian-agent-card__axis-derived">
          No tools. This agent was attached with an empty allowlist.
        </span>
      );
    case "named":
      // An explicit one-tool arm, because the console has one figure formatter and no
      // pluralizer: a count folded into prose has to agree with its noun, and
      // `${formatCount(1)} tools` reads "the 1 tools" — the same arm
      // `sessions/notifications/attention-sentences.ts` takes for one session.
      return (
        <span className="meridian-agent-card__axis-derived">
          {position.toolCount === 1
            ? "Restricted to the one tool it was attached with, named in the resolved configuration below."
            : `Restricted to the ${formatCount(position.toolCount)} tools it was attached with, named in the resolved configuration below.`}
        </span>
      );
  }
}

export function ToolGrantLine(props: {
  readonly position: AgentToolGrantPosition;
}): React.JSX.Element {
  return (
    <>
      <p className="meridian-agent-card__tool-grant">
        <span className="meridian-agent-card__line-label">Tool grant</span>{" "}
        {positionSentence(props.position)}
      </p>
      <p className="meridian-agent-card__grant-note">
        Applied at spawn and filtering the browser page tool set like any other source; a node-wide
        switch on the browser settings page withholds those tools from every later spawn here, and
        an allowlist cannot turn them back on.
      </p>
    </>
  );
}
