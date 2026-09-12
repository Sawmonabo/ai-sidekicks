# Spec-029: Connect an iOS app and drive control

| Field         | Value               |
| ------------- | ------------------- |
| **Status**    | `draft`             |
| **NNN**       | `032`               |
| **Slug**      | `ios-remote-client` |
| **Date**      | `2026-09-11`        |
| **Author(s)** | `Sawmon Abo`        |

A stub. No plan yet.

## Goal

An iOS app that links as a device and drives a session with full parity — the same session, the same machine executing, reached from a phone.

## Prerequisite

[Plan-028](../plans/028-remote-control.md) complete through Phase 6. The phone is a device like any other, so it needs the relay, the method proxy, the registry, and attestation to already exist. Nothing in this spec re-specifies them.

## Parity

From the phone, the user can:

- read the live timeline and session history
- send a message
- steer a run in flight
- stop a run
- answer an approval
- attach, configure, and drive sidekicks
- view the diff
- open and use the terminal

## Open Questions

- **Key custody on the phone.** Where the device identity key lives, what protects it, and what happens to it when the app is reinstalled or the phone is restored from a backup.
- **Background execution limits.** iOS suspends apps aggressively; what a long-running session looks like when the app is not foregrounded, and what the session shows about a phone that is asleep.
- **Push notifications for approvals.** An approval that arrives while the app is backgrounded needs to reach the user, which means a push path — and a push payload that carries no session content.
- **App Store review constraints on remote execution.** An app that drives a shell on a remote machine has review exposure; what is allowed, and what must be presented differently.

## References

- [Spec-028: Remote Control](028-remote-control.md)
