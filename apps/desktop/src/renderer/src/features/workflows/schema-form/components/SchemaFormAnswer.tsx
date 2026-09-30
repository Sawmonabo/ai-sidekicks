// The form a parked phase is answered through: its prompt, its controls, and one submit act.
// The schema's verdict is rendered but never disables the act (the daemon judges whether the
// answer is admissible); only `compiling` disables it. It leaves through `schema-form-mounts.ts`
// with its hook and stylesheet; the mounting body owns where the answer goes.

import { SchemaForm } from "./SchemaForm.js";
import { schemaRootRefusal } from "../plan/schema-root-shape.js";
import { useSchemaForm } from "../hooks/useSchemaForm.js";
import { InlineRefusal } from "@renderer/components/Refusal/InlineRefusal.js";
import { Nothing } from "@renderer/components/Nothing/Nothing.js";

/** The props of a parked phase's answer form. */
export interface SchemaFormAnswerProps {
  /** What the phase asks, as its author wrote it. Absent where the wire carried none. */
  readonly prompt: string | undefined;
  /** The schema the answer is shaped by; `undefined` where the wire carried none. */
  readonly inputSchema: unknown;
  /** Send the composed answer. Called with whatever input mode composed it. */
  readonly onSubmit: (answer: unknown) => void;
}

const SUBMIT_LABEL = "Submit answer";

/** One waiting phase's form, or the honest statement that its shape never arrived. */
export function SchemaFormAnswer(props: SchemaFormAnswerProps): React.JSX.Element {
  // Called unconditionally: a hook may not sit behind a branch.
  const form = useSchemaForm(props.inputSchema);
  const rootRefusal = schemaRootRefusal(props.inputSchema);
  // Closed while the compiler chunk is arriving: no verdict exists yet.
  const isAwaitingVerdict = form.validator.status === "compiling";
  return (
    <form
      className="meridian-schema-answer"
      aria-busy={isAwaitingVerdict ? true : undefined}
      onSubmit={(event) => {
        // The answer goes to `onSubmit`; the page must not navigate.
        event.preventDefault();
        props.onSubmit(form.answer);
      }}
    >
      {props.prompt === undefined ? null : (
        <p className="meridian-schema-answer__prompt">{props.prompt}</p>
      )}
      {props.inputSchema === undefined ? (
        <Nothing
          kind="empty"
          placement="inline"
          title="This run did not report what this phase asks for."
          detail="The phase is waiting on a person and its question has not reached this window, so there is nothing to answer here yet."
        />
      ) : rootRefusal !== undefined ? (
        // A root that is not a set of named values cannot be carried by a submission, so the
        // refusal stands where the form and its act would have.
        <InlineRefusal code={rootRefusal.code} detail={rootRefusal.detail} />
      ) : (
        <>
          <SchemaForm form={form} />
          <div className="meridian-schema-answer__act">
            <button
              type="submit"
              className="meridian-schema-answer__submit meridian-action-button meridian-action-button--regular"
              disabled={isAwaitingVerdict}
            >
              {SUBMIT_LABEL}
            </button>
          </div>
        </>
      )}
    </form>
  );
}
