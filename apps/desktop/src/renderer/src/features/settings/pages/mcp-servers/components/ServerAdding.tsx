import { useState, type ReactNode } from "react";

import type {
  McpServerConfigInput,
  McpWritableBindingRef,
} from "@ai-sidekicks/contracts/mcp/server";
import type { Clock } from "#renderer/lib/clock.js";
import type { SessionDirectoryState } from "#renderer/store/session/directory/state.js";
import type { McpMutationOutcome, SearchMcpRegistry } from "../mutation.js";
import { EMPTY_SERVER_DRAFT, serverDraftOf, type ServerDraft } from "../server-draft.js";
import { AddServerForm } from "./AddServerForm.js";
import { BrowseServers } from "./BrowseServers.js";
import { MutationOutcomeLine } from "./MutationOutcomeLine.js";
import type { ProjectListReading } from "./ProjectListStatus.js";

/**
 * `Add a server` and `Browse servers` under the page's one line about them, and whichever of the
 * two is open: the registry search, or the add form, empty or filled in from the registry result
 * picked. Each opening of the form has its own number, never one an earlier opening had, and its
 * own outcome, so an answer settles only the form that sent it. A server the service took closes
 * its form, and its settle lines stand under the line until the next `Add a server` or `Browse
 * servers`; a send still on its way when its form closed stands there too, and no form sends again
 * until it settles.
 */
export function ServerAdding(props: {
  /** Hands out the number of a new opening of the form, never one handed out before. */
  readonly mintOpening: () => number;
  /** The outcome of the send made from one opening of the form. */
  readonly outcomeFor: (opening: number) => McpMutationOutcome;
  readonly onAdd: (
    opening: number,
    binding: McpWritableBindingRef,
    config: McpServerConfigInput,
  ) => void;
  /** Lets go of the outcome of an opening whose send has settled or was never made. */
  readonly onDropOutcome: (opening: number) => void;
  readonly searchRegistry: SearchMcpRegistry;
  readonly projects: ProjectListReading;
  readonly sessionDirectory: SessionDirectoryState;
  readonly clock: Clock;
}): ReactNode {
  const { mintOpening, outcomeFor, onAdd, onDropOutcome } = props;
  const { searchRegistry, projects, sessionDirectory, clock } = props;
  const [adding, setAdding] = useState<ServerAddingState>(CLOSED_ADDING);
  const { opened, formOpening, standingOpening } = adding;
  // The outcomes held are the latest opening's and, while its send is on its way or until the
  // next opening once it settled, one earlier opening's that closed mid-send.
  const retire = (): number | undefined => {
    let standing: number | undefined;
    for (const opening of new Set([standingOpening, formOpening])) {
      if (opening === undefined) {
        continue;
      }
      if (outcomeFor(opening).kind === "sending") {
        standing = opening;
      } else {
        onDropOutcome(opening);
      }
    }
    return standing;
  };
  const openForm = (draft: ServerDraft): void => {
    const standing = retire();
    // A new opening remounts the form, so nothing an earlier form held is carried over.
    const opening = mintOpening();
    setAdding({ opened: { kind: "form", draft }, formOpening: opening, standingOpening: standing });
  };
  const show = (shown: OpenedAdding): void => {
    const standing = retire();
    setAdding({ opened: shown, formOpening, standingOpening: standing });
  };
  const formOutcome = formOpening === undefined ? undefined : outcomeFor(formOpening);
  const isFormShown = opened.kind === "form" && formOutcome?.kind !== "serverSent";
  const standingOutcome = standingOpening === undefined ? undefined : outcomeFor(standingOpening);
  return (
    <section className="meridian-mcp__adding" aria-label="Add a server">
      <div className="meridian-mcp__adding-head">
        <p className="meridian-settings-page__aside">
          Register a tool server for a provider, in all projects or in one.
        </p>
        <span className="meridian-mcp__add-actions">
          <button
            type="button"
            className="meridian-settings-page__action meridian-action-button"
            onClick={() => {
              openForm(EMPTY_SERVER_DRAFT);
            }}
          >
            Add a server
          </button>
          <button
            type="button"
            className="meridian-settings-page__action meridian-action-button"
            onClick={() => {
              show({ kind: "browsing" });
            }}
          >
            Browse servers
          </button>
        </span>
      </div>
      {standingOutcome === undefined ? null : (
        <MutationOutcomeLine
          outcome={standingOutcome}
          sessionDirectory={sessionDirectory}
          clock={clock}
        />
      )}
      {opened.kind === "browsing" ? (
        <BrowseServers
          searchRegistry={searchRegistry}
          clock={clock}
          onPick={(server) => {
            openForm(serverDraftOf(server));
          }}
          onCancel={() => {
            show({ kind: "closed" });
          }}
        />
      ) : null}
      {opened.kind === "form" && formOpening !== undefined && formOutcome !== undefined ? (
        isFormShown ? (
          <AddServerForm
            key={formOpening}
            draft={opened.draft}
            outcome={formOutcome}
            projects={projects}
            isAnotherSendInFlight={standingOutcome?.kind === "sending"}
            onSend={(binding, config) => {
              onAdd(formOpening, binding, config);
            }}
            onCancel={() => {
              show({ kind: "closed" });
            }}
            sessionDirectory={sessionDirectory}
            clock={clock}
          />
        ) : (
          <MutationOutcomeLine
            outcome={formOutcome}
            sessionDirectory={sessionDirectory}
            clock={clock}
          />
        )
      ) : null}
    </section>
  );
}

/** Which of `Add a server` and `Browse servers` is open, the form with what it opened with. */
type OpenedAdding =
  | { readonly kind: "closed" }
  | { readonly kind: "browsing" }
  | { readonly kind: "form"; readonly draft: ServerDraft };

/**
 * What is open, the latest opening of the form, and an earlier opening whose outcome stands under
 * the line because its form closed while its send was on its way.
 */
interface ServerAddingState {
  readonly opened: OpenedAdding;
  readonly formOpening: number | undefined;
  readonly standingOpening: number | undefined;
}

/** Nothing open, and no form opened yet. */
const CLOSED_ADDING: ServerAddingState = {
  opened: { kind: "closed" },
  formOpening: undefined,
  standingOpening: undefined,
};
