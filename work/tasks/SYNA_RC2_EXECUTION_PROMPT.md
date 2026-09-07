# Syna 1.0.0-rc.2 示例重建：实施任务书

> 这是要求你在仓库内实际重写示例、跑通 gate 并交付证据的任务，不是设计讨论。
> 本轮**不改 `packages/core` 的任何一行源码**：公开面已在 0.8 冻结，`api-inventory` 必须零差异，reference planner 差分与 explain/inspect 快照逐字不变。
> 本轮的产物同时是下一轮官方手册的示例来源。手册将从这些 demo 抽取 snippet，不再另造示例。

## 0. 任务、权限与完成含义

对象：`github.com/synajs/syna` 的 `main`（当前 `v1.0.0-rc.1`）。目标版本 `1.0.0-rc.2`。

四件事：

1. 用一套七步渐进的示例取代现有四个 demo；
2. 按同一个虚构领域重建 `packages/*` 里的夹具包；
3. 参考应用 `apps/hyla-mini` 更名为 `apps/multitenant-blog`（内容不动）；
4. 写下示例命名规则，并让门面（README）与展柜（参考应用）分开。

交付：新的 `apps/01-*` … `apps/07-*` 与重建后的夹具包；更名后的参考应用；`docs/EXAMPLES.md`；双语 README 改写；`docs/HYLA_MINI.md` → `docs/MULTITENANT_BLOG.md`；`docs/HISTORY.md` 补更名说明；gate 步骤同步；`CHANGELOG.md`；gate 从最终归档重建后的真实摘要。

授权范围同前：本地开发与测试，不发布、不打 tag、不 force push、不动全局设置。

完成不是"demo 都能跑"，而是：**七个 demo 各自回答一个下游开发者会问的问题、各自带断言、各自进 gate；核心零改动的三张网全绿；仓库里不再出现真实厂商名作为虚构组件名。**

## 1. 事实来源与冲突处理

优先级：用户之后的明确指令 > 本任务书 > `docs/SEMANTIC_MODEL.md` 与 `docs/API_STABILITY.md` > 现有代码。

示例只能使用冻结面上的 API。若某个教学目标需要冻结面没有的能力，**不要变通实现，也不要改核心**：记入 `docs/DEFERRED.md` 并在会话中报告。

示例里发现的核心缺陷同样不修，记入 `DEFERRED.md`。

## 2. 领域：通知投递服务（已裁定）

一个虚构的多租户通知服务，贯穿全部七个 demo，逐步长大。领域词汇只有四个：租户（tenant）、投递商（provider）、通知（notification）、投递（delivery）。读者不需要任何前置知识。

领域到 Syna 概念的映射（示例必须体现这一层，而不是把 Syna 概念直接当业务名）：

```text
投递商的客户端        → Service（自有资源：凭据、限流器、连接）
"发得出通知"这件能力  → Contract
某租户选了哪个投递商  → Binding + ImplementationRef（存进"数据库"）
当前租户、当次通知    → Input
一次每日摘要任务      → Service 依赖 Entry 得到的 AnchoredEntry 所创建的子世界
投递商 SDK 出了 v2    → 同一 Family 的两个 Revision 共存
```

### 2.1 夹具包（重建）

删除 `packages/openai-v1`、`openai-v2`、`claude`、`postgres`、`llm-contract`、`hyla`、`fluida`，代之以：

| 包 | 版本 | 作用 |
|---|---|---|
| `@syna-demo/notify-contract` | 1.0.0 | `Notifier` Contract；`syna.id: demo.notify.contract` |
| `@syna-demo/acme-notify` | 1.8.4 与 2.4.1 两个目录 | 同一 Family 两个 Revision；`syna.id: demo.notify.acme`；两版行为可观察地不同（例如 2.x 支持批量、返回结构不同） |
| `@syna-demo/globex-notify` | 3.1.0 | 第二个 Family；`syna.id: demo.notify.globex` |
| `@syna-demo/tenant-store` | 1.2.0 | 自有资源（假的连接池）+ 配置 Input + `onDispose` |
| `@syna-demo/logger` | 1.1.0 | 共享基础设施，用于演示"依赖它的人不负责关它" |

规则：厂商角色用公认虚构公司名（Acme、Globex）；基础设施角色用职能名，不挂厂商。全部 `private: true`，scope 保持 `@syna-demo`。`packages/logger` 可保留并按新领域调整。

多版本布局沿用现有做法（两个目录 + 本地 import alias），因为它演示的正是"应用有意同时接纳两个版本"。

### 2.2 七个 demo

每个是一个独立可运行的程序（`node apps/<name>/dist/index.js` 或 `bin`），有断言，失败时非零退出，输出稳定到可被 gate 匹配。每个 demo 的 `README.md` 开头一段回答"这个 demo 解决什么问题"，不讲 Syna 的内部机制。

| 目录 | 回答的问题 | 必须出现 | 不得出现 |
|---|---|---|---|
| `apps/01-basics` | 怎么定义服务、把它们接起来、进入一个世界 | `definePackage`、`define.service`、`requires`、`setup`、`onDispose`、`define.entry`、`createRuntime`、`runtime.run`、`ServiceRef.load` | Contract、Binding、Input |
| `apps/02-per-tenant` | 每个租户各自的实例，而不用命名 scope | `define.input`、`InputRef.read`、父子 Entry、`env.explain()` 打印分叉节点与原因、`reuse: { share }` 保住共享基础设施 | Contract、Binding |
| `apps/03-user-configurable` | 让租户自己选投递商，并把这个选择存进数据库 | `define.contract`、`provides`、`define.binding`、`Binding.to`、`ImplementationRef` 的 JSON 往返（写文件再读回）、`Contract.all` 渲染"设置页可选项" | 多版本 |
| `apps/04-two-versions` | 同一个投递商的 v1 与 v2 共存；老租户的存量配置继续有效 | 两个 Revision 同时 admitted、`ServiceRevision.range`、`ImplementationRef` 的 range 意图、`catalog.implementations` | — |
| `apps/05-scheduled-jobs` | 服务自己怎么创建类型安全的子世界 | eager 调度服务、Entry 作为依赖、`AnchoredEntry`、`run()`、子世界拿到自己的 Input、结束即销毁 | — |
| `apps/06-testing` | 怎么在集成测试里换掉真实投递商 | `override()`、录制式假实现、同一套 Entry 在真假两种 Runtime 下运行并断言结果一致 | — |
| `apps/07-failure-modes` | setup 失败、卡住、关闭时会发生什么 | 粘滞失败、`failure: { attempts, afterExhaustion: 'retry-on-next-load' }`、`loadTimeoutMs` 与逾期后被接纳的迟到成功、`env.dispose()` 的有界关闭、`runtime.inspect().unsettledAttempts`、`diagnostics` 事件 | — |

`02` 与 `03` 是最该被人先看到的两个，README 的示例节从这两个取材。

`05` 必须用调度服务而不是"一次投递尝试"来演示子世界：eager 服务在 owner Ready 后为每个租户开一个每日摘要世界，这才体现 `AnchoredEntry` 锚定在 owner Env 的意义。

`07` 的每一种失败都要打印 Syna 给出的错误码与 `details` 的关键字段，让读者知道该看什么。

### 2.3 删除与迁移

- 删除 `apps/minimal-demo`、`apps/features-demo`、`apps/hyla-demo`、`apps/fluida-demo`。
- **删除前先证明覆盖不丢**：`features-demo` 断言的四件事（eager 在 Entry 激活期间启动、解构依赖引用仍惰性、结构环在 setup 后可调用、setup 等待环被拒绝）必须在 `packages/core/tests` 中各找到对应用例，把文件与用例名写进 `work/rc2/COVERAGE_CHECK.md`；缺哪一条就在 `01`–`07` 里补上对应断言，不得默认已覆盖。
- `fluida-demo` 的"共享连接池 + 平行事务世界"被 `05` 吸收；`docs/HISTORY.md` 说明它去了哪里。

### 2.4 参考应用更名

`apps/hyla-mini` → `apps/multitenant-blog`；包名 `@hyla/mini` → `@syna-app/multitenant-blog`；`bin/hyla-mini.mjs` → `bin/multitenant-blog.mjs`；`docs/HYLA_MINI.md` → `docs/MULTITENANT_BLOG.md`；README、gate 步骤、npm scripts 同步。

**应用代码的行为一行不改。**其内部对 Hyla 领域概念（post、tenant、recipe）的命名保持不变——那是它的业务领域，不是品牌。

历史文档（`HISTORY.md`、`VALIDATION.md`、`AUDIT.md`、各版 `MIGRATION_*`、`SEMANTIC_CHANGES_*`、`work/**`）中的 "Hyla-mini" **一律不改**：记录里它就叫这个名字。仅在 `HISTORY.md` 增加一句更名说明。

### 2.5 门面与规则

- 双语 README 改写：开头用不需要背景知识的通用叙述说明 Syna 是什么、不是什么；示例节取自 `02` 与 `03`；参考应用降为单独一节，细节留给 `docs/MULTITENANT_BLOG.md`；保留现有的构建、测试、gate、PostgreSQL 说明。
- 新增 `docs/EXAMPLES.md`：示例的组织方式（七步、一个领域、每个可运行且有断言）、命名规则——**示例使用虚构名字；只有代码真的与某个产品交互时才使用它的真名**（`multitenant-blog` 连接真实 PostgreSQL、使用 `pg`、`remark`/`unified`/`rehype` 属于后者，保持真名）。
- `docs/EXAMPLES.md` 声明：这些 demo 是官方手册的 snippet 来源，改 demo 即改手册。

### 2.6 gate

替换跑 demo 的步骤：七个 demo 各一步，断言其稳定输出与零退出码；参考应用的四格断言（两个 HTTP 租户 + 静态构建）保持不动，仅更新路径与命令名。新增一步：全仓库 grep，`OpenAI`、`Claude`、`hyla-mini`（历史文档与 `work/**` 除外）作为组件名或路径零命中。

## 3. 执行方式

### Phase A：设计与覆盖证明（报告点，不停顿）

1. `work/rc2/DEMO_PLAN.md`：七个 demo 各自的程序结构、断言、稳定输出行，以及它们共同的领域模型（一页足够）。
2. `work/rc2/COVERAGE_CHECK.md`：§2.3 的四条覆盖证明。
3. 夹具包清单与版本布局。
4. 汇总到会话后直接继续。只有两种情况停下：某个教学目标需要冻结面之外的能力；或删除旧 demo 会造成实际覆盖损失且无法在新 demo 中补上。

### Phase B：夹具

重建 `packages/*` 夹具；`@syna-demo/*` 全部 private；`syna.id` 按 §2.1。

### Phase C：demo

`01` → `07` 顺序实现，每个一个 commit，含其 `README.md` 与断言。

### Phase D：更名与删除

参考应用更名；旧 demo 删除；gate 步骤替换；npm scripts 同步。

### Phase E：文档

双语 README、`docs/EXAMPLES.md`、`docs/MULTITENANT_BLOG.md`、`HISTORY.md` 的更名与去向说明、`CHANGELOG.md`、版本号改 `1.0.0-rc.2`。

### Phase F：验证与交付

全部核心/类型/应用/scripts 测试与真实 PostgreSQL 矩阵；七个 demo 与参考应用在 gate 中运行；`api-inventory` 与 rc.1 记录零差异；reference planner 差分与 explain/inspect 快照逐字不变；benchmark 与 rc.1 同机交替对比 ±10%；`any` 不增；gate 从最终归档重建；输出真实摘要。

## 4. 验收项

| # | 验收 |
|---|---|
| A01 | `packages/core` 零改动（`git diff --stat` 对该目录为空）；`api-inventory` 0 added / 0 removed / 0 changed；planner 差分与快照逐字不变 |
| A02 | 七个 demo 各自可运行、有断言、失败非零退出、各自进 gate；每个有回答"解决什么问题"的 README 段落 |
| A03 | `work/rc2/COVERAGE_CHECK.md` 对 §2.3 四条各给出核心测试的文件与用例名；缺口已在新 demo 中补齐 |
| A04 | 夹具按 §2.1 重建；全仓库 `OpenAI`/`Claude` 作为虚构组件名零命中；`@syna-demo/*` 全 private |
| A05 | 参考应用更名完成且行为零变化（其测试全部通过）；历史文档中的旧名未被改动；`HISTORY.md` 有更名说明 |
| A06 | 双语 README 的开头不依赖任何领域背景；示例取自 `02` 与 `03`；参考应用为独立一节 |
| A07 | `docs/EXAMPLES.md` 含命名规则与"demo 是手册 snippet 来源"的声明 |
| A08 | benchmark ±10%、`any` 不增、gate 从归档重建输出 COMPLETE、provenance dirty=false |

## 5. 禁止事项

- 不改 `packages/core` 的任何源码；不改任何公开名字、语义或默认值。
- 不为了让某个 demo 好看而使用冻结面之外的能力或变通实现。
- 不改历史文档中的旧名；不改参考应用的行为。
- 不在示例中使用真实厂商名作为虚构组件；不在 demo 的 README 中讲 Syna 的内部机制。
- 不删除旧 demo 而不给出覆盖证明。
- 不打 tag、不推送、不发布；不以"已完成"的文字代替证据。

若因外部条件阻塞（PostgreSQL 不可用等），完成其余部分，记录 `work/rc2/STATE.md`，报告 BLOCKED 并暂停。
