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

/// A seal a test hands the items file: each blob carries its name and value in hexadecimal, so a blob
/// opened under another name refuses as systemd's does; it counts its seals and can hold the next
/// one until the test releases it.
#[cfg(test)]
pub(crate) struct TestSeal {
    /// The seals asked for, those still held included.
    seals: tokio::sync::watch::Sender<usize>,
    /// The release the next seal waits for, once the test holds it.
    held_seal: std::sync::Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
}

#[cfg(test)]
impl TestSeal {
    /// A seal that answers every call at once.
    pub(crate) fn new() -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self {
            seals: tokio::sync::watch::Sender::new(0),
            held_seal: std::sync::Mutex::new(None),
        })
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

    /// Waits until `count` seals have been asked for.
    pub(crate) async fn wait_for_seals(&self, count: usize) {
        let mut seals = self.seals.subscribe();
        // The sender lives in `self`, which outlives this wait, so the wait ends only on the count.
        drop(seals.wait_for(|seals| *seals >= count).await);
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
        Box::pin(async move {
            if let Some(held) = held {
                // A dropped sender releases the seal as a sent one does.
                drop(held.await);
            }
            Ok(base16ct::lower::encode_string(
                format!("{name}\0{}", value.expose_secret()).as_bytes(),
            ))
        })
    }

    fn unseal<'call>(
        &'call self,
        name: &'call str,
        blob: &'call str,
    ) -> BoxFuture<'call, Result<SecretString, SealFailure>> {
        let opened = base16ct::lower::decode_vec(blob)
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .and_then(|text| {
                let (sealed_name, value) = text.split_once('\0')?;
                (sealed_name == name).then(|| SecretString::from(value))
            })
            .ok_or_else(|| SealFailure::Refused {
                error: "io.systemd.Credentials.NameMismatch".to_owned(),
                errno: None,
            });
        Box::pin(async move { opened })
    }
}
