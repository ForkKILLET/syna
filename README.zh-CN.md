# Syna v0.5 + Hyla-mini（中文简介）

Syna 是面向 TypeScript 的不可变、作用域感知的能力组合运行时。Runtime 接纳有限的带版本 Service 集合；Entry 创建 Env 世界；每个 Env 对每个 resolved node 只有一个 canonical slot，默认只复用 **parent 当前可见** 的 slot，Service 实例按需或 eager 物化，`load()` 返回普通 Promise。

Hyla-mini（`apps/hyla-mini`）是驱动本轮的窄范围完整应用：真实 PostgreSQL 与真实文件系统两后端 × HTTP 动态渲染与静态构建两方式；三份 Markdown 配方共享一组 remark/rehype 工厂 slot；两租户、域名映射、可替换认证；按需、有界、租约保护的 SiteEnv 工作集。

命令、文档索引与演示见英文 `README.md`；语义变更见 `docs/SEMANTIC_CHANGES_V05.md`，迁移见 `docs/MIGRATION_V04_TO_V05.md`，应用说明见 `docs/HYLA_MINI.md`。

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
  limits: { setupDeadlineMs: 5_000, disposalGraceMs: 1_000 },
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

验收入口：

```sh
node scripts/verify-v05.mjs --dev
node scripts/verify-v05.mjs --release
```

后者只在全部必跑项目通过（含真实 PostgreSQL）、归档在空目录重建通过时输出 `COMPLETE` 并退出 0。
