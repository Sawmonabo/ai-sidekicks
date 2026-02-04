# Git Notes Reference

Git notes attach metadata to commits (or any Git object) without modifying the objects themselves. Notes are stored separately and displayed alongside commit messages.

**Core principle:** Add information to commits after creation without rewriting history.

## Core Concepts

| Concept | Description |
|---------|-------------|
| **Notes ref** | Storage location, default `refs/notes/commits` |
| **Non-invasive** | Notes never modify SHA of original object |
| **Namespaces** | Use `--ref` for different note categories |
| **Display** | Notes appear in `git log` and `git show` output |

## Command Reference

### Add Notes

```bash
# Add to HEAD
git notes add -m "Reviewed by Alice"

# Add to specific commit
git notes add -m "Tested on Linux" abc1234

# Add from file
git notes add -F review-comments.txt abc1234

# Interactive (opens editor)
git notes add abc1234

# Overwrite existing
git notes add -f -m "Updated status" abc1234

# Add empty note
git notes add --allow-empty abc1234
```

### View Notes

```bash
git notes show              # HEAD
git notes show abc1234      # Specific commit
git log --show-notes        # In log
git notes list              # All notes
git notes list abc1234      # For specific object
```

Example output:
```text
commit abc1234def567890
Author: Developer <dev@example.com>

    feat: implement user authentication

Notes:
    Reviewed by Alice
    Tested-by: CI Bot <ci@example.com>
```

### Append to Notes

```bash
git notes append -m "Additional comment" abc1234
git notes append -F more-comments.txt abc1234
git notes append -m "Comment 1" -m "Comment 2" abc1234
```

### Edit Notes

```bash
git notes edit abc1234      # Opens editor
git notes edit              # Edit HEAD note
```

### Remove Notes

```bash
git notes remove                    # From HEAD
git notes remove abc1234            # From specific commit
git notes remove abc1234 def5678    # Multiple
git notes remove --ignore-missing abc1234
echo "abc1234" | git notes remove --stdin
```

### Copy Notes

```bash
git notes copy abc1234 def5678      # Copy to another commit
git notes copy abc1234              # Copy to HEAD
git notes copy -f abc1234 def5678   # Force overwrite
echo "abc1234 def5678" | git notes copy --stdin
```

### Prune Notes

```bash
git notes prune         # Remove orphaned notes
git notes prune -n      # Dry-run
git notes prune -v      # Verbose
```

## Namespaces

Organize notes by purpose with separate refs.

### Specify Namespace

```bash
# Full ref path
git notes --ref=refs/notes/reviews add -m "Approved" abc1234

# Shorthand (refs/notes/ assumed)
git notes --ref=reviews add -m "Approved" abc1234

# View from namespace
git notes --ref=reviews show abc1234
git notes --ref=reviews list
```

### Environment Variable

```bash
export GIT_NOTES_REF=refs/notes/reviews
git notes add -m "Approved"
```

### Display Multiple Namespaces

```bash
git log --notes=reviews                     # Specific
git log --notes=reviews --notes=testing     # Multiple
git log --notes='*'                         # All
git log --no-notes                          # Disable
```

## Merging Notes

```bash
# Merge from another ref
git notes merge refs/notes/other

# With strategy
git notes merge -s union refs/notes/other
git notes merge -s ours refs/notes/other
git notes merge -s theirs refs/notes/other
git notes merge -s cat_sort_uniq refs/notes/other
```

### Merge Strategies

| Strategy | Behavior |
|----------|----------|
| `manual` | Interactive conflict resolution (default) |
| `ours` | Keep local note on conflict |
| `theirs` | Keep remote note on conflict |
| `union` | Concatenate both notes |
| `cat_sort_uniq` | Concatenate, sort lines, remove duplicates |

### Resolve Conflicts

```bash
# After conflict with manual strategy
# Edit files in .git/NOTES_MERGE_WORKTREE/

git notes merge --commit    # Commit resolution
git notes merge --abort     # Abort merge
```

## Configuration

```bash
# Default display ref
git config notes.displayRef refs/notes/reviews
git config --add notes.displayRef refs/notes/testing

# Merge strategy
git config notes.mergeStrategy union
git config notes.reviews.mergeStrategy theirs

# Preserve during rebase/amend
git config notes.rewrite.rebase true
git config notes.rewrite.amend true
git config notes.rewriteMode concatenate
```

### Sample .gitconfig

```gitconfig
[notes]
    displayRef = refs/notes/reviews
    displayRef = refs/notes/testing
    mergeStrategy = union

[notes "reviews"]
    mergeStrategy = theirs

[notes.rewrite]
    rebase = true
    amend = true
```

## Workflow Patterns

### Code Review Tracking

```bash
# Mark reviewed
git notes --ref=reviews add -m "Reviewed-by: Alice <alice@example.com>" abc1234

# Add comments
git notes --ref=reviews append -m "Consider extracting helper function" abc1234

# View status
git log --notes=reviews --oneline

# Approve
git notes --ref=reviews add -f -m "APPROVED by Alice" abc1234
```

### Test Results Annotation

```bash
# Record pass
git notes --ref=testing add -m "Tests passed: 2024-01-15
Platform: Linux x64
Coverage: 85%" abc1234

# Record failure
git notes --ref=testing add -m "FAILED: Integration tests
See: https://ci.example.com/build/123" def5678

# View across commits
git log --notes=testing --oneline
```

### Audit Trail

```bash
git notes --ref=audit add -m "Security review: PASSED
Reviewer: Security Team
Date: 2024-01-15
Ticket: SEC-456" abc1234

git log --notes=audit --grep="Security review"
```

### Sharing Notes

```bash
# Push
git push origin refs/notes/reviews
git push origin 'refs/notes/*'

# Fetch
git fetch origin refs/notes/reviews:refs/notes/reviews
git fetch origin 'refs/notes/*:refs/notes/*'
```

### Bulk Operations

```bash
# Add notes to commits by author in date range
git log --format="%H" --author="Alice" --since="2024-01-01" | \
  while read sha; do
    git notes add -m "Author verified" "$sha"
  done

# Remove notes from range
git log --format="%H" HEAD~10..HEAD | xargs git notes remove --ignore-missing
```

## Troubleshooting

### Notes not showing in log

Specify ref: `git log --notes=reviews`

Or configure: `git config notes.displayRef refs/notes/reviews`

### Notes lost after rebase

Enable preservation: `git config notes.rewrite.rebase true`

### Notes not on remote

Push explicitly: `git push origin refs/notes/commits`

### "Note already exists" error

Use `-f` to overwrite or `append` to add.

## Best Practices

| Practice | Rationale |
|----------|-----------|
| Use namespaces | Separate by purpose (reviews, testing, audit) |
| Be explicit about refs | Always specify `--ref` for non-default |
| Push notes explicitly | Document sharing in team guidelines |
| Use append over add -f | Preserve note history |
| Configure rewrite preservation | Run before rebasing |
