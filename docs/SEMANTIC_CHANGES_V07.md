# Syna v0.7 语义变更说明（SEMANTIC_CHANGES_V07）

本文记录 v0.7 相对 v0.6（其语义与 v0.5 逐字相同）的保留项、澄清项、修订项与撤回项，格式沿用 `docs/SEMANTIC_CHANGES_V05.md`。每一条都对应仓库中的测试；不以"已证明无 bug"作为结论。任务书之外的公开名字一个不改、不加、不删（`docs/MIGRATION_V06_TO_V07.md` §1 与 `scripts/tests/api-inventory.test.mjs` 断言清单差异恰好是登记的删除与新增）；S1、S2、S6 之外的语义一字不动。

## 1. 保留

| 项 | 说明 | 证据 |
|---|---|---|
| 规划层零变化 | plan、复用固定点、lineage anchor、候选回溯、`check()` / `explain()` 的输出逐字不变；只有 S6 改名（`CONSTRAINT_VIOLATION` → `INACTIVE_REUSE_TARGET`，加 `constraint: 'fresh'`）与 S2 的新字段（`abandonedAttempts: []`）登记在快照测试的 RENAMED / ADDED 表里，记录本身不变 | `packages/core/tests/reference-planner.test.mjs`（穷举参考 planner 差分）、`v06-snapshots.test.mjs`（0.5.0 记录的 check/explain/inspect/catalog/错误快照） |
| v0.5 §1 的全部核心 | Runtime 有限、封闭、不可变；每个 Env 由一次 Entry invocation 创建；canonical slot 与 reverse-dependency 传播；Input/Binding 规则；`uniqueWithin: 'lineage'`；多版本共存；dependant-first SCC 清理 | `core.test.mjs`、`v05-definitions`、`v05-planner`、`v05-cache-cleanup`、`lifecycle`、`contracts` 的断言未改 |
| 普通 Promise 与 attempt/waiter 的其余规则 | 一个 slot 同时最多一个未结束的 attempt，并发 waiter join 同一 attempt；`load({ signal })` 只结束自己的等待（`LOAD_CANCELLED`），已 abort 的 signal 直接 `LOAD_CANCELLED` 且不启动休眠 slot；每次 `load()` 返回调用者自己的 Promise；被取消的等待者不留下 unhandled rejection；rollback 失败终局（`ROLLBACK_FAILED`）；`retry-on-next-load` 冷却；运行时 Ready = 全部 eager slot Ready | `v05-attempts`（R09 的单飞恢复以失败的首个 attempt 保留）、`v05-promises`、`v05-review-lifecycle` R-1（rollback 终局）与 R-1/R-4 取消路径、`hardening`、`lifecycle` |
| 等待环的观察 | 互相 await 的 setup 环由各自等待者的超时结束：每个 `load()` 以 `INITIALIZATION_TIMEOUT` 拒绝，`details.pendingLoads` / `suspectedWaitCycle` 仍是观察而不是死锁证明；环内 slot 最终 `failed`，因为它们自己内部的等待超时了 | `hardening`、`lifecycle`、`v05-promises` R04、`apps/features-demo`（断言未改） |
| 有界关闭的结构 | 先把整棵子树同步置 `disposing` 并 abort 各自 signal，再并发等待各子树，再给本 Env 拥有的每个在途 attempt 最多一个 grace，再 dependant-first 清理（穿越从未启动的中间 slot）；后代先关，所以每层最多一个 grace；被放弃 attempt 的依赖照常按顺序关闭（模型没有撤销与强杀，§14） | `v05-audit-lifecycle` F-PL-01（有界）、F-PL-03（广播）、F-PL-05（顺序）、`v05-review-lifecycle` R-3（20 个卡住的 Env 在一个 grace 内关闭）、R-4（依赖照常关闭并被报告） |
| 默认值 | `limits` 默认 30_000 / 2_000 / 10_000 / 512 逐字锁定 | `v07-expired-forms`（源码常量、类型声明注释、API_REFERENCE 示例） |
| 错误的触发条件与文案 | S6/S7/S8 只改码与 `details`，每个抛出点的消息逐字不变 | `v07-s6-reuse-errors`、`v07-s7-env-state`、`v07-s8-missing-implementation`（逐位点断言消息） |
| 持久化键 | `implementationId` 永久可读（每次 Runtime 读取报告一次 `legacy-implementation-ref`），`kind === 'persistent-implementation-ref'` 不变；JSON 只写 `familyId` | `v07-legacy-implementation-key`、`apps/hyla-mini/tests/v06-compat.test.mjs` |
| Contract、`C.all`、refs、override、realm、`check()` / `explain()` | v0.5 §5–§8 全部不变；`C.all` 的每个候选都是当前拓扑里的真实节点（selector 遗骸删除后 `set.load(candidate)` 就是可用性本身，§5） | `contracts`、`v05-realms-override`、`v05-planner`、`v05-audit-planning`、`v07-expired-forms` |

## 2. 澄清（S7、S8、S10）

澄清 = 触发条件、文案与规划行为不变，只有码和 `details` 变得能被程序区分；映射表在 `docs/MIGRATION_V06_TO_V07.md` §3。

| 项 | 0.6 | 0.7 | 证据 |
|---|---|---|---|
| S7 `INVALID_ENV_STATE` | 16 个抛出点、至少六种含义共用一个码 | 按含义拆为 `ENV_CLOSED`（关闭中/已关闭的 Env 拒绝的每种操作）、`RUNTIME_CLOSED`（已 dispose 的 Runtime）、`SLOT_NOT_LOADABLE`（disposing / disposed / abandoned 的 slot）、`LIFECYCLE_MISUSE`（attempt 结算后的 `onDispose()`）；调用方无法到达的位点是没有公开码的内部不变量（`Error('Syna internal invariant: …')`，S2 之后共五处）；`INVALID_ENV_STATE` 离开 `SynaErrorCode`；`ENTRY_ACTIVATION_FAILED.details.causeCode` 相应为 `ENV_CLOSED` | `v07-s7-env-state`（每个可达位点一例，`details` 逐键断言，编译产物里的抛出点计数） |
| S7 `INVALID_DESCRIPTOR` | 28 个抛出点，`details` 多为 `{}`，少数各带不同键 | 一种形状 `{ descriptor, problem, site?, path? }`，`problem` 取自封闭词表；`revisionKey` 不是字符串或不是 `family@version` 的 `CandidateRef` 也是 `INVALID_DESCRIPTOR` | `v07-s7-invalid-descriptor`（28 行表驱动，按抛出模块核对，编译产物计数恰为 28） |
| S8 `MISSING_IMPLEMENTATION` | 四种 `details` 形状，其中一处缺 `available`，一处只有 `{ revision }` 且可能是 `undefined` | 三种形状，字段全部必填：`{ binding, implementation, version, available }`、`{ contract, site }`、`{ contract, implementation, version, available }` | `v07-s8-missing-implementation`（六个位点各一例，无 `undefined` 必填字段，编译产物计数为 6） |
| S10 `asSynaError()` | 只把 `Error` 实例放进 `cause`，其他值丢失 | `SynaError` 原样通过；其他任何值都被包装：`details` = 位点 `details` + 固定的 `cause: { name, message }`，原值不论类型放在 `cause`，不再从外来对象读别的东西 | `v07-s10-as-syna-error`（核心内部，不导出：同时断言 `dist/index.d.ts` 不导出它） |

## 3. 修订（S1、S2、S6）

正文在 `docs/SEMANTIC_MODEL.md` §11（S1）、§13（S2）与 §10 / `docs/API_REFERENCE.md` 的 `reuse` 段（S6）；迁移与需要检查的用户代码模式在 `docs/MIGRATION_V06_TO_V07.md` §3（S6）、§4（S1、S2）。

### 3.1 S6 `FRESH_CONSTRAINT_FAILED` 按抛出点拆成三个码

0.6 的四个抛出点里只有 `fresh` / `share` 目标在父世界不活动的两处和 `fresh` 有关；"继承的选择在该位点不再是候选"与"`CandidateRef` 属于另一个集合"挂在这个名下并不贴切（0.6 `DEFERRED` S6）。0.7：`INACTIVE_REUSE_TARGET { constraint: 'fresh' | 'share', env, revision | family }`、`INVALID_INHERITED_CHOICE { site, selectedKey, candidates }`、`FOREIGN_CANDIDATE_REF { expectedSourceSlot, receivedSourceSlot }`；旧码没有抛出点，离开 `SynaErrorCode`。可回溯集合（决定 `check()` / `explain()` 报告而非抛出、规划器是否回溯）用前两个码顶替旧码，规划行为按构造不变；`FOREIGN_CANDIDATE_REF` 由 `ImplementationSet` 在运行时抛出，从不可回溯；`SHARE_CONSTRAINT_FAILED` 不动。这是修订而不是澄清，因为一个码的三类抛出点被分到了不同的码，`isSynaError(e, 'FRESH_CONSTRAINT_FAILED')` 分支必须改写。

证据：`v07-s6-reuse-errors`（`INACTIVE_REUSE_TARGET` × {fresh, share} × {revision, family} 在 `check()`（报告）与 `enter()` / `run()` / `derive()`（抛出）上各一例；`INVALID_INHERITED_CHOICE` 通过目标在父子 plan 之间移动的 `forward()` 端到端复现；`FOREIGN_CANDIDATE_REF` 在 `load(ref)` 与 `load(candidate)` 上以互为镜像的 slot id 复现；`dist/` 里没有旧码字符串）。

### 3.2 S1 `setupDeadlineMs` 是等待者的超时，不是 attempt 的期限

- deadline（Service 选项与 `limits.setupDeadlineMs`，默认仍 `30_000`）限定**一次 `load()` 等待当前 attempt** 的时长；到期时该等待者以 `INITIALIZATION_TIMEOUT` 拒绝（`details` 加 `attemptStillRunning: true`），attempt 继续运行，slot 保持 `starting`（`env.inspect()` 报告 `overdueMs`），账本以 `timed-out` 列出它，`attempt-overdue` 每个 attempt 只发一次。
- 之后的 `load()` 加入仍在运行的 attempt，各自计算自己的等待窗口；重试开始新 attempt 时重新计时，`delayMs` 退避期间不计时。更短的等待是调用者自己的 `AbortSignal`（`load({ signal: AbortSignal.timeout(ms) })`）；被取消的等待者连同它的 deadline 一起离开。不新增公开选项。
- 迟到的成功在 owner Env 仍 `ready` 时被接纳：实例是 slot 的，仍在等待的 `load()` 兑现，不执行 cleanup，`late-setup-result` 带 `adopted: true`。只有关闭会丢弃迟到的成功（`adopted: false`，cleanup 执行）。迟到的失败走原有失败路径（`late-setup-failure`）。到期不消耗 `failure.attempts`，不触发 `delayMs`。
- `enter()` 是每个 eager attempt 的等待者：到期即 `ENTRY_ACTIVATION_FAILED`（`causeCode: 'INITIALIZATION_TIMEOUT'`，`causeDetails.slot` 指向 overdue 的 slot），回滚关闭新 Env，其迟到成功因此被关闭丢弃——上一条的推论，不是例外。
- 保留期由用户自己的 setup Promise 界定：raw Promise 在 `setup()` 之后只被弱引用，overdue 的 attempt 的 Promise 被回收即判定不可达（cleanup 执行，`attempt-unreachable`，序列走失败策略）。

证据：`v07-s1-waiter-deadline`——任务书 §2.4 的四个反例场景（慢成功被接纳且未 cleanup；owner 在 150 ms 关闭时丢弃并 cleanup，grace 之后与之内各一例；多个等待者先后超时后接纳；eager 到期回滚）；"到期不消耗 attempts、默认值仍 30_000"（带一个失败的对照 attempt 证明窗口重新计时）；迟到失败的 sticky 与 retry-on-next-load；`AbortSignal.timeout(20)`；恢复冷却期与 setup 内部的等待者；`--expose-gc` 的不可达路径只断言账本与事件。

### 3.3 S2 `env.state` 只由 Runtime 动作推进；账本与 GC 解耦；`dispose()` 不再因用户代码不响应取消而拒绝

- `env.state`：`activating → ready → disposing → disposed`，只由 Runtime 的动作推进。有界关闭完成（后代已关、cleanup 已执行或 grace 已到）时，无论是否还有被放弃的 attempt，`state = 'disposed'`，Env 离开树与注册表；之后任何事件（迟到兑现、GC）都不再改变它。
- 账本：被放弃的 attempt 记录在 `runtime.inspect().unsettledAttempts` 与新增的 `env.inspect().abandonedAttempts`（该 Env 拥有的 slot 的账本项；父 Env 不列出后代的）。attempt 兑现（成功或失败，都因 owner 已关闭而被丢弃并 cleanup）时从账本移除并发出原有的 `late-setup-result { adopted: false }` / `late-setup-failure`。`FinalizationRegistry` 只用于账本的额外收缩与 `attempt-unreachable`；任何 `state` 断言的测试不依赖 `--expose-gc`。
- `dispose()` 的返回：被放弃的 attempt 不是关闭的错误——`attempt-abandoned` 事件（新增 `dependencies`，即 0.6 报告里的依赖列表）与账本报告它；`env.dispose()` / `runtime.dispose()` 只在关闭自身出错（cleanup 抛出）时以 `AggregateError` 拒绝；`runtime.dispose()` 结束时若账本非空，发出一次 `attempts-outstanding { attempts }`（仍先给正在结算的 cleanup 最多一个 grace）。`run()` 在只有 attempt 被放弃时以回调结果兑现。
- `UNSETTLED_ATTEMPT` 在 S1 与 S2 之后没有抛出点（运行中的 attempt 被加入而不是拒绝；恢复路径的守卫是内部不变量），从 `SynaErrorCode` 移除（评审批准 PROPOSAL Q6 (b)）。

证据：`v07-s2-state-and-ledger`——任务书 §2.4 的必做测试（`setup: () => new Promise(() => {})`：dispose 在 grace 后兑现，`state === 'disposed'`，`liveEnvCount` 减一，账本一项；Promise 被保持或释放引用、跨多个宏任务，`state` 都不变；迟到兑现后账本项移除、`adopted: false`、cleanup 执行、slot `disposed`）；父子 Env；`runtime.dispose()` 的一次汇总事件与 cleanup 抛出时仍拒绝且没有带码成员；回滚超出 grace；`run()` 直接返回结果；d.ts 表面。

## 4. 撤回登记

每一行写明被撤回的断言、它断言的旧语义与处置。"改写"= 测试保留场景，改为断言 0.7 行为；"码"= 只有错误码变（S6/S7 澄清，语义不变）；"删除"= 随别名或旧语义一起删除。

| 文件 · 测试 | 撤回的断言 | 它断言的旧语义 | 处置 |
|---|---|---|---|
| `v05-attempts` · R09 恢复在旧 attempt 运行时被拒绝 | 第二个 `load()` → `UNSETTLED_ATTEMPT`；迟到值被丢弃并 cleanup（`late-setup-result`）；之后 `attempts === 2` | 到期即 slot `failed`，迟到成功被丢弃，恢复被阻止 | 改写（S1）：第二个 `load()` 加入 attempt，成功被接纳（`attempts: 1`，无 cleanup，`adopted: true`）；单飞恢复以失败的首个 attempt 保留 |
| `v05-attempts` · K08 关闭报告永不结算的 attempt | `dispose()` 以 `UNSETTLED_ATTEMPT` 拒绝（`details.slots`）；`env.state === 'disposing'` | dispose 拒绝；state 等待结算或 GC | 改写（S2）：兑现；`disposed`；账本、`attempt-abandoned`、`attempts-outstanding`、slot `abandoned` 保留 |
| `v05-attempts` · K08 owner 开始关闭后才完成的 setup | `error.code === 'INVALID_ENV_STATE'` | — | 码 → `ENV_CLOSED` |
| `v05-audit-lifecycle` · F-PL-01 关闭受 grace 限定 | `disposal.ok === false` 且含 `UNSETTLED_ATTEMPT` | dispose 拒绝 | 改写（S2）：在上界内兑现；账本断言 |
| `v05-audit-lifecycle` · F-PL-01 `setupDeadlineMs: Infinity` | `disposal.ok === false`；`running.ok === false`（"run() 报告被放弃的 attempt"） | dispose / run 拒绝 | 改写（S2）：两者兑现且有界；`run()` 返回结果；账本三项 |
| `v05-audit-lifecycle` · F-PL-02 deadline 之后登记的 `onDispose` 由迟到结算执行 | 迟到结果之后资源立即关闭；`late-setup-result` | 迟到成功被丢弃 | 改写（S1）：被接纳（`adopted: true`），cleanup 在 `env.dispose()` 时执行 |
| `v05-audit-lifecycle` · F-PL-02 owner 关闭后登记的 `onDispose` | `dispose()` 拒绝 | dispose 拒绝 | 改写（S2）：兑现；cleanup 仍在结算时执行 |
| `v05-audit-lifecycle` · F-PL-02 过期 lifecycle | `INVALID_ENV_STATE` | — | 码 → `LIFECYCLE_MISUSE` |
| `v05-audit-lifecycle` · F-PL-03 广播 | 三处 `INVALID_ENV_STATE` | — | 码 → `ENV_CLOSED` / `SLOT_NOT_LOADABLE`（按位点精确断言） |
| `v05-audit-lifecycle` · F-PL-04 诚实的状态 | `dispose()` 拒绝；`state 'disposing'`；`runtime.dispose()` 拒绝；结算后才 `'disposed'` | state 跟随结算；dispose 拒绝 | 改写（S1+S2）：立即 `disposed`；兑现；事件序列 `attempt-overdue` → `attempt-abandoned` → `attempts-outstanding` → `late-setup-result`，账本断言 |
| `v05-audit-lifecycle` · F-PL-04 父 Env 诚实的状态 | `['disposing','disposing']` 再 `['disposed','disposed']`；`root.dispose()` 拒绝 | 父 state 跟随子的 attempt | 改写（S2）：两者 `disposed`；兑现；只有子 Env 的 `abandonedAttempts` 列出它 |
| `v05-review-lifecycle` · R-1 `INITIALIZATION_TIMEOUT` 之后迟到清理失败 → 终局 | 账本 `['timed-out','timed-out']`；迟到结果被丢弃并 cleanup；迟到清理失败后 `ROLLBACK_FAILED` | 迟到成功在结算时被丢弃并清理 | 改写（S1）：overdue 期间账本 `timed-out`，两者被接纳，cleanup 在 `dispose()` 时执行，抛出的 cleanup 是关闭错误；"迟到清理失败导致 `ROLLBACK_FAILED`"撤回（接纳时不清理，无法发生）；rollback 终局本身由同名的另一个 R-1 测试覆盖 |
| `v05-review-lifecycle` · R-1/R-4 取消路径 | 期望表里的 `'INVALID_ENV_STATE'` | — | 码 → `ENV_CLOSED` |
| `v05-review-lifecycle` · R-3 有界关闭 | `children.every(state === 'disposing')`（两处）；`runtime.dispose()` 以 20 个 attempt 拒绝 | state / 拒绝 | 改写（S2）：`disposed`；`attempts-outstanding` 带 20 项；账本与事件保留 |
| `v05-review-lifecycle` · R-3 保留期（`--expose-gc`） | `before.keptState === 'disposing'`；GC 后 `keptState === 'disposed'`、`keptSlot === 'disposed'` | state 跟随 GC | 撤回这些 state 断言；保留"Env 可被回收 / 两个 cleanup 都执行 / 两次 `attempt-unreachable` / 账本清空"（只看账本与事件的 GC 测试） |
| `v05-review-lifecycle` · R-4 被放弃 attempt 的依赖 | `UNSETTLED_ATTEMPT` 报告的 `details.slots[0].dependencies`（状态 `disposed`） | dispose 拒绝 | 改写（S2）：同一份 `dependencies` 列表在 `attempt-abandoned` 事件上（放弃时的状态 `ready`，随后按顺序关闭）；兑现；其余保留 |
| `v05-review-lifecycle` · R-5 grace 内到期的 deadline | `load` → `INITIALIZATION_TIMEOUT`（保留）；剩余 `≥ 300 ms`；拒绝；`'disposing'`；对照组同 | deadline 在 grace 内结算了序列 | 改写（S1+S2）：等待者超时，attempt 获得整个 grace，被放弃并列入账本，`disposed`；对照组同 |
| `v05-audit3-lifecycle-planning` · F-CL3-03 不可达（`--expose-gc`） | `keptState === 'disposed'` | state 跟随 GC | 撤回该断言；账本 / cleanup / 事件保留 |
| `v05-audit3-lifecycle-planning` · F-CL3-05a 回滚中 | 拒绝（文案 "were still rolling back"、`details.slots[].phase`）；`'disposing'`；`runtime.dispose()` 拒绝 | dispose 拒绝；state | 改写（S2）：兑现，`disposed`，`attempt-abandoned:rollback`，账本 `rolling-back` → 空，slot `disposed`，`attempts-outstanding` 一次 |
| `v05-audit3-lifecycle-planning` · F-CL3-05b 结算中 | 拒绝（三处）；`'disposing'`（两处） | 同上 | 改写（S2）：兑现；账本 `abandoned` → `settling` → 空；汇总事件只发一次（第二次 `runtime.dispose()` 不再发） |
| `v05-audit3-lifecycle-planning` · F-CL3-05c 结算的 grace | `INITIALIZATION_TIMEOUT`（保留）；拒绝；`'disposing'` | 同上 | 改写（S2）：兑现；`runtime.dispose()` 仍在 grace 内等待结算，没有汇总事件 |
| `v05-audit3-lifecycle-planning` · F-CL3-08 `run()` 的结果挂在关闭错误上 | 卡住的 setup 造成的关闭错误带 `result` | `run()` 因被放弃的 attempt 拒绝 | 改写（S2）：用抛出的 cleanup 造关闭错误（`result` 机制不变）；卡住的 setup 现在直接得到结果（`v07-s2-state-and-ledger` 断言） |
| `v06-m1-limits` · "每个旧嵌套记录映射到…" | `dispose()` 以 `UNSETTLED_ATTEMPT` 拒绝 | dispose 拒绝 | 随别名一半一起删除；默认值 / 校验用例只保留 `limits` 形式（`v07-expired-forms`） |
| `core` · disposed Env 不能 materialize；`v05-cache-cleanup` K09；`v05-definitions` K01（`runtime.dispose()` 后 `enter`）；Hyla-mini `site-manager` F-AP3-04 `cause.code` | `INVALID_ENV_STATE` | — | 码 → `ENV_CLOSED` / `SLOT_NOT_LOADABLE` / `RUNTIME_CLOSED`（按位点） |
| `contracts` `C.all` 的 CandidateRef；`v05-planner` R14、K03 | `FRESH_CONSTRAINT_FAILED` | — | 码 → `FOREIGN_CANDIDATE_REF` / `INACTIVE_REUSE_TARGET` |
| `hardening`、`lifecycle`、`v05-promises` R04、`features-demo` 等待环 | `INITIALIZATION_TIMEOUT` + 环观察 | — | 未改（等待者的超时与观察相同；环内 slot 因各自内部等待超时而 `failed`） |
| `apps/hyla-mini/tests/review-app` · R-2/R-3 `close()` 返回未结算的 attempt | `reported[0].errors` 含 `UNSETTLED_ATTEMPT`；`report.errors.some(UNSETTLED_ATTEMPT)` | Env / Runtime 的 dispose 拒绝 | 改写（S2）：`onDisposalError` 不因被放弃的 attempt 被调用；`report.errors` 为空；`report.unsettledAttempts`（账本）断言；`attempts-outstanding` 通过应用的 diagnostics 观察 |
| `v06-r1` … `v06-r6` 别名等价测试、`v06-compat` 标记 | 行使过期形式 | — | 随别名删除；其中别处未覆盖的 0.6 形式断言（调用形态的 `TypeError`、锚定调用形态、旧键的 `parse()`）迁入 `v07-expired-forms` / `v07-legacy-implementation-key` |
| `v06-snapshots` | RENAMED 映射表 | — | 加 ADDED 表：`constraint: 'fresh'`（S6）与 `abandonedAttempts: []`（S2）；记录不变 |
| `v06-t1-errors` | 22 个码；逐码 `details` 键 | — | 0.7 的 26 个码与形状（`v07-s7-env-state` 同时锁定 d.ts 里的码数与五处内部不变量） |
| `scripts/tests/api-inventory`、`deprecations`、`no-old-names` | 23 个弃用项、22 个码；别名清单；模式表 | — | 0 弃用项；26 个码；`EXPECTED = []`；模式表覆盖 23 个删除名、`FRESH_CONSTRAINT_FAILED`、`INVALID_ENV_STATE`、`UNSETTLED_ATTEMPT`、`availability`、`CandidateAvailability`、`AvailableImplementationCandidate` |

没有任何断言不变量的测试与 S1 或 S2 冲突：有界关闭、dependant-first 清理、`ROLLBACK_FAILED` 终局、单 attempt、`LOAD_CANCELLED`、eager Ready 规则与等待环观察都以相同断言继续通过。没有删除有效的反例测试换全绿：每个改写都保留原场景。

## 5. 到期删除（§2.1 / §2.2）

0.6 宣布到期的全部 23 个别名与 0.5 调用形态（`docs/MIGRATION_V06_TO_V07.md` §1 逐项列出替代写法与"仍写旧形式时"的结果），加上 selector 的最后遗骸（`ImplementationCandidate.availability`、`CandidateAvailability`、`AvailableImplementationCandidate`）。过期形式**被拒绝而不是被忽略**：定义里的 `scope`、参数记录里的 `scope` / `reuse`、`createRuntime()` 的四个嵌套记录都是指明现行形式的 `TypeError`。类型声明里没有任何 `@deprecated` 项；`scripts/tests/api-inventory.test.mjs` 断言公开 API 与 0.6.0 清单的差异恰好是登记的删除（23 + 3 + 三个错误码）与新增（S6/S7 的七个码、`EnvInspectionNode.overdueMs`、`EnvInspection.abandonedAttempts`）。序列化键 `implementationId` 不在其列：永久可读（§1）。

## 6. 明确不做（本轮）

`C.all` 共存放松、`primary()`、`ServiceFamily.range()`、`load({ timeoutMs })`、跨祖先复用、Prepared / 任何 barrier、Runtime 世代切换宿主，以及本轮发现的其他"顺手能改"的行为——一律不做，编号与理由在 `docs/DEFERRED.md`。
