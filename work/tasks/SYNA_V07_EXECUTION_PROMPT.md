# Syna v0.7 到期清理与语义修订：实施任务书

> 这是要求你实际修改代码、运行测试、更新文档并交付证据的任务，不是设计讨论。
> 本轮与 v0.6 相反：**v0.6 只改名不改语义，v0.7 只改语义不改名。**公共名字除删除 0.6 已宣布到期的别名和一处遗骸外，一个不动。
> 本轮做完，`docs/API_STABILITY.md` 的冻结面成为 1.0 候选面；此后任何公开名字或语义的变化都需要 major。

## 0. 任务、权限与完成含义

你是本项目的实施负责人。对象是当前工作区的 Syna v0.6.0 仓库（`packages/core`、`apps/hyla-mini`、`apps/*-demo`、`packages/hyla`、`docs`、`benchmarks`、`scripts`、`work`）。目标版本号 `0.7.0`。

本轮四类工作，按风险从低到高：

1. **到期删除**：0.6 标记 "Removed in 0.7.0" 的全部别名与兼容形态；
2. **遗骸清理**：selector 删除后残留的字段与类型；
3. **诊断质量**：把两个"杂物箱"错误码按含义拆开，收紧 `details`；
4. **语义修订**：三项，每项都在 v0.6 的 `docs/DEFERRED.md` 里登记过（S1、S2、S6）。

你必须交付：源码改动；每项语义修订的行为测试与反例测试；更新后的 `docs/SEMANTIC_MODEL.md`（§11、§13 实质修订）与新文件 `docs/SEMANTIC_CHANGES_V07.md`（保留/澄清/修订/撤回登记，格式沿用 `SEMANTIC_CHANGES_V05.md`）；`docs/MIGRATION_V06_TO_V07.md`；更新后的 `docs/API_REFERENCE.md`、`docs/API_STABILITY.md`（1.0 候选声明）、`docs/DEFERRED.md`（移除已解决项）、`CHANGELOG.md`；沿用 release gate 从最终归档重建后的真实摘要。

授权范围与前两轮相同：本地开发、隔离测试、本地归档。不发布、不 force push、不动全局设置、不做破坏性 git 操作、不读无关密钥。保留用户未提交改动。

完成不是"全绿"，而是：**到期项一个不剩、遗骸一个不剩、三项语义修订各有反例证明旧行为已消失且新行为受测试保护、其余语义逐字不变。**

## 1. 事实来源与冲突处理

优先级：用户之后的明确指令 > 本任务书 > `docs/SEMANTIC_MODEL.md` 与 `docs/SEMANTIC_CHANGES_V05.md` > `docs/DEFERRED.md` 的记录 > 现有代码与测试。

本任务书第 2 节是唯一的改动清单。清单之外的任何公开名字不改、不加、不删；清单之外的任何语义不动。本轮发现的新问题写入 `docs/DEFERRED.md`，不做。

三项语义修订（S1、S2、S6）之外若发现"顺手就能改"的行为——例如放松 `C.all` 共存、加 `primary()`、加 `ServiceFamily.range()`、给 `load()` 加 `timeoutMs`、恢复跨祖先复用——一律不做。这些在 0.6 的 DEFERRED 里有编号，保持编号，只更新"为什么仍然延后"。

若某项到期删除在实施中暴露出应用或 demo 仍依赖旧形态，不是恢复别名，而是迁移应用；若某项语义修订与现有测试冲突，先判断该测试断言的是旧语义（可撤回，逐项登记）还是不变量（不可撤回，说明修订方案错了，停下来报告）。

## 2. 本轮范围已经裁定

### 2.1 到期删除（无别名，直接删）

以下是 0.6 清单中带 "Removed in 0.7.0" 的全部项，共 23 个，以 `work/v06/API_INVENTORY_AFTER.json` 中的 `@deprecated` 标记为准，实施前用 `scripts/api-inventory.mjs` 重新生成核对：

| 组 | 删除项 |
|---|---|
| Env / Entry | `EnvHandle.bind()`、`BoundEntry`、`EntryDefinition.scope`、`EntryDescriptor.scope`、`DeriveOptions`、`ScopeTarget`、0.5 调用形态 `ScopedEntryParameters`（参数记录内的 `scope`/`reuse` 键；`EntryCallArguments`/`EntryRunCallArguments` 中对应的重载分支） |
| Runtime | `SynaRuntime`、`CreateRuntimeOptions.planCache/initialization/disposal/planning`、`PlanCacheOptions(.maxEntries)`、`InitializationOptions(.deadlineMs)`、`DisposalOptions(.graceMs)`、`PlanningOptions(.searchBudget)`、`RuntimePolicyContext.site` |
| Ref | `DependencyRef`（0.6 中已是 `ServiceRef \| InputRef` 的弃用别名）、`PersistentImplementationRef`、`ImplementationRef.implementationId`（运行时对象上的不可枚举 getter） |

两条**保留**规则，写进 MIGRATION 与 API_REFERENCE：

- `Binding.parse()` / `parseImplementationRef()` **永久**接受旧 JSON key `implementationId`（这是数据兼容，不是 API 别名；用户数据库里的引用不会随代码版本消失），并在读到旧 key 时发出一次 `diagnostics` 事件；
- `ImplementationRef.kind === 'persistent-implementation-ref'` **永久**保留（落盘判别字段），文档注明"名字来自 0.4，格式稳定，不会改"。

删除后：`API_INVENTORY_AFTER` 中 `@deprecated` 项必须为 0；`scripts/tests/no-old-names.test.mjs` 的模式表扩展到以上全部名字。

### 2.2 遗骸清理

| 项 | 处理 |
|---|---|
| `ImplementationCandidate.availability`、`CandidateAvailability` | 删除。0.6 里它永远是 `{ status: 'available' }`，是 selector 的遗骸。`ImplementationCandidate` 只剩 `ref` 与描述字段 |
| `RuntimeEvent` 中仅由 selector 产生、0.6 已不可能触发的事件类型 | 若存在，删除；用 grep 证明没有产生点 |
| `docs/API_REFERENCE.md`、`docs/ARCHITECTURE.md` 中提到 selector、lease、候选预检、availability 的段落 | 删除或改写为 `C.all` |

### 2.3 诊断质量（不改触发条件，只改码与 `details`）

**S6：拆分 `FRESH_CONSTRAINT_FAILED`。** 它在 0.6 有四个抛出点，只有一类和 `fresh` 有关：

| 抛出点 | 0.6 码 | 0.7 码 | `details` |
|---|---|---|---|
| `entry-planner` `validateScopeTargets`：`fresh`/`share` 目标修订在父世界不活动 | `FRESH_CONSTRAINT_FAILED` | `INACTIVE_REUSE_TARGET` | `{ constraint: 'fresh' \| 'share', env, revision }` |
| 同上，目标是 Family | `FRESH_CONSTRAINT_FAILED` | `INACTIVE_REUSE_TARGET` | `{ constraint: 'fresh' \| 'share', env, family }` |
| `graph-builder`：继承的解析在该位点不再有效 | `FRESH_CONSTRAINT_FAILED` | `INVALID_INHERITED_CHOICE` | `{ site, selectedKey, candidates }` |
| `implementation-directory`：`CandidateRef` 属于另一个集合 | `FRESH_CONSTRAINT_FAILED` | `FOREIGN_CANDIDATE_REF` | `{ expectedSourceSlot, receivedSourceSlot }` |

拆完后 `FRESH_CONSTRAINT_FAILED` 没有抛出点，从 `SynaErrorCode` 移除。`SHARE_CONSTRAINT_FAILED` 不动。触发条件与消息文案逐字不变。

**S7：拆分 `INVALID_ENV_STATE`（12 个抛出点、至少 6 种含义）。** 目标：≤ 4 个码，每个码 ≤ 2 种 `details` 形状，每个抛出点有一条测试。建议划分——Phase A 可以提出更好的方案，但必须给出"抛出点 → 码"的完整表：

| 含义 | 建议码 |
|---|---|
| 从 activating/disposing/disposed 的 Env 进入、锚定或加载 | `ENV_NOT_READY`（含当前 `state`） |
| Env 已关闭或在 activation 完成前被关闭 | `ENV_CLOSED` |
| slot 处于不可加载/不可恢复状态（disposing、disposed、非 failed 上调用恢复） | `SLOT_NOT_LOADABLE`（含 `state`） |
| 生命周期 API 误用（`onDispose()` 在 setup 之外、非法 Entry descriptor） | `LIFECYCLE_MISUSE` / 归入 `INVALID_DESCRIPTOR` |

**S7 续：收紧 `INVALID_DESCRIPTOR`（28 个抛出点）。** 保留一个码，`details` 规范为一种形状 `{ descriptor: string, problem: string, site?: string, path?: readonly string[] }`；用表驱动测试覆盖全部 28 个抛出点，禁止 `details` 为空对象。

**S8：`MISSING_IMPLEMENTATION.details.revision` 不得为 `undefined`；** 6 个抛出点各自的 `details` 收成 ≤ 3 种形状，全部字段必填。

**S10：`asSynaError()` 包装外来错误时，** `details` 固定为 `{ cause: { name, message } }`，原错误放在 `cause`；不再从外来对象上猜 `details`。

以上全部反映到 `SynaErrorDetails` 类型与 API_REFERENCE 的错误码表。Hyla-mini、demos、scripts 中对旧码的判断（grep `FRESH_CONSTRAINT_FAILED`、`INVALID_ENV_STATE`）同步迁移，并加入 `no-old-names` 模式表。

### 2.4 语义修订（三项，各自登记）

**S1：deadline 是等待者的超时，不是 attempt 的判决；迟到的成功被接纳。**

现状（0.5/0.6）：`setupDeadlineMs` 到期后 slot 进入 `failed`，attempt 继续运行，其后成功的结果被丢弃并执行 cleanup。这违反 v0 的原则"setup 是否成功由它自己决定"，并且会在生产中销毁一个耗时 45 秒但成功构建的资源。

0.7 语义：

1. `setupDeadlineMs`（Service 选项与 `limits.setupDeadlineMs`）限定**一次 `load()` 等待**当前 attempt 的时长，不决定 attempt 的结果。默认值仍为 `30_000`。
2. 到期时，该等待者的 `load()` 以 `INITIALIZATION_TIMEOUT` 拒绝；`details` 在现有字段上加 `attemptStillRunning: true`。slot **保持 `starting`**；`inspect()` 对该 slot 报告 `overdueMs`；每个 attempt 只发一次 `attempt-overdue` 事件。
3. 之后对同一 slot 的 `load()` 加入仍在运行的 attempt，各自计算自己的等待窗口。
4. attempt 随后**成功**且 owner Env 仍处于 `ready`：slot 进入 `ready`，实例被接纳，所有仍在等待的 `load()` 兑现，发出 `late-setup-result` 事件并带 `adopted: true`；此后的 `load()` 正常。
5. attempt 随后**失败**：走现有失败路径（sticky / attempts / retry-on-next-load 逐字不变）。deadline 到期**不消耗** `attempts` 计数，也不触发 `delayMs` 退避。
6. owner Env 在 attempt 运行期间开始关闭：现有有界关闭语义逐字不变（abort → grace → abandoned → 迟到结果丢弃并执行 cleanup）。**只有关闭会丢弃迟到的成功。**
7. eager 激活：`enter()` 的等待使用同一等待者超时；到期时 `ENTRY_ACTIVATION_FAILED`（`details` 列出 overdue 的 slot），随后现有回滚逻辑关闭新 Env——因此 eager 场景下迟到的成功仍因关闭而被丢弃，这是第 6 条的推论，不是例外，文档要写明。
8. 不新增任何公开选项。等待者需要更短的超时用现有 `load({ signal })` 配合 `AbortSignal.timeout()`；这条写进 API_REFERENCE。

必须有的反例测试：慢 250 ms 的成功 setup 在 100 ms deadline 下——第一次 `load()` 超时、300 ms 后 `load()` 得到实例、`onDispose` 未被执行、slot 为 `ready`；同一场景 owner 在 150 ms 时 dispose——结果被丢弃、cleanup 执行；两个等待者先后超时后 attempt 成功——两者都不再持有 stale 状态；eager 场景到期回滚。

**S2：`env.state` 与账本不依赖垃圾回收。**

现状：有界关闭后 Env 停在 `disposing`，直到被放弃的 attempt 的 Promise 被 V8 回收或迟到兑现才变为 `disposed`；账本随 GC 收缩；`dispose()` 以 `UNSETTLED_ATTEMPT` 拒绝。

0.7 语义：

1. `env.state` 只由 Runtime 的动作推进：`activating → ready → disposing → disposed`。有界关闭完成（后代已关、cleanup 已执行或 grace 已到）时，无论是否还有被放弃的 attempt，`state = 'disposed'`，Env 离开树与注册表。
2. 被放弃的 attempt 记录在 `runtime.inspect().unsettledAttempts` 与 `env.inspect().abandonedAttempts`；attempt 兑现（无论成功失败）时从账本移除并发出现有 `late-setup-*` 事件。`FinalizationRegistry` 只用于账本的**额外**收缩与 `attempt-unreachable` 诊断事件；**任何 `state` 断言的测试不得依赖 `--expose-gc`**。
3. `dispose()` 的返回：不再因用户代码不响应取消而拒绝。Phase A 必须在（i）总是兑现、通过账本与事件报告，与（ii）默认兑现、以最小方式提供严格模式，两者之间提出方案并说明理由；未经批准不得引入新的公开选项名。`runtime.dispose()` 结束时若账本非空，发出一次汇总事件。
4. `UNSETTLED_ATTEMPT` 保留为"在 attempt 未兑现时请求恢复"的码（现有含义之一）；若第 3 条选择（i），它在 `dispose()` 路径上不再出现，`SynaErrorDetails` 相应收紧。

必须有的反例测试：`setup: () => new Promise(() => {})` 的 Service，dispose 在 grace 后返回，`env.state === 'disposed'`，`liveEnvCount` 减一，账本含一项；之后该 Promise 被保持引用或释放引用，`state` 都不变；迟到兑现后账本项移除。

**S6 见 2.3。**它属于语义修订而非纯改名，因为 `isSynaError(e, code)` 的使用者会观察到不同的码。

### 2.5 明确不做

以下继续留在 `docs/DEFERRED.md`，只更新理由：S3 `primary()`、S4 `C.all` 共存放松、S5 新依赖形式/Entry 能力/Runtime 选项（含 `ServiceFamily.range()`、`load({ timeoutMs })`）、S9 `C.all` 多活动修订的版本解析、跨祖先复用、Prepared、任何 barrier、Runtime 世代切换宿主。

## 3. 执行方式：先提案，后动刀

### Phase A：盘点与提案（计划审阅点）

1. 重新生成 API 清单，列出全部 `@deprecated` 项与本任务书 2.1 的对照；差异即报告。
2. 写 `work/v07/PROPOSAL.md`，包含：S1 的 slot 状态机图（`starting` 上的 overdue 标记、等待者与 attempt 分离后的每条转移）；S2 的 `dispose()` 返回契约方案（i）/（ii）及理由；S7 的"12 个抛出点 → 码"完整表与 `INVALID_DESCRIPTOR` 28 个抛出点的 `details` 归一表；S1/S2 对现有测试的影响清单（哪些测试断言旧语义、准备如何撤回并登记）。
3. 评估 reference planner 差分与 explain/inspect 快照的影响：S1/S2 不触及规划层，差分与快照应当**逐字不变**；若不是，说明哪里漏了。
4. 停在这里等审阅。用户使用 `/plan` 时，Phase A 就是计划。

### Phase B：到期删除与遗骸

2.1、2.2 各一个 commit；扩展 `no-old-names` 模式表；应用与 demos 迁移；清单 `@deprecated` 归零。

### Phase C：诊断质量

S6、S7、S8、S10 各一个 commit，每个抛出点一条测试（表驱动可以），`SynaErrorDetails` 同步，API_REFERENCE 错误码表重写。

### Phase D：S1

在 `materializer` 内实现；测试见 2.4；`inspect()` 与事件类型同步；SEMANTIC_MODEL §11 改写。

### Phase E：S2

在 `runtime`/`materializer` 内实现；测试见 2.4；`gc` 相关测试仅保留在账本收缩与 `attempt-unreachable` 事件上；SEMANTIC_MODEL §13 改写。

### Phase F：文档与登记

`SEMANTIC_CHANGES_V07.md`（S1、S2、S6 为"修订"，S7/S8/S10 为"澄清"，2.1/2.2 为"到期删除"）；`MIGRATION_V06_TO_V07.md`（逐项：删除项及替代写法、错误码映射表、S1/S2 行为差异与需要检查的用户代码模式）；`API_STABILITY.md` 加"1.0 候选面"声明；`DEFERRED.md` 移除 S1、S2、S6、S7、S8、S10；`CHANGELOG.md`；README 双语示例若涉及错误码则更新。

### Phase G：验证与交付

全部核心/类型/应用/scripts 测试与真实 PostgreSQL 矩阵；reference planner 差分与 explain/inspect 快照逐字不变；benchmark 与 0.6 同机交替对比 ±10%；`any` 不增；README 示例测试；release gate 从最终归档重建；输出真实摘要。

## 4. 验收项

| # | 验收 | 依据 |
|---|---|---|
| A01 | 清单中 `@deprecated` 项为 0；2.1 的 23 项与 2.2 的遗骸在 AFTER 清单中不存在 | inventory 脚本 + gate 断言 |
| A02 | `no-old-names` 模式表覆盖全部删除名与旧错误码；应用、demos、benchmarks、scripts 无命中 | 测试 |
| A03 | S6：四个抛出点各有测试断言新码与 `details`；`FRESH_CONSTRAINT_FAILED` 不在联合中 | 测试 + 类型 |
| A04 | S7：`INVALID_ENV_STATE` 拆分后每个抛出点有测试；`INVALID_DESCRIPTOR` 28 个抛出点表驱动覆盖且 `details` 非空 | 测试 |
| A05 | S8/S10：`details` 无 `undefined` 必填字段；外来错误包装形状固定 | 测试 |
| A06 | S1：2.4 列出的四个反例场景全部有测试；到期不消耗 `attempts`；默认值仍为 30_000 | 测试 |
| A07 | S2：`state` 断言的测试不使用 `--expose-gc`；有界关闭后 `disposed`；账本行为受测试保护；`dispose()` 契约与 Phase A 批准的方案一致 | 测试 + PROPOSAL |
| A08 | 规划层零变化：reference planner 差分与 explain/inspect 快照逐字一致 | 测试 |
| A09 | `SEMANTIC_MODEL.md` §11、§13 与实现一致；`SEMANTIC_CHANGES_V07.md` 登记完整；`MIGRATION_V06_TO_V07.md` 含错误码映射表 | 文档 |
| A10 | `API_STABILITY.md` 含 1.0 候选声明；`DEFERRED.md` 已移除本轮解决项 | 文档 |
| A11 | 旧 JSON key `implementationId` 可解析并发出诊断事件；`kind` 判别字段不变 | 测试 |
| A12 | benchmark ±10%、`any` 不增、gate 从归档重建通过 | gate 输出 |

## 5. 禁止事项

- 不改任何公开名字（2.1、2.2 的删除除外）；不加任何公开选项（S2 第 3 条经批准的最小方案除外）；
- 不动 S1、S2、S6 之外的语义；规划层一字不改；
- 不用别名代替删除；不因为应用依赖旧形态就恢复别名；
- 不删除有效反例测试换全绿；撤回的测试逐项登记并说明它断言的是哪条旧语义；
- 不让任何 `state` 断言依赖 GC；
- 不修改本任务书的验收项；
- 不以"已完成"的文字代替证据：最后输出 gate 的真实摘要、归档哈希、清单 diff 统计与撤回测试清单。

若因外部条件（PostgreSQL 不可用、依赖安装失败等）确实无法完成某项验证，完成其余部分，记录 `work/v07/STATE.md` 与精确复现命令，报告 BLOCKED 并暂停。BLOCKED 不是成功；任务大或测试红不构成 BLOCKED。
