# 从 v0.6 迁移到 v0.7（MIGRATION_V06_TO_V07）

v0.7 做三件事：删除 0.6 宣布到期的全部 23 个别名与 0.5 调用形态（§1）；按表拆分与收紧错误码及其 `details`（§3）；两处语义修订——S1「deadline 是等待者超时」与 S2「`env.state` 只由 Runtime 动作推进」（§4，`docs/SEMANTIC_CHANGES_V07.md` 逐项登记保留/澄清/修订/撤回）。规划层零变化：`packages/core/tests/reference-planner.test.mjs` 的参考 planner 差分与 `packages/core/tests/v06-snapshots.test.mjs` 的 explain/inspect 快照逐字不变（唯一允许的差异登记在该文件的 RENAMED 表）。任务书之外的公开名字一个不改、不加、不删；未做的事在 `docs/DEFERRED.md`。

## §1 删除的名字（0.6 弃用别名 → 0.7 唯一形式）

0.6.x 里每一项都带 `@deprecated … Removed in 0.7.0`；0.7.0 起类型声明里没有任何 `@deprecated` 项（`scripts/tests/deprecations.test.mjs` 断言为 0；`scripts/tests/api-inventory.test.mjs` 断言公开 API 与 0.6.0 清单 `work/v07/API_INVENTORY_BEFORE.json` 的差异恰好是下表的 23 个清单项，多一个少一个都失败）。原则：过期形式**被拒绝而不是被忽略**——静默忽略是删除最不该有的结果。

| 清单项 | 0.6 形式 | 0.7 唯一形式 | 仍写旧形式时 |
|---|---|---|---|
| 1 | `EntryDefinition.scope` | `reuse: { fresh, share }` | `define.entry()` 抛 `TypeError`（`Entry <id> uses the removed option scope; use reuse.`）；类型层面是多余属性错误 |
| 2 | `EntryDescriptor.scope` | `descriptor.reuse` | 属性不存在（`'scope' in descriptor === false`） |
| — | 参数记录里的 `scope` 键：`enter/run/check/explain(entry, { …, scope })`（0.5 调用形态，从未是清单项） | 第三个参数 `{ reuse }`；`run(entry, args?, options?, callback)` 的回调永远最后 | `TypeError`（`scope is no longer a call parameter (removed in 0.7.0): pass the reuse constraints as the options argument, enter(entry, parameters, { reuse }).`），值为 `undefined` 也拒绝；`reuse` 作为参数键同样拒绝。`reuse` 与 `scope` 仍是保留的参数名 |
| 3 | `DeriveOptions` | `ReuseConstraints` | 类型不存在 |
| 4 | `ScopeTarget` | `ReuseTarget` | 类型不存在 |
| 5 | `env.bind(entry)` | `env.anchor(entry)` | `env.bind` 是 `undefined` |
| 6 | `BoundEntry` | `AnchoredEntry` | 类型不存在 |
| 7 | `SynaRuntime` | `Runtime` | 类型不存在 |
| 8 | `DependencyRef<T>` | `ServiceRef<T>`（可 `load()`）或 `InputRef<T>`（`read()`）；声明的依赖用 `DependencyRefFor<D>` | 类型不存在 |
| 9 | `PersistentImplementationRef` | `ImplementationRef` | 类型不存在 |
| 10 | `ref.implementationId`（getter） | `ref.familyId` | 属性不存在：`to()` / `parse()` 的结果只有 `kind` / `contractId` / `familyId` / `version` 四个自有属性。**序列化键 `implementationId` 永久可读**，见 §2 |
| 11 | `RuntimePolicyContext.site` | `context.dependencySite` | 属性不存在（context 的键恰是 `dependencySite`、`parentActiveRevisionKeys`） |
| 12–15 | `createRuntime({ planCache: { maxEntries } })`、`initialization: { deadlineMs }`、`disposal: { graceMs }`、`planning: { searchBudget }` | `limits: { planCacheEntries, setupDeadlineMs, disposalGraceMs, planningBudget }`；默认值不变：512 / 30_000 / 2_000 / 10_000 | `TypeError`（`createRuntime() option <record> was removed in 0.7.0; use limits.<key>.`），与 `limits` 同时给出也拒绝 |
| 16–23 | `PlanCacheOptions` / `.maxEntries`、`InitializationOptions` / `.deadlineMs`、`DisposalOptions` / `.graceMs`、`PlanningOptions` / `.searchBudget` | `RuntimeLimits` | 类型不存在 |

清单之外的 selector 遗骸（§2.2）：`ImplementationCandidate.availability`（0.6 起恒为 `{ status: 'available' }`——唯一产生过 `unavailable` 的是 0.5 selector 的候选预检）、它的类型 `CandidateAvailability`，以及由这个字段定义的 `AvailableImplementationCandidate`（Q2）一并删除。`C.all` 的每个候选都是当前拓扑里的真实节点，`set.load(candidate)` 就是可用性本身；候选对象的自有键恰是描述符字段加 `ref`。

测试：`packages/core/tests/v07-expired-forms.test.mjs` 逐项断言过期形式被拒绝或不存在、现行形式的行为与 0.6 相同、四个默认值逐字锁定、`C.all` 候选没有 `availability`；`packages/core/type-tests/api.ts` 对每个过期形式标 `@ts-expect-error`。0.6 的七个别名等价测试（`v06-r1` … `v06-r6`、`v06-m1-limits`）随别名一起删除，登记在 `docs/SEMANTIC_CHANGES_V07.md` 的撤回清单。

## §2 永久保留：序列化键 `implementationId` 与 `kind`

持久化数据比 API 线活得久，所以 R5 的旧键不随别名到期：

- `Binding.parse()` / `parseImplementationRef()` 永久接受 `implementationId`（两键同时给出时必须相等；都缺是 `TypeError`）。解析结果只带 `familyId`：JSON 只写 `familyId`，`Object.keys` 只有四个键。
- Runtime 的每条读取路径——`catalog.resolve()`、Binding 赋值的规划、`set.resolve()`、`set.load(ref)`——接受原始的 0.5 形式对象（`familyId` 缺失而 `implementationId` 为字符串），每次读取报告一次诊断事件 `legacy-implementation-ref { contractId, familyId, version, site }`；`parse()` 从旧键文档解析出的 ref 同样被报告（用不可枚举的 Symbol 标记，JSON / keys / spread 都看不见）。Runtime 自己在 `ImplementationDescriptor.persistentRef` 里报告的 ref 是现行形式，再次读取不报告。事件仅诊断：处理器抛错不改变结果，没有处理器就没有事件。
- `kind === 'persistent-implementation-ref'` 是磁盘上的判别字段，永不改变。
- Hyla-mini 在存储边界把旧键归一化为 `familyId`（`apps/hyla-mini/src/domain/recipe-schema.ts`），Runtime 不会读到旧键，事件不会因 Hyla-mini 的数据触发。

测试：`packages/core/tests/v07-legacy-implementation-key.test.mjs`、`apps/hyla-mini/tests/v06-compat.test.mjs`。

## §3 错误码映射

触发条件与消息文案逐字不变，只改码与 `details`；`docs/API_REFERENCE.md` 的错误表列出每个码的 `details`，`scripts/tests/api-inventory.test.mjs` 把每个码的清单项（`SynaErrorCode` 的成员）登记为删除/新增。

### S6 `FRESH_CONSTRAINT_FAILED` → 按抛出点拆成三个码

0.6 的四个抛出点里只有一类和 `fresh` 有关。拆完后 `FRESH_CONSTRAINT_FAILED` 没有抛出点，从 `SynaErrorCode` 移除；`SHARE_CONSTRAINT_FAILED` 不动。

| 抛出点 | 0.6 | 0.7 | `details` |
|---|---|---|---|
| `fresh` / `share` 目标修订在父世界不活动 | `FRESH_CONSTRAINT_FAILED` `{ env, revision }` | `INACTIVE_REUSE_TARGET` | `{ constraint: 'fresh' \| 'share', env, revision }` |
| 同上，目标是 Family | `FRESH_CONSTRAINT_FAILED` `{ env, family }` | `INACTIVE_REUSE_TARGET` | `{ constraint, env, family }` |
| 继承自父世系的解析在该位点不再是候选（两次规划之间该位点的依赖变了，例如 `forward()` 的目标） | `FRESH_CONSTRAINT_FAILED` | `INVALID_INHERITED_CHOICE` | `{ site, selectedKey, candidates }` |
| `set.load()` 收到属于另一个集合的 `CandidateRef`（或带着它的候选） | `FRESH_CONSTRAINT_FAILED` | `FOREIGN_CANDIDATE_REF` | `{ expectedSourceSlot, receivedSourceSlot }` |

可回溯集合（决定 `check()` / `explain()` 报告而非抛出、规划器是否回溯）用 `INACTIVE_REUSE_TARGET` 与 `INVALID_INHERITED_CHOICE` 顶替旧码，规划行为按构造不变；`FOREIGN_CANDIDATE_REF` 由 `ImplementationSet` 在运行时抛出，从不可回溯。快照：`v06-snapshots` 的 RENAMED 表把 0.5 记录的 `CONSTRAINT_VIOLATION` 映射到 `INACTIVE_REUSE_TARGET`，ADDED 表补上 `constraint: 'fresh'`；记录本身不变。测试：`packages/core/tests/v07-s6-reuse-errors.test.mjs`（四个抛出点各一，`details` 逐键断言）。

### S7 `INVALID_ENV_STATE` → 按含义拆成四个码；`INVALID_DESCRIPTOR` 的 `details` 收成一种形状

0.6 的 16 个抛出点（11 个字面量加上 `internal/abort.ts` 的 5 条路径）至少有六种含义。0.7 按含义分为 `ENV_CLOSED`（`{ env, state }` | `{ env, state, slot, revision }`）、`RUNTIME_CLOSED`（`{}`）、`SLOT_NOT_LOADABLE`（`{ slot, revision, state }`，slot 的状态）、`LIFECYCLE_MISUSE`（`{ slot, revision, attempt, state }`，attempt 的状态）；四个调用方无法到达的位点（计划里缺失锚点节点、没有 owner 的 slot、attempts 循环零次、恢复时状态异常）改为没有公开码的内部不变量 `Error('Syna internal invariant: …')`。`INVALID_ENV_STATE` 从 `SynaErrorCode` 移除；`ENTRY_ACTIVATION_FAILED` 的 `details.causeCode` 相应变为 `ENV_CLOSED`。消息文案不变。

| 抛出点 | 0.6 `details` | 0.7 | `details` |
|---|---|---|---|
| Env 在激活完成前被关闭（作为 `ENTRY_ACTIVATION_FAILED` 的 `cause`） | `{ env, state }` | `ENV_CLOSED` | `{ env, state }` |
| 锚定 Entry 的锚点 Env 已离开 Runtime | `{ env }` | `ENV_CLOSED` | `{ env, state: 'disposed' }` |
| Runtime 已 dispose 后的任何入口 | `{}` | `RUNTIME_CLOSED` | `{}` |
| 从 disposing / disposed 的 Env `enter` / `run` / `check` / `explain` / `derive` | `{ entry, env, state }` | `ENV_CLOSED` | `{ env, state }`（entry 仍在消息里） |
| `load()` 遇到 disposing / disposed / abandoned 的 slot | `{ slot, revision, state }` | `SLOT_NOT_LOADABLE` | `{ slot, revision, state }` |
| attempt 结算后再调用 `onDispose()` | `{ slot, revision, attempt, state }` | `LIFECYCLE_MISUSE` | `{ slot, revision, attempt, state }` |
| owner 关闭时 setup 仍未结算（结果将被丢弃） | `{ slot, revision, env, attempt }` | `ENV_CLOSED` | `{ env, state, slot, revision }`（`attempt` 去掉） |
| setup 在 owner 开始关闭后才完成（实例被丢弃） | `{ slot, revision, env }` | `ENV_CLOSED` | `{ env, state, slot, revision }` |
| owner 正在关闭时 materialize / recover | `{}`（信号已中止）或 `{ slot, revision, env, state }` | `ENV_CLOSED` | `{ env, state, slot, revision }` |
| 重试退避 / 恢复冷却被 owner 的关闭取消 | `{}` | `ENV_CLOSED` | `{ env, state, slot, revision }` |
| 缺失锚点节点、没有 owner 的 slot、attempts 循环零次、恢复时状态异常 | 各异 | 内部 `Error` | —（没有公开码） |

`INVALID_DESCRIPTOR` 保留一个码，28 个抛出点的 `details` 统一为 `{ descriptor: string, problem: string, site?: string, path?: readonly string[] }`：`descriptor` 是期望的描述符种类、选项名或出错描述符的 id / key；`problem` 取自封闭词表 `not-an-object`、`not-an-array`、`wrong-kind`、`unknown-kind`、`empty-contract-id`、`self-override`、`override-cycle`、`forward-cycle`、`not-service-revisions`、`parameters-not-an-object`、`invalid-assignment`、`not-from-this-runtime`、`policy-result-not-an-array`、`policy-result-not-a-permutation`；有依赖位点的带 `site`，override 环带 `path`（环上的 key 链）。0.6 键的映射：`revision`（override 环）→ `descriptor`；`binding`（Binding 赋值）→ `descriptor`；`site`（策略结果、未知依赖种类）保留；`original` / `ordered`（策略结果不是排列）去掉；其余 24 个位点在 0.6 的 `details` 是 `{}`。另外 `set.load()` 收到 `revisionKey` 不是字符串的 `CandidateRef` 现在是 `INVALID_DESCRIPTOR`（0.6 报 `MISSING_IMPLEMENTATION { revision: undefined }`）。

测试：`packages/core/tests/v07-s7-env-state.test.mjs`（每个可达位点一例，`details` 逐键断言）与 `v07-s7-invalid-descriptor.test.mjs`（28 个位点的表驱动测试，按抛出模块核对，并计数编译产物里的抛出点）。

### S8 `MISSING_IMPLEMENTATION`：六个抛出点、三种形状、字段全部必填

码不变。0.6 的 `details` 有四种形状，其中目录里"family 未被接纳"的位点缺 `available`，`set.load()` 里"候选不属于本集合"的位点只有 `{ revision }` 且 `revision` 可能是 `undefined`。0.7 收成三种，字段全部必填：

| 抛出点 | 0.6 `details` | 0.7 `details` |
|---|---|---|
| Binding 赋值：没有被接纳的修订满足引用的版本意图与 Contract（规划器） | `{ binding, implementation, version, available }` | 不变 |
| 裸 Contract / `auto()` 位点没有实现者（图构建器，两处） | `{ contract, site }` | 不变 |
| 实现引用指向未被接纳的 family（`catalog.resolve()`、`set.resolve()`、`Binding.parse()` 后的规划） | `{ contract, implementation, version }` | `{ contract, implementation, version, available: [] }` |
| 实现引用的版本意图没有候选满足 | `{ contract, implementation, version, available }` | 不变 |
| `set.load()` 收到本集合没有的候选（另一个 Runtime 的 `CandidateRef`，slot id 恰好相同） | `{ revision }`（可能 `undefined`） | `{ contract, implementation, version, available }`：从键 `family@version` 解析，`available` 是本集合持有的该 family 的版本 |

`revisionKey` 不是 `family@version` 形式的 `CandidateRef` 不可能来自任何 Runtime，`set.load()` 以 `INVALID_DESCRIPTOR { descriptor: 'CandidateRef', problem: 'not-from-this-runtime' }` 拒绝（S7 的第 27 个位点）。测试：`packages/core/tests/v07-s8-missing-implementation.test.mjs`（六个位点各一例，`details` 逐键断言，编译产物里的抛出点计数为 6）。

### S2 `UNSETTLED_ATTEMPT` → 无抛出点，从 `SynaErrorCode` 移除

0.6 的三个抛出点在 S1 与 S2 之后都不存在：deadline 到期不再把 slot 判 `failed`（同一 slot 的 `load()` 加入运行中的 attempt，恢复路径的守卫因此不可达，改为内部不变量 `Error('Syna internal invariant: …')`）；`env.dispose()` / `runtime.dispose()` 不再因用户代码不响应取消而拒绝。没有抛出点的码不保留（与 S6/S7 的处理一致；评审批准 PROPOSAL §12 Q6 (b)）。替代物是账本与事件：

| 抛出点 | 0.6 `details` | 0.7 | 替代 |
|---|---|---|---|
| `env.dispose()` 结束时仍有 attempt 在运行或回滚 | `{ env, state, slots: { slot, revision, attempt, phase, dependencies }[] }` | 不再拒绝；`env.state === 'disposed'` | 每个 attempt 一条 `attempt-abandoned { phase, slot, revision, env, elapsedMs, dependencies }`（`dependencies` 即原 `details.slots[].dependencies`）；`env.inspect().abandonedAttempts`、`runtime.inspect().unsettledAttempts` |
| `runtime.dispose()` 结束时账本非空 | `{ attempts }` | 不再拒绝 | 一次 `attempts-outstanding { attempts }`（`attempts` 与 `runtime.inspect().unsettledAttempts` 同形） |
| 恢复（`recover` / 新序列）时上一 attempt 未兑现 | `{ slot, revision, attempt, runningForMs }` | 不可达：未兑现的 attempt 只属于 `abandoned` 的 slot，`load()` 先以 `SLOT_NOT_LOADABLE` 拒绝 | 内部不变量（无公开码） |

`dispose()` 仍会拒绝的只有关闭自身的错误：某个 cleanup 抛出时的 `AggregateError`（`Runtime → Env → Service` 嵌套不变），其中不再有带 `code` 的成员。

### S10 `asSynaError()`：包装外来错误时 `details.cause` 固定为 `{ name, message }`

`asSynaError()` 是核心内部的辅助函数（`packages/core/src/errors.ts`，不在 `index.ts` 的导出里，仓库内目前没有调用方），公开 API 不变。0.6 只把 `Error` 实例放进 `cause`，非 `Error` 值丢失。0.7：`SynaError` 原样通过（不论码）；其他任何值都被包装——`details` = 抛出位点的 `details` 加上固定的 `cause: { name, message }`（`Error` 取 `name` / `message`；其他值取 `typeof` 与 `String()`），原值不论类型都放在 `cause`；不再从外来对象上读任何别的东西（`code`、`details`、`cause` 都不读）。返回类型是 `SynaError | (SynaErrorOf<Code> & { details: { cause: { name, message } } })`。测试：`packages/core/tests/v07-s10-as-syna-error.test.mjs`（直接从 `dist/errors.js` 导入；同时断言 `dist/index.d.ts` 不导出它）。

## §4 语义修订 S1 / S2

正文在 `docs/SEMANTIC_MODEL.md` §11 / §13，登记在 `docs/SEMANTIC_CHANGES_V07.md`。

### S1 `setupDeadlineMs` 是等待者的超时，不是 attempt 的期限

0.6：deadline 到期时 attempt 被判 `timed-out`，slot 进入 `failed`，迟到的成功被丢弃并执行 cleanup（`late-setup-result`），raw Promise 兑现前对同一 slot 的 `load()` 以 `UNSETTLED_ATTEMPT` 拒绝，到期还消耗一次 `failure.attempts` 并触发 `delayMs` 退避。

0.7：deadline 只限定**一次 `load()` 等待当前 attempt** 的时长（Service 选项与 `limits.setupDeadlineMs`，默认仍 `30_000`）。到期时该等待者以 `INITIALIZATION_TIMEOUT` 拒绝，`details` 在原有字段上加 `attemptStillRunning: true`（`note` 文字相应改写）；slot 保持 `starting`，`env.inspect()` 对该节点报告 `overdueMs`，`runtime.inspect().unsettledAttempts` 以 `timed-out` 列出该 attempt，每个 attempt 只发一次 `attempt-overdue` 事件（`{ slot, revision, env, attempt, deadlineMs, elapsedMs }`）。之后的 `load()` 加入仍在运行的 attempt，各自计算自己的等待窗口（重试开始新 attempt 时重新计时，`delayMs` 退避期间不计时）。attempt 随后成功且 owner Env 仍 `ready`：实例被接纳——slot `ready`，所有仍在等待的 `load()` 兑现，不执行 cleanup，`late-setup-result` 带 `adopted: true`；随后失败：走原有失败路径（sticky / attempts / retry-on-next-load 不变，`late-setup-failure` 报告）。到期**不消耗** `attempts`，也不触发 `delayMs`。只有关闭会丢弃迟到的成功：现有有界关闭语义不变（abort → grace → abandoned → 丢弃并 cleanup，`late-setup-result` 带 `adopted: false`）。eager 场景 `enter()` 是等待者：到期即 `ENTRY_ACTIVATION_FAILED`（`causeCode: 'INITIALIZATION_TIMEOUT'`，`causeDetails.slot` 指向 overdue 的 slot），回滚关闭新 Env，其迟到成功因此被关闭丢弃——这是上一条的推论，不是例外。不新增任何公开选项：更短的等待用 `load({ signal: AbortSignal.timeout(ms) })`（`LOAD_CANCELLED`；被取消的等待者连同它的 deadline 一起离开）。

需要检查的用户代码：

- 把 `INITIALIZATION_TIMEOUT` 当作"该 Service 已失败、稍后会重试"的代码：0.7 中 slot 仍在 `starting`，再次 `load()` 会加入同一 attempt 而不是触发恢复；要更短的等待用 `AbortSignal.timeout()`。
- 依赖"迟到的成功会被丢弃并清理"的代码：迟到的成功现在成为实例，它通过 `onDispose` 登记的清理在 Env 关闭时执行。
- 监听 `late-setup-result` 的诊断代码：新字段 `adopted` 区分接纳与丢弃；新增事件 `attempt-overdue`；`EnvInspectionNode` 新增可选字段 `overdueMs`。
- 断言超时后 `env.inspect().nodes[i].state === 'failed'`、或 `load()` 在超时后得到 `UNSETTLED_ATTEMPT` 的测试：现在分别是 `'starting'`（带 `overdueMs`）与加入 attempt。

### S2 `env.state` 只由 Runtime 动作推进；账本与 GC 解耦；`dispose()` 不再因用户代码不响应取消而拒绝

0.6：有界关闭结束后，若有 attempt 被放弃，`dispose()` 以 `UNSETTLED_ATTEMPT` 拒绝，`env.state` 保持 `'disposing'`，直到该 attempt 迟到兑现或其 setup Promise 被 GC 回收（`attempt-unreachable`）才变为 `'disposed'`；父 Env 的 `state` 同样等待后代的 attempt；`runtime.dispose()` 账本非空时以 `UNSETTLED_ATTEMPT` 拒绝；`run()` 在回调成功但关闭放弃了 attempt 时拒绝（结果挂在错误的不可枚举 `result` 上）。

0.7：`env.state` 只由 Runtime 的动作推进：`activating → ready → disposing → disposed`。有界关闭完成（后代已关、cleanup 已执行或 grace 已到）时，无论是否还有被放弃的 attempt，`state = 'disposed'`，Env 离开树与注册表（`liveEnvCount` / `rootEnvCount` 减少），之后任何事件（迟到兑现、GC）都不再改变它。被放弃的 attempt 记录在 `runtime.inspect().unsettledAttempts` 与新增的 `env.inspect().abandonedAttempts`（该 Env 拥有的 slot 的账本项；父 Env 不列出后代的）；attempt 兑现（成功或失败，都因 owner 已关闭而被丢弃并 cleanup）时从账本移除并发出原有的 `late-setup-result { adopted: false }` / `late-setup-failure`。`FinalizationRegistry` 只用于账本的额外收缩与 `attempt-unreachable` 事件。`dispose()` 不再因用户代码不响应取消而拒绝：被放弃的 attempt 由 `attempt-abandoned` 事件（新增字段 `dependencies`，即 0.6 报告里的依赖列表）与账本报告；`env.dispose()` / `runtime.dispose()` 只在关闭自身出错（cleanup 抛出）时以 `AggregateError` 拒绝；`runtime.dispose()` 结束时若账本非空，发出一次 `attempts-outstanding { attempts }`（仍先给正在结算的 cleanup 最多一个 grace）。`run()` 在只有 attempt 被放弃时以回调结果兑现；关闭出错时错误上的不可枚举 `result` 不变。`UNSETTLED_ATTEMPT` 从 `SynaErrorCode` 移除（§3）。

需要检查的用户代码：

- `await env.dispose().catch(…)` / `runtime.dispose().catch(…)` 里按 `code === 'UNSETTLED_ATTEMPT'` 分支的代码：该拒绝不再发生；改为订阅 `attempt-abandoned` / `attempts-outstanding`，或在关闭后读 `runtime.inspect().unsettledAttempts` / `env.inspect().abandonedAttempts`。仍需处理的拒绝只有 cleanup 抛出的 `AggregateError`。
- 轮询 `env.state === 'disposing'` 以等待迟到 attempt 结算的代码：`state` 在有界关闭结束时即为 `'disposed'`；要等待结算，改为等待 `runtime.inspect().unsettledAttempts` 变空（或对应的 `late-setup-*` / `attempt-unreachable` 事件）。
- 把 `state === 'disposed'` 当作"所有资源已释放"的代码：被放弃的 attempt 迟到兑现时其 cleanup 才执行；账本为空才是资源全部释放的信号。
- `run()` 的调用方：回调成功且关闭只放弃了 attempt 时得到结果本身，不再是带 `result` 的错误。
- 依赖 `--expose-gc` 断言 `state` 的测试：0.7 中没有任何 `state` 断言依赖 GC；GC 相关断言只剩账本收缩与 `attempt-unreachable`。
- Hyla-mini：`SiteManagerSettings.onDisposalError` 不再因被放弃的 attempt 被调用；`HylaApp.close()` 的 `errors` 只含 cleanup 错误，`unsettledAttempts` 仍来自账本。

## §5 迁移步骤

1. 升级后先跑类型检查：每个过期名字都是编译错误（缺失的导出、多余的属性），没有静默通过的别名。
2. 跑测试：三处运行时拒绝——定义里的 `scope`、参数记录里的 `scope` / `reuse`、`createRuntime()` 的四个嵌套记录——都是带出路的 `TypeError`。
3. 数据不需要重写。想找出仍是 0.5 形式的存储文档，订阅 `diagnostics.onEvent` 里的 `legacy-implementation-ref`（`site` 说明是哪条读取路径）。
4. 按 §3 改错误分支：`isSynaError(e, 'FRESH_CONSTRAINT_FAILED')` → 三个码之一；`isSynaError(e, 'INVALID_ENV_STATE')` → 四个码之一；`UNSETTLED_ATTEMPT` 分支删除；读 `INVALID_DESCRIPTOR` / `MISSING_IMPLEMENTATION` 的 `details` 的代码按新形状取键。类型层面每个已删除的码都是编译错误。
5. 按 §4 检查 S1/S2 的用户代码模式：把 `INITIALIZATION_TIMEOUT` 当作"attempt 已死"的分支、依赖"迟到成功会被丢弃"的清理逻辑、`dispose().catch(…)` 里的 `UNSETTLED_ATTEMPT` 分支、轮询 `env.state === 'disposing'` 的等待逻辑、以 `--expose-gc` 断言 `state` 的测试。
