# Syna v0.6 API 收束：实施任务书

> 这是要求你实际修改代码、运行测试、更新文档并交付证据的任务，不是请你继续讨论设计。
> 本轮**只改名字、删重复、合并类型、强化类型**。**任何语义变化都不属于本轮**，包括看起来顺手的那些。
> 做完本轮，公共 API 进入冻结期，并附带弃用政策。这是第一个外部用户出现之前最后一次便宜的改名机会，也是最后一次。

## 0. 任务、权限与完成含义

你是本项目的实施负责人。对象是当前工作区的 Syna v0.5 仓库（`packages/core`、`apps/hyla-mini`、`apps/*-demo`、`docs`、`benchmarks`、`scripts`）。目标版本号为 `0.6.0`。

你必须交付：

- 按第 3 节清单完成的源码改动；
- 每个改名对应的弃用别名、迁移测试与类型测试；
- 全部迁移到新名字的 Hyla-mini 与 demos（应用是语料，不允许靠别名过）；
- 更新后的 `docs/API_REFERENCE.md`、`docs/SEMANTIC_MODEL.md`（仅措辞）、`docs/PACKAGE_AUTHORING.md`、`docs/PLUGIN_AUTHORING.md`、`docs/HYLA_MINI.md`、双语 README；
- 新增 `docs/MIGRATION_V05_TO_V06.md`（逐项对照表）、`docs/API_STABILITY.md`（冻结范围与弃用政策）、`docs/DEFERRED.md`（本轮明确拒绝的语义改动）；
- `CHANGELOG.md` 条目；
- 沿用现有 release gate（`scripts/verify-*.mjs --release` 或等价流程）从最终归档重新解包、安装、编译、运行全部必跑测试后得到的真实摘要。

授权范围与上一轮相同：本地开发、隔离测试、本地归档。不发布 npm 包、不 force push、不修改用户全局设置、不执行破坏性 git 操作、不读取无关密钥。保留用户未提交改动。

完成不是"改了名字测试全绿"，而是：**清单里的每一项都有对应的代码、别名、测试与文档，清单外的任何名字与任何语义都没有动。**

## 1. 事实来源与冲突处理

优先级：用户之后的明确指令 > 本任务书 > 仓库现有 `docs/SEMANTIC_MODEL.md` 与 `docs/SEMANTIC_CHANGES_V05.md` > 现有代码与测试。

**本任务书第 3 节是唯一的改名清单。**不在清单里的名字，一律不改；觉得应该改的，写进 `docs/DEFERRED.md` 的"命名"小节，不做。

遇到"改这个名字顺便把这个行为也修一下"的冲动——例如把 `setupDeadlineMs` 默认值改为 `Infinity`、把 `env.state` 与 GC 解耦、给 `provides` 加默认实现标记、放松 `C.all` 的共存要求——**一律不做**，记入 `docs/DEFERRED.md` 的"语义"小节，附一句为什么它属于下一轮。

如果某个改名在实施中暴露出它实际会改变行为（例如把调用期 `scope` 移出参数记录时发现有测试依赖 `args.scope` 与同名 Input 的碰撞行为），停下来：保持旧行为，在迁移表里记录该发现，不要借机"修正"。

## 2. 判定规则与语料

本轮的每一个改名都必须满足下面三条理由之一，并在迁移表里写出是哪一条：

1. **与 Syna 自家词汇冲突**——同一个词根在库内指两个不相关的概念；
2. **与整个行业的既定含义冲突**——DI/IoC 领域对该词有稳定共识，Syna 用法相反；
3. **同一个概念有多个名字**——两个导出或两个字段指同一物。

"另一个词更好听"不是理由。清单之外若发现满足上述理由的名字，同样只记入 DEFERRED，不在本轮动。

判定依据的语料是 Hyla-mini 对内核的实际调用频率（`.load()` 25 次、`.read()` 11 次、`.enter()` 6 次、`.explain()` 4 次、`.run()` 2 次、`.check()` 1 次、`loadAll` 0 次）。高频路径的名字一个都不在改名清单里，这是有意的。

## 3. 本轮范围已经裁定

### 3.1 改名（六组）

| # | 旧 | 新 | 理由 | 波及 |
|---|---|---|---|---|
| R1 | Entry 定义中的 `scope: { fresh, share }`；调用期混在参数记录里的 `scope` | `reuse: { fresh, share }`；调用期通过独立 `options` 传入 | 理由 2：Spring、Inversify、Nest、Autofac 全部用 scope 指生命周期；另外 `args.scope` 会与同名 Input 参数碰撞 | `EntryDefinition.scope`、`EntryDescriptor.scope`、`DeriveOptions` → `ReuseConstraints`、`ScopeTarget` → `ReuseTarget`、`env.derive(options)`、`EntryParameters` 类型中去掉 `& { scope? }`、错误信息文案、explain 的 `ForkCause.kind: 'fresh'` 保持不变 |
| R2 | `env.bind(entry)`、`BoundEntry` | `env.anchor(entry)`、`AnchoredEntry` | 理由 1：`bind`/`Binding` 在库内是两个无关概念共用词根 | `EnvHandle.bind`、`BoundEntry` 类型、`DependencyOutput` 对 Entry 依赖的映射、错误码 `OWNER_NOT_READY` 文案、SEMANTIC_MODEL §10 措辞（"anchored at the owner Env" 已是现有文档用语，保持） |
| R3 | `SynaRuntime` | `Runtime` | 理由 3 的变体：全库唯一带品牌前缀的类型，与 `EnvHandle`、`Contract` 等不一致；前缀只保留给 `SynaError` | 类型导出、`createRuntime` 返回类型、docs |
| R4 | `DependencyRef<T>`（含 `load`） | `ServiceRef<T>`；`DependencyRef<T>` 改为 `ServiceRef<T> \| InputRef<T>` 的联合别名 | 理由 3：与已存在的 `InputRef` 不对称；RFC 与文档已使用 `ServiceRef` | `loadAll` 的约束改为 `ServiceRef`、`DependencyRefFor`/`DependencyRefs` 映射类型、`LoadedDependencies` |
| R5 | `PersistentImplementationRef`、其字段 `implementationId`、`ImplementationDescriptor.persistentRef` | `ImplementationRef`、`familyId`、`ref` | 理由 3：函数已叫 `parseImplementationRef`，类型却叫 Persistent…；`CandidateRef.familyId`、`ImplementationDescriptor.familyId` 与 `implementationId` 指同一物 | JSON 持久化格式的 **key** 也随之改为 `familyId`，`parse` 必须同时接受旧 key `implementationId` 并在迁移表说明；Hyla-mini 的 `StoredImplementationRef` 与配方 fixtures 同步 |
| R6 | `RuntimePolicyContext.site` | `dependencySite` | 内部术语 "choice site" 漏进公开 policy API | `RuntimePolicy.orderAutoCandidates/orderVersionCandidates` 的 context 参数、docs |

R1 的调用期形态由你决定具体重载方式，但必须满足：`enter/check/explain(entry, args?, options?)`，`run` 的 callback 永远是最后一个参数，`options.reuse` 是唯一的调用期约束入口，参数记录里不再允许出现 `scope` 或 `reuse` 键。

### 3.2 删除（四组）

| # | 删除 | 说明 |
|---|---|---|
| D1 | `DependencyRef.preload()` | v0.5 已标 deprecated；替代写法 `ref.load().then(…, report)` 写进 MIGRATION |
| D2 | `InputRef.load()` | v0.5 已标 deprecated；替代 `read()` |
| D3 | `Contract.selector`、`ImplementationSelector`、`ImplementationLease`、`ImplementationSelectorDependency` 及其专属错误路径 | v0.4 遗留的候选子世界语义，文档已标 legacy，Hyla-mini 零使用。相关测试若断言的是 `C.all` 也能覆盖的行为，迁移到 `C.all`；若只断言子世界行为，删除并在迁移表逐项列出 |
| D4 | 自由函数 `serviceRange(family, range)` | 由 `ServiceRevision.range()` 与新增的 `ServiceFamily.range()` 覆盖；若 `ServiceFamily.range()` 尚不存在则补上（这是把已有能力挂到已有对象上，不是新语义） |

删除项**不设别名**：D1、D2 在 0.5 已经弃用一个版本，D3、D4 是 legacy/重复入口。

### 3.3 合并（三组）

| # | 合并 | 目标 |
|---|---|---|
| M1 | `createRuntime` 的 `planCache: { maxEntries }`、`initialization: { deadlineMs }`、`disposal: { graceMs }`、`planning: { searchBudget }` | 平铺为 `limits: { setupDeadlineMs, disposalGraceMs, planningBudget, planCacheEntries }`。`services`、`overrides`、`policy`、`diagnostics` 不动。默认值**逐字保留**（30_000 / 2_000 / 10_000 / 512） |
| M2 | `EntryParameter`、`EntryParameterMap`、`EntryParameterValue`、`EntryParameterValues`、`EntryParameters`、`EntryArguments`、`EntryRunArguments` | 只保留两个公开名：`EntryParameters`（Entry 声明的参数映射类型）与 `EntryArguments`（调用时的取值类型）。其余若内部仍需要则转为不导出的辅助类型。同时 `DependencyOutput` 与 `LoadedDependencies` 保留一个；停止导出 `NormalizedServiceFailurePolicy`、`SetupResult` |
| M3 | 错误码 `CONSTRAINT_VIOLATION` 与 `SHARE_CONSTRAINT_FAILED` | 统一为 `FRESH_CONSTRAINT_FAILED` 与 `SHARE_CONSTRAINT_FAILED`；`UNKNOWN_ERROR` 从 `SynaErrorCode` 联合移出，仅保留在 `DiagnosticCode` |

### 3.4 类型强化（两项）

| # | 项 | 要求 |
|---|---|---|
| T1 | `SynaError` | 按 `code` 判别的联合类型：每个错误码有自己的 `details` 类型；`isSynaError(error, code)` 收窄。`docs/API_REFERENCE.md` 为每个码写出 `details` 字段表。现有 `details` 内容不增不减，只加类型 |
| T2 | 幽灵类型字段 `__api`、`__value`、`__publicApi`、`__contract` | 统一为一个约定与一个名字（由你选定，例如 `__type`），`kind` 判别字段保证不产生结构混淆。不导出该字段的文档 |

### 3.5 刻意保留（不要碰）

以下名字每一个都被考虑过并决定保留。不要改，不要加别名，不要在文档里暗示它们将来会改：

`definePackage`、`define.service/contract/input/binding/entry`、`requires`、`provides`、`parameters`、`eager`、`uniqueWithin: 'lineage'`、`failure: { attempts, delayMs, afterExhaustion, cooldownMs }`、`setupDeadlineMs`（作为 Service 选项名）、`metadata`/`revisionMetadata`、`setup(deps, { signal, onDispose })`、`auto()`、`forward()`、`override()`、`Service.range()`、`Contract.all`、`ImplementationSet` 及其 `candidates/resolve/load`、`CandidateRef`、`Binding` 与 `Binding.to()/parse()`、`Input`/`InputRef.read()`、`load()`、`loadAll()`、`Entry`、`EnvHandle`、`EnvState`、`env.deps`、`enter/run/check/explain/derive/inspect/dispose`、`catalog.implementations/resolve/revisions`、`defaultRuntimePolicy`、`ExplainedNode.disposition` 与全部 `ForkCause.kind`、全部 `RuntimeEvent.type`、其余 21 个错误码。

### 3.6 明确不做（写入 DEFERRED.md，不实现）

- `setupDeadlineMs` 的默认值或"迟到成功是否被接纳"的行为；
- `env.state` 与 GC 的关系、`unsettledAttempts` 账本语义；
- `provides: [primary(C)]` 一类的默认实现声明（Spring `@Primary` 的对应物）；
- `C.all` 共存要求的任何放松；
- 任何新的依赖形式、新的 Entry 能力、新的 Runtime 选项。

## 4. 执行方式：先盘点，后动刀，阶段闭环

### Phase A：盘点与 README-first

1. 用脚本从 `packages/core/src/index.ts` 与 `descriptors.ts` 生成**当前**公开 API 清单（每个导出、每个公开接口的成员、每个错误码），存为 `work/v06/API_INVENTORY_BEFORE.md`。脚本进入仓库，后续复用。
2. 对照第 3 节生成 `work/v06/RENAME_PLAN.md`：每一项列出触及的文件、测试、文档；每一项标注它满足第 2 节的哪条理由。
3. **先写 README 首页示例**（定义一个包与 Service、一个 Entry 与进入世界、宿主装配与 `explain`），用新名字。示例必须能原样编译运行，并在 Phase F 作为测试执行。**示例中不允许出现解释性注释**——如果某处需要注释才能读懂，记录下来，这是 API 的问题，不是注释的问题。
4. 在这里停一下，把 A1–A3 的产出汇总。若用户使用 `/plan` 模式，Phase A 就是计划审阅点。

### Phase B：改名，一项一个 commit

每个 R 项一个 commit，commit 内同时包含：新名实现；旧名的弃用别名（类型上 `@deprecated` JSDoc 指向新名，运行时行为等价）；一个迁移测试断言旧名与新名行为完全等价；类型测试断言旧名仍可编译并带弃用标记；对应文档更新。

别名的运行时形态由你决定，但不得引入第三个名字，不得改变任何行为，不得让别名路径比新名路径少检查任何东西。

### Phase C：删除与合并

D1–D4 直接删除并更新受影响测试；M1–M3 各一个 commit；T1、T2 各一个 commit。M1 的默认值用测试逐字锁定。M3 的错误码改动要更新 Hyla-mini 中所有对错误码的判断（grep `CONSTRAINT_VIOLATION`）。

### Phase D：迁移语料

把 `apps/hyla-mini`、`apps/*-demo`、`packages/hyla*`、`packages/fluida*`、`benchmarks`、`scripts` 全部迁移到新名字。加一个测试：对上述目录 grep 旧名（别名列表中的每一个），命中即失败。文档同步：API_REFERENCE 全文按新名重写相关段落；SEMANTIC_MODEL 只改措辞不改规则；PACKAGE_AUTHORING、PLUGIN_AUTHORING、HYLA_MINI、README 双语示例全部使用新名。

### Phase E：冻结声明

写 `docs/API_STABILITY.md`：

- 冻结范围：第 3.5 节全部名字加本轮新名；
- 弃用政策：被弃用的名字保留**一个 minor 版本**（0.6.x 全程可用），在 0.7.0 删除；每个别名在文档中标注删除版本；
- 命名守则（供以后新增 API 时遵守）：描述符是名词；动词的代价从名字可见——`load` 可能触发 setup，`read` 永不，`enter` 创建世界，`check` 永不创建；调用面上不出现内部术语（slot、realm、lineage anchor 的内部含义、materialize），`anchor` 作为公开概念（AnchoredEntry 的锚点 Env）是明确例外；同一概念只有一个名字；罕见选项可以啰嗦，高频路径必须最短。

写 `docs/MIGRATION_V05_TO_V06.md`：逐项表（旧 → 新 → 理由编号 → 别名到期版本 → 涉及的持久化格式变化）。R5 的 JSON key 变化单独一节，给出 `parse` 兼容旧 key 的保证与到期版本。

写 `docs/DEFERRED.md`，更新 `CHANGELOG.md`。

### Phase F：验证与交付

- 全部核心测试、类型测试、Hyla-mini 应用测试、scripts 测试通过；PostgreSQL 矩阵按现有流程运行，不可跳过；
- reference planner 差分测试通过（证明零语义变化）；
- `check()`/`explain()`/`inspect()` 输出的快照测试：除本轮改名字段外与 v0.5 逐字一致；
- benchmark 与 v0.5 同机对比，p50/p95 变化在 ±10% 内，缓存命中/条目数不变；
- `any` 计数不高于 v0.5 基线（分文件记录）；
- README 首页示例作为测试原样运行；
- release gate 从最终归档重新解包、安装、编译、运行必跑项，输出真实摘要与归档哈希。

## 5. 验收项

| # | 验收 | 依据 |
|---|---|---|
| A01 | `work/v06/API_INVENTORY_BEFORE.md` 与 `API_INVENTORY_AFTER.md` 存在；AFTER 中不出现任何 D 项名字；R 项旧名只以别名身份出现并标注到期版本 | 生成脚本可重跑 |
| A02 | 六个 R 项每个都有：新名实现、旧名别名、迁移等价测试、类型测试、文档更新，且在同一个 commit | git log 逐项对应 |
| A03 | 零语义变化：原有行为测试仅做名称映射后全部通过；reference planner 差分通过；explain/inspect 快照除改名字段外一致 | 测试 |
| A04 | 应用与 demos 不含任何旧名 | grep 断言测试 |
| A05 | README 首页三段示例可编译运行且无解释性注释 | 测试 |
| A06 | `API_STABILITY.md`、`MIGRATION_V05_TO_V06.md`、`DEFERRED.md`、`CHANGELOG.md` 齐备；迁移表每项有理由编号 | 文档 |
| A07 | `SynaError` 为判别联合且每个码有 `details` 类型表；Entry 参数类型只剩两个公开名；不再导出规范化内部类型；幽灵字段单一 | 类型测试 + 清单 |
| A08 | M1 默认值逐字不变；M3 后 Hyla-mini 无旧错误码 | 测试 |
| A09 | benchmark ±10%、缓存计数不变、`any` 不增 | benchmark JSON + 计数脚本 |
| A10 | release gate 从归档重建通过，摘要含哈希与逐命令结果 | gate 输出 |

## 6. 禁止事项

- 不改清单外的任何名字，不为清单外的名字加别名；
- 不改任何语义，包括默认值、错误触发条件、explain 内容、缓存行为；
- 不删除有效反例测试来换全绿；被撤回的只能是纯粹断言旧名或 D3 子世界行为的测试，且逐项列入迁移表；
- 不以别名代替应用迁移；
- 不在旧名与新名之间制造第三个名字；
- 不修改本任务书的验收项；
- 不把"已完成"的文字当证据：最后输出 gate 的真实摘要、归档路径与哈希、前后 API 清单的 diff 统计。

若因外部条件（PostgreSQL 不可用、依赖安装失败等）确实无法完成某项验证，完成其余部分，记录 `work/v06/STATE.md` 与精确复现命令，报告 BLOCKED 并暂停。BLOCKED 不是成功；任务大或测试红不构成 BLOCKED。
