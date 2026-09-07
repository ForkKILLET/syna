# Hyla 插件（共享渲染 Factory）作者指南（PLUGIN_AUTHORING）

本文描述 **Hyla 的插件协议**。它是 Hyla 对共享渲染 Factory 的业务规则，不是 Syna 对所有 Service 的全局规则。

## 一个 Factory 是什么

一个 Factory 是提供 `MarkdownStageFactoryContract` 的 Syna Service：

```ts
export const MyStageFactory = define.service('my-stage-factory', {
  provides: [MarkdownStageFactoryContract],
  setup() {
    return createFactory(
      {
        pluginId: 'my-stage',           // 稳定、不含版本
        kind: 'transform',              // parse | transform | bridge | rehype | compile
        optionsVersion: 1,
        optionsSchema: { type: 'object', additionalProperties: false, properties: { /* ... */ } },
        repeatable: false,
      },
      options => processor => processor.use(myUnifiedPlugin, options),
    )
  },
})
```

- **slot 共享**：整个部署只有一个 Factory slot（在 App Env 内），所有租户、配方、请求复用它。`configure(options)` 每次返回一个独立产物（`ConfiguredStage`），产物不是 Syna node，也不拥有资源。
- **可以依赖什么**：只能依赖 `RenderInfrastructureEntry` 已公开提供的基础能力（其他 Factory、`PipelineBuilder`、纯库）。**不得**依赖 `CurrentRequest`、`TenantId`、`SiteSnapshot`、任何 Input，也不得经由私有 helper 间接依赖它们。
- **输入从哪里来**：站点/请求事实一律以 `configure()` 的 options（来自 JSON 配方）或渲染参数进入，不从 Service locator 偷读。
- **产物生命周期**：产物借用 Factory 的资源时不得活过 Factory slot；Hyla 的产物是纯函数式的 unified plugin 装配，不持有资源。需要资源时，由领域 API 明确借用/关闭协议，Syna 不自动把产物变成 node。
- **并发安全**：`configure()` 不得把 options 写入 Factory 级别的共享变量；每个产物必须闭包自己的 options。`unified` processor 会被 `freeze()`，`process()` 可并发调用。
- **重复插件**：unified 对同一插件重复 `.use()` 会合并设置。默认 `repeatable: false`，同一配方中出现两次会被 PipelineBuilder 拒绝；明确支持重复语义时才设 `true`。
- **options 版本**：`optionsVersion` 变化即 breaking；PipelineBuilder 拒绝版本不匹配的配方，不做自动迁移（需要时给出最小显式迁移）。

## 配方（Recipe）

配方是 JSON：`formatVersion`、`name`、`stages[]`（`occurrence` 唯一键、`ref` = ImplementationRef（JSON 键 `kind`/`contractId`/`familyId`/`range`，0.8 起唯一可读的形状：更早的键或 `kind` 一律以 `INVALID_DESCRIPTOR` 拒绝，存量文档按 `docs/MIGRATION_V07_TO_V08.md` F9 重写后才可读）、`optionsVersion`、`options`）。`ref` 通过 `StageFactoryRef.to(MyStageFactory)` 生成，默认版本意图是 caret；保存的是用户意图，实际解析到的版本记录在 `BuiltPipeline.stages[].resolvedVersion` 供诊断。没有目标 Family 时明确失败（`MISSING_IMPLEMENTATION`），不自动换供应商。

阶段顺序规则：恰好一个 `parse` 在首，任意 `transform`（mdast），恰好一个 `bridge`（remark-rehype），任意 `rehype`（hast），恰好一个 `compile` 在尾。

## 可信 / 不可信输入

评论等不可信内容由 `PipelineBuilder.build(document, { trust: 'untrusted' })` 构建（`Renderer.renderComment` 就是这样做的）。构建器在配方之上施加平台策略：`bridge`/`compile` 阶段的 `allowDangerousHtml` 强制为 `false`；最后一个 `rehype` 阶段必须是声明了 `sanitizer` 角色的 Factory（`createFactory({ …, sanitizer: { options } })`），否则构建器把平台的 `rehype-sanitize` 追加为最后一个 rehype 阶段（`BuiltPipeline.stages[].appended`）。所以一个注册在 sanitize 之后的第三方 rehype 阶段不能把脚本或事件处理器带回评论输出；配方作者仍应把 `rehype-sanitize` 放在会添加属性的插件之前，以表达意图。没有任何已接纳的 sanitizer Factory 时，`untrusted` 构建以 `RecipeError` 拒绝。声明 `sanitizer` 角色的 Factory 必须让 `options` 产生一遍独立的处理（unified 会把同一插件身份的重复 `use()` 并入第一次）：平台的实现为每个配置创建一个新的插件函数（`rehypeSanitizeOwnPass()`），而不是共用一个「最后一遍」身份——共用身份会被同样声明 `finalPass` 的配方阶段吸收；构建器在追加之后核对 `processor.attachers` 确实多了一项，否则以 `RecipeError` 拒绝该配方的不可信构建（第三轮复审 F-AP3-01）。这是 Hyla 的业务安全策略，Syna core 不理解它。

## 启动预检（check / explain）

`createHylaApp()` 在监听前对 `RenderInfrastructureEntry`（含 `MarkdownStageFactoryContract.all`）执行 `explain()`。一个依赖 `CurrentRequest` 的 Factory 会在此以 `MISSING_INPUT` 加依赖路径被拒绝，而不是等某个租户的首个请求才失败（见 `tests/preflight.test.mjs`）。

`check()` 不能证明任意 JS 不读全局变量。`tests/preflight.test.mjs` 里的并发协议探针（`PollutingStageFactory`）演示了运行期检测闭包污染的方法：用不同 options 配置两个产物并交错执行，输出必须只取决于各自的 options。

## 请求分叉预算

`REQUEST_BUDGET`（默认本地 Service ≤ 10，且 PipelineBuilder / Renderer / SiteContext / 全部 Factory 必须 inherited；`DatabasePool` 等按资源成本计价）。`preflightRequests()` 对每个租户 explain 一次 RequestEntry 并在违规时拒绝部署。预算区分 Service 数、Input 数、synthetic 数与资源成本，不能靠漏记口径让表好看。
