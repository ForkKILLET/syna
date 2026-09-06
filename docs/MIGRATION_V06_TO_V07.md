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

（Phase C 填写：S6 `FRESH_CONSTRAINT_FAILED` 的拆分、S7 `INVALID_ENV_STATE` 的拆分与 `INVALID_DESCRIPTOR` 的统一 `details`、S8 `MISSING_IMPLEMENTATION` 的三种形状、S10 `asSynaError` 的 `details.cause`。）

## §4 语义修订 S1 / S2

（Phase D / E 填写；正文在 `docs/SEMANTIC_CHANGES_V07.md` 与 `docs/SEMANTIC_MODEL.md` §11 / §13。）

## §5 迁移步骤

1. 升级后先跑类型检查：每个过期名字都是编译错误（缺失的导出、多余的属性），没有静默通过的别名。
2. 跑测试：三处运行时拒绝——定义里的 `scope`、参数记录里的 `scope` / `reuse`、`createRuntime()` 的四个嵌套记录——都是带出路的 `TypeError`。
3. 数据不需要重写。想找出仍是 0.5 形式的存储文档，订阅 `diagnostics.onEvent` 里的 `legacy-implementation-ref`（`site` 说明是哪条读取路径）。
