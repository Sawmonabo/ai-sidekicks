//! The errors every session tool shares, each written with its values filled. When the person
//! refuses an approval, the tool returns the provider's own refusal unchanged, so it has no text
//! here. A name no session has reads as
//! `sidekicks_provider::driver::session_messages::no_session_named`, which a driver's send
//! hook also answers with.

/// One of the sessions a shared name names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SharedNameHolder<'session> {
    /// The session's name.
    pub name: &'session str,
    /// The session's id.
    pub id: &'session str,
    /// The session's project.
    pub project: &'session str,
}

/// A name two or more sessions share: each holder with its id and project, so the model calls
/// again with the id.
pub fn shared_name(name: &str, holders: &[SharedNameHolder<'_>]) -> String {
    let listed: Vec<String> = holders
        .iter()
        .map(|holder| format!("{} · {} in {}", holder.name, holder.id, holder.project))
        .collect();
    format!(
        "\"{name}\" names {} sessions: {}. Call again with the id.",
        holders.len(),
        listed.join(", ")
    )
}

/// A file the calling session named that it cannot read; nothing was sent.
pub fn file_unreadable(path: &str) -> String {
    format!("Not sent: {path} does not exist or cannot be read.")
}

/// A session on another of the person's computers that is offline; the message waits for it.
pub fn computer_offline(session: &str, computer: &str) -> String {
    format!(
        "{session} is on {computer}, which is offline. The message is queued and goes when \
         {computer} reconnects."
    )
}
