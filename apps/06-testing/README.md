# 06 — testing: replace the real provider in an integration test

The application delivers through Acme. An integration test has to run the same application — the same worlds, the same stored tenant choices, the same delivery code — without calling Acme, and then check what would have been sent. This demo runs one job under two runtimes: the real one, and one where the Acme client is replaced by a recording fake at construction time. Nothing in the application changes between the two; the results agree, and the fake holds the record.

## What the code shows (`src/index.ts`)

- The application is the shape of `03`: a Binding for the tenant's provider choice, an `Outbox`, an application world and a tenant world. `deliverAll(runtime)` is written once.
- `override(AcmeNotify, RecordingNotifier)` in `createRuntime({ services, overrides })` — every path that resolves the real revision, including the Binding written for it (`PreferredNotifier.to(AcmeNotify)`), runs the fake's `setup` instead. The fake keeps the real client's instance shape (`send`, `sendBatch`, `tenantId`, `sdk`), which is what TypeScript checks at the `override()` call.
- The fake records every `send()`; the real runtime never sees it (`inspect().overriddenServices` is empty there, and names the real revision in the test runtime).

## Run

```sh
npm run build && node apps/06-testing/dist/index.js     # or: npm run demo:06
```

## What it prints

```
06-testing: real runtime: acme-corp/welcome-1 via Acme 2.4.1, globex-fans/invoice-2 via Acme 2.4.1
06-testing: fake runtime: acme-corp/welcome-1 via Acme fake, globex-fans/invoice-2 via Acme fake
06-testing: same tenants, notifications and outcomes under both: true
06-testing: the fake recorded: acme-corp:welcome-1, globex-fans:invoice-2; overridden in the fake runtime: demo.notify.acme@2.4.1
06-testing: OK
```

Asserted by the program (exit 1 otherwise) and matched by the release gate's `demo-06-testing` step.
