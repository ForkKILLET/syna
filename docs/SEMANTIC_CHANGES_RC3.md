# Syna 1.0.0-rc.3 语义变更说明（SEMANTIC_CHANGES_RC3）

本文记录 1.0.0-rc.3 相对 1.0.0-rc.2 的保留项、澄清项、修订项与实现修正，格式沿用 `docs/SEMANTIC_CHANGES_V07.md`。本轮由一次独立审计驱动（`docs/HISTORY.md`）：审计在 rc.2 上复现了六组关闭路径问题，`work/rc3/BASELINE.md` 记录了七个探针的复现基线，仓库里的回归测试是它们翻转后的形态。每一条都对应仓库中的测试；不以"已证明无 bug"作为结论。

公开面只有一处增量（§5）：`attempt-abandoned.phase` 增加 `'cleanup'`。除此之外没有任何名字被改、被加、被删；规划层（`entry-planner`、`graph-builder`、`definition-compiler`、`plan-cache`）一行未动，reference planner 差分与 explain/inspect 快照逐字不变。

## 1. 保留

| 项 | 说明 | 证据 |
|---|---|---|
| 关闭的结构与顺序 | 先把整棵子树同步置 `disposing` 并 abort 各自 signal，再并发等待各子树，再给本 Env 拥有的每个在途 attempt 最多一个 grace，再 dependant-first 清理（穿越从未启动的中间 slot）；后代先关；被放弃 attempt 的依赖照常按顺序关闭 | `v05-audit-lifecycle` F-PL-01/03/05、`v05-review-lifecycle` R-3/R-4、`lifecycle`（全部未改） |
| `env.state` 与账本分离 | `disposed` 是有界关闭的终点，与还剩什么无关；任何状态断言都不依赖 GC；账本（`unsettledAttempts` / `abandonedAttempts`）记录关闭之后仍在的东西 | `v07-s2-state-and-ledger`、`v05-review-lifecycle` R-3（未改） |
| waiter 的报告 | `LOAD_TIMEOUT` 是等待者的报告而不是对 Service 的判决；`load({ signal })` 只结束自己的等待；被取消的等待者不留下 unhandled rejection | `v05-promises`、`v07-s1-waiter-deadline`、`hardening`（未改） |
| 失败与回滚 | 失败默认 sticky；回滚失败终局（`ROLLBACK_FAILED`）；`retry-on-next-load` 冷却；`onDispose()` 在 attempt 仍在执行期间一直可注册，之后 `LIFECYCLE_MISUSE` | `v05-review-lifecycle` R-1、`v05-attempts`、`v06-t1-errors`（未改） |
| 默认值与限额 | `limits` 默认 30_000 / 2_000 / 10_000 / 512 逐字不变；`disposalGraceMs` 仍是同一个数值，只是现在也是每个 Ready slot cleanup 阶段的预算 | `v07-expired-forms`（源码常量、类型声明、API_REFERENCE 示例；未改） |
| 规划层 | plan、复用固定点、lineage anchor、候选回溯、`check()` / `explain()` / `inspect()` 的输出逐字不变 | `reference-planner`、`v06-snapshots`（未改） |

## 2. 澄清（D1）

`docs/API_REFERENCE.md:162–163` 的注释还是 0.6 的定义——"`disposed` 只在本 Env 关闭所放弃的每个 attempt 都结算之后"——它与同一份文档 `:197` 和 `docs/SEMANTIC_MODEL.md` §13 自 0.7 起的定义相矛盾（0.7 S2 已经撤回了这个说法，`docs/SEMANTIC_CHANGES_V07.md`）。本轮删除该注释，改成与 §13 一致的一句：`disposed` 是有界关闭的终点，被放弃的 attempt 或 cleanup 活在账本里而不在状态里。

全文检查：`docs/` 中不再有"所有 abandoned attempt 结束后才 disposed"的表述。这是澄清，不是语义变化——实现从 0.7 起就是现在这样。

## 3. 修订

### 3.1 L1：Ready slot 的 cleanup 纳入有界关闭

**rc.2 的实现**：关闭的第 4 步逐个 `await` 每个 Ready slot 的 cleanup，没有任何上界。一个不结算的 `onDispose` 让 `env.dispose()` 永不兑现，整条关闭链（父 Env、`runtime.dispose()`、宿主的 shutdown）跟着停住。§13 说"关闭是有界的"，实现只对 attempt 做到了。

**rc.3 的规则**：

1. 每个 slot 的 cleanup 阶段各有一个预算，等于 `limits.disposalGraceMs`（不与 attempt 阶段共用，不由同一个 Env 内的其他 slot 分摊）。
2. 预算到期而 cleanup 未结束：停止等待。该 slot 记为被放弃的 cleanup——slot 置 `abandoned`，以产生该实例的 attempt 编号进账本（`state: 'abandoned'`，附 slot、revision、env、`elapsedMs`），发 `attempt-abandoned`，`phase: 'cleanup'`，`dependencies` 列出它可能仍在使用的依赖 slot。
3. 其余 slot 照常按依赖者优先顺序销毁，**包括被放弃 cleanup 的依赖**——§13 已经写下的"有界关闭的公认代价"，现在明确延伸到 cleanup。
4. 被放弃的 cleanup 后来结算：成功则从账本移除；抛错则从账本移除并发 `attempt-failed-late`（`error` 为该错误，多个时是 `AggregateError`；`cleanupErrors` 列出全部）。`dispose()` 不因被放弃的 cleanup 而拒绝——它已经返回了。
5. 独立 SCC 的销毁并发进行，每条依赖链内部的顺序（反向物化完成顺序，一次一个 slot）不变。一层的 cleanup 步骤因此是"最长依赖链的 slot 数 × 宽限期"，而不是"slot 数 × 宽限期"。
6. `signal` 在关闭第 1 步就已 abort，先于任何 cleanup；配合的 cleanup 本来就能观察到它。
7. `runtime.dispose()` 给被放弃的 cleanup 与迟到结算相同的一个 grace，然后把仍未结束的一并计入 `runtime-attempts-outstanding`。

**必须诚实的一句**：有界的是等待，不是资源释放。被放弃的 cleanup 仍在运行，它持有的资源仍被占用；JavaScript 无法强制终止它（§14）。Runtime 停止等待、如实上报、记进账本——保证到此为止。

文档：`docs/SEMANTIC_MODEL.md` §11（slot 状态图）与 §13（整节）、`docs/API_REFERENCE.md` 的 `limits.disposalGraceMs` 条目、`attempt-abandoned` 条目、"Ready and closing"与生命周期注记、`packages/core/src/descriptors.ts` 中 `RuntimeLimits.disposalGraceMs` 与 `UnsettledAttemptInspection.state` 的注释。

证据：`packages/core/tests/rc3-close-paths.test.mjs`（RC2-L1 两条）、`packages/core/tests/close-matrix.test.mjs`（`ready-hangs` 四格、并发销毁的链内顺序与上界两条）。

### 3.2 L2 / L2b：关闭期间的 cleanup 失败恰好一次可见

**rc.2 的实现**：关闭窗口内结算的 attempt，其被丢弃结果的 rollback 抛错时，错误进了 sequence 的 `AggregateError`，而 `settleSlot()` 只看 sequence"是否结算"，从不看它拒绝的理由——于是 `dispose()` 兑现，什么也不报。`attempt-succeeded-late` / `attempt-failed-late` 又只对"已经 overdue"的 attempt 发出，所以 waiter 已取消或已超时时，这个失败在任何地方都看不见。

**rc.3 的规则**：

1. 关闭**等待过**的每个 cleanup 失败——被销毁的 Ready slot 的 cleanup，以及在宽限期内结算、结果被这次关闭丢弃的 attempt 的 rollback——恰好一次进入该 Env `dispose()` 的 `AggregateError`（`run()` 走 `suppressed`），形态不变：每个服务一个 `AggregateError`，装进 Env 的 `AggregateError`。
2. `attempt-succeeded-late` / `attempt-failed-late` 从**关闭开始**起就对结算发出，而不是只在关闭结束之后。错误消息一直把这类结算叫作 "completed after owner Env began closing"，事件现在与之一致。
3. waiter 自己的拒绝不变：仍在等的得到同一个 `AggregateError`，已取消的得到 `LOAD_CANCELLED`，已超时的得到 `LOAD_TIMEOUT`。**waiter 得到什么，不影响关闭是否报告。**
4. 关闭**停止等待**的东西（被放弃的 attempt、被放弃的 cleanup）不进 `dispose()`：那个 `dispose()` 按定义已经返回。它们的迟到失败由事件报告。这条边界是 §13 的一部分，也是 L1 第 4 条的另一面。
5. 主操作的正常结果（`LOAD_CANCELLED`、`LOAD_TIMEOUT`、setup 自身的业务失败）不算关闭错误；同一个 cleanup 错误不会在集合里出现两次。

证据：`rc3-close-paths.test.mjs`（RC2-L2、RC2-L2b）、`close-matrix.test.mjs` 的 4×4（`ready-throws` / `rollback-throws` 行断言恰好一次，`late-cleanup-throws` 行断言只走事件）。

## 4. 实现修正（L3）

不是语义变化：§13 自 0.7 起就写着"attempt 的保留期由用户自己那个 pending 的 Promise 决定，绝不由 Runtime 延长"。rc.2 的实现没有做到——账本条目经 `attempt.slot.ownerEnv` 强持有已关闭 Env 的整张图（plan、`inputSlots`、兄弟 slot），`FinalizationRegistry` 的 held value 与迟到结算的闭包同样。`work/rc3/BASELINE.md` §4 列出了发现的全部十条强引用路径与各自的解法：

- attempt 只在"尚未进账本"期间强持有自己的 slot，进账本时换成 `WeakRef`（与 raw Promise 早有的做法相同），身份改由两个字符串承载；
- attempt 的 owner 是一个最小记录（`AttemptOwnerRecord`：env id、"已开始关闭"标志、这次关闭要报告的 cleanup 错误），不是 Env。它**不含** `AbortSignal`：signal 持有 abort reason，而这个 Error 的结构化栈会持有每一帧的接收者（Env 在内），直到有人读 `.stack`；堆快照显示这是最后一条路径。`setup()` 仍然照常从 lifecycle 拿到 signal；
- 迟到结算的反应与交给 `setup()` 的 lifecycle 各自建在独立的方法里，于是 pending 的 Promise 和用户的栈帧持有的是 attempt 与几个字符串，而不是 `runAttempt` 的整个作用域（slot、owner、依赖 refs）；
- rolling-back 的反应与被放弃 cleanup 的反应经弱引用回到 slot；被放弃的 attempt 清空为等待环诊断保留的 pendingLoads（该诊断只读活 owner 下运行中的 attempt）。

用户自己的 cleanup 闭包与 `setup` 栈帧捕获了什么，仍然是用户的事；`deps` 能到达它的 slot 正是依赖引用的定义。

证据：`rc3-close-paths.test.mjs` 的 RC2-L3（对照组 + `WeakRef` + `--expose-gc`：raw Promise 仍 pending 时被关闭的 Env 与其无关 Input payload 均不可达，账本为 1，且 attempt 在 Env 被回收之后仍能跑完自己的 cleanup）。

## 5. 公开面增量与登记

| item | 变化 | 理由 |
|---|---|---|
| `RuntimeEvent` | `attempt-abandoned.phase`：`'setup' \| 'rollback'` → `'setup' \| 'rollback' \| 'cleanup'`（含该行注释） | §3.1 第 2 条要求报告区分"放弃的是 cleanup"；没有别的事件带 phase |
| `RuntimeLimits` | 仅 `disposalGraceMs` 的注释 | 该限额现在也是每个 Ready slot cleanup 阶段的预算；不改注释就是误述 |
| `UnsettledAttemptInspection` | 仅 `state` 的注释 | `abandoned` 现在也覆盖"关闭停止等待的 cleanup"（按任务书不新增取值） |

`api-inventory` 差分：**0 added / 0 removed / 3 changed**（清单记录完整的签名文本——含类型体内的成员注释——以及条目自身的 JSDoc，所以一行注释也算这个条目的一次 changed）。没有新增名字、字段、选项或事件类型。`docs/API_STABILITY.md` 以 rc.3 例外登记。

## 6. 撤回与改写的测试清单

**没有测试被撤回，没有断言被改写。** rc.2 的 265 个核心测试与 133 个应用测试在本轮全部原样通过；`git diff d7a4410..HEAD -- packages/core/tests packages/core/type-tests apps/multitenant-blog/tests` 只有三个新增文件：

| 文件 | 内容 |
|---|---|
| `packages/core/tests/rc3-close-paths.test.mjs` | RC2-L1（两条）、RC2-L2、RC2-L2b、RC2-L3——审计七个探针中的四个核心探针翻转后的形态 |
| `packages/core/tests/close-matrix.test.mjs` | 关闭矩阵 4×4（Ready cleanup 挂住/抛错、宽限期内 rollback 抛错、被放弃 attempt 迟到 cleanup 抛错 × 无 waiter/仍在/已取消/已超时），并发销毁的链内顺序，一层关闭的时间上界 |
| `apps/multitenant-blog/tests/rc3-close-paths.test.mjs` | RC2-A1（三条关闭路径）、RC2-A2、RC2-A3 |

与 0.7 的 S1/S2 不同，本轮没有任何一条旧断言变成假：rc.2 的实现在这些路径上根本没有断言（一个挂住的 cleanup 会让测试自己挂住），所以新行为不与任何既有测试冲突。这也是为什么本轮是修订加实现修正，而不是撤回。
