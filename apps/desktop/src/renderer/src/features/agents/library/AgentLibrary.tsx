// The agent definitions page: the agents a person has tuned, so a configuration
// outlives the session it was typed into.
//
// WHAT IS ON THIS PAGE TODAY: THE REGISTRY, READ
//
// The page puts one read in flight on mount and renders whichever of three answers
// comes back — a read still going, a served empty registry, or the rows. Those stay
// apart because they are different facts: "nobody has answered yet" and "there are
// none" are two separate things, and a page that showed an empty list for the first
// would assert something nothing on this machine established.
//
// ONE READ, AND A RE-READ ONLY WHERE SOMETHING MOVED. The list is read on mount and
// again after a delete the daemon applied, which is the one moment this page knows
// the registry changed. Nothing polls. The `not-loaded` absence is entered
// once and never re-entered: a re-read that blanked the list would take rows off the
// screen to show a spinner for data the page is already holding.
//
// DELETE IS TWO STEPS, IN THE ROW. Press Delete and the row asks; press again and
// the call goes out. There is no browser dialog in this console and no dialog of our
// own either — the subject of the question is the row, so the question belongs on
// the row, where a person can still read what they are about to delete. The pending
// state and the re-read on success land there too.
//
// EDIT AND NEW SELECT THE SAME SUBJECT. The view holds a subject with exactly two arms
// — a stored record, or one being composed — and this page supplies whichever was
// asked for. The editor that reads it is not part of this page.
//
// THE TWO STANDING FACTS STAY. They need no wire to be true, and they are what people
// get wrong about a registry like this one.
//
// THE STATE IS NOT HERE. Everything this page holds — the read, the delete in
// flight, the view's refusal per row, and which record the editor is open on — lives in
// `library-view.ts`, because a state machine over the registry calls and a
// body that renders what it settled on are two jobs. This file makes no call
// and holds no `useState`: it reads one snapshot and hands presses back to the view.

import type { ReactNode } from "react";

import type { ConsoleBridge } from "@renderer/console/bridge/console-bridge.js";
import { type AgentRegistryCalls } from "./library-view.js";
import { useAgentLibraryView } from "./hooks/useAgentLibraryView.js";
import { useDefinitionSettlementAnnouncement } from "./hooks/useDefinitionSettlementAnnouncement.js";
import { SavedDefinitions } from "./components/SavedDefinitions.js";

/** One standing fact about the registry, in the two halves a description list wants. */
interface AgentRegistryRule {
  readonly term: string;
  readonly statement: string;
}

/**
 * The two facts, declared once and rendered in order.
 *
 * A list rather than hand-written blocks so the page's claim — that there are
 * exactly two things to know before tuning one — is countable by a test rather
 * than asserted in a comment.
 */
const AGENT_REGISTRY_RULES: readonly AgentRegistryRule[] = [
  {
    term: "Where they live",
    statement:
      "On this machine, and nowhere else. There is no sharing, no sync, and nothing to export.",
  },
  {
    term: "What names them",
    statement:
      "A name is a label, not an identifier. Renaming a sidekick changes nothing that is already running under it.",
  },
];

/** What the page needs: the bridge for its clock and triggers, and the registry calls. */
export interface AgentLibraryProps {
  readonly bridge: ConsoleBridge;
  /** Held stable by the caller: a new object restarts the read. */
  readonly calls: AgentRegistryCalls;
}

/**
 * The page's frame: the heading, the lede and the two standing facts.
 *
 * `actions` sit beside the heading and `children` under the facts; both are what the
 * registry read supplies.
 */
export function AgentDefinitionsFrame(props: {
  readonly actions?: ReactNode;
  readonly children?: ReactNode;
}): React.JSX.Element {
  return (
    <section className="meridian-agent-definitions" aria-label="Sidekicks">
      <header className="meridian-agent-definitions__head">
        <h2 className="meridian-agent-definitions__title">Sidekicks</h2>
        <p className="meridian-agent-definitions__lede">
          A sidekick you have tuned once — its provider, its instructions, its goal, the tools it
          may reach — kept so the next session starts from it instead of from nothing.
        </p>
        {props.actions}
      </header>

      <dl className="meridian-agent-definitions__rules">
        {AGENT_REGISTRY_RULES.map((rule) => (
          <div className="meridian-agent-definitions__rule" key={rule.term}>
            <dt className="meridian-agent-definitions__rule-term">{rule.term}</dt>
            <dd className="meridian-agent-definitions__rule-statement">{rule.statement}</dd>
          </div>
        ))}
      </dl>

      {props.children}
    </section>
  );
}

/** The saved-definitions page: the registry read, its rows, and the delete on each. */
export function AgentLibrary(props: AgentLibraryProps): React.JSX.Element {
  const { view, snapshot } = useAgentLibraryView(props.bridge, props.calls);
  useDefinitionSettlementAnnouncement(snapshot.reading);

  return (
    <AgentDefinitionsFrame
      actions={
        <button
          type="button"
          className="meridian-agent-definitions__new"
          // Pressed rather than merely styled: which subject is selected is state a
          // person has to be able to read.
          aria-pressed={snapshot.editorSubject?.kind === "new"}
          onClick={() => {
            view.openEditor({ kind: "new" });
          }}
        >
          New sidekick
        </button>
      }
    >
      <div className="meridian-agent-definitions__columns">
        <section className="meridian-agent-definitions__column" aria-label="Saved sidekicks">
          <h3 className="meridian-agent-definitions__column-title">Saved</h3>
          <SavedDefinitions snapshot={snapshot} view={view} />
        </section>
      </div>
    </AgentDefinitionsFrame>
  );
}
