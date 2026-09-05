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
- 请求/构建/后台使用者持 lease；`release()` 幂等，不负计数。
- 容量与空闲 TTL 可配置；只驱逐无活跃 lease 的 Env；不关闭共享 pool。
- 关闭中的 Env（记录状态 `disposing`）在它的 `dispose()` 结算前继续占用一个容量名额：驱逐不会提前腾出名额，等待者在关闭结算后按到达顺序获得容量，所以容量上限是真实的 Env 数量上限。Env 关闭失败（`dispose()` 拒绝）通过 `onDisposalError(error, { key, tenantId, configRevision })` 报告（默认 `console.error`）并计入 `stats().disposalFailures`，绝不成为 unhandled rejection；记录照样移除。
- 创建在 Env 进入之后失败（Authenticator 形状校验、管理器已关闭等）时，那个 Env 立即关闭而不是泄漏。
- 配置更新：新 acquire 读到新 `configRevision` → 旧 revision 置 draining，不再接受新 lease，在途请求完成后释放并关闭；旧配置不会无限积累。驱逐不是版本失效。
- 全部在用时：有界等待队列（`maxPendingAcquires`、`acquireTimeoutMs`），超出即明确拒绝 `SITE_CAPACITY`，不强关活跃租户。
- 冷创建失败不留 poison promise，按租户有界指数退避；读完配置后再次检查退避，所以同一突发中的其余 acquirer 得到 `SITE_CREATION_BACKOFF`（含 `cause`）而不是各自再试一次。创建时校验 Authenticator 实例形状（`scheme` + `authenticate()`），接口不兼容的 override 在站点创建时失败，而不是在租户的第一个请求。
- 关闭：拒绝新 acquire，等待 lease 到 `shutdownTimeoutMs`，报告未释放 lease，然后并发关闭 Env。`HylaApp.close()` 先执行这一关闭，再释放 Runtime，返回 `{ unreleasedLeases, unsettledAttempts, errors }`：Runtime 释放的失败（例如某个 setup 无视 stop signal 超过 `disposal.graceMs` 时的 `UNSETTLED_ATTEMPT`）进入 `errors` 而不是抛出，仍在运行的 attempt 列在 `unsettledAttempts`（来自 `runtime.inspect()`）；Runtime 不再保留这些 Env，它们只由各自的 setup Promise 维持。
- Env 被驱逐不丢业务事实：数据、配方、配置版本都在后端。

## 权限边界

- 认证：`Authenticator` Contract，两份本地测试实现（cookie 会话表 / HMAC 签名 token）。它们**不是**生产安全实现。
- 授权：应用函数 `canViewPost(principal, tenantId, post)`；身份属于某租户，跨租户身份视为匿名。
- 缓存：页面缓存键含 tenant、configRevision、**content version**、locale、visibility class、path。content version 由后端在每次变更（post/category/tag/配置）时推进（PostgreSQL `content_versions` 表在同一事务内递增；文件系统每租户 `content.version` 文件），每次查缓存都读取一次，而且**先读版本、再读内容**：在两次读取之间落地的编辑不会被缓存到新版本之下（它会被记在旧版本下并在下一次查询时被丢弃）；版本变化即丢弃该站点整个页面缓存，所以编辑与可见性变化不需要保存配置就生效，被撤回内容的摘要不会留在匿名索引页。Syna plan cache 不缓存页面或授权结果。
- HTTP 错误：客户端只看到状态码与短短语（503 `Service unavailable (<code>)`、500 `Internal error`、400 `Bad request`），内部错误信息进入 `startHttpServer({ onError })`（默认 `console.error`）；请求目标无法解析（绝对形式的坏 authority、错误百分号编码）→ 400，处理函数的任何异常都被兜底，不会挂起连接或以 unhandled rejection 终止进程。
- 域名：受控域名表 host → tenantId；未知 host 直接 404，不访问任何租户数据；只有 `trustProxy` 时才信任 `X-Forwarded-Host`。`saveSiteConfig` 拒绝声明其他租户已拥有的域名（`DomainConflictError`，大小写/端口归一后比较）；带外编辑造成的冲突 host 不分配给任何租户（`DomainTable.conflicts` 列出），其余租户不受影响，`serve` 启动时告警。
- 静态输出：只写匿名可见内容与公开元数据，不含凭据/内部引用（矩阵测试逐文件扫描）。输出目录必须为空或是上一次构建：构建器只删除上次清单（`.hyla-build.json`）中列出的文件及由此变空的目录，从不触碰其他文件；有陌生内容且无清单的目录被拒绝。静态服务器不发布点文件。
- 启动：`createHylaApp()` 在预检后实际加载内容后端（打开 PostgreSQL 连接池并探测 `search_path`），数据库不可达或 schema 非法在启动时失败并释放 Runtime，而不是在第一个请求。

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
