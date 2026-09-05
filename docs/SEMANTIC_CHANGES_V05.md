# Syna v0.5 语义变更说明（SEMANTIC_CHANGES_V05）

本文记录 v0.5 相对 Syna Core Semantic Model v0 / v0.4 实现的保留项与修订项。每一条都对应仓库中的测试；不以"已证明无 bug"作为结论。

## 1. 保留的 v0 核心

| 项 | 说明 | 证据 |
|---|---|---|
| Runtime 有限、封闭、不可变；构造不创建 Env/slot/实例 | `createRuntime()` 只编译定义；未知定义 `MISSING_SERVICE` | `tests/v05-definitions.test.mjs` K01 |
| 每个 Env 由一次 Entry invocation 创建；单父森林 | `runtime.enter` → root；`env.enter` → child | `core.test.mjs` |
| 同 Env 同 resolved node 只有一个 canonical slot；slot 变更沿 reverse dependency 传播；结构 SCC 一起分叉 | 规划器固定点 | `core.test.mjs`, `v05-cache-cleanup.test.mjs` R19 |
| Input 是 Entry 外部事实：省略继承，显式重提供即新 slot（即使同对象），presence 与 undefined 分开 | `prepareInputs` | `v05-planner.test.mjs` R16 |
| Binding 同 revision 重赋值归一化为 no-op；不同选择分叉消费者 | `prepareBindings` | `hardening.test.mjs`, R16 |
| `uniqueWithin: 'lineage'` 持久承诺 | 见 §3 | R13 |
| 多版本 Service 共存；Contract 无实例生命周期 | 不变 | `contracts.test.mjs` |
| dependant-first SCC DAG 清理；SCC 内逆完成顺序 | `Materializer.disposeServiceSlots` | `lifecycle.test.mjs`, R19 |

## 2. 撤回的 v0.4 行为（不是兼容目标）

| v0.4 行为 | v0.5 | 原因 |
|---|---|---|
| `load()` 在 setup 内加入"完成 barrier"，未 await 的 load 也拖住调用者 | `load()` 返回普通 Promise，无隐藏义务 | K07；JS 无法得知是否 await；barrier 使 catch 降级、race、后台预取全部失效（ISSUES I-02/I-03/I-04） |
| 基于 AsyncLocalStorage 的强等待图 + 即时 `CIRCULAR_MATERIALIZATION` | 无 ALS；每个 attempt 的 refs 显式携带来源，只用于诊断；真正 pending 由**可配置 initialization deadline** 报告 `INITIALIZATION_TIMEOUT`（附 pendingLoads 与"疑似 load 环"的观察） | K07；不用短静默期把疑似环判成 sticky failure |
| activation transaction：owner 未 Ready 时 Service-owned Entry 可进入并返回 Ready child | 普通 `enter` 只接受 Ready anchor；owner 未 Ready → `OWNER_NOT_READY`（普通可 catch 的拒绝） | K02/K10/H13；禁止 Prepared/假 Ready |
| `preload()` 是"唯一非阻塞形式" | `preload()` 保留为兼容 wrapper：启动真实 slot，失败服从同一 failure policy，之后的 `load()` 可观察到 | §6 |
| 手写 semver（无 union、prerelease 比较不完整） | npm `semver`（`includePrerelease: true`），版本必须完整；范围在 `Binding.to`/`range()` 定义时校验 | K06 |
| rollback 失败后继续重试 | rollback 失败结束本轮 sequence，报告 AggregateError | K08（I-08） |
| 私有 Entry 的 range root 只看 admitted | 私有 realm = owner 的 exact 闭包；exact 与 range 一致 | K10/R07（I-06） |
| `Input.load()` 吸收 thenable 载荷 | `InputRef.read()` 同步返回原载荷；`load()` 弃用并诚实返回 `Awaited<T>` | K05/R05（I-01） |

## 3. parent-only 复用与 lineage anchor

- 普通复用只针对 **parent 当前可见** 的 slots（parent 当前 slot 可以由更早祖先拥有）。不恢复被 parent 遮蔽/移出的历史普通 slot。R12：Binding A→B→A 的 flip-back 新建 A 实例，同时祖先拥有且 parent 可见的 Database 仍复用。
- 固定点：初始候选 = parent 有同名同 kind 同 label 的节点且不在 fresh 内；随后移除任一依赖 slot 不一致的节点并沿 reverse dependency 传播。`reference-planner.test.mjs` 用穷举子集证明该结果是唯一最大合法复用集（仅覆盖 exact/Input/fresh 子模型）。
- lineage anchor 持久化在 plan 中：某 Env 通过 Binding 翻转丢掉 unique Family 后，后代重新用到该 Family 时，若全部当前依赖 slot 与 anchor 的记录一致 → 复用 anchor slot；否则 `LINEAGE_UNIQUENESS_CONFLICT`，details 给出 `anchor-dependency-mismatch` 与冲突链。绝不悄悄开第二实例。siblings 在共同祖先未锚定时各自锚定。
- 注意：子 Env 的图总是包含继承的 root sites，因此"中间 Env 不用该 Family"只能通过 Binding 改变（或 Input 重提供导致 unique 直接冲突）出现，测试即以此构造。

## 4. 普通 Promise 与 Attempt/Waiter

- 一个逻辑 slot 同时最多一个未结束且未清理的 attempt。并发 waiters join 同一 attempt。`load({ signal })` 只结束自己的等待（`LOAD_CANCELLED`），attempt 继续。
- attempt 超时后 raw setup Promise 仍在运行：slot 标记 `failed`，`unsettledAttempt` 阻止重叠的新 attempt（`UNSETTLED_ATTEMPT`）；迟到结果被丢弃、其 `onDispose` 清理被执行、通过 `diagnostics.onEvent` 报告（`late-setup-result` / `late-setup-failure`）。setup 在超时（或 owner 关闭）之后才调用的 `onDispose()` 仍被接受并在迟到结算时执行——迟到获得的资源正是必须释放的资源；只有 raw Promise 已结算后的过期 lifecycle 才被拒绝（`INVALID_ENV_STATE`）。
- 每次 `load()` 返回调用者自己的 Promise（共享同一 attempt）：忘记处理的失败在任何 slot 状态下都是普通的 unhandled rejection；已 abort 的 `signal` 直接得到 `LOAD_CANCELLED`，不会启动休眠 slot。
- 关闭：先把**整棵子树**（自身与所有后代）同步置为 `disposing` 并 abort 各自 signal（拒绝新工作、广播取消），再并发等待各子树关闭，再给本 Env 拥有的每个在途 attempt（正在运行的和已超时的）最多 `disposal.graceMs` 的结算时间（各 slot 并发计时，所以整体上界是一个 grace，与 `setupDeadlineMs`——包括 `Infinity`——无关），然后 dependant-first 清理（顺序也穿越从未启动的中间 slot）。仍未结束的 attempt 标记 `abandoned`，`dispose()` 以 `UNSETTLED_ATTEMPT` 报告；此时 Env **保持 `disposing`**、继续被 `inspect()` 计数、后续 `runtime.dispose()` 再次报告它，直到迟到结果到达并清理完毕才成为 `disposed`——不宣称完全 Disposed。
- 运行时 `Ready` = 该 Env 拥有的全部 eager slots Ready；继承 eager 不重启；未声明等待关系的 eager 无顺序保证。

## 5. Contract、C.all、refs

- 裸 Contract：唯一 family 或 `AMBIGUOUS_IMPLEMENTATION`；`auto(C)` 无策略 → `MISSING_AUTO_POLICY`；策略异常按原类型抛出，不吞为 UNSAT；策略必须恰好返回每个候选一次（`INVALID_DESCRIPTOR`）。
- `C.all` 纳入全部 admitted 且兼容的 exact revisions，不按 Family 折叠；与 direct dependency 命中同节点共享同 slot；成员 slot 变化传播到集合与消费者；不能共存则整份 Entry 无解。
- catalog 只读；PersistentImplementationRef 保存 family/version intent；没有目标 Family 时 `MISSING_IMPLEMENTATION`，不换供应商；`CandidateRef` 只在其所属集合有效（`CONSTRAINT_VIOLATION`）。
- `C.selector` 仅作最小兼容：候选按 anchor 的子世界 check；`open()` 需要 Ready anchor，activation 期间 `OWNER_NOT_READY`。

## 6. override 的 compiled view

`override(Source, Fake)` 在 Runtime 编译期产生内部 `CompiledService`：

| 字段 | 来源 |
|---|---|
| key / family / version / provides / eager / uniqueWithin / metadata | Source |
| requires / setup / failure / setupDeadlineMs | Fake |

exact/range/裸 Contract/auto/all/Binding/refs/fresh/share/check 全部使用同一 compiled view。Fake 的私有依赖进入内部闭包；Fake 不自动公开；若另行 admitted 则成为独立候选。重复 source、self、cycle → 错误。Runtime 不能验证 Fake 的行为兼容，只有 TypeScript 检查实例类型可赋值。

## 7. 权限来源（realm）

- 公开 Entry（`runtime.enter`、`env.enter`、`env.bind`）只能引用 admitted revision。
- Service-owned Entry 的 roots 以 owner 的私有 realm 解析：admitted ∪ owner 的 exact 传递闭包（含其 Entry 的 exact roots）。range 只能在**已知**的 revision 中选择——一个仅有 `Family.range()` 引用、没有任何 exact 引用的 revision 对 Runtime 不存在。
- Contract/auto/selector/all 的候选发现始终公开。

## 8. check() / explain()

只规划，不执行 setup、不发布 Env、不留下 anchor。`explain()` 输出 inherited/new/forked 的 Service 数、Input/synthetic 数、待启动 eager 数、候选选择、每个非继承节点的 cause 与 path；参数缺失时给出 `missingInputs`/`missingBindings`——无论缺失的是 Entry 声明的参数，还是图深处某个 Service 需要而 lineage 未提供的 Input/Binding，也包括 `UNSATISFIABLE_TOPOLOGY` 各候选失败中的缺失。搜索预算耗尽 → `PLANNING_BUDGET_EXCEEDED`（budget error，不是无解证明）。

候选回溯只归因于与选择相关的失败：若某 choice site 的**每个**候选都以完全相同的错误（同 code、同 site、同 details）失败，该失败与选择无关（例如更深处缺失的 Input、别处的 share 违约），按其自身 code 抛出/解释，而不是包装成 `UNSATISFIABLE_TOPOLOGY`；诊断结果因此不依赖 `requires` 键的声明顺序。候选之间失败不同才是 UNSAT，`details.failures` 保留逐候选原因。

## 9. 明确不做（本轮）

跨祖先历史实例搜索、Prepared/activation group、Env merge/多父/动态 caller Env、Runtime 热装卸、reactive Input、跨进程 singleton、自动 Contract adapter、更精巧的 Promise/effect DSL、`implSelector` 新公共拼写。
