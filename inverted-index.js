/**
 * AstraCode Inverted Index Module v5.1
 * 
 * Fast keyword-based search across code content, summaries, and symbols.
 * Provides O(1) lookup for "find all code mentioning X".
 * 
 * Index Types:
 * 1. Content Index - Keywords from actual code
 * 2. Summary Index - Keywords from function/file summaries
 * 3. Symbol Index - Function/class/variable names
 * 4. Concept Index - Domain concepts and business terms
 * 
 * Usage:
 *   const { InvertedIndex } = require('./inverted-index');
 *   const index = new InvertedIndex();
 *   index.buildFromCodebase(contextFiles, codeIndex);
 *   const results = index.search('payment validation');
 */

// ============================================================
// STOP WORDS - Common words to exclude from indexing
// ============================================================

const STOP_WORDS = new Set([
    // English
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
    'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought',
    'used', 'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'it',
    'we', 'they', 'what', 'which', 'who', 'whom', 'whose', 'where', 'when',
    'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more', 'most',
    'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same',
    'so', 'than', 'too', 'very', 'just', 'also', 'now', 'here', 'there',
    
    // Code-specific noise words
    'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch',
    'case', 'break', 'continue', 'default', 'try', 'catch', 'finally',
    'throw', 'throws', 'new', 'class', 'interface', 'extends', 'implements',
    'public', 'private', 'protected', 'static', 'final', 'abstract',
    'void', 'int', 'string', 'boolean', 'true', 'false', 'null', 'undefined',
    'var', 'let', 'const', 'import', 'export', 'require', 'module',
    'param', 'returns', 'type', 'todo', 'fixme', 'note', 'xxx',
    
    // Common variable names
    'i', 'j', 'k', 'n', 'x', 'y', 'z', 'tmp', 'temp', 'val', 'value',
    'key', 'index', 'count', 'result', 'results', 'data', 'item', 'items',
    'arr', 'array', 'list', 'map', 'set', 'obj', 'object', 'str', 'num'
]);

// ============================================================
// TERM EXTRACTION
// ============================================================

/**
 * Extract indexable terms from text
 * @param {string} text - Text to extract terms from
 * @param {Object} options - Extraction options
 * @returns {Map<string, number>} Term -> frequency map
 */
function extractTerms(text, options = {}) {
    const {
        minLength = 2,
        maxLength = 50,
        includeNumbers = false,
        splitCamelCase = true,
        splitSnakeCase = true,
        lowercase = true
    } = options;
    
    const termFreq = new Map();
    
    if (!text || typeof text !== 'string') return termFreq;
    
    // Normalize text
    let normalized = text;
    
    // Split camelCase: processPayment -> process Payment
    if (splitCamelCase) {
        normalized = normalized.replace(/([a-z])([A-Z])/g, '$1 $2');
    }
    
    // Split snake_case: process_payment -> process payment
    if (splitSnakeCase) {
        normalized = normalized.replace(/_/g, ' ');
    }
    
    // Remove special characters, keep alphanumeric and spaces
    normalized = normalized.replace(/[^a-zA-Z0-9\s]/g, ' ');
    
    // Split into words
    const words = normalized.split(/\s+/);
    
    for (let word of words) {
        if (lowercase) word = word.toLowerCase();
        
        // Skip if too short/long
        if (word.length < minLength || word.length > maxLength) continue;
        
        // Skip numbers unless requested
        if (!includeNumbers && /^\d+$/.test(word)) continue;
        
        // Skip stop words
        if (STOP_WORDS.has(word.toLowerCase())) continue;
        
        // Add to frequency map
        termFreq.set(word, (termFreq.get(word) || 0) + 1);
    }
    
    return termFreq;
}

/**
 * Extract terms from code with language awareness
 * @param {string} code - Source code
 * @param {string} language - Programming language
 * @returns {Map<string, number>} Term -> frequency map
 */
function extractCodeTerms(code, language) {
    const termFreq = new Map();
    
    // Extract from comments (high value for understanding)
    const commentPatterns = [
        /\/\/(.+)$/gm,                    // Single-line //
        /\/\*[\s\S]*?\*\//g,              // Multi-line /* */
        /#(.+)$/gm,                        // Python/Shell #
        /--(.+)$/gm,                       // SQL --
        /\*(.+)$/gm,                       // COBOL *
    ];
    
    for (const pattern of commentPatterns) {
        let match;
        while ((match = pattern.exec(code)) !== null) {
            const commentTerms = extractTerms(match[1] || match[0], { minLength: 3 });
            for (const [term, freq] of commentTerms) {
                // Comments are weighted higher (2x)
                termFreq.set(term, (termFreq.get(term) || 0) + freq * 2);
            }
        }
    }
    
    // Extract from string literals (often contain business terms)
    const stringPatterns = [
        /"([^"]+)"/g,
        /'([^']+)'/g,
        /`([^`]+)`/g
    ];
    
    for (const pattern of stringPatterns) {
        let match;
        while ((match = pattern.exec(code)) !== null) {
            const stringTerms = extractTerms(match[1], { minLength: 3 });
            for (const [term, freq] of stringTerms) {
                // Strings weighted 1.5x
                termFreq.set(term, (termFreq.get(term) || 0) + freq * 1.5);
            }
        }
    }
    
    // Extract identifiers (function names, variables)
    const identifierPattern = /\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g;
    let match;
    while ((match = identifierPattern.exec(code)) !== null) {
        const idTerms = extractTerms(match[1], { minLength: 3 });
        for (const [term, freq] of idTerms) {
            termFreq.set(term, (termFreq.get(term) || 0) + freq);
        }
    }
    
    return termFreq;
}

// ============================================================
// POSTING LIST
// ============================================================

/**
 * Posting entry - represents one occurrence of a term
 */
class Posting {
    constructor(docId, docType, frequency, positions = [], metadata = {}) {
        this.docId = docId;           // File path or symbol key
        this.docType = docType;       // 'file', 'function', 'summary', 'comment'
        this.frequency = frequency;   // Term frequency in this doc
        this.positions = positions;   // Line numbers where term appears
        this.metadata = metadata;     // Additional info (function name, etc.)
    }
    
    /**
     * Calculate TF-IDF score
     */
    tfidf(totalDocs, docsWithTerm) {
        const tf = Math.log(1 + this.frequency);
        const idf = Math.log(totalDocs / (1 + docsWithTerm));
        return tf * idf;
    }
}

// ============================================================
// INVERTED INDEX
// ============================================================

/**
 * Main inverted index class
 */
class InvertedIndex {
    constructor(options = {}) {
        this.options = {
            minTermLength: 2,
            maxTermLength: 50,
            enableStemming: false,      // Future: add stemming
            enableSynonyms: true,       // Enable synonym expansion
            boostComments: 2.0,         // Weight for comment terms
            boostSummaries: 3.0,        // Weight for summary terms
            boostSymbols: 2.5,          // Weight for symbol names
            ...options
        };
        
        // Main index: term -> Posting[]
        this.index = new Map();
        
        // Document metadata: docId -> {path, type, name, summary, ...}
        this.documents = new Map();
        
        // Reverse index: docId -> Set<terms>
        this.docTerms = new Map();
        
        // Statistics
        this.stats = {
            totalDocuments: 0,
            totalTerms: 0,
            uniqueTerms: 0,
            indexedFiles: 0,
            indexedFunctions: 0,
            indexedSummaries: 0,
            lastUpdated: null
        };
        
        // Synonym map for concept expansion
        this.synonyms = new Map();
        this._initSynonyms();
        
        // Concept clusters (related terms)
        this.concepts = new Map();
    }
    
    /**
     * Initialize common synonyms/related terms
     */
    _initSynonyms() {
        const synonymGroups = [
            // Authentication/Authorization
            ['auth', 'authentication', 'login', 'signin', 'signon', 'credential', 'password', 'token', 'jwt', 'oauth', 'session'],
            ['authorize', 'authorization', 'permission', 'access', 'role', 'privilege', 'acl'],
            
            // Data operations
            ['create', 'insert', 'add', 'new', 'post'],
            ['read', 'get', 'fetch', 'retrieve', 'query', 'select', 'find', 'lookup'],
            ['update', 'modify', 'edit', 'change', 'put', 'patch', 'set'],
            ['delete', 'remove', 'drop', 'destroy', 'clear', 'purge'],
            
            // Validation
            ['validate', 'validation', 'verify', 'check', 'assert', 'ensure', 'sanitize'],
            ['error', 'exception', 'failure', 'invalid', 'fault', 'problem'],
            
            // Payment/Financial
            ['payment', 'pay', 'transaction', 'transfer', 'remittance', 'wire'],
            ['amount', 'balance', 'total', 'sum', 'money', 'currency', 'fund'],
            ['account', 'acct', 'customer', 'client', 'party', 'beneficiary'],
            ['bank', 'financial', 'institution', 'fi'],
            
            // Processing
            ['process', 'handle', 'execute', 'run', 'perform', 'do'],
            ['parse', 'extract', 'decode', 'deserialize', 'unmarshal'],
            ['format', 'encode', 'serialize', 'marshal', 'convert', 'transform'],
            
            // Configuration
            ['config', 'configuration', 'settings', 'options', 'preferences', 'params'],
            ['init', 'initialize', 'setup', 'bootstrap', 'start', 'begin'],
            
            // Data structures
            ['message', 'msg', 'request', 'req', 'payload', 'body'],
            ['response', 'resp', 'reply', 'result', 'output'],
            ['record', 'row', 'entry', 'item', 'entity', 'document', 'doc'],
            ['field', 'column', 'attribute', 'property', 'prop'],
            
            // Legacy/Mainframe
            ['cobol', 'copybook', 'cpy', 'mainframe', 'legacy'],
            ['tal', 'tandem', 'nonstop', 'guardian', 'pathway'],
            ['procedure', 'proc', 'subproc', 'paragraph', 'section'],
            
            // Messaging
            ['queue', 'mq', 'message', 'publish', 'subscribe', 'event'],
            ['send', 'emit', 'dispatch', 'transmit', 'post'],
            ['receive', 'consume', 'listen', 'handle', 'subscribe'],
            
            // Database
            ['database', 'db', 'sql', 'table', 'schema'],
            ['index', 'idx', 'key', 'primary', 'foreign'],
            ['join', 'relation', 'link', 'reference', 'fk'],
            
            // API/Network
            ['api', 'endpoint', 'route', 'url', 'uri', 'path'],
            ['http', 'https', 'rest', 'soap', 'grpc'],
            ['request', 'req', 'call', 'invoke'],
            
            // File operations
            ['file', 'document', 'attachment', 'blob'],
            ['read', 'load', 'open', 'input'],
            ['write', 'save', 'store', 'output', 'persist']
        ];
        
        for (const group of synonymGroups) {
            for (const term of group) {
                if (!this.synonyms.has(term)) {
                    this.synonyms.set(term, new Set());
                }
                for (const related of group) {
                    if (related !== term) {
                        this.synonyms.get(term).add(related);
                    }
                }
            }
        }
    }
    
    /**
     * Get synonyms for a term
     */
    getSynonyms(term) {
        const lower = term.toLowerCase();
        return this.synonyms.get(lower) || new Set();
    }
    
    /**
     * Expand query with synonyms
     */
    expandQuery(query) {
        const terms = extractTerms(query, { minLength: 2 });
        const expanded = new Set(terms.keys());
        
        if (this.options.enableSynonyms) {
            for (const term of terms.keys()) {
                const syns = this.getSynonyms(term);
                for (const syn of syns) {
                    expanded.add(syn);
                }
            }
        }
        
        return Array.from(expanded);
    }
    
    /**
     * Add a document to the index
     */
    addDocument(docId, content, docType, metadata = {}) {
        // Extract terms based on document type
        let termFreq;
        if (docType === 'code' || docType === 'file') {
            termFreq = extractCodeTerms(content, metadata.language);
        } else {
            termFreq = extractTerms(content, { minLength: this.options.minTermLength });
        }
        
        // Apply boost based on document type
        let boost = 1.0;
        if (docType === 'summary') boost = this.options.boostSummaries;
        else if (docType === 'symbol') boost = this.options.boostSymbols;
        else if (docType === 'comment') boost = this.options.boostComments;
        
        // Store document metadata
        this.documents.set(docId, {
            id: docId,
            type: docType,
            termCount: termFreq.size,
            ...metadata
        });
        
        // Track terms in this document
        this.docTerms.set(docId, new Set(termFreq.keys()));
        
        // Add to inverted index
        for (const [term, freq] of termFreq) {
            if (!this.index.has(term)) {
                this.index.set(term, []);
            }
            
            const posting = new Posting(
                docId,
                docType,
                freq * boost,
                metadata.positions || [],
                metadata
            );
            
            this.index.get(term).push(posting);
        }
        
        // Update stats
        this.stats.totalDocuments++;
        this.stats.totalTerms += termFreq.size;
        this.stats.uniqueTerms = this.index.size;
        
        if (docType === 'file' || docType === 'code') this.stats.indexedFiles++;
        else if (docType === 'function' || docType === 'symbol') this.stats.indexedFunctions++;
        else if (docType === 'summary') this.stats.indexedSummaries++;
    }
    
    /**
     * Remove a document from the index
     */
    removeDocument(docId) {
        const terms = this.docTerms.get(docId);
        if (!terms) return;
        
        // Remove from each posting list
        for (const term of terms) {
            const postings = this.index.get(term);
            if (postings) {
                const filtered = postings.filter(p => p.docId !== docId);
                if (filtered.length > 0) {
                    this.index.set(term, filtered);
                } else {
                    this.index.delete(term);
                }
            }
        }
        
        // Remove document metadata
        this.documents.delete(docId);
        this.docTerms.delete(docId);
        
        // Update stats
        this.stats.totalDocuments--;
        this.stats.uniqueTerms = this.index.size;
    }
    
    /**
     * Build index from codebase
     */
    buildFromCodebase(contextFiles, codeIndex, options = {}) {
        const { log = console.log, showProgress = () => {} } = options;
        const startTime = Date.now();
        
        this.clear();
        
        log('Building inverted index...');
        
        // Index file contents
        let fileCount = 0;
        for (const [filePath, fileInfo] of contextFiles) {
            showProgress(`Indexing ${fileCount + 1}/${contextFiles.size}: ${filePath}`);
            
            // Index file content
            this.addDocument(
                `file:${filePath}`,
                fileInfo.content,
                'file',
                {
                    path: filePath,
                    language: fileInfo.language,
                    name: filePath.split('/').pop()
                }
            );
            
            fileCount++;
        }
        
        // Index symbols (functions, classes, etc.)
        let symbolCount = 0;
        for (const [key, symbol] of codeIndex.symbols) {
            if (!key.includes('@')) continue;  // Skip non-qualified keys
            
            // Index symbol name and any summary
            const content = [
                symbol.name,
                symbol.summary || '',
                symbol.signature || '',
                symbol.params || ''
            ].join(' ');
            
            this.addDocument(
                `symbol:${key}`,
                content,
                'symbol',
                {
                    name: symbol.name,
                    type: symbol.type,
                    file: symbol.file,
                    line: symbol.line,
                    signature: symbol.signature
                }
            );
            
            symbolCount++;
        }
        
        // Index function summaries (from LLM)
        let summaryCount = 0;
        for (const [key, summaryInfo] of codeIndex.summaries) {
            if (!summaryInfo.summary) continue;
            
            this.addDocument(
                `summary:${key}`,
                summaryInfo.summary,
                'summary',
                {
                    name: summaryInfo.name,
                    file: summaryInfo.file,
                    symbolKey: key
                }
            );
            
            summaryCount++;
        }
        
        // Index file summaries
        for (const [filePath, summary] of codeIndex.fileSummaries) {
            if (!summary) continue;
            
            this.addDocument(
                `filesummary:${filePath}`,
                summary,
                'summary',
                {
                    path: filePath,
                    name: filePath.split('/').pop()
                }
            );
            
            summaryCount++;
        }
        
        // Build concept clusters
        this._buildConceptClusters();
        
        this.stats.lastUpdated = new Date();
        
        const elapsed = Date.now() - startTime;
        log(`Inverted index built in ${elapsed}ms:`);
        log(`  - ${fileCount} files`);
        log(`  - ${symbolCount} symbols`);
        log(`  - ${summaryCount} summaries`);
        log(`  - ${this.index.size} unique terms`);
        
        return this.stats;
    }
    
    /**
     * Build concept clusters from indexed terms
     */
    _buildConceptClusters() {
        // Group terms that frequently co-occur
        const cooccurrence = new Map();
        
        for (const [docId, terms] of this.docTerms) {
            const termArray = Array.from(terms);
            for (let i = 0; i < termArray.length; i++) {
                for (let j = i + 1; j < termArray.length; j++) {
                    const pair = [termArray[i], termArray[j]].sort().join('|');
                    cooccurrence.set(pair, (cooccurrence.get(pair) || 0) + 1);
                }
            }
        }
        
        // Find strongly related term pairs
        for (const [pair, count] of cooccurrence) {
            if (count >= 3) {  // Appears together in at least 3 docs
                const [term1, term2] = pair.split('|');
                
                if (!this.concepts.has(term1)) {
                    this.concepts.set(term1, new Set());
                }
                this.concepts.get(term1).add(term2);
                
                if (!this.concepts.has(term2)) {
                    this.concepts.set(term2, new Set());
                }
                this.concepts.get(term2).add(term1);
            }
        }
    }
    
    /**
     * Search the index
     * @param {string} query - Search query
     * @param {Object} options - Search options
     * @returns {Array} Ranked results
     */
    search(query, options = {}) {
        const {
            maxResults = 50,
            minScore = 0.1,
            docTypes = null,        // Filter by document type
            expandSynonyms = true,
            includeContext = true
        } = options;
        
        // Extract and expand query terms
        const queryTerms = expandSynonyms ? 
            this.expandQuery(query) : 
            Array.from(extractTerms(query, { minLength: 2 }).keys());
        
        if (queryTerms.length === 0) {
            return [];
        }
        
        // Collect matching documents with scores
        const docScores = new Map();
        const docMatches = new Map();  // Track which terms matched
        
        for (const term of queryTerms) {
            const postings = this.index.get(term);
            if (!postings) continue;
            
            for (const posting of postings) {
                // Filter by document type if specified
                if (docTypes && !docTypes.includes(posting.docType)) continue;
                
                // Calculate TF-IDF score
                const tfidf = posting.tfidf(
                    this.stats.totalDocuments,
                    postings.length
                );
                
                // Accumulate score
                const currentScore = docScores.get(posting.docId) || 0;
                docScores.set(posting.docId, currentScore + tfidf);
                
                // Track matched terms
                if (!docMatches.has(posting.docId)) {
                    docMatches.set(posting.docId, new Set());
                }
                docMatches.get(posting.docId).add(term);
            }
        }
        
        // Build results with metadata
        const results = [];
        for (const [docId, score] of docScores) {
            if (score < minScore) continue;
            
            const docMeta = this.documents.get(docId);
            const matchedTerms = docMatches.get(docId);
            
            // Boost score based on how many query terms matched
            const coverageBoost = matchedTerms.size / queryTerms.length;
            const finalScore = score * (1 + coverageBoost);
            
            results.push({
                docId,
                score: finalScore,
                matchedTerms: Array.from(matchedTerms),
                coverage: matchedTerms.size / queryTerms.length,
                ...docMeta
            });
        }
        
        // Sort by score descending
        results.sort((a, b) => b.score - a.score);
        
        // Limit results
        return results.slice(0, maxResults);
    }
    
    /**
     * Search for files containing query terms
     */
    searchFiles(query, options = {}) {
        return this.search(query, {
            ...options,
            docTypes: ['file', 'code']
        });
    }
    
    /**
     * Search for functions/symbols matching query
     */
    searchSymbols(query, options = {}) {
        return this.search(query, {
            ...options,
            docTypes: ['symbol', 'function']
        });
    }
    
    /**
     * Search summaries (best for concept queries)
     */
    searchSummaries(query, options = {}) {
        return this.search(query, {
            ...options,
            docTypes: ['summary']
        });
    }
    
    /**
     * Search for code related to a concept
     * Combines summary search with file search
     */
    searchConcept(concept, options = {}) {
        const { maxResults = 30 } = options;
        
        // First search summaries to understand what functions handle this concept
        const summaryResults = this.searchSummaries(concept, { maxResults: 20 });
        
        // Then search files for direct mentions
        const fileResults = this.searchFiles(concept, { maxResults: 20 });
        
        // Merge and deduplicate
        const seen = new Set();
        const merged = [];
        
        // Summaries first (better semantic match)
        for (const r of summaryResults) {
            const file = r.file || r.path;
            if (file && !seen.has(file)) {
                seen.add(file);
                merged.push({
                    ...r,
                    matchType: 'summary',
                    file
                });
            }
        }
        
        // Then files
        for (const r of fileResults) {
            const file = r.path;
            if (file && !seen.has(file)) {
                seen.add(file);
                merged.push({
                    ...r,
                    matchType: 'content',
                    file
                });
            }
        }
        
        return merged.slice(0, maxResults);
    }
    
    /**
     * Get related terms for a query (for query expansion/suggestions)
     */
    getRelatedTerms(query, maxTerms = 10) {
        const queryTerms = Array.from(extractTerms(query, { minLength: 2 }).keys());
        const related = new Map();
        
        for (const term of queryTerms) {
            // Add synonyms
            const syns = this.getSynonyms(term);
            for (const syn of syns) {
                related.set(syn, (related.get(syn) || 0) + 2);
            }
            
            // Add co-occurring terms
            const coterms = this.concepts.get(term);
            if (coterms) {
                for (const coterm of coterms) {
                    if (!queryTerms.includes(coterm)) {
                        related.set(coterm, (related.get(coterm) || 0) + 1);
                    }
                }
            }
        }
        
        // Sort by relevance
        const sorted = Array.from(related.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, maxTerms)
            .map(([term]) => term);
        
        return sorted;
    }
    
    /**
     * Suggest completions for a partial query
     */
    suggestCompletions(prefix, maxSuggestions = 10) {
        const prefixLower = prefix.toLowerCase();
        const suggestions = [];
        
        for (const term of this.index.keys()) {
            if (term.startsWith(prefixLower)) {
                const postings = this.index.get(term);
                suggestions.push({
                    term,
                    docCount: postings.length,
                    score: postings.reduce((sum, p) => sum + p.frequency, 0)
                });
            }
        }
        
        // Sort by document count (more common terms first)
        suggestions.sort((a, b) => b.docCount - a.docCount);
        
        return suggestions.slice(0, maxSuggestions);
    }
    
    /**
     * Get index statistics
     */
    getStats() {
        return {
            ...this.stats,
            memoryEstimate: this._estimateMemory()
        };
    }
    
    /**
     * Estimate memory usage
     */
    _estimateMemory() {
        let bytes = 0;
        
        // Index entries
        for (const [term, postings] of this.index) {
            bytes += term.length * 2;  // String
            bytes += postings.length * 100;  // Approximate posting size
        }
        
        // Documents
        bytes += this.documents.size * 200;  // Approximate doc metadata
        
        return {
            bytes,
            kb: Math.round(bytes / 1024),
            mb: Math.round(bytes / (1024 * 1024) * 100) / 100
        };
    }
    
    /**
     * Clear the index
     */
    clear() {
        this.index.clear();
        this.documents.clear();
        this.docTerms.clear();
        this.concepts.clear();
        
        this.stats = {
            totalDocuments: 0,
            totalTerms: 0,
            uniqueTerms: 0,
            indexedFiles: 0,
            indexedFunctions: 0,
            indexedSummaries: 0,
            lastUpdated: null
        };
    }
    
    /**
     * Export index for persistence
     */
    export() {
        return {
            version: '1.0',
            stats: this.stats,
            index: Array.from(this.index.entries()).map(([term, postings]) => [
                term,
                postings.map(p => ({
                    d: p.docId,
                    t: p.docType,
                    f: p.frequency,
                    m: p.metadata
                }))
            ]),
            documents: Array.from(this.documents.entries()),
            concepts: Array.from(this.concepts.entries()).map(([k, v]) => [k, Array.from(v)])
        };
    }
    
    /**
     * Import index from persistence
     */
    import(data) {
        if (!data || data.version !== '1.0') {
            throw new Error('Invalid index data format');
        }
        
        this.clear();
        
        this.stats = data.stats;
        
        for (const [term, postings] of data.index) {
            this.index.set(term, postings.map(p => new Posting(
                p.d, p.t, p.f, [], p.m
            )));
        }
        
        for (const [docId, meta] of data.documents) {
            this.documents.set(docId, meta);
        }
        
        for (const [term, related] of data.concepts) {
            this.concepts.set(term, new Set(related));
        }
        
        // Rebuild docTerms
        for (const [term, postings] of this.index) {
            for (const posting of postings) {
                if (!this.docTerms.has(posting.docId)) {
                    this.docTerms.set(posting.docId, new Set());
                }
                this.docTerms.get(posting.docId).add(term);
            }
        }
    }
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    InvertedIndex,
    Posting,
    extractTerms,
    extractCodeTerms,
    STOP_WORDS
};
