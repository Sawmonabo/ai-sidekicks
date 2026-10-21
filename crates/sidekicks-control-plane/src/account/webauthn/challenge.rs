//! The ceremony fence: every challenge is chosen here, stored with a five-minute expiry and the
//! transaction id its caller quotes back, and consumed once by a `DELETE … RETURNING`, so two
//! verifies of one challenge never both pass. Every expiry reads the router's one clock.

use jiff::Timestamp;
use serde::Deserialize;
use sha2::{Digest as _, Sha256};
use sidekicks_contracts::trust_statement::{ChallengeNonce, TrustStatementHash};
use sidekicks_contracts::webauthn::ceremony::{WebAuthnChallenge, WebAuthnTransactionId};
use sidekicks_contracts::wire::id::mint_uuid_v7;

use crate::account_store::{AccountStore, AccountStoreError, SqlValue};

/// How long a challenge is good, in seconds.
const CHALLENGE_LIFETIME_SECONDS: i64 = 300;

/// The ceremony a challenge was issued for, as `webauthn_challenges.ceremony` keeps it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Ceremony {
    /// Adding a passkey.
    Registration,
    /// Signing in with one.
    Authentication,
}

impl Ceremony {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Registration => "registration",
            Self::Authentication => "authentication",
        }
    }
}

/// A challenge issued: what its options carry.
#[derive(Clone, Debug)]
pub(crate) struct IssuedChallenge {
    /// The challenge.
    pub(crate) challenge: WebAuthnChallenge,
    /// The transaction the verify quotes.
    pub(crate) transaction_id: WebAuthnTransactionId,
    /// With a statement hash, the nonce the challenge was made from.
    pub(crate) nonce: Option<ChallengeNonce>,
}

/// Why a challenge could not be issued.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ChallengeError {
    /// The store refused a statement.
    #[error("the challenge store failed")]
    Store(#[from] AccountStoreError),
    /// The system's random source failed.
    #[error("the random source failed")]
    Random(#[source] getrandom::Error),
}

/// Issues a challenge for `ceremony`, for `user_id` when a signed-in user asks, inside the
/// caller's step: rows already expired at `now` are deleted first, then one row is written that
/// expires five minutes on. With `statement_hash` the challenge is SHA-256(nonce ‖ hash) over a
/// fresh 32-byte nonce and the hash's 32 bytes; without, 32 random bytes.
pub(crate) fn issue_challenge<S: AccountStore>(
    store: &S,
    ceremony: Ceremony,
    user_id: Option<&str>,
    statement_hash: Option<&TrustStatementHash>,
    now: Timestamp,
) -> Result<IssuedChallenge, ChallengeError> {
    let random = read_random_bytes()?;
    let (challenge, nonce) = match statement_hash {
        None => (random.to_vec(), None),
        Some(hash) => {
            let mut digest = Sha256::new();
            digest.update(random);
            // The hash's type holds 64 lowercase hex digits.
            digest.update(
                base16ct::lower::decode_vec(hash.as_str()).expect("a statement hash is hex"),
            );
            let nonce = ChallengeNonce::encode(&random).expect("32 bytes are 43 characters");
            (digest.finalize().to_vec(), Some(nonce))
        }
    };
    let challenge = WebAuthnChallenge::encode(&challenge).expect("32 bytes are 43 characters");
    let transaction_id =
        WebAuthnTransactionId::try_from(mint_uuid_v7()).expect("a version 7 UUID is a UUID id");

    store.execute(
        "DELETE FROM webauthn_challenges WHERE expires_at <= ?1",
        &[SqlValue::Integer(now.as_second())],
    )?;
    store.execute(
        "INSERT INTO webauthn_challenges (challenge, transaction_id, user_id, ceremony, \
         expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        &[
            SqlValue::Text(challenge.as_str().to_owned()),
            SqlValue::Text(transaction_id.text().as_str().to_owned()),
            user_id.map_or(SqlValue::Null, |user_id| SqlValue::Text(user_id.to_owned())),
            SqlValue::Text(ceremony.as_str().to_owned()),
            SqlValue::Integer(now.as_second() + CHALLENGE_LIFETIME_SECONDS),
            SqlValue::Integer(now.as_second()),
        ],
    )?;
    Ok(IssuedChallenge {
        challenge,
        transaction_id,
        nonce,
    })
}

/// Reads, without consuming, the live challenge of `transaction_id` for `ceremony` and
/// `user_id` (`None` for a sign-in) at `now`: the challenge a response is verified against
/// before the step that consumes it.
pub(crate) fn read_challenge<S: AccountStore>(
    store: &S,
    transaction_id: &WebAuthnTransactionId,
    ceremony: Ceremony,
    user_id: Option<&str>,
    now: Timestamp,
) -> Result<Option<String>, AccountStoreError> {
    Ok(store
        .query::<StoredChallenge>(
            "SELECT challenge FROM webauthn_challenges WHERE transaction_id = ?1 \
             AND ceremony = ?2 AND user_id IS ?3 AND expires_at > ?4",
            &challenge_key(transaction_id, ceremony, user_id, now),
        )?
        .pop()
        .map(|row| row.challenge))
}

/// Consumes `challenge` inside the caller's step when it is still the live challenge of
/// `transaction_id` for `ceremony` and `user_id` at `now`; `false` when no row matched: unknown,
/// expired, already consumed, or another transaction's, ceremony's or user's.
pub(crate) fn consume_challenge<S: AccountStore>(
    store: &S,
    challenge: &str,
    transaction_id: &WebAuthnTransactionId,
    ceremony: Ceremony,
    user_id: Option<&str>,
    now: Timestamp,
) -> Result<bool, AccountStoreError> {
    let mut parameters = challenge_key(transaction_id, ceremony, user_id, now).to_vec();
    parameters.push(SqlValue::Text(challenge.to_owned()));
    let consumed: Vec<StoredChallenge> = store.query(
        "DELETE FROM webauthn_challenges WHERE transaction_id = ?1 AND ceremony = ?2 \
         AND user_id IS ?3 AND expires_at > ?4 AND challenge = ?5 RETURNING challenge",
        &parameters,
    )?;
    Ok(!consumed.is_empty())
}

#[derive(Deserialize)]
struct StoredChallenge {
    challenge: String,
}

fn challenge_key(
    transaction_id: &WebAuthnTransactionId,
    ceremony: Ceremony,
    user_id: Option<&str>,
    now: Timestamp,
) -> [SqlValue; 4] {
    [
        SqlValue::Text(transaction_id.text().as_str().to_owned()),
        SqlValue::Text(ceremony.as_str().to_owned()),
        user_id.map_or(SqlValue::Null, |user_id| SqlValue::Text(user_id.to_owned())),
        SqlValue::Integer(now.as_second()),
    ]
}

fn read_random_bytes() -> Result<[u8; 32], ChallengeError> {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes).map_err(ChallengeError::Random)?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use jiff::Timestamp;

    use super::{Ceremony, consume_challenge, issue_challenge, read_challenge};
    use crate::account_store::{AccountStore, open_account_file};

    fn at(second: i64) -> Timestamp {
        Timestamp::from_second(second).unwrap()
    }

    #[test]
    fn a_challenge_is_consumed_once_inside_its_life_by_its_own_transaction_and_ceremony() {
        let folder = tempfile::tempdir().unwrap();
        let store = open_account_file(&folder.path().join("account.sqlite")).unwrap();
        let issue = |ceremony| {
            store
                .write_step(|step| issue_challenge(step, ceremony, None, None, at(1_000)))
                .unwrap()
        };
        let consume = |issued: &super::IssuedChallenge, ceremony, now| {
            store
                .write_step(|step| {
                    consume_challenge(
                        step,
                        issued.challenge.as_str(),
                        &issued.transaction_id,
                        ceremony,
                        None,
                        at(now),
                    )
                })
                .unwrap()
        };

        let first = issue(Ceremony::Authentication);
        let other = issue(Ceremony::Authentication);
        let mistaken = super::IssuedChallenge {
            transaction_id: other.transaction_id,
            ..first.clone()
        };
        assert!(
            !consume(&mistaken, Ceremony::Authentication, 1_000),
            "another transaction"
        );
        assert!(
            !consume(&first, Ceremony::Registration, 1_000),
            "an authentication challenge on the registration leg"
        );
        assert!(
            !consume(&first, Ceremony::Authentication, 1_300),
            "at its expiry"
        );
        assert_eq!(
            store
                .write_step(|step| read_challenge(
                    step,
                    &first.transaction_id,
                    Ceremony::Authentication,
                    None,
                    at(1_299)
                ))
                .unwrap()
                .as_deref(),
            Some(first.challenge.as_str())
        );
        assert!(
            consume(&first, Ceremony::Authentication, 1_299),
            "a second before"
        );
        assert!(
            !consume(&first, Ceremony::Authentication, 1_299),
            "a second consume"
        );

        let registration = issue(Ceremony::Registration);
        assert!(
            !consume(&registration, Ceremony::Authentication, 1_000),
            "a registration challenge on the authentication leg"
        );
    }
}
