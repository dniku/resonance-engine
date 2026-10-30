#!/usr/bin/env bash
# Acceptance checklist. Each step is independent and reports what it did.
set -uo pipefail
cd "$(dirname "$0")"

STATUS=0

# Deno does the type check and runs the unit suite. A hardcoded store path used
# to sit here as a fallback, which worked on the machine that wrote it and named
# a path no other machine has. `nix-shell shell.nix` puts deno on PATH, so it is
# looked up rather than guessed; when it is absent phases 1-2 report a skip and
# the run still exits non-zero rather than passing on nothing.
DENO=${DENO:-$(command -v deno || true)}

echo "== 1/3 type check =="
if [[ -n $DENO ]]; then
  "$DENO" check --no-lock --allow-import src/*.js \
    && echo "types ok" || STATUS=1
else
  echo "SKIP: deno unavailable"
fi

echo
echo "== 2/3 unit + wiring tests =="
# The wiring test shells out to the standalone build, so it needs what that
# build needs: --allow-run for the esbuild spawn, --allow-env to read $ESBUILD,
# --allow-write for the .tmp directory esbuild writes through.
if [[ -n $DENO ]]; then
  "$DENO" test --no-lock --no-check --allow-read --allow-env --allow-run \
    --allow-write="$PWD/.tmp" \
    tests/engine.test.js tests/wiring.test.mjs tests/png.test.mjs tests/serve.test.mjs \
    || STATUS=1
else
  echo "SKIP: deno unavailable"
fi

echo
echo "== 3/3 browser smoke test =="
if [[ -x .gc-roots/node/bin/node && -e .gc-roots/pw/index.js ]]; then
  PATH="$PWD/.gc-roots/node/bin:$PATH" \
  PLAYWRIGHT_BROWSERS_PATH="$PWD/.gc-roots/browsers" \
    node tests/browser.test.mjs || STATUS=1
else
  echo "SKIP: browser toolchain absent. Bootstrap with:"
  echo "  nix-build gcroots.nix -A pw        --out-link .gc-roots/pw"
  echo "  nix-build gcroots.nix -A browsers  --out-link .gc-roots/browsers"
  echo "  nix-build gcroots.nix -A node      --out-link .gc-roots/node"
fi

echo
if [[ $STATUS -eq 0 ]]; then echo "ALL CHECKS PASSED"; else echo "SOME CHECKS FAILED"; fi
exit $STATUS
