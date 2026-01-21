/**
 * AstraCode Documentation Generator v2.0
 * 
 * Key changes from v1.0:
 * - Opens docs in VS Code editor window (not just chat)
 * - Provides fallback link if editor fails
 * - Search-first approach: find functionality, then document
 * - Uses inverted index and summaries for better context
 * - Supports specifying subset of functionality to document
 * - Language agnostic (COBOL, TAL, C, Java, Python, etc.)
 */

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { BusinessDocPrompts, UseCasePrompts, TechnicalDocPrompts, SystemPrompts } = require('./prompts');
const { buildContext } = require('./context-builder');

// ============================================================
// DOCUMENTATION TYPES
// ============================================================

const DOC_TYPES = {
    BUSINESS: 'business',
    USE_CASES: 'useCases',
    TECHNICAL: 'technical',
    BUSINESS_SUMMARY: 'businessSummary',
    USE_CASES_SUMMARY: 'useCasesSummary',
    BUSINESS_RULES: 'businessRules'
};

// ============================================================
// DOC GENERATOR CLASS
// ============================================================

class DocGenerator {
    constructor(options = {}) {
        this.llmClient = options.llmClient;
        this.codebaseIndex = options.codebaseIndex;
        this.contextFiles = options.contextFiles;
        this.log = options.log || console.log;
        this.onProgress = options.onProgress || (() => {});
    }

    /**
     * Generate Business Documentation
     * Opens in VS Code editor with title
     */
    async generateBusinessDoc(moduleName, options = {}) {
        const {
            focusArea = '',  // Specific functionality to focus on
            maxTokens = 8000,
            openInEditor = true
        } = options;

        this.log(`Generating business documentation for: ${moduleName}${focusArea ? ` (focus: ${focusArea})` : ''}`);
        this.onProgress('Searching for relevant code...');

        try {
            // Step 1: Search for relevant code (focus area if specified)
            const searchQuery = focusArea || moduleName;
            const searchResults = await this._searchForFunctionality(searchQuery, {
                includeSummaries: true,
                includeBusinessLogic: true
            });
            
            if (!searchResults || searchResults.totalResults === 0) {
                return {
                    documentation: this._noResultsMessage('business documentation', searchQuery),
                    filePath: null
                };
            }

            this.onProgress(`Found ${searchResults.symbols.length} relevant items, analyzing...`);

            // Step 2: Build context with summaries and business logic focus
            const { context } = await buildContext(searchResults, searchQuery, {
                llmClient: this.llmClient,
                log: this.log,
                onProgress: this.onProgress,
                maxContextChars: 48000,
                prioritize: 'business_logic'  // Focus on validations, rules, error handling
            });

            this.onProgress('Generating business documentation...');

            // Step 3: Generate with LLM
            const prompt = BusinessDocPrompts.generate(context, moduleName, { focusArea });
            const systemPrompt = SystemPrompts.businessDoc();

            const documentation = await this.llmClient.complete(prompt, {
                system: systemPrompt,
                maxTokens: maxTokens,
                temperature: 0.3
            });

            this.log(`Business documentation generated: ${documentation.length} chars`);

            // Step 4: Save and open in editor
            let filePath = null;
            if (openInEditor) {
                filePath = await this._openInEditor(documentation, moduleName, 'business');
            }

            return {
                documentation,
                filePath,
                title: `${moduleName} - Business Documentation`
            };

        } catch (error) {
            this.log(`Error generating business doc: ${error.message}`);
            throw error;
        }
    }

    /**
     * Generate Use Cases & Requirements
     */
    async generateUseCases(moduleName, options = {}) {
        const {
            focusArea = '',
            maxTokens = 8000,
            openInEditor = true
        } = options;

        this.log(`Generating use cases for: ${moduleName}${focusArea ? ` (focus: ${focusArea})` : ''}`);
        this.onProgress('Searching for functionality...');

        try {
            const searchQuery = focusArea || moduleName;
            const searchResults = await this._searchForFunctionality(searchQuery, {
                includeSummaries: true,
                includeEntryPoints: true
            });
            
            if (!searchResults || searchResults.totalResults === 0) {
                return {
                    documentation: this._noResultsMessage('use cases', searchQuery),
                    filePath: null
                };
            }

            this.onProgress(`Found ${searchResults.symbols.length} items, extracting use cases...`);

            const { context } = await buildContext(searchResults, searchQuery, {
                llmClient: this.llmClient,
                log: this.log,
                maxContextChars: 48000
            });

            this.onProgress('Generating use cases...');

            const prompt = UseCasePrompts.generate(context, moduleName, { focusArea });
            const systemPrompt = SystemPrompts.useCaseDoc();

            const documentation = await this.llmClient.complete(prompt, {
                system: systemPrompt,
                maxTokens: maxTokens,
                temperature: 0.3
            });

            let filePath = null;
            if (openInEditor) {
                const docTitle = focusArea ? `${moduleName}-${focusArea}` : moduleName;
                filePath = await this._openInEditor(documentation, docTitle, 'usecases');
            }

            return {
                documentation,
                filePath,
                title: `${moduleName}${focusArea ? ` - ${focusArea}` : ''} - Use Cases & Requirements`
            };

        } catch (error) {
            this.log(`Error generating use cases: ${error.message}`);
            throw error;
        }
    }

    /**
     * Generate Technical Documentation
     */
    async generateTechnicalDoc(moduleName, options = {}) {
        const {
            focusArea = '',
            maxTokens = 8000,
            openInEditor = true
        } = options;

        this.log(`Generating technical documentation for: ${moduleName}${focusArea ? ` (focus: ${focusArea})` : ''}`);
        this.onProgress('Searching codebase...');

        try {
            const searchQuery = focusArea || moduleName;
            const searchResults = await this._searchForFunctionality(searchQuery, {
                includeCallGraph: true
            });
            
            if (!searchResults || searchResults.totalResults === 0) {
                return {
                    documentation: this._noResultsMessage('technical documentation', searchQuery),
                    filePath: null
                };
            }

            const { context } = await buildContext(searchResults, searchQuery, {
                llmClient: this.llmClient,
                log: this.log,
                maxContextChars: 48000
            });

            this.onProgress('Generating technical documentation...');

            const prompt = TechnicalDocPrompts.generate(context, moduleName, { focusArea });
            const systemPrompt = SystemPrompts.default();

            const documentation = await this.llmClient.complete(prompt, {
                system: systemPrompt,
                maxTokens: maxTokens,
                temperature: 0.2
            });

            let filePath = null;
            if (openInEditor) {
                const docTitle = focusArea ? `${moduleName}-${focusArea}` : moduleName;
                filePath = await this._openInEditor(documentation, docTitle, 'technical');
            }

            return {
                documentation,
                filePath,
                title: `${moduleName}${focusArea ? ` - ${focusArea}` : ''} - Technical Documentation`
            };

        } catch (error) {
            this.log(`Error generating technical doc: ${error.message}`);
            throw error;
        }
    }

    /**
     * Extract business rules for specific functionality
     */
    async extractBusinessRules(functionality, options = {}) {
        const {
            maxTokens = 4000,
            openInEditor = true
        } = options;

        this.log(`Extracting business rules for: ${functionality}`);
        this.onProgress('Searching for validation logic...');

        try {
            // Search specifically for validation and rule-related code
            const searchResults = await this._searchForFunctionality(functionality, {
                includeValidations: true,
                searchTerms: [
                    functionality,
                    'valid', 'check', 'verify', 'require',
                    'error', 'fail', 'reject', 'deny'
                ]
            });
            
            if (!searchResults || searchResults.totalResults === 0) {
                return {
                    documentation: this._noResultsMessage('business rules', functionality),
                    filePath: null
                };
            }

            const { context } = await buildContext(searchResults, functionality, {
                llmClient: this.llmClient,
                log: this.log,
                maxContextChars: 32000,
                prioritize: 'validations'
            });

            this.onProgress('Extracting business rules...');

            const prompt = BusinessDocPrompts.extractRules(context, functionality);
            const systemPrompt = SystemPrompts.businessDoc();

            const documentation = await this.llmClient.complete(prompt, {
                system: systemPrompt,
                maxTokens: maxTokens,
                temperature: 0.2
            });

            let filePath = null;
            if (openInEditor) {
                filePath = await this._openInEditor(documentation, functionality, 'rules');
            }

            return {
                documentation,
                filePath,
                title: `${functionality} - Business Rules`
            };

        } catch (error) {
            this.log(`Error extracting business rules: ${error.message}`);
            throw error;
        }
    }

    /**
     * Quick summaries
     */
    async generateBusinessSummary(moduleName) {
        const searchResults = await this._searchForFunctionality(moduleName, { maxResults: 30 });
        
        if (!searchResults || searchResults.totalResults === 0) {
            return {
                documentation: this._noResultsMessage('business summary', moduleName),
                filePath: null
            };
        }

        const { context } = await buildContext(searchResults, moduleName, {
            log: this.log,
            maxContextChars: 24000
        });

        const prompt = BusinessDocPrompts.summary(context, moduleName);
        
        const documentation = await this.llmClient.complete(prompt, {
            system: SystemPrompts.businessDoc(),
            maxTokens: 2000,
            temperature: 0.3
        });

        return { documentation, filePath: null, title: `${moduleName} - Summary` };
    }

    async generateUseCasesSummary(moduleName) {
        const searchResults = await this._searchForFunctionality(moduleName, { maxResults: 30 });
        
        if (!searchResults || searchResults.totalResults === 0) {
            return {
                documentation: this._noResultsMessage('use cases summary', moduleName),
                filePath: null
            };
        }

        const { context } = await buildContext(searchResults, moduleName, {
            log: this.log,
            maxContextChars: 24000
        });

        const prompt = UseCasePrompts.summary(context, moduleName);
        
        const documentation = await this.llmClient.complete(prompt, {
            system: SystemPrompts.useCaseDoc(),
            maxTokens: 2000,
            temperature: 0.3
        });

        return { documentation, filePath: null, title: `${moduleName} - Use Cases Summary` };
    }

    /**
     * Main generate method
     */
    async generate(docType, moduleName, options = {}) {
        switch (docType) {
            case DOC_TYPES.BUSINESS:
                return this.generateBusinessDoc(moduleName, options);
            case DOC_TYPES.USE_CASES:
                return this.generateUseCases(moduleName, options);
            case DOC_TYPES.TECHNICAL:
                return this.generateTechnicalDoc(moduleName, options);
            case DOC_TYPES.BUSINESS_SUMMARY:
                return this.generateBusinessSummary(moduleName);
            case DOC_TYPES.USE_CASES_SUMMARY:
                return this.generateUseCasesSummary(moduleName);
            case DOC_TYPES.BUSINESS_RULES:
                return this.extractBusinessRules(moduleName, options);
            default:
                return this.generateBusinessDoc(moduleName, options);
        }
    }

    // ============================================================
    // PRIVATE HELPERS
    // ============================================================

    /**
     * Check if a file path is in the scoped contextFiles
     */
    _isFileInScope(filePath) {
        if (!this.contextFiles || this.contextFiles.size === 0) {
            return true;  // No scope = all files allowed
        }
        
        // Build suffix set for flexible path matching
        if (!this._scopeSuffixes) {
            this._scopeSuffixes = new Set();
            for (const p of this.contextFiles.keys()) {
                this._scopeSuffixes.add(p);
                const parts = p.split('/').filter(Boolean);
                for (let i = 0; i < Math.min(parts.length, 5); i++) {
                    this._scopeSuffixes.add(parts.slice(-(i + 1)).join('/'));
                }
            }
        }
        
        if (!filePath) return false;
        if (this._scopeSuffixes.has(filePath)) return true;
        const parts = filePath.split('/').filter(Boolean);
        for (let i = 0; i < Math.min(parts.length, 5); i++) {
            if (this._scopeSuffixes.has(parts.slice(-(i + 1)).join('/'))) return true;
        }
        return false;
    }

    /**
     * Search for functionality using multiple strategies
     * Respects contextFiles scope if set
     */
    async _searchForFunctionality(query, options = {}) {
        const { 
            maxResults = 50,
            includeSummaries = false,
            includeBusinessLogic = false,
            includeValidations = false,
            includeCallGraph = false,
            includeEntryPoints = false,
            searchTerms = []
        } = options;

        if (!this.codebaseIndex) {
            this.log('Warning: No codebaseIndex available');
            return { symbols: [], codeBlocks: [], summaries: [], totalResults: 0 };
        }

        const results = {
            symbols: [],
            codeBlocks: [],
            summaries: [],
            files: [],
            totalResults: 0
        };

        // Check if we have a scope (limited contextFiles)
        const hasScope = this.contextFiles && this.contextFiles.size > 0 && 
                         this.codebaseIndex.contextFiles && 
                         this.contextFiles.size < this.codebaseIndex.contextFiles.size;
        
        if (hasScope) {
            this.log(`[DocGen] Filtering search to ${this.contextFiles.size} scoped files`);
        }

        // Helper to filter results to scope
        const filterToScope = (items) => {
            if (!hasScope) return items;
            return items.filter(item => this._isFileInScope(item.file));
        };

        // Strategy 1: Direct search
        const directResults = this.codebaseIndex.search(query, { maxResults });
        if (directResults) {
            results.symbols.push(...filterToScope(directResults.symbols || []));
            results.codeBlocks.push(...filterToScope(directResults.codeBlocks || []));
        }

        // Strategy 2: Search for business logic patterns
        if (includeBusinessLogic || includeValidations) {
            const businessPatterns = [
                'validate', 'check', 'verify', 'is_valid', 'isValid',
                'require', 'assert', 'ensure', 'must', 'should',
                'error', 'fail', 'reject', 'deny', 'forbidden',
                'allow', 'permit', 'grant', 'authorize'
            ];
            
            for (const pattern of businessPatterns) {
                const patternResults = this.codebaseIndex.search(`${query} ${pattern}`, { maxResults: 10 });
                if (patternResults) {
                    for (const sym of filterToScope(patternResults.symbols || [])) {
                        if (!results.symbols.find(s => s.name === sym.name && s.file === sym.file)) {
                            results.symbols.push(sym);
                        }
                    }
                }
            }
        }

        // Strategy 3: Additional search terms
        for (const term of searchTerms) {
            const termResults = this.codebaseIndex.search(term, { maxResults: 10 });
            if (termResults) {
                for (const sym of filterToScope(termResults.symbols || [])) {
                    if (!results.symbols.find(s => s.name === sym.name && s.file === sym.file)) {
                        results.symbols.push(sym);
                    }
                }
            }
        }

        // Strategy 4: Get summaries if available
        if (includeSummaries && this.codebaseIndex.summaries) {
            for (const [key, summary] of this.codebaseIndex.summaries) {
                // Filter summaries to scope
                if (hasScope && !this._isFileInScope(summary.file || key.split('@')[0])) {
                    continue;
                }
                const keyLower = key.toLowerCase();
                const queryLower = query.toLowerCase();
                if (keyLower.includes(queryLower) || (summary.summary && summary.summary.toLowerCase().includes(queryLower))) {
                    results.summaries.push(summary);
                }
            }
        }

        // Strategy 5: Entry points (public functions)
        if (includeEntryPoints) {
            for (const [key, symbol] of this.codebaseIndex.symbols) {
                // Filter to scope
                if (hasScope && !this._isFileInScope(symbol.file)) {
                    continue;
                }
                if (symbol.type === 'function' && !key.includes('@')) {
                    // Check if it looks like a public/entry point
                    const nameLower = symbol.name.toLowerCase();
                    if (!nameLower.startsWith('_') && !nameLower.startsWith('internal')) {
                        if (symbol.name.toLowerCase().includes(query.toLowerCase())) {
                            if (!results.symbols.find(s => s.name === symbol.name && s.file === symbol.file)) {
                                results.symbols.push(symbol);
                            }
                        }
                    }
                }
            }
        }

        results.totalResults = results.symbols.length + results.codeBlocks.length + results.summaries.length;
        
        this.log(`Search for "${query}" found: ${results.totalResults} results (${results.symbols.length} symbols, ${results.summaries.length} summaries)`);
        
        return results;
    }

    /**
     * Open documentation in VS Code editor
     */
    async _openInEditor(content, moduleName, docType) {
        try {
            // Create temp file
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const safeName = moduleName.replace(/[^a-zA-Z0-9_-]/g, '_');
            const filename = `${safeName}-${docType}-${timestamp}.md`;
            const tempDir = os.tmpdir();
            const filePath = path.join(tempDir, filename);
            
            // Write content
            fs.writeFileSync(filePath, content, 'utf8');
            this.log(`Documentation saved to: ${filePath}`);
            
            // Open in VS Code
            const uri = vscode.Uri.file(filePath);
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, {
                preview: false,
                viewColumn: vscode.ViewColumn.Beside
            });
            
            return filePath;
            
        } catch (error) {
            this.log(`Error opening in editor: ${error.message}`);
            // Return path anyway so user can open manually
            return null;
        }
    }

    /**
     * No results message
     */
    _noResultsMessage(docType, query) {
        return `## No Code Found

Unable to generate ${docType} for "${query}".

**Possible reasons:**
- No code matches "${query}"
- Try a different search term
- Ensure relevant files are in context

**Suggestions:**
- Use broader terms (e.g., "payment" instead of "PaymentProcessor")
- Check spelling
- Rebuild the index if files were recently added

**Current index:**
- Files: ${this.codebaseIndex?.stats?.files || 0}
- Symbols: ${this.codebaseIndex?.stats?.symbols || 0}
`;
    }
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    DocGenerator,
    DOC_TYPES
};
