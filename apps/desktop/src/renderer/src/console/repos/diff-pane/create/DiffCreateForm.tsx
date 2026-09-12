// Naming the two states a diff is taken between, and sending the create.
//
// TWO FIELDS AND NO DEFAULTS. The create has to identify both compared states, and this
// console holds neither: a base pre-filled
// from something the pane happens to know would put a ref on the wire nobody named, and
// the change set that came back would be attributed to a comparison a person did not
// ask for. The control is held shut until both are named, and the line under it says so
// rather than leaving a dead control.
//
// WHAT THE DIFF WILL BE ATTRIBUTED TO IS DRAWN BEFORE THE CONTROL, because it is the
// one thing about this act a person cannot see from the form. Pretending a workspace
// diff is run-attributed is the pitfall; the attribution line says
// which arm this create will send, and it says so from the resolution the daemon's own
// roots projection answered rather than from the address.
//
// AND A REFUSED RESOLUTION KEEPS THE FORM. `mount-health.ts`'s posture rule: a control
// that vanished would report a capability this subject does not have rather than one
// that is momentarily closed, so the fields stay, the control is shut, and the sentence
// beside it is the daemon's own.

import { useCallback } from "react";

import { InlineRefusal, Nothing, WireFigure } from "../../../primitives/index.js";
import { useSubjectScopedState } from "../../../store/index.js";
import type { ComparedStates } from "../patch-parse.js";
import type { DiffCreationBinding } from "./diff-creation-binding.js";
import { diffCreateStanding, type DiffCreationReading } from "./diff-creation-model.js";

/** Both fields empty — the state a form opens in, and the one a re-mint is seeded at. */
const UNNAMED_COMPARED_STATES: ComparedStates = { baseRef: "", headRef: "" };

export interface DiffCreateFormProps {
  readonly binding: DiffCreationBinding;
}

export function DiffCreateForm(props: DiffCreateFormProps): React.JSX.Element {
  const { binding } = props;
  const { reading, createDiff, clearAct } = binding;
  // THE FIELDS DIE WITH THE CONTROLLER THEY ARE BEING SENT THROUGH, on the prepare
  // form's own reason: the pane is keyed by its address and the controller by its
  // subject, so a re-mint happens underneath a component React never unmounts.
  const { value: comparedStates, publish: publishComparedStates } =
    useSubjectScopedState<ComparedStates>(
      binding.controllerIdentity,
      undefined,
      () => UNNAMED_COMPARED_STATES,
    );
  const standing = diffCreateStanding(reading, comparedStates);

  const nameState = useCallback(
    (named: Partial<ComparedStates>) => {
      // THE ACT ARM IS DROPPED WHENEVER EITHER REF CHANGES, because it belongs to the
      // comparison it was sent for. What that reaches in practice is the REFUSED arm —
      // a settled change set replaces this form rather than sitting above it — and a
      // refusal left standing over a pair nobody names any more reads as a verdict on
      // the pair now in the fields.
      publishComparedStates((current) => ({ ...current, ...named }));
      clearAct();
    },
    [publishComparedStates, clearAct],
  );

  const submit = useCallback(() => {
    createDiff(comparedStates);
  }, [createDiff, comparedStates]);

  return (
    <div className="meridian-diff-create">
      <p className="meridian-diff-create__lead">
        A diff names two states and what it is attributed to. Name both, and this session mints the
        change set between them.
      </p>
      {renderAttribution(reading, binding.retryResolution)}
      <label className="meridian-diff-create__field">
        <span className="meridian-diff-create__legend">Base</span>
        <input
          type="text"
          className="meridian-diff-create__input"
          value={comparedStates.baseRef}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => {
            nameState({ baseRef: event.target.value });
          }}
        />
      </label>
      <label className="meridian-diff-create__field">
        <span className="meridian-diff-create__legend">Head</span>
        <input
          type="text"
          className="meridian-diff-create__input"
          value={comparedStates.headRef}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => {
            nameState({ headRef: event.target.value });
          }}
        />
      </label>
      {renderSettlement(reading)}
      <button
        type="button"
        className="meridian-diff-create__confirm"
        disabled={standing.status !== "sendable"}
        onClick={submit}
      >
        Mint the diff
      </button>
      {standing.status === "held" ? (
        <p className="meridian-diff-create__held" role="status">
          {standing.because}
        </p>
      ) : null}
    </div>
  );
}

/**
 * What this diff would be attributed to, in the wire's own vocabulary.
 *
 * THE MODE IS A WIRE STRING AND WEARS THE PROVENANCE SIGNATURE, rule 4's own claim: it
 * is the discriminant the request will carry, not a word this console chose, and the id
 * beside it is the key the daemon will resolve.
 */
function renderAttribution(reading: DiffCreationReading, onRetry: () => void): React.JSX.Element {
  switch (reading.prerequisite.status) {
    case "not-read":
      return (
        <Nothing
          kind="not-checked"
          title="Nothing has asked what this diff would be attributed to."
        />
      );
    case "reading":
      return <Nothing kind="computing" title="Resolving what this diff would be attributed to." />;
    case "refused":
      return (
        <InlineRefusal
          code={reading.prerequisite.refusal.code}
          detail={reading.prerequisite.refusal.detail}
          action={
            <button type="button" className="meridian-diff-create__retry" onClick={onRetry}>
              Ask again
            </button>
          }
        />
      );
    case "read": {
      const resolved = reading.prerequisite.value;
      return (
        <p className="meridian-diff-create__attribution">
          <WireFigure value={resolved.attributionMode} />
          <WireFigure
            value={
              resolved.attributionMode === "run_attributed" ? resolved.runId : resolved.workspaceId
            }
            title={
              resolved.attributionMode === "run_attributed" ? resolved.runId : resolved.workspaceId
            }
          />
        </p>
      );
    }
  }
}

/** What the create did, for the two arms that are not a rendered change set. */
function renderSettlement(reading: DiffCreationReading): React.JSX.Element | null {
  switch (reading.act.status) {
    case "idle":
    case "created":
      return null;
    case "sending":
      return <Nothing kind="computing" title="Minting the diff." />;
    case "refused":
      return <InlineRefusal code={reading.act.refusal.code} detail={reading.act.refusal.detail} />;
  }
}
