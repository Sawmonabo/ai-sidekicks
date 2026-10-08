# Running Command Payload Contracts

Part of [API Payload Contracts](./api-payload-contracts.md), which holds the shared types, the error envelope and the conventions every shape here uses.

## Running-Command Method Registry (Plan-003)

The console's window onto the shell commands an agent started. The provider decides how a command runs and the console never forces it — it sets no time limit of its own, never chooses foreground or background for a command, and never reports a command's processor or memory use. What the console adds is one live view with four acts, on the `command` root riding the **daemon JSON-RPC transport only**: the running set is the daemon's own, folded from one provider's whole-set change notification (which a repeated handshake also returns after a reconnect) and the other's background-terminal listing, so a reconnect converges without a client reconciling two readings.

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `command.list` | `subscription` | `CommandListSubscribeRequest` | `CommandListUpdate` (stream) |
| `command.stop` | `mutation` | `CommandStopRequest` | `CommandStopResponse` |
| `command.background` | `mutation` | `CommandBackgroundRequest` | `CommandBackgroundResponse` |
| `command.write` | `mutation` | `CommandWriteRequest` | `CommandWriteResponse` |

`command.list` is a subscription and not a read, because the set changes without anyone asking and a command can outlive the turn that started it. `command.background` is capability-gated: exactly one pinned provider can move a waited-on command to the background, and on the other the control does not exist — absent rather than disabled — so the verb is never dispatched there and a word typed for it is answered by the console with one row rather than a refused call. `command.write` carries what the person typed on a command's input line, or `End input`. A command that can take input, a Codex command given a terminal or one an agent ran with `shell_run`, carries that line for its whole run, so a write is taken whether or not the command is waiting; the waiting signal only brings the line forward and marks the session waiting. `End input` ends the command's input as end of file does on a terminal. A git or ssh prompt that would open the terminal raises the same input line with the prompt's own words, on any command, and there `End input` answers the prompt with nothing, as closing the prompt would.

```ts
// One running command, in the order the commands started. `name` is the command as the agent ran it,
// which is also what the transcript row shows; `startedAt` is what the live timer counts from, so the
// timer is a rendering of one fact rather than a second clock. `waitingInForeground` is true only where
// the provider is holding the agent's turn on this command, which is the one state the background act
// applies to.
interface RunningCommand {
  commandId: string;
  runId: RunId;
  name: string;
  startedAt: string;
  waitingInForeground: boolean;
  // True for a command that can take typed input for its whole run, a Codex command given a terminal
  // or one an agent ran with `shell_run`, so its row carries the input line from start to end; false
  // for a Claude Code Bash command and a Codex command started without a terminal, whose input the
  // provider closed.
  acceptsInput: boolean;
  // True while the command is waiting on its own input, read from the system (the kernel's state,
  // or on macOS the innermost call `sample` shows) by the daemon, through its command wrapper for a
  // Codex command and through the shell table for a command in a session's shell. It brings the
  // input line forward and marks the session waiting, and the waiting mark is kept with the session,
  // so every device shows it.
  waitingForInput: boolean;
  // The command's terminal echo state while it takes input or has a prompt open, whether or not it is
  // waiting: true while echo is off, as at a password prompt, so the input line masks what is typed.
  // Read from the terminal's settings through its master side on macOS and Linux, from the console's
  // input mode on Windows, and from an open askpass prompt's kind for git and ssh.
  echoOff: boolean;
  // Set only while a git or ssh prompt is open on the command through the askpass variables: the
  // prompt's own words, which the line shows, since the prompt prints nothing to the command's output.
  prompt?: { text: string };
}
interface CommandListSubscribeRequest {
  sessionId: SessionId;
}
// The WHOLE set per emission, because the provider's own change notification carries the whole set and a
// subscriber composing deltas could hold a command the provider has already dropped. The set going empty
// is what takes the view away.
interface CommandListUpdate {
  sessionId: SessionId;
  commands: RunningCommand[];
}

// Ending a command is never a bare failure to the agent: the row records that the person ended it, and
// the agent receives one short message naming the stopped command, so its next step reads an
// instruction rather than an unexplained error. Stopping every command in a session is this same verb once
// per running command — there is no sweep verb, and nothing here touches an agent.
interface CommandStopRequest {
  sessionId: SessionId;
  commandId: string;
}
interface CommandStopResponse {
  commandId: string;
  stopped: true;
}

// Moving a waited-on command to the background continues the agent's turn and starts the output
// streaming into the command's own row. Refused where the bound provider has no such mechanism, and where
// no command is waiting in the foreground.
interface CommandBackgroundRequest {
  sessionId: SessionId;
  commandId: string;
}
interface CommandBackgroundResponse {
  commandId: string;
  waitingInForeground: false;
}

// Typed input, or `End input`, for a command that takes input or has a prompt open, taken whether or
// not `waitingForInput` is true; a write to a command that does neither is refused. It goes one of
// three ways. A Codex command in a terminal takes `text` through Codex's `process/write`, which the
// daemon's command wrapper copies into the command's terminal; a command an agent ran with
// `shell_run` takes it written into that session's shell; either way `endOfInput` writes the
// terminal's end-of-file character. An open askpass prompt takes `text` as its answer, which the
// daemon seals to the askpass program's own key and leaves in the command channel for that program
// alone, and there `endOfInput` answers it with nothing, as closing the prompt would. A read waits
// for the person or `End input`, bounded only by the provider's and the runtime's own limits.
interface CommandWriteRequest {
  sessionId: SessionId;
  commandId: string;
  text?: string;
  endOfInput?: boolean;
}
interface CommandWriteResponse {
  commandId: string;
}
```

**Two records the flow folds.** A command's output arrives as `command.output` and streams into that command's own row as it prints; the row is the one home for the whole output, and the live view above it is a window onto the same rows rather than a second copy. A command settles as `command.ended`, carrying which of the three endings it was — it finished, it failed, or the person ended it — because a row that cannot say which of the three happened cannot be read. The taxonomy is [Spec-005](../../specs/005-session-event-taxonomy-and-audit-log.md)'s.

**The live command list is `session.providerCommandsSubscribe`.** The `/` list a session offers is bound to the LIVE provider process. On both providers its Skills group is the skills the daemon lists (`skill.list`), a skill only the other provider can run left out, and the composer joins that list with the provider's half this subscription carries; `skill.list` is the one inventory, and the provider's own enumeration only shows what it loaded and is never a second registry. On Claude Code the process's first frame, replaced whole by each `commands_changed` push, supplies only its own words that are not skills, and a new process — a new session, a switch of provider or worktree at its boundary — brings a new frame and a new list; on Codex, whose wire parses no slash text, the words are the console's own. A provider's own skill enumeration (Codex's `skills/list`) is read only for what it loaded, so a skill the provider failed to load stays listed and grayed with its load error, which the daemon matches to its row and the composer draws as given. Each working tool server's prompts join it; Codex never asks a server for its prompts, so on a Codex session the daemon lists and reads them itself through its own MCP client, for every server it can reach. The subscription takes `ProviderCommandsSubscribeRequest` and emits `ProviderCommandsUpdate`, the whole list on every emission (provider-driver-payloads.md §Plan-003), over the daemon JSON-RPC transport only.

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `session.providerCommandsSubscribe` | `subscription` | `ProviderCommandsSubscribeRequest` | `ProviderCommandsUpdate` (stream) |
