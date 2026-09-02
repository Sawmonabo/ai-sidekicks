// The sidekicks page: the sidekicks a person has tuned, so a configuration
// outlives the session it was typed into.
//
// WHAT IS ON THIS PAGE TODAY, AND WHY IT IS NOT A LIST
//
// The page's whole subject is a stored record, and this repository registers no way
// to read one. `packages/contracts` carries no method, response type, or error code
// for the sidekick-definition registry; the console's growth port carries no
// operation for it and its slate names no row it could be reached through. So there
// is no read to put in flight, no refusal to render, and no row shape to project —
// and the console's rule for exactly this case is rule 8's fourth absence: NOBODY
// ASKED. That is not an empty list, and rendering one would assert a fact — that
// this person has saved no sidekicks — that nothing on this machine has established.
//
// The console does not draw a create control either. A lifecycle control whose verb
// is not registered is not drawn (`Spec-023 §Console Design (Meridian)` §The surface
// set says so of the session list, and the reason carries: a button that can only
// fail is worse than no button). The page therefore offers no action at all, which
// is the honest count of the actions it can complete.
//
// WHAT IS ON IT INSTEAD
//
// The three facts a person needs before they tune a sidekick, none of which needs a
// wire to be true, and all three of which are the facts people get wrong about a
// registry like this one: where the records live, what names them, and what editing
// one reaches. `Spec-030 §State And Data Implications` fixes the first; the
// attach-time snapshot rule fixes the third. Stating them where the records will be
// is what makes the page teach rather than wait.

import { Nothing } from "../primitives/index.js";
import {
  SIDEKICK_DEFINITION_RECORD_EDITOR_SLOT,
  SidekickDefinitionRecordEditorMount,
} from "./DefinitionEditorSlot.js";

/** One standing fact about the registry, in the two halves a description list wants. */
interface SidekickRegistryRule {
  readonly term: string;
  readonly statement: string;
}

/**
 * The three facts, declared once and rendered in order.
 *
 * A list rather than three hand-written blocks so the page's claim — that there are
 * exactly three things to know before tuning one — is countable by a test rather
 * than asserted in a comment.
 */
const SIDEKICK_REGISTRY_RULES: readonly SidekickRegistryRule[] = [
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
  {
    term: "What editing reaches",
    statement:
      "Nothing already attached. A sidekick keeps the configuration it was given when it joined a session, for the rest of its life — so editing or deleting one here is safe.",
  },
];

/**
 * The page.
 *
 * Takes no props: it reads nothing, writes nothing, and navigates nowhere, because
 * every verb it would use is unregistered. The day the registry read lands it grows
 * a bridge, and the day the attach picker links into it it grows a handler — both
 * of which are additions to a shape a mount already has, rather than a rewrite.
 */
export function SidekickDefinitionsPage(): React.JSX.Element {
  return (
    <section className="meridian-sidekicks" aria-label="Sidekicks">
      <header className="meridian-sidekicks__head">
        <h2 className="meridian-sidekicks__title">Sidekicks</h2>
        <p className="meridian-sidekicks__lede">
          A sidekick you have tuned once — its provider, its instructions, its goal, the tools it
          may reach — kept so the next session starts from it instead of from nothing.
        </p>
      </header>

      <dl className="meridian-sidekicks__rules">
        {SIDEKICK_REGISTRY_RULES.map((rule) => (
          <div className="meridian-sidekicks__rule" key={rule.term}>
            <dt className="meridian-sidekicks__rule-term">{rule.term}</dt>
            <dd className="meridian-sidekicks__rule-statement">{rule.statement}</dd>
          </div>
        ))}
      </dl>

      <div className="meridian-sidekicks__columns">
        <section className="meridian-sidekicks__column" aria-label="Saved sidekicks">
          <h3 className="meridian-sidekicks__column-title">Saved</h3>
          <Nothing
            kind="not-checked"
            placement="surface"
            title="The saved sidekicks have not been read."
            detail="Nothing has been asked for them: this build has no way to read one back. Attaching a sidekick to a session works inline in the meantime, and needs none of this."
          />
        </section>

        <section className="meridian-sidekicks__column" aria-label="Sidekick detail">
          <h3 className="meridian-sidekicks__column-title">Detail</h3>
          <SidekickDefinitionRecordEditorMount
            slot={SIDEKICK_DEFINITION_RECORD_EDITOR_SLOT}
            // Nothing can be selected while nothing can be listed. The seat carries
            // the subject anyway, because the subject is what the mount owes the
            // body and a contract stated only when it is exercised is a contract
            // discovered late.
            subject={undefined}
          />
        </section>
      </div>
    </section>
  );
}
