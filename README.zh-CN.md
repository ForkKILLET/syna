# Syna（中文简介）

[![CI](https://github.com/synajs/syna/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/synajs/syna/actions/workflows/ci.yml)

[English](README.md) | 简体中文 · 源码：[github.com/synajs/syna](https://github.com/synajs/syna) · 问题：[github.com/synajs/syna/issues](https://github.com/synajs/syna/issues) · `@syna/core` 与 `@syna/tsconfig` 版本 1.0.0-rc.1（公开面自 0.8.0 冻结，见 `docs/API_STABILITY.md`；从 tarball 基线到 1.0 的脉络见 `docs/HISTORY.md`）

Syna 是面向 TypeScript 的不可变、作用域感知的能力组合运行时。Runtime 接纳有限的带版本 Service 集合；Entry 创建 Env 世界；每个 Env 对每个 resolved node 只有一个 canonical slot，默认只复用 **parent 当前可见** 的 slot，Service 实例按需或 eager 物化，`load()` 返回普通 Promise。

Hyla-mini（`apps/hyla-mini`）是驱动本轮的窄范围完整应用：真实 PostgreSQL 与真实文件系统两后端 × HTTP 动态渲染与静态构建两方式；三份 Markdown 配方共享一组 remark/rehype 工厂 slot；两租户、域名映射、可替换认证；按需、有界、租约保护的 SiteEnv 工作集。

命令、文档索引与演示见英文 `README.md`。1.0.0-rc.1 相对 0.8.0 内核零代码变化——公开 API 清单 374 项逐项相同、0 个 `@deprecated`（发布门禁的 `api-inventory-frozen` 步骤与 `scripts/tests/api-inventory.test.mjs` 断言），只改元数据、工具与文档（`CHANGELOG.md`）；v0.8 是 1.0 之前最后一次改名：逐项对照表、codemod（`scripts/codemod-v08.mjs`）、实现引用唯一的序列化形状与刻意未改的名字见 `docs/MIGRATION_V07_TO_V08.md`，术语表见 `docs/GLOSSARY.md`，冻结的公开面与命名准则见 `docs/API_STABILITY.md`（1.0 前不承诺兼容，公开面自 0.8.0 冻结，1.0 起只按 major 变化），未做的事与只能在下一个 major 改的名字见 `docs/DEFERRED.md`；v0.7 的到期删除、错误码映射与 S1/S2 语义修订见 `docs/MIGRATION_V06_TO_V07.md` 与 `docs/SEMANTIC_CHANGES_V07.md`（保留/澄清/修订/撤回登记）；v0.6 的 API 收束见 `docs/MIGRATION_V05_TO_V06.md`，v0.5 的语义变更见 `docs/SEMANTIC_CHANGES_V05.md`，应用说明见 `docs/HYLA_MINI.md`。

## 一屏示例

同一程序的四个文件；`npm run test:scripts` 会按此处的原样编译并运行它们（`scripts/tests/readme-example.test.mjs`）。

`package.json`

```json
{
  "name": "greeter",
  "version": "1.0.0",
  "type": "module",
  "imports": { "#syna/package": "./package.json" }
}
```

`src/greeter.ts`

```ts
import packageJson from '#syna/package' with { type: 'json' }
import { definePackage } from '@syna/core'

export const define = definePackage(packageJson)

export const Audience = define.input<{ name: string }>('audience')

export const Greeter = define.service({
  requires: { audience: Audience },
  setup({ audience }) {
    const { name } = audience.read()
    return { greet: () => `hello, ${name}` }
  },
})
```

`src/conversation.ts`

```ts
import type { Runtime } from '@syna/core'
import { Audience, Greeter, define } from './greeter.js'

export const Conversation = define.entry('conversation', {
  requires: { greeter: Greeter },
  parameters: { audience: Audience },
})

export const Aside = define.entry('aside', {
  requires: { greeter: Greeter },
  reuse: { fresh: [Greeter] },
})

export async function converse(runtime: Runtime) {
  const world = await runtime.enter(Conversation, { audience: { name: 'world' } })
  const shared = await world.deps.greeter.load()
  console.log(shared.greet())

  const aside = await world.enter(Aside)
  const own = await aside.deps.greeter.load()
  console.log(own === shared, own.greet())

  await world.dispose()
}
```

`src/main.ts`

```ts
import { createRuntime } from '@syna/core'
import { Conversation, converse } from './conversation.js'
import { Greeter } from './greeter.js'

const runtime = createRuntime({
  services: [Greeter],
  limits: { loadTimeoutMs: 5_000, disposalGraceMs: 1_000 },
})

const plan = await runtime.explain(Conversation, { audience: { name: 'world' } })
if (plan.ok) console.log(plan.services.new, plan.forks.map(fork => fork.label))

await converse(runtime)
await runtime.dispose()
```

`node dist/main.js` 输出：

```
1 [ 'greeter/input/audience/v1', 'greeter@1.0.0' ]
hello, world
false hello, world
```

验收入口（门禁从 `package.json` 读取版本，输出在 `validation/v<version>-<mode>/`）：

```sh
node scripts/verify-release.mjs --dev
node scripts/verify-release.mjs --release
```

后者只在全部必跑项目通过（含真实 PostgreSQL、与 0.8.0 记录逐项相同的 API 清单、两侧都以 `--no-maglev` 运行的同会话 benchmark 对比）、归档在空目录重建通过时输出 `COMPLETE` 并退出 0；一次门禁运行的证据（`RELEASE_MANIFEST.json`、`validation/v<version>-release/`、由其生成的 `docs/VALIDATION.md`）随发布 commit 一起提交。
