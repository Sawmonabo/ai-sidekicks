//! The name Claude Code gives the folder under `<config folder>/projects` that holds the
//! transcripts of the sessions started in one working folder.

use std::path::Path;

// The longest name kept whole, counted in UTF-16 code units as Claude Code counts it.
const KEY_MAX_UNITS: usize = 200;

/// The project folder's name for `working_folder`, as Claude Code writes it: each UTF-16 code unit
/// of the path outside `[A-Za-z0-9]` made `-`, and a name past 200 units cut there and suffixed
/// with `-` and the whole path's 32-bit string hash, its magnitude in base 36.
pub(super) fn claude_project_key(working_folder: &Path) -> String {
    let path = working_folder.to_string_lossy();
    let key: String = path
        .encode_utf16()
        .map(|unit| {
            char::from_u32(u32::from(unit))
                .filter(char::is_ascii_alphanumeric)
                .unwrap_or('-')
        })
        .collect();
    if key.len() <= KEY_MAX_UNITS {
        return key;
    }
    // Each step is `hash * 31 + unit` on a wrapping 32-bit integer.
    let hash = path.encode_utf16().fold(0_i32, |hash, unit| {
        hash.wrapping_shl(5)
            .wrapping_sub(hash)
            .wrapping_add(i32::from(unit))
    });
    format!("{}-{}", &key[..KEY_MAX_UNITS], base_36(hash.unsigned_abs()))
}

// `value` in lowercase base-36 digits.
fn base_36(mut value: u32) -> String {
    let mut digits = Vec::new();
    loop {
        digits.push(char::from_digit(value % 36, 36).expect("a remainder of 36 is one digit"));
        value /= 36;
        if value == 0 {
            break;
        }
    }
    digits.iter().rev().collect()
}
