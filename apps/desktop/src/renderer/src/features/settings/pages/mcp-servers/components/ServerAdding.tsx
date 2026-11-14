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
 * picked. A server the service took closes the form, and its settle lines stand under the line
 * until the next `Add a server` or `Browse servers`; any other outcome of a send whose form was
 * closed stands there too.
 */
export function ServerAdding(props: {
  /** The last send's outcome. */
  readonly outcome: McpMutationOutcome;
  readonly onAdd: (binding: McpWritableBindingRef, config: McpServerConfigInput) => void;
  /** Returns the last send's outcome to idle, so a form opened afresh carries none. */
  readonly onDropOutcome: () => void;
  readonly searchRegistry: SearchMcpRegistry;
  readonly projects: ProjectListReading;
  readonly sessionDirectory: SessionDirectoryState;
  readonly clock: Clock;
}): ReactNode {
  const { outcome, onAdd, onDropOutcome, searchRegistry, projects, sessionDirectory, clock } =
    props;
  const [opened, setOpened] = useState<OpenedAdding>({ kind: "closed" });
  const openForm = (draft: ServerDraft): void => {
    onDropOutcome();
    // A new opening ordinal remounts the form, so nothing an earlier form held is carried over.
    setOpened((held) => ({
      kind: "form",
      draft,
      opening: (held.kind === "form" ? held.opening : 0) + 1,
    }));
  };
  const close = (): void => {
    onDropOutcome();
    setOpened({ kind: "closed" });
  };
  const isFormShown = opened.kind === "form" && outcome.kind !== "serverSent";
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
              onDropOutcome();
              setOpened({ kind: "browsing" });
            }}
          >
            Browse servers
          </button>
        </span>
      </div>
      {opened.kind === "browsing" ? (
        <BrowseServers
          searchRegistry={searchRegistry}
          clock={clock}
          onPick={(server) => {
            openForm(serverDraftOf(server));
          }}
          onCancel={close}
        />
      ) : null}
      {isFormShown ? (
        <AddServerForm
          key={opened.opening}
          draft={opened.draft}
          outcome={outcome}
          projects={projects}
          onSend={onAdd}
          onCancel={close}
          sessionDirectory={sessionDirectory}
          clock={clock}
        />
      ) : (
        <MutationOutcomeLine outcome={outcome} sessionDirectory={sessionDirectory} clock={clock} />
      )}
    </section>
  );
}

/** Which of `Add a server` and `Browse servers` is open, the form with what it opened with. */
type OpenedAdding =
  | { readonly kind: "closed" }
  | { readonly kind: "browsing" }
  | { readonly kind: "form"; readonly draft: ServerDraft; readonly opening: number };
