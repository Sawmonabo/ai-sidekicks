// The picker's state and its one act. A pick sends one `session.create` and nothing else: a
// served create closes the picker and hands the session out, which opens it; a refused one keeps
// the picker open with its line under the rows. One create runs at a time
// (`useSessionStartFlight.ts`), and a row picked again after a refusal sends the same key, so a
// create whose answer was lost names the session it made rather than making a second.

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

import type { ExtendedRefusal } from "#renderer/lib/refusal/extensions.js";
import { useSubjectScopedState } from "#renderer/hooks/subject-scoped/useSubjectScopedState.js";
import { useSessionStartFlight } from "../../hooks/useSessionStartFlight.js";
import type { NewSessionControlProps, NewSessionProject } from "../control-contract.js";
import { createPickedSession } from "../create.js";

/** A create the service refused: the row picked, the key it carried and the refusal. */
export interface RefusedPick {
  /** `undefined` for `Just chat`, else the picked project's id. */
  readonly rowKey: string | undefined;
  readonly clientIdempotencyKey: string;
  readonly refusal: ExtendedRefusal;
}

/** What the control draws and every act it offers. */
export interface NewSessionPick {
  readonly isOpen: boolean;
  /** True while a pick's create runs; the rows hold until it answers. */
  readonly isCreating: boolean;
  /** The newest refused pick; closing the picker clears it. */
  readonly refused: RefusedPick | undefined;
  readonly toggle: () => void;
  /** Close the picker and hand the caret back to the New session button. */
  readonly close: () => void;
  /** The New session button, which takes the caret back when the picker closes. */
  readonly openButtonRef: React.RefObject<HTMLButtonElement | null>;
  /** The picker's first row, which takes the caret when the picker opens. */
  readonly firstRowRef: React.RefObject<HTMLButtonElement | null>;
  /** Make a session where `project` says, or a chat where it is `undefined`. */
  readonly pick: (project: NewSessionProject | undefined) => void;
}

/** Hold the picker and send the one create a pick makes. */
export function useNewSessionPick(props: NewSessionControlProps): NewSessionPick {
  const { bridge, lead, onSessionCreated } = props;
  const picker = useSubjectScopedState<PickerState>(bridge, undefined, () => CLOSED);
  const publish = picker.publish;
  const flight = useSessionStartFlight(bridge, true);

  // The callback as of the last commit, so a fresh function each pass changes no act's identity.
  const committedSessionCreated = useRef(onSessionCreated);
  useLayoutEffect(() => {
    committedSessionCreated.current = onSessionCreated;
  });

  const toggle = useCallback(() => {
    publish((held) => (held.isOpen ? CLOSED : { isOpen: true, refused: undefined }));
  }, [publish]);

  const openButtonRef = useRef<HTMLButtonElement | null>(null);
  const firstRowRef = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => {
    publish(CLOSED);
    openButtonRef.current?.focus();
  }, [publish]);
  // An opened picker puts the caret on its first row, so a pick is one key away.
  const isOpen = picker.value.isOpen;
  useEffect(() => {
    if (isOpen) {
      firstRowRef.current?.focus();
    }
  }, [isOpen]);

  const { admit, settle } = flight;
  const refused = picker.value.refused;
  const pick = useCallback(
    (project: NewSessionProject | undefined) => {
      if (!admit()) {
        return;
      }
      const rowKey = project?.projectId;
      const clientIdempotencyKey =
        refused !== undefined && refused.rowKey === rowKey
          ? refused.clientIdempotencyKey
          : crypto.randomUUID();
      void createPickedSession(bridge, { project, lead, clientIdempotencyKey }).then((reply) => {
        settle();
        if (reply.status === "refused") {
          publish({
            isOpen: true,
            refused: { rowKey, clientIdempotencyKey, refusal: reply.refusal },
          });
          return;
        }
        publish(CLOSED);
        committedSessionCreated.current(reply.value.sessionId);
      });
    },
    [admit, bridge, lead, publish, refused, settle],
  );

  return {
    isOpen,
    isCreating: flight.isOutstanding,
    refused,
    toggle,
    close,
    openButtonRef,
    firstRowRef,
    pick,
  };
}

/** The picker as it stands for one bridge. */
interface PickerState {
  readonly isOpen: boolean;
  readonly refused: RefusedPick | undefined;
}

/** A closed picker, with no refusal standing. */
const CLOSED: PickerState = { isOpen: false, refused: undefined };
