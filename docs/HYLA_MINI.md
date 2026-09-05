# Hyla-mini（HYLA_MINI）

Hyla-mini 是使用 Syna v0.5 的窄范围但完整的多租户博客引擎：两种真实数据后端 × 两种执行方式，三份配方共享一组工厂，两租户隔离，可替换 auth，按需、有界、租约保护的 SiteEnv 工作集。它不是完整的 BlogAssembly，也不是通用 ORM。

## 分层

```
apps/hyla-mini/src
├── domain/        数据模型（Post/Category/Tag/SiteConfig/Recipe）、ContentRepository/ContentStore Contract、ContentBackend Binding
├── data/
│   ├── postgres/  DatabasePool（唯一 pg.Pool，schema 固定）、PostgresContentStore、幂等 migrations、seed
│   └── filesystem/ FilesystemContentStore、Default/Blog 两个 ContentLayout（同 Contract）、原子写、symlink 拒绝、每租户互斥
├── render/        MarkdownStageFactory Contract、7 个 unified/remark/rehype 工厂、JSON 配方、PipelineBuilder、Renderer、RenderInfrastructureEntry
├── auth/          Principal、Authenticator Contract、SessionAuth 与 SignedTokenAuth（测试适配器）、SiteAuth Binding、授权函数
├── site/          Inputs（TenantId/SiteSnapshot/CurrentRequest/BuildOptions/SiteManagerOptions）、SiteContext、RequestHandler、
│                  SiteEnvironmentManager、StaticBuilder、MaintenanceWorker、Entries、域名表、预算评估、HTTP/静态服务
├── app.ts         宿主装配：Runtime → 基础设施 root → App Env，启动预检
└── testing/       故意违规的 fixture（仅测试/演示）
```

## Env 世界

```
InfrastructureEntry (root)      DatabaseConfig 或 ContentRoot+Layout 的 Input
└── AppEntry                    ContentBackend Binding；拥有 Pool/Store、Factory 集合、PipelineBuilder、Renderer、SiteEnvironmentManager、MaintenanceWorker
    ├── SiteEntry (per tenant × configRevision)  TenantId、SiteSnapshot、SiteAuth Binding、AuthOptions；拥有 SiteContext 与 Authenticator
    │   ├── RequestEntry (per request)          CurrentRequest；仅 RequestHandler 为请求本地
    │   └── BuildEntry (per static build)       BuildOptions；StaticBuilder
    └── WorkerEntry (由宿主在 Ready 后启动)
```

"想要两个对象时，先问它们是否只是同一个 Factory 的两个产物"：三份配方、两个租户共享同一组 Factory slot；只有受 Syna 管理的依赖身份（TenantId、SiteSnapshot、CurrentRequest、Binding 选择）不同才分叉。

## 数据模型（H01）

Post：stable `id`、`tenantId`、`slug`、`locale`（`zh-CN`/`en`，普通数据）、Markdown `body`、`status`（published/draft/private）、`categories` 与 `primaryCategory`、`tags`、`revision`、时间戳（fixture 控制）。Category/Tag/SiteConfig（标题、域名、主题参数、导航、三份配方、auth 设置、`configRevision`）。排序、路径安全、locale/状态判断在 `domain/model.ts`，两个后端共用。

## 站点工作集（H10/H11）

`SiteEnvironmentManager` 是普通 Hyla Service（Syna core 无 TenantScope/LRU）：

- key = `runtimeId|tenantId|configRevision|g<generation>`；按需创建；同 key 并发首次获取 single-flight。`invalidate(tenantId)` 递增 generation：即使 `configRevision` 未变，下一次 acquire 也得到全新 Env，旧 Env 在最后一个 lease 释放时立即关闭。
- 创建期间被轮换（配置保存或 invalidate）的 Env 一旦无人持有就关闭，不会以 draining 状态滞留占用容量；等它的 acquirer 重新读取配置加入当前世界，重试以 `acquireTimeoutMs` 为界而不是固定次数。
- 轮换单调：acquire 读到的配置若比该租户某个仍接受 lease 的记录**更旧**（更小的 `configRevision`，或已被 `invalidate()` 推进的 generation），它加入较新的记录，而不是把较新的记录置 draining；只有比读到的配置更旧的记录才轮换。等待容量期间发生了 `invalidate()`、或更新的世界已被别人创建时，等到的名额放回队列并重新读取配置（仍以 `acquireTimeoutMs` 为界）。滞后的副本读或与保存竞争的缓存读因此不会毁掉当前世界，也不会造出一出生就过期的世界。
- 名额交接：等待者被唤醒时名额（reservation）已属于它；一个名额若发现同 key 的记录已由别人创建、或管理器已关闭，立即交给下一位等待者，不会有第三个 acquirer 守着空闲名额等到超时。
- lease 用途：`acquire(tenantId, purpose)` 的 `purpose`（`request` / `build` / `background`）是容量策略。`reservedForRequests` 个名额（默认 `capacity ≥ 2 ? 1 : 0`，取值 `[0, capacity)`，启动时校验）只有请求可以用来**新建** SiteEnv；构建/后台任务随时可以加入已存在的 SiteEnv，但只在空闲名额多于该值时新建，排队时请求先于更早到达的构建/后台等待者。`stats()` 报告 `reservedForRequests` 与 `waitingByPurpose`。
- 请求/构建/后台使用者持 lease；`release()` 幂等，不负计数。
- 容量与空闲 TTL 可配置；只驱逐无活跃 lease 的 Env；不关闭共享 pool。
- 关闭中的 Env（记录状态 `disposing`）在它的 `dispose()` 结算前继续占用一个容量名额：驱逐不会提前腾出名额，等待者在关闭结算后按到达顺序获得容量，所以容量上限是真实的 Env 数量上限。H11 测试在每次 lease 时采样 `runtime.inspect().liveEnvCount`：任何时刻存活的 SiteEnv（含关闭中的）不超过 capacity（`working-set.json` 的 `maxSiteEnvsAlive`）。Env 关闭失败（`dispose()` 拒绝）通过 `onDisposalError(error, { key, tenantId, configRevision })` 报告（默认 `console.error`）并计入 `stats().disposalFailures`，绝不成为 unhandled rejection；记录照样移除。
- 创建在 Env 进入之后失败（Authenticator 形状校验、管理器已关闭等）时，那个 Env 立即关闭而不是泄漏。
- 配置更新：新 acquire 读到新 `configRevision` → 旧 revision 置 draining，不再接受新 lease，在途请求完成后释放并关闭；旧配置不会无限积累。驱逐不是版本失效。
- 全部在用时：有界等待队列（`maxPendingAcquires`、`acquireTimeoutMs`），超出即明确拒绝 `SITE_CAPACITY`，不强关活跃租户。
- 冷创建失败不留 poison promise，按租户有界指数退避；读完配置后再次检查退避，所以同一突发中的其余 acquirer 得到 `SITE_CREATION_BACKOFF`（含 `cause`）而不是各自再试一次。创建时校验 Authenticator 实例形状（`scheme` + `authenticate()`），接口不兼容的 override 在站点创建时失败，而不是在租户的第一个请求。
- 维护 worker（`MaintenanceWorker`）：宿主在 root Ready 后 `start({ intervalMs, domains })`；每个 tick 执行 `sweep()`，给定 `domains` 时还重载域名表（重载失败计入 `refreshFailures`，循环继续）。tick 抛错则循环结束、worker 世界释放、状态为 `failed`、`lastError` 保存原因；随后的 `stop()`（包括 Runtime 释放时的清理）重新抛出该错误，进入 `HylaApp.close()` 的 `errors`；`start()` 可以从 `failed` 重新开始。循环从不产生 unhandled rejection，也不会停在 `running`。
- 关闭：拒绝新 acquire，等待 lease 到 `shutdownTimeoutMs`，报告未释放 lease，然后并发关闭 Env。`HylaApp.close()` 先执行这一关闭，再释放 Runtime，返回 `{ unreleasedLeases, unsettledAttempts, errors }`（管理器关闭本身失败也进入 `errors`；Runtime 嵌套的释放报告被展平成叶子错误；`close()` 幂等，重复调用返回同一份报告）：Runtime 释放的失败（例如某个 setup 无视 stop signal 超过 `disposal.graceMs` 时的 `UNSETTLED_ATTEMPT`）进入 `errors` 而不是抛出，仍在运行的 attempt 列在 `unsettledAttempts`（来自 `runtime.inspect()`）；Runtime 不再保留这些 Env，它们只由各自的 setup Promise 维持。
- Env 被驱逐不丢业务事实：数据、配方、配置版本都在后端。

## 权限边界

- 认证：`Authenticator` Contract，两份本地测试实现（cookie 会话表 / HMAC 签名 token）。它们**不是**生产安全实现。
- 授权：应用函数 `canViewPost(principal, tenantId, post)`；身份属于某租户，跨租户身份视为匿名。
- 缓存：页面缓存键含 tenant、configRevision、**content version**、locale、visibility class、path。每个 SiteEnv 的页面缓存有界（`siteManager.pageCacheMaxEntries`，默认 256，最久未用者先淘汰）；同一 key 的并发渲染只生产一次（single-flight，其余等待者加入），并发的版本读取共用一次后端往返，渲染失败不入缓存；`cacheStats` 报告 `hits/misses/coalesced/entries/evictions/maxEntries`。配方流水线缓存（`PipelineBuilder`）同样有界（`PIPELINE_CACHE_MAX_ENTRIES` = 64，按 (trust, 配方) 为键，键序无关），管理器对同一租户的并发配置读取也只做一次。content version 由后端在每次变更（post/category/tag/配置）时推进（PostgreSQL `content_versions` 表在同一事务内递增；文件系统每租户 `content.version` 文件），每次查缓存都读取一次，而且**先读版本、再读内容**：在两次读取之间落地的编辑不会被缓存到新版本之下（它会被记在旧版本下并在下一次查询时被丢弃）；版本变化即丢弃该站点整个页面缓存，所以编辑与可见性变化不需要保存配置就生效，被撤回内容的摘要不会留在匿名索引页。Syna plan cache 不缓存页面或授权结果。
- 不可信输入：`PipelineBuilder.build(document, { trust })`。`trusted`（文章正文、预览）按配方原样构建；`untrusted`（评论：`/comments/preview`、`SiteContext.renderComment`）在配方之上施加平台策略：`bridge`/`compile` 阶段的 `allowDangerousHtml` 强制为 false，且最后一个 rehype 阶段必须是声明了 `sanitizer` 角色的 Factory，否则由构建器追加平台的 `rehype-sanitize`（`allowLinkTargets: true`，保留链接阶段加上的 `rel`/`target`；`finalPass: true`，作为独立的一遍而不是并入配方里更早的 sanitize）。因此通过 `extraServices` 注册在 sanitize 之后的阶段无法把 `<script>` 或事件处理器带回评论输出；没有任何已接纳的 sanitizer Factory 时，`untrusted` 构建以 `RecipeError` 明确拒绝。
- 站点配置：两个后端在 `saveSiteConfig` 与 `getSiteConfig` 都校验文档（`parseSiteConfig`，JSON schema + `isSafeHref` + `isCssColor` + 域名可归一化 + 租户 id 路径安全）；不合法的保存以 `SiteConfigError`（`INVALID_SITE_CONFIG`，`problems` 列出原因）拒绝且 `configRevision` 不变，带外写入的坏文档在读取时成为该租户的类型化错误而不是渲染出的页面。渲染器另有兜底：不安全的导航 `href` 渲染为 `#`，非颜色的 `theme.accent` 渲染为默认色。格式错误的 cookie（坏的百分号编码）视为匿名而不是 500。
- HTTP 错误：客户端只看到状态码与短短语（503 `Service unavailable (<code>)`、500 `Internal error`、400 `Bad request`），内部错误信息进入 `startHttpServer({ onError })`（默认 `console.error`）；请求目标无法解析（绝对形式的坏 authority、错误百分号编码）→ 400，处理函数的任何异常都被兜底，不会挂起连接或以 unhandled rejection 终止进程。
- 域名：受控域名表 host → tenantId；未知 host 先触发一次域名表重载（single-flight，每 `domainRefreshMinIntervalMs`（默认 1000 ms）至多一次，并发的未知 host 共用一次；重载失败沿用旧表并报告给 `onError`），再次解析仍未知才 404，不访问任何租户数据，所以启动后保存的租户无需重启即可访问，而未知 host 的洪流每个间隔只花一次扫描；`serve` 的 worker 每个 tick 也重载域名表。只有 `trustProxy` 时才信任 `X-Forwarded-Host`。归一化：trim、小写、去掉一个端口和一个结尾的点、IDNA（`url.domainToASCII`），所以 `BÜCHER.example.` 与 `xn--bcher-kva.example` 是同一声明。`saveSiteConfig` 拒绝声明其他租户已拥有的域名（`DomainConflictError`，归一后比较）；带外编辑造成的冲突 host 不分配给任何租户（`DomainTable.conflicts` 列出），其余租户不受影响，`serve` 启动时告警。
- 静态输出：只写匿名可见内容与公开元数据，不含凭据/内部引用（矩阵测试逐文件扫描）。输出目录必须为空或是上一次构建：构建器只删除上次清单（`.hyla-build.json`）中列出的文件及由此变空的目录，从不触碰其他文件；有陌生内容且无清单的目录被拒绝。发布是有序的而不是事务性的（H03：逐文件原子替换，不宣称多文件 ACID）：整站先在内存中从同一个内容版本渲染完成（前后两次读取 `contentVersion` 一致，否则重渲染，最多 `BUILD_SNAPSHOT_ATTEMPTS` 次后以 `BUILD_CONTENT_CHANGED` 拒绝且不写任何文件），然后逐文件原子替换新内容，再删除上次清单中不再存在的文件，最后写清单（含 `contentVersion`）；写入阶段之前失败的构建让上一次构建原样保留。同一目录同时只有一个构建：进程内按解析后的目录互斥，进程间靠 `.hyla-build.lock`（`{ pid, startedAt }`；持有者进程已消失或超过 `BUILD_LOCK_STALE_MS` 的锁被接管，否则 `BUILD_LOCKED`）。输出目录本身不得是符号链接，其下任何路径也不得是或穿过符号链接：将要写入或删除的每个路径在第一次写之前都经过逐段 `lstat` 检查，发现链接即以 `UNSAFE_OUTPUT_DIR` 拒绝且不动任何文件。静态服务器启动时解析根目录的真实路径，请求路径下不跟随任何符号链接（404），读取的文件必须仍在根目录之内；点文件不发布。
- 启动：`createHylaApp()` 预检三个形状：渲染基础设施、站点、以及一次请求（在管理器之外进入一个合成的 `preflight` 站点世界，按 `REQUEST_BUDGET` 解释一次请求后释放；`preflight` 数组的第三项），任何一个越界都拒绝部署（`PreflightError`）；`preflightRequests()` 再按每个已配置租户各自的配方与认证器重复请求检查。预检后实际加载内容后端（打开 PostgreSQL 连接池并探测 `search_path`）并创建站点管理器，数据库不可达、schema 非法或 `siteManager` 设置非法在启动时失败并释放 Runtime，而不是在第一个请求。

## 运行

```sh
npm install && npm run build
# 四格演示（文件系统后端）
node apps/hyla-mini/bin/hyla-mini.mjs demo --root /tmp/hyla-content
# PostgreSQL 后端（临时集群）
node scripts/pg-test-cluster.mjs with -- node apps/hyla-mini/bin/hyla-mini.mjs demo --backend postgres
# 开发服务器
node apps/hyla-mini/bin/hyla-mini.mjs serve --root /tmp/hyla-content --port 8080
curl -H 'Host: alpha.test' http://127.0.0.1:8080/posts/shared-slug
```

## 明确非目标

完整后台、完整 UI i18n、MongoDB、通用 ORM、插件市场、线上部署、生产级 auth、跨进程锁、多文件 ACID（文件系统后端只有单文件原子替换 + 进程内每租户串行）。
