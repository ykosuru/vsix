/**
 * LLM Service - handles model selection and streaming for GitHub Copilot
 */

const vscode = require('vscode');
const config = require('../config.json');

/**
 * Select the best available chat model
 * Prefers Claude Sonnet, falls back to any Claude, then any available model
 * @returns {Promise<Object|null>} Selected model or null
 */
async function selectModel() {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    
    // Prefer Claude Sonnet
    let model = models.find(m => 
        m.name.toLowerCase().includes(config.llm.preferredModel) && 
        m.name.toLowerCase().includes(config.llm.preferredVariant)
    );
    
    // Fall back to any Claude
    if (!model) {
        model = models.find(m => m.name.toLowerCase().includes(config.llm.preferredModel));
    }
    
    // Fall back to any available model
    if (!model && models.length > 0) {
        model = models[0];
    }
    
    return model;
}

/**
 * Stream LLM response to chat response
 * @param {string} systemPrompt - System prompt for the model
 * @param {string} userPrompt - User prompt with context
 * @param {Object} response - VS Code chat response stream
 * @param {Object} outputChannel - Output channel for logging
 * @param {CancellationToken} token - Cancellation token
 * @returns {Promise<void>}
 */
async function streamResponse(systemPrompt, userPrompt, response, outputChannel, token) {
    const model = await selectModel();
    
    if (!model) {
        response.markdown('❌ No language model available. Make sure GitHub Copilot is authenticated.');
        return;
    }
    
    outputChannel.appendLine(`Using model: ${model.name}`);
    
    // Combine system + user prompt into single user message
    // (Copilot API typically uses single message format)
    const messages = [
        vscode.LanguageModelChatMessage.User(systemPrompt + '\n\n' + userPrompt)
    ];
    
    const chatResponse = await model.sendRequest(messages, {}, token);
    
    for await (const chunk of chatResponse.text) {
        response.markdown(chunk);
    }
}

/**
 * Get model info for diagnostics
 * @returns {Promise<Object>} Model info
 */
async function getModelInfo() {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    const selected = await selectModel();
    
    return {
        available: models.map(m => m.name),
        selected: selected?.name || null,
        count: models.length
    };
}

module.exports = {
    selectModel,
    streamResponse,
    getModelInfo
};
