// The picker's state and its one act. A pick sends one `session.create` and nothing else: a
// served create closes the picker and hands the session out, which opens it; a refused one keeps
// an open picker open with its line under the rows, and asks the sessions list to read again, since
// a create whose answer was lost may still have made a session. One create runs at a time
// (`useSessionStartFlight.ts`), and a row picked again on the same lead before a create of it was
// served sends the same key, so a lost create names the session it made rather than making a second.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { SessionLead } from "@ai-sidekicks/contracts/session/directory";

import type { ExtendedRefusal } from "#renderer/lib/refusal/extensions.js";
import { useSubjectScopedState } from "#renderer/hooks/subject-scoped/useSubjectScopedState.js";
import { useSessionStartFlight } from "../../hooks/useSessionStartFlight.js";
import type { NewSessionControlProps, NewSessionProject } from "../control-contract.js";
import { createPickedSession } from "../create.js";

/** What the control draws and every act it offers. */
export interface NewSessionPick {
  readonly isOpen: boolean;
  /** True while a pick's create runs; the rows hold until it answers. */
  readonly isCreating: boolean;
  /** The newest refused create's refusal; closing the picker clears it. */
  readonly refusal: ExtendedRefusal | undefined;
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
  const { bridge, lead } = props;
  const picker = useSubjectScopedState<PickerState>(bridge, undefined, () => CLOSED);
  const publish = picker.publish;
  const flight = useSessionStartFlight(bridge);
  const [unsettledKeys] = useState(() => new UnsettledCreateKeys());

  // The callbacks as of the last commit, so a fresh function each pass changes no act's identity.
  const committedProps = useRef(props);
  useLayoutEffect(() => {
    committedProps.current = props;
  });

  const toggle = useCallback(() => {
    publish((held) => (held.isOpen ? CLOSED : { isOpen: true, refusal: undefined }));
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
  const pick = useCallback(
    (project: NewSessionProject | undefined) => {
      if (!admit()) {
        return;
      }
      const createKey = unsettledKeys.keyFor(project, lead);
      void createPickedSession(bridge, { project, lead, clientIdempotencyKey: createKey }).then(
        (reply) => {
          settle();
          if (reply.status === "refused") {
            // A refusal that lands after the person closed the picker leaves it closed.
            publish((held) => (held.isOpen ? { isOpen: true, refusal: reply.refusal } : held));
            committedProps.current.recheckDirectory();
            return;
          }
          unsettledKeys.forget(project, lead);
          publish(CLOSED);
          committedProps.current.onSessionCreated(reply.value.sessionId);
        },
      );
    },
    [admit, bridge, lead, publish, settle, unsettledKeys],
  );

  return {
    isOpen,
    isCreating: flight.isOutstanding,
    refusal: picker.value.refusal,
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
  readonly refusal: ExtendedRefusal | undefined;
}

/** A closed picker, with no refusal standing. */
const CLOSED: PickerState = { isOpen: false, refusal: undefined };

/**
 * The key of each row and lead's last create that was not served, held for the control's mount:
 * picked again, that row on that lead sends the same key, so the service answers with any session
 * the unanswered create made. A served create drops its row's key.
 */
class UnsettledCreateKeys {
  readonly #keys = new Map<string, string>();

  /** The key a create of `project` on `lead` carries: its unsettled one, or a fresh one kept. */
  public keyFor(project: NewSessionProject | undefined, lead: SessionLead): string {
    const pickKey = pickKeyOf(project, lead);
    const held = this.#keys.get(pickKey);
    if (held !== undefined) {
      return held;
    }
    const minted = crypto.randomUUID();
    this.#keys.set(pickKey, minted);
    return minted;
  }

  /** Drop the key of `project` on `lead` once its create was served. */
  public forget(project: NewSessionProject | undefined, lead: SessionLead): void {
    this.#keys.delete(pickKeyOf(project, lead));
  }
}

/** One row on one lead: the picked project's id, or none for `Just chat`, and the lead's parts. */
function pickKeyOf(project: NewSessionProject | undefined, lead: SessionLead): string {
  return JSON.stringify([project?.projectId ?? null, lead.providerName, lead.modelId, lead.effort]);
}
