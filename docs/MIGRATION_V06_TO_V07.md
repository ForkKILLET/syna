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

（S8、S10 随各自提交填写。）

## §4 语义修订 S1 / S2

（Phase D / E 填写；正文在 `docs/SEMANTIC_CHANGES_V07.md` 与 `docs/SEMANTIC_MODEL.md` §11 / §13。）

## §5 迁移步骤

1. 升级后先跑类型检查：每个过期名字都是编译错误（缺失的导出、多余的属性），没有静默通过的别名。
2. 跑测试：三处运行时拒绝——定义里的 `scope`、参数记录里的 `scope` / `reuse`、`createRuntime()` 的四个嵌套记录——都是带出路的 `TypeError`。
3. 数据不需要重写。想找出仍是 0.5 形式的存储文档，订阅 `diagnostics.onEvent` 里的 `legacy-implementation-ref`（`site` 说明是哪条读取路径）。
