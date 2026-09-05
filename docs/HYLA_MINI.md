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

- key = `runtimeId|tenantId|configRevision`；按需创建；同 key 并发首次获取 single-flight。
- 请求/构建/后台使用者持 lease；`release()` 幂等，不负计数。
- 容量与空闲 TTL 可配置；只驱逐无活跃 lease 的 Env；不关闭共享 pool。
- 配置更新：新 acquire 读到新 `configRevision` → 旧 revision 置 draining，不再接受新 lease，在途请求完成后释放并关闭；旧配置不会无限积累。驱逐不是版本失效。
- 全部在用时：有界等待队列（`maxPendingAcquires`、`acquireTimeoutMs`），超出即明确拒绝 `SITE_CAPACITY`，不强关活跃租户。
- 冷创建失败不留 poison promise，按租户有界指数退避。
- 关闭：拒绝新 acquire，等待 lease 到 `shutdownTimeoutMs`，报告未释放 lease，然后关闭 Env。
- Env 被驱逐不丢业务事实：数据、配方、配置版本都在后端。

## 权限边界

- 认证：`Authenticator` Contract，两份本地测试实现（cookie 会话表 / HMAC 签名 token）。它们**不是**生产安全实现。
- 授权：应用函数 `canViewPost(principal, tenantId, post)`；身份属于某租户，跨租户身份视为匿名。
- 缓存：页面缓存键含 tenant、configRevision、locale、visibility class、path；Syna plan cache 不缓存页面或授权结果。
- 域名：受控域名表 host → tenantId；未知 host 直接 404，不访问任何租户数据；只有 `trustProxy` 时才信任 `X-Forwarded-Host`。
- 静态输出：只写匿名可见内容与公开元数据，不含凭据/内部引用（矩阵测试逐文件扫描）。

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
