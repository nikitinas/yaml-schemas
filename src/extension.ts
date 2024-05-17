// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import {OutputChannel, Uri} from "vscode";

const SCHEMA = "myschema";

let log: OutputChannel;

const schemaJSON = JSON.stringify({
	type: "object",
	additionalProperties: false,
	properties: {
		version: {
			type: "string",
			description: "A stringy string string",
			enum: [
				"test"
			]
		}
	}
});

function onRequestSchemaURI(resource: string): string | undefined {
	log.appendLine('onRequestSchemaURI: ' + resource);
	if (resource.endsWith('test.yaml')) {
		return `${SCHEMA}://schema/porter`;
	}
	return undefined;
}

function onRequestSchemaContent(schemaUri: string): string | undefined {
	log.appendLine('onRequestSchemaContent: ' + schemaUri);
	const parsedUri = Uri.parse(schemaUri);
	if (parsedUri.scheme !== SCHEMA) {
		return undefined;
	}
	if (!parsedUri.path || !parsedUri.path.startsWith('/')) {
		return undefined;
	}

	return schemaJSON;
}

export async function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "yaml-schemas" is now active!');

	log = vscode.window.createOutputChannel('YAML Schema Test');

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	let disposable = vscode.commands.registerCommand('yaml-schemas.helloWorld', () => {
		// The code you place here will be executed every time your command is executed
		// Display a message box to the user
		vscode.window.showInformationMessage('Hello World from yaml-schemas!');
	});

	context.subscriptions.push(disposable);

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
	yamlExtensionAPI.registerContributor(SCHEMA, onRequestSchemaURI, onRequestSchemaContent);
}

// This method is called when your extension is deactivated
export function deactivate() {}
