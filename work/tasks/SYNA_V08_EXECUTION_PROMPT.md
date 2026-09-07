# Syna v0.8 最终命名收束：实施任务书

> 这是 1.0 之前**最后一次**改名。做完本轮，`docs/API_STABILITY.md` 的"候选面"变成"冻结面"，此后任何公开名字的变化都要等 2.0。
> 本轮与 v0.6 同类：**只改名字、不改语义。**任何行为差异都是缺陷。
> 与 v0.6 不同的一点：本轮**不设别名、不保留任何旧数据键**，改用 codemod 迁移（§2.0，已由用户裁定）。0.x 不承诺 API 稳定，包也尚未发布，仓库外没有任何依赖它的代码或数据。

## 0. 任务、权限与完成含义

对象：当前工作区的 Syna 0.7.0 仓库。目标版本 `0.8.0`。

交付：源码改动；`scripts/codemod-v08.mjs`（对 TypeScript 源码做本轮全部改名的机械迁移，Hyla-mini、demos、benchmarks 必须由它迁移而不是手改）；`docs/MIGRATION_V07_TO_V08.md`（逐项表）；`docs/API_STABILITY.md`（冻结声明）；`docs/SEMANTIC_MODEL.md` 与 `docs/API_REFERENCE.md` 等全部文档的措辞同步；`scripts/api-inventory.mjs` 的一处工具修正（§2.6）；gate 从最终归档重建后的真实摘要。

授权范围同前：本地开发与测试，不发布，不 force push，不打 tag（tag 由用户在确认后手工打），不动全局设置。

完成不是"全绿"，而是：**§2 表里的每一项都改到位，表外的任何名字与任何语义没有动，前后 API 清单的 diff 与 §2 的表逐项对得上。**

## 1. 事实来源与冲突处理

优先级：用户之后的明确指令 > 本任务书 > `docs/SEMANTIC_MODEL.md` > 现有代码与测试。

§2 是唯一的改名清单。表外发现的不妥帖写进 `docs/DEFERRED.md` 的"命名（2.0）"小节，不做。改名过程中若发现某项实际会改变行为，停下来报告，不要"顺手修正"。

## 2. 本轮范围已经裁定

### 2.0 迁移方式（已裁定）

不设别名，不保留旧键。理由：0.x 不承诺 API 稳定；`@syna/core` 未在 npm 发布；仓库外没有依赖它的代码，也没有它写出的持久化数据。`API_STABILITY.md` 相应改写：1.0 之前不承诺兼容，公开面自 0.8.0 起冻结，1.0 起只按 major 变化。0.6 引入的"永久接受 0.5 旧键 `implementationId`"按同一原则一并删除（见 F9、D10）。

### 2.1 类型与接口名

| # | 现在 | 改为 | 波及 |
|---|---|---|---|
| T1 | `EnvHandle` | `Env` | 每个签名；内部类保持 `EnvImpl`；文档里概念与类型同名，与 `Runtime` 对称 |
| T2 | `EntryDescriptor` | `Entry` | `EntryDefinition`（define 入参）不变；`Entry<Requires, Parameters>` 与 `Contract<Api>`、`Input<T>`、`Binding<C>` 对称 |
| T3 | `ImplementationDescriptor` | `ImplementationRecord` | `catalog.implementations()` 返回类型；`ImplementationCandidate extends ImplementationRecord` |
| T4 | `NodeDisposition` | `NodePlacement` | 值见 D4 |
| T5 | `InputType<I>` | `InputValue<I>` | 与描述符泛型参数 `ValueType` 对齐 |
| T6 | 新增 `SlotState` | `'dormant' \| 'starting' \| 'ready' \| 'failed' \| 'disposing' \| 'disposed' \| 'abandoned'` | 用于 D6；以 `materializer` 实际状态集为准，缺一个补一个，多一个删一个 |
| T7 | `UniquenessPolicy = 'none' \| 'lineage'` | `UniquenessPolicy = 'lineage'`；`ServiceFamily.uniqueWithin?: UniquenessPolicy`（未声明即 `undefined`） | 见 D9 |

### 2.2 字段与参数名

| # | 现在 | 改为 | 理由 |
|---|---|---|---|
| F1 | `ServiceRevision.key` | `id` | 其余描述符全叫 `id` |
| F2 | `RuntimePolicyContext.parentActiveRevisionKeys` | `parentActiveRevisionIds` | 随 F1 |
| F3 | 公开面上任何指修订 id 的 `*Key` 字段（如 `INVALID_INHERITED_CHOICE.details.selectedKey`） | `selectedRevision`；其余按 `grep 'Key\b'` 逐项改为 `*Id` 或 `*Revision` | 随 F1；Phase A 列出完整清单 |
| F4 | `ServiceDefinition.metadata`（族级） | `familyMetadata` | 定义端两级并存时两级都显式 |
| F5 | `ServiceRevision.metadata`（修订级） | `revisionMetadata` | 与 `ImplementationRecord.revisionMetadata` 一致；族级经 `revision.family.metadata` |
| F6 | `ImplementationCandidate.ref: CandidateRef` | `candidateRef` | 字段名 = 类型名 |
| F7 | `ImplementationRecord.persistentRef: ImplementationRef` | `implementationRef` | 同上；"persistent" 只留在落盘 `kind` |
| F8 | `Binding.to(service, version?)`、`ServiceRevision.range(version?)` 的参数名 | `range` | 收的是范围 |
| F9 | `ImplementationRef.version`（含 JSON 键） | `range`；**不**接受旧键。同时删除 0.6 加入的旧键 `implementationId` 读取分支及其辅助函数（`isLegacyImplementationRef`、`familyIdOf` 等）：读取路径只认 `{ kind, contractId, familyId, range }` 一种形状，其余 `INVALID_DESCRIPTOR` | `version` 在 `CandidateRef`、`ImplementationRecord` 是精确值，这里是范围；仓库外没有存量数据需要迁就 |
| F10 | `RuntimeInspection.internalServices` | `privateServices` | 规范用词是 private |
| F11 | `RuntimeInspection.planCache.maxEntries` | `limit` | 与 `limits.planCacheEntries` 对应；`entries` 仍是当前数 |
| F12 | `EntryExplanationSuccess.parameters.bindingsResolved` | `bindingsAssigned` | 与 `inputsProvided` 对称；解析是 Runtime 的事 |
| F13 | `ExplainedNode.disposition` | `placement` | 与 `dispose` 脱开词根 |
| F14 | `UnsettledAttemptInspection.runningForMs` | `elapsedMs` | 与事件字段同一量 |
| F15 | 事件与账本里的 `attempt: number` | `attemptNumber` | `attempt` 在规范里是名词 |
| F16 | `ServiceDefinition.setupDeadlineMs`、`RuntimeLimits.setupDeadlineMs` | `loadTimeoutMs` | 0.7 之后它是等待者的超时 |
| F17 | `ServiceRevision.setupDeadlineMs` | `loadTimeoutMs` | 随 F16 |
| F18 | `LINEAGE_UNIQUENESS_CONFLICT.details.anchorSlot / anchorRevision` | `pinnedSlot / pinnedRevision` | 与 `anchor()` 分开词根 |
| F19 | `ImplementationRef.kind: 'persistent-implementation-ref'` | `'implementation-ref'` | 类型已叫 `ImplementationRef`；0.6 保留旧字面量是为了落盘兼容，该理由已被 §2.0 撤销 |

### 2.3 联合值、枚举与字符串

| # | 现在 | 改为 |
|---|---|---|
| D1 | 错误码 `INITIALIZATION_TIMEOUT` | `LOAD_TIMEOUT`（与 `LOAD_CANCELLED` 成对） |
| D2 | ForkCause `anchor-dependency-mismatch` | `pinned-dependency-mismatch` |
| D3 | `InspectionNodeKind` 的 `'all'` | `'all-implementations'` |
| D4 | `NodePlacement` 值 `'inherited' \| 'new' \| 'forked'` | `'reused' \| 'new' \| 'forked'` |
| D5 | `ExplainCounts.inherited`、`services.eagerInherited` | `reused`、`eagerReused`（`inputs.inherited`、`inputsInherited`、`bindingsInherited` **不改**：那是声明继承） |
| D6 | `EnvInspection.state: string`、`EnvInspectionNode.state: string`、`attempt-abandoned.dependencies[].state: string` | `EnvState`、`SlotState`、`SlotState` |
| D7 | `UnsettledAttemptInspection.state` 的 `'timed-out'` | `'overdue'` |
| D8 | 事件 `late-setup-result` / `late-setup-failure` / `attempts-outstanding` / `foreign-thenable-setup` | `attempt-succeeded-late` / `attempt-failed-late` / `runtime-attempts-outstanding` / `setup-returned-thenable`；`attempt-overdue`、`attempt-abandoned`、`attempt-unreachable` 不变 |
| D9 | `ServiceFamily.uniqueWithin: 'none'` | 未声明时 `undefined` |
| D10 | 事件 `legacy-implementation-ref` | **删除**（随 F9：没有旧键就没有这个事件） |

### 2.4 结构与参数排列

| # | 现在 | 改为 |
|---|---|---|
| S1 | `env.derive(reuse?: ReuseConstraints)` | `derive(options?: EntryOptions)` |
| S2 | `catalog.revisions(familyId: string)` | `revisions(family: ServiceFamily)` |

### 2.5 刻意不改（写进 MIGRATION 的"未改与理由"节）

`Binding`、`ServiceRevision`、`load()`、`read()`、`parameters`、`provides`、`requires`、`reuse`、`override`、`auto`、`forward`、`C.all`、`ImplementationSet`、`EntryOptions`、`LINEAGE_UNIQUENESS_CONFLICT`、`details.site` 与 `RuntimePolicyContext.dependencySite` 的并存、`run()` 在无参 Entry 加调用期约束时的 `undefined` 空位、`contract()/service()/entry()` 可无名而 `input()/binding()` 必有名。

### 2.6 顺带的文档与工具修正（不涉及名字之外的语义）

- `scripts/api-inventory.mjs --diff`：把"仅 JSDoc 变化"与"签名变化"分开列，0.7 的 diff 把三个 `define.*` 重载报成签名变化是误报。
- `docs/SEMANTIC_MODEL.md`：§3 删除 "strong"；状态名改为小写代码字体；§7 用 pinned；§11 用 load timeout；全文用 `Env`/`Entry`。
- `docs/ARCHITECTURE.md`：补写 `DeadlineQueue`（进程级单例 timer、空闲 `unref`、跨 Runtime 隔离），这是 0.7 G1 引入而未记录的架构元素；补两条测试：两个 Runtime 的等待者互不干扰、无等待者时进程自然退出。
- `docs/PACKAGE_AUTHORING.md`：加一节"长冷启动请调大 `loadTimeoutMs`；超时是等待者的报告，不是 Service 的判决"。
- 术语表（`docs/manual/**/glossary.md` 若尚不存在则在 `docs/GLOSSARY.md`）：Env=环境、pinned=固定、anchored=锚定、materialize=物化、reused=复用、inherited=继承（仅 Input/Binding 声明）。

## 3. 执行方式

### Phase A：清单（报告点，不停顿）

1. 重新生成 API 清单；用脚本列出 §2 每一项在清单中的对应条目与所有出现位置（含 details 字段、事件载荷、文档）。
2. 产出 `work/v08/RENAME_TABLE.md`：旧 → 新 → 类别（类型 / 字段 / 值 / 事件 / 结构）→ 涉及文件数。F3 的 `*Key` 完整列表在此给出。
3. 写好 `scripts/codemod-v08.mjs`，在 Hyla-mini 上试跑并记录改动统计。
4. 把以上三项汇总到会话后**直接继续**。只有两种情况停下：发现表外必须一并改的名字（先记 DEFERRED 再问），或发现某项改名会改变行为。

### Phase B：内核改名

按 §2.1 → 2.2 → 2.3 → 2.4 顺序，每个小节一个 commit；每个 commit 内同步 `SynaErrorDetails`、事件类型、inspection 类型、类型测试。

### Phase C：消费者迁移

用 codemod 迁移 `apps/*`、`packages/hyla*`、`benchmarks`、`scripts`、`packages/core/tests`（测试里的旧名断言按 §2 表映射改写，不是删除）；Hyla-mini 存储的配方 fixtures 改写为 `{ kind: 'implementation-ref', contractId, familyId, range }`，删除全部旧键 fixture 与旧键测试；`no-old-names` 模式表扩展到本轮全部旧名。

### Phase D：文档与冻结

`docs/MIGRATION_V07_TO_V08.md`（逐项表 + codemod 用法 + F9 的读写规则）；`API_STABILITY.md` 改写为三句：1.0 之前不承诺兼容（无别名、无旧键）；公开面自 0.8.0 起冻结，0.8 之后到 1.0 之间不再有名字变化；1.0 起名字与语义只按 major 变化；全部文档措辞同步；`DEFERRED.md` 新增"命名（2.0）"小节收本轮表外发现；`CHANGELOG.md`。

### Phase E：验证与交付

全部核心/类型/应用/scripts 测试与真实 PostgreSQL 矩阵；reference planner 差分与 explain/inspect 快照在按 §2 映射改写后逐字一致；benchmark ±10%、缓存计数不变；`any` 不增；README 示例测试；清单 `@deprecated` 为 0；gate 从最终归档重建；输出真实摘要。

## 4. 验收项

| # | 验收 |
|---|---|
| A01 | 前后清单 diff 中的每一条 removed/added/changed 都能在 `RENAME_TABLE.md` 找到对应行；没有表外条目 |
| A02 | 清单 `@deprecated` 为 0；`no-old-names` 覆盖本轮全部旧名与旧码，消费者零命中 |
| A03 | codemod 在仓库内所有消费者上可重跑且幂等；MIGRATION 给出用法 |
| A04 | 零语义变化：reference planner 差分、explain/inspect 快照（映射后）逐字一致；`limits` 默认值逐字不变 |
| A05 | F9/F19/D10：新写入只有 `{ kind: 'implementation-ref', contractId, familyId, range }` 一种形状；核心源码与测试中 `implementationId`、`persistent-implementation-ref`、`legacy` 的 grep 为零；旧键对象被 `parse()` 以 `INVALID_DESCRIPTOR` 拒绝并有测试 |
| A06 | D6：三处 `state` 有类型；`SlotState` 与 materializer 实际状态集一致（测试枚举全部状态） |
| A07 | §2.6 的四项文档修正与两条 DeadlineQueue 测试到位；inventory 工具区分 doc-only 变化 |
| A08 | `API_STABILITY.md` 含冻结声明与"最后一次"的措辞；`DEFERRED.md` 有"命名（2.0）"小节 |
| A09 | benchmark ±10%、`any` 不增、gate 从归档重建通过 |

## 5. 禁止事项

- 不改 §2 之外的任何公开名字；不改任何语义；不加任何公开选项。
- 不设别名，不保留旧键，不写"兼容旧格式"的分支；不手改消费者（必须经 codemod）。
- 不删除有效反例测试；改写的断言逐项对应 §2 表。
- 不修改本任务书的验收项；不以"已完成"的文字代替证据。

若因外部条件阻塞，完成其余部分，记录 `work/v08/STATE.md`，报告 BLOCKED 并暂停。
