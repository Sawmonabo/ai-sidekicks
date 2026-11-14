use std::collections::HashMap;

use super::innermost_first;

// Fails when a nested wrapper's own nested party is stopped with it or after it, so the outer
// level's group kill ends the inner party's wrapper before it ended its own command. Mutation:
// answer every party as one level.
#[test]
fn the_parties_under_a_wrapper_are_ordered_innermost_first() {
    let (wrapper, outer, inner, beside, askpass) = (1, 2, 3, 4, 5);
    let parents = HashMap::from([
        (outer, Some(wrapper)),
        (inner, Some(outer)),
        (beside, Some(wrapper)),
        (askpass, Some(inner)),
    ]);

    assert_eq!(
        innermost_first(wrapper, &parents),
        [vec![askpass], vec![inner], vec![outer, beside]]
    );
}
