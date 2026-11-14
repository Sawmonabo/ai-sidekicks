// The worktree popover's new mode: the name, fixed except for its tail, with the folder it will be
// made in, the base picked from the branches the daemon lists in its own order (one another tree
// holds grayed), carrying the uncommitted changes where the session's tree has any, the error
// line, and `Cancel` beside `Create and move here`. Creating makes the tree for the session's
// workspace, which moves the session there.

import { useEffect, useState } from "react";

import type { ProjectBranchListResponse } from "@ai-sidekicks/contracts/repo/git-reads";
import type { WorkspaceListEntry } from "@ai-sidekicks/contracts/repo/workspace";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { NewWorktreeSuggestion } from "@ai-sidekicks/contracts/worktree/lifecycle";

import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import type { ExtendedRefusal } from "#renderer/lib/refusal/extensions.js";
import { callDaemon } from "#renderer/services/daemon/reply.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";

/** What the form creates from and how it ends. */
export interface NewWorktreeFormProps {
  readonly bridge: PlatformBridge;
  readonly sessionId: SessionId;
  readonly suggestion: NewWorktreeSuggestion;
  /** Whether the session's tree holds uncommitted changes, which the form offers to carry. */
  readonly isSourceDirty: boolean;
  readonly onCancel: () => void;
  readonly onCreated: () => void;
}

/** The new-worktree form. */
export function NewWorktreeForm(props: NewWorktreeFormProps): React.JSX.Element {
  const [tail, setTail] = useState(props.suggestion.suggestedTail ?? "");
  const [base, setBase] = useState<string | undefined>(undefined);
  const [carriesChanges, setCarriesChanges] = useState(false);
  // Git's refusal, kept with the request it refused so any edit of the form lifts it.
  const [gitRefusal, setGitRefusal] = useState<
    { readonly request: string; readonly detail: string } | undefined
  >(undefined);
  const [refusal, setRefusal] = useState<ExtendedRefusal | undefined>(undefined);
  const [workspace, setWorkspace] = useState<WorkspaceListEntry | undefined>(undefined);
  const [branches, setBranches] = useState<ProjectBranchListResponse | undefined>(undefined);
  useEffect(() => {
    const read = new AbortController();
    void callDaemon(
      props.bridge,
      "workspace.list",
      { sessionId: props.sessionId },
      { signal: read.signal },
    ).then(async (reply) => {
      if (read.signal.aborted) {
        return;
      }
      if (reply.status === "refused") {
        setRefusal(reply.refusal);
        return;
      }
      const [first] = reply.value.workspaces;
      setWorkspace(first);
      if (first === undefined) {
        return;
      }
      const listed = await callDaemon(
        props.bridge,
        "project.branch.list",
        { repoMountId: first.repoMountId },
        { signal: read.signal },
      );
      if (read.signal.aborted) {
        return;
      }
      if (listed.status === "refused") {
        setRefusal(listed.refusal);
        return;
      }
      setBranches(listed.value);
    });
    return () => {
      read.abort();
    };
  }, [props.bridge, props.sessionId]);
  const name = `${props.suggestion.fixedPart}${tail}`;
  const isTailEmpty = tail.trim().length === 0;
  const request = JSON.stringify([name, base, carriesChanges]);
  // Create stays disabled with its reason under the field while the tail is empty or git refuses
  // the name.
  const errorLine = isTailEmpty
    ? "Enter a name first"
    : gitRefusal?.request === request
      ? gitRefusal.detail
      : undefined;
  return (
    <form
      className="meridian-composer-worktrees__new"
      onSubmit={(event) => {
        event.preventDefault();
        if (workspace === undefined || errorLine !== undefined) {
          return;
        }
        void callDaemon(props.bridge, "workspace.executionRoot.prepare", {
          workspaceId: workspace.id,
          branchName: name,
          ...(base === undefined ? {} : { baseRef: base }),
          ...(carriesChanges ? { carryUncommitted: true } : {}),
        }).then((reply) => {
          if (reply.status === "refused") {
            // Git's own refusal reads as git printed it, under the field.
            setGitRefusal({ request, detail: reply.refusal.detail });
            return;
          }
          props.onCreated();
        });
      }}
    >
      <label className="meridian-composer-worktrees__name">
        <span>{props.suggestion.fixedPart}</span>
        <input
          aria-label="Worktree name"
          value={tail}
          onChange={(event) => {
            setTail(event.target.value);
          }}
        />
      </label>
      <span className="meridian-composer-worktrees__faint">{`Will be created as ${name}.`}</span>
      <span className="meridian-composer-worktrees__faint">
        {`${props.suggestion.folderBefore}${name}`}
      </span>
      {branches === undefined ? null : (
        <select
          aria-label="Base"
          value={base ?? branches.defaultBranch}
          onChange={(event) => {
            setBase(event.target.value);
          }}
        >
          {branches.branches.map((branch) => (
            <option key={branch.name} value={branch.name} disabled={branch.heldBy !== undefined}>
              {branch.name}
            </option>
          ))}
        </select>
      )}
      {props.isSourceDirty ? (
        <label className="meridian-composer-worktrees__carry">
          <input
            type="checkbox"
            checked={carriesChanges}
            onChange={(event) => {
              setCarriesChanges(event.target.checked);
            }}
          />
          Bring uncommitted changes
        </label>
      ) : null}
      {errorLine === undefined ? null : (
        <p className="meridian-composer-worktrees__error">{errorLine}</p>
      )}
      {refusal === undefined ? null : <InlineRefusal code={refusal.code} detail={refusal.detail} />}
      <button type="button" className="meridian-clickable-word" onClick={props.onCancel}>
        Cancel
      </button>
      <button
        type="submit"
        className="meridian-clickable-word"
        disabled={workspace === undefined || errorLine !== undefined}
      >
        Create and move here
      </button>
    </form>
  );
}
