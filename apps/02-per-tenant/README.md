# 02 — per tenant: one set of instances per tenant, without a named scope

Your notification service has several tenants. Each tenant has its own credential at the provider, so each needs its own provider client and its own outbox; the connection pool and the logger, on the other hand, should exist once and be shared by everyone. This demo shows how to get exactly that split — per-tenant pieces separate, shared pieces shared — without inventing a "tenant scope" or passing the tenant through every constructor: the tenant is a fact of the world a piece lives in, and what reads that fact belongs to that tenant.

## What the code shows (`src/index.ts`)

- `CurrentTenant` is an Input (`define.input`, in `@syna-demo/tenant-store`): a fact the host provides when it opens a world. `Branding` reads it with `tenant.read()` — synchronously, no lifecycle — so every tenant world gets its own `Branding`.
- `Outbox` never reads the tenant; it depends on `Branding` and on the Acme client (which reads the tenant inside its own package), so it is per tenant too. The store and the logger depend on nothing tenant-specific, so they are the same instances in every world.
- `AppEntry` is the root world (the store, configured by the host); `TenantEntry` is a child world that provides the tenant; a `SandboxEntry` below a tenant world provides the tenant again with a test credential.
- `env.explain(TenantEntry, { tenant })` answers "what would this world create, and why?" before anything is created: every node that is not reused is listed with its placement (`new` / `forked`) and its cause (`input-provided`, `not-in-parent`, `dependency-forked via …`).
- `reuse: { share: [TenantStore, Logger] }` on `TenantEntry` makes sharing a hard rule: a caller that asks for a fresh store under it is refused (`SHARE_CONSTRAINT_FAILED`) instead of silently opening a second pool.

## Run

```sh
npm run build && node apps/02-per-tenant/dist/index.js     # or: npm run demo:02
```

## What it prints

```
02-per-tenant: a tenant world: 3 new, 0 forked, 2 reused services
02-per-tenant:   new demo.tenant-store/input/current-tenant/v1 — this world provides it
02-per-tenant:   new demo.examples.per-tenant/branding@1.0.0 — the parent world has no such node
02-per-tenant:   new demo.examples.per-tenant/outbox@1.0.0 — the parent world has no such node
02-per-tenant:   new demo.notify.acme@2.4.1 — the parent world has no such node
02-per-tenant: acme-corp → acme/2/1-1; globex-fans → acme/2/2-1
02-per-tenant: separate outboxes and Acme clients per tenant: true; one store pool and one logger for all: true
02-per-tenant: a sandbox world below acme-corp: 0 new, 3 forked, 2 reused services
02-per-tenant:   new demo.tenant-store/input/current-tenant/v1 — this world provides it
02-per-tenant:   forked demo.examples.per-tenant/branding@1.0.0 — its dependency "tenant" is new in this world
02-per-tenant:   forked demo.examples.per-tenant/outbox@1.0.0 — its dependency "notifier" is new in this world
02-per-tenant:   forked demo.notify.acme@2.4.1 — its dependency "tenant" is new in this world
02-per-tenant: the sandbox has its own Acme client (true) on the shared pool #1: acme/2/3-1
02-per-tenant: a caller asking for a fresh store under a shared one is refused: SHARE_CONSTRAINT_FAILED
02-per-tenant: OK
```

Asserted by the program (exit 1 otherwise) and matched by the release gate's `demo-02-per-tenant` step; the `[info]` / `[debug]` lines in between are the logger's.
