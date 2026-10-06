# macOS Service Probes

The probes [Plan-005 §Phase R3 — Client Delivery](../plans/005-local-ipc-and-daemon-control.md#phase-r3--client-delivery) owes on a Mac, for the system service that keeps the background service running while the person is logged out, which `sidekicks daemon install --while-signed-out` has the app register ([Spec-006 §Required Behavior](../specs/006-local-ipc-and-daemon-control.md#required-behavior)).

## Phase R3 — probes owed on a Mac

Each runs on a Mac with macOS 13 or later before macOS's `--while-signed-out` is built (T-005r-3-11), as the person, with an administrator password at hand for the one approval. The app registers its system service through `SMAppService`, so each row registers its test service from a test app. Nothing changes a system setting except where the row says so, and those are reverted after.

| What is run | Expected | Decides |
| --- | --- | --- |
| A test app registers a test system service through `SMAppService` that runs a program as the person, approved once with an administrator password in System Settings › General › Login Items. Claude Code's sign-in in its own sign-in file, `.credentials.json` in its config home, and Codex's in `auth.json` with `cli_auth_credentials_store = "file"`, each at mode `0600`, and no sign-in in the login keychain. Restart the Mac and, before logging in, have the service start a Claude Code turn and a Codex turn the way the daemon runs them; log in and run both again; log out and run both again, and again 30 minutes later | Recorded for each provider at each moment: whether it is signed in from its file and finishes its turn, whether it writes anything to the login keychain, and each failure with its error | Whether `--while-signed-out` ships on macOS, or refuses with the cause found |
| The same service registered and approved; turn it off in System Settings › General › Login Items; read its status from the test app; turn it back on and read again | Each status read recorded | How the main process reads `whileSignedOut`'s `turnedOffInLoginItems` |
| A per-user login agent running a program that logs the signals it receives; log out | `SIGTERM` logged at logout, and the program gone | That the login agent alone stops at logout |
