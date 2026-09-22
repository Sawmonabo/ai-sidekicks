# ADR-032: Two Session Shapes

| Field         | Value                            |
| ------------- | -------------------------------- |
| **Status**    | `accepted`                       |
| **Type**      | `Type 2 (one-way door)`          |
| **Domain**    | Session Model, Workspace Binding |
| **Date**      | 2026-09-21                       |
| **Author(s)** | Claude (AI-assisted)             |
| **Reviewers** | Sawmon Abo                       |

---

## Context

The session is the primary object ([ADR-001](001-session-is-the-primary-domain-object.md)). A person starts a session for two different reasons: to work on a repository they have attached, or to talk something through with no repository at all. Both providers need a working folder to run in, and the console's panes (Review, Terminal, Preview, the file pane) each assume something about what that folder is.

## Problem Statement

How many kinds of session are there, what decides which kind a session is, and what happens when a conversation that started without a repository needs one?

### Trigger

The locked console design draws different controls on the two kinds of session, so the rule that tells them apart must be fixed before the session record, the mount record and the screens are built against it.

---

## Decision

A session has one of two shapes, **chat** or **project**, and the shape is decided by what the session is bound to, never by a mode flag.

- A **project** session is bound to a repository the person attached. "Project" is defined against the mount's origin being one the person attached, never against a folder merely existing.
- A **chat** session is bound to a managed workspace the daemon owns: a real, git-initialized folder, one per session, at `<home>/.ai-sidekicks/workspaces/<session-id>`, registered as a mount with a managed origin.
- The discriminator is a real column on the record. It is never guessed from a path prefix.
- Attaching a repository to a chat promotes that same session in place. The managed workspace and the session's history are kept, the working folder moves to the attached repository, and the files the chat wrote are copied into that repository, where they show as new uncommitted changes. Nothing is committed and nothing is merged automatically.
- Attaching a folder that is already a project switches to that project, and the daemon refuses to create a second project record for the same origin.
- A managed workspace is deleted whole at purge, retained on archive and skipped by the archive sweep. Provable destruction is never claimed for it.

### Thesis — Why This Option

- **Every session has a real folder.** A provider process always has a working directory, an agent in a chat can still write a file, and the file is in a git repository from its first byte, so undo and checkpoints work the same way in both shapes.
- **The binding cannot lie.** A mode flag can disagree with what the session is actually bound to. A shape read from the binding cannot.
- **Defining "project" by origin stops every chat becoming a project.** If a project were "a session with a folder", every chat would silently be one, because every chat has a managed workspace.
- **Promotion in place keeps the conversation.** A person who realises mid-conversation that they need their repository does not start again.

### Antithesis — The Strongest Case Against [T2]

A managed git workspace per chat is real disk and real process cost for conversations that may never write a file. A lazily created folder, or no folder at all with a temporary directory on first write, would be cheaper. Two shapes also double the states every pane must draw, and promotion is a third path that must be tested across every pane.

### Synthesis — Why It Still Holds [T2]

An empty git-initialized folder costs a few kilobytes and no process. Creating it lazily buys that back at the price of a session whose working directory changes identity on its first write, which is exactly the class of surprise the binding rule removes. The two shapes do not double the screen: a control that needs a repository is absent on a chat, with the pane chips the one exception, greyed with their reason; the composer placeholder and the strip that reads `Session workspace` beside `Attach a repo` are the only other differences. Promotion is one transition whose only data movement is a file copy into the repository's working tree, which is why it is cheap to test.

---

## Alternatives Considered

### Option A: Two shapes decided by the binding (Chosen)

- **What:** Chat on a managed workspace, project on an attached repository, one column, promotion in place.
- **Steel man:** One session model, a real folder always, and no state that can contradict itself.
- **Weaknesses:** A folder per chat, and a promotion path to maintain.

### Option B: One shape; a session always requires an attached repository (Rejected)

- **What:** No chat. A person attaches a repository before the first message.
- **Steel man:** One set of panes, no managed workspaces, no promotion.
- **Why rejected:** It refuses the most common first act, asking a question, and forces a throwaway repository on people who only want to talk.

### Option C: A mode flag on the session (Rejected)

- **What:** `mode: chat | project` stored beside the binding.
- **Steel man:** Trivial to read and to filter on.
- **Why rejected:** Two sources for one fact. The flag and the binding can disagree after an attach, a failed attach or a restore, and every reader must then pick one.

---

## Assumptions Audit [T2]

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | Both providers run correctly in an empty git-initialized folder | **Unvalidated.** Proved by starting each provider in an empty git-initialized folder on the first build of the chat shape | A chat could not start; the workspace would need seeding |
| 2 | A mount's origin can always tell a managed workspace from an attached repository | The mount's origin is marked managed when the daemon creates it ([Spec-001](../specs/001-session-core.md)); the mount itself is [Spec-007](../specs/007-repo-attachment-and-workspace-binding.md)'s | The shape could not be derived, and a flag would return |
| 3 | Copying the chat's files into the repository as uncommitted changes is what a person expects | The copied files open in Review as new changes, so the person sees and decides on each one | A copy could land on a path the repository already uses; such a file is left uncopied, named on the conversion's own act row and named to the session's agent ([Spec-001](../specs/001-session-core.md)) |

---

## Failure Mode Analysis [T2]

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| Managed workspaces accumulate on disk | Med | Low | The folder under the app's home grows | Purge deletes them whole; archive keeps them by design |
| A path-prefix shortcut creeps into a reader | Low | Med | A chat under a moved home folder shows project controls | The rule is the column; code review rejects prefix checks |
| A person does not expect the copied files in their repository | Low | Low | They ask where the changes came from | The conversion says what it will do before it runs, and one row in the transcript records that it happened |

## Reversibility Assessment

- **Reversal cost:** Weeks. The session record, the mount record, the purge path and every pane read the shape.
- **Blast radius:** [Spec-001](../specs/001-session-core.md), [Spec-007](../specs/007-repo-attachment-and-workspace-binding.md), [Spec-008](../specs/008-worktree-lifecycle-and-execution-modes.md), [Spec-012](../specs/012-artifacts-files-and-attachments.md) and the session screen.
- **Migration path:** None is needed before release; after it, a new record with a data plan.
- **Point of no return:** The first release that writes managed workspaces to people's disks.

## Consequences

### Positive

- Undo, checkpoints and the file pane work in a chat exactly as in a project.
- No code path asks "is there a folder?".

### Negative (accepted trade-offs)

- One small folder per chat session, kept until purge.

### Unknowns

- How large managed workspaces grow in practice. Read from the retention figures once the app is in daily use.

---

## Decision Validation [T2]

### Pre-Implementation Checklist

- [x] All unvalidated assumptions have a validation plan
- [x] At least one alternative was seriously considered and steel-manned
- [x] Antithesis was reviewed by someone other than the author
- [x] Failure modes have detection mechanisms
- [x] Point of no return is identified and communicated to the team

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
| --- | --- | --- | --- |
| Readers that derive the shape from anything but the column | Zero | `rg` for path-prefix checks on the workspaces path when the session screen lands | When Plan-021's session screen completes |

---

## References

No outside research was needed; the decision rests on the specifications linked above.

### Related ADRs

- [ADR-001: Session Is The Primary Domain Object](001-session-is-the-primary-domain-object.md) — the object whose shape this fixes.

## Decision Log

| Date       | Event    | Notes                            |
| ---------- | -------- | -------------------------------- |
| 2026-09-21 | Accepted | Decided with the console design. |
