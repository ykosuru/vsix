/**
 * Copilot LLM Integration - Simplified
 * 
 * Streams responses from Copilot. Uses VS Code settings for preferred model.
 */

const vscode = require('vscode');

let workingModel = null;

function getPreferredModel() {
    try {
        const config = vscode.workspace.getConfiguration('astracode');
        return config.get('preferredModel') || 'gpt-4o';
    } catch (e) {
        return 'gpt-4o';
    }
}

async function getAvailableModels() {
    try {
        let models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
        if (!models || !Array.isArray(models) || models.length === 0) {
            models = await vscode.lm.selectChatModels({});
        }
        return models || [];
    } catch (error) {
        console.error('[AstraCode] Failed to get models:', error);
        return [];
    }
}

function orderModels(models) {
    if (!models || models.length === 0) return [];
    
    const preferred = getPreferredModel().toLowerCase();
    let ordered = [...models];
    
    // Put working model first
    if (workingModel) {
        const idx = ordered.findIndex(m => m.id === workingModel.id);
        if (idx > 0) {
            ordered.splice(idx, 1);
            ordered.unshift(workingModel);
        }
    }
    
    // Put preferred model first
    if (preferred) {
        const idx = ordered.findIndex(m => 
            m.id && (m.id.toLowerCase() === preferred || m.id.toLowerCase().includes(preferred))
        );
        if (idx > 0) {
            const [match] = ordered.splice(idx, 1);
            ordered.unshift(match);
        }
    }
    
    return ordered;
}

async function streamResponse(systemPrompt, userPrompt, response, outputChannel, token) {
    const models = await getAvailableModels();
    
    if (!models || models.length === 0) {
        response.markdown('⚠️ **No Copilot models available.** Make sure GitHub Copilot is active.');
        return;
    }
    
    const ordered = orderModels(models);
    
    if (outputChannel) {
        outputChannel.appendLine(`[AstraCode] Preferred: ${getPreferredModel()}`);
        outputChannel.appendLine(`[AstraCode] Trying: ${ordered[0]?.id}`);
    }
    
    const messages = [
        vscode.LanguageModelChatMessage.User(`${systemPrompt}\n\n---\n\n${userPrompt}`)
    ];
    
    for (const model of ordered) {
        try {
            if (outputChannel) {
                outputChannel.appendLine(`[AstraCode] → ${model.id}`);
            }
            
            const result = await model.sendRequest(messages, {}, token);
            
            for await (const chunk of result.text) {
                if (token.isCancellationRequested) return;
                response.markdown(chunk);
            }
            
            workingModel = model;
            if (outputChannel) {
                outputChannel.appendLine(`[AstraCode] ✓ ${model.id}`);
            }
            return;
            
        } catch (error) {
            if (outputChannel) {
                outputChannel.appendLine(`[AstraCode] ✗ ${model.id}: ${error.message?.slice(0, 50) || 'Error'}`);
            }
            
            if (workingModel?.id === model.id) {
                workingModel = null;
            }
        }
    }
    
    response.markdown(`⚠️ **All models failed.** Set \`astracode.preferredModel\` in Settings to a working model like \`gpt-4o\`.`);
}

async function getResponse(systemPrompt, userPrompt, token) {
    const models = await getAvailableModels();
    if (!models || models.length === 0) {
        throw new Error('No Copilot models available');
    }
    
    const ordered = orderModels(models);
    
    const messages = [
        vscode.LanguageModelChatMessage.User(`${systemPrompt}\n\n---\n\n${userPrompt}`)
    ];
    
    for (const model of ordered) {
        try {
            const result = await model.sendRequest(messages, {}, token);
            let text = '';
            for await (const chunk of result.text) {
                if (token.isCancellationRequested) throw new Error('Cancelled');
                text += chunk;
            }
            workingModel = model;
            return text;
        } catch (error) {
            if (error.message?.includes('Cancelled')) throw error;
        }
    }
    
    throw new Error('All models failed');
}

module.exports = {
    getAvailableModels,
    streamResponse,
    getResponse,
    getPreferredModel
};
