# macOS Service Probes

The probes [Plan-005 §Phase R3 — Client Delivery](../plans/005-local-ipc-and-daemon-control.md#phase-r3--client-delivery) owes on a Mac, for the service that keeps running while the person is logged out, which `sidekicks daemon install --while-signed-out` registers ([Spec-006 §Required Behavior](../specs/006-local-ipc-and-daemon-control.md#required-behavior)).

## Phase R3 — probes owed on a Mac

Each runs on a Mac with macOS 13 or later before macOS's `--while-signed-out` is built (T-005r-3-11), as the person, with an administrator password at hand for the one approval. A system service registered through `SMAppService` belongs to an app, so each row registers its test service from a test app. Nothing changes a system setting except where the row says so, and those are reverted after.

| What is run | Expected | Decides |
| --- | --- | --- |
| A test app registers a test system service through `SMAppService` that runs a program as the person, approved once with an administrator password in System Settings › General › Login Items. Claude Code signed in as it signs in on macOS, keeping its sign-in in the Keychain, and Codex with `cli_auth_credentials_store = "file"`. Log out; while logged out, the service starts a Claude Code turn and a Codex turn the way the daemon runs them, and again 30 minutes later; log back in | Recorded for each provider: whether it stays signed in and finishes both turns while the person is logged out; where Claude Code kept its sign-in, the Keychain or `~/.claude/.credentials.json`, which it writes only when the Keychain rejects the write; and each failure with its error | Whether `--while-signed-out` ships on macOS, or refuses naming the cause found |
| The same service registered and approved; turn it off in System Settings › General › Login Items; read its status from the test app; turn it back on and read again | Each status read recorded | How the main process reads `whileSignedOut`'s `turnedOffInLoginItems` |
| The same service and a per-user login agent, each running a program that logs its start and its end; log out, log in, log out again | Which program runs at each moment, with times, and whether both ever run at once | How the system service and the login agent hand the daemon to each other at logout and at login |
| A per-user login agent running a program that logs the signals it receives; log out | `SIGTERM` logged at logout, and the program gone | That the login agent alone stops at logout |
