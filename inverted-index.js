/**
 * AstraCode Enhanced Inverted Index
 * 
 * Integrates with KeywordLearner to use dynamically learned vocabulary
 * instead of hardcoded synonym lists.
 * 
 * Key Differences from Original:
 * 1. No hardcoded STOP_WORDS - learned from codebase
 * 2. No hardcoded synonym groups - learned from co-occurrence
 * 3. Term weights based on learned importance
 * 4. Domain-aware query expansion
 */

const { KeywordLearner } = require('./keyword-learner');
const pathUtils = require('./pathUtils');

// ============================================================
// MINIMAL BOOTSTRAP STOP WORDS
// Only truly universal terms that should never be indexed
// Everything else is learned from the codebase
// ============================================================

const BOOTSTRAP_STOP_WORDS = new Set([
    // Single letters
    'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
    'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
    // Articles only (other words might be important in code)
    'the', 'an'
]);

// ============================================================
// POSTING LIST
// ============================================================

class Posting {
    constructor(docId, docType, frequency, positions = [], metadata = {}) {
        this.docId = docId;
        this.docType = docType;
        this.frequency = frequency;
        this.positions = positions;
        this.metadata = metadata;
    }
    
    tfidf(totalDocs, docsWithTerm) {
        const tf = Math.log(1 + this.frequency);
        const idf = Math.log(totalDocs / (1 + docsWithTerm));
        return tf * idf;
    }
}

// ============================================================
// ENHANCED INVERTED INDEX
// ============================================================

class EnhancedInvertedIndex {
    constructor(options = {}) {
        this.options = {
            minTermLength: 2,
            maxTermLength: 50,
            enableStemming: true,
            enableLearnedSynonyms: true,
            boostComments: 2.0,
            boostSummaries: 3.0,
            boostSymbols: 2.5,
            ...options
        };
        
        // Main index: term -> Posting[]
        this.index = new Map();
        
        // Document metadata
        this.documents = new Map();
        
        // Reverse index: docId -> Set<terms>
        this.docTerms = new Map();
        
        // Keyword learner instance
        this.keywordLearner = new KeywordLearner();
        
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
    }
    
    /**
     * Build index from codebase with vocabulary learning
     */
    async buildFromCodebase(contextFiles, codeIndex, options = {}) {
        const { log = console.log, onProgress = null, verbose = false } = options;
        const startTime = Date.now();
        
        this.clear();
        
        log('EnhancedInvertedIndex: Building with vocabulary learning...');
        
        // Phase 1: Learn vocabulary from codebase
        await this.keywordLearner.learn(contextFiles, codeIndex, {
            log: verbose ? log : () => {},
            onProgress: (pct, msg) => onProgress?.(pct * 0.5, msg)
        });
        
        if (verbose) {
            log(`Learned vocabulary: ${this.keywordLearner.vocabulary.size} terms`);
            log(`Learned synonyms: ${this.keywordLearner.synonymClusters.size} clusters`);
            log(`Learned stop words: ${this.keywordLearner.learnedStopWords.size}`);
        }
        
        // Phase 2: Build inverted index using learned vocabulary
        let fileCount = 0;
        const totalFiles = contextFiles.size;
        
        for (const [filePath, fileInfo] of contextFiles) {
            this.addDocument(
                `file:${filePath}`,
                fileInfo.content,
                'file',
                {
                    path: filePath,
                    language: fileInfo.language,
                    name: pathUtils.getFileName(filePath)
                }
            );
            
            fileCount++;
            if (onProgress && fileCount % 50 === 0) {
                onProgress(50 + (fileCount / totalFiles) * 25, 
                    `Indexing files: ${fileCount}/${totalFiles}`);
            }
        }
        
        // Index symbols
        let symbolCount = 0;
        if (codeIndex?.symbols) {
            for (const [key, symbol] of codeIndex.symbols) {
                if (!key.includes('@')) continue;
                
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
        }
        
        if (onProgress) onProgress(80, 'Indexing summaries...');
        
        // Index summaries
        let summaryCount = 0;
        if (codeIndex?.summaries) {
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
        }
        
        // Index file summaries
        if (codeIndex?.fileSummaries) {
            for (const [filePath, summary] of codeIndex.fileSummaries) {
                if (!summary) continue;
                
                this.addDocument(
                    `filesummary:${filePath}`,
                    summary,
                    'summary',
                    {
                        path: filePath,
                        name: pathUtils.getFileName(filePath)
                    }
                );
                
                summaryCount++;
            }
        }
        
        this.stats.lastUpdated = new Date();
        
        const elapsed = Date.now() - startTime;
        log(`EnhancedInvertedIndex built in ${elapsed}ms:`);
        log(`  - ${fileCount} files`);
        log(`  - ${symbolCount} symbols`);
        log(`  - ${summaryCount} summaries`);
        log(`  - ${this.index.size} unique terms`);
        
        if (onProgress) onProgress(100, 'Index complete');
        
        return this.getStats();
    }
    
    /**
     * Extract terms using learned vocabulary
     */
    extractTerms(text, options = {}) {
        const {
            minLength = this.options.minTermLength,
            maxLength = this.options.maxTermLength
        } = options;
        
        const termFreq = new Map();
        if (!text || typeof text !== 'string') return termFreq;
        
        // Tokenize
        let normalized = text
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .replace(/_/g, ' ')
            .replace(/[^a-zA-Z0-9\s]/g, ' ')
            .toLowerCase();
        
        const words = normalized.split(/\s+/);
        
        for (const word of words) {
            if (word.length < minLength || word.length > maxLength) continue;
            
            // Skip bootstrap stop words
            if (BOOTSTRAP_STOP_WORDS.has(word)) continue;
            
            // Skip learned stop words (if vocabulary is built)
            if (this.keywordLearner.isStopWord(word)) continue;
            
            // Apply simple stemming
            const stemmed = this._simpleStem(word);
            if (stemmed.length < minLength) continue;
            
            termFreq.set(stemmed, (termFreq.get(stemmed) || 0) + 1);
        }
        
        return termFreq;
    }
    
    /**
     * Simple porter-like stemming
     */
    _simpleStem(word) {
        if (word.length < 4) return word;
        
        // Handle -ing
        if (word.endsWith('ing') && word.length > 4) {
            let stem = word.slice(0, -3);
            if (stem.length > 2 && stem[stem.length - 1] === stem[stem.length - 2]) {
                return stem.slice(0, -1);
            }
            if (stem.length >= 3) return stem;
        }
        
        // Handle -ed
        if (word.endsWith('ed') && word.length > 4) {
            if (word.endsWith('ied')) return word.slice(0, -3) + 'y';
            let stem = word.slice(0, -2);
            if (stem.length > 2 && stem[stem.length - 1] === stem[stem.length - 2]) {
                return stem.slice(0, -1);
            }
            return stem.length >= 2 ? stem : word;
        }
        
        // Handle plurals
        if (word.endsWith('ies') && word.length > 4) return word.slice(0, -3) + 'y';
        if (word.endsWith('es') && word.length > 4) {
            if (/[xsz]es$/.test(word) || /[sc]hes$/.test(word)) {
                return word.slice(0, -2);
            }
        }
        if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) {
            return word.slice(0, -1);
        }
        
        return word;
    }
    
    /**
     * Add a document to the index
     */
    addDocument(docId, content, docType, metadata = {}) {
        const termFreq = this.extractTerms(content);
        
        // Apply boost based on document type
        let boost = 1.0;
        if (docType === 'summary') boost = this.options.boostSummaries;
        else if (docType === 'symbol') boost = this.options.boostSymbols;
        else if (docType === 'comment') boost = this.options.boostComments;
        
        // Apply learned term weights
        for (const [term, freq] of termFreq) {
            const learnedWeight = this.keywordLearner.getTermWeight(term);
            if (learnedWeight > 0) {
                // Boost by learned importance (normalized)
                termFreq.set(term, freq * (1 + Math.log(1 + learnedWeight) * 0.1));
            }
        }
        
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
     * Expand query using learned synonyms
     */
    expandQuery(query) {
        const baseTerms = Array.from(this.extractTerms(query).keys());
        
        if (!this.options.enableLearnedSynonyms) {
            return baseTerms;
        }
        
        // Use keyword learner for expansion
        return this.keywordLearner.expandQuery(query);
    }
    
    /**
     * Get learned synonyms for a term
     */
    getSynonyms(term) {
        return this.keywordLearner.getSynonyms(term);
    }
    
    /**
     * Search the index
     */
    search(query, options = {}) {
        const {
            maxResults = 50,
            minScore = 0.1,
            docTypes = null,
            expandSynonyms = true,
            useLearnedWeights = true
        } = options;
        
        // Extract and expand query terms
        const queryTerms = expandSynonyms 
            ? this.expandQuery(query)
            : Array.from(this.extractTerms(query).keys());
        
        if (queryTerms.length === 0) {
            return [];
        }
        
        // Collect matching documents with scores
        const docScores = new Map();
        const docMatches = new Map();
        
        for (const term of queryTerms) {
            const postings = this.index.get(term);
            if (!postings) continue;
            
            // Get learned weight for this term
            const termWeight = useLearnedWeights 
                ? (this.keywordLearner.getTermWeight(term) || 1.0)
                : 1.0;
            
            for (const posting of postings) {
                if (docTypes && !docTypes.includes(posting.docType)) continue;
                
                // Calculate TF-IDF score with learned weight
                let tfidf = posting.tfidf(
                    this.stats.totalDocuments,
                    postings.length
                );
                
                // Apply learned term weight
                tfidf *= (1 + Math.log(1 + termWeight) * 0.1);
                
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
            
            // Boost score based on term coverage
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
        
        results.sort((a, b) => b.score - a.score);
        return results.slice(0, maxResults);
    }
    
    /**
     * Search files only
     */
    searchFiles(query, options = {}) {
        return this.search(query, { ...options, docTypes: ['file', 'code'] });
    }
    
    /**
     * Search symbols only
     */
    searchSymbols(query, options = {}) {
        return this.search(query, { ...options, docTypes: ['symbol', 'function'] });
    }
    
    /**
     * Search summaries only
     */
    searchSummaries(query, options = {}) {
        return this.search(query, { ...options, docTypes: ['summary'] });
    }
    
    /**
     * Get related terms (autocomplete)
     */
    suggestCompletions(prefix, maxSuggestions = 10) {
        // Combine index terms with learned vocabulary
        const suggestions = [];
        const prefixLower = prefix.toLowerCase();
        
        // From learned vocabulary (weighted by importance)
        const learned = this.keywordLearner.getRelatedTerms(prefixLower, maxSuggestions);
        for (const item of learned) {
            suggestions.push({
                term: item.term,
                score: item.weight,
                source: 'learned'
            });
        }
        
        // From index (by document count)
        for (const term of this.index.keys()) {
            if (term.startsWith(prefixLower) && !suggestions.find(s => s.term === term)) {
                const postings = this.index.get(term);
                suggestions.push({
                    term,
                    score: postings.length,
                    source: 'index'
                });
            }
        }
        
        suggestions.sort((a, b) => b.score - a.score);
        return suggestions.slice(0, maxSuggestions);
    }
    
    /**
     * Get statistics
     */
    getStats() {
        return {
            ...this.stats,
            learnedVocabularySize: this.keywordLearner.vocabulary.size,
            learnedSynonymClusters: this.keywordLearner.synonymClusters.size,
            learnedStopWords: this.keywordLearner.learnedStopWords.size,
            domainConcepts: this.keywordLearner.domainConcepts.size
        };
    }
    
    /**
     * Get domain concepts (for debugging/analysis)
     */
    getDomainConcepts() {
        return this.keywordLearner.getDomainConcepts();
    }
    
    /**
     * Get top terms (for debugging/analysis)
     */
    getTopTerms(n = 50) {
        return this.keywordLearner.getTopTerms(n);
    }
    
    /**
     * Clear the index
     */
    clear() {
        this.index.clear();
        this.documents.clear();
        this.docTerms.clear();
        this.keywordLearner.clear();
        
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
     * Export for persistence
     */
    export() {
        return {
            version: '2.0',
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
            learnedVocabulary: this.keywordLearner.export()
        };
    }
    
    /**
     * Import from persistence
     */
    import(data) {
        if (!data || !data.version) {
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
        
        // Import learned vocabulary
        if (data.learnedVocabulary) {
            this.keywordLearner.import(data.learnedVocabulary);
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
    InvertedIndex: EnhancedInvertedIndex,  // Backward compatible alias
    EnhancedInvertedIndex,
    Posting,
    BOOTSTRAP_STOP_WORDS
};
