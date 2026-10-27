//! A project's slug: the name of its worktrees folder, `<worktrees>/<slug>/`, fixed at attach so a
//! rename moves no worktree. Made from the folder's own name, safe on every file system: lowercase,
//! so two projects never differ by case alone on a disk that ignores case; never starting with a
//! dot, which names the kept-worktrees folder beside it; never a device name Windows reserves; and
//! unique among the projects and the folders already there.

use std::sync::LazyLock;

use regex::Regex;
use sidekicks_std::text_cut::cut_to_code_points;
use unicode_normalization::UnicodeNormalization as _;

/// The file system's 255-byte limit on one folder name (`NAME_MAX` on APFS and ext4). A slug holds
/// only ASCII, so each character is one byte and every cut counts bytes.
const SLUG_MAX_LENGTH: usize = 255;

/// The slug of a folder whose name keeps no safe character.
const FALLBACK_SLUG: &str = "project";

// What a slug keeps: letters, digits, `.`, `_` and `-`; any other run becomes one `-`.
static UNSAFE_SLUG_RUN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new("[^a-z0-9._-]+").expect("the unsafe slug run pattern is a valid regex")
});

// The device names Windows reserves in every folder, alone or before a first dot (`con`, `nul.d`).
static WINDOWS_RESERVED_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)")
        .expect("the reserved name pattern is a valid regex")
});

/// The slug a folder named `folder_name` starts from, before it is made unique: compatibility
/// decomposed, lowercased, each unsafe run made one `-`, cut to 255 bytes and its edges trimmed.
pub(crate) fn slug_base_of(folder_name: &str) -> String {
    let lowercase = folder_name.nfkd().collect::<String>().to_lowercase();
    let replaced = UNSAFE_SLUG_RUN.replace_all(&lowercase, "-");
    let base = trim_slug_edges(cut_to_code_points(&replaced, SLUG_MAX_LENGTH));
    if base.is_empty() {
        return FALLBACK_SLUG.to_owned();
    }
    // Windows opens the device for such a name, never a folder, so the fallback goes in front.
    if WINDOWS_RESERVED_NAME.is_match(base) {
        let prefixed = format!("{FALLBACK_SLUG}-{base}");
        return trim_slug_edges(cut_to_code_points(&prefixed, SLUG_MAX_LENGTH)).to_owned();
    }
    base.to_owned()
}

/// The `ordinal`th candidate for `base`, counting from 1: the base itself, then `base-2`,
/// `base-3`, …, the base cut so the suffix still fits the slug's length.
pub(crate) fn slug_candidate(base: &str, ordinal: u32) -> String {
    if ordinal == 1 {
        return base.to_owned();
    }
    let suffix = format!("-{ordinal}");
    format!(
        "{}{suffix}",
        cut_to_code_points(base, SLUG_MAX_LENGTH - suffix.len())
    )
}

// Leading dots and dashes, and trailing dots and dashes: Windows refuses a folder name ending in a
// dot, and a leading dash reads as an option. The slug holds no whitespace by now, since every
// unsafe run became a dash.
fn trim_slug_edges(slug: &str) -> &str {
    slug.trim_start_matches(['.', '-'])
        .trim_end_matches(['.', '-'])
}

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::{slug_base_of, slug_candidate};

    #[rstest]
    #[case::spaces_and_case("My Project", "my-project")]
    #[case::accent_decomposed("Café", "cafe")]
    #[case::compatibility_ligature("\u{FB01}le", "file")]
    #[case::kelvin_sign("\u{212A}iln", "kiln")]
    #[case::leading_dots_and_dashes("..-hidden", "hidden")]
    #[case::trailing_dot("name.", "name")]
    #[case::no_safe_character("日本", "project")]
    #[case::empty("", "project")]
    #[case::reserved_device("CON", "project-con")]
    #[case::reserved_device_before_a_dot("nul.d", "project-nul.d")]
    #[case::reserved_numbered_device("com1", "project-com1")]
    #[case::reserved_word_inside_a_name("console", "console")]
    #[case::cut_to_255_bytes(&"a".repeat(300), &"a".repeat(255))]
    #[case::reserved_device_cut_after_the_prefix(
        &format!("con.{}", "b".repeat(300)),
        &format!("project-con.{}", "b".repeat(243))
    )]
    fn a_folder_name_becomes_a_safe_slug(#[case] folder_name: &str, #[case] expected: &str) {
        assert_eq!(slug_base_of(folder_name), expected);
    }

    #[rstest]
    #[case::first_is_the_base("app", 1, "app")]
    #[case::later_ones_take_a_suffix("app", 2, "app-2")]
    #[case::suffix_fits_the_length(&"a".repeat(255), 12, &format!("{}-12", "a".repeat(252)))]
    fn a_slug_candidate_keeps_its_suffix_within_the_length(
        #[case] base: &str,
        #[case] ordinal: u32,
        #[case] expected: &str,
    ) {
        assert_eq!(slug_candidate(base, ordinal), expected);
    }
}
