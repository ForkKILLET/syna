# 从 v0.5 迁移到 v0.6（MIGRATION_V05_TO_V06）

v0.6 只收束 API 的名字与类型。语义——默认值、错误触发条件、`explain` 内容、计划缓存行为、`C.all` 的共存要求、deadline、GC 相关状态、默认实现——与 v0.5 逐字相同：`packages/core/tests/v06-snapshots.test.mjs` 把 0.5.0 记录的 check/explain/inspect/catalog/错误快照与 0.6 逐项比对，唯一允许的差异是本文列出的改名；`packages/core/tests/reference-planner.test.mjs` 的参考 planner 差分同样通过。想改语义的地方记录在 `docs/DEFERRED.md`。

理由编号（`docs/API_STABILITY.md` 命名守则）：

- **(1)** 与 Syna 自身词汇冲突
- **(2)** 与业界含义冲突
- **(3)** 一个概念多个名字

弃用政策：每个旧名在 0.6.x 全程可用、行为与检查不少于新名（同一对象或转发别名），类型声明标 `@deprecated` 并指向新名；0.7.0 删除。`scripts/tests/deprecations.test.mjs` 逐项核对弃用清单，`docs/API_REFERENCE.md` 末尾的表列出全部别名。

## 改名（旧名保留为弃用别名，0.7.0 删除）

| # | v0.5 | v0.6 | 理由 | 别名到期 | 持久化变化 |
|---|---|---|---|---|---|
| R1 | Entry 定义与调用参数记录里的 `scope: { fresh, share }`；`DeriveOptions`；`ScopeTarget`；`descriptor.scope` | 定义用 `reuse: { fresh, share }`；调用期约束是独立的第三个参数 `options.reuse`（`enter/check/explain(entry, args?, options?)`，`run(entry, args?, options?, callback)` 的回调永远最后）；`ReuseConstraints`、`ReuseTarget`、`EntryOptions`；`descriptor.reuse`（`descriptor.scope` 为不可枚举别名） | (2) `scope` 在业界指生命周期作用域；参数记录里的 `scope` 键还与名为 `scope` 的 Input 冲突 | 0.7.0 | 无（`reuse` 与 `scope` 都是保留的参数名） |
| R2 | `env.bind(entry)`、`BoundEntry` | `env.anchor(entry)`、`AnchoredEntry`（`bind` 转发到 `anchor`） | (1) `bind` 与 `Binding` 同词根 | 0.7.0 | 无 |
| R3 | `SynaRuntime` | `Runtime`（`SynaError` 是唯一保留品牌前缀的类型） | (3) | 0.7.0 | 无 |
| R4 | `DependencyRef<T>`（可 `load()` 的 ref） | `ServiceRef<T>`；0.6 里 `DependencyRef<T>` 的含义变为 `ServiceRef<T> \| InputRef<T>`，用 `'load' in ref` 收窄或直接标注 `ServiceRef` | (3) 一个概念（可加载的 Service 类 ref）两个名字 | 0.7.0 | 无 |
| R5 | `PersistentImplementationRef`；字段 `implementationId` | `ImplementationRef`；字段 `familyId`。`ImplementationDescriptor.persistentRef` **不改名**：`ImplementationCandidate.ref` 已是 `CandidateRef`，再叫 `ref` 会让同一词指两种对象（实施中发现，记录为 F1） | (3) 持久化偏好就是实现引用，存的键就是 Family id | 0.7.0（`implementationId` 在运行时产生的 ref 上是不可枚举 getter） | **是**，见下一节 |
| R6 | `RuntimePolicyContext.site` | `dependencySite`（`site` 为同值的原型 getter） | (1) `site` 在 explain 与错误详情里指选择位点 | 0.7.0 | 无（错误详情的 `site` 键不变） |

## 持久化 key：`implementationId` → `familyId`（R5）

- `Binding.to()` 与 `catalog.implementations()[i].persistentRef` 产生的 JSON 在 0.6 写 `{ kind: 'persistent-implementation-ref', contractId, familyId, version }`；`implementationId` 不再序列化。
- 解析兼容保证：`Binding.parse()`、`catalog.resolve()`、`set.resolve()`、`set.load(ref)` 在 0.6.x 全程接受 `implementationId`；同时给出两键时必须相等，两键都缺则 `INVALID_DESCRIPTOR`。0.7.0 起只接受 `familyId`。
- Hyla-mini：`StoredImplementationRef.familyId`；0.5 写入的配方与站点配置（`implementationId`）在读取边界（`parseRecipeDocument`、`parseSiteConfig`）规范化为 0.6 形状并在下次保存时以 `familyId` 写回；内容根无需重写（`apps/hyla-mini/tests/v06-compat.test.mjs`）。

## 删除（无别名）

| # | 删除 | 替代 | 改写的测试 | 删除的测试 |
|---|---|---|---|---|
| D1 | `ServiceRef.preload()` | `void ref.load().catch(() => undefined)`：0.5 起 `preload()` 的实现就是这一行（M-06），删除后没有第二种"后台启动"形式 | v04-corrections、v04-regressions、v05-audit-lifecycle、v05-review-lifecycle（子进程脚本）、v04-finalization 里的 `preload()` 改为未 await 的 `load()`；这些测试覆盖的是后台启动、粘性失败与"不制造假 setup 环"的行为，保持不变 | 无 |
| D3 | `Contract.selector`、`ImplementationSelector`（`open()`/`run()`）、`ImplementationLease`、`ImplementationSelectorDependency`、inspect 节点类型 `'selector'`、只有 selector 才会触发的错误码 `UNAVAILABLE_IMPLEMENTATION` | `C.all`（`ImplementationSet`：`candidates`/`resolve(ref)`/`load(candidate \| ref)`），或者每个候选一个显式 Entry。`ImplementationCandidate.availability` 字段保留（清单外的名字），在 0.6 里永远是 `{ status: 'available' }`（见 `docs/DEFERRED.md`） | contracts（CandidateRef 只在自己的集合有效；私有实现不泄漏到候选）、hardening（policy 异常原样传播；持久化 ref 按 Runtime 版本策略解析——改为 `C.all` 后同族的两个修订都在同一 Env 中活动，`resolve('^1.0.0')` 取最高满足版本 1.9.0，selector 版本里只有 Provider12 活动才偏向 1.2.0）、v04-corrections（计划模板复用与缓存有界；异步 dispose 只剩 Runtime 与 Env）、v04-regressions（请求 Env 的计划复用有界；override 的身份保持只剩 exact/Contract/all/reuse）、v05-audit3 F-CL3-01（两个 Runtime 共享 Contract 对象互不污染）；`packages/hyla` 的 `ProviderPanel`、`apps/hyla-demo`、`benchmarks/v0.4-planning.mjs` 改为 `C.all` | contracts "selector candidate changes propagate through its canonical synthetic slot"（selector 节点按 owner 锚定的合成槽行为，`C.all` 没有对应物）；hardening "a selector freezes candidates but plans each candidate as an independent child world"（候选预检、`availability: unavailable`、`open()`、`UNAVAILABLE_IMPLEMENTATION`，全部随 selector 消失）；v04-regressions "selector.open during the anchor Env activation is refused with OWNER_NOT_READY"（同一边界由 v04-corrections "a parent setup that opens a worker world of its activating owner fails with OWNER_NOT_READY" 与 hardening "an owner-bound Entry entered during owner activation rejects with OWNER_NOT_READY" 覆盖） |
| D2 | `InputRef.load()` | `ref.read()`：同步，原载荷按身份返回 | contracts、core、hardening（2 处）、v04-adversarial（2 处）、v04-finalization、v04-regressions 里对 Input ref 的 `load()` 改为 `read()`；`apps/minimal-demo` | v05-promises R05 中"旧形式 await thenable 载荷"的断言：该行为随 `load()` 一起消失，`read()` 的身份保持断言保留 |
