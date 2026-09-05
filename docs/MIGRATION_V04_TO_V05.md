# 从 v0.4 迁移到 v0.5（MIGRATION_V04_TO_V05）

原则：v0.4 中仅因 bug 才能成功的行为不是兼容目标；正确性修复逐条列出。旧测试若断言已撤回语义，已按下表改写（编号 M-xx 出现在测试注释里）。

## 弃用 / 修正总表

| # | 变化 | v0.4 | v0.5 | 你需要做什么 |
|---|---|---|---|---|
| M-01 | Input 读取 | `await ref.load()` | `ref.read()` 同步返回原载荷 | 把 Input 的 `load()` 换成 `read()`；旧 `load()` 仍在但弃用且会 await thenable |
| M-02 | `loadAll()` | 接受任意 refs | 只接受 Service 类 refs（InputRef 没有 `preload`，类型上被排除） | 从批量中移除 Input refs |
| M-03 | `load()` 签名 | `load()` | `load(options?: { signal })` | 可选：传入 AbortSignal 只取消自己的等待 |
| M-04 | 版本字符串 | 手写解析器接受 `'1'`、`'2.4'` | 必须完整 semver；范围在定义期校验 | 修正 package.json 版本与 `Binding.to(..., range)` 字面量 |
| M-05 | activation 期开子世界 | 允许，返回"Ready" child | `OWNER_NOT_READY` | 把 worker/子世界的启动移到 setup 返回的控制对象里，由宿主在 root Ready 后调用 |
| M-06 | 未 await 的 `load()` | 成为 setup barrier | 普通后台操作 | 需要等待就 `await`；`preload()` 与 `void ref.load()` 等价 |
| M-07 | 等待环 | 立即 `CIRCULAR_MATERIALIZATION` | 可配置 deadline → `INITIALIZATION_TIMEOUT` | 在测试里设置 `initialization.deadlineMs` 或 `setupDeadlineMs` |
| M-08 | 私有 Entry range root | `MISSING_SERVICE` | 与 exact 一致地解析 | 无需改动；确保 owner 的 exact 闭包包含目标 revision |
| M-09 | semver 实现 | 自研 | npm `semver`（`includePrerelease: true`） | 注意 `*`/`^` 会匹配已 admitted 的 prerelease |
| M-10 | rollback 失败 | 继续重试 | 结束本轮 sequence（AggregateError） | 让 `onDispose` 清理幂等 |
| M-11 | Runtime 选项 | — | 新增 `initialization`、`disposal`、`planning`、`diagnostics` | 可选 |
| M-12 | 错误码 | `CIRCULAR_MATERIALIZATION` | 移除；新增 `INITIALIZATION_TIMEOUT`、`OWNER_NOT_READY`、`LOAD_CANCELLED`、`UNSETTLED_ATTEMPT`、`PLANNING_BUDGET_EXCEEDED` | 更新错误处理分支 |
| M-13 | activation 失败 | SynaError 原样抛出 | 一律包成 `ENTRY_ACTIVATION_FAILED`，`cause` 为底层错误，`details.causeCode` 给出内层码 | 从 `error.cause`/`details.causeCode` 读取原因 |
| M-14 | `C.selector` | 一等 primitive | 最小兼容（`@deprecated`） | 迁到 `C.all` 或显式 Entry |
| M-15 | thenable 实例 | 未定义 | 实例不能是 thenable（await 必然吸收）；同步返回外部 thenable 触发 `foreign-thenable-setup` 诊断事件 | 把 thenable 客户端放进普通 holder 对象 |
| M-16 | `RuntimeInspection` | — | 新增 `overriddenServices`、`liveEnvCount` | 可选 |
| M-17 | `check()` 的意外错误 | `checkFrom(..., rethrowUnexpected)` 内部参数 | 非拓扑错误（策略 TypeError、无效 descriptor、budget）一律抛出 | 无需改动 |
| M-18 | `dispose()` 后的 `env.state` | 总是 `disposed` | 有 attempt 被放弃（`UNSETTLED_ATTEMPT`）时保持 `disposing`，迟到结果清理后（或 attempt 不可达后）才 `disposed`；有界关闭结束时 Env 已离开树与 `inspect()` 计数，未结束的 attempt 列在 `inspect().unsettledAttempts`，`runtime.dispose()` 会再次报告；关闭期间才到期（deadline 在 grace 内触发）的 attempt 同样被报告并保持 `disposing`（第三轮 I-61） | 等待/处理 `UNSETTLED_ATTEMPT`，不要把 `state === 'disposed'` 当作关闭完成的唯一信号；用 `unsettledAttempts` 而不是 `liveEnvCount` 观察未结束的 attempt |
| M-19 | 未处理的 `load()` 失败 | 加入运行中 attempt 的调用者得到带内部 catch 的共享 Promise（失败被静默） | 每个调用者得到自己的 Promise，忘记 `.catch` 即 unhandled rejection | 给每个 `load()` 结果加处理（`await`/`.catch`/`preload()`） |
| M-20 | 回滚失败后的恢复 | `retry-on-next-load` 冷却后照常启动新 attempt，即使上一次的 `onDispose` 清理抛错 | 清理失败过的 slot 永久 `failed`，之后每次 `load()` 得到 `ROLLBACK_FAILED`（`cause` 为原错误） | 把清理失败当作需要人工处理的事件（新 Env / 修复资源），不要依赖自动恢复 |
| M-21 | 永不结算的 setup | 超时/被放弃的 attempt 永久占住 slot 与 Env | setup Promise 被垃圾回收后 attempt 以 `attempt-unreachable` 关闭：清理运行，slot 与 Env 成为 `disposed` | 需要观察时监听 `diagnostics.onEvent` 的 `attempt-unreachable`；不要假定 `disposing` 会永久存在 |
| M-22 | 仅以 `Family.range()` 引用的私有 Family | 私有 realm 内 `MISSING_SERVICE`（需要另有 exact 引用让 Runtime 认识该 revision） | range 携带 origin revision；origin 及其闭包进入 owner 的候选集（公开 realm 仍只见 admitted） | 删除只为"让 Runtime 认识"而加的 exact 引用（第三轮 I-58） |
| M-23 | `Revision.range()` / `serviceRange()` 的类型 | origin 的完整实例类型 | origin 的 Contract 视图（`ProvidedShape<Provides>`；无 `provides` 时为 `unknown`）；候选必须提供 origin 的全部 Contract，否则 `INCOMPATIBLE_IMPLEMENTATION` | 通过 range 使用 revision 私有成员的代码改用 exact 引用，或把该成员提升为 Contract（第三轮 I-59） |
| M-24 | 同 key、不同 `setup` 文本的物理副本 | 先注册者胜出（静默） | `DUPLICATE_DEFINITION`（`details.expected/actual` 含 `setup=` 摘要）；文本相同仍归一 | 保证副本来自同一构建；闭包捕获的状态与原生函数不参与比较（第三轮 I-63） |
| M-25 | `RuntimeInspection` / `check()` | — | 新增 `definitions`（entries/inputs/bindings/contracts/families 计数）；`check()`/`explain()` 不再消耗 Env 编号（Env id 连续） | 可选；不要依赖 check 会推进 Env 编号（第三轮 I-62） |

## 改写的旧测试（逐项）

| 文件 | 原断言 | 现断言 | 编号 |
|---|---|---|---|
| hardening.test.mjs | 经 Ready service 的 setup 环立即 CIRCULAR | INITIALIZATION_TIMEOUT（等待经由实例方法，不可观察 load 边，诚实说明） | M-07 |
| v05-definitions.test.mjs R20 / core.test.mjs | 不同 `setup` 的物理副本先注册者胜出 | 不同 setup 文本 → `DUPLICATE_DEFINITION`；文本相同仍归一为一个 admitted revision | M-24 |
| hardening.test.mjs（metadata drift） | 两副本 setup 返回不同 id | setup 文本相同、仅 metadata 不同；只启动一次 | M-24 |
| v05-realms-override.test.mjs R06 | `fresh: [Real]` 后的空断言 | 分叉节点的 owner、共享的私有 helper、分叉内各解析路径的同一新实例 | — |
| v05-realms-override.test.mjs R07 | 私有 range 依赖由 exact 边"喂进" Runtime | 仅以 range 引用的私有 Family 也解析；公开调用仍 `MISSING_SERVICE` | M-22 |
| hardening.test.mjs | owner 激活期 BoundEntry 进入返回 ready | OWNER_NOT_READY；Ready 后同一 handle 可用 | M-05 |
| lifecycle.test.mjs | C↔D setup 环立即失败 | deadline 诊断含 suspectedWaitCycle | M-07 |
| lifecycle.test.mjs | 经 selector/all 的环立即失败 | INITIALIZATION_TIMEOUT | M-07 |
| semver.test.mjs | `parseVersion('1')` 合法；非法范围报"Invalid semantic version" | 版本必须完整；非法范围报"not a valid semver range"；新增 union/prerelease 用例 | M-04/M-09 |
| v04-corrections.test.mjs | preload 非阻塞而未 await load 强等待 | 两者都非阻塞 | M-06 |
| v04-corrections.test.mjs | eager 在 activation 事务内开 child | eager 被拒（OWNER_NOT_READY），Ready Env 内 lazy 可开 | M-05 |
| v04-corrections.test.mjs | parent-setup→child-eager→parent 环 | ENTRY_ACTIVATION_FAILED cause OWNER_NOT_READY | M-05/M-13 |
| v04-finalization.test.mjs | 失败 parent 回滚结构化 child | child 根本不会启动；本地 eager 回滚 | M-05 |
| v04-finalization.test.mjs | 未 await 的 load 是 barrier | 不是 barrier；消费者不被后续毒化 | M-06 |
| v04-regressions.test.mjs | 未 await load 形成环 | 两种模式都成功 | M-06 |
| v04-regressions.test.mjs | eager 在激活期创建结构化 child | 宿主在 Ready 后 `start()` | M-05 |
| v04-regressions.test.mjs | selector.open 参与激活事务 | ENTRY_ACTIVATION_FAILED cause OWNER_NOT_READY | M-05 |

## 文档修正

v0.4 README 中 `onDispose(() => pool.close())` 出现在**拥有** pool 的 Service 内是正确的；本轮补充的规则是：Service 不得 `onDispose` 关闭它并不拥有的依赖（例如 Repository 不能关闭共享 Pool）。Hyla-mini 的 `DatabasePool` 是唯一调用 `pool.end()` 的地方。
