#!/usr/bin/env bash
#
# Build smelt the way a stranger would.
#
# `git archive` emits *tracked files only*, so this catches the class of bug where the
# repo works on your machine because of something that was never committed — a generated
# file, a stray grammar, an ignored config, a symlink into a sibling checkout. It is the
# same check as "clone it fresh and see", minus the network round trip, and it runs the
# full gate afterwards rather than only the build.
#
# Usage: bash scripts/check-fresh-clone.sh [git-ref]   (default: HEAD)

set -euo pipefail

ref="${1:-HEAD}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/smelt-fresh-XXXXXX")"

cleanup() { rm -rf "$work_dir"; }
trap cleanup EXIT INT TERM

echo "==> exporting tracked files at ${ref} to ${work_dir}"
git -C "$repo_root" archive --format=tar "$ref" | tar -x -C "$work_dir"

if [[ ! -f "$work_dir/pnpm-lock.yaml" ]]; then
  echo "FAIL: pnpm-lock.yaml is not tracked. A fresh clone cannot install reproducibly." >&2
  exit 1
fi

echo "==> installing (frozen lockfile)"
cd "$work_dir"
pnpm install --frozen-lockfile

echo "==> running the full gate"
pnpm verify

echo
echo "==> fresh clone is green: install, build, lint, typecheck, test, mutate"
