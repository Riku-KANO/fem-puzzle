#!/usr/bin/env bash
# Merge a finished task branch into main only if the merged result is green.
#
#   scripts/integrate.sh <branch> [profile]     (profile defaults to "fast")
#
# 1. merges <branch> into a throwaway integration branch cut from main
# 2. runs scripts/verify.sh <profile> on the merged tree
# 3. fast-forwards main on success; on failure leaves main untouched and prints why
set -euo pipefail

BRANCH="${1:?usage: integrate.sh <branch> [profile]}"
PROFILE="${2:-fast}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "✗ main checkout has uncommitted changes; commit or stash first" >&2
  exit 1
fi

CURRENT="$(git rev-parse --abbrev-ref HEAD)"
if [ "$CURRENT" != "main" ]; then
  echo "✗ run from the main checkout (currently on $CURRENT)" >&2
  exit 1
fi

INTEG="integrate/${BRANCH//\//-}"
git branch -D "$INTEG" >/dev/null 2>&1 || true
git checkout -q -b "$INTEG" main

if ! git merge --no-ff --no-edit "$BRANCH"; then
  echo "✗ merge conflict integrating $BRANCH — resolve on $INTEG or rebase the task branch" >&2
  git merge --abort || true
  git checkout -q main
  git branch -D "$INTEG" >/dev/null
  exit 1
fi

# Lockfile or manifests may have changed on the branch.
if ! git diff --quiet main -- pnpm-lock.yaml '**/package.json'; then
  pnpm install --frozen-lockfile >/dev/null
fi

if bash scripts/verify.sh "$PROFILE"; then
  git checkout -q main
  git merge -q --ff-only "$INTEG"
  git branch -D "$INTEG" >/dev/null
  echo "✓ integrated $BRANCH into main"
else
  git checkout -q main
  echo "✗ $BRANCH is not green after merge; main unchanged (inspect branch $INTEG)" >&2
  exit 1
fi
