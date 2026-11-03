//! How the program, run by a provider's hook, reaches a daemon that is away: it dials again on the
//! program's one schedule of waits and gives up after the try that follows the last wait.

use std::error::Error;

use sidekicks_std::retry::waits::RETRY_WAITS;

/// The daemon stayed away through every try of the redial, seven over 63 s; the hook program then
/// exits 2 (`ExitCode::from(2)`), which the provider reads as a failed hook.
#[derive(Debug, thiserror::Error)]
#[error("the daemon could not be reached in seven tries over 63 seconds")]
pub(crate) struct ProviderHookRedialEnded {
    /// Why the last try failed.
    #[source]
    last_failure: Box<dyn Error + Send + Sync>,
}

/// Dials the daemon through `dial`, and after each failed try waits the schedule's next wait and
/// dials again; answers the first connection made. Fails with [`ProviderHookRedialEnded`] once the
/// try after the last wait fails too.
pub(crate) async fn connect_with_redial<Connection, DialError, Dial, DialAttempt>(
    mut dial: Dial,
) -> Result<Connection, ProviderHookRedialEnded>
where
    Dial: FnMut() -> DialAttempt,
    DialAttempt: Future<Output = Result<Connection, DialError>>,
    DialError: Error + Send + Sync + 'static,
{
    let mut waits = RETRY_WAITS.iter();
    loop {
        let failure = match dial().await {
            Ok(connection) => return Ok(connection),
            Err(failure) => failure,
        };
        let Some(wait) = waits.next() else {
            return Err(ProviderHookRedialEnded {
                last_failure: Box::new(failure),
            });
        };
        tracing::debug!(
            error = &failure as &(dyn Error + 'static),
            wait_seconds = wait.as_secs(),
            "The daemon could not be reached; dialing again after the wait"
        );
        tokio::time::sleep(*wait).await;
    }
}

#[cfg(test)]
mod tests {
    use std::io;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use tokio::time::Instant;

    use super::connect_with_redial;

    /// The offsets from the start, in seconds, at which each try of the redial dialed.
    const TRY_OFFSETS: [u64; 7] = [0, 1, 3, 7, 15, 31, 63];

    // Fails when the redial never gives up, skips or shortens a wait, or waits before its first
    // try: each would move a try off its offset, add an eighth, or drop one.
    #[tokio::test(start_paused = true)]
    async fn the_redial_tries_seven_times_over_63_seconds_and_connects_once_the_daemon_answers() {
        for answering_try in [None, Some(4)] {
            let start = Instant::now();
            let offsets = Arc::new(Mutex::new(Vec::new()));
            let tried = Arc::clone(&offsets);
            let redial = connect_with_redial(move || {
                let tried = Arc::clone(&tried);
                async move {
                    let mut tried = tried.lock().expect("no try panicked");
                    tried.push(start.elapsed());
                    assert!(tried.len() <= TRY_OFFSETS.len(), "the redial has no bound");
                    if Some(tried.len()) == answering_try {
                        Ok(tried.len())
                    } else {
                        Err(io::Error::from(io::ErrorKind::ConnectionRefused))
                    }
                }
            })
            .await;

            let tries = answering_try.unwrap_or(TRY_OFFSETS.len());
            let expected: Vec<Duration> = TRY_OFFSETS[..tries]
                .iter()
                .map(|&offset| Duration::from_secs(offset))
                .collect();
            assert_eq!(*offsets.lock().expect("no try panicked"), expected);
            match (redial, answering_try) {
                (Ok(connected_on), Some(answering_try)) => assert_eq!(connected_on, answering_try),
                (Err(ended), None) => assert!(ended.to_string().contains("63 seconds")),
                (redial, _) => panic!("{answering_try:?}: the redial ended {redial:?}"),
            }
        }
    }
}
