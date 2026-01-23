/**
 * AstraCode Extension - Entry Point
 */

const vscode = require('vscode');
const { handleRequest, clearIndex } = require('./participant');
const { ConfluenceAuth } = require('./auth/confluence-auth');
const { showSourcePicker, getSelectedSources } = require('./commands/sources');

const PARTICIPANT_ID = 'astracode.chat';

let confluenceAuth = null;
let lastSourceConfig = null;  // Store last selected sources

function activate(context) {
    const outputChannel = vscode.window.createOutputChannel('AstraCode');
    outputChannel.appendLine('AstraCode activated (v0.8.4 - OAuth support)');
    
    // Initialize Confluence auth
    confluenceAuth = new ConfluenceAuth(context);
    
    // Register URI handler for OAuth callback
    const uriHandler = vscode.window.registerUriHandler({
        handleUri(uri) {
            outputChannel.appendLine(`[AstraCode] URI callback: ${uri.path}`);
            if (uri.path === '/auth/callback') {
                confluenceAuth.handleCallback(uri);
            }
        }
    });
    
    // Register sign-in command
    const signInCmd = vscode.commands.registerCommand('astracode.confluence.signIn', async () => {
        try {
            await confluenceAuth.signIn();
        } catch (e) {
            vscode.window.showErrorMessage(`Confluence sign-in failed: ${e.message}`);
        }
    });
    
    // Register sign-out command
    const signOutCmd = vscode.commands.registerCommand('astracode.confluence.signOut', async () => {
        await confluenceAuth.signOut();
    });
    
    // Register configure sources command (for button)
    const configureSourcesCmd = vscode.commands.registerCommand('astracode.configureSources', async () => {
        const sources = await showSourcePicker();
        if (sources) {
            lastSourceConfig = sources;
            const summary = [];
            if (sources.workspace) summary.push('Workspace');
            if (sources.attachments) summary.push('Attachments');
            if (sources.history) summary.push(`History (${sources.historyCount})`);
            if (sources.confluence) summary.push('Confluence');
            if (sources.files && sources.selectedFiles.length > 0) {
                summary.push(`Files (${sources.selectedFiles.length})`);
            }
            vscode.window.showInformationMessage(
                `AstraCode sources: ${summary.join(', ') || 'None'}. Run a command to use them.`
            );
        }
    });
    
    // Create chat participant
    const participant = vscode.chat.createChatParticipant(
        PARTICIPANT_ID,
        (request, chatContext, response, token) => {
            return handleRequest(
                request, chatContext, response, token, 
                outputChannel, getWorkspaceRoot, confluenceAuth
            );
        }
    );
    
    participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'assets', 'icon.png');
    
    context.subscriptions.push(
        participant, 
        outputChannel, 
        uriHandler,
        signInCmd,
        signOutCmd,
        configureSourcesCmd
    );
}

function getWorkspaceRoot() {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0].uri.fsPath : null;
}

function deactivate() {
    clearIndex();
}

module.exports = { activate, deactivate };
