/**
 * AstraCode Extension - Entry Point
 */

const vscode = require('vscode');
const { handleRequest, clearIndex } = require('./participant');

const PARTICIPANT_ID = 'astracode.chat';

function activate(context) {
    const outputChannel = vscode.window.createOutputChannel('AstraCode');
    outputChannel.appendLine('AstraCode activated (v0.8.0 - Copilot-native)');
    
    const participant = vscode.chat.createChatParticipant(
        PARTICIPANT_ID,
        (request, chatContext, response, token) => {
            return handleRequest(request, chatContext, response, token, outputChannel, getWorkspaceRoot);
        }
    );
    
    participant.iconPath = new vscode.ThemeIcon('search');
    context.subscriptions.push(participant, outputChannel);
}

function getWorkspaceRoot() {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0].uri.fsPath : null;
}

function deactivate() {
    clearIndex();
}

module.exports = { activate, deactivate };
