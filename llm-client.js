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
        
        this.log(`LLMClient: Starting completion, task=${task}, providers=${providers.join(',')}`);
        
        let lastError = null;
        
        for (const provider of providers) {
            try {
                this.log(`LLMClient: Trying provider: ${provider}`);
                switch (provider) {
                    case 'copilot':
                        return await this._callCopilot(prompt, { task, systemPrompt });
                    case 'openai':
                        const openaiKey = llmConfig.getApiKey('openai');
                        if (openaiKey) {
                            this.log(`LLMClient: OpenAI API key found, attempting call`);
                            return await this._callOpenAI(prompt, openaiKey, { task, systemPrompt });
                        } else {
                            this.log(`LLMClient: No OpenAI API key configured, skipping`);
                        }
                        break;
                    case 'anthropic':
                        const anthropicKey = llmConfig.getApiKey('anthropic');
                        if (anthropicKey) {
                            this.log(`LLMClient: Anthropic API key found, attempting call`);
                            return await this._callAnthropic(prompt, anthropicKey, { task, systemPrompt });
                        } else {
                            this.log(`LLMClient: No Anthropic API key configured, skipping`);
                        }
                        break;
                }
            } catch (error) {
                this.log(`LLMClient: ${provider} failed: ${error.message}`);
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
     * Includes automatic fallback to cheaper models on quota errors
     */
    async _callCopilot(prompt, options = {}) {
        const { task = TASKS.DEFAULT, systemPrompt = null } = options;
        
        // Check if API is available
        if (!vscode.lm || typeof vscode.lm.selectChatModels !== 'function') {
            throw new Error('VS Code Language Model API not available');
        }
        
        // Get preferred model for this task
        const preferredModel = this.config.llm.getModelForTask(task);
        this.log(`LLMClient: Preferred model for task ${task}: ${preferredModel}`);
        
        // Check if settings changed (clear failed cache)
        const currentSetting = preferredModel;
        if (this.lastCopilotModelSetting !== currentSetting) {
            failedModelsCache.clear();
            this.lastCopilotModelSetting = currentSetting;
        }
        
        // Get all available models upfront
        const allModels = await vscode.lm.selectChatModels({});
        this.log(`LLMClient: Total available Copilot models: ${allModels?.length || 0}`);
        if (allModels && allModels.length > 0) {
            this.log(`LLMClient: Models: ${allModels.map(m => `${m.name}(${m.id})`).join(', ')}`);
        }
        
        // Try up to all available models (max 10 to prevent infinite loops)
        const maxAttempts = Math.min(allModels?.length || 3, 10);
        let lastError = null;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            // Select model (will skip failed models)
            const model = await this._selectCopilotModel(preferredModel);
            if (!model) {
                this.log(`LLMClient: No more models available after ${failedModelsCache.size} failures`);
                throw new Error('No Copilot models available');
            }
            
            const modelId = model.id || model.name || 'unknown';
            this.log(`LLMClient: Attempt ${attempt + 1}/${maxAttempts}, using model: ${model.name} (id: ${model.id})`);
            
            try {
                const result = await this._sendCopilotRequest(model, prompt, systemPrompt);
                return result;
            } catch (error) {
                lastError = error;
                const errorMsg = error.message || String(error);
                
                this.log(`LLMClient: Error from ${modelId}: ${errorMsg}`);
                
                // Check if this is a quota/rate limit/model error that we should retry with different model
                const isRetryableError = 
                    errorMsg.includes('quota') || 
                    errorMsg.includes('exhausted') || 
                    errorMsg.includes('rate limit') ||
                    errorMsg.includes('premium') ||
                    errorMsg.includes('allowance') ||
                    errorMsg.includes('model_not_supported') ||
                    errorMsg.includes('not supported') ||
                    errorMsg.includes('Request Failed') ||
                    errorMsg.includes('400');
                
                if (isRetryableError) {
                    this.log(`LLMClient: Marking ${modelId} as failed, will try next model...`);
                    
                    // Mark this model as failed so we try a different one
                    failedModelsCache.add(modelId);
                    
                    // Continue to next attempt with different model
                    continue;
                }
                
                // For non-retryable errors, rethrow immediately
                throw error;
            }
        }
        
        // All attempts failed
        this.log(`LLMClient: All ${maxAttempts} Copilot attempts failed. Failed models: ${Array.from(failedModelsCache).join(', ')}`);
        throw lastError || new Error('All model attempts failed');
    }
    
    /**
     * Send request to a specific Copilot model
     */
    async _sendCopilotRequest(model, prompt, systemPrompt) {
        // Build messages
        const messages = [];
        if (systemPrompt) {
            messages.push(vscode.LanguageModelChatMessage.User(systemPrompt));
        }
        messages.push(vscode.LanguageModelChatMessage.User(prompt));
        
        // Create cancellation token
        const cancellationTokenSource = new vscode.CancellationTokenSource();
        
        // Make request
        this.log(`LLMClient: Sending request to Copilot...`);
        const response = await model.sendRequest(
            messages, 
            {}, 
            cancellationTokenSource.token
        );
        
        // FIXED: Collect response by iterating over the response stream directly
        // The VS Code LM API returns an async iterable of LanguageModelTextPart objects
        let result = '';
        this.log(`LLMClient: Reading response stream...`);
        
        try {
            // The response object itself is an async iterable that yields text parts
            for await (const part of response.stream) {
                // Each part has a 'value' property containing the text chunk
                if (part && typeof part === 'object' && 'value' in part) {
                    result += part.value;
                } else if (typeof part === 'string') {
                    result += part;
                } else if (part && part.text) {
                    result += part.text;
                }
            }
        } catch (streamError) {
            // Try alternative iteration methods if stream doesn't work
            this.log(`LLMClient: Stream iteration failed, trying alternatives: ${streamError.message}`);
            
            // Try iterating over response.text if it exists
            if (response.text && typeof response.text[Symbol.asyncIterator] === 'function') {
                for await (const chunk of response.text) {
                    result += chunk;
                }
            } 
            // Try direct iteration over response
            else if (typeof response[Symbol.asyncIterator] === 'function') {
                for await (const chunk of response) {
                    if (typeof chunk === 'string') {
                        result += chunk;
                    } else if (chunk && chunk.value) {
                        result += chunk.value;
                    }
                }
            }
            // If nothing works, check if response has a text property that's a string
            else if (typeof response.text === 'string') {
                result = response.text;
            }
            else {
                throw new Error(`Unable to read response: ${streamError.message}`);
            }
        }
        
        this.log(`LLMClient: Response received, length: ${result.length} chars`);
        
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
     * Prefers Claude Sonnet 4.5, falls back to GPT 5.2 Codex or GPT-5-mini
     */
    async _selectCopilotModel(preferredModel) {
        const allModels = await vscode.lm.selectChatModels({});
        
        if (!allModels || allModels.length === 0) {
            this.log('LLMClient: No Copilot models available at all');
            return null;
        }
        
        // Log available models for debugging
        this.log(`LLMClient: Selecting from ${allModels.length} models, ${failedModelsCache.size} already failed`);
        
        // Filter out failed models
        const availableModels = allModels.filter(m => {
            const id = m.id || m.name || '';
            const isFailed = failedModelsCache.has(id);
            if (isFailed) {
                this.log(`LLMClient: Skipping failed model: ${id}`);
            }
            return !isFailed;
        });
        
        if (availableModels.length === 0) {
            this.log('LLMClient: All models have been tried and failed');
            // Clear cache and return null to signal we've exhausted all options
            return null;
        }
        
        this.log(`LLMClient: ${availableModels.length} models still available to try`);
        
        // Try matchers in order
        const matchers = this.config.llm.getModelSearchOrder(preferredModel);
        
        // Track which model category we match
        const modelCategories = [
            'preferred', 'Claude Sonnet 4.5', 'Claude Sonnet 4', 'Claude 3.5 Sonnet', 
            'Claude', 'GPT 5.2 Codex', 'GPT-5-mini', 'GPT-5o-mini', 'GPT-4o', 'GPT-4', 'any'
        ];
        
        for (let i = 0; i < matchers.length; i++) {
            const match = availableModels.find(matchers[i]);
            if (match) {
                const matchedCategory = modelCategories[i] || 'unknown';
                this.log(`LLMClient: Selected ${match.name} (${matchedCategory})`);
                return match;
            }
        }
        
        // Return first available
        this.log(`LLMClient: No preferred match, using first available: ${availableModels[0].name}`);
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
        let model = this.config.llm.getModelForTask(task);
        
        // Map model names to OpenAI format
        // If a Claude model is configured, use a comparable OpenAI model
        if (model.includes('claude') || model.includes('sonnet')) {
            model = 'gpt-4o';  // Use GPT-4o as equivalent to Claude Sonnet
            this.log(`LLMClient: Mapped Claude model to OpenAI: ${model}`);
        } else if (model.includes('gpt-5')) {
            // Map hypothetical GPT-5 models to current best
            model = 'gpt-4o';
            this.log(`LLMClient: Mapped GPT-5 to available model: ${model}`);
        }
        
        // Validate model is a known OpenAI model
        const validOpenAIModels = ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo', 'o1', 'o1-mini', 'o1-preview'];
        if (!validOpenAIModels.some(m => model.includes(m))) {
            this.log(`LLMClient: Unknown model ${model}, falling back to gpt-4o-mini`);
            model = 'gpt-4o-mini';
        }
        
        this.log(`LLMClient: Calling OpenAI with model: ${model}`);
        
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
            const errorText = await response.text();
            this.log(`LLMClient: OpenAI error response: ${errorText}`);
            throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
        }
        
        const data = await response.json();
        
        if (!data.choices || !data.choices[0] || !data.choices[0].message) {
            this.log(`LLMClient: Unexpected OpenAI response: ${JSON.stringify(data)}`);
            throw new Error('OpenAI returned unexpected response format');
        }
        
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
        if (model.includes('claude-sonnet-4-5') || model.includes('claude-sonnet-4.5')) {
            anthropicModel = 'claude-sonnet-4-5-20250514';
        } else if (model.includes('claude-sonnet-4')) {
            anthropicModel = 'claude-sonnet-4-20250514';
        } else if (model.includes('claude-3.5') || model.includes('claude-3-5')) {
            anthropicModel = 'claude-3-5-sonnet-20241022';
        } else if (model.includes('gpt') || model.includes('o1')) {
            // If OpenAI model configured but Anthropic is being used, fall back to Claude
            anthropicModel = 'claude-sonnet-4-5-20250514';
            this.log(`LLMClient: Mapped OpenAI model to Anthropic: ${anthropicModel}`);
        }
        
        this.log(`LLMClient: Calling Anthropic with model: ${anthropicModel}`);
        
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
    LLMClient
};
