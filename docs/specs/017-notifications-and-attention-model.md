# Spec-017: Notifications And Attention Model

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `017` |
| **Slug** | `notifications-and-attention-model` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Depends On** | [Live Timeline Visibility And Reasoning Surfaces](../specs/011-live-timeline-visibility-and-reasoning-surfaces.md), [Desktop Architecture](../architecture/desktop.md), [Observability Architecture](../architecture/observability-architecture.md) |
| **Implementation Plan** | [Plan-016: Notifications And Attention Model](../plans/016-notifications-and-attention-model.md) |

## Purpose

Define how the product turns session and run state into attention surfaces and notifications.

## Scope

This spec covers in-app attention state, the operating system's notification on the machine and on each of the person's other devices, the two ways a moment leaves the machine (a web address and an email digest), the switches and the per-session mute that govern them, and notification degradation paths.

## Non-Goals

- The phone apps, the web client's service worker and the push senders themselves ([Spec-027](027-remote-control.md), [Spec-028](028-ios-remote-client.md)); this spec decides which moment reaches which device and when
- Marketing or email campaigns; the email digest is a notification channel to the person's own address, never a campaign
- A full on-call paging policy for the person

## Domain Dependencies

- [Session Model](../domain/session-model.md)
- [Run State Machine](../domain/run-state-machine.md)
- [User And Device Model](../domain/user-and-device-model.md)

## Architectural Dependencies

- [Desktop Architecture](../architecture/desktop.md)
- [Observability Architecture](../architecture/observability-architecture.md)

## Required Behavior

- The system must surface attention-worthy session and run states even when the user is not actively watching the timeline.
- Attention has four kinds:
  - `Waiting on you`: an approval, a question, or a plan waiting on its card, Claude Code's retry-or-edit choice waiting on a refused turn's row, or its switch-or-credits choice waiting on a Fable turn's row, on a session or a workflow run (actionable);
  - `Finished`: a session or a workflow run that finished (informational);
  - `Failed`: a session or a workflow run that stopped on an error (informational);
  - a workflow's Notify step: the notice the person wrote into the workflow (informational).

  An agent naming the person is not one.

- Notification emission must be derived from canonical session or run state, not from client heuristics alone. For a session, the daemon writes each entry from what the provider reports, never from a provider's own notification feature, so both providers behave alike: on Claude Code from the held permission or question request and the turn's `result`, on Codex from the thread status flags `waitingOnApproval` and `waitingOnUserInput` and from `turn/completed`.
- A workflow's Notify step is one informational entry on the attention projection, with trigger `workflow_notify`, carrying the step it came from, with no event of its own on the workflow's stream.
- Users must be able to distinguish passive informational notifications from actionable blocking attention.
- The attention model must support both run-scoped attention and session-scoped aggregate attention derived from canonical state.
- Attention is counted from the projection and never recomputed by a client. Only unresolved actionable moments count; an entry leaves the counted group the moment its moment resolves; and informational moments (a session or run that finished or failed, and a Notify step) are listed and never counted.
- There is one count, not several. The figure the in-app bell carries and the figure on the application icon are the same read of the same projection, so the two can never disagree, and the bell is the only badge the console draws on screen.
- Every attention moment carries an identity of its own, the subject and the moment it is in, so a later state for the same subject replaces what was already posted for it instead of standing a second notice beside it.
- Whether an entry may raise a notification is decided once, by the daemon, when it writes the entry: it reads the machine's settings file at that moment, keeps no copy and runs no watcher, and applies the master switch, the entry's kind switch and the session's mute together.
- A session can be muted from its own actions list. A muted session raises no `Finished` or `Failed` notification on any device, sends none to the web address and leaves those lines out of the email digest; its `Waiting on you` and a workflow's Notify step are untouched, and so are the bell's list and the count.
- Losing the connection to the local daemon is not attention. It raises no entry, no count, and no notification, because nothing is waiting on a person to decide; the working line shows the connection state instead ([Spec-018 §Required Behavior](018-observability-and-failure-recovery.md#required-behavior)).
- A session in an exchange with another session is not waiting on the person either. The exchange line its row carries while the two are trading messages is never an attention entry, never reaches the count, and never reaches the bell: two sessions working on each other's behalf is work going on, not a decision anyone is being asked for ([Spec-014 §Sessions Talking To Each Other](014-multi-agent-orchestration.md#sessions-talking-to-each-other)).

## Default Behavior

- Pending approval or required input, and a plan waiting on its card, is actionable attention by default.
- Completion and failure, of a session or a workflow run, are informational attention by default, and so is a workflow's Notify step.
- While no app window is in front on this machine, each kind is posted as an operating-system notification beside the in-app bell. While an app window is in front, whichever screen or pane it shows, attention stays on the in-app surfaces and no notification is posted, except a workflow's Notify step, which is the person's own instruction and posts either way.
- Run-scoped attention defaults to the fine-grained source projection, while session-scoped attention defaults to an aggregate of unresolved run-scoped and session-native signals.
- Settings › Notifications holds two switches, both on by default: `Show a count on the app icon`, and `Notify me outside the app`, which governs every operating-system notification on this machine, under the line `Posted while the app is not in front; a workflow's Notify step posts either way.`
- Beneath `Notify me outside the app` sit four kind switches, each on by default: `Waiting on you`, `Finished`, `Failed` and `Notify steps`. A kind switched off stops that kind's notification on this machine and nothing else: the bell's list still holds every entry, the app-icon count still counts every waiting entry, and a notification already posted is still replaced and withdrawn by its moment. With `Notify me outside the app` off, the four keep their state and draw grayed, each reading `Turned off above.` The four describe this machine's screen; each of the person's other devices keeps its own switches and kinds.
- A session's mute is set from its own actions list (`Mute notifications`, and `Unmute notifications` on a muted session) and nowhere else. It has no timer and no list on the Settings page; the session's row and its inspector show it.
- `Send to a web address` and `Email me what I have not seen` are both off until the person sets them up.
- The page's switches and a session's mute are the only things that silence a notification, and the page's first switch alone hides the count. Nothing outside them overrides them — no environment variable, no hidden flag, no stored daemon preference — so a kind switch drawn on means that kind's notification would arrive for any session whose row shows no mute. The page never renders the daemon's own stored records as further switches, and nothing makes a sound.

## Fallback Behavior

- If OS notifications are unavailable or denied, the system must still show in-app badges and attention summaries: the switches and the kinds still draw, the Notifications page says in place that the operating system is refusing, and the bell and the in-app count keep working. Where a platform cannot post a notification at all, the page says so in the same place.
- If notification delivery is delayed, the session attention projection must still reflect outstanding actionable items.
- A kind switch, the master switch and a session's mute withhold notifications and deliveries off the machine only. None of them removes, hides or downgrades an entry in the bell's list or the count, none of them gates a withdrawal, and a mute never withholds `Waiting on you`.
- A web-address message that fails is tried again at 5 seconds, 5 minutes and 30 minutes and then counted as undelivered on the page's status line; at most 100 messages wait at once, and past that the oldest is dropped and counted. A digest the mail server refuses, or cannot be reached for, is written on the page's status line, the switch stays on, nothing is queued past its period, and the next period tries again.
- A keychain that is locked or unavailable when a delivery secret is needed refuses the act with its cause and falls back to no other store.

## Interfaces And Contracts

- `attention.projectionRead` is served live: the whole projection, then every change, the way `command.list` is served, so no `attention.subscribe` exists. It exposes current actionable and informational attention state at both run and session scope, and it is the one read behind the bell's count, the bell's list, and the count on the application icon. The main process posts and withdraws the operating-system notification from that same read rather than from a channel of its own.
- Every entry names the moment it speaks for with a stable id, `momentId` (the session or run and the moment it is in), so a replacement notification replaces its predecessor instead of accumulating beside it. An entry also carries its display name (the session's name, or the run's name on a run's entry), a state phrase, its kind, the step's id on a Notify-step entry, a reference to the canonical event or state that caused it, and `bannerState` (`pending | posted | withheld | withdrawn`). The daemon writes `withheld` when it writes an entry whose kind is switched off, whose master switch is off, or that is a muted session's `Finished` or `Failed`; a withheld entry starts nothing. An entry's summary never becomes a notification's body.
- `attention.bannerSettle {entryId, state}` records what became of an entry's notification. Only the main process calls it, and it is a no-op once the entry is past `pending`, so a notification is never posted twice.
- `attention.seenUpdate {sessionId}` marks a session seen: the one seen-or-unseen fact behind a session row's done dot and the email digest.
- `session.mute {sessionId}` and `session.unmute {sessionId}` answer `{}` and are idempotent: muting a muted session appends nothing. They append `session.muted {sessionId, at}` and `session.unmuted {sessionId, at}`, and every `session.list` and `session.read` entry carries `muted`. On `session.muted` the daemon withdraws the session's `Finished` and `Failed` notifications still standing, by their moment ids.
- There are no attention-preference methods. The switches, the kinds, the web address's switch and its `Send` kinds, and the email digest's settings live in the machine's settings file under `notifications`, written by the daemon, the file's one writer, through the main process's `machineSettings.write(change)` and read through `machineSettings.read()` and `machineSettings.subscribe()`; the main process reads the operating system's notification permission beside them with `native.getNotificationPermission()`. The kind keys are `notifications.kinds.waitingOnYou`, `.finished`, `.failed` and `.notifyStep`, booleans that default to `true`, a missing key reading `true`; the web address's are `notifications.webAddress {enabled: false, kinds: {waitingOnYou, finished, failed, notifyStep}}`; the digest's are `notifications.emailDigest {enabled: false, sendTo, mailServer?, port?, userName?, after: hour | fourHours | day}`, `day` by default. No secret is in the file.
- The delivery verbs, in the `attention` domain:
  - `attention.deliveryRead {}` → `{webAddress: {saved, host, lastOutcome}, emailDigest: {passwordSaved, lastOutcome}}`, where `lastOutcome` is `{at, result: delivered | refused | unreachable | timedOut | signInRefused | notEncrypted, httpStatus?, undelivered}` or `null`;
  - `attention.mailPasswordSave {password}` → `{}` and `attention.mailPasswordRemove {}` → `{}`;
  - `attention.webAddressSave {address}` → `{host?, signingSecret?}`, `host` absent for text with no scheme and host, the first save minting the signing secret and returning it once; `attention.webAddressSecretRotate {}` → `{signingSecret}`, returned once; `attention.webAddressRemove {}` → `{}`, which removes the address and the secret;
  - `attention.deliveryTest {channel: webAddress | emailDigest}` → `{outcome}`; on a saved web address with no scheme and host nothing is sent and the outcome's `result` is `notAnAddress`.

  Refusals: `attention.delivery_store_unavailable` (`cause: locked | unavailable`) and `attention.delivery_not_configured` (`missing: address | password`). Apart from the signing secret, returned once when it is made so the receiver can be set up, no secret is on any reply, event, log or error.

- A push to another device is the daemon's `push.send` to the control plane, carrying a notice the machine has already sealed to that device's push key ([Spec-027](027-remote-control.md) owns the senders).
- A notification click reaches the renderer through the main process's navigation member, `window.subscribeToNavigationRequest`, the same path a `sidekicks://` link takes ([Spec-021](021-desktop-app-and-renderer.md) owns the member).
- None of these operations is built yet; [Plan-016 §Implementation Phase Sequence](../plans/016-notifications-and-attention-model.md#implementation-phase-sequence) names the task that builds each.
- See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed request/response schemas.
- See [Error Contracts](../architecture/contracts/error-contracts.md) for error response schemas and error codes.

## State And Data Implications

- Attention state is a derived projection from canonical events, kept by the daemon.
- Session-scoped attention is an aggregate projection over run-scoped and session-native triggers.
- The notification switches are kept per machine and per device, in each one's own settings file. A device hands its own switches and kinds to every machine it links with, on every connection and whenever one changes; the machine keeps the copy it was last handed only to decide before it sends a push, and never edits it.
- A session's mute is the session's own fact: `muted_at` on the session row, rebuilt from the `session.muted` and `session.unmuted` events and gone with the session.
- Each entry keeps its own delivery facts: `bannerState`, `digested_at` once a digest has carried it, and `web_address_state` (`pending | delivered | undelivered`) with an attempt count. Each outside channel keeps one outcome row, overwritten on every attempt and removed with the channel's secret.
- The web address, its signing secret and the mail password are sealed in the operating system's keychain by the daemon, beside the workflow secrets ([ADR-036](../decisions/036-workflow-secrets-in-the-os-keychain.md)); none is ever in the settings file or the app's own store.
- A push is a delivery, not a fact of the session: nothing is written to any session log, and the control plane keeps no notification queue, filter or preference table.
- Notification delivery attempts may be ephemeral, but actionable attention state must remain durable until resolved.

## Notification Delivery

Every notification on every device comes from the machine's own attention entries, in the four kinds: `Waiting on you`, `Finished` and `Failed`, which say the session's or run's name and its state and never what was said, and a workflow's Notify step, which says its run's name and the notice the person wrote. The machine reaches each of the person's devices in exactly one way at a time:

- **A device with a live connection and an app window in front:** nothing is posted; the bell carries it.
- **A device with a live connection and no window in front:** the device posts the operating system's notification itself, from the projection it reads ([§Desktop-to-Desktop Delivery](#desktop-to-desktop-delivery)).
- **A device with no live connection:** the machine sends a push ([§Cross-Device Delivery](#cross-device-delivery)).

The kinds, the text, the stable id, the replacement in place and the withdrawal are the same on every path. The web address and the email digest are the machine's own two ways out, sent by its daemon, not per device.

### The Console's Attention Surfaces

- **The bell and its list.** The bell toggles the notifications list and reads as expanded while the list is open. The list opens in the same track the all-sessions list uses, in flow and never over the screen, and the two are never open together: opening one closes the other. The list holds a `Waiting on you` group with its count over the waiting entries, then an `Earlier` group over what finished or failed and every Notify step since it was last read. A group with no entries is not drawn, and with no entries at all the list shows its heading and nothing under it, with no sentence. An entry is one line — a state dot, the title, the state word (`Waiting on you` · `Finished` · `Failed`), and how long ago it happened; a Notify step's entry reads its run's name and, in place of a state word, the step's own notice text, the same words its push carries, and the hollow ring, the done mark, as a finished entry carries; it sits in `Earlier` with finished entries and is never counted — newest first inside each group, and the whole line is the control: a session entry lands on the session's place, bringing forward the view that shows the session where one does and otherwise switching the focused view of the window used last to it; a workflow-run entry opens that run; neither closes the list. Opening the list puts focus on its first entry and closing it returns focus to the bell. Waiting entries pin above the rest and are the only counted ones. An entry carries no menu and no mute mark of its own, and nothing about a notification is ever said inside a session.
- **The application icon.** The icon carries the same figure the bell carries — the dock icon on macOS and Linux, a number drawn onto the taskbar icon on Windows through the window's overlay icon, because Windows has no count there — from the same projection read, counting only what is waiting on the person right now, and absent at zero rather than showing a zero. The main process sets it with Electron's `app.setBadgeCount` on macOS and Linux and `BaseWindow.setOverlayIcon` on Windows. `Show a count on the app icon` turns it off.
- **A session row is not a notification.** A row's status dot is that session's own state, and the control that opens the all-sessions list carries no mark of its own. A session that finished while the person was away draws its done dot filled until they open it and hollow from the moment they do, from the one seen-or-unseen fact the projection keeps, so the row and the list can never disagree. A muted session's row carries one bell-off mark directly after its title for as long as the mute stands, with the hover title `Notifications muted`, and the inspector's `Notifications` fact reads `Muted` or `Not muted`.

### Desktop-to-Desktop Delivery

- **On the machine, with the app running.** The main process reads the live projection and posts an operating-system notification, through Electron's `Notification`, for each `pending` entry while no app window is in front, and for a Notify-step entry either way; it settles each entry through `attention.bannerSettle`. A window behind a locked or sleeping screen is not in front: the main process reads Electron's `lock-screen`, `unlock-screen`, `suspend` and `resume` events and the system idle state's `locked` where the platform reports it. The notification names the subject and its state and never what was said; it carries the stable id of the moment it speaks for, so a subject that moves from waiting to finished while nobody is looking replaces its own notification in place; it is withdrawn when its moment resolves, except a Notify step's, which is never withdrawn; and a mute withdraws the session's `Finished` and `Failed` notifications still standing. It carries the application's own name and icon on every platform that can post one, and where a platform cannot post one at all the Notifications page says so in place, exactly as it does of a refusal. The main process reads no kind switch: the daemon has already applied every switch and the mute when it wrote the entry.
- **On the machine, with the app closed.** The daemon keeps running when the app quits. When it writes a `pending` entry and no main process is connected, it starts the app's own program with no window (`--banner`; on macOS through LaunchServices, `open -g -b <bundleId> --args --banner`). That process takes the single-instance lock, exiting if a main process holds it; sets the accessory activation policy before any window, so no Dock icon appears; posts the notification through the same poster; settles the entry; and quits itself, because with no window the app's last-window-closed event never fires. Opening the app meanwhile turns that process into the windowed app. A withheld entry starts nothing. Measured on macOS: ready in 0.15 to 0.21 s, gone by 0.3 s, one process of about 113 MB. A click on a notification the process posted starts the app on the entry's address; on Windows that needs the installer's Start-menu shortcut and its `ToastActivatorCLSID` activator. Acceptance runs on signed, packaged builds on macOS, Windows and Linux.
- **Withdrawal on Windows.** The main process withdraws a notification it posted with `close()` while it still holds that `Notification` from the same run. Every other withdrawal — of one the windowless program posted, or one the main process posted before the app restarted — goes through the toast history, `ToastNotificationHistory.Remove(tag, group, appId)` under the app's own AppUserModelID, because Electron's `remove`, `removeGroup` and `getHistory` are macOS-only. The daemon's Windows half makes that call, or starts the app's own windowless program again with a withdraw verb where Windows lets only the posting program remove it. This holds on native Windows and on a Windows computer whose daemon runs in WSL 2 alike: there the daemon asks its Windows half to start the windowless program, and no notification is posted from inside the distribution, since WSLg carries no Linux notifications to Windows ([microsoft/WSL#2466](https://github.com/microsoft/WSL/issues/2466)).
- **A click.** A notification click is handed from the main process to the renderer, which lands on the session's place: the view that shows the session comes forward where one does; otherwise the focused view of the window used last switches to it; with no window open, a window opens on it. A workflow-run notification opens that run.
- **Another desktop.** A desktop app on another of the person's devices, holding a live connection with no window in front, posts the notification itself from the projection it reads, applying its own switches and kinds, under the same rules.
- **Moments that land together are posted once.** The daemon, which already computes the count, merges the moments that resolve within half a second of the first by the subject they belong to, so one session is named once and two different sessions still each get their own notification, and a later moment of the same subject replaces its notification rather than stacking a second one. The in-app list keeps every line.

### Cross-Device Delivery

- **Push.** For a device with no live connection, the machine decides and seals. For each linked device it applies, in order, that device's `Notify me outside the app`, its kind switch, the session's mute, then the quiet rule below, then the path. It seals the notice on the machine to the device's push key — HPKE with X-Wing, and [RFC 8291](https://www.rfc-editor.org/rfc/rfc8291) for Web Push — and hands it to the control plane with `push.send`; the relay adds only the person's own APNs, FCM or VAPID credentials and holds nothing that opens a notice, and the phone apps are signed under the person's own Apple and Google developer accounts. A push says the session's or run's name, the state word or the Notify step's own text and, when the person has two or more machines, the machine's name, as `Nightly bump · Waiting on you · mac-mini`; tapping it opens that session on the machine that sent it. Every push carries the moment's stable id as its collapse id (APNs' `apns-collapse-id`, FCM's collapse key and notification tag, Web Push's `Topic` header and the notification's `tag`), so `Finished` replaces `Waiting on you` in place; withdrawal of a resolved moment with nothing to replace it is best effort by platform. `Waiting on you` and a Notify step go at high priority, `Finished` and `Failed` at normal priority, and every push expires after 24 hours. There is no control-plane queue, filter or notification-preference table.
- **Web address.** With `Send to a web address` on, the daemon sends one `POST` to the saved address for each moment whose kind is switched on under `Send` (the web address's own switches, apart from the notification's), never for a muted session's `Finished` or `Failed`, and nothing for a withdrawal. The body is one JSON object — `text` (`<name> · <state>`, or for a Notify step its run's name and the notice title the person wrote), `kind` (`waitingOnYou | finished | failed | notifyStep | test`), `state` (the on-screen word), `subject` (`{type: session | run, id, name}`), `momentId`, `at` (RFC 3339), `machine` (this machine's device name) and `link` (`sidekicks://…`) — and never a sentence from a transcript. It is signed the [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks) way: `content-type: application/json` and the `webhook-*` headers, the body signed with HMAC-SHA256 from `node:crypto`, and `webhook-id` the moment's delivery id, unchanged across retries. Any 2xx answer within 15 seconds is success; a redirect is not followed and counts as a failure. The address is saved as the person types it, and nothing typed is refused. Because chat services put their token in the address, the address is a secret: sealed in the keychain, shown back only as its host, never read back. Text with no scheme and host is saved as typed and reads masked with no host shown, and each message to it fails and is counted as undelivered on the status line like any failed delivery. `Send a test message` on that text sends nothing and settles in place as `Not a web address, so nothing was sent.`, beside the test's three other outcomes: the address answered with success, answered with another status, or did not answer in 15 seconds. A message already delivered cannot be taken back.
- **Email digest.** With `Email me what I have not seen` on, the daemon sends at most one email in each `After` period (an hour, 4 hours or a day), and only when at least one moment qualifies: a moment at least one period old, in no earlier email, that is a `Waiting on you` still unresolved, or a `Finished`, `Failed` or Notify-step moment whose session or run has not been opened since, and never a muted session's `Finished` or `Failed`. The subject counts the lines by state (`1 waiting on you · 2 finished · 1 failed`, naming only the states it holds); the body lists them in that order, each line the session's or run's name, its time in the machine's own clock and its `sidekicks://` address, and nothing from the transcript. It goes through the person's own outgoing mail account, so the product runs no mail service and has no sending domain, over TLS only: TLS from the start on port 465, and on 587 a required STARTTLS, so a server that will not encrypt is refused before the password is sent. The password is sealed in the keychain by the daemon. A failure is written on the page's status line and never retried within the same period.
- **When the web address and push send.** Both send only while no app window is in front on any of the person's devices, the notification's own rule, so a moment the person is already looking at on the bell does not also buzz their phone; a workflow's Notify step sends either way.
- **The presence fact.** Whether an app window is in front is each device's `appVisible` on its presence heartbeat, the same fact the machine reads to decide whether to post a notification. A window behind a locked or sleeping screen is not in front; on Linux, where Electron reports no lock, a locked screen with the app in front still reads as in front. Each device sends its heartbeat on each machine connection when `appVisible` changes and otherwise every 15 seconds, the machine keeps the last one per device in memory only, and a device whose connection has closed counts as not in front.

## Example Flows

- Example: A run reaches `waiting_for_approval` while no app window is in front. The main process posts a `Waiting on you` notification and the bell counts it. The person presses `Allow` on their phone; the approval resolves, the count drops, and the Mac's notification is withdrawn.
- Example: The app is quit and a nightly workflow's Notify step runs. The daemon, finding no main process connected, starts the app's own program with no window, which posts the notification and exits.
- Example: A session the person muted finishes. No `Finished` notification, web-address message or push goes out, and the next digest leaves it out; the bell's `Earlier` group still lists it. When the same session later asks for an approval, `Waiting on you` is posted as usual.
- Example: Two runs in one session require action at the same time. Each run exposes its own actionable attention state, and the session aggregate stays actionable until both are resolved.

## Implementation Notes

- Attention projection should be small and queryable without requiring full timeline replay in the foreground client.
- Users need suppression controls, but suppression must not erase actual blocking session state.
- Notification channels should be policy-aware and platform-aware.
- The digest sends with Nodemailer, loaded on the first send, rather than hand-written SMTP: it is MIT-0 licensed with no runtime dependencies, handles TLS and STARTTLS (with `requireTLS` and without `opportunisticTLS`, a refused upgrade fails instead of sending the password in the clear), and ships a maintained map from an address's domain to its mail server. A mail API SDK and signing in to send with Google or Microsoft are not used, because each needs an account or a registered application that the person or the project would have to hold. The web address is signed with `node:crypto`; the `standardwebhooks` library is used only in tests, to verify what the daemon signs.

## Pitfalls To Avoid

- Basing notifications only on transient client events
- Treating all notifications as equally urgent
- Letting muted informational noise hide blocking approval state

## Acceptance Criteria

- [ ] Approval-required runs generate actionable attention even when the user is not focused on the session.
- [ ] Notification loss does not remove in-app attention state.
- [ ] Informational and actionable attention are distinguishable in product behavior.
- [ ] With the app quit, each kind is posted by the windowless program, on signed, packaged builds on macOS, Windows and Linux, and a click on it opens the entry's address.
- [ ] A muted session's `Waiting on you` is posted and counted, while its `Finished` is withheld on every channel and device.
- [ ] A kind switched off withholds only that kind's notification on this machine; the bell's list and the count are unchanged.
- [ ] The mail password, the web address beyond its host, and the signing secret after its one showing never appear in any reply, event, log line or error.
- [ ] A mail server that offers no encryption is refused before the password is written to the connection.
- [ ] A moment already in one digest is never in a second, across a daemon restart.
- [ ] A web-address message the daemon signs verifies with the Standard Webhooks reference library, and a tampered body fails; no message carries a sentence from a transcript.

## References

- [Live Timeline Visibility And Reasoning Surfaces](../specs/011-live-timeline-visibility-and-reasoning-surfaces.md)
- [Desktop Architecture](../architecture/desktop.md)
- [Spec-027: Remote Control](027-remote-control.md)
- [ADR-036: Workflow secrets in the OS keychain](../decisions/036-workflow-secrets-in-the-os-keychain.md)
- [Standard Webhooks specification](https://github.com/standard-webhooks/standard-webhooks)
- [Nodemailer SMTP transport](https://nodemailer.com/smtp/)
- [RFC 8291: Message Encryption for Web Push](https://www.rfc-editor.org/rfc/rfc8291)
