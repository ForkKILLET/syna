import packageJson from '#syna/package' with { type: 'json' };
import { createRuntime, definePackage } from '@syna/core';
const define = definePackage(packageJson);
const Name = define.input('name');
const Greeter = define.service({
    requires: { name: Name },
    setup({ name }) {
        return {
            async greet() {
                return `Hello, ${await name.load()}!`;
            },
        };
    },
});
const Main = define.entry({
    requires: { greeter: Greeter },
    parameters: { name: Name },
});
const runtime = createRuntime({ services: [Greeter] });
await runtime.run(Main, { name: 'Syna' }, async ({ greeter }) => {
    console.log(await (await greeter.load()).greet());
});
//# sourceMappingURL=index.js.map