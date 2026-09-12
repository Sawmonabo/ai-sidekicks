#!/bin/bash
# PostToolUse hook for caching WebSearch and WebFetch results.
#
# Triggered on PostToolUse for WebSearch|WebFetch tools.
# Caches all websearches for audit trail and reproducibility.
#
# Output: JSON files in .claude/tmp/websearch/

set -euo pipefail

# Determine project directory
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
RESEARCH_DIR="$PROJECT_DIR/.claude/tmp/websearch/"

# Ensure research directory exists
mkdir -p "$RESEARCH_DIR"

# Read tool input/output from stdin
INPUT=$(cat)

# Check if we have valid input
if [[ -z "$INPUT" ]]; then
    exit 0
fi

# Check if jq is available
if ! command -v jq &> /dev/null; then
    echo "Warning: jq not installed, skipping research cache" >&2
    exit 0
fi

# Generate filename with timestamp and query hash
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"')

# Get query or URL depending on tool
QUERY=$(echo "$INPUT" | jq -r '.tool_input.query // .tool_input.url // "unknown"')

# Generate a short hash for the filename
QUERY_HASH=$(echo "$QUERY" | md5sum 2>/dev/null | cut -c1-8 || echo "nohash")

FILENAME="${TIMESTAMP}_${TOOL_NAME}_${QUERY_HASH}.json"

# Save formatted research entry with full response
echo "$INPUT" | jq '{
  timestamp: (now | strftime("%Y-%m-%dT%H:%M:%SZ")),
  tool: .tool_name,
  query: (.tool_input.query // .tool_input.url),
  input: .tool_input,
  tool_output: .tool_output,
  response_size_bytes: (.tool_output | tostring | length)
}' > "$RESEARCH_DIR/$FILENAME" 2>/dev/null || true

# Log file size for monitoring
FILE_SIZE=$(stat -c%s "$RESEARCH_DIR/$FILENAME" 2>/dev/null || echo "0")
if [[ "$FILE_SIZE" -gt 100000 ]]; then
  echo "Note: Large research cache file created: $FILENAME ($FILE_SIZE bytes)" >&2
fi

exit 0
