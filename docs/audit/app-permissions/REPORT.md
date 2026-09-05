# Hyla-mini adversarial audit — application / permissions / resources

Independent audit of `apps/hyla-mini` (Syna v0.5). Line: two tenants, private realms, override coherence, `C.all` factory sharing, site lease / configuration race, shared pool ownership and closing. The auditor did not write this code and received no claim that it is correct. Everything below is behavioural: each finding has a trigger, the expected behaviour with the spec sentence it rests on, the observed output, the probe that reproduces it, a severity and a scope. Nothing under `packages/`, `apps/`, `docs/`, `scripts/` was modified.

## Environment

| item | value |
| --- | --- |
| repository HEAD | `0240b6f736142bbe4bad48ee8ee999ebc05b2cfc` (`git rev-parse HEAD`) |
| node | v26.0.0 |
| OS | macOS 26.2 (Darwin 25.2.0), arm64 |
| PostgreSQL | 17.10 (Homebrew), temporary cluster via `scripts/pg-test-cluster.mjs with --` under `SYNA_PG_CLUSTER_DIR=work/pg-audit`, removed after each run |
| build | `apps/hyla-mini/dist` and `packages/core/dist` were current (no `.ts` newer than `dist/app.js`); not rebuilt |
| baseline | the shipped filesystem-side suites (`tenants-auth`, `preflight`, `filesystem`) pass: 53/53 |
| run date | 2026-09-05T03:5x UTC |

## Probes

All probes live in `work/v05/audit/app-permissions/`, import the app from `../../../../apps/hyla-mini/dist/index.js` and the harness from `../../../../apps/hyla-mini/tests/helpers/app-harness.mjs`, print one `PASS`/`FAIL` line per case with the observed value, and exit on their own (60–120 s watchdog; an unref'd 5 s timer reports if anything keeps the process alive after close — it never fired).

Run: `node work/v05/audit/app-permissions/<name>.probe.mjs`. PostgreSQL probes: `SYNA_PG_CLUSTER_DIR=$PWD/work/pg-audit node scripts/pg-test-cluster.mjs with -- node work/v05/audit/app-permissions/<name>.probe.mjs` (one wrapped command at a time).

| probe | attack list | PASS | FAIL | findings |
| --- | --- | ---: | ---: | --- |
| `tenant-isolation.probe.mjs` | 1, 2 | 71 | 3 | F-AP-04 |
| `site-manager-race.probe.mjs` | 3 | 39 | 9 (11 in one of three runs) | F-AP-01, F-AP-02, F-AP-05, F-AP-06, F-AP-12 |
| `pool-sharing.probe.mjs` (PostgreSQL) | 4 | 25 | 0 | — |
| `override-private-realm.probe.mjs` | 5, 6 | 19 | 1 | F-AP-10 |
| `factory-sharing.probe.mjs` | 7 | 17 | 0 | — |
| `static-export.probe.mjs` | 8 | 22 | 4 | F-AP-03 (static server), F-AP-08 |
| `filesystem-backend.probe.mjs` | 9 | 42 | 0 | — |
| `postgres-backend.probe.mjs` (PostgreSQL) | 10 | 22 | 0 | — |
| `worker-lifecycle.probe.mjs` | 11 | 13 | 1 | F-AP-09 |
| `process-hygiene.probe.mjs` | 12 | 17 | 8 | F-AP-03, F-AP-07, F-AP-11 (observed); one FAIL is a probe artifact, see note |

Notes on counts. `process-hygiene` line `3 no sockets / servers still open after close -- ["PipeWrap","PipeWrap"]` appears only when the probe's stdout is piped (`| grep`); run directly it reports timers only. It is not an application handle and is not counted as a finding. `process-hygiene` has two extra modes: `AUDIT_NO_HANDLER=1 node …` (Node's default unhandled-rejection policy, as a real server runs) exits 1 with `ERR_INVALID_URL` from `dist/site/http.js:49`; `node --unhandled-rejections=strict …` dies the same way after 13 checks. `site-manager-race` section C (`slow-auth` storm) stranded a record in one run out of three; sections A1–A3 and B reproduce the same defect deterministically.

## Findings

Severity scale: blocking / major / minor / limitation. "Scope" says whether the defect is in the application (Hyla-mini) or would need the core.

### F-AP-01 — SiteEnv rotated to `draining` while still `creating` is never disposed; it leaks capacity until shutdown

- **Trigger.** A tenant's first `acquire()` is still creating its SiteEnv (any authenticator whose `setup()` does asynchronous work widens the window; the probe uses a 60 ms one) and, meanwhile, either the tenant's configuration is saved (new `configRevision`) or `invalidate(tenantId)` is called.
- **Expected.** H10: "旧配置不得在 manager 中无限积累", "驱逐不能代替版本失效", "不可驱逐有活跃 lease 的 Env"; H11: "证明容量有界". A record with zero leases in `draining` must be disposed like any other draining record.
- **Actual.** `create()` sets `record.state = record.state === 'creating' ? 'active' : record.state` (`site/manager.ts:230`), so a record rotated to `draining` during creation stays `draining` with a live Env. Its creator and joiners decrement `leases` in `finally` (lines 288, 298) and nobody calls `disposeRecord`: the rotation loop skips records already `draining` (line 264), `release()` is never called because no lease was handed out, `sweep()` and `evictIdle()` only touch `active` records (lines 169, 335). Observed after both acquires were released and a sweep: `[{key:"…|slow|1", state:"draining", leases:0, idleForMs:84}, {key:"…|slow|2", state:"active", leases:0}]`, `liveEnvCount` = 2 + 2. With `capacity: 3` and two such strands, a third tenant gets `SiteCapacityError: Timed out after 300 ms waiting for a site environment` while `stats()` shows `draining: 2, active: 0, idle: 1`. The storm variant with a slow authenticator (`C[slow-auth]`) stranded `…|alpha|4` spontaneously in one of three runs.
- **Probe.** `site-manager-race.probe.mjs` A1, A3 (deterministic), C[slow-auth] (nondeterministic).
- **Severity.** major. **Scope.** application (`site/manager.ts`). Fix sketch: after `create()` resolves, if `record.state === 'draining' && record.leases === 0` dispose it; or make the rotation loop and `sweep()` also dispose draining records whose lease count is zero.

### F-AP-02 — `invalidate()` makes the tenant unacquirable while any lease is held (and permanently after F-AP-01)

- **Trigger.** `manager.acquire('alpha')` (hold it) → `manager.invalidate('alpha')` → `manager.acquire('alpha')`. No race is needed.
- **Expected.** Interface comment (`site/manager.ts:74-75`) and `docs/HYLA_MINI.md`: "Marks every environment of a tenant as stale; new acquires read the store again. Draining envs close when their leases end." H10: "新请求必须进入新配置版本，旧请求继续合法完成并释放旧环境".
- **Actual.** The configuration revision did not change, so the new acquire computes the same key, finds the draining record, and the retry loop (`attempt < 5 → continue`, lines 270-274) re-reads the same store state five times with no delay and throws `Error: Site alpha configuration changed repeatedly while acquiring; giving up after 5 attempts.` Acquires succeed again only after the in-flight lease is released (section B) — or never, when the record was stranded (F-AP-01; section A2 shows the tenant stays dead until a configuration save changes the key). Over HTTP this is a 500 for every request of that tenant.
- **Probe.** `site-manager-race.probe.mjs` B, A2.
- **Severity.** major. **Scope.** application. `invalidate()` needs a generation counter in the key (or a "force new record" path) rather than relying on `configRevision` changing.

### F-AP-03 — URL parsing exceptions escape both HTTP handlers: hung connections, and process termination under Node's default policy

- **Trigger.** Dynamic server: an absolute-form request target whose authority the WHATWG parser rejects — `GET http://[::1 HTTP/1.1`, `GET http://alpha.test:99999/ HTTP/1.1`, `GET http://%zz/ HTTP/1.1` (Host `alpha.test`). Static server: a malformed percent-encoding — `GET /%zz`, `GET /posts/%e0%a4%a`.
- **Expected.** H04: the dynamic side "真实启动本地临时端口 HTTP server并请求页面" and the static side is "服务它" — a server must answer or refuse; §11 quality baseline. An unauthenticated request must not be able to stop the process.
- **Actual.** `new URL(request.url ?? '/', \`http://${host}\`)` (`site/http.ts:72`) is outside every `try`, and `decodeURIComponent(url.pathname)` (`site/http.ts:129`) is inside a `void (async () => …)()` with the `try` only around the file read. Both throw synchronously into an async function whose promise nobody observes: the response is never written (client `HUNG` after 2 s), `unhandledRejection` fires (`Invalid URL` ×3, `URI malformed` ×2). With no handler installed — `bin/hyla-mini.mjs serve` installs none — Node's default `--unhandled-rejections=throw` policy terminates the process: `TypeError: Invalid URL … code: 'ERR_INVALID_URL', input: 'http://[::1', base: 'http://alpha.test'` at `dist/site/http.js:49`, exit 1. Node accepts these request targets (llhttp only validates characters).
- **Probe.** `process-hygiene.probe.mjs` (section 2; run with `AUDIT_NO_HANDLER=1` for the crash), `static-export.probe.mjs` (malformed percent cases).
- **Severity.** major (remote, unauthenticated denial of service of the whole multi-tenant process; an operator exposing `serve` would treat it as blocking). **Scope.** application (`site/http.ts`). Wrap URL parsing in the request `try`, answer 400, and consider a top-level `server.on('request')` guard.

### F-AP-04 — Page cache is never invalidated by content changes; a post made private keeps its title and preview on anonymous index/category pages

- **Trigger.** Anonymous `GET /posts/hello-world` and `GET /` (both cached); `savePost` with a new body; request again. Then `savePost` turning `shared-slug` to `status: 'private'`; anonymous `GET /` and `GET /category/notes`.
- **Expected.** H08: "tenant/locale/content visibility等会影响输出时进入应用缓存键"; H10: business facts live in the backend, the SiteEnv is only "a cached, leased composition … for one configuration revision". A visibility change must stop the anonymous index from listing the post; an edit should be visible without a configuration save.
- **Actual.** `SiteContext.cached()` keys on `tenant|configRevision|locale|visibilityClass|path` (`site/context.ts:53`) and nothing ever deletes entries. Edited body: `/posts/hello-world` and `/` are byte-identical to the pre-edit responses (`stale: true`); a not-yet-cached partition (member) sees the new body, so the data path is fine and only the cache is stale. After the post became private the post page correctly returns 404 (authorization is re-checked before the cache, `context.ts:85`), but the anonymous `/` and `/category/notes` still list `shared-slug` with its title and rendered preview (first 160 characters of the body). For a tenant with continuous traffic the Env is never idle-evicted, so this lasts until a configuration save. The documented remedy, `invalidate()`, is F-AP-02.
- **Probe.** `tenant-isolation.probe.mjs` section 2c (three FAIL lines).
- **Severity.** major (stale index/category pages disclose the excerpt of content that was withdrawn from the public; edits invisible indefinitely on hot tenants). **Scope.** application (`site/context.ts`). Include a content revision in the key or have the repository/store signal mutations to the manager.

### F-AP-05 — A fast-failing cold creation is not single-flight; the backoff counter is inflated by the number of concurrent acquirers

- **Trigger.** Tenant configured with `SignedTokenAuth` and no `secret`; six concurrent `acquire()`s.
- **Expected.** H10: "并发首次获取同一键 single-flight", "创建失败不能留 poison single-flight promise；设置有界重试/backoff避免风暴".
- **Actual.** The first acquirer's creation fails within the same microtask drain and deletes its record (`manager.ts:241-243`) before the other five resume from their `readConfig()` await; each of them finds no record, inserts one, and runs its own creation. `creationFailures` = 6 after one burst; backoff message `backing off after 6 failure(s)`; with default settings (`creationBackoffMs 200`, max 10 s) one burst of six yields a 6.4 s lockout instead of 200 ms. The contrast case (a creation that fails after asynchronous work) shares one attempt: `creationFailures` +1 for six acquirers. No poisoned record remains in either case (that part holds).
- **Probe.** `site-manager-race.probe.mjs` E.
- **Severity.** minor. **Scope.** application. Keep the failed record in the map (or a per-tenant "failing" promise) until the current microtask drain ends, or check backoff again after `readConfig()`.

### F-AP-06 — Internal diagnostics echoed to anonymous HTTP clients; backoff error has no `code`

- **Trigger.** Anonymous `GET /` with `Host: broken.test` while that tenant is backing off; or any handler failure.
- **Expected.** A 5xx with a neutral body; the configuration text of a tenant is not public information. (H08/H09 do not state this sentence; §11 quality baseline; the acquire-error path already tries to map codes to statuses.)
- **Actual.** `500 ERROR: Site broken creation is backing off after 6 failure(s) until 2026-09-05T03:53:35.360Z: signed-token-auth requires a string \`secret\` option.` (`site/http.ts:79-81`: the backoff `Error` carries no `code`, so it is not 503 either); `500 Internal error: authenticator.authenticate is not a function` (`site/http.ts:105-106`).
- **Probe.** `site-manager-race.probe.mjs` E (`HTTP body does not echo…`), `override-private-realm.probe.mjs` 5c.
- **Severity.** minor. **Scope.** application.

### F-AP-07 — `DatabasePool` ends its pool twice on a failed setup; the surfaced error becomes a spurious "rollback failed" aggregate

- **Trigger.** PostgreSQL backend with an unreachable server (`postgres://nobody@127.0.0.1:1/nope`), then the first `store.load()`.
- **Expected.** K09 / task line: the pool is ended exactly once; the error surface names the real cause.
- **Actual.** `data/postgres/pool.ts:77` registers `onDispose(() => pool.end())` before the probe query; the `catch` at line 89 calls `pool.end()` itself and rethrows; the core then runs the attempt's cleanups (`packages/core/src/internal/materializer.ts:370-379`) and `pg` throws `Error: Called end on pool more than once`. Observed `ends: 2` (counted on `pg.Pool.prototype.end`) and `AggregateError: Setup attempt 1 of hyla.mini/database-pool@0.1.0 and its rollback both failed.` wrapping `connect ECONNREFUSED 127.0.0.1:1` and the spurious end error. No PostgreSQL server is needed to reproduce.
- **Probe.** `process-hygiene.probe.mjs` section 1.
- **Severity.** minor. **Scope.** application (register `onDispose` after the probe, or drop the manual `end()`).

### F-AP-08 — `StaticBuilder` recursively deletes `posts/`, `category/`, `index.html`, `site.json` in any `outputDir`, including files it never wrote

- **Trigger.** `BuildEntry` with `outputDir` pointing at a directory that already contains `posts/notes/keep.md`, `category/unrelated.txt`, `notes.txt`.
- **Expected.** The code comment at `site/static-builder.ts:40`: "Only remove what a previous build of this builder wrote"; H03: "禁止危险递归删除不属于测试的路径".
- **Actual.** `rm(path.join(outputDir, entry), { recursive: true, force: true })` for the four fixed names (`static-builder.ts:41-45`) — no manifest or marker check. Observed `keepExists: false, unrelatedExists: false, notesExists: true`. Pointing a build at a tenant's content directory of the filesystem backend (`<root>/<tenant>/posts/…`) would destroy that tenant's posts; `isSafeOutputDir` only requires an absolute path with two segments.
- **Probe.** `static-export.probe.mjs` (last check).
- **Severity.** minor (requires operator misconfiguration; consequence is data loss). **Scope.** application. Write a manifest/marker and delete only listed files, or refuse a non-empty directory without one.

### F-AP-09 — `MaintenanceWorker.stop()` issued during `start()` is lost

- **Trigger.** `const p = worker.start({ intervalMs: 5 }); await worker.stop(); await p`.
- **Expected.** H13: the worker "退出时收到停止通知"; a stop issued after start must leave the worker not running.
- **Actual.** `stop()` sees `state === 'idle'` (start has not yet flipped to `running`; it is awaiting `bound.enter()`), sets `stopped` and returns (`site/worker.ts:33-35`); `start()` then sets `running` and the loop runs — observed `state: "running", ticks: 7, liveEnvs: 3` 40 ms later. A second explicit `stop()` works. Disposal is unaffected (`signal.aborted` ends the loop; probe A passes).
- **Probe.** `worker-lifecycle.probe.mjs` B.
- **Severity.** minor. **Scope.** application (track a `starting` state or check `stopRequested` after `bound.enter()`).

### F-AP-10 — Interface-incompatible override is accepted through preflight and site creation; it fails on the tenant's first request

- **Trigger.** `createHylaApp({ runtime: { overrides: [override(SessionAuth, BrokenAuth)] } })` where `BrokenAuth.setup()` returns `{ scheme: 'broken' }` (no `authenticate`).
- **Expected.** K11: "必须检查提供给消费者的接口兼容，Runtime 不能假装 TS 类型是运行时行为证明". The manager also loads the authenticator at creation "to surface configuration errors at creation" (`site/manager.ts:228-230`).
- **Actual.** `startup: ok, siteCreation: ok, firstRequest: 500, body: "Internal error: authenticator.authenticate is not a function"`.
- **Probe.** `override-private-realm.probe.mjs` 5c.
- **Severity.** limitation / minor; interpretation uncertain — the Runtime cannot prove JavaScript shapes statically, but the application's own creation-time load could check the Contract's method set. **Scope.** core semantics (K11) and application (creation-time check).

### F-AP-11 — `createHylaApp()` resolves without touching the database; the failure appears at the first `store.load()`; the runtime is not disposed if `AppEntry.enter` rejects

- **Trigger.** PostgreSQL backend with an unreachable server or an invalid schema name (`bad-schema;drop`).
- **Expected.** `app.ts` describes "Runtime → infrastructure root → app Env, with startup preflight"; H13 "正常启动". A deployment whose only data source is unreachable should not report itself as started.
- **Actual.** All Service slots are lazy and preflight is planning-only, so `createHylaApp()` resolves (`resolved: true`) for both bad configurations; `store.load()` then rejects (ECONNREFUSED; `DatabaseConfig.schema must match …`). The CLI `serve` path calls `store.load()` immediately, so its practical impact is a late but clear error; programmatic users of `HylaApp` get no signal. Code reading (not probe-observable): when `infrastructure.enter(AppEntry)` rejects (`app.ts:139`) the runtime and root Env are not disposed, unlike the `check()` and preflight failure paths.
- **Probe.** `process-hygiene.probe.mjs` section 1 (OBSERVE lines).
- **Severity.** limitation / minor. **Scope.** application.

### F-AP-12 — `HylaApp.close()` discards the unreleased-lease report

- **Trigger.** Hold a lease, call `app.close()` with `shutdownTimeoutMs: 60`.
- **Expected.** H10: "关闭期间 … 等待或明确报告未释放 lease".
- **Actual.** `onDispose(async () => { await shutdown() })` (`site/manager.ts:368`) drops the return value; `app.close()` waits the timeout (70 ms observed) and resolves `undefined`. Only a caller of `manager.shutdown()` directly receives `{ unreleasedLeases: [...] }` (that path is correct: per-record `key#count`, idempotent, late releases never negative).
- **Probe.** `site-manager-race.probe.mjs` F (last line).
- **Severity.** minor. **Scope.** application (log the report or expose it on `HylaApp.close()`).

### F-AP-13 — A tenant configuration claiming another tenant's domain stops the whole deployment's domain table

- **Trigger.** Beta saves `domains: ['beta.test', 'alpha.test']`; `app.domains()`.
- **Expected.** H08: "受控域名表". The table is meant to be controlled; the question is only who controls tenant `domains`.
- **Actual.** `loadDomainTable` throws `Domain alpha.test is claimed by both alpha and beta.` (`site/domains.ts:40-42`), so `app.domains()` — and therefore server start — fails for every tenant. A running table's `refresh()` rejects and keeps the previous table (correct).
- **Probe.** `tenant-isolation.probe.mjs` (last two checks; recorded as OBSERVE).
- **Severity.** limitation / minor (depends on whether domains are tenant-editable; the spec treats the table as platform-controlled). **Scope.** application.

## Verified expectations

Behaviour that was attacked and held, with the probe that shows it.

- **Tenant isolation over HTTP** (`tenant-isolation`): `shared-slug` renders different, correct content for `alpha.test`/`www.alpha.test` and `beta.test` (`x-hyla-tenant` correct); alpha's `/category/essays` lists nothing of beta's; `/site.json` is per tenant; beta's `private-diary` is unreachable via seven vectors (alpha domain anonymous/member/editor/beta bearer token; beta domain with a token signed by beta's secret but `tenantId: 'alpha'`, with an alpha cookie, anonymous) and the real beta member reads it; 20 path tricks (`..`, `%2e%2e`, encoded slashes, upper-case slugs, trailing/double slashes, `//host/…`, absolute-form target, query smuggling, NUL) leak nothing and never 500 (dot segments are WHATWG-normalised inside the tenant's own routes); hosts: unknown, IPv6 literal, trailing dot, bare IP, percent → 404; port stripped; case-insensitive; HTTP/1.0 without Host → 404 (HTTP/1.1 without Host → 400 by Node); duplicate `Host` headers → Node keeps the first; `X-Forwarded-Host` ignored unless `trustProxy`, first list entry wins, unknown forwarded host is refused with no fallback to `Host`.
- **Cache partitions** (`tenant-isolation`): anonymous/member/editor/foreign-tenant partitions never bleed (anonymous after member/editor identical to first anonymous; member after editor identical to first member; foreign-tenant identity gets the anonymous partition); private post: member 200 then anonymous 404; draft: editor 200, member 404, anonymous 404; responses are `private, no-store`; a configuration save rotates the next request into the new revision (`x-hyla-config-revision` 1 → 2), the old cached page is not served, the old record is disposed once idle.
- **Site lease manager** (`site-manager-race` C, D, E, F): under 24 concurrent acquirers, a held lease and 12 configuration saves, no acquire error and no acquire returned a revision older than one already saved when it started; after the storm exactly one active record at the latest revision, leases 0, `liveEnvCount` = infrastructure + app + records (fast authenticator; the slow-authenticator variant is the nondeterministic F-AP-01 case); transient per-tenant records peaked at 3 (one current + old revisions still leased in flight — legitimate); bounded queue (`maxPendingAcquires`) rejects with `SITE_CAPACITY`, waiters time out instead of evicting a leased Env, leased Envs stay intact, a release hands capacity to the waiter; double release never goes negative; a failing creation leaves no poisoned record, backoff is per tenant (beta unaffected), recovery after the configuration is fixed; slow-failing creations are single-flight; shutdown refuses new acquires with `SITE_MANAGER_CLOSED`, waits up to the timeout, reports unreleased leases per record (`…|beta|1#2`), disposes everything, is idempotent, late releases are harmless.
- **Shared pool** (`pool-sharing`, PostgreSQL): exactly one `pg.Pool` constructed for the whole app (seeding, 8 requests, 2 tenants, request/build Envs); exactly one `DatabasePool` slot across infrastructure/app/site/request/build inspections, owned by the app Env (`env-4`); site Envs own only `site-context` + their authenticator, request Env only `request-handler`, build Env only `static-builder`; `BuildEntry` and `RequestEntry` inherit `DatabasePool` and `PostgresContentStore` (forked 0); a child Entry requiring `DatabasePool` inherits it (new 0); transactions run on one leased client (same `pg_backend_pid`); `search_path` pinned to the app schema; disposing child Envs/leases does not end the pool; `app.close()` ends it exactly once; queries then reject (`Cannot use a pool after calling end on the pool`); second and third `runtime.dispose()` are no-ops; `liveEnvCount` 0.
- **PostgreSQL backend** (`postgres-backend`): rollback on throw (post, category, tag absent); concurrent transactions on two tenants with the same slug; same-tenant slug race → one winner, one `SlugConflictError` (`<concurrent>`), one row; `savePost` with another tenant's id rejected (`already belongs to another tenant`) and the victim row untouched, also inside a transaction; cross-tenant `getPostById`/`deletePost`/`getPost` see nothing; unsafe tenant ids rejected by `forTenant`, `transaction`, `deleteTenant`; injection-shaped category/tag filters are parameterised; `saveSiteConfig` with a foreign `tenantId` rejected; updates increment `revision` and keep `createdAt`; 10 concurrent updates → 10 distinct revisions.
- **Filesystem backend** (`filesystem-backend`): tenant ids `../alpha`, `alpha/..`, `..`, `.`, `Alpha`, NUL, `/alpha`, `a b` rejected by `forTenant` and `transaction`; slugs with `/`, `..`, upper case, backslash, empty, `.md` rejected before any file is touched; symlinked tenant directory excluded from `listTenants` and refused for read, write and `acquire`; a symlinked post file or a symlinked directory pointing at `/etc` makes the scan refuse (`UnsafePathError`), never followed; 20 concurrent updates → revision +20 with 20 distinct revisions; 20 concurrent creates land; racing creates for one slug → one `SlugConflictError`, one file; slug + primary-category rename under the blog layout moves the file, removes the old one, preserves `id`/`createdAt`, bumps `revision`, no duplicate record, rename back works; taking another post's slug is a conflict; uncategorised posts land in `posts/_uncategorized`; `transaction()` nests mutations without self-deadlock; documented no-rollback limitation confirmed; no `.tmp` files left; beta untouched.
- **Factory sharing** (`factory-sharing`): with alpha on default recipes and beta on three recipes with different options, six distinct pipelines are built; each of the seven factory Services is set up exactly once; `configured` counts equal one `configure()` per distinct stage occurrence (parse 6, gfm 4, excerpt 2, rehype 6, sanitize 4, links 4, stringify 6); 50 concurrent renders across tenants and recipe roles equal their serial baselines; no additional `configure()` during the storm (pipeline cache: builds 6, hits 60); alpha's comment recipe strips images while beta's keeps them (two products of one sanitize factory); every factory, the `all` collection, `PipelineBuilder` and `Renderer` slot is owned by the app Env as seen from both site Envs and a request Env.
- **Override coherence** (`override-private-realm` 5a/5b): an interface-preserving fake renderer is used for pages, keeps the source's nominal identity in `inspect()` and `overriddenServices`, is not an admitted candidate, and leaves the request budget intact; the site-fact-reading fake is refused at the render-infrastructure preflight with `MISSING_INPUT: Input hyla.mini/input/site-snapshot/v1 is required at service:hyla.mini/renderer@0.1.0/dependency:snapshot`.
- **Private realm** (`override-private-realm` 6): exact private dependencies of an admitted Service are `internalServices`, not `admittedServices`; `catalog.implementations(Authenticator)` excludes the private-only implementation; the Service-owned `BoundEntry` resolves its private root, whose slot is owned inside the owner-anchored world (not the app Env); public `check()`, `bind().enter()`, `enter()` and `explain()` of the same Entry, from the app Env and from the owner's own Env, all yield `MISSING_SERVICE` with a message that does not leak a candidate; a site configuration pointing `SiteAuth` at the private-only implementation fails with `MISSING_IMPLEMENTATION` (no supplier substitution) and leaves no record.
- **Static export** (`static-export`): 11 files for two tenants contain none of: draft/private bodies, session ids, token secret, `postgres://`, schema names, absolute paths, implementation refs, private/draft slugs or ids; `site.json` lists published posts only and no auth/recipe/domain configuration; the static server refuses eleven traversal encodings (403/404; in-root dot segments normalise to the tenant's own file) and serves directories with or without a trailing slash.
- **Worker** (`worker-lifecycle` A): starts after Ready in a real child Env, sweeps idle site Envs, `start()` twice rejects, `runtime.dispose()` while running completes in 1 ms, the loop ends, `liveEnvCount` 0, `start()` after disposal is refused with `INVALID_ENV_STATE`, restart after `stop()` works, `stop()` is idempotent.
- **Hygiene** (`process-hygiene`, all probes): `POST` → 405, `HEAD` → 200 empty; comment preview sanitised (`onerror`, `<script>`, `javascript:` removed; `rel="nofollow noopener ugc"`); no temp files; no sockets after close; every probe process exited on its own.

## Remaining risk / not covered

- F-AP-01's spontaneous occurrence under a configuration storm was observed in one of three runs; the deterministic reproduction (A1/A3) does not depend on timing. Treat the storm observation as **uncertain in frequency, certain in mechanism**.
- The interpretation of K11 for F-AP-10 (who must check interface compatibility at runtime) is uncertain; the observed behaviour is not.
- Not exercised: `MaintenanceWorker` when `sweep()` throws (the loop promise would reject unobserved); multi-process filesystem concurrency (documented out of scope); plan-cache eviction under hundreds of tenants (covered by the shipped H11 test, not re-probed); HTTP transport concerns outside application logic (keep-alive exhaustion, request smuggling, body limits — Node defaults); performance; the runtime leak on `AppEntry.enter` failure (code reading only, F-AP-11).
- Syna core internals were observed only through the application's behaviour (private realm, override view, ownership, cleanup-after-failed-attempt). No core-level probe was written for this line.
- The two authenticators are test adapters by declaration; beyond confirming `timingSafeEqual`, tenant binding of principals, and cross-scheme credential rejection, no cryptographic review was attempted.
