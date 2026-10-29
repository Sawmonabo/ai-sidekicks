//! How a value larger than one entry of a store with an entry capacity is laid out as numbered
//! pieces under the same service. The head entry, under the item's own account, holds a header (a
//! format tag, the generation, the piece count and the SHA-256 of the whole value) and the first
//! piece; piece `n` sits under `<account>#<generation>-<n>`, the generation in hexadecimal.
//!
//! The store writes the pieces under a fresh generation first and the head last: until the head
//! lands the old head still names the old pieces, which stay whole, so a write cut short leaves the
//! old value readable. A head whose pieces do not join to its digest is a torn write and is refused
//! whole.

use secrecy::zeroize::Zeroizing;
use sha2::{Digest as _, Sha256};

// Leads every head. A value written as one entry never starts with it, since a value that does is
// written as a head even when it fits, so a head is never mistaken for a value.
const FORMAT_TAG: &[u8] = b"\0sidekicks-pieces-1\0";

// The bytes of a generation, written as twice as many hexadecimal digits in a piece's account.
const GENERATION_LENGTH: usize = 8;

// The bytes of the piece count, big-endian.
const COUNT_LENGTH: usize = 8;

// The bytes of the whole value's SHA-256.
const DIGEST_LENGTH: usize = 32;

// The bytes of a head before its first piece.
const HEADER_LENGTH: usize = FORMAT_TAG.len() + GENERATION_LENGTH + COUNT_LENGTH + DIGEST_LENGTH;

/// Names one write's pieces, so a later write's pieces never overwrite them and the pieces of
/// every other write can be told apart and removed.
pub(super) type Generation = [u8; GENERATION_LENGTH];

/// A fresh generation for a write's pieces. Fails when the system offers no randomness.
pub(super) fn fresh_generation() -> Result<Generation, getrandom::Error> {
    let mut generation = Generation::default();
    getrandom::fill(&mut generation)?;
    Ok(generation)
}

/// Whether `value` is written as a head and pieces on a store whose entries hold at most
/// `capacity` bytes: when it is larger than one entry, or when it starts as a head does.
pub(super) fn is_pieced(value: &[u8], capacity: Option<usize>) -> bool {
    value.starts_with(FORMAT_TAG) || capacity.is_some_and(|capacity| value.len() > capacity)
}

/// `value` laid out under `generation` for a store whose entries hold at most `capacity` bytes,
/// none when it has no cap: the head, then the pieces in order, each at most `capacity` bytes.
pub(super) fn lay_out(
    value: &[u8],
    capacity: Option<usize>,
    generation: Generation,
) -> (Zeroizing<Vec<u8>>, Vec<&[u8]>) {
    let head_room = capacity.map_or(value.len(), |capacity| {
        capacity.saturating_sub(HEADER_LENGTH).min(value.len())
    });
    let (first, rest) = value.split_at(head_room);
    let pieces: Vec<&[u8]> =
        capacity.map_or_else(Vec::new, |capacity| rest.chunks(capacity).collect());
    let mut head = Zeroizing::new(Vec::with_capacity(HEADER_LENGTH + first.len()));
    head.extend_from_slice(FORMAT_TAG);
    head.extend_from_slice(&generation);
    head.extend_from_slice(&(pieces.len() as u64).to_be_bytes());
    head.extend_from_slice(&Sha256::digest(value));
    head.extend_from_slice(first);
    (head, pieces)
}

/// The account piece `number` of `generation` is filed under, for the item under `account`.
pub(super) fn piece_account(account: &str, generation: &Generation, number: u64) -> String {
    format!(
        "{account}#{}-{number}",
        base16ct::lower::encode_string(generation)
    )
}

/// The item's account and the generation, when `account` names a piece; `None` for an item's own
/// account. Exact, since an item's account may itself hold `#` and `-`.
pub(super) fn piece_of(account: &str) -> Option<(&str, Generation)> {
    let (item_account, suffix) = account.rsplit_once('#')?;
    let (generation_text, number) = suffix.split_once('-')?;
    let is_number = !number.is_empty()
        && !number.starts_with('0')
        && number.bytes().all(|byte| byte.is_ascii_digit());
    if !is_number || generation_text.len() != 2 * GENERATION_LENGTH {
        return None;
    }
    let mut generation = Generation::default();
    base16ct::lower::decode(generation_text, &mut generation).ok()?;
    Some((item_account, generation))
}

/// Whether a stored entry is a head rather than a whole value.
pub(super) fn is_head(stored: &[u8]) -> bool {
    stored.starts_with(FORMAT_TAG)
}

/// A head's header and first piece, read from what its entry holds.
pub(super) struct Head<'stored> {
    /// The generation of the head's pieces.
    generation: Generation,
    /// How many pieces follow the head.
    count: u64,
    /// The SHA-256 of the whole value.
    digest: [u8; DIGEST_LENGTH],
    /// The first piece, which the head holds itself.
    first: &'stored [u8],
}

impl<'stored> Head<'stored> {
    /// The head `stored` holds, or `None` when it is too short to hold a header.
    pub(super) fn read(stored: &'stored [u8]) -> Option<Self> {
        let rest = stored.strip_prefix(FORMAT_TAG)?;
        let (generation, rest) = rest.split_first_chunk::<GENERATION_LENGTH>()?;
        let (count, rest) = rest.split_first_chunk::<COUNT_LENGTH>()?;
        let (digest, first) = rest.split_first_chunk::<DIGEST_LENGTH>()?;
        Some(Self {
            generation: *generation,
            count: u64::from_be_bytes(*count),
            digest: *digest,
            first,
        })
    }

    /// The accounts of the head's pieces, in order, for the item under `account`.
    pub(super) fn piece_accounts<'call>(
        &'call self,
        account: &'call str,
    ) -> impl Iterator<Item = String> + 'call {
        (1..=self.count).map(move |number| piece_account(account, &self.generation, number))
    }

    /// The whole value: the first piece joined to `pieces`, or `None` when they do not match the
    /// head's digest.
    pub(super) fn join(&self, pieces: &[Zeroizing<Vec<u8>>]) -> Option<Zeroizing<Vec<u8>>> {
        let length = self.first.len() + pieces.iter().map(|piece| piece.len()).sum::<usize>();
        // Sized once, so no copy of the value is left behind by a growing buffer.
        let mut value = Zeroizing::new(Vec::with_capacity(length));
        value.extend_from_slice(self.first);
        for piece in pieces {
            value.extend_from_slice(piece);
        }
        (Sha256::digest(value.as_slice()).as_slice() == self.digest).then_some(value)
    }
}

#[cfg(test)]
mod tests {
    use std::error::Error;

    use secrecy::{ExposeSecret, SecretString};

    use super::piece_of;
    use crate::credential_store::CredentialStore;
    use crate::credential_store::blocking::BlockingCredentialStore;

    const SERVICE: &str = "ai-sidekicks-pieces-test";
    const ACCOUNT: &str = "https://mcp.example.com/#a-1";
    // The Credential Manager's cap on one entry.
    const CAPACITY: usize = 2560;

    fn value_of(length: usize, pattern: &str) -> SecretString {
        SecretString::from(pattern.repeat(length / pattern.len()))
    }

    fn capped(store: CredentialStore) -> CredentialStore {
        CredentialStore {
            entry_capacity: Some(CAPACITY),
            ..store
        }
    }

    // The accounts of the entries under the service that hold a value; the in-memory store lists
    // every entry ever built, emptied ones included.
    fn held_accounts(store: &CredentialStore) -> Vec<String> {
        store
            .entries(SERVICE)
            .expect("the store lists its entries")
            .iter()
            .filter(|item| {
                store
                    .entry(SERVICE, item.account())
                    .expect("the entry builds")
                    .get_secret()
                    .is_ok()
            })
            .map(|item| item.account().to_owned())
            .collect()
    }

    fn read_text(store: &CredentialStore) -> Option<String> {
        store
            .read(SERVICE, ACCOUNT)
            .expect("the item reads")
            .map(|value| value.expose_secret().to_owned())
    }

    /// A value past one entry round-trips equal over three entries; the item's listing names its
    /// account alone while the erase's listing names the pieces too. Mutations: write the value as
    /// one entry; list the pieces as accounts.
    #[test]
    fn a_value_past_one_entry_round_trips_as_pieces_listed_only_for_the_erase() {
        let store = capped(CredentialStore::in_memory());
        let value = value_of(6 * 1024, "0123456789abcdef");
        store
            .write(SERVICE, ACCOUNT, &value)
            .expect("the item is written");

        assert_eq!(read_text(&store).as_deref(), Some(value.expose_secret()));
        assert_eq!(held_accounts(&store).len(), 3);
        let accounts: Vec<String> = store
            .accounts(SERVICE)
            .expect("the store lists its items")
            .iter()
            .map(|item| item.account().to_owned())
            .collect();
        assert_eq!(accounts, [ACCOUNT]);
        let pieces = store
            .entries(SERVICE)
            .expect("the store lists its entries")
            .iter()
            .filter(|item| {
                piece_of(item.account()).is_some_and(|(item_account, _)| item_account == ACCOUNT)
            })
            .count();
        assert_eq!(pieces, 2);
    }

    /// A rewrite refused at its head leaves the old value readable, and a later shorter rewrite
    /// answers the new value with every earlier generation's pieces gone. Mutations: write the
    /// head before the pieces (the refused write tears the old value); keep the previous
    /// generation's pieces.
    #[test]
    fn a_rewrite_lands_its_head_last_and_removes_the_earlier_pieces() {
        let blocking_store = BlockingCredentialStore::new();
        blocking_store.release();
        let store = capped(CredentialStore::from_store(blocking_store.clone()));
        let first = value_of(6 * 1024, "0123456789abcdef");
        store
            .write(SERVICE, ACCOUNT, &first)
            .expect("the item is written");

        // Two pieces land; the third write, the head, is refused.
        blocking_store.refuse_write(SERVICE, 2);
        store
            .write(SERVICE, ACCOUNT, &value_of(6 * 1024, "fedcba9876543210"))
            .expect_err("the refused head refuses the write");
        assert_eq!(read_text(&store).as_deref(), Some(first.expose_secret()));

        let shorter = value_of(3 * 1024, "abcdefghijklmnop");
        store
            .write(SERVICE, ACCOUNT, &shorter)
            .expect("the item is rewritten");
        assert_eq!(read_text(&store).as_deref(), Some(shorter.expose_secret()));
        assert_eq!(
            store
                .entries(SERVICE)
                .expect("the store lists its entries")
                .len(),
            2
        );
    }

    /// A head whose pieces do not match its digest is refused, never answered in part, and the
    /// refusal carries none of the value. Mutation: join the pieces without checking the digest.
    #[test]
    fn a_torn_item_is_refused_whole() {
        let store = capped(CredentialStore::in_memory());
        let value = value_of(6 * 1024, "0123456789abcdef");
        store
            .write(SERVICE, ACCOUNT, &value)
            .expect("the item is written");
        let piece = store
            .entries(SERVICE)
            .expect("the store lists its entries")
            .into_iter()
            .find(|item| piece_of(item.account()).is_some())
            .expect("the item has a piece");
        let piece_entry = store
            .entry(SERVICE, piece.account())
            .expect("the entry builds");
        let length = piece_entry.get_secret().expect("the piece reads").len();
        piece_entry
            .set_secret(&vec![b'x'; length])
            .expect("the piece is overwritten");

        let refusal = store
            .read(SERVICE, ACCOUNT)
            .expect_err("a torn item is refused");
        assert!(!refusal.is_locked());
        let mut written = vec![refusal.to_string(), format!("{refusal:?}")];
        let mut source = refusal.source();
        while let Some(failure) = source {
            written.push(failure.to_string());
            source = failure.source();
        }
        for text in written {
            assert!(!text.contains("0123456789abcdef"), "{text}");
        }
    }

    /// Removing an item removes its head and every piece. Mutation: remove the head alone.
    #[test]
    fn a_removed_item_leaves_no_head_and_no_piece() {
        let store = capped(CredentialStore::in_memory());
        store
            .write(SERVICE, ACCOUNT, &value_of(6 * 1024, "0123456789abcdef"))
            .expect("the item is written");

        assert!(store.remove(SERVICE, ACCOUNT).expect("the item is removed"));
        assert_eq!(held_accounts(&store), Vec::<String>::new());
        assert_eq!(read_text(&store), None);
    }
}
