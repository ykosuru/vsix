/**
 * AstraCode Extension - Entry Point
 * 
 * Code search with function call tracking for GitHub Copilot Chat.
 * Answers "who calls X?" queries and provides TAL-to-Java translation,
 * Fed ISO 20022 uplift guidance, and business requirements extraction.
 */

const vscode = require('vscode');
const { handleRequest, clearIndex } = require('./participant');
const { getWorkspaceRoot } = require('./utils/workspace');

const PARTICIPANT_ID = 'astracode.chat';

/**
 * Activate the extension
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    const outputChannel = vscode.window.createOutputChannel('AstraCode');
    outputChannel.appendLine('AstraCode Copilot participant activated');
    
    // Register the chat participant
    const participant = vscode.chat.createChatParticipant(
        PARTICIPANT_ID,
        (request, chatContext, response, token) => {
            return handleRequest(
                request,
                chatContext,
                response,
                token,
                outputChannel,
                getWorkspaceRoot
            );
        }
    );
    
    participant.iconPath = new vscode.ThemeIcon('search');
    
    context.subscriptions.push(participant, outputChannel);
}

/**
 * Deactivate the extension
 */
function deactivate() {
    clearIndex();
}

module.exports = { activate, deactivate };
