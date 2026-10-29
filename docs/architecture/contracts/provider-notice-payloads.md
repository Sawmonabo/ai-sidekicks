# Provider Notice Payload Contracts

Part of [API Payload Contracts](./api-payload-contracts.md), which holds the shared types, the error envelope and the conventions every shape here uses.

Each kind of `session.notice.posted`, a notice the daemon records on a session about its provider or the place the provider runs. The driver interface they come through is in [Provider Driver Payload Contracts](./provider-driver-payloads.md).

**Codex's warnings draw no flow row.** The Codex driver maps Codex's warnings and deprecations onto the first shape below; it is no row in the flow, and a Claude Code session carries none, because Claude Code sends no such signal. The names and their categories are [Spec-005](../../specs/005-session-event-taxonomy-and-audit-log.md)'s.

```ts
// session.notice.posted of kind `providerWarning` (Spec-005 §Session Lifecycle): Codex's `warning`,
// whose `message` becomes `text`, or its `deprecationNotice`, whose `summary` becomes `text` and
// whose `details` are kept beside it. Recorded so the working line's warnings count and its list
// survive a reload; it draws no flow row. `configWarning` and `guardianWarning` are not this kind,
// nor is the `warning` right after `model/rerouted` in the same turn, which is that switch's
// `sentence`.
interface SessionNoticeProviderWarning {
  sessionId: SessionId;
  kind: "providerWarning";
  source: "warning" | "deprecation";
  text: string; // Codex's own words
  details?: string; // a deprecation's details; absent on a warning
}

// session.notice.posted of kind `levelUnavailable`: an account switch moved the session onto an
// account that cannot run the level it was at, so it runs at `Ask`. One flow row, `Reviewed isn't
// available on this Claude Code account`, naming the level it left.
interface SessionNoticeLevelUnavailable {
  sessionId: SessionId;
  kind: "levelUnavailable";
  level: PermissionLevel; // the level it left
}

// session.notice.posted of kind `providerUpdated`: the session moved to the provider's new build,
// its process or service replaced and its conversation resumed when its running reply ended, or at
// once while it was idle. It draws the faint line `<Provider> updated · <old version> → <new
// version> · What's new` above the composer until the next message is sent, and no flow row.
interface SessionNoticeProviderUpdated {
  sessionId: SessionId;
  kind: "providerUpdated";
  provider: ProviderId;
  fromVersion: string; // as the provider reports it
  toVersion: string;
}

// session.notice.posted of kind `settingsIgnored`: the provider started without part of its own
// settings, read from the provider's own report and quoted, never composed (Spec-005 §Session
// Lifecycle). It splits by the shape of that report, never by provider: a report naming a file and
// a line, both always (Codex's `Invalid configuration; using defaults`), or one naming a file and a
// key, each only where known (the `Invalid settings` block `claude doctor` prints, which names no
// line).
type SessionNoticeSettingsIgnored = {
  sessionId: SessionId;
  kind: "settingsIgnored";
  provider: ProviderId;
} & ({ file: string; line: number; key?: never } | { file?: string; key?: string; line?: never });

// A provider process that ends on its own is restarted silently: the daemon restarts it at once,
// then after 1 s, 2 s, 4 s and so on, with no notice and no flow row, the working line reading
// `Reconnecting…` meanwhile. A crash during a turn ends that turn as the run's failed row
// (`agent.run.failed`'s `processExit`); a crash while idle shows nothing. A Codex service the
// daemon started that stays alive but answers nothing for 2 minutes is ended by the daemon and
// restarted the same way as a crash, the turn it cut reading `Turn ended · Codex stopped
// answering · no reply for 2 minutes`; a service the daemon only joined is never ended.

// session.notice.posted of kind `providerCrashLoop`: the provider process crashed for the fifth
// time within three minutes, or a Codex service the daemon ended for its silence was ended so for
// the fifth time within thirty minutes, and the daemon stopped restarting it. It draws the banner
// `Claude Code ended unexpectedly · exit code 137 · Restart ×` and no flow row, or, for a lasting
// Codex service whose five crashes were all failed starts, `Codex could not start · <the start's
// failure, one line> · Restart ×`, or, for a silent service, `Codex stopped answering · no reply
// for 2 minutes · Restart ×`. It carries exactly one of the exit code, the signal, the seconds the
// service answered nothing and the start's failure the daemon observed; the first three as
// `agent.run.failed`'s `processExit` does.
type SessionNoticeProviderCrashLoop = {
  sessionId: SessionId;
  kind: "providerCrashLoop";
  provider: ProviderId;
} & (
  | { exitCode: number; signal?: never; silentSeconds?: never; startFailure?: never }
  | { signal: string; exitCode?: never; silentSeconds?: never; startFailure?: never }
  | { silentSeconds: number; exitCode?: never; signal?: never; startFailure?: never }
  | { startFailure: string; exitCode?: never; signal?: never; silentSeconds?: never }
);

// session.notice.posted of kind `providerRestarted`: the person's `Restart` brought back a provider
// the crash loop stopped. Written on every session that showed the banner, it ends the banner on
// every device and after a reload and draws no flow row; the daemon's own silent restarts write
// none.
type SessionNoticeProviderRestarted = {
  sessionId: SessionId;
  kind: "providerRestarted";
  provider: ProviderId;
};

// session.notice.posted of kind `providerMissing`: the session's provider is not installed where
// the session runs, so no provider process started (Spec-001 §Fallback Behavior). One flow row
// naming the provider, opening Settings › Providers on its section. `place` is present on a Windows
// computer with a WSL 2 distribution and names where the session runs; the row then reads `Claude
// Code is not installed in Ubuntu.` with `Install in Ubuntu`, which opens that provider's `Ubuntu
// (WSL)` row, or, for a Windows folder, `Claude Code is not installed on Windows.` with `Install on
// Windows`, which opens that provider's `Windows` row. A stored session whose provider has no
// registered driver lands the same row with no section to open, its row reading `<Provider> isn't
// available in this version of the app. The transcript stays readable.`, and its stored transcript
// still reads.
interface SessionNoticeProviderMissing {
  sessionId: SessionId;
  kind: "providerMissing";
  provider: ProviderId;
  place?: Place;
}

// session.notice.posted of kind `distributionRemoved`: the WSL 2 distribution the session runs in
// is no longer on this computer (`wsl --unregister`, a reset, or WSL uninstalled). One flow row,
// `Ubuntu is no longer on this computer, so this session cannot run.`; the store and the transcript
// are untouched.
interface SessionNoticeDistributionRemoved {
  sessionId: SessionId;
  kind: "distributionRemoved";
  distro: string; // as `wsl -l` prints it
}

// session.notice.posted of kind `wslNotAnswering`: two `wsl.exe` runs missed their deadlines with
// no success between them, so the daemon starts no more until the next wake or the hour. One flow
// row on every session in any distribution, `WSL is not answering. Restarting Windows brings it
// back.`; Windows sessions get none.
interface SessionNoticeWslNotAnswering {
  sessionId: SessionId;
  kind: "wslNotAnswering";
}

// session.notice.posted of kind `distributionRestartFailed`: the WSL server for the session's
// distribution failed its fifth restart. One flow row,
// `Ubuntu stopped and could not start again. Restarting Windows usually brings it back.`, with
// `error` under it word for word where the last start gave one.
interface SessionNoticeDistributionRestartFailed {
  sessionId: SessionId;
  kind: "distributionRestartFailed";
  distro: string; // as `wsl -l` prints it
  // what the last start gave, word for word; absent where it printed nothing before its deadline
  error?: string;
}

// session.notice.posted of kind `fastOutputUnavailable`: the provider says fast output is not on
// for a turn that asked for it. One flow row, its words held by Spec-021 §Session Composer.
interface SessionNoticeFastOutputUnavailable {
  sessionId: SessionId;
  kind: "fastOutputUnavailable";
  runId: RunId; // the run whose turn asked for fast output
  reason?: string; // the provider's own words, absent when it sent none
}
```
