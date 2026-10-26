//! The channel as a party holds it, the command wrapper or the askpass: joined once by a restart
//! that hands the party its own key pair, its records sealed to the daemon and the daemon's
//! requests read back, each from a thread of its own with no runtime.

use std::collections::VecDeque;
use std::ffi::OsString;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};
use std::time::Instant;

use hpke::{Deserializable, Kem as _, Serializable};
use sidekicks_platforms::{
    FolderArrivalWait, exec_with_secret, name_program, take_inherited_secret,
};
use zeroize::Zeroizing;

use super::{
    COMMAND_CHANNEL_KEY_VARIABLE, COMMAND_CHANNEL_VARIABLE, ChannelKem, ChannelPrivateKey,
    ChannelPublicKey, DaemonRequest, Direction, PARTY_KEY_ARGUMENT_PREFIX, PARTY_SECRET_VARIABLE,
    PartyId, PartyRecord, REQUESTS_FOLDER, open, parse_public_key, parse_record_name, party_key_of,
    public_key_hex, record_context, record_name, seal, write_record,
};

/// A channel as a party holds it: what it writes to the daemon and what it reads back, each usable
/// from a thread of its own.
pub(crate) struct ChannelParty {
    /// The party's records to the daemon.
    pub(crate) records: PartyRecords,
    /// The daemon's requests to the party.
    pub(crate) requests: PartyRequests,
}

/// What a party writes to the daemon: its channel's folder, its own key pair, the daemon's key and
/// the sequence number its last record took.
pub(crate) struct PartyRecords {
    folder: PathBuf,
    party: PartyId,
    keys: (ChannelPrivateKey, ChannelPublicKey),
    daemon_key: ChannelPublicKey,
    last_sequence: u64,
}

/// The daemon's requests to one party, waited on by the party's thread: its private key, the
/// daemon's key, the last sequence number opened, the watch on the `requests` folder and the
/// arrivals of its last listing not read yet.
pub(crate) struct PartyRequests {
    party: PartyId,
    private_key: ChannelPrivateKey,
    daemon_key: ChannelPublicKey,
    last_sequence: u64,
    watch: FolderArrivalWait,
    pending: VecDeque<PathBuf>,
}

/// How a party program goes on: run without a channel, or joined to one.
pub(crate) enum PartyStart {
    /// No channel is named, so the program runs without one.
    Unchanneled,
    /// The program joined its channel; its own arguments follow its key's, the second of its
    /// process's arguments.
    Joined(Box<ChannelParty>),
}

impl ChannelParty {
    /// Joins the channel the environment names, restarting this program once with a key pair of
    /// its own first: the public half as its first argument, the private half on a pipe, its name
    /// and its other `process_arguments` kept. Answers [`PartyStart::Unchanneled`] when no channel
    /// is named; returns only once joined after the restart. Fails when the restart, the key's
    /// read or the requests' watch fails.
    pub(crate) fn join(process_arguments: &[OsString]) -> io::Result<PartyStart> {
        let (Some(folder), Some(daemon_key)) = (
            std::env::var_os(COMMAND_CHANNEL_VARIABLE),
            std::env::var_os(COMMAND_CHANNEL_KEY_VARIABLE),
        ) else {
            return Ok(PartyStart::Unchanneled);
        };
        let daemon_key = daemon_key
            .to_str()
            .and_then(parse_public_key)
            .ok_or_else(|| io::Error::new(ErrorKind::InvalidInput, "no channel key named"))?;
        let Some(own_key) = party_key_argument(process_arguments) else {
            return Err(restart_with_key(process_arguments));
        };
        let public_key = parse_public_key(own_key)
            .ok_or_else(|| io::Error::new(ErrorKind::InvalidInput, "no party key named"))?;
        let descriptor = std::env::var_os(PARTY_SECRET_VARIABLE)
            .ok_or_else(|| io::Error::new(ErrorKind::InvalidInput, "no party secret named"))?;
        let secret = Zeroizing::new(take_inherited_secret(&descriptor)?);
        let private_key = ChannelPrivateKey::from_bytes(&secret).map_err(io::Error::other)?;
        let folder = PathBuf::from(folder);
        let party = std::process::id();
        let watch = FolderArrivalWait::watch(&folder.join(REQUESTS_FOLDER))?;
        Ok(PartyStart::Joined(Box::new(Self {
            records: PartyRecords {
                folder,
                party,
                keys: (private_key.clone(), public_key),
                daemon_key: daemon_key.clone(),
                last_sequence: 0,
            },
            requests: PartyRequests {
                party,
                private_key,
                daemon_key,
                last_sequence: 0,
                watch,
                pending: VecDeque::new(),
            },
        })))
    }
}

/// The arguments a party program was started with past its name, and past its key where it was
/// restarted with one.
pub(crate) fn own_arguments(process_arguments: &[OsString]) -> &[OsString] {
    let skipped = if party_key_argument(process_arguments).is_some() {
        2
    } else {
        1
    };
    process_arguments.get(skipped..).unwrap_or_default()
}

// The public key in hexadecimal a restarted party's first argument holds.
fn party_key_argument(process_arguments: &[OsString]) -> Option<&str> {
    party_key_of(process_arguments.get(1)?.to_str()?)
}

impl PartyRecords {
    /// Writes `record` to the daemon, sealed with this party's key. Blocks; fails with the
    /// write's error.
    pub(crate) fn send(&mut self, record: &PartyRecord) -> io::Result<()> {
        self.last_sequence += 1;
        let context = record_context(Direction::ToDaemon, self.party, self.last_sequence);
        let plaintext = Zeroizing::new(serde_json::to_vec(record).map_err(io::Error::other)?);
        let sealed = seal(&self.keys, &self.daemon_key, &context, &plaintext)?;
        write_record(
            &self.folder,
            &record_name(self.party, self.last_sequence),
            &sealed,
        )
    }
}

/// Why a party has no next request from the daemon.
#[derive(Debug, thiserror::Error)]
pub(crate) enum RequestError {
    /// One request could not be read and is lost; the next call goes on with the others.
    #[error("a request from the daemon could not be read: {0}")]
    Unreadable(#[source] io::Error),
    /// The watch on the requests failed, so no later request can come.
    #[error("the daemon's requests could not be watched: {0}")]
    Watch(#[source] io::Error),
}

impl PartyRequests {
    /// The daemon's next request to this party, waiting on this thread until one comes or
    /// `deadline` passes, `None` then; the requests of one listing are handed out in order before
    /// the next listing. Each request read is removed, and one gone before its read, that does not
    /// open or comes out of order is dropped. Fails with [`RequestError::Unreadable`] for a request
    /// whose read fails, and with [`RequestError::Watch`] once the watch fails.
    pub(crate) fn next_request(
        &mut self,
        deadline: Option<Instant>,
    ) -> Result<Option<DaemonRequest>, RequestError> {
        loop {
            while let Some(path) = self.pending.pop_front() {
                if let Some(request) = self.read_request(&path).map_err(RequestError::Unreadable)? {
                    return Ok(Some(request));
                }
            }
            let arrivals = self
                .watch
                .next_arrivals(deadline)
                .map_err(RequestError::Watch)?;
            if arrivals.is_empty() {
                return Ok(None);
            }
            self.pending.extend(arrivals);
        }
    }

    // The request at `path`, removed once read; `None` for a file that is not this party's
    // request, is gone, does not open or comes out of order. Fails with the read's error.
    fn read_request(&mut self, path: &Path) -> io::Result<Option<DaemonRequest>> {
        let Some((party, sequence)) = parse_record_name(path) else {
            return Ok(None);
        };
        if party != self.party {
            return Ok(None);
        }
        let sealed = match std::fs::read(path) {
            Ok(sealed) => sealed,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        // A request left behind is removed with the party's others once the daemon forgets it.
        std::fs::remove_file(path).unwrap_or_default();
        if sequence <= self.last_sequence {
            return Ok(None);
        }
        let context = record_context(Direction::ToParty, party, sequence);
        let Some(plaintext) = open(&self.private_key, &self.daemon_key, &context, &sealed) else {
            return Ok(None);
        };
        let Ok(request) = serde_json::from_slice(&plaintext) else {
            return Ok(None);
        };
        self.last_sequence = sequence;
        Ok(Some(request))
    }
}

/// Restarts this program with a new key pair, its public half before its other arguments and its
/// private half on a pipe; returns only on failure.
fn restart_with_key(process_arguments: &[OsString]) -> io::Error {
    let (private_key, public_key) = ChannelKem::gen_keypair();
    let program = match std::env::current_exe() {
        Ok(program) => program,
        Err(error) => return error,
    };
    let mut command = std::process::Command::new(program);
    if let Some(name) = process_arguments.first()
        && let Err(error) = name_program(&mut command, name)
    {
        return error;
    }
    command
        .arg(format!(
            "{PARTY_KEY_ARGUMENT_PREFIX}{}",
            public_key_hex(&public_key)
        ))
        .args(process_arguments.iter().skip(1));
    let secret = Zeroizing::new(private_key.to_bytes().to_vec());
    exec_with_secret(&mut command, PARTY_SECRET_VARIABLE, &secret)
}

#[cfg(test)]
mod tests;
