//! FTS5's BM25, to the bit.

/// BM25's term-frequency saturation.
pub const K1: f64 = 1.2;
/// BM25's length normalization.
pub const B: f64 = 0.75;

/// A phrase's inverse document frequency as FTS5 computes it, with its floor of 1e-6 at or below 0.
pub fn phrase_idf(live_rows: u64, phrase_rows: u64) -> f64 {
    let idf = ((live_rows as f64 - phrase_rows as f64 + 0.5) / (phrase_rows as f64 + 0.5)).ln();
    if idf <= 0.0 { 1e-6 } else { idf }
}

/// The most a phrase can add to any row's score, whatever its frequency and length.
pub fn phrase_ceiling(idf: f64) -> f64 {
    idf * (K1 + 1.0)
}

/// A row's score: each phrase's part in query order, added with a fused multiply-add as FTS5's own
/// build adds it. `frequencies[i]` is how many times phrase `i` occurs in the row, `length` the
/// row's token count plus one.
pub fn row_score(idfs: &[f64], frequencies: &[u32], length: u64, average_length: f64) -> f64 {
    let length = length as f64;
    let mut score = 0.0f64;
    for (idf, frequency) in idfs.iter().zip(frequencies) {
        let frequency = f64::from(*frequency);
        let length_part = 1.0 - B + B * length / average_length;
        score = idf.mul_add(
            (frequency * (K1 + 1.0)) / K1.mul_add(length_part, frequency),
            score,
        );
    }
    score
}

#[cfg(test)]
mod tests {
    use super::{phrase_idf, row_score};

    // FTS5's own ranks for rows of the seeded set at 1M (1,041,000 rows, 19,519,302 tokens), read
    // from its database with each row's phrase counts and length. The `lo kalo*` rows are ones
    // where adding the parts without the fused multiply-add gives a different score.
    const LIVE_ROWS: u64 = 1_041_000;
    const LIVE_TOKENS: u64 = 19_519_302;

    struct Expected {
        phrase_rows: &'static [u64],
        frequencies: &'static [u32],
        length: u64,
        score_bits: u64,
    }

    const LO_KALO: &[u64] = &[732_272, 159_292];
    const NEZI: &[u64] = &[17_892];

    const fn expected(
        phrase_rows: &'static [u64],
        frequencies: &'static [u32],
        length: u64,
        score_bits: u64,
    ) -> Expected {
        Expected {
            phrase_rows,
            frequencies,
            length,
            score_bits,
        }
    }

    const EXPECTED: &[Expected] = &[
        expected(LO_KALO, &[2, 1], 21, 0x3ffa18de0b3e3a15),
        expected(LO_KALO, &[1, 2], 19, 0x4002c08d01d97700),
        expected(LO_KALO, &[4, 1], 19, 0x3ffb3acf9d96a9d1),
        expected(LO_KALO, &[2, 1], 4, 0x40042f53e1cfdbb7),
        expected(LO_KALO, &[5, 2], 21, 0x4002353d9098c7de),
        expected(LO_KALO, &[5, 1], 21, 0x3ffa18de7a4bd0d0),
        expected(NEZI, &[1], 19, 0x401018e62d594447),
        expected(NEZI, &[1], 3, 0x4018a8916d475b5e),
    ];

    #[test]
    fn scores_equal_fts5_ranks_bit_for_bit() {
        let average_length = LIVE_TOKENS as f64 / LIVE_ROWS as f64;
        for expected in EXPECTED {
            let idfs: Vec<f64> = expected
                .phrase_rows
                .iter()
                .map(|rows| phrase_idf(LIVE_ROWS, *rows))
                .collect();
            let score = row_score(&idfs, expected.frequencies, expected.length, average_length);
            assert_eq!(
                score.to_bits(),
                expected.score_bits,
                "{:?} at length {}: {score:e} against FTS5's {:e}",
                expected.frequencies,
                expected.length,
                f64::from_bits(expected.score_bits),
            );
        }
    }
}
