#!/bin/bash
# Apply all patches from the patches/ directory
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
PATCHES_DIR="$ROOT_DIR/patches"

cd "$ROOT_DIR"

if [ ! -f "$PATCHES_DIR/series" ]; then
	echo "No patches/series file found"
	exit 0
fi

echo "Applying patches..."

while IFS= read -r patch || [ -n "$patch" ]; do
	# Skip empty lines and comments
	[[ -z "$patch" || "$patch" =~ ^# ]] && continue

	patch_file="$PATCHES_DIR/$patch"
	if [ -f "$patch_file" ]; then
		echo "  Applying: $patch"
		patch -p1 --forward --batch < "$patch_file" || {
			echo "    (already applied or failed)"
		}
	else
		echo "  Warning: patch file not found: $patch"
	fi
done < "$PATCHES_DIR/series"

echo "Done!"
