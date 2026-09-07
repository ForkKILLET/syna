# Syna（中文简介）

[![CI](https://github.com/synajs/syna/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/synajs/syna/actions/workflows/ci.yml)

[English](README.md) | 简体中文 · 源码：[github.com/synajs/syna](https://github.com/synajs/syna) · 问题：[github.com/synajs/syna/issues](https://github.com/synajs/syna/issues) · `@syna/core` 与 `@syna/tsconfig` 版本 1.0.0-rc.2（公开面自 0.8.0 冻结，见 `docs/API_STABILITY.md`；从 tarball 基线到 1.0 的脉络见 `docs/HISTORY.md`）

Syna 把一个 TypeScript 程序的各个部件——连接池、某个服务商的客户端、请求处理器——组合成能干净地打开与关闭的世界。每个部件只声明一次：它需要什么、怎样启动；由 Syna 决定哪个世界创建它、哪些世界共享它、何时关闭它。不同租户的部件互不相干而无需 scope 对象，连接池只存在一份，用户选择的或测试里替换的服务商是一条声明而不是一次改写。

一段话的模型：Runtime 接纳有限的带版本 Service 集合；Entry 打开 Env 世界；每个世界对每个 resolved 部件只有一个可见 slot，默认复用父世界的 slot，Service 实例按需或 eager 物化，`load()` 返回普通 Promise。模型见 `docs/SEMANTIC_MODEL.md`，术语见 `docs/GLOSSARY.md`，公开面见 `docs/API_REFERENCE.md`。

## 七个示例

`apps/01-basics` … `apps/07-failure-modes`：同一个虚构领域（多租户通知投递服务），每个示例回答一个问题，按阅读顺序编号。每个程序自己断言结果，断言失败即非零退出，打印其 README 列出的稳定行，并各自是发布门禁的一个步骤。组织方式、夹具、命名规则（示例使用虚构名字；只有代码真的与某个产品交互时才使用它的真名）以及"手册的 snippet 来自示例"的声明见 `docs/EXAMPLES.md`。

| 示例 | 回答的问题 |
|---|---|
| `apps/01-basics` | 怎样定义一个服务的部件、把它们连起来，并在一个能干净打开与关闭的世界里运行？ |
| `apps/02-per-tenant` | 每个租户要有自己的服务商客户端和发件箱，而连接池与日志器全局共享——不引入具名 scope。 |
| `apps/03-user-configurable` | 让租户选择自己的服务商、把选择存下来，下一次请求就用它。 |
| `apps/04-two-versions` | 服务商发布了 SDK 2.x：在 1.x 时代做出选择的租户照常工作，新租户用 2.x。 |
| `apps/05-scheduled-jobs` | 服务内部的调度器为每个租户打开一个类型化的摘要世界，跑完即关。 |
| `apps/06-testing` | 在集成测试里替换真实服务商，而不动被测程序。 |
| `apps/07-failure-modes` | setup 失败、卡住、或世界在它脚下关闭时会发生什么——该读哪些字段？ |

```sh
npm run demo        # 先构建，再依次运行七个；每个以 `<name>: OK` 结束
npm run demo:03     # 只运行一个
```

## 一屏示例

同一程序的四个文件；`npm run test:scripts` 会按此处的原样编译并运行它们（`scripts/tests/readme-example.test.mjs`）。它是 `apps/02-per-tenant` 与 `apps/03-user-configurable` 的一屏版：同一个 Contract 后面的两个服务商，作为世界事实的租户，存成 JSON 又读回来的选择。

`package.json`

```json
{
  "name": "notify",
  "version": "1.0.0",
  "type": "module",
  "imports": { "#syna/package": "./package.json" }
}
```

`src/notify.ts`

```ts
import packageJson from '#syna/package' with { type: 'json' }
import { definePackage } from '@syna/core'

export const define = definePackage(packageJson)

export interface Notifier { send(to: string, text: string): string }
export const Notifier = define.contract<Notifier>('notifier')
export const CurrentTenant = define.input<{ id: string; apiKey: string }>('current-tenant')

export const Acme = define.service('acme', {
  provides: [Notifier],
  requires: { tenant: CurrentTenant },
  setup({ tenant }) {
    const { apiKey } = tenant.read()
    return { send: (to: string, text: string) => `acme(${apiKey}) → ${to}: ${text}` }
  },
})

export const Globex = define.service('globex', {
  provides: [Notifier],
  setup() {
    return { send: (to: string, text: string) => `globex → ${to}: ${text}` }
  },
})
```

`src/outbox.ts`

```ts
import type { Runtime } from '@syna/core'
import { CurrentTenant, Notifier, define } from './notify.js'

export const Preferred = define.binding('preferred', Notifier)

export const Outbox = define.service('outbox', {
  requires: { notifier: Preferred, tenant: CurrentTenant },
  async setup({ notifier, tenant }) {
    const provider = await notifier.load()
    const { id } = tenant.read()
    return { deliver: (text: string) => provider.send(`owner@${id}.test`, text) }
  },
})

export const TenantEntry = define.entry('tenant', {
  requires: { outbox: Outbox },
  parameters: { tenant: CurrentTenant, notifier: Preferred },
})

export async function deliver(runtime: Runtime, id: string, stored: string) {
  const notifier = Preferred.parse(JSON.parse(stored))
  const tenant = { id, apiKey: `key-${id}` }
  return runtime.run(TenantEntry, { tenant, notifier }, async ({ outbox }) => (await outbox.load()).deliver('welcome'))
}
```

`src/main.ts`

```ts
import { createRuntime } from '@syna/core'
import { Acme, Globex } from './notify.js'
import { Outbox, Preferred, TenantEntry, deliver } from './outbox.js'

const runtime = createRuntime({ services: [Acme, Globex, Outbox] })

const settings = { 'acme-corp': JSON.stringify(Preferred.to(Acme)), 'globex-fans': JSON.stringify(Preferred.to(Globex)) }
console.log(settings['globex-fans'])

const plan = await runtime.explain(TenantEntry, { tenant: { id: 'acme-corp', apiKey: 'key-acme-corp' }, notifier: Preferred.to(Acme) })
if (plan.ok) console.log(plan.services.new, plan.forks.map(fork => fork.label).join(', '))

for (const [id, stored] of Object.entries(settings)) console.log(await deliver(runtime, id, stored))
await runtime.dispose()
```

`node dist/main.js` 输出：

```
{"kind":"implementation-ref","contractId":"notify/notifier/v1","familyId":"notify/globex","range":"^1.0.0"}
2 notify/binding/preferred/v1->notify/acme@1.0.0, notify/input/current-tenant/v1, notify/acme@1.0.0, notify/outbox@1.0.0
acme(key-acme-corp) → owner@acme-corp.test: welcome
globex → owner@globex-fans.test: welcome
```

四行各说一件事：存下来的选择是只有一种形状的 JSON（`Binding.to()` 写出，`parse()` 拒绝其他任何形状）；`explain()` 在创建任何东西之前说明一个世界会新建或分叉哪些部件、为什么（这里是两个 Service，加上该世界提供的租户事实与选择）；每个租户世界得到自己的 `Outbox` 与它选择的服务商，都出自同一个 Runtime。`serviceRef.load()` 是普通 Promise；复用只看父世界；Service 拥有的 `AnchoredEntry` 需要 Ready 的拥有者（否则 `OWNER_NOT_READY`）。

## 参考应用

`apps/multitenant-blog`（`@syna-app/multitenant-blog`）是驱动内核的窄范围完整应用：真实 PostgreSQL 与真实文件系统两后端 × HTTP 动态渲染与静态构建两方式；三份 Markdown 配方共享一组 remark/rehype 工厂 slot；两租户、域名映射、可替换认证；按需、有界、租约保护的站点世界工作集。说明见 `docs/MULTITENANT_BLOG.md`，插件协议见 `docs/PLUGIN_AUTHORING.md`；先读示例，涉及规模、资源与运行边界的问题再读应用。

```sh
npm run demo:multitenant-blog     # 三格：HTTP alpha、HTTP beta、静态 alpha（文件系统后端）；任一格不是 200 即退出 1
node scripts/pg-test-cluster.mjs with -- node apps/multitenant-blog/bin/multitenant-blog.mjs demo --backend postgres
node apps/multitenant-blog/bin/multitenant-blog.mjs serve --root /tmp/blog-content --port 8080
curl -H 'Host: alpha.test' http://127.0.0.1:8080/posts/shared-slug
```

## 构建、测试与门禁

命令与文档索引见英文 `README.md`（`npm ci && npm run build`、`npm test`、`npm run test:app`、`npm run test:scripts`、`npm run test:postgres`）。验收入口（门禁从 `package.json` 读取版本，输出在 `validation/v<version>-<mode>/`）：

```sh
node scripts/verify-release.mjs --dev
node scripts/verify-release.mjs --release
```

后者只在全部必跑项目通过（含真实 PostgreSQL、与 0.8.0 记录逐项相同且自 1.0.0-rc.1 起零变化的 API 清单、七个示例各自的稳定行、两侧都以 `--no-maglev` 运行的与 1.0.0-rc.1 的同会话 benchmark 对比、厂商名扫描）、归档在空目录重建通过时输出 `COMPLETE` 并退出 0；一次门禁运行的证据（`RELEASE_MANIFEST.json`、`validation/v<version>-release/`、由其生成的 `docs/VALIDATION.md`）随发布 commit 一起提交。

1.0.0-rc.2 相对 1.0.0-rc.1 与 0.8.0 内核零代码变化——公开 API 清单 374 项逐项相同、0 个 `@deprecated`（发布门禁的 `api-inventory-frozen` 与 `api-inventory-unchanged` 步骤及 `scripts/tests/api-inventory.test.mjs` 断言）；本轮重建示例与夹具、参考应用更名，见 `CHANGELOG.md` 与 `docs/HISTORY.md`。v0.8 是 1.0 之前最后一次改名：逐项对照表、codemod（`scripts/codemod-v08.mjs`）、实现引用唯一的序列化形状与刻意未改的名字见 `docs/MIGRATION_V07_TO_V08.md`，冻结的公开面与命名准则见 `docs/API_STABILITY.md`（1.0 前不承诺兼容，公开面自 0.8.0 冻结，1.0 起只按 major 变化），未做的事与只能在下一个 major 改的名字见 `docs/DEFERRED.md`；v0.7 的到期删除、错误码映射与 S1/S2 语义修订见 `docs/MIGRATION_V06_TO_V07.md` 与 `docs/SEMANTIC_CHANGES_V07.md`；v0.6 的 API 收束见 `docs/MIGRATION_V05_TO_V06.md`，v0.5 的语义变更见 `docs/SEMANTIC_CHANGES_V05.md`。
