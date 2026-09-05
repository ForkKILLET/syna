#!/bin/sh
# Runs every probe of this audit line and records the raw output in RUN-LOG.txt.
# Usage: sh run-all.sh   (from any directory; needs the built packages/core/dist)
cd "$(dirname "$0")" || exit 2
LOG=RUN-LOG.txt
: > "$LOG"
status=0
for probe in 01-unreachable-dropped-handle.probe.mjs 01b-unreachable-repeat.probe.mjs 01c-v8-weak-order.mjs \
             02-selector-cross-runtime-cache.probe.mjs 03-public-range-origin.probe.mjs 04-tree-close-bound.probe.mjs \
             05-slow-rollback-in-grace.probe.mjs 06-requires-order-determinism.probe.mjs 07-cache-hit-skips-drift-check.probe.mjs \
             08-controls.probe.mjs 09-misc.probe.mjs; do
  printf '===== %s =====\n' "$probe" >> "$LOG"
  node "$probe" >> "$LOG" 2>&1
  code=$?
  printf -- '----- exit %s -----\n\n' "$code" >> "$LOG"
  [ "$code" -ne 0 ] && status=1
done
echo "done; see $LOG"; exit "$status"
