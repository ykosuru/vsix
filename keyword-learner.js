/**
 * AstraCode Keyword Learner Module
 * 
 * Dynamically learns keywords, synonyms, and domain vocabulary from the codebase
 * instead of relying on hardcoded lists.
 * 
 * Learning Sources:
 * 1. Code identifiers (function names, variables, classes)
 * 2. Comments and documentation strings
 * 3. String literals (often contain domain terminology)
 * 4. File/directory naming patterns
 * 5. Co-occurrence patterns across files
 * 
 * Outputs:
 * - Domain-specific vocabulary with weights
 * - Learned synonym clusters
 * - Adaptive stop words (common in THIS codebase)
 * - Term importance scores (TF-IDF based)
 */

const pathUtils = require('./pathUtils');

// ============================================================
// CONFIGURATION - Thresholds only, no domain-specific terms
// ============================================================

const LEARNER_CONFIG = {
    // Minimum occurrences to consider a term significant
    MIN_TERM_FREQUENCY: 2,
    
    // Maximum document frequency ratio (terms in >50% of files are stop words)
    MAX_DOC_FREQUENCY_RATIO: 0.5,
    
    // Minimum document frequency to include term
    MIN_DOC_FREQUENCY: 2,
    
    // Co-occurrence threshold for synonym detection
    COOCCURRENCE_THRESHOLD: 0.3,  // Jaccard similarity
    
    // Minimum pattern frequency for naming convention detection
    MIN_PATTERN_FREQUENCY: 3,
    
    // Maximum vocabulary size to prevent memory issues
    MAX_VOCABULARY_SIZE: 50000,
    
    // Weight multipliers for different sources
    WEIGHTS: {
        functionName: 3.0,
        className: 3.5,
        variableName: 1.5,
        comment: 2.5,
        stringLiteral: 2.0,
        fileName: 2.0,
        directoryName: 1.5,
        codeBody: 1.0
    }
};

// ============================================================
// KEYWORD LEARNER CLASS
// ============================================================

class KeywordLearner {
    constructor(options = {}) {
        this.config = { ...LEARNER_CONFIG, ...options };
        
        // Learned vocabulary: term -> { frequency, docFrequency, weight, sources }
        this.vocabulary = new Map();
        
        // Learned synonyms: term -> Set<related terms>
        this.synonymClusters = new Map();
        
        // Adaptive stop words (learned from codebase)
        this.learnedStopWords = new Set();
        
        // Term document index: term -> Set<docIds>
        this.termDocuments = new Map();
        
        // Document term index: docId -> Set<terms>
        this.documentTerms = new Map();
        
        // Naming patterns: pattern -> { terms, frequency }
        this.namingPatterns = new Map();
        
        // Domain concepts: automatically detected domain clusters
        this.domainConcepts = new Map();
        
        // Statistics
        this.stats = {
            documentsProcessed: 0,
            termsLearned: 0,
            synonymClustersFound: 0,
            stopWordsIdentified: 0,
            domainConceptsDetected: 0,
            lastUpdated: null
        };
    }
    
    /**
     * Learn vocabulary from a codebase
     * @param {Map} contextFiles - Map of filePath -> { content, language }
     * @param {Object} codeIndex - Parsed code index with symbols
     * @param {Object} options - Learning options
     */
    async learn(contextFiles, codeIndex, options = {}) {
        const { log = console.log, onProgress = null } = options;
        const startTime = Date.now();
        
        log('KeywordLearner: Starting vocabulary learning...');
        this.clear();
        
        const totalFiles = contextFiles.size;
        let processed = 0;
        
        // Phase 1: Extract terms from all sources
        for (const [filePath, fileInfo] of contextFiles) {
            this._processFile(filePath, fileInfo);
            processed++;
            
            if (onProgress && processed % 50 === 0) {
                onProgress(Math.round((processed / totalFiles) * 40), 
                    `Learning vocabulary: ${processed}/${totalFiles} files`);
            }
        }
        
        // Phase 2: Learn from symbols (functions, classes, variables)
        if (codeIndex?.symbols) {
            this._processSymbols(codeIndex.symbols);
        }
        
        if (onProgress) onProgress(50, 'Analyzing term distributions...');
        
        // Phase 3: Identify stop words (too common in this codebase)
        this._identifyStopWords();
        
        if (onProgress) onProgress(60, 'Detecting synonym clusters...');
        
        // Phase 4: Detect synonym clusters from co-occurrence
        this._detectSynonymClusters();
        
        if (onProgress) onProgress(75, 'Extracting domain concepts...');
        
        // Phase 5: Extract domain-specific concepts
        this._extractDomainConcepts();
        
        if (onProgress) onProgress(90, 'Finalizing vocabulary...');
        
        // Phase 6: Compute final weights and prune vocabulary
        this._finalizeVocabulary();
        
        this.stats.lastUpdated = new Date();
        this.stats.documentsProcessed = totalFiles;
        
        const elapsed = Date.now() - startTime;
        log(`KeywordLearner: Completed in ${elapsed}ms`);
        log(`  - ${this.vocabulary.size} terms learned`);
        log(`  - ${this.synonymClusters.size} synonym clusters`);
        log(`  - ${this.learnedStopWords.size} stop words identified`);
        log(`  - ${this.domainConcepts.size} domain concepts detected`);
        
        if (onProgress) onProgress(100, 'Vocabulary learning complete');
        
        return this.getStats();
    }
    
    /**
     * Process a single file for vocabulary extraction
     */
    _processFile(filePath, fileInfo) {
        const { content, language } = fileInfo;
        const docId = filePath;
        
        if (!content) return;
        
        // Extract terms from different sources with appropriate weights
        const fileTerms = new Map();
        
        // 1. File name terms
        const fileName = pathUtils.getFileName(filePath);
        this._extractAndWeight(fileName, fileTerms, 'fileName');
        
        // 2. Directory names
        const dirs = pathUtils.splitPath(filePath).slice(0, -1);
        for (const dir of dirs) {
            this._extractAndWeight(dir, fileTerms, 'directoryName');
        }
        
        // 3. Comments
        const comments = this._extractComments(content, language);
        for (const comment of comments) {
            this._extractAndWeight(comment, fileTerms, 'comment');
        }
        
        // 4. String literals
        const strings = this._extractStrings(content);
        for (const str of strings) {
            this._extractAndWeight(str, fileTerms, 'stringLiteral');
        }
        
        // 5. Code body (lower weight)
        const codeWithoutCommentsStrings = this._stripCommentsAndStrings(content, language);
        this._extractAndWeight(codeWithoutCommentsStrings, fileTerms, 'codeBody');
        
        // Update global indices
        this.documentTerms.set(docId, new Set(fileTerms.keys()));
        
        for (const [term, weight] of fileTerms) {
            // Update vocabulary
            if (!this.vocabulary.has(term)) {
                this.vocabulary.set(term, {
                    frequency: 0,
                    docFrequency: 0,
                    totalWeight: 0,
                    sources: new Set()
                });
            }
            const entry = this.vocabulary.get(term);
            entry.frequency += 1;
            entry.totalWeight += weight;
            
            // Update term-document index
            if (!this.termDocuments.has(term)) {
                this.termDocuments.set(term, new Set());
            }
            this.termDocuments.get(term).add(docId);
        }
    }
    
    /**
     * Process symbols from code index
     */
    _processSymbols(symbols) {
        for (const [key, symbol] of symbols) {
            if (key.includes('@')) continue;  // Skip qualified names
            
            const sourceType = this._getSymbolSourceType(symbol.type);
            const terms = this._tokenize(symbol.name);
            
            for (const term of terms) {
                if (!this.vocabulary.has(term)) {
                    this.vocabulary.set(term, {
                        frequency: 0,
                        docFrequency: 0,
                        totalWeight: 0,
                        sources: new Set()
                    });
                }
                const entry = this.vocabulary.get(term);
                entry.frequency += 1;
                entry.totalWeight += this.config.WEIGHTS[sourceType] || 1.0;
                entry.sources.add(sourceType);
            }
            
            // Also learn from signature/params if available
            if (symbol.signature) {
                const sigTerms = this._tokenize(symbol.signature);
                for (const term of sigTerms) {
                    if (!this.vocabulary.has(term)) {
                        this.vocabulary.set(term, {
                            frequency: 0,
                            docFrequency: 0,
                            totalWeight: 0,
                            sources: new Set()
                        });
                    }
                    this.vocabulary.get(term).frequency += 1;
                }
            }
        }
    }
    
    /**
     * Map symbol types to source types for weighting
     */
    _getSymbolSourceType(symbolType) {
        const mapping = {
            'function': 'functionName',
            'method': 'functionName',
            'procedure': 'functionName',
            'subproc': 'functionName',
            'class': 'className',
            'struct': 'className',
            'interface': 'className',
            'enum': 'className',
            'variable': 'variableName',
            'constant': 'variableName',
            'field': 'variableName'
        };
        return mapping[symbolType] || 'codeBody';
    }
    
    /**
     * Extract terms and apply weight
     */
    _extractAndWeight(text, termMap, sourceType) {
        const terms = this._tokenize(text);
        const weight = this.config.WEIGHTS[sourceType] || 1.0;
        
        for (const term of terms) {
            const currentWeight = termMap.get(term) || 0;
            termMap.set(term, currentWeight + weight);
            
            // Track source types in vocabulary
            if (this.vocabulary.has(term)) {
                this.vocabulary.get(term).sources.add(sourceType);
            }
        }
    }
    
    /**
     * Tokenize text into terms
     */
    _tokenize(text) {
        if (!text || typeof text !== 'string') return [];
        
        // Split camelCase and snake_case
        let normalized = text
            .replace(/([a-z])([A-Z])/g, '$1 $2')  // camelCase
            .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')  // XMLParser -> XML Parser
            .replace(/_/g, ' ')  // snake_case
            .replace(/-/g, ' ')  // kebab-case
            .replace(/[^a-zA-Z0-9\s]/g, ' ')
            .toLowerCase();
        
        return normalized
            .split(/\s+/)
            .filter(t => t.length >= 2 && t.length <= 40);
    }
    
    /**
     * Extract comments from code
     */
    _extractComments(content, language) {
        const comments = [];
        const patterns = this._getCommentPatterns(language);
        
        for (const pattern of patterns) {
            let match;
            const regex = new RegExp(pattern.source, pattern.flags);
            while ((match = regex.exec(content)) !== null) {
                comments.push(match[1] || match[0]);
            }
        }
        
        return comments;
    }
    
    /**
     * Get comment patterns for a language
     */
    _getCommentPatterns(language) {
        // Return array of regex patterns for the language
        const patterns = {
            javascript: [/\/\/(.+)$/gm, /\/\*[\s\S]*?\*\//g],
            typescript: [/\/\/(.+)$/gm, /\/\*[\s\S]*?\*\//g],
            python: [/#(.+)$/gm, /'''[\s\S]*?'''/g, /"""[\s\S]*?"""/g],
            java: [/\/\/(.+)$/gm, /\/\*[\s\S]*?\*\//g],
            c: [/\/\/(.+)$/gm, /\/\*[\s\S]*?\*\//g],
            cpp: [/\/\/(.+)$/gm, /\/\*[\s\S]*?\*\//g],
            sql: [/--(.+)$/gm, /\/\*[\s\S]*?\*\//g],
            cobol: [/^.{6}\*(.*)$/gm],
            tal: [/--(.+)$/gm, /!(.+)$/gm]
        };
        
        return patterns[language] || patterns.javascript;
    }
    
    /**
     * Extract string literals from code
     */
    _extractStrings(content) {
        const strings = [];
        const patterns = [
            /"([^"\\]|\\.)*"/g,
            /'([^'\\]|\\.)*'/g,
            /`([^`\\]|\\.)*`/g
        ];
        
        for (const pattern of patterns) {
            let match;
            while ((match = pattern.exec(content)) !== null) {
                // Remove quotes and add if substantial
                const str = match[0].slice(1, -1);
                if (str.length >= 3 && str.length <= 200) {
                    strings.push(str);
                }
            }
        }
        
        return strings;
    }
    
    /**
     * Strip comments and strings from code
     */
    _stripCommentsAndStrings(content, language) {
        let stripped = content;
        
        // Remove comments
        const commentPatterns = this._getCommentPatterns(language);
        for (const pattern of commentPatterns) {
            stripped = stripped.replace(pattern, ' ');
        }
        
        // Remove strings
        stripped = stripped
            .replace(/"([^"\\]|\\.)*"/g, '""')
            .replace(/'([^'\\]|\\.)*'/g, "''")
            .replace(/`([^`\\]|\\.)*`/g, '``');
        
        return stripped;
    }
    
    /**
     * Identify stop words based on document frequency
     */
    _identifyStopWords() {
        const totalDocs = this.documentTerms.size;
        const maxDf = totalDocs * this.config.MAX_DOC_FREQUENCY_RATIO;
        
        for (const [term, docs] of this.termDocuments) {
            const df = docs.size;
            
            // Update doc frequency in vocabulary
            if (this.vocabulary.has(term)) {
                this.vocabulary.get(term).docFrequency = df;
            }
            
            // Mark as stop word if too common
            if (df > maxDf) {
                this.learnedStopWords.add(term);
            }
        }
        
        this.stats.stopWordsIdentified = this.learnedStopWords.size;
    }
    
    /**
     * Detect synonym clusters from co-occurrence patterns
     */
    _detectSynonymClusters() {
        // Build co-occurrence matrix (sparse)
        const cooccurrence = new Map();
        
        for (const [docId, terms] of this.documentTerms) {
            const termArray = Array.from(terms);
            
            // Skip very large documents (too noisy)
            if (termArray.length > 500) continue;
            
            for (let i = 0; i < termArray.length; i++) {
                for (let j = i + 1; j < termArray.length; j++) {
                    const t1 = termArray[i];
                    const t2 = termArray[j];
                    
                    // Skip stop words
                    if (this.learnedStopWords.has(t1) || this.learnedStopWords.has(t2)) continue;
                    
                    const pair = t1 < t2 ? `${t1}|${t2}` : `${t2}|${t1}`;
                    cooccurrence.set(pair, (cooccurrence.get(pair) || 0) + 1);
                }
            }
        }
        
        // Find strong co-occurrences using Jaccard similarity
        for (const [pair, count] of cooccurrence) {
            if (count < this.config.MIN_TERM_FREQUENCY) continue;
            
            const [t1, t2] = pair.split('|');
            const docs1 = this.termDocuments.get(t1)?.size || 0;
            const docs2 = this.termDocuments.get(t2)?.size || 0;
            
            // Jaccard similarity: intersection / union
            const jaccard = count / (docs1 + docs2 - count);
            
            if (jaccard >= this.config.COOCCURRENCE_THRESHOLD) {
                // Add to synonym clusters
                if (!this.synonymClusters.has(t1)) {
                    this.synonymClusters.set(t1, new Set());
                }
                if (!this.synonymClusters.has(t2)) {
                    this.synonymClusters.set(t2, new Set());
                }
                
                this.synonymClusters.get(t1).add(t2);
                this.synonymClusters.get(t2).add(t1);
            }
        }
        
        this.stats.synonymClustersFound = this.synonymClusters.size;
    }
    
    /**
     * Extract domain-specific concepts from vocabulary patterns
     */
    _extractDomainConcepts() {
        // Group terms by prefix/suffix patterns
        const prefixGroups = new Map();
        const suffixGroups = new Map();
        
        for (const term of this.vocabulary.keys()) {
            if (term.length < 4) continue;
            if (this.learnedStopWords.has(term)) continue;
            
            // Extract prefixes (3-5 chars)
            for (let len = 3; len <= Math.min(5, term.length - 2); len++) {
                const prefix = term.slice(0, len);
                if (!prefixGroups.has(prefix)) {
                    prefixGroups.set(prefix, new Set());
                }
                prefixGroups.get(prefix).add(term);
            }
            
            // Extract suffixes (3-5 chars)
            for (let len = 3; len <= Math.min(5, term.length - 2); len++) {
                const suffix = term.slice(-len);
                if (!suffixGroups.has(suffix)) {
                    suffixGroups.set(suffix, new Set());
                }
                suffixGroups.get(suffix).add(term);
            }
        }
        
        // Find significant patterns (multiple terms share prefix/suffix)
        const patterns = [];
        
        for (const [prefix, terms] of prefixGroups) {
            if (terms.size >= this.config.MIN_PATTERN_FREQUENCY) {
                patterns.push({
                    type: 'prefix',
                    pattern: prefix,
                    terms: Array.from(terms),
                    frequency: terms.size
                });
            }
        }
        
        for (const [suffix, terms] of suffixGroups) {
            if (terms.size >= this.config.MIN_PATTERN_FREQUENCY) {
                patterns.push({
                    type: 'suffix',
                    pattern: suffix,
                    terms: Array.from(terms),
                    frequency: terms.size
                });
            }
        }
        
        // Convert patterns to domain concepts
        for (const pattern of patterns) {
            const conceptName = pattern.type === 'prefix' 
                ? `${pattern.pattern}*` 
                : `*${pattern.pattern}`;
            
            this.domainConcepts.set(conceptName, {
                type: pattern.type,
                pattern: pattern.pattern,
                terms: pattern.terms,
                frequency: pattern.frequency
            });
        }
        
        this.stats.domainConceptsDetected = this.domainConcepts.size;
    }
    
    /**
     * Finalize vocabulary with TF-IDF weights and pruning
     */
    _finalizeVocabulary() {
        const totalDocs = this.documentTerms.size;
        const toRemove = [];
        
        for (const [term, entry] of this.vocabulary) {
            // Remove stop words
            if (this.learnedStopWords.has(term)) {
                toRemove.push(term);
                continue;
            }
            
            // Remove rare terms
            if (entry.docFrequency < this.config.MIN_DOC_FREQUENCY) {
                toRemove.push(term);
                continue;
            }
            
            // Compute final IDF-based weight
            const idf = Math.log((totalDocs + 1) / (entry.docFrequency + 1));
            entry.idfWeight = idf;
            entry.finalWeight = entry.totalWeight * idf;
        }
        
        // Prune vocabulary
        for (const term of toRemove) {
            this.vocabulary.delete(term);
        }
        
        // If still too large, keep top N by weight
        if (this.vocabulary.size > this.config.MAX_VOCABULARY_SIZE) {
            const sorted = Array.from(this.vocabulary.entries())
                .sort((a, b) => b[1].finalWeight - a[1].finalWeight)
                .slice(0, this.config.MAX_VOCABULARY_SIZE);
            
            this.vocabulary = new Map(sorted);
        }
        
        this.stats.termsLearned = this.vocabulary.size;
    }
    
    // ============================================================
    // PUBLIC API
    // ============================================================
    
    /**
     * Get synonyms for a term (learned from codebase)
     */
    getSynonyms(term) {
        const lower = term.toLowerCase();
        return this.synonymClusters.get(lower) || new Set();
    }
    
    /**
     * Check if a term is a stop word (in this codebase)
     */
    isStopWord(term) {
        return this.learnedStopWords.has(term.toLowerCase());
    }
    
    /**
     * Get term weight (importance in this codebase)
     */
    getTermWeight(term) {
        const entry = this.vocabulary.get(term.toLowerCase());
        return entry ? entry.finalWeight : 0;
    }
    
    /**
     * Expand a query using learned vocabulary
     */
    expandQuery(query) {
        const terms = this._tokenize(query);
        const expanded = new Set(terms);
        
        for (const term of terms) {
            // Add learned synonyms
            const synonyms = this.getSynonyms(term);
            for (const syn of synonyms) {
                expanded.add(syn);
            }
            
            // Add terms from domain concepts that contain this term
            for (const [conceptName, concept] of this.domainConcepts) {
                if (concept.terms.includes(term)) {
                    // Add other terms from same concept (limited)
                    const relatedTerms = concept.terms
                        .filter(t => t !== term)
                        .slice(0, 3);
                    for (const rt of relatedTerms) {
                        expanded.add(rt);
                    }
                }
            }
        }
        
        return Array.from(expanded);
    }
    
    /**
     * Get related terms for autocomplete/suggestions
     */
    getRelatedTerms(prefix, maxResults = 10) {
        const lower = prefix.toLowerCase();
        const results = [];
        
        for (const [term, entry] of this.vocabulary) {
            if (term.startsWith(lower)) {
                results.push({
                    term,
                    weight: entry.finalWeight,
                    docFrequency: entry.docFrequency
                });
            }
        }
        
        return results
            .sort((a, b) => b.weight - a.weight)
            .slice(0, maxResults);
    }
    
    /**
     * Get top terms by weight
     */
    getTopTerms(n = 100) {
        return Array.from(this.vocabulary.entries())
            .sort((a, b) => b[1].finalWeight - a[1].finalWeight)
            .slice(0, n)
            .map(([term, entry]) => ({
                term,
                weight: entry.finalWeight,
                frequency: entry.frequency,
                docFrequency: entry.docFrequency,
                sources: Array.from(entry.sources)
            }));
    }
    
    /**
     * Get domain concepts
     */
    getDomainConcepts() {
        return Array.from(this.domainConcepts.entries())
            .sort((a, b) => b[1].frequency - a[1].frequency)
            .map(([name, concept]) => ({
                name,
                type: concept.type,
                pattern: concept.pattern,
                termCount: concept.terms.length,
                exampleTerms: concept.terms.slice(0, 5)
            }));
    }
    
    /**
     * Get statistics
     */
    getStats() {
        return {
            ...this.stats,
            vocabularySize: this.vocabulary.size,
            synonymClusterCount: this.synonymClusters.size,
            stopWordCount: this.learnedStopWords.size,
            domainConceptCount: this.domainConcepts.size
        };
    }
    
    /**
     * Clear all learned data
     */
    clear() {
        this.vocabulary.clear();
        this.synonymClusters.clear();
        this.learnedStopWords.clear();
        this.termDocuments.clear();
        this.documentTerms.clear();
        this.namingPatterns.clear();
        this.domainConcepts.clear();
        
        this.stats = {
            documentsProcessed: 0,
            termsLearned: 0,
            synonymClustersFound: 0,
            stopWordsIdentified: 0,
            domainConceptsDetected: 0,
            lastUpdated: null
        };
    }
    
    /**
     * Export learned vocabulary for persistence
     */
    export() {
        return {
            version: '1.0',
            stats: this.stats,
            vocabulary: Array.from(this.vocabulary.entries()).map(([term, entry]) => ({
                term,
                frequency: entry.frequency,
                docFrequency: entry.docFrequency,
                finalWeight: entry.finalWeight,
                sources: Array.from(entry.sources)
            })),
            synonymClusters: Array.from(this.synonymClusters.entries())
                .map(([term, syns]) => [term, Array.from(syns)]),
            stopWords: Array.from(this.learnedStopWords),
            domainConcepts: Array.from(this.domainConcepts.entries())
        };
    }
    
    /**
     * Import previously learned vocabulary
     */
    import(data) {
        if (!data || data.version !== '1.0') {
            throw new Error('Invalid vocabulary data format');
        }
        
        this.clear();
        this.stats = data.stats;
        
        // Restore vocabulary
        for (const entry of data.vocabulary) {
            this.vocabulary.set(entry.term, {
                frequency: entry.frequency,
                docFrequency: entry.docFrequency,
                finalWeight: entry.finalWeight,
                sources: new Set(entry.sources)
            });
        }
        
        // Restore synonyms
        for (const [term, syns] of data.synonymClusters) {
            this.synonymClusters.set(term, new Set(syns));
        }
        
        // Restore stop words
        for (const word of data.stopWords) {
            this.learnedStopWords.add(word);
        }
        
        // Restore domain concepts
        for (const [name, concept] of data.domainConcepts) {
            this.domainConcepts.set(name, concept);
        }
    }
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    KeywordLearner,
    LEARNER_CONFIG
};
