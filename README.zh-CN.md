# Syna

Syna 是一个面向 TypeScript 的、作用域感知的依赖注入与能力组合运行时。Runtime 显式接纳有限且版本明确的 Service；Entry 创建不可变的 Env 世界；每个 Env 对每个 resolved node 只有一个 canonical visible slot，并在满足约束时最大化复用祖先 slot。Service 可以 lazy 或 eager materialize，但 materialization 顺序不会改变拓扑。

本仓库是 **Syna Core Semantic Model v0** 与 refined **v0.4.0 API** 的完整可执行参考实现。

## 核心不变量

- 创建 Runtime 时没有 Env、slot 或 Service instance。
- 每个 Env 都由一次 Entry invocation 创建。
- Runtime 定义集合与 Env topology 均不可变。
- Lazy 只改变 materialization 时机，不改变版本、owner 或实例身份。
- 一个 Env 对一个 canonical resolved node 只有一个可见 slot。
- 某个 dependency slot 变化时，其 reverse dependency closure 自动分叉。
- 结构依赖环合法；setup 阶段的动态等待环立即报错。
- 多个 Service revision 可以正常共存。
- Input 表示由外界提供、没有自身生命周期的上下文事实。
- Contract 有运行时名义身份，但没有独立实例和生命周期。

## 定义一个包

```ts
import packageJson from '#syna/package' with { type: 'json' }
import { definePackage } from '@syna/core'

export const define = definePackage(packageJson)
```

包的 `package.json`：

```json
{
  "name": "@example/postgres",
  "version": "2.4.1",
  "type": "module",
  "imports": {
    "#syna/package": "./package.json"
  }
}
```

Service 的导出名不带版本号，精确 revision 自动来自 package version：

```ts
export interface PostgresConfig {
  connectionString: string
}

export const DatabaseConfig =
  define.input<PostgresConfig>('database-config')

export interface Postgres {
  query<T>(sql: string): Promise<readonly T[]>
}

export const Postgres = define.service({
  requires: { config: DatabaseConfig },

  async setup({ config }, { onDispose }): Promise<Postgres> {
    const settings = await config.load()
    const pool = createPool(settings.connectionString)
    onDispose(() => pool.close())

    return {
      query: sql => pool.query(sql),
    }
  },
})
```

依赖是 inert 的 `DependencyRef<T>`；只有调用 `.load()` 才会 materialize 已经规划好的 canonical slot。

## Contract 依赖

```ts
export interface LlmConnector {
  complete(prompt: string): Promise<string>
}

export const Llm = define.contract<LlmConnector>('llm')
```

```ts
const Consumer = define.service('consumer', {
  requires: {
    strictDefault: Llm,
    policySelected: auto(Llm),
    selectable: Llm.selector,
    allTogether: Llm.all,
  },
  setup(deps) { /* ... */ },
})
```

- 裸 Contract 要求实现 Family 无歧义。
- `auto(C)` 表示这条依赖边显式接受 Runtime 的自动选择策略。
- `C.selector` 冻结全部候选，并把每个候选作为独立 child world 预检；候选可以是 `available` 或 `unavailable`，不要求彼此共存。
- `C.all` 才表示所有 admitted implementation revisions 必须在当前 Env 中共同存在。

## Binding

Binding 表示具有业务身份、可持久化、可由多个消费者共享的实现选择：

```ts
export const SummaryLlm = define.binding('summary-llm', Llm)

const Summarizer = define.service('summarizer', {
  requires: { llm: SummaryLlm },
  setup({ llm }) {
    return {
      async summarize(text: string) {
        return (await llm.load()).complete(text)
      },
    }
  },
})
```

```ts
const storedRef = SummaryLlm.to(OpenAI)
```

`0.2.0` 默认生成 `^0.2.0`，`2.4.1` 默认生成 `^2.4.1`，不会再出现不可满足的 `^0.0.0`。

## Entry 与 Env

```ts
const AppEntry = define.entry('app', {
  requires: { database: Postgres },
  parameters: { config: DatabaseConfig },
})

const runtime = createRuntime({ services: [Postgres] })

await runtime.run(
  AppEntry,
  { config: { connectionString: 'postgres://localhost/app' } },
  async ({ database }) => {
    await (await database.load()).query('select 1')
  },
)
```

Service 也可以把 Entry 声明为依赖。得到的 `BoundEntry` 固定锚定在该 Service slot 的 owner Env，从而可以创建类型安全的后代世界，又不会引入含混的 ambient current Env：

```ts
const UnitOfWork = define.service('unit-of-work', {
  requires: { transaction: TransactionEntry },
  setup({ transaction }) {
    return {
      async run(input, callback) {
        const entry = await transaction.load()
        return entry.run(input, async ({ tx }) => callback(await tx.load()))
      },
    }
  },
})
```

## 验证

```bash
npm install
npm run check
npm run test:coverage
npm run benchmark:v04
```

`npm run check` 会执行 strict TypeScript project build、正负类型测试、完整行为测试和全部 demo。

详细资料见 `docs/`。
