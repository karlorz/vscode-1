#!/bin/bash
# Unapply all patches (in reverse order)
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
PATCHES_DIR="$ROOT_DIR/patches"

cd "$ROOT_DIR"

if [ ! -f "$PATCHES_DIR/series" ]; then
	echo "No patches/series file found"
	exit 0
fi

echo "Unapplying patches..."

# Read patches into array, then reverse
patches=()
while IFS= read -r patch || [ -n "$patch" ]; do
	[[ -z "$patch" || "$patch" =~ ^# ]] && continue
	patches+=("$patch")
done < "$PATCHES_DIR/series"

# Reverse iterate
for ((i=${#patches[@]}-1; i>=0; i--)); do
	patch="${patches[$i]}"
	patch_file="$PATCHES_DIR/$patch"
	if [ -f "$patch_file" ]; then
		echo "  Unapplying: $patch"
		patch -p1 --reverse --batch < "$patch_file" || {
			echo "    (already unapplied or failed)"
		}
	fi
done

echo "Done!"
