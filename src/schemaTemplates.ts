export class SchemaTemplates {
    private readonly nameToTemplate: Map<string, SchemaTemplate> = new Map();

    constructor(templates: SchemaTemplate[]) {
        templates.forEach(t => this.nameToTemplate.set(t.name, t));
    }

    getBySchemaName(name: string): SchemaTemplate | undefined {
        return this.nameToTemplate.get(name);
    }

    matchByFileName(fileName: string): SchemaTemplate | undefined {
        for (let template of this.nameToTemplate.values()) {
            if (template.filePattern === fileName) { // TODO: replace with glob pattern matching
                return template;
            }
        }
    }
}
