/**
 * AstraCode LLM Client Module
 * 
 * Handles all LLM interactions with support for multiple providers:
 * - GitHub Copilot (via VS Code Language Model API)
 * - OpenAI (direct API)
 * - Anthropic (direct API)
 * 
 * Usage:
 *   const { LLMClient } = require('./llm-client');
 *   const client = new LLMClient(config, logFn);
 *   const response = await client.complete(prompt, { task: 'coding' });
 */

const vscode = require('vscode');

// ============================================================
// CONSTANTS
// ============================================================

const TASKS = {
    CODING: 'coding',
    ANALYSIS: 'analysis',
    SUMMARY: 'summary',
    CLASSIFICATION: 'classification',
    DEFAULT: 'default'
};

// Models that have failed (cleared on reload or settings change)
const failedModelsCache = new Set();

// ============================================================
// LLM CLIENT CLASS
// ============================================================

class LLMClient {
    /**
     * @param {Object} config - Configuration object with llm settings
     * @param {Function} logFn - Logging function
     */
    constructor(config, logFn = console.log) {
        this.config = config;
        this.log = logFn;
        this.lastUsedModel = null;
        this.lastCopilotModelSetting = null;
    }

    /**
     * Main completion method - tries providers in priority order
     * @param {string} prompt - The prompt to send
     * @param {Object} options - Options including task type
     * @returns {Promise<string>} The completion response
     */
    async complete(prompt, options = {}) {
        const { task = TASKS.DEFAULT, systemPrompt = null } = options;
        const llmConfig = this.config.llm;
        const providers = llmConfig.providerPriority || ['copilot', 'openai', 'anthropic'];
        
        let lastError = null;
        
        for (const provider of providers) {
            try {
                switch (provider) {
                    case 'copilot':
                        return await this._callCopilot(prompt, { task, systemPrompt });
                    case 'openai':
                        const openaiKey = llmConfig.getApiKey('openai');
                        if (openaiKey) {
                            return await this._callOpenAI(prompt, openaiKey, { task, systemPrompt });
                        }
                        break;
                    case 'anthropic':
                        const anthropicKey = llmConfig.getApiKey('anthropic');
                        if (anthropicKey) {
                            return await this._callAnthropic(prompt, anthropicKey, { task, systemPrompt });
                        }
                        break;
                }
            } catch (error) {
                this.log(`LLMClient: ${provider} failed:`, error.message);
                lastError = error;
            }
        }
        
        throw lastError || new Error('No LLM providers available');
    }

    /**
     * Completion specifically for coding tasks (may use different model)
     */
    async completeForCoding(prompt, options = {}) {
        return this.complete(prompt, { ...options, task: TASKS.CODING });
    }

    /**
     * Completion specifically for analysis tasks
     */
    async completeForAnalysis(prompt, options = {}) {
        return this.complete(prompt, { ...options, task: TASKS.ANALYSIS });
    }

    /**
     * Completion specifically for summary tasks
     */
    async completeForSummary(prompt, options = {}) {
        return this.complete(prompt, { ...options, task: TASKS.SUMMARY });
    }

    /**
     * Quick classification (uses lightweight model)
     */
    async classify(prompt, options = {}) {
        return this.complete(prompt, { ...options, task: TASKS.CLASSIFICATION });
    }

    // ========================================
    // Provider Implementations
    // ========================================

    /**
     * Call GitHub Copilot via VS Code Language Model API
     */
    async _callCopilot(prompt, options = {}) {
        const { task = TASKS.DEFAULT, systemPrompt = null } = options;
        
        // Check if API is available
        if (!vscode.lm || typeof vscode.lm.selectChatModels !== 'function') {
            throw new Error('VS Code Language Model API not available');
        }
        
        // Get preferred model for this task
        const preferredModel = this.config.llm.getModelForTask(task);
        
        // Check if settings changed (clear failed cache)
        const currentSetting = preferredModel;
        if (this.lastCopilotModelSetting !== currentSetting) {
            failedModelsCache.clear();
            this.lastCopilotModelSetting = currentSetting;
        }
        
        // Select model
        const model = await this._selectCopilotModel(preferredModel);
        if (!model) {
            throw new Error('No Copilot models available');
        }
        
        this.log(`LLMClient: Using Copilot model: ${model.name || model.id}`);
        
        // Build messages
        const messages = [];
        if (systemPrompt) {
            messages.push(vscode.LanguageModelChatMessage.User(systemPrompt));
        }
        messages.push(vscode.LanguageModelChatMessage.User(prompt));
        
        // Make request
        const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
        
        // Collect response
        let result = '';
        for await (const chunk of response.text) {
            result += chunk;
        }
        
        // Track successful model
        this.lastUsedModel = {
            name: model.name,
            vendor: model.vendor,
            family: model.family
        };
        
        return result;
    }

    /**
     * Select best available Copilot model
     */
    async _selectCopilotModel(preferredModel) {
        const allModels = await vscode.lm.selectChatModels({});
        
        if (!allModels || allModels.length === 0) {
            return null;
        }
        
        // Filter out failed models
        const availableModels = allModels.filter(m => {
            const id = m.id || m.name || '';
            return !failedModelsCache.has(id);
        });
        
        if (availableModels.length === 0) {
            // All models failed, clear cache and retry
            failedModelsCache.clear();
            return allModels[0];
        }
        
        // Try matchers in order
        const matchers = this.config.llm.getModelSearchOrder(preferredModel);
        
        for (const matcher of matchers) {
            const match = availableModels.find(matcher);
            if (match) {
                return match;
            }
        }
        
        // Return first available
        return availableModels[0];
    }

    /**
     * Mark a model as failed (won't be tried again this session)
     */
    markModelFailed(modelId) {
        failedModelsCache.add(modelId);
        this.log(`LLMClient: Marked model as failed: ${modelId}`);
    }

    /**
     * Call OpenAI API directly
     */
    async _callOpenAI(prompt, apiKey, options = {}) {
        const { task = TASKS.DEFAULT, systemPrompt = null } = options;
        const model = this.config.llm.getModelForTask(task);
        
        const messages = [];
        if (systemPrompt) {
            messages.push({ role: 'system', content: systemPrompt });
        }
        messages.push({ role: 'user', content: prompt });
        
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: model,
                messages: messages,
                max_tokens: 4096
            })
        });
        
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`OpenAI API error: ${response.status} - ${error}`);
        }
        
        const data = await response.json();
        
        this.lastUsedModel = {
            name: model,
            vendor: 'openai',
            family: model.split('-')[0]
        };
        
        return data.choices[0].message.content;
    }

    /**
     * Call Anthropic API directly
     */
    async _callAnthropic(prompt, apiKey, options = {}) {
        const { task = TASKS.DEFAULT, systemPrompt = null } = options;
        const model = this.config.llm.getModelForTask(task);
        
        // Map model names to Anthropic format
        let anthropicModel = model;
        if (model.includes('claude-sonnet-4')) {
            anthropicModel = 'claude-sonnet-4-20250514';
        } else if (model.includes('claude-3.5') || model.includes('claude-3-5')) {
            anthropicModel = 'claude-3-5-sonnet-20241022';
        }
        
        const body = {
            model: anthropicModel,
            max_tokens: 4096,
            messages: [{ role: 'user', content: prompt }]
        };
        
        if (systemPrompt) {
            body.system = systemPrompt;
        }
        
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify(body)
        });
        
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Anthropic API error: ${response.status} - ${error}`);
        }
        
        const data = await response.json();
        
        this.lastUsedModel = {
            name: anthropicModel,
            vendor: 'anthropic',
            family: 'claude'
        };
        
        return data.content[0].text;
    }

    // ========================================
    // Utility Methods
    // ========================================

    /**
     * Get info about the last used model
     */
    getLastUsedModel() {
        return this.lastUsedModel;
    }

    /**
     * Get display name for current/last model
     */
    getModelDisplayName() {
        if (!this.lastUsedModel) return 'Unknown';
        return this.config.llm.getDisplayName(this.lastUsedModel.name);
    }

    /**
     * Check if any LLM provider is available
     */
    async isAvailable() {
        const llmConfig = this.config.llm;
        
        // Check Copilot
        if (vscode.lm && typeof vscode.lm.selectChatModels === 'function') {
            const models = await vscode.lm.selectChatModels({});
            if (models && models.length > 0) {
                return true;
            }
        }
        
        // Check API keys
        if (llmConfig.getApiKey('openai') || llmConfig.getApiKey('anthropic')) {
            return true;
        }
        
        return false;
    }

    /**
     * Clear failed models cache
     */
    clearFailedCache() {
        failedModelsCache.clear();
        this.log('LLMClient: Cleared failed models cache');
    }
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    LLMClient,
    TASKS,
    failedModelsCache
};
