//! The one minter of the time-ordered ids every stored row and event carries.

use uuid::Uuid;

/// A new version 7 UUID from the process-wide context, so ids minted in one process strictly
/// increase, within one millisecond too; its text form is lowercase.
#[expect(
    clippy::disallowed_methods,
    reason = "this is the one place stored row and event ids are minted"
)]
pub(crate) fn mint_uuid_v7() -> Uuid {
    Uuid::now_v7()
}

#[cfg(test)]
mod tests {
    use super::mint_uuid_v7;

    #[test]
    fn a_burst_of_ids_strictly_increases() {
        let ids: Vec<_> = (0..10_000).map(|_| mint_uuid_v7()).collect();
        assert!(ids.windows(2).all(|pair| pair[0] < pair[1]));
    }
}
