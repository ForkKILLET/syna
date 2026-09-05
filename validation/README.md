# validation/

Machine-readable results produced by `node scripts/verify-v05.mjs`:

- `v0.5-dev/manifest.json`, `v0.5-dev/logs/*.log` — development gate (G0): every spawned command with exit code, timing, TAP counts and log path; `benchmark-v0.5.json`; `working-set.json`.
- `v0.5-release/manifest.json`, `v0.5-release/logs/*.log` — release gate (G0 + G1): additionally the archive scan, archive hashes, the clean-directory rebuild steps, package tarballs and the independent consumer smoke result. The same manifest is copied to `RELEASE_MANIFEST.json`; archive and tarball hashes are listed in `v0.5-release/SHA256SUMS.txt` (the root `SHA256SUMS.txt` is the task-document hash list shipped with the workspace and is never rewritten).
- `v0.5-release/hyla-request-latency.json` — end-to-end Hyla-mini request latency on both backends (report only, rendered in `docs/VALIDATION.md`; not a budget)
- `v0.5-<mode>/working-set.json` — H11/P05 working-set report written by `apps/hyla-mini/tests/site-manager.test.mjs` for that run (heap samples after GC, records per phase, eviction counts). A plain `npm run test:app` writes it under `work/v05/` instead, so tests never rewrite tracked files.

Hash discipline: the manifest records the **source** fingerprint (sha256 over path + content hashes of every archived source file, excluding `dist`, `node_modules` and the dev/release validation directories) and the **archive** hashes computed after the archive is written. The manifest itself is never placed inside the archive it describes; it is a sidecar that references the archive hash. Commands are recorded with the workspace root replaced by `<root>`; git provenance is captured before the first step runs. Any source change invalidates the recorded fingerprint and requires a new run.
