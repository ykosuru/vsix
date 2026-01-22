/**
 * AstraCode Extension - Entry Point
 */

const vscode = require('vscode');
const { handleRequest, clearIndex } = require('./participant');
const { ConfluenceAuth } = require('./auth/confluence-auth');

const PARTICIPANT_ID = 'astracode.chat';

let confluenceAuth = null;

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
    
    participant.iconPath = new vscode.ThemeIcon('search');
    
    context.subscriptions.push(
        participant, 
        outputChannel, 
        uriHandler,
        signInCmd,
        signOutCmd
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
