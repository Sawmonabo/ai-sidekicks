# Plan-027: Windows and Linux

|  |  |
| --- | --- |
| **Status** | `draft` |
| **Spec** | None of its own: each task implements the spec of the plan it links. |
| **Decisions** | [ADR-018](../decisions/018-windows-v1-tier-and-pty-sidecar.md) (the Windows tier and the terminal sidecar), [ADR-039](../decisions/039-the-service-on-wsl-2.md) (the line with the service on WSL 2) |

## Goal

When this plan is done, every interface that the earlier phases build and check on macOS has its Windows and its Linux implementation, and each is measured on a machine of its own kind. The earlier phases keep the code portable: each piece that differs by operating system sits behind one interface in the plan phase that owns it, which builds the macOS form. This plan adds the other two forms, so the same product runs on all three systems before the release.

## Non-goals

- **The terminal sidecar.** [Plan-021](./021-rust-pty-sidecar.md) owns it whole: its host, protocol, crash budget and respawn, the cross-compile of both Rust crates for x64 and arm64 and its publish script, with the arm64 package. Its Phase 4, its Phase 5 and its Phase 3B sidecar-only tasks are built beside this plan, and this plan holds no task for them.
- **The service on WSL 2 and the Windows half.** [Plan-005](./005-local-ipc-and-daemon-control.md) Phase R4 owns everything `sidekicks-windows-half.exe` does on either kind of Windows computer (the daemon's pipe, the credential store's Windows arm, banners and their withdrawal, keep-awake, the wake timer, the logon task, the port carry) and the daemon's WSL arm. This plan holds the rest of the Windows code.
- **Packaging, signing and the update path.** They are the release's, after this plan.

## Target areas

- `apps/desktop/src/main` — the Windows and Linux forms of the native verbs, the taskbar count, the window chrome and the `sidekicks://` address registration
- `apps/desktop/src/renderer` — the Windows and Linux key legends and file-manager wording
- `packages/runtime-daemon/src` — the Windows and Linux forms of the service's provider, credential, keep-awake, wake, messaging, command-wrapper and capture interfaces
- `apps/cli` — the Linux user service with lingering

## Phases

Each phase is one pull request. A task names the plan whose interface it implements; that plan's spec and done-when are the acceptance, run on a machine of the task's own kind.

### Phase 1 — Windows

Precondition: the plan phase each task extends merged.

Native Windows: every Windows implementation of an interface the earlier phases build on macOS that the service's Windows half does not hold, in main, the renderer, the daemon's TypeScript and the terminal sidecar.

- **T27.1.1 — Editors.** "`native.listEditors` and `native.openInEditor` on Windows". Implements [Plan-020](./020-desktop-app-and-renderer.md) T-020r-2-4's `native` namespace.
- **T27.1.2 — The taskbar count.** "The taskbar's overlay count": `BaseWindow.setOverlayIcon` on Windows, where `app.setBadgeCount` does not work, fed by the same entries as the bell. Implements [Plan-016](./016-notifications-and-attention-model.md)'s count.
- **T27.1.3 — Codex hooks on Windows.** "The Codex hooks' `command_windows` form". Implements the Codex hook registration in [Plan-003](./003-provider-driver-contract-and-capabilities.md) and the standing rules in [Plan-023](./023-provider-accounts-and-credential-homes.md) Phase 4.
- **T27.1.4 — The agent-memory link.** "The agent-memory folder's link as a junction": the `agent-memory` link from every Claude Code configuration home to `~/.ai-sidekicks/agent-memory/<name>/`. Implements [Plan-024](./024-agent-definitions-and-peer-invocation.md)'s memory folders.
- **T27.1.5 — Stopping on Windows.** "The stop of Claude Code and of the daemon on Windows." Implements the Claude Code process stop in [Plan-003](./003-provider-driver-contract-and-capabilities.md) and the service's stop in [Plan-005](./005-local-ipc-and-daemon-control.md).
- **T27.1.6 — Session inboxes as named pipes.** On native Windows the Claude Code inbox and the daemon's own are named pipes, so messaging between sessions delivers, draws `Address` and applies the hook exactly as elsewhere, with a `\\.\pipe\` name as the address object. Implements [Plan-013](./013-multi-agent-orchestration.md)'s messaging between sessions.
- **T27.1.7 — The socket-path limit.** "The socket-path limit on Windows": the daemon's socket path must fit in 108 bytes on Windows, and the same limit holds for each Codex service's socket. Implements [Plan-005](./005-local-ipc-and-daemon-control.md) Phase 2C.
- **T27.1.8 — The machine name.** "The machine name": on Windows `os.hostname()`, the DNS host name without its domain, never `%COMPUTERNAME%`. Implements [Plan-025](./025-remote-control.md) Phase 3's machine registration.
- **T27.1.9 — Window chrome and words.** "The Windows window chrome, key legends and file-manager wording." Implements [Plan-020](./020-desktop-app-and-renderer.md)'s frame, keyboard legends and reveal action.
- **T27.1.10 — Finding and installing a provider.** "The provider lookup table's Windows rows and the one-press install there." Implements the lookup order and `provider.install` in [Plan-023](./023-provider-accounts-and-credential-homes.md) Phase 4.
- **T27.1.11 — The Windows measurements.** Each is run on a Windows machine as this phase's acceptance: the sandbox; editor detection; whether the command line's check of a held folder needs a retry (only if the lock handle is inherited); the machine-name readings on a long, mixed-case name; the stay-awake hold (a PowerShell child holding `SetThreadExecutionState` until the service exits); the setup token handed to Claude Code on a descriptor, and whether another process can read Claude Code's start-up block; whether a detached child outlives the app (where it does not, the service starts through the per-user service); the wake for an account's window start (`SetWaitableTimer`); the helper command Codex runs through its shell; the command wrapper's waiting signal (Windows has no job control or pipe-wait flag, so the terminal sidecar needs its own); the Codex hooks' `command_windows` form; the memory folder's link, a junction there; the kept discard and shell-write undo; the workflow quick step's thread; the shared Codex service there (its listen form, the plain `codex` join and `codex resume`); session messaging over named pipes (Claude Code's inbox and the daemon's own); the updater and the relay legs.

Done when: every task's linked plan passes its own tests and done-when on a Windows machine, and each measurement in T27.1.11 is recorded in the plan that owns its capability.

### Phase 2 — Linux

Precondition: the plan phase each task extends merged.

Linux: every Linux implementation of an interface the earlier phases build on macOS.

- **T27.2.1 — The user service.** "The user service with lingering and the service across logout": `sidekicks daemon install` installs a user service and turns lingering on; `sidekicks daemon uninstall` removes it. Implements [Plan-005](./005-local-ipc-and-daemon-control.md) Phase R3.
- **T27.2.2 — The Secret Service pin.** "The Secret Service pin on every keychain entry": every item opened with `{linux: {store: "secret-service"}}`. Implements [Plan-023](./023-provider-accounts-and-credential-homes.md) T2.3 and [Plan-019](./019-data-retention-and-gdpr.md) Phase 1.
- **T27.2.3 — The credential store's Linux file.** "The credential store's Linux file, where no Secret Service answers, and Runtime's line naming it then": one file in the service's own data folder, readable only by the person. Implements [Plan-019](./019-data-retention-and-gdpr.md) Phase 1.
- **T27.2.4 — Keep-awake.** "Keep-awake through `systemd-inhibit`", with `org.freedesktop.ScreenSaver.Inhibit` held on the service's own session D-Bus connection for the screen. Implements [Plan-005](./005-local-ipc-and-daemon-control.md) T-005r-1-14.
- **T27.2.5 — The wake helper.** "The wake helper's Linux form". Implements [Plan-023](./023-provider-accounts-and-credential-homes.md) T3.4.
- **T27.2.6 — Editors.** "`native.listEditors` and `native.openInEditor` through desktop entries". Implements [Plan-020](./020-desktop-app-and-renderer.md) T-020r-2-4's `native` namespace.
- **T27.2.7 — The machine name.** "The machine name from `PRETTY_HOSTNAME`", read from `/etc/machine-info` and falling back to the static hostname. Implements [Plan-025](./025-remote-control.md) Phase 3's machine registration.
- **T27.2.8 — The app's address.** "`MimeType=x-scheme-handler/sidekicks`" in the `.desktop` entry, so a `sidekicks://` address opens the app. Implements [Plan-020](./020-desktop-app-and-renderer.md) T-020r-4-3's deep-link handler.
- **T27.2.9 — Both sandboxes on Ubuntu.** "Both sandboxes on a real Ubuntu desktop": Claude Code's and Codex's sandboxes started by the service, each with its tool's own error. Implements the full-tier step sandbox in [Plan-014](./014-workflow-authoring-and-execution.md).
- **T27.2.10 — The waiting signal.** "The waiting signal through `/proc/<pid>/wchan`", for a command waiting on a pipe; a stopped terminal read restarts on Linux. Implements the command wrapper in [Plan-003](./003-provider-driver-contract-and-capabilities.md) T3.29.
- **T27.2.11 — The clone.** "The clone where the disk has one". Implements the captures in [Plan-012](./012-persistence-recovery-and-replay.md) T15.6 and T15.7.
- **T27.2.12 — The backup folder.** "The backup folder's Linux default." Implements the backups in [Plan-005](./005-local-ipc-and-daemon-control.md) T-005r-1-15.
- **T27.2.13 — Finding a provider.** "The provider lookup table's Linux rows." Implements the lookup order in [Plan-023](./023-provider-accounts-and-credential-homes.md) Phase 4.
- **T27.2.14 — Window chrome and key legends.** "The Linux window chrome and key legends." Implements [Plan-020](./020-desktop-app-and-renderer.md)'s frame and keyboard legends.
- **T27.2.15 — The Linux measurements.** Each is run on a real Linux desktop as this phase's acceptance (a container has no desktop session, AppArmor, snapd or display): the command wrapper's waiting signal (a stopped terminal read restarts there; pipe waiters in `/proc/<pid>/wchan`); the stay-awake hold from a detached service (logind's sleep inhibitor, and `org.freedesktop.ScreenSaver.Inhibit`, which lasts only while the D-Bus connection that took it stays open, so the service holds that connection itself, on GNOME and KDE); lingering with a locked keyring, a real logout and `enable-linger` on Ubuntu, Fedora, Arch and openSUSE; both sandboxes started by the service on a real Ubuntu 24.04 desktop, with each tool's error; snap installs, editors installed through the JetBrains Toolbox's window, and opening a file; the TPM tier; the kept discard and shell-write undo; the workflow quick step's thread.

Done when: every task's linked plan passes its own tests and done-when on a Linux desktop, and each measurement in T27.2.15 is recorded in the plan that owns its capability.

## Risks

- **No Windows or Linux machine in the build loop.** The measurements in T27.1.11 and T27.2.15 cannot run on a Mac, and a container has no desktop session, AppArmor, snapd or display; each phase needs a machine of its own kind.
