/**
 * AstraCode Configuration Module - UPDATED
 * 
 * Key changes:
 * 1. Default model changed to gpt-4o for better code analysis
 * 2. Added separate analysisModel setting
 * 3. summaryModel stays as gpt-4o-mini for efficiency
 */

const vscode = require('vscode');

// ============================================================
// DEFAULT VALUES - UPDATED FOR BETTER CODE ANALYSIS
// ============================================================

const DEFAULTS = {
    agent: {
        enableJudge: true,
        maxIterations: 10,
        verboseSearch: false,
        maxChunks: 8,
        maxBatchSize: 3,
        maxCombinedSize: 15000,
        maxAnalysisLength: 10000  // Increased from 8000
    },
    
    indexing: {
        batchSize: 50,
        batchDelay: 10,
        maxFilesForFullIndex: 1000,
        maxSymbolsPerFile: 500,
        maxVarsPerFile: 100,
        searchResultLimit: 100,
        enableAutoSummary: true
    },
    
    summary: {
        batchSize: 10,
        maxFunctionSize: 5000,
        minFunctionSize: 50,
        contextWindowLimit: 18000,
        chunkSizeForQuery: 12000,  // Increased from 10000
        chunkOverlap: 500
    },
    
    vector: {
        chunkSize: 500,
        chunkOverlap: 50,
        minChunkSize: 50,
        maxChunksPerFile: 100,
        topKResults: 10,
        embeddingBatchSize: 20,
        similarityThreshold: 0.3,
        dimensions: 384
    },
    
    trigram: {
        minQueryLength: 3,
        maxResults: 100,
        maxFileSize: 500000,
        caseSensitive: false,
        maxPositionsPerFile: 1000
    },
    
    llm: {
        // CHANGED: Default to stronger model for better code analysis
        defaultModel: 'gpt-4o',
        
        // NEW: Task-specific models
        codingModel: 'gpt-4o',           // For code generation
        analysisModel: 'gpt-4o',         // For code analysis (CRITICAL)
        summaryModel: 'gpt-4o-mini',     // For quick summaries
        classificationModel: 'gpt-4o-mini', // For query classification
        
        providerPriority: ['copilot', 'openai', 'anthropic'],
        
        modelDisplayNames: {
            'gpt-4o-mini': 'GPT-4o Mini',
            'gpt-4o': 'GPT-4o',
            'gpt-4': 'GPT-4',
            'claude-sonnet-4': 'Claude Sonnet 4',
            'claude-3.5-sonnet': 'Claude 3.5 Sonnet'
        },
        
        // NEW: Model capabilities for automatic selection
        modelCapabilities: {
            'gpt-4o': {
                contextWindow: 128000,
                codeAnalysis: 'excellent',
                jsonExtraction: 'excellent',
                speed: 'medium'
            },
            'gpt-4o-mini': {
                contextWindow: 128000,
                codeAnalysis: 'good',
                jsonExtraction: 'good',
                speed: 'fast'
            },
            'claude-sonnet-4': {
                contextWindow: 200000,
                codeAnalysis: 'excellent',
                jsonExtraction: 'excellent',
                speed: 'medium'
            }
        }
    },
    
    general: {
        mode: 'auto',
        searchMode: 'detailed',
        debugMode: false
    }
};

// ============================================================
// TASK TYPES
// ============================================================

const TASKS = {
    CODING: 'coding',
    ANALYSIS: 'analysis',
    SUMMARY: 'summary',
    CLASSIFICATION: 'classification',
    DEFAULT: 'default'
};

// ============================================================
// CONFIGURATION CLASS - UPDATED
// ============================================================

class Configuration {
    constructor() {
        this._cache = null;
        this._cacheTime = null;
        this._cacheTTL = 1000;
        
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('astra')) {
                this._cache = null;
                this._cacheTime = null;
            }
        });
    }
    
    _getConfig() {
        const now = Date.now();
        if (this._cache && this._cacheTime && (now - this._cacheTime) < this._cacheTTL) {
            return this._cache;
        }
        this._cache = vscode.workspace.getConfiguration('astra');
        this._cacheTime = now;
        return this._cache;
    }
    
    get agent() {
        const config = this._getConfig();
        return {
            enableJudge: config.get('agent.enableJudge', DEFAULTS.agent.enableJudge),
            maxIterations: config.get('agent.maxIterations', DEFAULTS.agent.maxIterations),
            verboseSearch: config.get('agent.verboseSearch', DEFAULTS.agent.verboseSearch),
            maxChunks: config.get('agent.maxChunks', DEFAULTS.agent.maxChunks),
            maxBatchSize: config.get('agent.maxBatchSize', DEFAULTS.agent.maxBatchSize),
            maxCombinedSize: config.get('agent.maxCombinedSize', DEFAULTS.agent.maxCombinedSize),
            maxAnalysisLength: config.get('agent.maxAnalysisLength', DEFAULTS.agent.maxAnalysisLength)
        };
    }
    
    get indexing() {
        const config = this._getConfig();
        return {
            batchSize: config.get('indexing.batchSize', DEFAULTS.indexing.batchSize),
            batchDelay: config.get('indexing.batchDelay', DEFAULTS.indexing.batchDelay),
            maxFilesForFullIndex: config.get('indexing.maxFilesForFullIndex', DEFAULTS.indexing.maxFilesForFullIndex),
            maxSymbolsPerFile: config.get('indexing.maxSymbolsPerFile', DEFAULTS.indexing.maxSymbolsPerFile),
            maxVarsPerFile: config.get('indexing.maxVarsPerFile', DEFAULTS.indexing.maxVarsPerFile),
            searchResultLimit: config.get('indexing.searchResultLimit', DEFAULTS.indexing.searchResultLimit),
            enableAutoSummary: config.get('indexing.enableAutoSummary', DEFAULTS.indexing.enableAutoSummary)
        };
    }
    
    get summary() {
        const config = this._getConfig();
        return {
            batchSize: config.get('summary.batchSize', DEFAULTS.summary.batchSize),
            maxFunctionSize: config.get('summary.maxFunctionSize', DEFAULTS.summary.maxFunctionSize),
            minFunctionSize: config.get('summary.minFunctionSize', DEFAULTS.summary.minFunctionSize),
            contextWindowLimit: config.get('summary.contextWindowLimit', DEFAULTS.summary.contextWindowLimit),
            chunkSizeForQuery: config.get('summary.chunkSizeForQuery', DEFAULTS.summary.chunkSizeForQuery),
            chunkOverlap: config.get('summary.chunkOverlap', DEFAULTS.summary.chunkOverlap)
        };
    }
    
    get vector() {
        const config = this._getConfig();
        return {
            chunkSize: config.get('vector.chunkSize', DEFAULTS.vector.chunkSize),
            chunkOverlap: config.get('vector.chunkOverlap', DEFAULTS.vector.chunkOverlap),
            minChunkSize: config.get('vector.minChunkSize', DEFAULTS.vector.minChunkSize),
            maxChunksPerFile: config.get('vector.maxChunksPerFile', DEFAULTS.vector.maxChunksPerFile),
            topKResults: config.get('vector.topKResults', DEFAULTS.vector.topKResults),
            embeddingBatchSize: config.get('vector.embeddingBatchSize', DEFAULTS.vector.embeddingBatchSize),
            similarityThreshold: config.get('vector.similarityThreshold', DEFAULTS.vector.similarityThreshold),
            dimensions: DEFAULTS.vector.dimensions
        };
    }
    
    get trigram() {
        return { ...DEFAULTS.trigram };
    }
    
    get llm() {
        const config = this._getConfig();
        const self = this;
        
        return {
            defaultModel: config.get('llm.defaultModel', DEFAULTS.llm.defaultModel),
            providerPriority: config.get('llm.providerPriority', DEFAULTS.llm.providerPriority),
            openaiApiKey: config.get('llm.openaiApiKey', ''),
            anthropicApiKey: config.get('llm.anthropicApiKey', ''),
            
            /**
             * Get the model for a specific task - UPDATED
             * @param {string} task - One of TASKS values
             * @returns {string} Model identifier
             */
            getModelForTask(task) {
                const defaultModel = config.get('llm.defaultModel', DEFAULTS.llm.defaultModel);
                
                switch (task) {
                    case TASKS.CODING:
                        return config.get('llm.codingModel') || DEFAULTS.llm.codingModel || defaultModel;
                    case TASKS.ANALYSIS:
                        // CRITICAL: Analysis MUST use stronger model
                        return config.get('llm.analysisModel') || DEFAULTS.llm.analysisModel || defaultModel;
                    case TASKS.SUMMARY:
                        return config.get('llm.summaryModel') || DEFAULTS.llm.summaryModel || defaultModel;
                    case TASKS.CLASSIFICATION:
                        return config.get('llm.classificationModel') || DEFAULTS.llm.classificationModel || defaultModel;
                    default:
                        return defaultModel;
                }
            },
            
            /**
             * NEW: Get recommended model based on task complexity
             * @param {string} task - Task type
             * @param {number} contextSize - Size of context in characters
             * @returns {string} Recommended model
             */
            getRecommendedModel(task, contextSize = 0) {
                // For large contexts (>50KB) or analysis, always use gpt-4o
                if (contextSize > 50000 || task === TASKS.ANALYSIS) {
                    return 'gpt-4o';
                }
                
                // For medium contexts or coding
                if (contextSize > 20000 || task === TASKS.CODING) {
                    return config.get('llm.codingModel') || DEFAULTS.llm.codingModel;
                }
                
                // For small contexts, use task-specific model
                return this.getModelForTask(task);
            },
            
            getDisplayName(modelId) {
                if (!modelId) return 'Unknown';
                
                const customNames = config.get('llm.modelDisplayNames', {});
                if (customNames[modelId]) return customNames[modelId];
                
                const builtInNames = DEFAULTS.llm.modelDisplayNames;
                if (builtInNames[modelId]) return builtInNames[modelId];
                
                const modelLower = modelId.toLowerCase();
                if (modelLower.includes('gpt-4o-mini')) return 'GPT-4o Mini';
                if (modelLower.includes('gpt-4o')) return 'GPT-4o';
                if (modelLower.includes('gpt-4')) return 'GPT-4';
                if (modelLower.includes('claude-sonnet-4')) return 'Claude Sonnet 4';
                if (modelLower.includes('claude-3.5') || modelLower.includes('claude-3-5')) return 'Claude 3.5 Sonnet';
                if (modelLower.includes('claude')) return 'Claude';
                if (modelLower.includes('o1-mini')) return 'o1 Mini';
                if (modelLower.includes('o1')) return 'o1';
                
                return modelId;
            },
            
            getApiKey(provider) {
                switch (provider) {
                    case 'openai':
                        return config.get('llm.openaiApiKey') || null;
                    case 'anthropic':
                        return config.get('llm.anthropicApiKey') || null;
                    default:
                        return null;
                }
            },
            
            getModelSearchOrder(preferredModel) {
                const preferred = (preferredModel || this.defaultModel).toLowerCase();
                
                return [
                    // First: exact match for preferred model
                    m => (m.name?.toLowerCase().includes(preferred) || 
                          m.id?.toLowerCase().includes(preferred) ||
                          m.family?.toLowerCase().includes(preferred)),
                    // GPT-4o (prefer full model over mini for analysis)
                    m => (m.family?.toLowerCase() === 'gpt-4o' ||
                          m.name?.toLowerCase() === 'gpt-4o'),
                    // GPT-4o-mini
                    m => (m.family?.toLowerCase().includes('gpt-4o-mini') ||
                          m.name?.toLowerCase().includes('gpt-4o-mini')),
                    // GPT-4
                    m => (m.family?.toLowerCase().includes('gpt-4') ||
                          m.name?.toLowerCase().includes('gpt-4')),
                    // Claude (excellent for code)
                    m => (m.family?.toLowerCase().includes('claude') ||
                          m.name?.toLowerCase().includes('claude')),
                    // Any available
                    m => true
                ];
            }
        };
    }
    
    get general() {
        const config = this._getConfig();
        return {
            mode: config.get('mode', DEFAULTS.general.mode),
            searchMode: config.get('searchMode', DEFAULTS.general.searchMode),
            debugMode: config.get('debugMode', DEFAULTS.general.debugMode),
            systemPrompt: config.get('systemPrompt', '')
        };
    }
    
    logConfig(logFn = console.log) {
        logFn('AstraCode Configuration:', {
            agent: this.agent,
            indexing: this.indexing,
            llm: {
                defaultModel: this.llm.defaultModel,
                analysisModel: this.llm.getModelForTask(TASKS.ANALYSIS),
                summaryModel: this.llm.getModelForTask(TASKS.SUMMARY),
                providerPriority: this.llm.providerPriority,
                hasOpenAIKey: !!this.llm.openaiApiKey,
                hasAnthropicKey: !!this.llm.anthropicApiKey
            },
            general: this.general
        });
    }
    
    async set(key, value, global = false) {
        const config = vscode.workspace.getConfiguration('astra');
        const target = global 
            ? vscode.ConfigurationTarget.Global 
            : vscode.ConfigurationTarget.Workspace;
        await config.update(key, value, target);
        this._cache = null;
    }
}

// ============================================================
// SINGLETON INSTANCE
// ============================================================

const Config = new Configuration();

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    Config,
    Configuration,
    TASKS,
    DEFAULTS
};
