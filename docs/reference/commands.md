# Commands

Every command the product ships: what a person types into the `sidekicks` command line, the modes the background service starts its own program in, and the program and link file names. The specs and plans named in each row say how a command behaves; this page is the one list of names.

## How a command is named

- A command a person types is a group word, then a verb: `sidekicks data export`, `sidekicks account login`. Two words are never joined with a dash into one command.
- A group word is a singular noun with an explicit `list` verb: `sidekicks device list`, `sidekicks crash list`.
- One act takes one verb everywhere: `login` and `logout` for every sign-in, `list` for every listing.
- A modifier of a command is a flag, never a command of its own: `sidekicks daemon update --check`.
- A program or link file keeps the `sidekicks-` prefix, which marks the file as the product's among other programs' files: `sidekicks-daemon`, `sidekicks-command-wrapper`. The prefix is part of a file name only, never of a command a person types.

## Commands a person types

| Command | What it does | Specified in |
| --- | --- | --- |
| `sidekicks account login` | Signs this computer in to the hosted account through the background service, opening the sign-in page in the browser. | [Spec-006](../specs/006-local-ipc-and-daemon-control.md), [Plan-015](../plans/015-hosted-account-and-identity.md) |
| `sidekicks account logout` | Signs this computer out of the hosted account through the background service. | [Spec-006](../specs/006-local-ipc-and-daemon-control.md), [Plan-015](../plans/015-hosted-account-and-identity.md) |
| `sidekicks account delete` | Deletes the hosted account and signs this computer out; local data stays. | [Spec-020](../specs/020-data-retention-export-and-deletion.md) |
| `sidekicks account show` | Prints the hosted account's id and name. | [Spec-016](../specs/016-hosted-account-and-identity.md), [Plan-015](../plans/015-hosted-account-and-identity.md) |
| `sidekicks account rename <new name>` | Changes the account's name. | [Spec-016](../specs/016-hosted-account-and-identity.md), [Plan-015](../plans/015-hosted-account-and-identity.md) |
| `sidekicks data export <folder>` | Writes everything this computer keeps to a folder, as Settings' `Export all data` does. | [Spec-020](../specs/020-data-retention-export-and-deletion.md) |
| `sidekicks data erase` | Erases all local data, as Settings' `Erase all data` does; refused while the service runs; asks first, and `--yes` skips the question. | [Spec-020](../specs/020-data-retention-export-and-deletion.md) |
| `sidekicks data restore <backup>` | Restores a backup with the service stopped, for a computer with no app; asks first, and `--yes` skips the question. | [Spec-013](../specs/013-persistence-and-recovery.md) |
| `sidekicks daemon install` | Sets up the background service; `--while-signed-out` keeps it running while the person is signed out of the computer. `--daemon-path <path>` registers another build of the service's program in place of the one beside the command line, and `--timeout <ms>` sets how long it waits for the service to answer (10,000 ms unless given). | [Spec-006](../specs/006-local-ipc-and-daemon-control.md) |
| `sidekicks daemon uninstall` · `start` · `stop` · `restart` · `status` | Removes, starts, stops, restarts or reports the background service; `stop` and `restart` ask first, and `--yes` skips the question. `start` and `restart` take `--daemon-path <path>` and `--timeout <ms>` as `install` does; `--daemon-path` is refused where a login agent or the service that runs while the person is logged out starts its own program. | [Spec-006](../specs/006-local-ipc-and-daemon-control.md) |
| `sidekicks daemon update [--check]` | Checks for, and applies, a newer background service; it never updates the app. | [Spec-023](../specs/023-self-host-secure-defaults.md), [Plan-005](../plans/005-local-ipc-and-daemon-control.md) |
| `sidekicks device list` | Lists the person's computers and devices. | [Spec-027](../specs/027-remote-control.md) |
| `sidekicks device link` · `rename` · `revoke` · `forget` | Links a new device with a code and six digits; renames, revokes or forgets one. | [Spec-027](../specs/027-remote-control.md) |
| `sidekicks relay repin --force` | Accepts a relay's new key after its pin was refused, with the new hash pasted. | [Spec-027](../specs/027-remote-control.md) |
| `sidekicks agent list` · `create` · `edit` · `delete` | Lists, creates, edits and deletes saved agents, the sidekicks on the Sidekicks page. | [Plan-024](../plans/024-agent-definitions-and-peer-invocation.md) |
| `sidekicks workflow list` · `show` · `export` · `import` | Lists, shows, exports and imports workflow definitions, the same operations as the builder. | [Plan-014](../plans/014-workflow-authoring-and-execution.md) |
| `sidekicks workflow start` · `status` · `cancel` · `resume` | Starts a workflow run, reads it, cancels it or resumes it. | [Plan-014](../plans/014-workflow-authoring-and-execution.md) |
| `sidekicks mcp list` · `add` · `remove` · `override` · `login` · `watch` | Lists, adds, removes and overrides MCP servers; `login` signs in to a server and `watch` follows changes live. | [Plan-022](../plans/022-mcp-server-configuration-and-governance.md) |
| `sidekicks provider account list` · `register` · `correct` · `remove` · `switch` · `probe` | Lists, registers, corrects and removes Claude Code and Codex accounts; `switch` makes one the provider's current account; `probe` checks one. | [Plan-023](../plans/023-provider-accounts-and-credential-homes.md) |
| `sidekicks provider account login` · `code` · `cancel` | Starts an account's sign-in, hands in the sign-in page's code, or cancels a sign-in under way. | [Plan-023](../plans/023-provider-accounts-and-credential-homes.md) |
| `sidekicks provider account observe <account> on\|off` | Turns the per-account observer on or off. | [Plan-023](../plans/023-provider-accounts-and-credential-homes.md) |
| `sidekicks provider account quota` · `spend` | Shows an account's quota per limit, and its spend with the total across accounts. | [Plan-023](../plans/023-provider-accounts-and-credential-homes.md) |
| `sidekicks crash list` | Lists the crash reports this computer keeps. | [Spec-021](../specs/021-desktop-app-and-renderer.md) |
| `sidekicks open <address>` | Hands a `sidekicks://` address to the desktop app, as following the link does. | [Spec-021](../specs/021-desktop-app-and-renderer.md) |
| `sidekicks help [command]` | Prints the help for the command line or for one command. | [Plan-005](../plans/005-local-ipc-and-daemon-control.md) |

## What the command line prints

Each act prints one line naming the act and the background service. A question is its sentence, then `[y/N]`; `y` or `yes` in any case is a yes, and `--yes` answers it beforehand.

| Command | Lines |
| --- | --- |
| `daemon start` | `Started the background service.` · `The background service is already running.` · on Linux, where the service cannot leave the login's scope: `Started the background service. It stops when you log out: <cause>.` · the service that runs while the person is logged out, started without `sudo` (exit 77): `The background service runs while you are logged out. Start it with sudo sidekicks daemon start.` · launchd not running it in time under `sudo` (exit 69): `The background service did not start running within <ms> ms of its start` |
| `daemon stop` | the question `Stop the background service? Work in flight stops, and nothing new starts until it is running again.`, with how many sessions typed in a terminal will disconnect, or `Couldn't count the sessions typed in a terminal. Any there will disconnect.` · `Stopped the background service.` · `The background service is not running.` |
| `daemon restart` | the question `Restart the background service? Work in flight continues once it is back.` · `Restarted the background service.` · without `sudo` for the service that runs while the person is logged out (exit 77): `The background service runs while you are logged out. Restart it with sudo sidekicks daemon restart.` |
| `daemon start` · `restart` under `sudo` with `--daemon-path` (exit 78) | `The background service runs while you are logged out with its own program. Run the command again without --daemon-path.` |
| `daemon install` | `Installed the background service. It starts at login and is running now.` · over SSH with no one at the Mac's screen: `Installed the background service. It starts at your next login at this Mac.` · `The background service is already installed. It starts at login.` · `--while-signed-out` under `sudo`: `Installed the background service for this Mac. It runs while you are logged out.`, `The background service is already installed to run while you are logged out.`, or, with secrets still in the login keychain, `This Mac cannot keep the background service running while you are logged out: the sign-ins and secrets are in the login keychain. Log in at this Mac once, run the command there, then it runs while you are logged out.` · a plain install beside that service: `The background service is already installed to run while you are logged out. See it with sidekicks daemon status.` |
| `daemon uninstall` | `Removed the background service. Your data is kept.` · where the app runs it: `The app runs the background service on this computer. Turn it off in System Settings › General › Login Items & Extensions.` · the service that runs while the person is logged out: `The background service no longer runs while you are logged out. It starts at login and is running now.` (with no one at the screen: `… It starts at your next login at this Mac.`), canceled: `The background service still runs while you are logged out: the administrator password was not given.`, refused by macOS: `The background service could not be fully removed: <macOS's message>. Check it with sidekicks daemon status.`, without `sudo` or a screen session: `The background service runs while you are logged out. Remove it with sudo sidekicks daemon uninstall.` |
| `daemon status` | `The background service is running and starts at login.` · `The background service is installed and starts at login, but is not running.` · `The background service is not installed.` · `The background service is installed but turned off in System Settings › General › Login Items & Extensions.` · `The background service is running and keeps running while you are logged out.` · `The background service is installed to keep running while you are logged out, but is not running.` · `The background service speaks protocol <the service's>; this command speaks <its own>. Update the one that is older.` |
| any command that starts the service, where the person turned the app's service off | `The app's background service is turned off. Turn it on in the app's Settings › Runtime.` |
| `data erase` | refused while the service runs: `Stop the background service first: sidekicks daemon stop. Then run sidekicks data erase again.` · `Erased everything this app keeps on this computer.` |
| `data restore` | refused while the service runs: `Stop the background service first: sidekicks daemon stop. Then run sidekicks data restore again.` · the question `Restore the backup from <date and time>? What this app keeps now is replaced by the backup's copy.`, the date and time from the backup's manifest · `Restored the backup. Start the background service with sidekicks daemon start.`; the service stays stopped, as after `data erase` |
| `data export` | `Exporting… 12 of 40 sessions.` then `Exported 40 sessions to <path>.` |
| `open` | with no app to take the address: `No app on this computer opens sidekicks:// addresses. Install the AI Sidekicks app, then try again.` |

## Modes of the service's program

Nobody types these. One program, `sidekicks-daemon`, is signed and shipped; the service, a provider or git starts it in one of these modes as `sidekicks-daemon <mode> …`. Each mode is a hidden command, so the program's help lists none of them.

| Mode | Started by | What it does |
| --- | --- | --- |
| `hook provider --event <event> --hooks <session file>` | Codex, as a hook command | Runs a Codex helper's own command hooks; on the terminal Codex service, relays the daemon's two hooks to the service. |
| `hook git <hook name>` | git | The commit hook that stamps `Agent-Run`. |
| `system-service` | launchd, from the property list `sudo sidekicks daemon install --while-signed-out` writes | Runs the background service as the Mac's system service, which keeps running while the person is logged out. |
| `secrets move files` · `secrets move keychain` | `sidekicks daemon install --while-signed-out` and `sidekicks daemon uninstall`, in the person's login session | Moves the service's secrets from the login keychain into the items file of the service that runs while the person is logged out, or back into the login keychain. |
| `secrets check keychain` | `sidekicks daemon uninstall`, in the person's login session | Checks that the login keychain takes a value now, without holding the data folder, before secrets are moved back into it. |
| `wsl` | The service, through `wsl.exe` | The WSL server, one per WSL 2 distribution that has work. |
| `banners` | The service, in the person's Windows desktop session | Shows and withdraws Windows notifications while the service runs signed out. |
| `shell <daemon-pid>` | The service | Starts each terminal shell inside the service's process containment, reading the shell's program, arguments, folder, environment and any text the shell parses itself, and the fallback shell's launch, from its start confirmation. |
| `console <pid>` | The service, on Windows | Sends a shell the hard stop (`CTRL_BREAK_EVENT`) and checks whether a console is waiting. |
| `console input <pid>` | The service, on Windows | Writes how many input events wait unread on a shell's console, so the screen's answers stop while its program reads none of them. |
| `environment <marker>` | The person's login shell, which the service starts once at its start | Prints the environment the login shell hands it between two marker lines, each entry ended by a NUL, so the service reads the environment every provider starts from without any program of the system's. |
| `minidump` | The service | Writes the service's own crash reports. |
| `index` | The service | Rebuilds the session search index in a child process, so a crash there cannot take the service down. |
| `database shell` | The service | SQLite's own shell, used for `.recover` on a damaged database. |
| `database copy` | The service | Copies a damaged database aside in a child process, so the service's file locks survive. |
| `database restore <backup>` | `sidekicks data restore` or the app | Restores a backup with the service stopped. |
| `data erase` | `sidekicks data erase` | Erases everything the app keeps on this computer with the service stopped: signs every account home out through its provider's own sign-out before it deletes it, then ends what a stopped service left running, deletes the keychain items, then the data folder but its backups. |
| `ingest` | The service | Draws a file's preview, such as a PDF's first page, in a throwaway child process. |

## Program and link files

| File | Run by | What it is |
| --- | --- | --- |
| `sidekicks` | The person | The command line. |
| `sidekicks-daemon` | The operating system, once `sidekicks daemon install` registers it | The background service and every mode above. |
| `sidekicks-wake-helper` | macOS | The wake helper: its own program because it runs as root, links only IOKit and talks only over its socket. |
| `sidekicks-command-wrapper` | Claude Code (`CLAUDE_CODE_SHELL_PREFIX`), and Codex through the executor relay | A link to `sidekicks-daemon` that wraps each command an agent runs, so the service sees and controls it. |
| `sidekicks-command-askpass` | git and ssh inside an agent's command (`GIT_ASKPASS`, `SSH_ASKPASS`) | A link to `sidekicks-daemon` that brings git's and ssh's password questions to the person. |
| `sidekicks-git-askpass` | git, during a clone the service runs | A link to `sidekicks-daemon` that brings a clone's questions to the clone card. |

A link's file name picks its mode, whatever folder it runs from, so each link runs the same signed program. The links live in the `bin` folder of the service's data folder (`~/.ai-sidekicks/bin`), never beside the program, whose folder sits inside the signed app and may not be writable. The service makes each link there at its start, in development and in a release alike, where one is missing, cannot be opened or opens another build: a hard link, a symbolic link where the system refuses a hard link for any reason, and on Windows a copy where it refuses a symbolic link too. A link a crashed start left half made is removed first, and one that cannot be removed is logged and left. A missing link the service cannot make fails its start; one that opens another build or cannot be opened, and cannot be made again, such as a copy a running command still holds on Windows, is logged and kept until the next start.
