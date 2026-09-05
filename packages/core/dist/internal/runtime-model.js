export class NeedChoice extends Error {
    data;
    constructor(data) {
        super(`A resolution choice is required at ${data.site}.`);
        this.name = 'NeedChoice';
        this.data = data;
    }
}
//# sourceMappingURL=runtime-model.js.map