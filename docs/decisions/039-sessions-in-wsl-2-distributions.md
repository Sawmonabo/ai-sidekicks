# ADR-039: Sessions In WSL 2 Distributions

| Field         | Value                                          |
| ------------- | ---------------------------------------------- |
| **Status**    | `accepted`                                     |
| **Type**      | `Type 1 (two-way door)`                        |
| **Domain**    | Daemon, Local IPC, Windows, Credential Custody |
| **Date**      | 2026-10-16                                     |
| **Author(s)** | Claude (AI-assisted)                           |
| **Reviewers** | Sawmon Abo                                     |

---

## Context

On a Windows computer a person may keep projects inside a WSL 2 distribution, such as Ubuntu, and install Claude Code or Codex there. Both providers support it: Claude Code documents its desktop app running a session's process, tools and git inside the distribution, and Codex documents WSL 2 as a supported place to run. A person who works that way expects the product to work there too, beside projects kept on a Windows drive.

The background service is the person's own long-running process: it starts providers, holds their sessions, runs terminals and workflows, and outlives the desktop app ([Spec-006 §Required Behavior](../specs/006-local-ipc-and-daemon-control.md#required-behavior)). Its local clients — the desktop app's client helper and the CLI — reach it over an OS-local transport, a named pipe on Windows ([ADR-008](./008-default-transports-and-relay-boundaries.md)), with loopback rejected as a weaker local boundary. A computer is one machine to the person's other devices: it is listed once and has one identity key ([Spec-027](../specs/027-remote-control.md)). Several jobs the service owes while the app is quit are Windows-only: keeping the machine awake, waking it for a reset, posting and withdrawing banners, and custody in Credential Manager.

WSL imposes its own rules. A distribution's instance ends 15 seconds after its last Windows client closes (`instanceIdleTimeout`) and the virtual machine 60 seconds after the last instance (`vmIdleTimeout`); systemd services and Linux background processes inside it do not keep it alive; a user's whole WSL ends at the sign-out of the Windows session that first reached it. A killed `wsl.exe` closes its program's standard streams and sends it no signal. After a sleep a new `wsl.exe` can hang until a reboot (microsoft/WSL#14005), and at Modern Standby every host-to-guest socket can drop at once. Files on the Windows–WSL file bridge are slow and break file watching, so Microsoft's rule is to "store your files in the WSL file system if you are working in a Linux command line".

## Problem Statement

On a Windows computer whose projects and providers may live on Windows, in one or more WSL 2 distributions, or both, where does the background service run, where does each session run, and how does the service reach work inside a distribution?

### Trigger

WSL 2 is a first-class place to keep projects and run Claude Code and Codex. The service's install, start, pipe and custody on Windows, a session's provider, terminals, git and file work, and every per-account home each depend on this answer.

---

## Decision

We will run one background service per Windows computer, the native Windows daemon, whether or not WSL is installed; for each WSL 2 distribution that has work it starts that distribution's WSL server, a helper mode of the Linux `sidekicks-daemon` program, which does the distribution's provider, terminal, git, file and watch work and talks to the daemon over one channel on the stdio of one long-lived `wsl.exe`; and each session runs where its project folder is — a folder on a Windows drive on Windows, a folder inside a distribution in that distribution — written at creation and never changed, with no override.

### Thesis — Why This Option

- **One service, native on Windows.** One service keeps the computer one machine, with one store, one identity key and one registration, which is what linked devices and the relay assume. Native on Windows, because then the virtual machine is down whenever no WSL work exists, every client call stays on the native per-user pipe, each Windows-only job (the logon task, the pipe, Credential Manager, keep-awake, the wake timer, banners) has one implementation in the daemon's own process through `sidekicks-platforms`, and a computer with WSL runs the same daemon a computer without it runs. ADR-008's OS-local default and its rejection of loopback hold with nothing WSL-specific.
- **The WSL server does a distribution's work.** It runs that distribution's provider processes, terminals, git and worktrees, file reads and watches, workflow steps, and the local endpoints providers and hooks dial. It never holds the store, credentials, the scheduler, the relay connection or approvals, and it holds no secret at rest. It is a mode of the shipped Linux `sidekicks-daemon`, `sidekicks-daemon wsl-server`, so no other binary is built or signed. The daemon starts it with `wsl.exe --exec`, which runs no Linux shell, so the person's shell and its rc files never re-read its arguments. Editors put the same hop in the same place: VS Code's "VS Code Server" and Zed's "remote server" run inside the distribution and talk to the Windows side over `wsl.exe`.
- **One channel per distribution, not a link per connection.** Each distribution with work gets one long-lived `wsl.exe` carrying one HTTP/2 channel on its standard input and output, `h2` 0.4.20 on tokio on both ends, the daemon the client. Every provider process, terminal, file read, watch, carried connection and local client of the server's endpoints is one stream. A link per connection would cost a process pair each, and after a sleep a new `wsl.exe` can hang until a reboot, so every new connection would hang. HTTP/2 brings multiplexing, flow control and backpressure from a maintained implementation rather than a framing of our own.
- **The folder decides where a session runs.** A session uses the provider installed where its project folder lives, with the paths, sandbox and hooks that provider's own documentation describes, and offers `Install in Ubuntu` where the provider is missing there. No session works on another place's disk, so nothing reads across the file bridge for a session's work, and every worktree sits on its project's side. A folder under `/mnt/<drive>` is a Windows folder and runs on Windows.
- **The WSL server runs only while its distribution has work** and exits 10 minutes after the last work ends, closing its stdout first; WSL then stops the distribution and the virtual machine on its own timers. The person's `.wslconfig` is never edited.
- **One sign-in per account, one home per place.** An account's provider sign-in is one store in the daemon's Windows data folder, which providers in a distribution read through a private mount the daemon makes, so a refresh token is never copied. Everything else in an account's home lives in the home in the place where its sessions run, because Codex rebuilds its memory folder from a local database and Claude Code's settings watcher sees no change across the file bridge.
- **The Linux runtime ships inside the Windows installers**, the Linux release's Rust builds for `x86_64` and `aarch64` on glibc and musl, so the first WSL session works offline and runs the bytes a Linux user downloads, and an Alpine distribution runs the WSL server as Ubuntu does.

---

## Alternatives Considered

### Option A: The native daemon, a WSL server per distribution with work, one channel each, the folder decides (Chosen)

- **What:** One native Windows daemon per computer; a WSL server, `sidekicks-daemon wsl-server`, inside each WSL 2 distribution that has work, reached over one HTTP/2 channel on one `wsl.exe`'s stdio; each session runs where its project folder is.
- **Steel man:** It keeps every local-transport rule, adds no listening port for the service's clients, keeps the virtual machine down when no WSL work exists, gives each Windows job one implementation, runs each provider where its documentation says it runs, and keeps the computer one machine.
- **Weaknesses:** A WSL session's own work takes one hop over the channel, whose latency and throughput are measured before build. The channel rests on `wsl.exe`'s standard streams carrying binary intact, which a probe checks on every supported build. Work kept on at all times in a distribution, such as a Codex terminal service, keeps the virtual machine up.

### Option B: The service inside a distribution, with a native Windows program for the Windows jobs (Rejected)

- **What:** The daemon runs inside the distribution where the providers are installed, and a small native Windows program started by a logon task holds one attached `wsl.exe` open, serves the named pipe by carrying each client over that link, and does the Windows-only jobs.
- **Steel man:** Every provider process is a direct child of the daemon, with no hop for a WSL session's work.
- **Why rejected:** The virtual machine stays up for the service's whole life; every local call on that computer, Windows sessions included, crosses into WSL; a second native program is built, signed and shipped; a computer with projects in both places needs one side to reach the other's files across the bridge or a move of the whole service between sides; and every Windows job has a second home.
- **What would change the answer:** None of the Windows jobs remaining Windows-only, and WSL keeping an instance alive on its own for a service inside it.

### Option C: One service per place (Rejected)

- **What:** A service on Windows and another inside each distribution, each with its own store.
- **Steel man:** Each place runs its own providers natively with no channel between them.
- **Why rejected:** Several identities for one computer, against the one machine linked devices and the relay see; several stores the person must keep in step; and a service in one place cannot see sessions in another.
- **What would change the answer:** The product letting one computer present as several machines, which it does not.

### Option D: A `wsl.exe` per connection (Rejected)

- **What:** Each process, terminal or client connection into a distribution starts its own `wsl.exe` running a small relay.
- **Steel man:** Simple, no multiplexer, each connection isolated.
- **Why rejected:** A process pair per connection, and after a sleep every new `wsl.exe` can hang until a reboot while running ones keep working, so every new connection would hang.
- **What would change the answer:** WSL fixing the post-sleep hang, together with the channel probe finding one link per connection cheap enough.

### Option E: A WSL server that outlives its link (Rejected)

- **What:** The WSL server detaches from `wsl.exe` and stays up between connections, reached again by a new link.
- **Steel man:** A server survives a dropped link and keeps its warm state.
- **Why rejected:** WSL ends an instance 15 seconds after its last Windows client, Linux background processes do not keep it up, and at Modern Standby every host-to-guest socket can drop at once, so outliving the link keeps nothing through a sleep and adds a reconnect path.
- **What would change the answer:** WSL keeping an instance alive for a process inside it with no Windows client.

### Option F: A per-session override of where a session runs (Rejected)

- **What:** The folder sets a default place and the person may pick the other place for a session, running a provider on Windows against a distribution's folder or the reverse.
- **Steel man:** A person with a provider installed in only one place can use it on any folder.
- **Why rejected:** A session would work across the file bridge, which is slow and breaks file watching, and a second way of running each provider, with paths, sandbox and hooks the providers do not document, would need its own tests. `Install in <place>` installs the provider where the folder is with one press, and the per-place `Command` override points a place at another install.
- **What would change the answer:** The file bridge carrying file watching and the providers documenting a cross-place mode.

---

## Reversibility Assessment

- **Reversal cost:** Days. The WSL server's role sits behind one routing interface chosen by a session's place; replacing the channel changes the daemon's channel end and the WSL server, not the clients, the store or custody.
- **Blast radius:** Where a session runs on a Windows computer with WSL, the WSL server and its channel, the per-place provider readings in Settings › Providers, the per-place account homes and the private mount.
- **Migration path:** Replace the channel with another carrier between the same two ends; the store, custody, the pipe and each session's place are unchanged.
- **Point of no return:** None for the transport. A session's place is written at creation, so a later design keeps each session in its place.

## Consequences

### Positive

- The providers run where the person installed them, beside the folder they work on, with nothing to reinstall.
- The computer stays one machine with one service, one store and one key, with or without WSL.
- Local clients keep one transport and one pipe name on every Windows computer, with no listening port for the service's clients.
- Every Windows-only job has one implementation, in the daemon.
- The WSL virtual machine runs only while a distribution has work.

### Negative (accepted trade-offs)

- One more hop for a WSL session's own work, measured against [Plan-005](../plans/005-local-ipc-and-daemon-control.md) Phase R4's budgets.
- A Codex account with sessions in a distribution runs one more Codex service there.
- Work a person keeps on at all times in a distribution keeps the virtual machine up; its cost is measured and stated in [deployment-topology](../architecture/deployment-topology.md#local-daemon-memory-instrumentation-and-budget), and Runtime's figure counts only the service's own processes.
- Sessions in a distribution run while the person is signed out of Windows only where the signed-out task's daemon reaches WSL; where it does not, they wait for the next sign-in and Runtime says so.

### Unknowns

- Whether `wsl.exe`'s standard streams carry 1 GB of random bytes intact both ways from a program with no console on every supported build. Where they do not, the channel carries its frames base64-encoded on the same link.
- The channel's latency and throughput against a native session's local work, a terminal flood, the WSL server's and `wsl.exe`'s resident memory, and the virtual machine's working set with one session. Measured before build.
- Whether one Claude Code sign-in store serves sessions on Windows and in a distribution at once through the private mount, a sleep included. Where it does not, each account gets a second sign-in per place, made by Claude Code's own sign-in and never copied.
- Whether a task set to run while the person is signed out reaches WSL with no one signed in.

---

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| WSL basic commands | Documentation | `--exec` runs without the default Linux shell; `--shutdown` stops every distribution and the VM; `--unregister` loses all data; `Sysnative` for a 32-bit caller | https://learn.microsoft.com/en-us/windows/wsl/basic-commands |
| WSL configuration | Documentation | `instanceIdleTimeout` 15000, `vmIdleTimeout` 60000; automount off still allows a manual mount; `metadata` off by default | https://learn.microsoft.com/en-us/windows/wsl/wsl-config |
| WSL file systems | Documentation | Store files in the WSL file system when working in a Linux command line | https://learn.microsoft.com/en-us/windows/wsl/filesystems |
| WSL networking | Documentation | Mirrored mode shares loopback; NAT keeps Windows loopback from Linux; `ignoredPorts` | https://learn.microsoft.com/en-us/windows/wsl/networking |
| WSL source | Source code | The last Windows client gone ends the instance; a killed `wsl.exe` sends no signal; standard handles that are not consoles are relayed raw; the per-user session ends with the Windows session that first reached it; `--exec` and `--cd ~` usage text | github.com/microsoft/WSL at commit `91f161fa` and tag 3.0.3 (`src/windows/service/exe/LxssUserSession.cpp`, `LxssUserSessionFactory.cpp`, `src/linux/init/init.cpp`, `localization/strings/en-US/Resources.resw`) |
| WSL issues 9231, 14005, 41937 | Issue tracker | Session 0 reaches WSL only through the Program Files `wsl.exe`; a new `wsl.exe` can hang after sleep and every host-to-guest socket can drop at Modern Standby; a piped `wsl --list` can come back empty | https://github.com/microsoft/WSL/issues |
| JOBOBJECT_BASIC_LIMIT_INFORMATION | Documentation | Kill-on-close and silent breakaway | https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information |
| CreateNamedPipeW; Named Pipe Security and Access Rights | Documentation | `FILE_FLAG_FIRST_PIPE_INSTANCE` makes a second create fail with `ERROR_ACCESS_DENIED`; the default descriptor gives Everyone and anonymous read | https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-createnamedpipew |
| `h2` 0.4.20 | Package registry | Published 2026-10-06, MIT; the release both ends of the channel pin; no keepalive | https://crates.io/crates/h2 |
| Claude Code on WSL | Documentation | Sessions run in the distribution with native Linux paths; the distribution share is a network filesystem that breaks file watching | https://code.claude.com/docs/en/desktop-wsl |
| Codex on Windows and WSL | Documentation | WSL 2 supported, WSL 1 not; WSL does not share configuration, auth or history with the Windows app | https://learn.chatgpt.com/docs/windows/wsl |
| VS Code Remote - WSL | Documentation | VS Code installs its server inside WSL and talks to it through `wsl.exe` | https://code.visualstudio.com/docs/remote/wsl |
| Zed's WSL transport | Source code | Starts its server with `wsl.exe --distribution … --cd ~ --exec` and carries its protocol over stdio | github.com/zed-industries/zed at `2d4c4831`, `crates/remote/src/transport/wsl.rs` |

### Related ADRs

- [ADR-008](./008-default-transports-and-relay-boundaries.md) — the OS-local default and the rejection of loopback, which hold on a Windows computer with WSL.
- [ADR-020](./020-cli-identity-key-storage-custody.md) — every daemon secret as its own credential-store item, which the native daemon keeps in Credential Manager in its own process.
- [ADR-026](./026-provider-credential-custody-posture.md) — provider credentials; each account's sign-in is one store on Windows, read by a distribution's providers through the private mount and never copied.
- [ADR-034](./034-embedded-browser-for-preview.md) — Preview; the daemon carries a dev server's port from a distribution when WSL cannot.
