# 05 — scheduled jobs: a service creates typed child worlds by itself

Once a day every tenant gets a digest. The scheduler is a long-lived part of the application; each digest is a short-lived job with its own facts — the tenant, the date — that must use the tenant's own provider client, share the application's connection pool, and leave nothing behind when it is done. This demo shows a scheduler that opens one such job world per tenant, in parallel, without being handed a "current world" by whoever calls it, and how each job world gets its own inputs and is closed as soon as its work returns.

## What the code shows (`src/index.ts`)

- `DigestEntry` — the digest world, typed: what it offers (`sender`) and what it must be given (`tenant`, `job`). `DigestJob` is the job's own Input, next to the tenant.
- `DigestScheduler` is an eager Service that depends on `DigestEntry`. What it receives is an `AnchoredEntry`: the Entry anchored at the world that owns the scheduler, so every world it opens is a child of the application world — no ambient "current world" is involved.
- `anchored.check(…)` during the scheduler's own setup: planning is allowed while the owner is still starting; `anchored.run({ tenant, job }, callback)` after the host started the schedule: one child world per tenant, all at once, each closed when its callback returns (`liveEnvCount` is back to the application world alone).
- Every job world shares the application's `TenantStore` pool (same `poolId`) and has its own `DigestSender` and Acme client (`sendBatch` of the 2.x generation).
- The control: a service that tries to enter a child world *during its own setup* is refused — its owner is not ready — and that refusal fails the owner's activation (`ENTRY_ACTIVATION_FAILED`, cause `OWNER_NOT_READY`). Start schedules after the world is ready, as the host does here.

## Run

```sh
npm run build && node apps/05-scheduled-jobs/dist/index.js     # or: npm run demo:05
```

## What it prints

```
05-scheduled-jobs: the scheduler planned a digest world while it was starting: ok
05-scheduled-jobs: digests for 2026-09-07: acme-corp (pool #1), globex-fans (pool #1); batches: acme/2/batch-1-1, acme/2/batch-2-1
05-scheduled-jobs: worlds alive after the run: 1 (each digest world closed when its run() returned)
05-scheduled-jobs: entering a child world from inside setup is refused: ENTRY_ACTIVATION_FAILED (cause OWNER_NOT_READY)
05-scheduled-jobs: OK
```

Asserted by the program (exit 1 otherwise) and matched by the release gate's `demo-05-scheduled-jobs` step.
