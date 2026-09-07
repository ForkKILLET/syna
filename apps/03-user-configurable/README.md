# 03 — user-configurable: a tenant chooses its provider, and the choice is stored

Two providers can deliver a notification. A tenant picks one on its settings page; the choice has to go into the database and, when it is read back later — after a deploy, on another machine — still mean the same provider, without the code that sends notifications knowing which providers exist. This demo shows how to describe the capability the tenant chooses between, how to list the available options, how to store a choice as plain JSON and read it back, and how a delivery then uses whichever provider the tenant picked.

## What the code shows

- The capability is a Contract: `define.contract<Notifier>('notifier')` in `packages/notify-contract/src/index.ts`. The Acme and Globex clients declare `provides: [Notifier]` (`packages/acme-notify-v2/src/index.ts`, `packages/globex-notify/src/index.ts`); this program depends on the Contract only.
- `PreferredNotifier = define.binding('preferred-notifier', Notifier)` — the tenant's choice is a Binding: a named slot that one implementation is assigned to when a tenant world is entered.
- `Notifier.all` — the settings page lists every admitted implementation with its display name, version and the JSON-safe reference a pick would store.
- `PreferredNotifier.to(GlobexNotify)` writes an `ImplementationRef` — `{ kind, contractId, familyId, range }`, nothing else — into the tenant's settings file; `PreferredNotifier.parse(document)` reads it back and refuses anything that is not a complete reference (`INVALID_DESCRIPTOR`).
- `app.run(TenantEntry, { tenant, notifier }, …)` enters a delivery world with the tenant and the choice read from its file; the `Outbox` depends on the Binding and sends through whichever provider that is.

## Run

```sh
npm run build && node apps/03-user-configurable/dist/index.js     # or: npm run demo:03
```

## What it prints

```
03-user-configurable: settings page of globex-fans: Acme Notify 2.4.1, Globex Notify 3.1.0
03-user-configurable: stored choice of globex-fans: {"kind":"implementation-ref","contractId":"demo.notify.contract/notifier/v1","familyId":"demo.notify.globex","range":"^3.1.0"}
03-user-configurable: acme-corp → Acme 2.4.1 (receipt acme/2/1-1); globex-fans → Globex 3.1.0 (receipt globex/1-1)
03-user-configurable: a hand-written document without a range is refused: INVALID_DESCRIPTOR (malformed-implementation-ref)
03-user-configurable: OK
```

Asserted by the program (exit 1 otherwise) and matched by the release gate's `demo-03-user-configurable` step.
