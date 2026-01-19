/**
 * AstraCode Query Classifier v5.1
 * 
 * Classifies user queries into specific types and provides tailored search strategies.
 * Discovers domain knowledge dynamically from the codebase rather than hardcoding.
 * 
 * Query Types:
 * 1. CONCEPT     - "How does X work?" "Explain Y"
 * 2. CALL_GRAPH  - "Who calls X?" "What does X call?"
 * 3. FILES_TRACE - "Show files related to X" "Find code for Y"
 * 4. STRUCTURE   - "What fields in X?" "Show structure Y"
 * 5. FLOW        - "How does X flow to Y?" "What happens during Z"
 * 6. IMPLEMENTATION - "How is X implemented?" "Find the Y logic"
 * 7. CROSS_MODULE - "What connects X to Y?" "How does X get to Y"
 * 
 * Usage:
 *   const { QueryClassifier, QueryTypes } = require('./query-classifier');
 *   const classifier = new QueryClassifier({ log: console.log });
 *   classifier.learnFromCodebase(contextFiles, codeIndex);
 *   const result = classifier.classify("show me files related to btree");
 */

// ============================================================
// QUERY TYPES
// ============================================================

const QueryTypes = {
    CONCEPT: 'concept',
    CALL_GRAPH: 'call_graph',
    FILES_TRACE: 'files_trace',
    STRUCTURE: 'structure',
    FLOW: 'flow',
    IMPLEMENTATION: 'implementation',
    CROSS_MODULE: 'cross_module',
    GENERAL: 'general',
    OVERVIEW: 'overview'
};

// ============================================================
// SEARCH STRATEGIES
// ============================================================


const SearchStrategies = {
    [QueryTypes.CONCEPT]: {
        primary: 'summary_search',           // summaries first (high signal)
        secondary: 'inverted_keyword',       // ← stronger weight now
        tertiary: 'related_functions',
        expandTerms: true,
        useModuleMapping: true,
        useInvertedIndex: true,              // NEW flag
        resultFormat: 'explanation'
    },
    [QueryTypes.IMPLEMENTATION]: {
        primary: 'algorithm_search',
        secondary: 'code_extraction',
        tertiary: 'inverted_keyword',        // NEW: concept search helps find logic
        expandTerms: true,
        useModuleMapping: true,
        useInvertedIndex: true,
        resultFormat: 'implementation_detail'
    },
    [QueryTypes.FLOW]: {
        primary: 'multi_function_trace',
        secondary: 'call_path_finding',
        tertiary: 'inverted_keyword',        // helps find control-flow comments/terms
        expandTerms: true,
        useModuleMapping: true,
        useInvertedIndex: true,
        resultFormat: 'flow_diagram'
    },
    [QueryTypes.CALL_GRAPH]: {
        primary: 'call_graph_lookup',
        secondary: 'symbol_resolve',
        tertiary: 'trace_expansion',
        expandTerms: false,
        useModuleMapping: false,
        resultFormat: 'call_tree'
    },
    [QueryTypes.FILES_TRACE]: {
        primary: 'module_search',
        secondary: 'directory_index',
        tertiary: 'summary_search',
        expandTerms: true,
        useModuleMapping: true,
        resultFormat: 'file_list'
    },
    [QueryTypes.STRUCTURE]: {
        primary: 'symbol_lookup',
        secondary: 'struct_extraction',
        tertiary: 'type_references',
        expandTerms: false,
        useModuleMapping: false,
        resultFormat: 'structure_def'
    },
    [QueryTypes.CROSS_MODULE]: {
        primary: 'interface_search',
        secondary: 'call_path_finding',
        tertiary: 'boundary_detection',
        expandTerms: false,
        useModuleMapping: true,
        resultFormat: 'connection_map'
    },
    [QueryTypes.GENERAL]: {
        primary: 'full_text_search',
        secondary: 'summary_search',
        tertiary: null,
        expandTerms: true,
        useModuleMapping: false,
        resultFormat: 'general'
    },
    [QueryTypes.OVERVIEW]: {
        primary: 'codebase_summary',
        secondary: 'module_overview',
        tertiary: null,
        expandTerms: false,
        useModuleMapping: false,
        resultFormat: 'overview'
    }
};

/*

const SearchStrategies = {
    [QueryTypes.CONCEPT]: {
        primary: 'summary_search',
        secondary: 'inverted_keyword',
        tertiary: 'related_functions',
        expandTerms: true,
        useModuleMapping: true,
        resultFormat: 'explanation'
    },
    [QueryTypes.CALL_GRAPH]: {
        primary: 'call_graph_lookup',
        secondary: 'symbol_resolve',
        tertiary: 'trace_expansion',
        expandTerms: false,
        useModuleMapping: false,
        resultFormat: 'call_tree'
    },
    [QueryTypes.FILES_TRACE]: {
        primary: 'module_search',
        secondary: 'directory_index',
        tertiary: 'summary_search',
        expandTerms: true,
        useModuleMapping: true,
        resultFormat: 'file_list'
    },
    [QueryTypes.STRUCTURE]: {
        primary: 'symbol_lookup',
        secondary: 'struct_extraction',
        tertiary: 'type_references',
        expandTerms: false,
        useModuleMapping: false,
        resultFormat: 'structure_def'
    },
    [QueryTypes.FLOW]: {
        primary: 'multi_function_trace',
        secondary: 'call_path_finding',
        tertiary: 'stage_detection',
        expandTerms: true,
        useModuleMapping: true,
        resultFormat: 'flow_diagram'
    },
    [QueryTypes.IMPLEMENTATION]: {
        primary: 'algorithm_search',
        secondary: 'code_extraction',
        tertiary: 'detail_synthesis',
        expandTerms: true,
        useModuleMapping: true,
        resultFormat: 'implementation_detail'
    },
    [QueryTypes.CROSS_MODULE]: {
        primary: 'interface_search',
        secondary: 'call_path_finding',
        tertiary: 'boundary_detection',
        expandTerms: false,
        useModuleMapping: true,
        resultFormat: 'connection_map'
    },
    [QueryTypes.GENERAL]: {
        primary: 'full_text_search',
        secondary: 'summary_search',
        tertiary: null,
        expandTerms: true,
        useModuleMapping: false,
        resultFormat: 'general'
    },
    [QueryTypes.OVERVIEW]: {
        primary: 'codebase_summary',
        secondary: 'module_overview',
        tertiary: null,
        expandTerms: false,
        useModuleMapping: false,
        resultFormat: 'overview'
    }
};

*/

// ============================================================
// CLASSIFICATION PATTERNS
// ============================================================

const ClassificationPatterns = {
    [QueryTypes.CALL_GRAPH]: [
        { regex: /\bwhat\s+(?:functions?\s+)?calls?\s+(\w+)/i, weight: 1.0, entityGroup: 1 },
        { regex: /\bwho\s+calls?\s+(\w+)/i, weight: 1.0, entityGroup: 1 },
        { regex: /\bwhat\s+does\s+(\w+)\s*\(\)?\s*call/i, weight: 1.0, entityGroup: 1 },
        { regex: /\btrace\s+(?:the\s+)?(?:execution|calls?|path)\s+(?:of\s+)?(\w+)?/i, weight: 0.9, entityGroup: 1 },
        { regex: /\bcallers?\s+of\s+(\w+)/i, weight: 1.0, entityGroup: 1 },
        { regex: /\bcallees?\s+of\s+(\w+)/i, weight: 1.0, entityGroup: 1 },
        { regex: /\bcall\s*graph\s+(?:for\s+)?(\w+)?/i, weight: 0.9, entityGroup: 1 },
        { regex: /\bwhere\s+is\s+(\w+)\s+called/i, weight: 0.9, entityGroup: 1 },
    ],
    
    [QueryTypes.FILES_TRACE]: [
        { regex: /\bshow\s+(?:me\s+)?(?:the\s+)?files?\s+(?:related\s+to|for|about|in)\s+(.+)/i, weight: 1.0, entityGroup: 1 },
        { regex: /\bfind\s+(?:the\s+)?(?:code|files?)\s+(?:related\s+to|for|about)\s+(.+)/i, weight: 1.0, entityGroup: 1 },
        { regex: /\bwhat'?s?\s+(?:is\s+)?in\s+(?:the\s+)?(\w+)\s+(?:module|directory|folder|dir)/i, weight: 1.0, entityGroup: 1 },
        { regex: /\b(?:list|show)\s+(?:the\s+)?(\w+)\s+files?/i, weight: 0.9, entityGroup: 1 },
        { regex: /\bfiles?\s+(?:related\s+to|for|about|containing)\s+(.+)/i, weight: 0.9, entityGroup: 1 },
        { regex: /\bwhere\s+is\s+(?:the\s+)?(.+?)\s+(?:code|implementation|module)/i, weight: 0.8, entityGroup: 1 },
        { regex: /\bfind\s+(.+?)\s+(?:source|implementation|code)\s*$/i, weight: 0.8, entityGroup: 1 },
    ],
    
    [QueryTypes.STRUCTURE]: [
        { regex: /\bwhat\s+(?:fields?|members?)\s+(?:are\s+)?in\s+(\w+)/i, weight: 1.0, entityGroup: 1 },
        { regex: /\bshow\s+(?:me\s+)?(?:the\s+)?(\w+)\s+struct(?:ure)?/i, weight: 1.0, entityGroup: 1 },
        { regex: /\bexplain\s+(?:the\s+)?(\w+)\s+struct(?:ure)?/i, weight: 1.0, entityGroup: 1 },
        { regex: /\bwhat\s+is\s+(?:a\s+)?(\w+)\s*\??$/i, weight: 0.6, entityGroup: 1 },
        { regex: /\bdefin(?:e|ition)\s+(?:of\s+)?(\w+)/i, weight: 0.8, entityGroup: 1 },
        { regex: /\bwhich\s+tables?\s+(?:are\s+)?(?:accessed|used)/i, weight: 0.8, entityGroup: 0 },
        { regex: /\b(\w+)\s+(?:struct|structure|type|class)\s+(?:fields?|members?|definition)/i, weight: 0.9, entityGroup: 1 },
        { regex: /\bdescribe\s+(?:the\s+)?(\w+)\s+(?:data\s+)?structure/i, weight: 0.9, entityGroup: 1 },
    ],
    
    [QueryTypes.FLOW]: [
        { regex: /\bhow\s+does\s+.+\s+(?:go|flow|get)\s+(?:from|to)/i, weight: 1.0, entityGroup: 0 },
        { regex: /\bwhat\s+happens\s+(?:during|when|in)\s+(.+)/i, weight: 0.9, entityGroup: 1 },
        { regex: /\bexplain\s+(?:the\s+)?(.+?)\s+flow/i, weight: 0.9, entityGroup: 1 },
        { regex: /\bhow\s+(?:are|is)\s+(.+?)\s+(?:acquired|released|managed|handled)/i, weight: 0.8, entityGroup: 1 },
        { regex: /\b(?:execution|processing)\s+(?:flow|path|pipeline)/i, weight: 0.8, entityGroup: 0 },
        { regex: /\bwalk\s+(?:me\s+)?through\s+(?:the\s+)?(.+)/i, weight: 0.8, entityGroup: 1 },
        { regex: /\bstep\s*(?:s|by\s*step)?\s+(?:of|for|in)\s+(.+)/i, weight: 0.7, entityGroup: 1 },
        { regex: /\blife\s*cycle\s+(?:of\s+)?(.+)/i, weight: 0.8, entityGroup: 1 },
    ],
    
    [QueryTypes.IMPLEMENTATION]: [
        { regex: /\bhow\s+is\s+(.+?)\s+implemented/i, weight: 1.0, entityGroup: 1 },
        { regex: /\bfind\s+(?:the\s+)?(.+?)\s+logic/i, weight: 0.9, entityGroup: 1 },
        { regex: /\bwhere\s+is\s+(.+?)\s+(?:done|performed|handled|implemented)/i, weight: 0.9, entityGroup: 1 },
        { regex: /\bexplain\s+(?:the\s+)?details?\s+(?:of\s+)?(?:how\s+)?(.+)/i, weight: 0.7, entityGroup: 1 },
        { regex: /\bimplementation\s+(?:of|details?\s+(?:of|for)?)\s+(.+)/i, weight: 1.0, entityGroup: 1 },
        { regex: /\bhow\s+does\s+(.+?)\s+(?:algorithm|work)\s+internally/i, weight: 0.9, entityGroup: 1 },
        { regex: /\bdetailed?\s+(?:explanation|analysis)\s+(?:of\s+)?(.+)/i, weight: 0.8, entityGroup: 1 },
    ],
    
    [QueryTypes.CROSS_MODULE]: [
        { regex: /\bwhat\s+connects?\s+(?:the\s+)?(\w+)\s+(?:to|and|with)\s+(?:the\s+)?(\w+)/i, weight: 1.0, entityGroup: [1, 2] },
        { regex: /\bhow\s+does\s+(?:the\s+)?(\w+)\s+(?:get|receive|obtain)\s+(?:its?\s+)?(\w+)?/i, weight: 0.9, entityGroup: [1, 2] },
        { regex: /\bwhat\s+links?\s+(?:the\s+)?(\w+)\s+(?:to|and|with)\s+(?:the\s+)?(\w+)/i, weight: 1.0, entityGroup: [1, 2] },
        { regex: /\binterface\s+between\s+(\w+)\s+(?:and|to)\s+(\w+)/i, weight: 1.0, entityGroup: [1, 2] },
        { regex: /\bhow\s+(?:does|do)\s+(\w+)\s+(?:and|to)\s+(\w+)\s+(?:interact|communicate|connect)/i, weight: 0.9, entityGroup: [1, 2] },
        { regex: /\brelationship\s+between\s+(\w+)\s+(?:and|to)\s+(\w+)/i, weight: 0.8, entityGroup: [1, 2] },
    ],
    
    [QueryTypes.CONCEPT]: [
        { regex: /\bhow\s+(?:does|is)\s+(.+?)\s+(?:work|performed|done|handled)\??/i, weight: 0.8, entityGroup: 1 },
        { regex: /\bexplain\s+(?:the\s+)?(\w+)(?:\s+(?:system|module|subsystem))?\s*$/i, weight: 0.7, entityGroup: 1 },
        { regex: /\bwhat\s+(?:handles?|manages?|does)\s+(.+)/i, weight: 0.7, entityGroup: 1 },
        { regex: /\bhow\s+(?:are|is)\s+(.+?)\s+(?:built|created|generated|processed)/i, weight: 0.8, entityGroup: 1 },
        { regex: /\bdescribe\s+(?:the\s+)?(.+?)(?:\s+(?:mechanism|process|system))?\s*$/i, weight: 0.7, entityGroup: 1 },
        { regex: /\bunderstand\s+(?:the\s+)?(.+)/i, weight: 0.6, entityGroup: 1 },
    ],
    
    [QueryTypes.OVERVIEW]: [
        { regex: /\b(?:explain|describe|summarize|overview|analyze)\s+(?:the\s+)?(?:code|codebase|project|files?|attached)/i, weight: 1.0, entityGroup: 0 },
        { regex: /\bwhat\s+(?:does|is)\s+(?:this|the)\s+(?:code|codebase|project)/i, weight: 1.0, entityGroup: 0 },
        { regex: /\bgive\s+(?:me\s+)?(?:an?\s+)?overview/i, weight: 1.0, entityGroup: 0 },
        { regex: /\bhigh[\s-]?level\s+(?:summary|overview|description)/i, weight: 1.0, entityGroup: 0 },
        { regex: /\bsummarize\s+(?:the\s+)?(?:attached|uploaded|these)\s+files?/i, weight: 1.0, entityGroup: 0 },
    ]
};

// ============================================================
// INTENT PATTERNS
// ============================================================

const IntentPatterns = {
    LIST: [/\b(?:list|show|find|get|display)\b/i],
    EXPLAIN: [/\b(?:explain|describe|tell\s+me\s+about|what\s+is)\b/i],
    TRACE: [/\b(?:trace|follow|track|walk\s+through)\b/i],
    COMPARE: [/\b(?:compare|difference|vs|versus)\b/i],
    FIND: [/\b(?:find|locate|where|search)\b/i],
    COUNT: [/\b(?:how\s+many|count|number\s+of)\b/i],
};

// ============================================================
// QUERY CLASSIFICATION RESULT
// ============================================================

class QueryClassification {
    constructor() {
        this.type = QueryTypes.GENERAL;
        this.confidence = 0;
        this.entities = [];
        this.intent = null;
        this.strategy = null;
        this.expandedTerms = [];
        this.moduleHints = [];
        this.matchedPattern = null;
    }
    
    toJSON() {
        return {
            type: this.type,
            confidence: this.confidence,
            entities: this.entities,
            intent: this.intent,
            expandedTerms: this.expandedTerms,
            moduleHints: this.moduleHints
        };
    }
}

// ============================================================
// DOMAIN KNOWLEDGE (Discovered from codebase)
// ============================================================

class DomainKnowledge {
    constructor() {
        this.directoryModules = new Map();
        this.fileNamePrefixes = new Map();
        this.termClusters = new Map();
        this.moduleTerms = new Map();
        this.prefixToModule = new Map();
        this.stats = {
            directoriesIndexed: 0,
            prefixesFound: 0,
            termClustersBuilt: 0,
            lastUpdated: null
        };
    }
    
    clear() {
        this.directoryModules.clear();
        this.fileNamePrefixes.clear();
        this.termClusters.clear();
        this.moduleTerms.clear();
        this.prefixToModule.clear();
        this.stats = {
            directoriesIndexed: 0,
            prefixesFound: 0,
            termClustersBuilt: 0,
            lastUpdated: null
        };
    }
}

// ============================================================
// QUERY CLASSIFIER
// ============================================================

class QueryClassifier {
    constructor(options = {}) {
        this.options = {
            minConfidence: 0.5,
            enableTermExpansion: true,
            maxExpandedTerms: 10,
            log: options.log || console.log,
            ...options
        };
        
        this.log = this.options.log;
        this.domain = new DomainKnowledge();
        this.termToModules = new Map();
        this.isLearned = false;
    }
    
    /**
     * Learn domain knowledge from the codebase
     */
    learnFromCodebase(contextFiles, codeIndex, options = {}) {
        const startTime = Date.now();
        this.domain.clear();
        this.termToModules.clear();
        
        this.log('[QueryClassifier] Learning domain knowledge from codebase...');
        
        this._learnDirectoryStructure(contextFiles);
        this._learnFileNamePatterns(contextFiles);
        
        if (codeIndex?.summaries?.size > 0 || codeIndex?.fileSummaries?.size > 0) {
            this._learnFromSummaries(codeIndex);
        }
        
        this._buildTermClusters(contextFiles, codeIndex);
        this._buildReverseTermMappings();
        
        this.domain.stats.lastUpdated = new Date();
        this.isLearned = true;
        
        const duration = Date.now() - startTime;
        this.log(`[QueryClassifier] Learning complete in ${duration}ms:`, {
            directories: this.domain.directoryModules.size,
            prefixes: this.domain.fileNamePrefixes.size,
            termClusters: this.domain.termClusters.size
        });
        
        return this.domain.stats;
    }
    
    _learnDirectoryStructure(contextFiles) {
        const dirFiles = new Map();
        
        for (const [filePath] of contextFiles) {
            const parts = filePath.split('/').filter(p => p.length > 0);
            if (parts.length < 2) continue;
            
            const fileName = parts[parts.length - 1];
            const dirName = parts[parts.length - 2];
            const parentDir = parts.length > 2 ? parts[parts.length - 3] : null;
            
            if (!dirFiles.has(dirName)) {
                dirFiles.set(dirName, {
                    files: [],
                    parentDir: parentDir,
                    fullPath: parts.slice(0, -1).join('/')
                });
            }
            dirFiles.get(dirName).files.push(fileName);
        }
        
        for (const [dirName, info] of dirFiles) {
            if (info.files.length >= 2 && dirName.length >= 3) {
                this.domain.directoryModules.set(dirName.toLowerCase(), info);
            }
        }
        
        this.domain.stats.directoriesIndexed = this.domain.directoryModules.size;
    }
    
    _learnFileNamePatterns(contextFiles) {
        const prefixGroups = new Map();
        
        for (const [filePath] of contextFiles) {
            const fileName = filePath.split('/').pop();
            const baseName = fileName.replace(/\.[^.]+$/, '').toLowerCase();
            
            for (let len = 2; len <= Math.min(6, baseName.length - 1); len++) {
                const prefix = baseName.substring(0, len);
                if (!prefixGroups.has(prefix)) {
                    prefixGroups.set(prefix, new Set());
                }
                prefixGroups.get(prefix).add(fileName);
            }
        }
        
        for (const [prefix, files] of prefixGroups) {
            if (files.size >= 3) {
                this.domain.fileNamePrefixes.set(prefix, Array.from(files));
                
                // Map prefix to directory
                for (const [dirName] of this.domain.directoryModules) {
                    if (dirName.startsWith(prefix) || prefix.startsWith(dirName.substring(0, Math.min(prefix.length, dirName.length)))) {
                        this.domain.prefixToModule.set(prefix, dirName);
                        break;
                    }
                }
            }
        }
        
        // IMPORTANT: Also learn directory-to-concept mappings
        // e.g., "nbtree" directory -> concept "btree"
        // This handles cases where directory name is prefixed version of concept
        for (const [dirName, info] of this.domain.directoryModules) {
            // Extract potential concept names from directory name
            // e.g., "nbtree" -> "btree", "nodeHashjoin" -> "hashjoin"
            const concepts = this._extractConceptsFromName(dirName);
            for (const concept of concepts) {
                if (concept !== dirName && concept.length >= 3) {
                    // Map concept -> directory
                    if (!this.domain.prefixToModule.has(concept)) {
                        this.domain.prefixToModule.set(concept, dirName);
                    }
                }
            }
        }
        
        this.domain.stats.prefixesFound = this.domain.fileNamePrefixes.size;
    }
    
    /**
     * Extract potential concept names from a directory/file name
     * e.g., "nbtree" -> ["btree", "tree"]
     *       "nodeHashjoin" -> ["hashjoin", "hash", "join"]
     */
    _extractConceptsFromName(name) {
        const concepts = new Set();
        const nameLower = name.toLowerCase();
        
        // Common prefixes to strip
        const stripPrefixes = ['n', 'nb', 'node', 'exec', 'pg_'];
        
        for (const prefix of stripPrefixes) {
            if (nameLower.startsWith(prefix) && nameLower.length > prefix.length + 2) {
                concepts.add(nameLower.substring(prefix.length));
            }
        }
        
        // Also split on camelCase and underscores
        const parts = nameLower
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .replace(/[-_]/g, ' ')
            .split(/\s+/)
            .filter(p => p.length >= 3);
        
        for (const part of parts) {
            concepts.add(part);
        }
        
        // Add combined parts (e.g., "hash" + "join" -> "hashjoin")
        if (parts.length >= 2) {
            concepts.add(parts.join(''));
        }
        
        return concepts;
    }
    
    _learnFromSummaries(codeIndex) {
        const dirTerms = new Map();
        
        if (codeIndex.summaries) {
            for (const [key, summaryInfo] of codeIndex.summaries) {
                const summary = typeof summaryInfo === 'string' ? summaryInfo : summaryInfo.summary;
                if (!summary) continue;
                
                const filePath = typeof summaryInfo === 'object' ? summaryInfo.file : key.split('@')[1];
                if (!filePath) continue;
                
                const parts = filePath.split('/');
                const dirName = parts.length > 1 ? parts[parts.length - 2].toLowerCase() : null;
                
                if (dirName) {
                    if (!dirTerms.has(dirName)) {
                        dirTerms.set(dirName, new Map());
                    }
                    
                    const terms = this._extractTermsFromText(summary);
                    for (const term of terms) {
                        const termMap = dirTerms.get(dirName);
                        termMap.set(term, (termMap.get(term) || 0) + 1);
                    }
                }
            }
        }
        
        if (codeIndex.fileSummaries) {
            for (const [filePath, summary] of codeIndex.fileSummaries) {
                if (!summary) continue;
                
                const parts = filePath.split('/');
                const dirName = parts.length > 1 ? parts[parts.length - 2].toLowerCase() : null;
                
                if (dirName) {
                    if (!dirTerms.has(dirName)) {
                        dirTerms.set(dirName, new Map());
                    }
                    
                    const terms = this._extractTermsFromText(summary);
                    for (const term of terms) {
                        const termMap = dirTerms.get(dirName);
                        termMap.set(term, (termMap.get(term) || 0) + 1);
                    }
                }
            }
        }
        
        for (const [dirName, termFreq] of dirTerms) {
            const significantTerms = new Set();
            for (const [term, freq] of termFreq) {
                if (freq >= 2) {
                    significantTerms.add(term);
                }
            }
            if (significantTerms.size > 0) {
                this.domain.moduleTerms.set(dirName, significantTerms);
            }
        }
    }
    
    _buildTermClusters(contextFiles, codeIndex) {
        for (const [dirName, info] of this.domain.directoryModules) {
            const cluster = new Set();
            
            cluster.add(dirName);
            
            if (info.parentDir) {
                cluster.add(info.parentDir.toLowerCase());
            }
            
            for (const [prefix, module] of this.domain.prefixToModule) {
                if (module === dirName) {
                    cluster.add(prefix);
                }
            }
            
            const moduleTerms = this.domain.moduleTerms.get(dirName);
            if (moduleTerms) {
                for (const term of moduleTerms) {
                    cluster.add(term);
                }
            }
            
            if (cluster.size > 1) {
                this.domain.termClusters.set(dirName, cluster);
            }
        }
        
        this.domain.stats.termClustersBuilt = this.domain.termClusters.size;
    }
    
    _buildReverseTermMappings() {
        this.termToModules.clear();
        
        for (const [module, terms] of this.domain.termClusters) {
            for (const term of terms) {
                if (!this.termToModules.has(term)) {
                    this.termToModules.set(term, new Set());
                }
                this.termToModules.get(term).add(module);
            }
        }
    }
    
    _extractTermsFromText(text) {
        const stopWords = new Set([
            'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
            'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
            'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
            'this', 'that', 'these', 'those', 'it', 'its', 'which', 'what',
            'function', 'method', 'returns', 'return', 'file', 'code', 'data',
            'value', 'values', 'parameter', 'parameters', 'argument', 'arguments'
        ]);
        
        const terms = new Set();
        
        const words = text.toLowerCase()
            .replace(/[^a-z0-9\s-]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length >= 3 && !stopWords.has(w));
        
        for (const word of words) {
            terms.add(word);
            
            const parts = word.replace(/([a-z])([A-Z])/g, '$1 $2')
                .replace(/[-_]/g, ' ')
                .split(/\s+/)
                .filter(p => p.length >= 3);
            
            for (const part of parts) {
                if (!stopWords.has(part)) {
                    terms.add(part);
                }
            }
        }
        
        return terms;
    }
    
    /**
     * Classify a user query
     */
    classify(query) {
        const result = new QueryClassification();
        const queryLower = query.toLowerCase().trim();
        
        let bestMatch = null;
        let bestWeight = 0;
        
        for (const [type, patterns] of Object.entries(ClassificationPatterns)) {
            for (const pattern of patterns) {
                const match = queryLower.match(pattern.regex);
                if (match && pattern.weight > bestWeight) {
                    bestWeight = pattern.weight;
                    bestMatch = {
                        type,
                        pattern,
                        match,
                        entities: this._extractEntities(match, pattern.entityGroup)
                    };
                }
            }
        }
        
        if (bestMatch && bestWeight >= this.options.minConfidence) {
            result.type = bestMatch.type;
            result.confidence = bestWeight;
            result.entities = bestMatch.entities;
            result.matchedPattern = bestMatch.pattern.regex.toString();
        } else {
            result.type = QueryTypes.GENERAL;
            result.confidence = 0.3;
            result.entities = this._extractKeywords(query);
        }
        
        result.intent = this._detectIntent(queryLower);
        result.strategy = SearchStrategies[result.type];
        
        if (result.strategy.expandTerms && this.isLearned) {
            const expansion = this.expandTerms(result.entities);
            result.expandedTerms = expansion.terms;
            result.moduleHints = expansion.modules;
        }
        
        return result;
    }
    
    _extractEntities(match, entityGroup) {
        const entities = [];
        
        if (!entityGroup || entityGroup === 0) {
            return this._extractKeywords(match[0]);
        }
        
        if (Array.isArray(entityGroup)) {
            for (const group of entityGroup) {
                if (match[group]) {
                    entities.push(match[group].trim().toLowerCase());
                }
            }
        } else {
            if (match[entityGroup]) {
                const entity = match[entityGroup].trim().toLowerCase();
                entities.push(...entity.split(/\s+/).filter(e => e.length > 0));
            }
        }
        
        return entities;
    }
    
    _extractKeywords(text) {
        const stopWords = new Set([
            'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
            'of', 'with', 'by', 'from', 'as', 'is', 'are', 'was', 'what', 'where',
            'when', 'how', 'why', 'show', 'find', 'search', 'get', 'list', 'me',
            'my', 'all', 'code', 'function', 'file', 'files', 'related', 'about'
        ]);
        
        return text.toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length >= 2 && !stopWords.has(w));
    }
    
    _detectIntent(query) {
        for (const [intent, patterns] of Object.entries(IntentPatterns)) {
            for (const pattern of patterns) {
                if (pattern.test(query)) {
                    return intent;
                }
            }
        }
        return 'UNKNOWN';
    }
    
    /**
     * Expand query terms using learned domain knowledge
     */
    expandTerms(terms) {
        const expanded = new Set(terms);
        const modules = new Set();
        
        for (const term of terms) {
            const termLower = term.toLowerCase();
            
            if (this.termToModules.has(termLower)) {
                for (const module of this.termToModules.get(termLower)) {
                    modules.add(module);
                    
                    const cluster = this.domain.termClusters.get(module);
                    if (cluster) {
                        for (const related of cluster) {
                            expanded.add(related);
                        }
                    }
                }
            }
            
            if (this.domain.directoryModules.has(termLower)) {
                modules.add(termLower);
            }
            
            if (this.domain.prefixToModule.has(termLower)) {
                const module = this.domain.prefixToModule.get(termLower);
                modules.add(module);
                expanded.add(module);
            }
            
            for (const [prefix, files] of this.domain.fileNamePrefixes) {
                if (prefix.includes(termLower) || termLower.includes(prefix)) {
                    expanded.add(prefix);
                    if (this.domain.prefixToModule.has(prefix)) {
                        modules.add(this.domain.prefixToModule.get(prefix));
                    }
                }
            }
        }
        
        const termArray = Array.from(expanded).slice(0, this.options.maxExpandedTerms);
        const moduleArray = Array.from(modules);
        
        return {
            terms: termArray,
            modules: moduleArray
        };
    }
    
    /**
     * Get files related to a concept/module
     */
    getRelatedFiles(concept, contextFiles) {
        const conceptLower = concept.toLowerCase();
        const relatedFiles = [];
        
        if (this.domain.directoryModules.has(conceptLower)) {
            for (const [filePath] of contextFiles) {
                if (filePath.toLowerCase().includes(`/${conceptLower}/`)) {
                    relatedFiles.push({ path: filePath, score: 2.0, reason: 'directory_match' });
                }
            }
        }
        
        for (const [prefix, files] of this.domain.fileNamePrefixes) {
            if (prefix.includes(conceptLower) || conceptLower.includes(prefix)) {
                for (const [filePath] of contextFiles) {
                    const fileName = filePath.split('/').pop().toLowerCase();
                    if (files.map(f => f.toLowerCase()).includes(fileName)) {
                        relatedFiles.push({ path: filePath, score: 1.5, reason: 'prefix_match' });
                    }
                }
            }
        }
        
        if (this.termToModules.has(conceptLower)) {
            for (const module of this.termToModules.get(conceptLower)) {
                for (const [filePath] of contextFiles) {
                    if (filePath.toLowerCase().includes(`/${module}/`)) {
                        if (!relatedFiles.find(r => r.path === filePath)) {
                            relatedFiles.push({ path: filePath, score: 1.2, reason: 'term_cluster' });
                        }
                    }
                }
            }
        }
        
        relatedFiles.sort((a, b) => b.score - a.score);
        
        return relatedFiles;
    }
    
    /**
     * Get domain knowledge statistics
     */
    getStats() {
        return {
            isLearned: this.isLearned,
            ...this.domain.stats,
            directoryModules: this.domain.directoryModules.size,
            fileNamePrefixes: this.domain.fileNamePrefixes.size,
            termClusters: this.domain.termClusters.size,
            moduleTerms: this.domain.moduleTerms.size,
            prefixToModule: this.domain.prefixToModule.size
        };
    }
    
    /**
     * Export learned domain knowledge for persistence
     */
    exportKnowledge() {
        return {
            version: '1.0',
            directoryModules: Array.from(this.domain.directoryModules.entries()),
            fileNamePrefixes: Array.from(this.domain.fileNamePrefixes.entries()),
            termClusters: Array.from(this.domain.termClusters.entries()).map(
                ([k, v]) => [k, Array.from(v)]
            ),
            moduleTerms: Array.from(this.domain.moduleTerms.entries()).map(
                ([k, v]) => [k, Array.from(v)]
            ),
            prefixToModule: Array.from(this.domain.prefixToModule.entries()),
            stats: this.domain.stats
        };
    }
    
    /**
     * Import previously learned domain knowledge
     */
    importKnowledge(data) {
        if (!data || data.version !== '1.0') {
            throw new Error('Invalid domain knowledge format');
        }
        
        this.domain.clear();
        
        for (const [k, v] of data.directoryModules) {
            this.domain.directoryModules.set(k, v);
        }
        
        for (const [k, v] of data.fileNamePrefixes) {
            this.domain.fileNamePrefixes.set(k, v);
        }
        
        for (const [k, v] of data.termClusters) {
            this.domain.termClusters.set(k, new Set(v));
        }
        
        for (const [k, v] of data.moduleTerms) {
            this.domain.moduleTerms.set(k, new Set(v));
        }
        
        for (const [k, v] of data.prefixToModule) {
            this.domain.prefixToModule.set(k, v);
        }
        
        this.domain.stats = data.stats;
        this._buildReverseTermMappings();
        this.isLearned = true;
    }
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    QueryClassifier,
    QueryClassification,
    QueryTypes,
    SearchStrategies,
    ClassificationPatterns,
    DomainKnowledge
};
