// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { OutputChannel, Uri, workspace } from 'vscode';
import * as yaml from 'js-yaml';
import { SchemaTemplates } from "./schemaTemplates";
import { SchemaTemplate } from "./schemaTemplate";
import { EnumSource } from "./enumSource";
import { AssertionError } from "node:assert";

const SCHEMA = "schema-template";
const textDecoder = new TextDecoder();
const workspaceFolderQueryParam = 'workspaceFolder';

let outputChannel: OutputChannel;
let schemaTemplates: SchemaTemplates;

function log(message: string) {
	outputChannel.appendLine(message);
}

function assertOk<T>(obj: T | undefined, getMessage: () => string): asserts obj {
	assert(obj !== undefined, getMessage);
}

function assert(condition: boolean, getMessage: () => string): asserts condition {
	if (!condition) {
		const message = getMessage();
		log('ERROR: ' + message);
		vscode.window.showErrorMessage(message);
		throw new AssertionError({ message });
	}
}

async function processSchemaTemplate(template: string, root: Uri): Promise<string> {
	const enumField = "enumSource";
	const templateObj = JSON.parse(template);

	async function traverse(obj: any) {
		for (let key in obj) {
			if (obj.hasOwnProperty(key)) {
				if (key === enumField) {
					const enumSource: EnumSource = obj[key];
					log(`Enum source found: ${JSON.stringify(enumSource)}`);
					const enumValues = await resolveEnum(enumSource, root);
					log(`Enum values: ${JSON.stringify(enumValues)}`);
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

async function resolveEnum(enumSource: EnumSource, root: Uri): Promise<string[]> {
	log('Resolving enum source: ' + JSON.stringify(enumSource));
	const fileUri = Uri.joinPath(root, enumSource.file);
	const content = textDecoder.decode(await vscode.workspace.fs.readFile(fileUri));
	const yamlContent: any[] = yaml.load(content) as any[];
	if (enumSource.property) {
		const prop = enumSource.property;
		const values = yamlContent.map(i => i[prop].toString());
		log('Loaded enum values: ' + JSON.stringify(values));
		return values;
	}
	if (enumSource.expression) {
		const expr = enumSource.expression;
		const arrowFunction = eval(expr);
		const values = yamlContent.map(i => {
			let value: string = arrowFunction(i).toString();
			return value;
		});
		log('Loaded enum values: ' + JSON.stringify(values));
		return values;
	}
	return [];
}

async function loadSchemas(schemasDir: Uri): Promise<SchemaTemplates> {
	log('Loading schemas from: ' + schemasDir);
	const schemaFiles = await vscode.workspace.fs.readDirectory(schemasDir);
	const templates: SchemaTemplate[] = [];
	for (let [schemaFilename, fileType] of schemaFiles) {
		if (fileType === vscode.FileType.File) {
			const fileUri = vscode.Uri.joinPath(schemasDir, schemaFilename);
			log('Read schema from: ' + fileUri);
			const content = textDecoder.decode(await vscode.workspace.fs.readFile(fileUri));
			const schemaObj = JSON.parse(content);
			const schema: SchemaTemplate = {
				name: schemaFilename,
				filePattern: schemaObj.filePattern,
				schema: content
			};
			templates.push(schema);
			log(`Schema template ${schemaFilename}: ` + JSON.stringify(content));
		}
	}
	return new SchemaTemplates(templates);
}

/**
 * Generates URI for loading schema for given YAML file
 * @param resource
 */
function onRequestSchemaURI(resource: string): string | undefined {
	log('> onRequestSchemaURI: ' + resource);
	const parsedUri = Uri.parse(resource);
	const filename = parsedUri.path.split('/').pop();
	assertOk(filename, () => 'Failed to extract filename: ' + filename);
	if (!schemaTemplates) {
		log('Schemas are not loaded yet');
		return undefined;
	}
	const foundSchema = schemaTemplates.matchByFileName(filename);
	if (!foundSchema) {
		log('Schema for file ' + filename + ' not found');
		return undefined;
	}
	log('Matched schema template: ' + foundSchema.name);
	const workspaceFolder = vscode.workspace.workspaceFolders?.find((f) => parsedUri.fsPath.startsWith(f.uri.fsPath));
	assertOk(workspaceFolder, () => 'Workspace folder not found for resource: ' + resource);
	log('Matched workspace root: ' + workspaceFolder?.uri);
	return `${SCHEMA}://schema/${foundSchema.name}?${workspaceFolderQueryParam}=${workspaceFolder.index}`;
}

/**
 * Resolved schema URI into JSON schema
 * @param schemaUri
 */
async function onRequestSchemaContent(schemaUri: string): Promise<string | undefined> {
	log('> onRequestSchemaContent: ' + schemaUri);
	const parsedUri = Uri.parse(schemaUri);
	if (parsedUri.scheme !== SCHEMA) {
		return; // Skip unknown schemaUri
	}

	// Extract filename for schema template
	const schemaName = parsedUri.path.split('/').pop();
	assertOk(schemaName, () => 'Failed to extract schema name from ' + schemaUri);

	// Load schema template
	const schemaTemplate = schemaTemplates.getBySchemaName(schemaName);
	assertOk(schemaTemplate, () => 'Unresolved schema template: ' + schemaName);

	// Extract index of workspace folder
	const workspaceFolderIndex = parsedUri.query.split('&')
		.map(q => q.split('='))
		.find(v => v[0] === workspaceFolderQueryParam)?.at(1);
	assertOk(workspaceFolderIndex, () => 'Workspace folder index not extracted from uri: ' + schemaUri);

	// Resolve workspace root URI
	const workspaceFolder = vscode.workspace.workspaceFolders?.at(parseInt(workspaceFolderIndex));
	assertOk(workspaceFolder, () => `Workspace folder #${workspaceFolderIndex} not found`);
	log(`Workspace folder resolved: ` + workspaceFolder.uri);

	// Apply schema template to workspace root
	const schema = await processSchemaTemplate(schemaTemplate.schema, workspaceFolder.uri);
	log(`Schema template ${schemaName} successfully applied to root ${workspaceFolder.uri}:`);
	log(schema);

	return schema;
}

export async function activate(context: vscode.ExtensionContext) {

	outputChannel = vscode.window.createOutputChannel('YAML Schema Test');

	// Locate directory with yaml schema templates
	const yamlSettings = workspace.getConfiguration('yaml');
	const setting = 'schemasDir';
	let schemasUri: Uri;
	if (yamlSettings.has(setting)) {
		schemasUri = Uri.file(yamlSettings.get<string>(setting, ''));
	} else {
		schemasUri = context.extensionUri;
	}

	// Load all schema files from that directory
	const schemaTemplatesPromise = loadSchemas(schemasUri);

	// Activate vscode-yaml extension
	const yamlExtension = vscode.extensions.getExtension("redhat.vscode-yaml");
	assertOk(yamlExtension, () => 'vscode-yaml extension not found');
	const yamlExtensionAPI = await yamlExtension.activate();
	assertOk(yamlExtensionAPI, () => 'Failed to activate vscode-yaml extension');

	// Wait for schema templates loading
	schemaTemplates = await schemaTemplatesPromise;
	log('Schemas are loaded');

	// Register schema provider
	yamlExtensionAPI.registerContributor(SCHEMA, onRequestSchemaURI, onRequestSchemaContent);
	log('Schema provider is registered');
}

// This method is called when your extension is deactivated
export function deactivate() { }
