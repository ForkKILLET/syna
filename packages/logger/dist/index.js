import { define } from './syna.js';
export const Logger = define.service({
    eager: true,
    revisionMetadata: {
        displayName: 'Demo Logger 1.1',
    },
    setup(_dependencies, { onDispose }) {
        const messages = [];
        const write = (level, message) => {
            const line = `[${level}] ${message}`;
            messages.push(line);
            console.log(line);
        };
        onDispose(() => write('INFO', 'logger disposed'));
        return {
            debug: message => write('DEBUG', message),
            info: message => write('INFO', message),
            get messages() {
                return messages;
            },
        };
    },
});
//# sourceMappingURL=index.js.map