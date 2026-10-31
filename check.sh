#!/usr/bin/env bash
# Acceptance checklist. Each step is independent and reports what it did.
set -uo pipefail
cd "$(dirname "$0")"

STATUS=0

# Deno does the type check and runs the unit suite. A hardcoded store path used
# to sit here as a fallback, which worked on the machine that wrote it and named
# a path no other machine has. `nix-shell shell.nix` puts deno on PATH, so it is
# looked up rather than guessed.
#
# A phase that cannot run FAILS the run rather than skipping it. An acceptance
# checklist that prints ALL CHECKS PASSED after executing nothing is worse than
# one that errors, and that is exactly what this script used to do: with deno
# off PATH and the browser out-links absent it printed ALL CHECKS PASSED and
# exited 0 having run zero tests.
DENO=${DENO:-$(command -v deno || true)}
if [[ -z $DENO ]]; then
  # The clear error, rather than the old hardcoded /nix/store/<hash> path that
  # resolved only on the machine that wrote it. A Nix-backed fallback was tried
  # and rejected: it needs network access, so it could not be verified here,
  # and silently reaching for the network to run one's own test suite is a poor
  # default. Naming the fix beats guessing at it.
  echo "deno is not on PATH. Run it inside the project shell: nix-shell shell.nix --run ./check.sh" >&2
fi

echo "== 1/3 type check =="
if [[ -z $DENO ]]; then
  echo "FAIL: deno unavailable, so nothing here has been type checked." >&2
  STATUS=1
else
  "$DENO" check --no-lock --allow-import src/*.js \
    && echo "types ok" || STATUS=1
fi

echo
echo "== 2/3 unit + wiring tests =="
# The wiring test shells out to the standalone build, so it needs what that
# build needs: --allow-run for the esbuild spawn, --allow-env to read $ESBUILD,
# --allow-write for the .tmp directory esbuild writes through.
if [[ -z $DENO ]]; then
  echo "FAIL: deno unavailable, so no unit test ran." >&2
  STATUS=1
else
  "$DENO" test --no-lock --no-check --allow-read --allow-env --allow-run \
    --allow-write="$PWD/.tmp" \
    tests/engine.test.js tests/wiring.test.mjs tests/png.test.mjs tests/serve.test.mjs \
    || STATUS=1
fi

echo
echo "== 3/3 browser smoke test =="
if [[ -x .gc-roots/node/bin/node && -e .gc-roots/pw/index.js ]]; then
  PATH="$PWD/.gc-roots/node/bin:$PATH" \
  PLAYWRIGHT_BROWSERS_PATH="$PWD/.gc-roots/browsers" \
    node tests/browser.test.mjs || STATUS=1
else
  echo "FAIL: browser toolchain absent, so no page was painted. Bootstrap with:" >&2
  STATUS=1
  echo
  echo "  nix-build gcroots.nix -A pw        --out-link .gc-roots/pw"
  echo "  nix-build gcroots.nix -A browsers  --out-link .gc-roots/browsers"
  echo "  nix-build gcroots.nix -A node      --out-link .gc-roots/node"
fi

echo
if [[ $STATUS -eq 0 ]]; then echo "ALL CHECKS PASSED"; else echo "SOME CHECKS FAILED"; fi
exit $STATUS
