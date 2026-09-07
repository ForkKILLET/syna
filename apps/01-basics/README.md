# 01 — basics: define services, connect them, enter a world

You have a connection to a notification provider, some code that sends through it, and a program that should open the connection the first time it is needed and close it when the program is done. This demo shows how to describe those pieces so that opening happens on first use, closing happens at the end, and the code in between never has to think about either — and how shared infrastructure (a logger) is used by several pieces without any of them being responsible for shutting it down.

## What the code shows (`src/index.ts`)

- `definePackage(packageJson)` — every definition of this program is scoped to its package name and version.
- `define.service('acme-connection', { requires, setup })` — a Service owns a resource; `setup` acquires it and `onDispose(cleanup)` releases it when the world that owns the slot ends.
- `requires: { connection: AcmeConnection, logger: Logger }` — a Service names what it needs and receives refs; `await connection.load()` is what opens the connection, so it opens on the first delivery, not before.
- `define.entry('main', { requires })` — an Entry says what a world offers to the code that enters it.
- `createRuntime({ services })` admits the Services the program may use; `runtime.run(Main, callback)` enters the world, hands the callback the refs, and closes the world when the callback returns — the connection closes first, the logger last, each by its own cleanup.

## Run

```sh
npm run build && node apps/01-basics/dist/index.js     # or: npm run demo:01
```

## What it prints

```
01-basics: delivered welcome-1 to ada@example.test (receipt acme-1)
01-basics: connection opened only on the first delivery: true
01-basics: connection closed after the world ended: true
01-basics: logger closed last, by its own cleanup: true
01-basics: OK
```

The lines above are asserted by the program itself (exit 1 otherwise) and matched by the release gate's `demo-01-basics` step; the `[info]` lines between them are the logger's.
