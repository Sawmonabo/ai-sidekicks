//! The one way names are compared wherever a name must be held once: a workflow in the library, a
//! pasted-token account under its provider.

use icu_casemap::CaseMapper;

/// A name folded the one way names are compared: Unicode's full case folding, the same on every
/// machine whatever its language, so `Straße`, `STRASSE` and `STRAẞE` are one name and the Turkish
/// dotless `ı` stays apart from `i`. A store writes this fold beside the name it keeps once.
pub fn fold_name(name: &str) -> String {
    CaseMapper::new().fold_string(name).into_owned()
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use serde::Deserialize;

    use super::fold_name;

    /// Every code point whose fold is not itself, from the fold the desktop runs, and the code
    /// points only its newer Unicode data folds.
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct NameFoldTable {
        simple_folds: Vec<u32>,
        full_folds: Vec<Vec<u32>>,
        later_code_points: Vec<u32>,
    }

    fn text_of(code_points: &[u32]) -> String {
        code_points
            .iter()
            .map(|&code_point| char::from_u32(code_point).expect("a table entry is a scalar value"))
            .collect()
    }

    #[test]
    fn a_name_folds_as_the_desktop_folds_it() {
        let table: NameFoldTable =
            serde_json::from_str(include_str!("../tests/fixtures/name-fold.json"))
                .expect("the case table reads");
        let mut folds: HashMap<u32, String> = table
            .simple_folds
            .chunks_exact(2)
            .map(|pair| (pair[0], text_of(&pair[1..])))
            .collect();
        folds.extend(
            table
                .full_folds
                .iter()
                .map(|entry| (entry[0], text_of(&entry[1..]))),
        );
        let misfolded: Vec<String> = (0..=u32::from(char::MAX))
            .filter(|code_point| !table.later_code_points.contains(code_point))
            .filter_map(char::from_u32)
            .filter(|&character| {
                let text = character.to_string();
                fold_name(&text) != *folds.get(&u32::from(character)).unwrap_or(&text)
            })
            .map(|character| format!("{:x}", u32::from(character)))
            .collect();
        assert_eq!(misfolded, Vec::<String>::new());
    }
}
