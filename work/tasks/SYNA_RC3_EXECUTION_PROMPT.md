# Syna 1.0.0-rc.3 关闭路径修复：实施任务书

> 这是要求你实际修改代码、运行测试并交付证据的任务，不是设计讨论。
> 本轮**只修独立审计（rc.2，提交 `d7a4410`）复现的六组问题**，全部落在关闭路径上。不重构（`materializer.ts` 的拆分是 rc.4），不改名，不加公开选项。
> 唯一允许的公开面变化见 §2.0；除此之外 `api-inventory` 必须与 rc.2 逐项相同。

## 0. 任务、权限与完成含义

对象：`github.com/synajs/syna` 的 `main`（当前 `1.0.0-rc.2`，`d7a4410`）。目标版本 `1.0.0-rc.3`。

审计材料在 `work/rc3/audit/`（由用户放入：`README_ZH.md`、`probes/core-lifecycle.mjs`、`probes/site-manager-isolated.cjs`、`evidence/*.json`）。它的七个探针在 rc.2 上全部 `REPRODUCED`，并已在按锁文件从源码重建的环境中被独立复核。**它们的断言写的是"缺陷出现"；本轮要把它们翻转成"正确行为出现"的回归测试并收进仓库。**

六组问题与修复决定（用户已裁定）：

| 编号 | 问题 | 决定 |
|---|---|---|
| L1 | Ready 服务的 cleanup 不受宽限期约束，一个挂住的 `onDispose` 让整条关闭链永远等待 | **纳入有界关闭**（不是收窄文档） |
| L2 / L2b | 关闭促成的 rollback 里 cleanup 抛错，既不进 `dispose()` 的错误集合，也没有事件；waiter 已离开时完全不可见 | 修：关闭期间发生的每个 cleanup 失败恰好一次进入 `dispose()` 的错误，并有事件 |
| L3 | 账本经 `attempt.slot.ownerEnv` 强持有已关闭 Env 的整张图（含无关 Input） | 修：attempt 与 Env 图解耦 |
| A1 | 参考应用 SiteManager：owner abort 先置 `closed`，随后 `shutdown()` 跳过 `clearInterval` 与 waiter 拒绝 | 修：拆分状态、幂等收尾 |
| A2 / A3 | `acquireTimeoutMs` 不覆盖配置读取；关闭不结束在途调用者的等待；而 `docs/MULTITENANT_BLOG.md:55` 承诺"整个 acquire 共用一个截止时间" | 修：按文档承诺做到端到端 |
| D1 | `docs/API_REFERENCE.md:162–163` 的注释仍是 0.6 的 `disposed` 定义，与 `:197` 和 §13 矛盾 | 删旧注释 |

交付：源码修复；翻转后的回归测试；关闭矩阵测试（§3）；`docs/SEMANTIC_MODEL.md` §13 修订；`docs/SEMANTIC_CHANGES_RC3.md`（登记格式沿用 `SEMANTIC_CHANGES_V07.md`）；`docs/API_REFERENCE.md`、`docs/MULTITENANT_BLOG.md` 同步；`CHANGELOG.md`；`docs/HISTORY.md` 记录本轮来自独立审计；gate 从最终归档重建后的真实摘要。

授权范围同前：本地开发与测试，不发布、不打 tag、不推送、不 force push、不动全局设置。

完成不是"探针翻绿"，而是：**六组问题各有翻转后的回归测试与关闭矩阵覆盖；§13 修订登记完整；规划层零变化；公开面除 §2.0 允许的一项外逐项相同。**

## 1. 事实来源与冲突处理

优先级：用户之后的明确指令 > 本任务书 > `docs/SEMANTIC_MODEL.md`（§13 按本任务书修订）> 审计报告 > 现有代码。

规划层（`entry-planner`、`graph-builder`、`definition-compiler`、`plan-cache`）一行不改；reference planner 差分与 explain/inspect 快照逐字不变。

修复中若发现第七个问题：记入 `docs/DEFERRED.md`，不顺手修。若发现某项修复必须改公开名字：停下报告。

## 2. 裁定与规格

### 2.0 唯一允许的公开面变化

有界 cleanup 需要报告"被放弃的是 cleanup 而不是 setup/rollback"。现有 `attempt-abandoned` 事件的 `phase` 是 `'setup' | 'rollback'`，账本条目 `UnsettledAttemptInspection.state` 是 `'overdue' | 'abandoned' | 'rolling-back' | 'settling'`。

允许：`phase` 联合增加 `'cleanup'`；若账本条目需要区分，允许其 `state` 增加 `'cleaning-up'`。**不允许**新增事件类型、新增字段、新增选项、改任何名字。Phase A 给出最小必要增量；inventory diff 必须恰好等于该增量，并在 `docs/API_STABILITY.md` 记为 rc.3 的登记例外（"§13 修订所需的判别值"）。

若能用现有值如实表达（例如账本用 `abandoned` + 事件用新的 `phase: 'cleanup'`），就不加 `state` 值。

### 2.1 L1：cleanup 纳入有界关闭

关闭的第 4 步（销毁自有 Ready slot）现在是裸的逐个 `await cleanup()`。改为：

1. **每个 slot 的 cleanup 阶段各有一个预算**，等于 `limits.disposalGraceMs`（不与 attempt 阶段共用，不由 Env 内的其他 slot 分摊）。
2. 预算到期而 cleanup 未结束：**停止等待**，该 slot 记为被放弃的 cleanup——进账本（附 slot、revision、env、elapsedMs），发 `attempt-abandoned`，`phase: 'cleanup'`，`dependencies` 列出该 slot 的依赖 slot（它可能仍在使用）。随后继续按依赖者优先顺序销毁其余 slot，**包括被放弃 cleanup 的依赖**——这是 §13 已经写下的"有界关闭的公认代价"，现在明确延伸到 cleanup。
3. 被放弃的 cleanup 后来结算：成功 → 从账本移除；抛错 → 从账本移除并发 `attempt-failed-late`（现有事件，`error` 为该错误）。
4. `dispose()` **不**因被放弃的 cleanup 而拒绝（与被放弃的 attempt 一致）；只因 cleanup **抛错**而拒绝（§2.2）。
5. **独立 SCC 的销毁并发进行**，依赖者优先的顺序在每条依赖链上保持不变。这样一个 Env 的 cleanup 阶段上界是"最长依赖链长度 × 宽限期"，而不是"slot 数 × 宽限期"。现有 `disposeServiceSlots` 是按 `componentOrder` 顺序 `for … await`，改为按条件（依赖者已完成或已放弃）驱动的并发调度。
6. `signal` 在关闭第 1 步已 abort，先于任何 cleanup；配合的 cleanup 本来就能观察到它。文档要说这一点。
7. `runtime.dispose()` 结束时的 `runtime-attempts-outstanding` 同样包含被放弃的 cleanup。

必须诚实写进 §13 与 API_REFERENCE：**有界的是等待，不是资源释放。**被放弃的 cleanup 仍在运行，它持有的资源仍被占用；JavaScript 无法强制终止它。

### 2.2 L2 / L2b：关闭期间的 cleanup 失败恰好一次可见

在一个 Env 的关闭窗口内发生的**任何** cleanup 失败——Ready slot 的 cleanup 抛错、attempt 在关闭窗口内结算后被丢弃时 rollback 的 cleanup 抛错、宽限期内结算的 attempt 的 rollback 抛错——都必须：

1. **恰好一次**进入该 Env `dispose()` 的 `AggregateError`（现有形态；`run()` 走 `suppressed`）；
2. 发出事件：Ready cleanup 抛错走 `dispose()` 拒绝即可；attempt 结算后被丢弃且 cleanup 抛错，发现有的 `attempt-succeeded-late`（`adopted: false`，`cleanupErrors` 非空）或 `attempt-failed-late`——现有实现只在"关闭结束之后"结算时发这两个事件，改为**从关闭开始起**结算的都发。错误消息里已经把这类结算叫作 "completed after owner Env began closing"，事件应与之一致。
3. waiter 自己的拒绝不变：仍在等的 waiter 得到 `AggregateError`，已取消的得到 `LOAD_CANCELLED`，已超时的得到 `LOAD_TIMEOUT`。**waiter 得到什么，不影响关闭是否报告。**
4. 不把主操作的正常结果（`LOAD_CANCELLED`、`LOAD_TIMEOUT`、setup 自身的业务失败）算成关闭错误；不把同一个 cleanup 错误在 `dispose()` 的集合里放两次。

### 2.3 L3：attempt 与 Env 图解耦

账本条目、`FinalizationRegistry` 的 held value、迟到结算闭包，都不得可达 `EnvImpl`、`plan`、`inputSlots`、`slotsByNode`。attempt 需要的 owner 信息改为一个最小记录：owner id、`signal`、"已开始关闭"标志、宽限期值、诊断用的 revision/slot 字符串。`attempt-abandoned.dependencies` 需要的依赖列表在放弃时**物化为字符串数组**存入条目，不再经 slot 反查。

被放弃的 attempt 的 cleanups 是用户闭包，它们捕获什么是用户的事；Runtime 自己的引用不得把图拉住。

验收沿用审计的方法：对照组、`WeakRef`、`--expose-gc`、跨宏任务 GC、迟到结算前后对比。关闭后、raw Promise 仍 pending 时：被关闭的 Env 与其无关 Input payload **不可达**，账本条目为 1；对照 Env 同样不可达。**这是保留性断言，不是状态断言**，允许依赖 `--expose-gc`，与现有账本 GC 测试同类；`env.state` 的任何断言仍不得依赖 GC。

### 2.4 A1：SiteManager 收尾幂等

`apps/multitenant-blog/src/site/manager.ts`：把 `closed` 拆成 `admissionClosed`（停止接纳新 acquire；abort listener 与 shutdown 都置它）与 `shutdownPromise`（收尾只执行一次：`clearInterval`、拒绝容量 waiter、结束在途配置读取的调用者等待、等待租约、销毁记录）。`onDispose` 与显式 `shutdown()` 都返回同一个 `shutdownPromise`。已经 `admissionClosed` 不是跳过收尾的理由。

测试三条路径：宿主先 `shutdown()` 再 dispose Runtime；仅 dispose Runtime（owner 驱动，abort 先到）；启动失败回滚。每条路径断言：interval 已清（用可注入的 timer 或记录创建/清除的 handle），无 waiter 悬挂，`shutdown()` 幂等。

### 2.5 A2 / A3：`acquireTimeoutMs` 端到端

按 `docs/MULTITENANT_BLOG.md:55` 的承诺实现：一次 `acquire` 有一个截止时间，覆盖配置读取、容量等待、创建、轮换重试的全部阶段。

1. 配置读取保持 single-flight（共享 Promise 不取消），但**每个调用者**对它的等待以剩余预算为界，到期以现有的超时错误拒绝该调用者；
2. `shutdown()` 结束所有在途调用者的等待（`SITE_MANAGER_CLOSED`），不等后端读取返回；
3. `inspect()`（应用层）增加 `inFlightConfigReads` 与 `inFlightAcquires`，`pendingAcquires` 保持"容量队列"含义并在文档注明。

若实现后发现文档第 55 行的承诺有无法兑现的部分，改文档而不是静默缩小实现，并说明为什么。

### 2.6 D1：文档

删除 `docs/API_REFERENCE.md:162–163` 的旧注释，替换为与 `:197` 和 §13 一致的一句。全文检查不再有"所有 abandoned attempt 结束后才 disposed"的表述。

## 3. 关闭矩阵测试（必须新增）

一个专门的测试文件（建议 `packages/core/tests/close-matrix.test.mjs`），行 × 列全覆盖：

| 行：卡住/抛错的是 | 列：waiter 状态 |
|---|---|
| Ready slot 的 cleanup 挂住 | 无 waiter |
| Ready slot 的 cleanup 抛错 | waiter 仍在等 |
| 宽限期内结算的 attempt 的 rollback 抛错 | waiter 已取消（`LOAD_CANCELLED`） |
| 被放弃 attempt 的迟到 cleanup 抛错 | waiter 已超时（`LOAD_TIMEOUT`） |

每个格子断言：`dispose()` 在上界内结束；`env.state`；`dispose()` 是否拒绝及 `AggregateError` 内容（每个 cleanup 错误恰好一次）；事件序列；账本内容；被放弃 cleanup 的依赖是否按顺序被销毁。另加：并发销毁下依赖链顺序不变（A→B→C 三链并列，断言每条链内顺序、链间可交错）；一层的关闭时间 ≤ 最长链长度 × 宽限期 + 容差。

审计的七个探针翻转后各成一条测试（`RC2-L1…L3` 进核心，`RC2-A1…A3` 进 `apps/multitenant-blog/tests`），文件头注明来源。

## 4. 执行方式

### Phase A：定位与最小增量（报告点，不停顿）

1. 把审计探针原样跑一遍，确认七个 `REPRODUCED`（作为基线记录进 `work/rc3/BASELINE.md`）。
2. 给出 §2.0 的最小公开面增量与理由；给出 §2.1 第 5 条并发调度的实现方案（在现有 SCC 条件化 DAG 上如何驱动）。
3. 列出 L3 的全部强引用路径（不只是审计指出的那一条），逐条给出解法。
4. 汇总后直接继续。只有两种情况停下：某项修复必须改公开名字；或并发销毁在现有结构上无法保持依赖链顺序（那就退回顺序销毁并把上界如实写成 slot 数 × 宽限期，报告后继续）。

### Phase B：核心修复

L1 → L2 → L3 顺序，各一个 commit，每个 commit 带其回归测试；关闭矩阵测试在 L2 之后补齐。

### Phase C：应用修复

A1、A2/A3 各一个 commit，带测试。

### Phase D：文档与登记

§13 修订；`SEMANTIC_CHANGES_RC3.md`（L1、L2 为"修订"，L3 为"实现修正"，D1 为"澄清"）；API_REFERENCE、MULTITENANT_BLOG 同步；API_STABILITY 的 rc.3 例外说明；HISTORY 记录本轮由独立审计驱动；CHANGELOG；版本 `1.0.0-rc.3`。

### Phase E：验证与交付

全部核心/类型/应用/scripts 测试与真实 PostgreSQL 矩阵；七个翻转探针与关闭矩阵全绿；规划层零变化；inventory diff 恰好等于 §2.0 增量；benchmark 与 rc.2 同机交替对比 ±10%（销毁并发化不得使任何 dispose 相关行退化）；`any` 不增；gate 从最终归档重建；输出真实摘要。

## 5. 验收项

| # | 验收 |
|---|---|
| A01 | 规划层四个模块 `git diff` 为空；planner 差分与快照逐字不变 |
| A02 | inventory diff 恰好等于 §2.0 记录的增量；API_STABILITY 有登记 |
| A03 | L1：cleanup 挂住时 `dispose()` 在（最长链长度 × 宽限期 + 容差）内兑现，`state === 'disposed'`，账本有 `phase: 'cleanup'` 的条目，事件 `attempt-abandoned`；被放弃 cleanup 的依赖按顺序被销毁；迟到结算从账本移除 |
| A04 | L2：关闭矩阵 4×4 每格断言通过；每个 cleanup 错误在 `dispose()` 的 `AggregateError` 中恰好一次；waiter 已取消/已超时时事件仍发出 |
| A05 | L3：关闭后 pending attempt 期间，Env 与无关 Input 不可达（对照组方法），账本为 1；全部强引用路径在 Phase A 报告中列出并关闭 |
| A06 | A1：三条关闭路径 interval 已清、waiter 不悬挂、`shutdown()` 幂等 |
| A07 | A2/A3：配置读取阻塞时 acquire 在 `acquireTimeoutMs` 内以超时拒绝；`shutdown()` 后在途调用者立即得到 `SITE_MANAGER_CLOSED`；新增两项指标 |
| A08 | D1：API_REFERENCE 无旧 `disposed` 表述；§13、API_REFERENCE、示例注释、测试对 `disposed` 的释义一致 |
| A09 | `SEMANTIC_CHANGES_RC3.md` 登记完整，含撤回/改写的测试清单 |
| A10 | benchmark ±10%、`any` 不增、gate 从归档重建 COMPLETE、provenance dirty=false |

## 6. 禁止事项

- 不重构：不拆 `materializer.ts`，不重排测试目录，不合并 gate 脚本（rc.4）。
- 不改任何公开名字；不加公开选项；公开面变化仅限 §2.0。
- 不动规划层。
- 不以"收窄文档"代替 L1 的实现修复；不以内部 `catch` 代替 L2 的错误报告；不以 `WeakRef(rawPromise)` 代替 L3 的引用解耦。
- 不把审计探针原样收进测试（它们断言的是缺陷）；必须翻转。
- 不修矩阵之外顺手发现的问题；记入 DEFERRED。
- 不打 tag、不推送、不发布；不以"已完成"的文字代替证据。

若因外部条件阻塞，完成其余部分，记录 `work/rc3/STATE.md`，报告 BLOCKED 并暂停。
