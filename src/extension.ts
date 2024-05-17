// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import {OutputChannel, Uri, workspace} from "vscode";
import * as yaml from 'js-yaml';

const SCHEMA = "myschema";

let log: OutputChannel;

type SchemaTemplate = {
	name: string;
	filePattern: string;
	schema: string
};

class SchemaTemplates {
	private readonly nameToTemplate: Map<string, SchemaTemplate> = new Map();
	constructor(templates: SchemaTemplate[]){
		templates.forEach(t=>this.nameToTemplate.set(t.name, t));
	}

	getBySchemaName(name: string): SchemaTemplate | undefined {
		return this.nameToTemplate.get(name);
	}

	matchByFileName(fileName: string): SchemaTemplate | undefined {
		for(let template of this.nameToTemplate.values()){
			if (template.filePattern === fileName) { // TODO: replace with glob pattern matching
				return template;
			}
		}
	}
}

const textDecoder = new TextDecoder();
const workspaceFolderQueryParam = 'workspaceFolder';

async function processSchemaTemplate(template: string, root: Uri): Promise<string> {
	const enumField = "enumSource";
	const templateObj = JSON.parse(template);

	async function traverse(obj: any) {
		for (let key in obj) {
			if (obj.hasOwnProperty(key)) {
				if (key === enumField) {
					const enumSource: EnumSource = obj[key];
					log.appendLine(`Enum source found: ${JSON.stringify(enumSource)}`);
					const enumValues = await resolveEnum(enumSource, root);
					log.appendLine(`Enum values: ${JSON.stringify(enumValues)}`);
					obj['enum'] = enumValues;
					delete obj[enumField];
				} else if (typeof obj[key] === 'object') {
					await traverse(obj[key]); // Recursive call for nested objects
				}
			}
		}
	}

	await traverse(templateObj);

	return JSON.stringify(templateObj);
}

type EnumSource = {
	file: string
	property?: string
	expression?: string
};

async function resolveEnum(enumSource: EnumSource, root: Uri): Promise<string[]> {
	log.appendLine('Resolving enum source: ' + JSON.stringify(enumSource));
	const fileUri = Uri.joinPath(root, enumSource.file);
	const content = textDecoder.decode(await vscode.workspace.fs.readFile(fileUri));
	const yamlContent: any[] = yaml.load(content) as any[];
	if(enumSource.property) {
		const prop = enumSource.property;
		const values = yamlContent.map(i=>i[prop].toString());
		log.appendLine('Loaded enum values: ' + JSON.stringify(values));
		return values;
	}
	if(enumSource.expression) {
		const expr = enumSource.expression;
		const arrowFunction = eval(expr);
		const values = yamlContent.map(i=>{
			let value: string = arrowFunction(i).toString();
			return value;
		});
		log.appendLine('Loaded enum values: ' + JSON.stringify(values));
		return values;
	}
	return [];
}

async function loadSchemas(schemasDir: Uri): Promise<SchemaTemplates> {
	log.appendLine('Loading schemas from: ' + schemasDir);
	const schemaFiles = await vscode.workspace.fs.readDirectory(schemasDir);
	const templates: SchemaTemplate[] = [];
	for(let [schemaFilename, fileType] of schemaFiles ){
		if(fileType === vscode.FileType.File){
			const fileUri = vscode.Uri.joinPath(schemasDir, schemaFilename);
			log.appendLine('Read schema from: ' + fileUri);
			const content = textDecoder.decode(await vscode.workspace.fs.readFile(fileUri));
			const schemaObj = JSON.parse(content);
			const schema: SchemaTemplate = {
				name: schemaFilename,
				filePattern: schemaObj.filePattern,
				schema: content
			};
			templates.push(schema);
			log.appendLine(`Schema template ${schemaFilename}: ` + JSON.stringify(content));
		}
	}
	return new SchemaTemplates(templates);
}

let schemaTemplatesPromise: Promise<SchemaTemplates>;

let schemaTemplates: SchemaTemplates | undefined;

export async function activate(context: vscode.ExtensionContext) {

	log = vscode.window.createOutputChannel('YAML Schema Test');

	const yamlSettings = workspace.getConfiguration('yaml');
	let schemasUri: Uri;
	const setting = 'schemasDir';
	if(yamlSettings.has(setting)) {
		schemasUri = Uri.file(yamlSettings.get<string>(setting, ''));
	}else {schemasUri = context.extensionUri;}
	schemaTemplatesPromise = loadSchemas(schemasUri);
	schemaTemplatesPromise.then(s=>{
		log.appendLine('Schemas are loaded');
		schemaTemplates = s;
	});

	const yamlExtension = vscode.extensions.getExtension("redhat.vscode-yaml");
	if(!yamlExtension) {
		vscode.window.showErrorMessage('vscode-yaml extension not found');
		return;
	}
	const yamlExtensionAPI = await yamlExtension.activate();
	if(!yamlExtensionAPI) {
		vscode.window.showErrorMessage('Failed to activate vscode-yaml extension');
		return;
	}

	function onRequestSchemaURI(resource: string): string | undefined {
		log.appendLine('> onRequestSchemaURI: ' + resource);
		const parsedUri = Uri.parse(resource);
		const filename = parsedUri.path.split('/').pop();
		if(!filename) {
			vscode.window.showErrorMessage('Failed to extract filename: ' + filename);
			return undefined;
		}
		if(!schemaTemplates) {
			log.appendLine('Schemas are not loaded yet');
			return undefined;
		}
		const foundSchema = schemaTemplates.matchByFileName(filename);
		if(!foundSchema) {
			log.appendLine('Schema for file ' + filename + ' not found');
			return undefined;
		}
		log.appendLine('Matched schema template: ' + foundSchema.name);
		const workspaceFolder = vscode.workspace.workspaceFolders?.find((f)=>parsedUri.fsPath.startsWith(f.uri.fsPath));
		if(!workspaceFolder){
			vscode.window.showErrorMessage('Workspace folder not found for resource: ' + resource);
			return undefined;
		}
		log.appendLine('Matched workspace root: ' + workspaceFolder?.uri);
		return `${SCHEMA}://schema/${foundSchema.name}?${workspaceFolderQueryParam}=${workspaceFolder.index}`;
	}

	async function onRequestSchemaContent(schemaUri: string): Promise<string | undefined> {
		log.appendLine('> onRequestSchemaContent: ' + schemaUri);
		const parsedUri = Uri.parse(schemaUri);
		if (parsedUri.scheme !== SCHEMA) {
			return;
		}
		const schemaName = parsedUri.path.split('/').pop();
		if(!schemaName) {
			vscode.window.showErrorMessage('Failed to extract schema name: ' + schemaUri);
			return;
		}
		const schemaTemplates = await schemaTemplatesPromise;
		const schemaTemplate = schemaTemplates.getBySchemaName(schemaName);
		if(!schemaTemplate) {
			vscode.window.showErrorMessage('Unresolved schema template: ' + schemaName);
			return;
		}
		const workspaceFolderIndex = parsedUri.query.split('&')
			.map(q=>q.split('='))
			.find(v=>v[0] === workspaceFolderQueryParam)?.at(1);
		if(!workspaceFolderIndex){
			vscode.window.showErrorMessage('Workspace folder index not extracted from uri: ' + schemaUri);
			return;
		}
		const workspaceFolder = vscode.workspace.workspaceFolders?.at(parseInt(workspaceFolderIndex));
		if(!workspaceFolder) {
			vscode.window.showErrorMessage(`Workspace folder #${workspaceFolderIndex} not found`);
			return;
		}
		log.appendLine(`Workspace folder resolved: `+ workspaceFolder.uri);
		const schema = await processSchemaTemplate(schemaTemplate.schema, workspaceFolder.uri);
		log.appendLine(`Schema template ${schemaName} successfully applied to root ${workspaceFolder.uri}:`);
		log.appendLine(schema);

		return schema;
	}
	yamlExtensionAPI.registerContributor(SCHEMA, onRequestSchemaURI, onRequestSchemaContent);
}

// This method is called when your extension is deactivated
export function deactivate() {}
