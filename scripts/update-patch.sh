#!/bin/bash
# Update a patch file from current changes
# Usage: ./scripts/update-patch.sh <patch-name> [files...]
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
PATCHES_DIR="$ROOT_DIR/patches"

if [ -z "$1" ]; then
	echo "Usage: $0 <patch-name> [files...]"
	echo "  patch-name: name of patch (e.g., workbench-defaults)"
	echo "  files: specific files to include (optional, defaults to all staged/unstaged changes)"
	exit 1
fi

PATCH_NAME="$1"
shift

cd "$ROOT_DIR"

# Add .diff extension if not present
if [[ "$PATCH_NAME" != *.diff ]]; then
	PATCH_NAME="${PATCH_NAME}.diff"
fi

PATCH_FILE="$PATCHES_DIR/$PATCH_NAME"

# Get the description from the existing patch if it exists
DESCRIPTION=""
if [ -f "$PATCH_FILE" ]; then
	# Extract lines before the first "Index:" line
	DESCRIPTION=$(sed '/^Index:/,$d' "$PATCH_FILE")
fi

if [ -z "$DESCRIPTION" ]; then
	DESCRIPTION="Patch: ${PATCH_NAME%.diff}

"
fi

# Generate the diff
if [ $# -gt 0 ]; then
	# Specific files provided
	DIFF=$(git diff "$@")
else
	# All changes
	DIFF=$(git diff)
fi

if [ -z "$DIFF" ]; then
	echo "No changes to create patch from"
	exit 1
fi

# Write the patch
echo "$DESCRIPTION" > "$PATCH_FILE"
echo "$DIFF" | sed 's|^--- a/|--- vscode.orig/|; s|^+++ b/|+++ vscode/|' >> "$PATCH_FILE"

echo "Updated: $PATCH_FILE"

# Add to series if not already there
PATCH_BASENAME=$(basename "$PATCH_NAME")
if ! grep -q "^$PATCH_BASENAME$" "$PATCHES_DIR/series" 2>/dev/null; then
	echo "$PATCH_BASENAME" >> "$PATCHES_DIR/series"
	echo "Added to patches/series"
fi
