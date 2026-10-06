// The agent library: the agents a person has tuned, so a configuration outlives the session it
// was typed into. Renders one snapshot from `view.ts`, which owns the read, the delete
// in flight and the editor subject; this file makes no call and holds no state. The list is
// read on mount and again only after a delete the daemon applied. Delete asks in the row, not a
// dialog: the row is the subject, so a person can still read what they are about to delete.

import "./AgentLibrary.css";

import type { ReactNode } from "react";

import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { type AgentRegistryCalls } from "./view.js";
import { useAgentLibraryView } from "./hooks/useAgentLibraryView.js";
import { useDefinitionSettlementAnnouncement } from "./hooks/useDefinitionSettlementAnnouncement.js";
import { SavedDefinitions } from "./components/SavedDefinitions.js";

/** One standing fact about the registry, in the two halves a description list wants. */
interface AgentRegistryRule {
  readonly term: string;
  readonly statement: string;
}

/** The standing facts about the registry, declared once and rendered in order. */
const AGENT_REGISTRY_RULES: readonly AgentRegistryRule[] = [
  {
    term: "Where they live",
    statement:
      "On this machine, and nowhere else. There is no sharing, no sync, and nothing to export.",
  },
  {
    term: "What names them",
    statement:
      "A name is a label, not an identifier. Renaming a sidekick " +
      "changes nothing that is already running under it.",
  },
];

/** What the page needs: the bridge for its clock and triggers, and the registry calls. */
export interface AgentLibraryProps {
  readonly bridge: PlatformBridge;
  /** Held stable by the caller: a new object restarts the read. */
  readonly calls: AgentRegistryCalls;
}

/**
 * The page's frame: heading, lede and the two standing facts. `actions` sit beside the
 * heading and `children` under the facts.
 */
export function AgentDefinitionsFrame(props: {
  readonly actions?: ReactNode;
  readonly children?: ReactNode;
}): React.JSX.Element {
  return (
    <section className="meridian-agent-library" aria-label="Sidekicks">
      <header className="meridian-agent-library__head">
        <h2 className="meridian-agent-library__title">Sidekicks</h2>
        <p className="meridian-agent-library__lede">
          A sidekick you have tuned once — its provider, its instructions, its goal, the tools it
          may reach — kept so the next session starts from it instead of from nothing.
        </p>
        {props.actions}
      </header>

      <dl className="meridian-agent-library__rules">
        {AGENT_REGISTRY_RULES.map((rule) => (
          <div className="meridian-agent-library__rule" key={rule.term}>
            <dt className="meridian-agent-library__rule-term">{rule.term}</dt>
            <dd className="meridian-agent-library__rule-statement">{rule.statement}</dd>
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
          className={
            "meridian-agent-library__new meridian-action-button " +
            "meridian-action-button--compact meridian-action-button--raised"
          }
          // Selection is state a person must be able to read, so it is `aria-pressed`.
          aria-pressed={snapshot.editorSubject?.kind === "new"}
          onClick={() => {
            view.openEditor({ kind: "new" });
          }}
        >
          New sidekick
        </button>
      }
    >
      <div className="meridian-agent-library__columns">
        <section className="meridian-agent-library__column" aria-label="Saved sidekicks">
          <h3 className="meridian-agent-library__column-title">Saved</h3>
          <SavedDefinitions snapshot={snapshot} view={view} />
        </section>
      </div>
    </AgentDefinitionsFrame>
  );
}
