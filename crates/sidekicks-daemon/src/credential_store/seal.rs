//! The seal the daemon's items file puts each secret through: systemd's credential service, reached
//! through the platforms crate's client, behind a seam a test fills with a seal of its own.

use futures::future::BoxFuture;
use secrecy::SecretString;
use sidekicks_platforms::{CredentialSeal, SealFailure};

/// Seals a secret to this computer under a name and opens it again. Every call fails with
/// [`SealFailure`]; the caller sets its time.
pub(crate) trait SecretSeal: Send + Sync {
    /// Seals `value` under `name` and returns the sealed blob, which only [`Self::unseal`] under
    /// the same name opens.
    fn seal<'call>(
        &'call self,
        name: &'call str,
        value: &'call SecretString,
    ) -> BoxFuture<'call, Result<String, SealFailure>>;

    /// Opens `blob`, sealed under `name`.
    fn unseal<'call>(
        &'call self,
        name: &'call str,
        blob: &'call str,
    ) -> BoxFuture<'call, Result<SecretString, SealFailure>>;
}

impl SecretSeal for CredentialSeal {
    fn seal<'call>(
        &'call self,
        name: &'call str,
        value: &'call SecretString,
    ) -> BoxFuture<'call, Result<String, SealFailure>> {
        Box::pin(Self::seal(self, name, value))
    }

    fn unseal<'call>(
        &'call self,
        name: &'call str,
        blob: &'call str,
    ) -> BoxFuture<'call, Result<SecretString, SealFailure>> {
        Box::pin(Self::unseal(self, name, blob))
    }
}

/// A seal a test hands the daemon: each blob carries a real header naming the key it is set to seal
/// with, then the name and value, so a blob opened under another name refuses as systemd's does.
/// It counts its calls, can hold the next seal until the test releases it or delay the seals of
/// some names, and is switched by the test: absent or refusing, keeping another value than it is
/// given, or no longer opening the blobs it sealed so far, as a lost key does.
#[cfg(test)]
pub(crate) struct TestSeal {
    /// The seals asked for, those still held included.
    seals: tokio::sync::watch::Sender<usize>,
    /// The unseals asked for.
    unseals: std::sync::atomic::AtomicUsize,
    /// The release the next seal waits for, once the test holds it.
    held_seal: std::sync::Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
    /// How the seal answers now.
    settings: std::sync::Mutex<TestSealSettings>,
}

/// How a test's seal answers every call.
#[cfg(test)]
#[derive(Clone, Copy, Debug)]
pub(crate) enum TestSealAnswer {
    /// It seals and opens.
    Serves,
    /// Nothing listens at its socket.
    Absent,
    /// It answers every call with the varlink error `error` and the system error `errno`.
    Refuses {
        /// The error's name.
        error: &'static str,
        /// The system error number an `io.systemd.System` error carries.
        errno: Option<i64>,
    },
}

// What a test's seal does now.
#[cfg(test)]
struct TestSealSettings {
    answer: TestSealAnswer,
    key: sidekicks_platforms::SealKey,
    pcr_mask: u64,
    keeps_another_value: bool,
    // The generation each new blob carries; a blob of an earlier one no longer opens.
    generation: u32,
    // How long each seal of a name starting with the text waits before it answers.
    delay: Option<(&'static str, std::time::Duration)>,
}

#[cfg(test)]
impl TestSeal {
    /// A seal that serves every call at once with the security chip, bound to no boot state.
    pub(crate) fn new() -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self {
            seals: tokio::sync::watch::Sender::new(0),
            unseals: std::sync::atomic::AtomicUsize::new(0),
            held_seal: std::sync::Mutex::new(None),
            settings: std::sync::Mutex::new(TestSealSettings {
                answer: TestSealAnswer::Serves,
                key: sidekicks_platforms::SealKey::Chip,
                pcr_mask: 0,
                keeps_another_value: false,
                generation: 0,
                delay: None,
            }),
        })
    }

    /// Answers every later call as `answer` says.
    pub(crate) fn answer(&self, answer: TestSealAnswer) {
        self.settings().answer = answer;
    }

    /// Seals every later value with `key`, bound to the PCRs `pcr_mask` names.
    pub(crate) fn seal_with(&self, key: sidekicks_platforms::SealKey, pcr_mask: u64) {
        let mut settings = self.settings();
        settings.key = key;
        settings.pcr_mask = pcr_mask;
    }

    /// Whether every later seal keeps another value than the one it is given.
    pub(crate) fn keep_another_value(&self, keeps_another_value: bool) {
        self.settings().keeps_another_value = keeps_another_value;
    }

    /// Stops opening every blob sealed so far, as a key that is gone does; later blobs open.
    pub(crate) fn forget_the_blobs_sealed_so_far(&self) {
        self.settings().generation += 1;
    }

    /// Delays every later seal of a name starting with `prefix` by `delay`.
    pub(crate) fn delay_seals_under(&self, prefix: &'static str, delay: std::time::Duration) {
        self.settings().delay = Some((prefix, delay));
    }

    /// Holds the next seal until the returned sender sends or drops.
    pub(crate) fn hold_next_seal(&self) -> tokio::sync::oneshot::Sender<()> {
        let (release, held) = tokio::sync::oneshot::channel();
        *self
            .held_seal
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(held);
        release
    }

    /// The seals asked for so far.
    pub(crate) fn seals(&self) -> usize {
        *self.seals.borrow()
    }

    /// The unseals asked for so far.
    pub(crate) fn unseals(&self) -> usize {
        self.unseals.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Waits until `count` seals have been asked for.
    pub(crate) async fn wait_for_seals(&self, count: usize) {
        let mut seals = self.seals.subscribe();
        // The sender lives in `self`, which outlives this wait, so the wait ends only on the count.
        drop(seals.wait_for(|seals| *seals >= count).await);
    }

    fn settings(&self) -> std::sync::MutexGuard<'_, TestSealSettings> {
        self.settings
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

// The failure a test's seal answers with for `answer`, or `None` when it serves.
#[cfg(test)]
fn test_failure(answer: TestSealAnswer) -> Option<SealFailure> {
    match answer {
        TestSealAnswer::Serves => None,
        TestSealAnswer::Absent => Some(SealFailure::NoService(std::io::Error::from(
            std::io::ErrorKind::NotFound,
        ))),
        TestSealAnswer::Refuses { error, errno } => Some(SealFailure::Refused {
            error: error.to_owned(),
            errno,
        }),
    }
}

#[cfg(test)]
impl SecretSeal for TestSeal {
    fn seal<'call>(
        &'call self,
        name: &'call str,
        value: &'call SecretString,
    ) -> BoxFuture<'call, Result<String, SealFailure>> {
        use secrecy::ExposeSecret as _;

        self.seals.send_modify(|seals| *seals += 1);
        let held = self
            .held_seal
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        let (sealed, delay) = {
            let settings = self.settings();
            let delay = settings
                .delay
                .filter(|(prefix, _)| name.starts_with(prefix))
                .map(|(_, delay)| delay);
            let sealed = if let Some(failure) = test_failure(settings.answer) {
                Err(failure)
            } else {
                let kept = if settings.keeps_another_value {
                    format!("{}-changed", value.expose_secret())
                } else {
                    value.expose_secret().to_owned()
                };
                let payload = format!("{}\0{name}\0{kept}", settings.generation);
                Ok(sidekicks_platforms::SealHeader::test_blob(
                    settings.key,
                    settings.pcr_mask,
                    payload.as_bytes(),
                ))
            };
            (sealed, delay)
        };
        Box::pin(async move {
            if let Some(held) = held {
                // A dropped sender releases the seal as a sent one does.
                drop(held.await);
            }
            if let Some(delay) = delay {
                tokio::time::sleep(delay).await;
            }
            sealed
        })
    }

    fn unseal<'call>(
        &'call self,
        name: &'call str,
        blob: &'call str,
    ) -> BoxFuture<'call, Result<SecretString, SealFailure>> {
        self.unseals
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let settings = self.settings();
        let opened = if let Some(failure) = test_failure(settings.answer) {
            Err(failure)
        } else {
            let payload = sidekicks_platforms::SealHeader::test_blob_payload(blob)
                .and_then(|bytes| String::from_utf8(bytes).ok());
            let mut parts = payload.as_deref().map(|payload| payload.splitn(3, '\0'));
            let parts = parts.as_mut().and_then(|parts| {
                Some((
                    parts.next()?.parse::<u32>().ok()?,
                    parts.next()?,
                    parts.next()?,
                ))
            });
            match parts {
                Some((generation, sealed_name, value))
                    if generation == settings.generation && sealed_name == name =>
                {
                    Ok(SecretString::from(value))
                }
                Some((generation, ..)) if generation != settings.generation => {
                    Err(SealFailure::Refused {
                        error: "io.systemd.Credentials.BadFormat".to_owned(),
                        errno: None,
                    })
                }
                Some(_) | None => Err(SealFailure::Refused {
                    error: "io.systemd.Credentials.NameMismatch".to_owned(),
                    errno: None,
                }),
            }
        };
        drop(settings);
        Box::pin(async move { opened })
    }
}
