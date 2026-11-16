#!/bin/bash
# scripts/install-hooks.sh — point git at the repo's hooks (Phase 2 item 892).
# Run once per clone: ./scripts/install-hooks.sh
set -e
cd "$(dirname "$0")/.." || exit 1
chmod +x .githooks/pre-commit
git config core.hooksPath .githooks
echo "Git hooks installed (core.hooksPath = .githooks). Pre-commit secret scan is active."
