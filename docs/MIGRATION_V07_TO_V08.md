# 从 v0.7 迁移到 v0.8（MIGRATION_V07_TO_V08）

v0.8 只做一件事：**1.0 之前最后一次改名**。任务书 §2 表内的每个名字改为唯一形式——类型名（§1）、字段与参数名（§2）、值与事件名（§3）、两处结构（§4）——不设别名，不保留任何旧键或兼容分支（0.6 加入的 `implementationId` 读取分支一并删除，§6）；表外任何名字不改，任何语义不改，任何公开选项不加（未改的名字与理由在 §7）。规划层零变化：`packages/core/tests/reference-planner.test.mjs` 的参考 planner 差分与 `packages/core/tests/v06-snapshots.test.mjs` 的 explain/inspect 快照按本表映射改写后逐字一致，`limits` 四个默认值逐字不变（`packages/core/tests/v07-expired-forms.test.mjs`）。`scripts/tests/api-inventory.test.mjs` 断言公开 API 与 0.7.0 清单（`work/v08/API_INVENTORY_BEFORE.json`，commit 72f1991）的差异——删除项、新增项与签名变化项——恰好是本表的条目，多一个少一个都失败；`scripts/tests/no-old-names.test.mjs` 断言应用、演示、benchmark、脚本与核心测试里没有任何旧名、旧码、旧键与旧事件名。

从 0.8.0 起公开面冻结：1.0 前不承诺兼容，公开面自 0.8.0 冻结，1.0 起只按 major 变化（`docs/API_STABILITY.md`）。术语表见 `docs/GLOSSARY.md`。

原则沿用 0.7：**过期形式被拒绝而不是被忽略**。能在类型层面拒绝的（不存在的类型、不存在的属性、不可赋值的字面量）由编译器拒绝；Runtime 在运行时能读到的四种旧形式——改名的 Service 定义选项、改名的 limit、`derive(constraints)`、`revisions(familyId)`——被明确拒绝并指出现行形式，绝不静默读成"没有"（`packages/core/tests/v08-expired-forms.test.mjs`）。其余旧名在运行时只是不存在的属性或永不成立的比较，靠 `npm run typecheck` 与 §5 的 codemod 找出。

## §1 类型名（§2.1）

| 清单项 | 0.7 形式 | 0.8 唯一形式 | 仍写旧形式时 |
|---|---|---|---|
| T1 | `EnvHandle<Deps>` | `Env<Deps>`（内部类仍是 `EnvImpl`） | 类型不存在（编译错误）。codemod T1 |
| T2 | `EntryDescriptor<R, P>` | `Entry<R, P>`（`EntryDefinition` 不变） | 类型不存在。codemod T2 |
| T3 | `ImplementationDescriptor<C>` | `ImplementationRecord<C>` | 类型不存在。codemod T3 |
| T4 | `NodeDisposition` | `NodePlacement`（值见 D4） | 类型不存在。codemod T4 |
| T5 | `InputType<I>` | `InputValue<I>` | 类型不存在。codemod T5 |
| T6 | `EnvInspection.state`、`EnvInspectionNode.state`、`attempt-abandoned.dependencies[].state` 都是 `string` | 新增 `SlotState = 'dormant' \| 'starting' \| 'ready' \| 'failed' \| 'disposing' \| 'disposed' \| 'abandoned'`；`EnvInspection.state: EnvState`、`EnvInspectionNode.state: SlotState`、`dependencies[].state: SlotState`（D6）；`SLOT_NOT_LOADABLE.details.state` 是 `SlotState` 的子集 | 与 `string` 比较的代码不受影响；与集合外字面量比较是类型错误。`packages/core/tests/v08-slot-state.test.mjs` 断言声明的并集与实际可观察的状态集完全一致 |
| T7 | `UniquenessPolicy = 'none' \| 'lineage'`；`uniqueWithin: 'none'` | `UniquenessPolicy = 'lineage'`；不声明唯一性的 Family **没有** `uniqueWithin` 键（D9） | `define.service({ uniqueWithin: 'none' })` 抛 `TypeError`（`uniqueWithin must be "lineage" when provided.`）；类型层面 `'none'` 不可赋值。codemod D9 |

## §2 字段与参数名（§2.2）

| 清单项 | 0.7 形式 | 0.8 唯一形式 | 仍写旧形式时 |
|---|---|---|---|
| F1 | `ServiceRevision.key` | `ServiceRevision.id`（`<family>@<version>`，值不变） | 属性不存在（`undefined`）；类型错误。codemod F1（按接收者的声明类型；`any` 接收者按名字启发式） |
| F2 | `RuntimePolicyContext.parentActiveRevisionKeys` | `context.parentActiveRevisionIds`（`ReadonlySet<string>`，内容不变） | 属性不存在。codemod F2 |
| F3 | `INVALID_INHERITED_CHOICE.details.selectedKey` | `details.selectedRevision` | 属性不存在。codemod F3 |
| F4 | `define.service({ metadata })` | `define.service({ familyMetadata })`，读为 `revision.family.metadata`；`revisionMetadata` 不变 | `define.service()` 抛 `TypeError`（`Service <id> uses the option metadata, renamed in 0.8.0; use familyMetadata.`）；类型层面多余属性。codemod F4 |
| F5 | `ServiceRevision.metadata` | `ServiceRevision.revisionMetadata`（family 级经 `revision.family.metadata`） | 属性不存在。codemod F5（按接收者类型） |
| F6 | `ImplementationCandidate.ref: CandidateRef` | `candidate.candidateRef` | 属性不存在。codemod F6 |
| F7 | `ImplementationDescriptor.persistentRef` | `ImplementationRecord.implementationRef`——`Binding.to(revision)` 会为该修订写出的引用，`range` 是该版本的默认范围（`^<version>`） | 属性不存在。codemod F7 |
| F8 | `Binding.to(service, version?)`、`revision.range(version?)` 的参数名 | `range` | 位置参数，调用不变；只影响声明、文档与 IDE 提示 |
| F9 | `ImplementationRef.version`（含 JSON 键）；0.5 键 `implementationId` 的读取分支与辅助函数（`isLegacyImplementationRef`、`normalizeImplementationRef`、`familyIdOf`、`RawImplementationRef`） | `ImplementationRef.range`；唯一形状 `{ kind: 'implementation-ref', contractId, familyId, range }`（§6） | `parse()` 与每条 Runtime 读取路径以 `INVALID_DESCRIPTOR` 拒绝（§6）。codemod F9 改写声明形状与字面量里的 `version` 键；读旧键的代码需手工删除（codemod 以退出码 2 逐行列出） |
| F10 | `RuntimeInspection.internalServices` | `inspect().privateServices` | 属性不存在。codemod F10 |
| F11 | `RuntimeInspection.planCache.maxEntries` | `planCache.limit`（`hits` / `misses` / `entries` / `evictions` 不变） | 属性不存在。codemod F11 |
| F12 | `explain().parameters.bindingsResolved` | `parameters.bindingsAssigned`（站点 → 修订 id 的映射，内容不变） | 属性不存在。codemod F12 |
| F13 | `ExplainedNode.disposition` | `node.placement`（值见 D4） | 属性不存在。codemod F13 |
| F14 | `UnsettledAttemptInspection.runningForMs` | `elapsedMs` | 属性不存在。codemod F14 |
| F15 | `attempt: number`——事件 `attempt-overdue`、账本项 `UnsettledAttemptInspection`、`LOAD_TIMEOUT.details`、`LIFECYCLE_MISUSE.details` | `attemptNumber`（同一个 attempt 序号，四处一致） | 属性不存在。codemod F15（按接收者类型或名字） |
| F16 | `define.service({ setupDeadlineMs })`、`limits.setupDeadlineMs` | `loadTimeoutMs`（默认 30_000 不变） | `define.service()` 抛 `TypeError`（`Service <id> uses the option setupDeadlineMs, renamed in 0.8.0; use loadTimeoutMs.`）；`createRuntime()` 抛 `TypeError`（`limits.setupDeadlineMs was renamed in 0.8.0; use limits.loadTimeoutMs.`）。codemod F16 |
| F17 | `ServiceRevision.setupDeadlineMs` | `ServiceRevision.loadTimeoutMs` | 属性不存在。codemod F16 |
| F18 | `LINEAGE_UNIQUENESS_CONFLICT.details.anchorSlot` / `anchorRevision` | `pinnedSlot` / `pinnedRevision`（另一形状 `{ family, slots }` 不变） | 属性不存在。codemod F18 |
| F19 | `kind: 'persistent-implementation-ref'` | `kind: 'implementation-ref'` | 其他任何 `kind` 都以 `INVALID_DESCRIPTOR`（`wrong-kind`）拒绝（§6）。codemod F19 |

## §3 值与事件（§2.3）

| 清单项 | 0.7 形式 | 0.8 唯一形式 | 仍写旧形式时 |
|---|---|---|---|
| D1 | 错误码 `INITIALIZATION_TIMEOUT` | `LOAD_TIMEOUT`（`details` 形状不变；`attempt` → `attemptNumber` 见 F15；26 个码按字母序，`LOAD_TIMEOUT` 在 `LOAD_CANCELLED` 之后） | `isSynaError(e, 'INITIALIZATION_TIMEOUT')` 类型错误，运行时永不匹配。codemod D1 |
| D2 | ForkCause `'anchor-dependency-mismatch'` | `'pinned-dependency-mismatch'`（`{ family, via }` 不变） | 比较永不成立；类型错误。codemod D2 |
| D3 | `InspectionNodeKind` `'all'` | `'all-implementations'`（`C.all` 描述符的 `kind` 同名；inspect 节点以 `nodeId` 区分） | 同上。codemod D3 |
| D4 | `NodePlacement` `'inherited'` | `'reused'`（`'new'`、`'forked'` 不变） | 同上。codemod D4 |
| D5 | `ExplainCounts.inherited`（`services` / `synthetic`）、`services.eagerInherited` | `reused`、`eagerReused`；`inputs.inherited`、`parameters.inputsInherited` / `bindingsInherited` **不变**——只有 Input 与 Binding 会被继承，Service slot 是被复用 | 属性不存在。codemod D5 |
| D6 | 三处 `state: string` | 见 T6 | — |
| D7 | 账本状态 `'timed-out'` | `'overdue'`（`'abandoned'` / `'rolling-back'` / `'settling'` 不变） | 比较永不成立。codemod D7 |
| D8 | 事件 `late-setup-result` / `late-setup-failure` / `attempts-outstanding` / `foreign-thenable-setup` | `attempt-succeeded-late` / `attempt-failed-late` / `runtime-attempts-outstanding` / `setup-returned-thenable`（负载不变；`attempt-overdue`、`attempt-abandoned`、`attempt-unreachable` 不变） | 处理器永不触发；类型错误。codemod D8 |
| D9 | `family.uniqueWithin === 'none'` | 未声明时 `undefined`（键不存在） | 见 T7。codemod D9 |
| D10 | 事件 `legacy-implementation-ref` | 删除（没有旧键可读，§6） | 处理器永不触发；类型错误。codemod 以退出码 2 列出 |

## §4 结构（§2.4）

| 清单项 | 0.7 形式 | 0.8 唯一形式 | 仍写旧形式时 |
|---|---|---|---|
| S1 | `env.derive(reuse?: ReuseConstraints)` | `env.derive(options?: EntryOptions)`：`derive({ reuse: { fresh, share } })`，与 `enter` / `run` / `check` / `explain` 的第三个参数同形 | `derive({ fresh })` / `derive({ share })` 以 `TypeError` 拒绝（`fresh and share are reuse constraints, not call options: pass them as { reuse: { fresh, share } }.`），每个 Entry 调用的 options 记录都如此；类型层面多余属性。codemod S1 |
| S2 | `catalog.revisions(familyId: string)` | `catalog.revisions(family: ServiceFamily)`（`revision.family`） | 字符串以 `INVALID_DESCRIPTOR` 拒绝（`{ descriptor: 'ServiceFamily', problem: 'not-an-object' }`），其他描述符 `wrong-kind`；未知 Family 仍返回 `[]`。codemod S2（实参为 `x.family.id` 时改为 `x.family`；字符串字面量列为手工项） |

## §5 codemod：`scripts/codemod-v08.mjs`

```sh
node scripts/codemod-v08.mjs                       # 工作区默认目标：apps、benchmarks、packages/*（core 与 tsconfig 除外）、packages/core/tests、scripts
node scripts/codemod-v08.mjs src tests             # 任意文件或目录（.ts / .mts / .cts / .mjs / .cjs / .js）
node scripts/codemod-v08.mjs --dry-run --verbose   # 只报告不写入；逐条列出改动
node scripts/codemod-v08.mjs --json report.json    # 按规则计数的报告
```

- 以 TypeScript 编译器 API 驱动：对目标建一个程序（`allowJs`），凡程序能解析出类型的地方按**接收者的声明类型**改名（`ServiceRevision` 的 `.key`、`ImplementationCandidate` 的 `.ref`、`kind: 'implementation-ref'` 形状的 `.version`、`ExplainCounts` 的 `.inherited`、`{ attempt, slot, revision }` 形状的 `.attempt`……），解析不出（`any`）时按名字启发式；处处只有一个意思的名字按 token 改写（标识符、属性名、字符串、注释）。所以先升级到 0.8 的 `@syna/core`（或把 `dist/` 构建到位）再跑，类型信息最全。
- 幂等：迁移后的树再跑一次是 `0 edits in 0 files`；发布门禁 `scripts/verify-v08.mjs` 在工作区与解包后的归档里各跑一次 `--dry-run` 并要求这一行。
- 退出码：全部改写 0；仍有需手工处理的位点 2（逐行列出原因）；`--dry-run` 不写文件。手工位点只有三类：读 0.5 键 `implementationId` 的代码（F9，删除并按 §6 重写存量文档）、`legacy-implementation-ref` 的处理器或断言（D10，删除）、`catalog.revisions('字面量')`（S2，改为描述符）。
- 冻结：带 `syna-v05-compat`、`syna-v08-rename` 或 `codemod-v08: skip` 的行，以及 `codemod-v08: off` … `codemod-v08: on` 之间的行不改。`dist`、`node_modules`、`work` 不进入。
- 不改的名字：Hyla-mini 自己的 `cacheStats.maxEntries`、`PipelineBuilder.stats.maxEntries`、`record.key`、`lease.key` 等按其自身类型识别，不动；`inputs.inherited` 与 `*Inherited` 计数按 D5 保留。
- 本仓库的应用、演示、benchmark、脚本与核心测试全部由它迁移（`work/v08/codemod-dry-run-all.json`：525 处改动 / 52 个文件；手工位点全在被删除的旧键代码里），`scripts/tests/codemod-v08.test.mjs` 在一个 fixture 上验证每条规则、幂等性与手工位点报告。

## §6 实现引用只有一种形状（F9 / F19 / D10 的读写规则）

写：`Binding.to(revision, range?)`、`Binding.parse(input)`、`catalog.implementations(C)[].implementationRef`、`catalog.resolve(ref).implementationRef` 写出且只写出 `{ kind: 'implementation-ref', contractId, familyId, range }`——`Object.keys` 恰好这四个键，`range` 缺省为 `^<version>`。

读：`parse()` 与每条 Runtime 读取路径——`catalog.resolve(ref)`、Binding 赋值（`enter(entry, { choice: ref })`）、`set.resolve(ref)`、`set.load(ref)`——只接受这一种形状，其余一律 `INVALID_DESCRIPTOR`，`details.problem` 取：

| 输入 | `problem` | 说明 |
|---|---|---|
| 非对象（`'x'`、`null`） | `not-an-object` | |
| `kind` 不是 `'implementation-ref'`（含 0.7 的 `'persistent-implementation-ref'`） | `wrong-kind` | Binding 赋值路径报 `{ descriptor: <binding id>, problem: 'invalid-assignment' }`（0.7 S7 的赋值形状检查，不变）；`set.load()` 把非实现引用当候选引用读，报 `{ descriptor: 'CandidateRef', problem: 'not-from-this-runtime' }`（0.7 不变） |
| `familyId` 缺失或为空；`range` 缺失、为空或不是合法范围；0.5 的 `implementationId` 键；0.7 的 `version` 键；`contractId` 不是该 Contract | `malformed-implementation-ref`（0.8 新增的唯一 `problem` 词汇） | `parse()` 的消息：`Invalid implementation reference for Contract <id>.`；赋值：`Malformed implementation reference assigned to Binding <id>.`；目录：`catalog.resolve() received a malformed implementation reference.` |

`parse()` 在 0.7 对非法输入抛的是普通 `TypeError`；0.8 统一为 `INVALID_DESCRIPTOR`（`{ descriptor: 'ImplementationRef', problem }`）——这是本次发布唯一改变错误类别的地方，由 §2.2 F9 / §4 A05 规定，触发条件不变。`kind` 是判别字段而不是偏好：形状正确而 Family 不在 Runtime 里仍是 `MISSING_IMPLEMENTATION`（`details.version` 是引用要求的范围），绝不换成别的实现。

存量文档：0.8 不读任何更早的序列化形式。写于 0.7 及更早的引用（`kind: 'persistent-implementation-ref'`、`version` 键、0.5 的 `implementationId` 键）在被再次读取之前必须重写为上面的形状——`kind` 改为 `'implementation-ref'`，`version` 改名 `range`（值不变），`implementationId` 改名 `familyId`。Hyla-mini 的 recipe 文档 schema（`apps/hyla-mini/src/domain/recipe-schema.ts`）只接受这一种形状，其他形状在存储边界以 schema 错误拒绝；0.7 的 `normalizeStoredImplementationRef` 与 `legacy-implementation-ref` 事件随旧键一起删除。测试：`packages/core/tests/v08-implementation-ref.test.mjs`（每条写路径的形状；`parse()` 与四条读路径对每种旧形式的拒绝，旧形式取自 0.5 快照记录的数据；`kind` 是判别字段）。

## §7 未改与理由（任务书 §2.5）

| 名字 | 理由 |
|---|---|
| `Binding`、`ServiceRevision` | 各自命名一件事（一个具名的继承选择；一个 Family 的精确修订），与行业用法一致 |
| `load()`、`read()` | 动词的代价可见：`load` 可能触发 setup 并等待，`read` 只返回值（`docs/API_STABILITY.md` 命名准则 2） |
| `parameters`、`provides`、`requires` | 定义面的三个名词，0.5 起从未引起歧义 |
| `reuse`、`override`、`auto`、`forward` | 0.6 收束时确定的名字；每个都是一个概念一个名字 |
| `C.all`、`ImplementationSet` | 集合形式与其类型；`'all-implementations'` 只是 inspect 节点与描述符的 `kind` 值（D3） |
| `EntryOptions` | `enter` / `run` / `check` / `explain` / `derive` 共用的调用选项记录（S1 让 `derive` 也用它） |
| `LINEAGE_UNIQUENESS_CONFLICT` | 码名说的是冲突本身；F18 只把 details 里的 `anchor*` 改为 `pinned*` |
| `details.site` 与 `RuntimePolicyContext.dependencySite` | 错误细节里的 `site` 是 0.5 快照固定的键；策略上下文的 `dependencySite` 是 0.6 R6 的名字；两者所指相同但记录在不同层（`docs/DEFERRED.md` N3） |
| `run()` 的 `undefined` 槽位（`run(entry, params, undefined, callback)`） | 回调永远最后的调用形态（0.7 §1），不是名字 |
| 无名的 `contract()` / `service()` / `entry()` 与有名的 `input()` / `binding()` | Service、Contract、Entry 可由包名与 `syna.id` 命名；Input 与 Binding 是参数键，必须有名 |
| `inputs.inherited`、`inputsInherited`、`bindingsInherited` | D5 的界线：Input 与 Binding 声明会被继承，Service slot 只会被复用（`reused`） |
| 内部 `*Key` 标识符、`MISSING_IMPLEMENTATION.details.version`、未类型化的 `details.state`、`persistent:` 站点标签、`all:` 节点 id 前缀、`activating` / `starting` | 表外发现，登记在 `docs/DEFERRED.md` 命名（2.0）节，只能在下一个 major 改 |

## §8 迁移步骤

1. 升级 `@syna/core` 到 0.8.0，构建（codemod 需要 0.8 的类型声明）。
2. 跑 `node scripts/codemod-v08.mjs <你的源码>`；退出码 2 时按列出的原因处理手工位点（§5），再跑一次直到 `0 edits`。
3. `tsc`：残留的旧名都是编译错误——不存在的类型、不存在的属性、不可赋值的字面量、options 里的多余属性。
4. 跑测试：四种运行时可读的旧形式（F4 / F16 的定义选项、F16 的 limit、S1 的 `derive(constraints)`、S2 的 `revisions(familyId)`）以带出路的错误拒绝；`parse()` 的调用方若以 `TypeError` 分支处理非法引用，改为 `isSynaError(e, 'INVALID_DESCRIPTOR')`（§6）。
5. 重写存量文档里的实现引用（§6）；没有诊断事件可以找出旧形式——读取即拒绝，所以在读之前重写。
6. 诊断处理器：按 D8 改事件名；D10 的处理器删除；D7 的账本状态改为 `'overdue'`；F15 的 `attempt` 改为 `attemptNumber`。
7. 断言与快照：按本表映射改写（`node.placement === 'reused'`、`services.reused`、`planCache.limit`、`item.elapsedMs`……），不是删除；explain / inspect 的其余内容逐字不变。
