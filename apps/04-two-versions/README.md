# 04 — two versions: v1 and v2 of one provider coexist, and stored choices keep working

The Acme SDK shipped a generation 2. Tenants who chose Acme a year ago must keep working exactly as before, new tenants should get the new generation, and both must be installed side by side until the last legacy tenant has moved — without a flag day and without the sending code caring which generation it talks to. This demo shows both generations admitted at once, a choice stored before generation 2 existed still resolving to generation 1, a new choice resolving to generation 2, and what a stored choice for a generation nobody ships any more gets told.

## What the code shows

- Two Revisions of one Family admitted together: `@syna-demo/acme-notify-v1` (1.8.4) and `@syna-demo/acme-notify-v2` (2.4.1) share the `syna.id` `demo.notify.acme`, so they are one Family; `createRuntime({ services: [AcmeNotify1, AcmeNotify2, …] })` admits both.
- `runtime.catalog.implementations(Notifier)` and `runtime.catalog.revisions(AcmeNotify1.family)` — what is installed, highest first.
- A stored `ImplementationRef` carries a range, not a build: `^1.8.0` written before v2 existed resolves to 1.8.4 today; `PreferredNotifier.to(AcmeNotify2)` writes `^2.4.1`. Through the Binding a client is the Contract; whether this one can batch (`sendBatch`, generation 2 only) is a runtime fact the outbox reports.
- `AcmeNotify1.range('>=1.8.0')` — a range reference taken from the 1.x revision resolves to the newest admitted revision that satisfies it and provides the same Contracts (2.4.1), while `AcmeNotify1.range('^1.8.0')` stays at 1.8.4; either way the ref types as the Contract view, never as the 1.x instance.
- A stored choice for `^0.9.0` is `MISSING_IMPLEMENTATION` with `details.available` listing what is installed — from the catalog and from `runtime.check()` alike.

## Run

```sh
npm run build && node apps/04-two-versions/dist/index.js     # or: npm run demo:04
```

## What it prints

```
04-two-versions: catalog: demo.notify.acme@2.4.1, demo.notify.acme@1.8.4, demo.notify.globex@3.1.0; Acme revisions: 2.4.1, 1.8.4
04-two-versions: legacy tenant (stored ^1.8.0) → Acme 1.8.4, batches: no; new tenant (^2.4.1) → Acme 2.4.1, batches: yes
04-two-versions: a range taken from the 1.x code: >=1.8.0 → 2.4.1, ^1.8.0 → 1.8.4
04-two-versions: a stored choice for ^0.9.0 is refused: MISSING_IMPLEMENTATION (available: 2.4.1, 1.8.4); a world entered with it: MISSING_IMPLEMENTATION
04-two-versions: OK
```

Asserted by the program (exit 1 otherwise) and matched by the release gate's `demo-04-two-versions` step.
