//! A lasting child's move out of the daemon's cgroup on Linux: a transient scope of its own under
//! systemd's user manager, so stopping the daemon's own unit does not end it.

use std::io;

use zbus::zvariant::Value;

// systemd's name, object and manager interface on the session bus, and the call that makes a unit.
const SYSTEMD_SERVICE: &str = "org.freedesktop.systemd1";
const SYSTEMD_OBJECT: &str = "/org/freedesktop/systemd1";
const SYSTEMD_MANAGER_INTERFACE: &str = "org.freedesktop.systemd1.Manager";
const START_TRANSIENT_UNIT_METHOD: &str = "StartTransientUnit";

// The job mode that fails the start rather than replace a job already queued for the unit.
const FAIL_JOB_MODE: &str = "fail";

/// Moves process `process_id` into a transient user scope of its own,
/// `app-sidekicks-lasting-<pid>.scope`, which systemd collects once the process ends. Fails with
/// the session bus's or systemd's error, as where no systemd user manager runs; the caller logs
/// it and goes on, the child then left in the daemon's cgroup.
pub async fn leave_daemon_scope(process_id: u32) -> io::Result<()> {
    let connection = zbus::Connection::session()
        .await
        .map_err(io::Error::other)?;
    let unit_name = format!("app-sidekicks-lasting-{process_id}.scope");
    let properties: Vec<(&str, Value<'_>)> = vec![
        ("PIDs", Value::from(vec![process_id])),
        (
            "Description",
            Value::from("A lasting child of the background service"),
        ),
        ("CollectMode", Value::from("inactive-or-failed")),
    ];
    let auxiliary_units: Vec<(&str, Vec<(&str, Value<'_>)>)> = Vec::new();
    connection
        .call_method(
            Some(SYSTEMD_SERVICE),
            SYSTEMD_OBJECT,
            Some(SYSTEMD_MANAGER_INTERFACE),
            START_TRANSIENT_UNIT_METHOD,
            &(
                unit_name.as_str(),
                FAIL_JOB_MODE,
                properties,
                auxiliary_units,
            ),
        )
        .await
        .map_err(io::Error::other)?;
    Ok(())
}
