//! The price list the build vendored, carried in the program gzipped and handed over inflated, so
//! a start with no held copy on disk still prices runs.

use std::io::Read as _;

use flate2::read::GzDecoder;

/// The vendored price list, checked against its recorded hash and gzipped by the build.
const PRICE_LIST_SEED_GZIP: &[u8] = include_bytes!(env!("PRICE_LIST_SEED"));

/// The vendored price list's bytes, inflated; only a start with no held copy calls it.
pub(crate) fn price_list_seed() -> Vec<u8> {
    // A gzip stream ends with its inflated size, little-endian, so the bytes land in one buffer.
    let inflated_size = PRICE_LIST_SEED_GZIP
        .last_chunk()
        .map(|size| u32::from_le_bytes(*size))
        .expect("a gzip stream ends with its inflated size");
    let mut seed = Vec::with_capacity(inflated_size as usize);
    GzDecoder::new(PRICE_LIST_SEED_GZIP)
        .read_to_end(&mut seed)
        .expect("the build wrote a whole gzip stream");
    seed
}

#[cfg(test)]
mod tests {
    use sidekicks_provider::pricing::list::{
        PriceRowSelection, PriceTableRefusal, RefusedPriceField, decode_price_table,
    };

    use super::price_list_seed;

    /// The release's check of a copy: every row read, the copy refused whole on a structural fault,
    /// and each rate refused alone handed back to be named.
    fn release_check(copy: &str) -> Result<Vec<RefusedPriceField>, PriceTableRefusal> {
        decode_price_table(copy, PriceRowSelection::Every).map(|decoded| decoded.refused_fields)
    }

    /// The release check over the vendored list: the seed is the vendored bytes and every row
    /// decodes, each rate refused alone named in the log. Kills a seed that is not the vendored
    /// bytes, and a check that reads only the rows in use.
    #[test]
    fn vendored_price_list() {
        let seed = price_list_seed();
        assert!(
            seed == include_bytes!("../vendor/litellm/model_prices_and_context_window.json"),
            "the seed inflates to the vendored price list"
        );
        let copy = std::str::from_utf8(&seed).expect("the price list is UTF-8");
        let refused_fields = release_check(copy).unwrap_or_else(|refusal| {
            panic!("the release check refused the price list: {refusal}")
        });
        for RefusedPriceField { model_id, field } in refused_fields {
            eprintln!("refused rate: {model_id} {field}");
        }
    }

    /// A row that is not an object fails the release even when no model uses it, and a bad rate
    /// passes it, named. Kills reading only the rows in use, and failing the release on a rate the
    /// runtime drops alone.
    #[test]
    fn release_check_fails_a_row_not_an_object_and_names_a_bad_rate() {
        let Err(PriceTableRefusal::RowNotObject { model_id }) =
            release_check(r#"{"a": {"input_cost_per_token": 1e-06}, "b": 5}"#)
        else {
            panic!("a row that is not an object fails the release");
        };
        assert_eq!(model_id, "b");

        let refused_fields = release_check(r#"{"a": {"input_cost_per_token": "abc"}}"#)
            .expect("a bad rate passes the release");
        assert_eq!(
            refused_fields,
            [RefusedPriceField {
                model_id: "a".to_owned(),
                field: "input_cost_per_token".to_owned(),
            }]
        );
    }
}
