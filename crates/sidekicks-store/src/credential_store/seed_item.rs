//! A 32-byte key kept as a credential-store item: drawn from the system's random source, written
//! as 64 lowercase hex characters and read back only when the item holds exactly that.

use secrecy::{ExposeSecret as _, SecretString};
use subtle::ConstantTimeEq as _;
use zeroize::Zeroizing;

/// The bytes of a seed.
pub const SEED_LENGTH: usize = 32;

/// A fresh seed from the system's random source, wiped when it drops. Fails when the system gives
/// no random bytes.
pub fn random_seed() -> Result<Zeroizing<[u8; SEED_LENGTH]>, getrandom::Error> {
    let mut seed = Zeroizing::new([0; SEED_LENGTH]);
    getrandom::fill(seed.as_mut_slice())?;
    Ok(seed)
}

/// The item that keeps `seed`: its bytes in lowercase hex, encoded from the wiped buffer so no
/// unwiped copy of the seed is left.
pub fn encode_seed(seed: &Zeroizing<[u8; SEED_LENGTH]>) -> SecretString {
    SecretString::from(base16ct::lower::encode_string(seed.as_slice()))
}

/// The seed `item` holds, or `None` when it is not exactly 64 lowercase hex characters or is all
/// zero, the one seed no mint makes.
pub fn item_seed(item: &SecretString) -> Option<Zeroizing<[u8; SEED_LENGTH]>> {
    let text = item.expose_secret();
    if text.len() != SEED_LENGTH * 2 {
        return None;
    }
    let mut seed = Zeroizing::new([0; SEED_LENGTH]);
    base16ct::lower::decode(text, seed.as_mut_slice()).ok()?;
    if bool::from(seed.as_slice().ct_eq(&[0; SEED_LENGTH])) {
        return None;
    }
    Some(seed)
}
