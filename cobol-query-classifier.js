/**
 * AstraCode COBOL Query Classifier v1.0
 * 
 * Specialized query understanding and expansion for COBOL codebases.
 * Handles COBOL-specific terminology, structure, and patterns.
 * 
 * Usage:
 *   const { CobolQueryClassifier } = require('./cobol-query-classifier');
 *   const classifier = new CobolQueryClassifier({ log: console.log });
 *   classifier.learnFromCodebase(contextFiles, codeIndex);
 *   const result = classifier.classify(userQuery);
 *   // result.expandedTerms, result.searchStrategy, result.cobolContext
 */

// ============================================================
// COBOL KNOWLEDGE BASE
// ============================================================

/**
 * COBOL terminology mappings
 * Maps common programming terms to COBOL equivalents
 */
const COBOL_SYNONYMS = {
    // Control flow
    'function': ['paragraph', 'section', 'procedure', 'proc'],
    'method': ['paragraph', 'section', 'procedure'],
    'procedure': ['paragraph', 'section', 'perform'],
    'call': ['perform', 'call using', 'invoke'],
    'invoke': ['perform', 'call using'],
    'return': ['goback', 'stop run', 'exit program', 'exit paragraph'],
    'loop': ['perform until', 'perform varying', 'perform times', 'perform thru'],
    'for loop': ['perform varying', 'perform times'],
    'while loop': ['perform until'],
    'if': ['if', 'evaluate', 'when'],
    'switch': ['evaluate', 'evaluate true', 'when'],
    'case': ['evaluate', 'when', 'when other'],
    'else': ['else', 'when other'],
    'goto': ['go to', 'alter'],
    
    // Variables and data
    'variable': ['data item', 'working-storage', 'pic', 'picture', 'ws-', '01 level', '77 level'],
    'field': ['data item', 'pic', 'elementary item', 'group item'],
    'constant': ['88 level', 'value', 'zeros', 'spaces', 'high-values', 'low-values'],
    'string': ['pic x', 'pic a', 'alphanumeric', 'display'],
    'number': ['pic 9', 'pic s9', 'comp', 'comp-3', 'packed decimal', 'binary'],
    'decimal': ['pic 9v9', 'comp-3', 'packed', 'v99'],
    'integer': ['pic 9', 'comp', 'binary', 'comp-5'],
    'boolean': ['88 level', 'condition name', 'switch'],
    'array': ['occurs', 'table', 'indexed by', 'depending on'],
    'table': ['occurs', 'indexed by', 'search', 'search all'],
    'struct': ['01 level', 'group item', 'record'],
    'record': ['01 level', 'fd', 'group item', 'copybook'],
    'pointer': ['pointer', 'address of', 'set address'],
    'null': ['spaces', 'zeros', 'low-values', 'high-values'],
    'global': ['working-storage', 'external', 'global'],
    'local': ['local-storage', 'linkage'],
    'parameter': ['linkage', 'using', 'call using', 'procedure division using'],
    
    // File and I/O
    'file': ['fd', 'select', 'file-control', 'file section', 'i-o'],
    'open': ['open input', 'open output', 'open i-o', 'open extend'],
    'close': ['close'],
    'read': ['read', 'read next', 'read into', 'start'],
    'write': ['write', 'write from', 'rewrite'],
    'print': ['display', 'write', 'exhibit'],
    'input': ['accept', 'read', 'receive', 'input'],
    'output': ['display', 'write', 'send', 'output'],
    'log': ['display', 'exhibit', 'write'],
    
    // Database
    'database': ['exec sql', 'exec cics', 'db2', 'sql', 'cursor'],
    'sql': ['exec sql', 'end-exec', 'sqlcode', 'sqlca'],
    'query': ['select', 'exec sql select', 'cursor', 'fetch'],
    'insert': ['exec sql insert', 'insert into'],
    'update': ['exec sql update', 'update set'],
    'delete': ['exec sql delete', 'delete from'],
    'cursor': ['declare cursor', 'open cursor', 'fetch', 'close cursor'],
    'transaction': ['commit', 'rollback', 'exec sql commit', 'exec sql rollback'],
    'connection': ['connect', 'exec sql connect'],
    
    // Error handling
    'error': ['on exception', 'not on exception', 'invalid key', 'at end', 'sqlcode'],
    'exception': ['on exception', 'on error', 'use after error'],
    'try': ['on exception', 'not on exception'],
    'catch': ['on exception', 'use after error', 'declaratives'],
    'status': ['file status', 'sqlcode', 'return-code', 'sqlca'],
    
    // Modules and structure
    'module': ['program-id', 'division', 'section', 'copy'],
    'import': ['copy', 'copy replacing', 'copybook'],
    'include': ['copy', 'copybook'],
    'library': ['copybook', 'copy', 'call'],
    'class': ['program-id', 'class-id', 'object'],
    
    // Operations
    'assign': ['move', 'set', 'initialize', 'compute'],
    'add': ['add', 'compute', '+'],
    'subtract': ['subtract', 'compute', '-'],
    'multiply': ['multiply', 'compute', '*'],
    'divide': ['divide', 'compute', '/'],
    'calculate': ['compute', 'add', 'subtract', 'multiply', 'divide'],
    'compare': ['if', 'evaluate', 'greater', 'less', 'equal'],
    'concatenate': ['string', 'string delimited'],
    'split': ['unstring', 'unstring delimited'],
    'search': ['search', 'search all', 'inspect'],
    'sort': ['sort', 'merge', 'release', 'return'],
    'validate': ['inspect', 'verify', 'validate', 'if numeric', 'class test'],
    'convert': ['move', 'compute', 'function'],
    'format': ['move', 'string', 'edit', 'de-edit'],
    'parse': ['unstring', 'inspect', 'reference modification'],
};

/**
 * COBOL division structure
 */
const COBOL_DIVISIONS = {
    'IDENTIFICATION': {
        keywords: ['program-id', 'author', 'installation', 'date-written', 'date-compiled', 'security'],
        purpose: 'Program metadata and identification',
        searchFor: ['program name', 'author', 'program info']
    },
    'ENVIRONMENT': {
        keywords: ['configuration', 'source-computer', 'object-computer', 'special-names', 
                   'input-output', 'file-control', 'select', 'assign', 'i-o-control'],
        purpose: 'Environment configuration, file assignments',
        searchFor: ['file definition', 'file assignment', 'configuration']
    },
    'DATA': {
        keywords: ['file section', 'fd', 'working-storage', 'local-storage', 'linkage',
                   'communication', 'report', 'screen', '01', '77', '88', 'pic', 'picture',
                   'copy', 'occurs', 'redefines', 'value', 'filler'],
        purpose: 'Data definitions, variables, records, copybooks',
        searchFor: ['variable', 'field', 'record', 'data', 'definition', 'structure']
    },
    'PROCEDURE': {
        keywords: ['perform', 'call', 'move', 'add', 'subtract', 'multiply', 'divide',
                   'compute', 'if', 'evaluate', 'go to', 'stop run', 'goback', 'exit',
                   'open', 'close', 'read', 'write', 'rewrite', 'delete', 'start',
                   'exec sql', 'exec cics', 'display', 'accept', 'string', 'unstring',
                   'inspect', 'search', 'sort', 'merge'],
        purpose: 'Executable code, business logic, procedures',
        searchFor: ['logic', 'process', 'call', 'perform', 'code', 'function', 'how']
    }
};

/**
 * Common COBOL naming patterns
 */
const COBOL_NAMING_PATTERNS = {
    paragraphs: /^[A-Z][A-Z0-9-]*(-PARA|-PROC|-RTN|-ROUTINE|-SECTION|-SECT|-PROCESS)?$/i,
    dataItems: /^(WS-|LS-|LK-|FD-|WA-|SW-|CT-|IX-|TB-|GR-)[A-Z0-9-]+$/i,
    copybooks: /^[A-Z][A-Z0-9]+\.(CPY|CBL|COB|COPY)$/i,
    conditions: /^[A-Z][A-Z0-9-]+-?(YES|NO|TRUE|FALSE|VALID|INVALID|FOUND|NOTFOUND|EOF|ERROR)$/i,
    counters: /^(WS-|CT-|IX-)[A-Z0-9-]*(-CNT|-COUNT|-CTR|-INDEX|-IDX|-SUB|-SUBSCRIPT)$/i,
    flags: /^(WS-|SW-)[A-Z0-9-]*(-FLAG|-SW|-SWITCH|-IND|-INDICATOR)$/i,
    dates: /^[A-Z0-9-]*(-DATE|-DT|-YYYYMMDD|-CCYYMMDD|-MMDDYY)$/i,
    amounts: /^[A-Z0-9-]*(-AMT|-AMOUNT|-BAL|-BALANCE|-TOTAL|-SUM)$/i,
    codes: /^[A-Z0-9-]*(-CODE|-CD|-TYPE|-TYP|-STATUS|-STAT)$/i,
};

/**
 * Query intent patterns for COBOL
 */
const COBOL_QUERY_INTENTS = [
    // Module + Table queries (NEW)
    {
        patterns: [
            /(?:show|list|find|get)\s+(?:all\s+)?(?:the\s+)?tables?\s+in\s+(?:the\s+)?(\S+)/i,
            /tables?\s+(?:in|for|of)\s+(?:the\s+)?(\S+)\s+(?:module|program|section)/i,
            /(\S+)\s+(?:module|program)\s+tables?/i,
            /what\s+tables?\s+(?:are|does)\s+(?:in\s+)?(\S+)/i,
        ],
        intent: 'LIST_TABLES_IN_MODULE',
        division: 'DATA',
        extractName: true,
        extractModule: true,
        searchBoost: ['occurs', 'indexed by', 'exec sql', 'from', 'into', 'fd', '01']
    },
    
    // All tables in codebase
    {
        patterns: [
            /(?:show|list|find|get)\s+(?:all\s+)?tables?$/i,
            /(?:show|list|find|get)\s+(?:all\s+)?(?:cobol\s+)?tables?/i,
            /what\s+tables?\s+(?:are\s+)?(?:defined|used|available)/i,
            /list\s+(?:all\s+)?(?:occurs|arrays?)/i,
        ],
        intent: 'LIST_ALL_TABLES',
        division: 'DATA',
        extractName: false,
        searchBoost: ['occurs', 'indexed by', 'depending on', 'search', 'set']
    },
    
    // SQL tables specifically
    {
        patterns: [
            /(?:show|list|find|get)\s+(?:all\s+)?(?:sql|db2|database)\s+tables?/i,
            /(?:show|list|find|get)\s+(?:all\s+)?tables?\s+(?:in\s+)?(?:sql|db2|database)/i,
            /what\s+(?:sql|db2|database)\s+tables?/i,
            /tables?\s+accessed\s+(?:by|in)/i,
        ],
        intent: 'LIST_SQL_TABLES',
        division: 'PROCEDURE',
        extractName: false,
        searchBoost: ['exec sql', 'from', 'into', 'update', 'delete', 'insert']
    },
    
    // Module overview queries
    {
        patterns: [
            /(?:show|describe|explain)\s+(?:the\s+)?(\S+)\s+(?:module|program|component)/i,
            /what\s+(?:is|does)\s+(?:the\s+)?(\S+)\s+(?:module|program)\s+(?:do|contain)/i,
            /overview\s+of\s+(?:the\s+)?(\S+)/i,
            /(\S+)\s+(?:module|program)\s+overview/i,
        ],
        intent: 'MODULE_OVERVIEW',
        division: null,  // Search all divisions
        extractName: true,
        extractModule: true,
        searchBoost: ['program-id', 'section', 'paragraph', 'copy', 'call']
    },
    
    // Definition queries
    {
        patterns: [
            /where\s+is\s+(\S+)\s+defined/i,
            /definition\s+of\s+(\S+)/i,
            /what\s+is\s+(\S+)/i,
            /find\s+(\S+)\s+definition/i,
            /show\s+(\S+)\s+structure/i,
            /how\s+is\s+(\S+)\s+defined/i,
        ],
        intent: 'FIND_DEFINITION',
        division: 'DATA',
        extractName: true,
        searchBoost: ['01', '77', 'pic', 'working-storage', 'copy', 'fd']
    },
    
    // Call/flow queries
    {
        patterns: [
            /who\s+calls\s+(\S+)/i,
            /what\s+calls\s+(\S+)/i,
            /where\s+is\s+(\S+)\s+called/i,
            /callers?\s+of\s+(\S+)/i,
            /what\s+performs\s+(\S+)/i,
        ],
        intent: 'FIND_CALLERS',
        division: 'PROCEDURE',
        extractName: true,
        searchBoost: ['perform', 'call using']
    },
    {
        patterns: [
            /what\s+does\s+(\S+)\s+call/i,
            /(\S+)\s+calls\s+what/i,
            /what\s+does\s+(\S+)\s+perform/i,
            /callees?\s+of\s+(\S+)/i,
        ],
        intent: 'FIND_CALLEES',
        division: 'PROCEDURE',
        extractName: true,
        searchBoost: ['perform', 'call using']
    },
    
    // Database queries
    {
        patterns: [
            /sql\s+(?:statements?|queries|code)/i,
            /database\s+(?:calls?|access|operations?)/i,
            /db2\s+(?:calls?|code)/i,
            /what\s+(?:tables?|cursors?)/i,
            /show\s+(?:sql|database|db2)/i,
            /exec\s+sql/i,
        ],
        intent: 'FIND_DATABASE',
        division: 'PROCEDURE',
        extractName: false,
        searchBoost: ['exec sql', 'cursor', 'fetch', 'select', 'insert', 'update', 'delete', 'sqlcode']
    },
    
    // File I/O queries
    {
        patterns: [
            /file\s+(?:operations?|handling|i\/o|io)/i,
            /(?:read|write)\s+(?:file|record)/i,
            /what\s+files?\s+(?:are|does)/i,
            /show\s+(?:fd|file\s+section)/i,
            /file\s+(?:definition|description)/i,
        ],
        intent: 'FIND_FILE_IO',
        division: 'ENVIRONMENT',  // Start in ENVIRONMENT for SELECT, then DATA for FD
        extractName: false,
        searchBoost: ['fd', 'select', 'assign', 'open', 'close', 'read', 'write', 'file-control']
    },
    
    // Copybook queries
    {
        patterns: [
            /copybooks?/i,
            /copy\s+statements?/i,
            /included?\s+(?:files?|code|members?)/i,
            /what\s+(?:copybooks?|copies)/i,
            /show\s+(?:copybooks?|copy)/i,
            /shared\s+(?:data|records?|structures?)/i,
        ],
        intent: 'FIND_COPYBOOKS',
        division: 'DATA',
        extractName: false,
        searchBoost: ['copy', 'copybook', '.cpy']
    },
    
    // Paragraph/section list
    {
        patterns: [
            /list\s+(?:all\s+)?(?:paragraphs?|sections?|procedures?)/i,
            /show\s+(?:all\s+)?(?:paragraphs?|sections?|procedures?)/i,
            /what\s+(?:paragraphs?|sections?|procedures?)/i,
            /(?:paragraphs?|sections?)\s+in/i,
        ],
        intent: 'LIST_PARAGRAPHS',
        division: 'PROCEDURE',
        extractName: false,
        searchBoost: ['paragraph', 'section', 'proc', 'perform']
    },
    
    // Data item queries
    {
        patterns: [
            /list\s+(?:all\s+)?(?:variables?|fields?|data\s+items?)/i,
            /show\s+(?:all\s+)?(?:variables?|fields?|working.?storage)/i,
            /what\s+(?:variables?|fields?|data)/i,
            /working.?storage\s+(?:items?|variables?|section)/i,
        ],
        intent: 'LIST_DATA_ITEMS',
        division: 'DATA',
        extractName: false,
        searchBoost: ['01', '77', 'working-storage', 'pic']
    },
    
    // Logic/process queries
    {
        patterns: [
            /how\s+(?:does|is)\s+(\S+)\s+(?:work|processed|calculated|validated|handled)/i,
            /explain\s+(\S+)/i,
            /what\s+(?:does|is)\s+the\s+logic\s+(?:for|of|in)\s+(\S+)/i,
            /(?:process|flow)\s+(?:for|of)\s+(\S+)/i,
        ],
        intent: 'EXPLAIN_LOGIC',
        division: 'PROCEDURE',
        extractName: true,
        searchBoost: ['perform', 'if', 'evaluate', 'compute', 'move']
    },
    
    // Validation queries
    {
        patterns: [
            /(?:how|where)\s+is\s+(\S+)\s+validated/i,
            /validation\s+(?:for|of)\s+(\S+)/i,
            /(?:check|verify)\s+(\S+)/i,
            /(\S+)\s+validation/i,
        ],
        intent: 'FIND_VALIDATION',
        division: 'PROCEDURE',
        extractName: true,
        searchBoost: ['if', 'evaluate', 'numeric', 'alphabetic', 'valid', 'invalid', 'verify', 'inspect']
    },
    
    // Error handling queries
    {
        patterns: [
            /error\s+handling/i,
            /exception\s+handling/i,
            /how\s+(?:are\s+)?errors?\s+(?:handled|processed)/i,
            /what\s+happens\s+(?:on|when)\s+error/i,
            /show\s+error\s+(?:handling|code)/i,
        ],
        intent: 'FIND_ERROR_HANDLING',
        division: 'PROCEDURE',
        extractName: false,
        searchBoost: ['on exception', 'invalid key', 'at end', 'not on exception', 'sqlcode', 'file status']
    },
];

// ============================================================
// COBOL QUERY CLASSIFIER CLASS
// ============================================================

class CobolQueryClassifier {
    constructor(options = {}) {
        this.log = options.log || console.log;
        this.codebaseInfo = null;
        this.learnedPatterns = {
            programNames: new Set(),
            paragraphNames: new Set(),
            dataItemNames: new Set(),
            copybookNames: new Set(),
            tableNames: new Set(),      // SQL tables
            fileNames: new Set(),       // COBOL file names (FD)
        };
        this.initialized = false;
    }

    /**
     * Learn from the indexed codebase
     * Extracts COBOL-specific patterns and names
     */
    learnFromCodebase(contextFiles, codeIndex) {
        this.log('CobolQueryClassifier: Learning from codebase...');
        const startTime = Date.now();
        
        let programCount = 0;
        let paragraphCount = 0;
        let dataItemCount = 0;
        let copybookCount = 0;
        let sqlTableCount = 0;
        
        for (const [filePath, file] of contextFiles) {
            const content = file.content || '';
            const language = (file.language || '').toLowerCase();
            
            // Only process COBOL files
            if (!this._isCobolFile(filePath, language)) continue;
            
            // Extract PROGRAM-ID
            const progMatch = content.match(/PROGRAM-ID\.\s+([A-Z0-9-]+)/i);
            if (progMatch) {
                this.learnedPatterns.programNames.add(progMatch[1].toUpperCase());
                programCount++;
            }
            
            // Extract paragraph names (lines starting with name followed by period)
            const paragraphPattern = /^[\s]{0,6}([A-Z][A-Z0-9-]{2,})\.\s*$/gm;
            let match;
            while ((match = paragraphPattern.exec(content))) {
                const name = match[1].toUpperCase();
                // Filter out division/section keywords
                if (!this._isDivisionKeyword(name)) {
                    this.learnedPatterns.paragraphNames.add(name);
                    paragraphCount++;
                }
            }
            
            // Extract data item names (01-77 levels)
            const dataPattern = /^\s*(01|77|05|10|15|20|88)\s+([A-Z][A-Z0-9-]+)/gm;
            while ((match = dataPattern.exec(content))) {
                const name = match[2].toUpperCase();
                if (name !== 'FILLER') {
                    this.learnedPatterns.dataItemNames.add(name);
                    dataItemCount++;
                }
            }
            
            // Extract COPY statements
            const copyPattern = /COPY\s+([A-Z0-9-]+)/gi;
            while ((match = copyPattern.exec(content))) {
                this.learnedPatterns.copybookNames.add(match[1].toUpperCase());
                copybookCount++;
            }
            
            // Extract SQL table names
            const sqlPattern = /(?:FROM|INTO|UPDATE|JOIN)\s+([A-Z][A-Z0-9_]+)/gi;
            while ((match = sqlPattern.exec(content))) {
                const tableName = match[1].toUpperCase();
                // Filter out COBOL keywords that might match
                if (!this._isSqlKeyword(tableName)) {
                    this.learnedPatterns.tableNames.add(tableName);
                    sqlTableCount++;
                }
            }
            
            // Extract FD names
            const fdPattern = /FD\s+([A-Z][A-Z0-9-]+)/gi;
            while ((match = fdPattern.exec(content))) {
                this.learnedPatterns.fileNames.add(match[1].toUpperCase());
            }
        }
        
        // Also learn from codeIndex symbols
        if (codeIndex && codeIndex.symbols) {
            for (const [key, symbol] of codeIndex.symbols) {
                if (!key.includes('@')) continue;
                
                const name = symbol.name.toUpperCase();
                const type = (symbol.type || '').toLowerCase();
                
                if (type === 'paragraph' || type === 'section') {
                    this.learnedPatterns.paragraphNames.add(name);
                } else if (type === 'variable' || type === 'field' || type === 'record') {
                    this.learnedPatterns.dataItemNames.add(name);
                } else if (type === 'program') {
                    this.learnedPatterns.programNames.add(name);
                }
            }
        }
        
        this.initialized = true;
        
        const elapsed = Date.now() - startTime;
        this.log(`CobolQueryClassifier: Learned in ${elapsed}ms - ` +
            `${programCount} programs, ${paragraphCount} paragraphs, ` +
            `${dataItemCount} data items, ${copybookCount} copybooks, ${sqlTableCount} SQL tables`);
        
        return {
            programs: this.learnedPatterns.programNames.size,
            paragraphs: this.learnedPatterns.paragraphNames.size,
            dataItems: this.learnedPatterns.dataItemNames.size,
            copybooks: this.learnedPatterns.copybookNames.size,
            sqlTables: this.learnedPatterns.tableNames.size,
            files: this.learnedPatterns.fileNames.size,
        };
    }

    /**
     * Classify a user query
     * Returns intent, expanded terms, search strategy, etc.
     */
    classify(query) {
        const result = {
            originalQuery: query,
            intent: 'GENERAL_SEARCH',
            division: null,
            extractedNames: [],
            expandedTerms: [],
            searchBoost: [],
            cobolContext: {},
            confidence: 0.5,
        };
        
        // Normalize query
        const normalizedQuery = query.trim();
        const queryUpper = normalizedQuery.toUpperCase();
        
        // Try to match intent patterns
        for (const intentDef of COBOL_QUERY_INTENTS) {
            for (const pattern of intentDef.patterns) {
                const match = normalizedQuery.match(pattern);
                if (match) {
                    result.intent = intentDef.intent;
                    result.division = intentDef.division;
                    result.searchBoost = [...intentDef.searchBoost];
                    result.confidence = 0.8;
                    
                    // Extract name if pattern captures one
                    if (intentDef.extractName && match[1]) {
                        const extractedName = match[1].toUpperCase().replace(/['"]/g, '');
                        result.extractedNames.push(extractedName);
                    }
                    break;
                }
            }
            if (result.intent !== 'GENERAL_SEARCH') break;
        }
        
        // Extract any COBOL-looking names from query
        const cobolNames = this._extractCobolNames(normalizedQuery);
        for (const name of cobolNames) {
            if (!result.extractedNames.includes(name)) {
                result.extractedNames.push(name);
            }
        }
        
        // Check if extracted names match known patterns
        for (const name of result.extractedNames) {
            if (this.learnedPatterns.paragraphNames.has(name)) {
                result.cobolContext.isParagraph = true;
                if (!result.division) result.division = 'PROCEDURE';
            }
            if (this.learnedPatterns.dataItemNames.has(name)) {
                result.cobolContext.isDataItem = true;
                if (!result.division) result.division = 'DATA';
            }
            if (this.learnedPatterns.copybookNames.has(name)) {
                result.cobolContext.isCopybook = true;
            }
            if (this.learnedPatterns.tableNames.has(name)) {
                result.cobolContext.isSqlTable = true;
                result.searchBoost.push('exec sql');
            }
            if (this.learnedPatterns.programNames.has(name)) {
                result.cobolContext.isProgram = true;
            }
        }
        
        // Expand query terms using COBOL synonyms
        result.expandedTerms = this._expandTerms(normalizedQuery);
        
        // Add extracted names to search
        for (const name of result.extractedNames) {
            if (!result.expandedTerms.includes(name)) {
                result.expandedTerms.push(name);
            }
            // Also add common COBOL search patterns
            result.expandedTerms.push(`PERFORM ${name}`);
            result.expandedTerms.push(`CALL '${name}'`);
            if (result.cobolContext.isDataItem) {
                result.expandedTerms.push(`MOVE ${name}`);
                result.expandedTerms.push(`01 ${name}`);
            }
        }
        
        // Deduplicate
        result.expandedTerms = [...new Set(result.expandedTerms)];
        result.searchBoost = [...new Set(result.searchBoost)];
        
        return result;
    }

    /**
     * Get search strategy based on classification
     */
    getSearchStrategy(classification) {
        const strategy = {
            searchOrder: [],
            filters: {},
            boostTerms: classification.searchBoost,
            maxResults: 50,
        };
        
        switch (classification.intent) {
            case 'LIST_TABLES_IN_MODULE':
                strategy.searchOrder = ['module_files', 'data_division', 'sql_statements'];
                strategy.filters.symbolTypes = ['table', 'occurs', 'fd', 'record'];
                strategy.filters.patterns = [/OCCURS/i, /EXEC\s+SQL/i, /\bFD\b/i];
                strategy.extractTables = true;
                strategy.moduleFilter = classification.extractedNames[0] || null;
                break;
                
            case 'LIST_ALL_TABLES':
                strategy.searchOrder = ['data_division', 'symbols'];
                strategy.filters.symbolTypes = ['table', 'occurs', 'record'];
                strategy.filters.patterns = [/OCCURS\s+\d+/i, /INDEXED\s+BY/i];
                strategy.extractTables = true;
                strategy.maxResults = 200;
                break;
                
            case 'LIST_SQL_TABLES':
                strategy.searchOrder = ['sql_statements', 'procedure_division'];
                strategy.filters.patterns = [/EXEC\s+SQL/i, /FROM\s+[A-Z]/i, /INTO\s+[A-Z]/i];
                strategy.extractSqlTables = true;
                strategy.maxResults = 100;
                break;
                
            case 'MODULE_OVERVIEW':
                strategy.searchOrder = ['module_files', 'symbols', 'summaries'];
                strategy.filters.symbolTypes = ['program', 'section', 'paragraph'];
                strategy.moduleFilter = classification.extractedNames[0] || null;
                strategy.includeStats = true;
                strategy.maxResults = 100;
                break;
            
            case 'FIND_DEFINITION':
                strategy.searchOrder = ['data_division', 'copybooks', 'symbols'];
                strategy.filters.symbolTypes = ['variable', 'field', 'record', '01-level', '77-level'];
                break;
                
            case 'FIND_CALLERS':
            case 'FIND_CALLEES':
                strategy.searchOrder = ['call_graph', 'procedure_division', 'symbols'];
                strategy.filters.symbolTypes = ['paragraph', 'section', 'procedure'];
                break;
                
            case 'FIND_DATABASE':
                strategy.searchOrder = ['sql_statements', 'procedure_division'];
                strategy.filters.patterns = [/EXEC\s+SQL/i, /CURSOR/i, /FETCH/i];
                break;
                
            case 'FIND_FILE_IO':
                strategy.searchOrder = ['file_section', 'environment_division', 'procedure_division'];
                strategy.filters.patterns = [/\bFD\b/i, /\bSELECT\b/i, /\bOPEN\b/i, /\bREAD\b/i, /\bWRITE\b/i];
                break;
                
            case 'FIND_COPYBOOKS':
                strategy.searchOrder = ['copybooks', 'data_division'];
                strategy.filters.patterns = [/\bCOPY\b/i];
                break;
                
            case 'LIST_PARAGRAPHS':
                strategy.searchOrder = ['symbols', 'procedure_division'];
                strategy.filters.symbolTypes = ['paragraph', 'section'];
                break;
                
            case 'LIST_DATA_ITEMS':
                strategy.searchOrder = ['symbols', 'data_division'];
                strategy.filters.symbolTypes = ['variable', 'field', 'record'];
                break;
                
            case 'EXPLAIN_LOGIC':
            case 'FIND_VALIDATION':
                strategy.searchOrder = ['procedure_division', 'call_graph', 'symbols'];
                strategy.maxResults = 100;  // Need more context for explanations
                break;
                
            case 'FIND_ERROR_HANDLING':
                strategy.searchOrder = ['procedure_division', 'declaratives'];
                strategy.filters.patterns = [/ON\s+EXCEPTION/i, /INVALID\s+KEY/i, /AT\s+END/i, /SQLCODE/i];
                break;
                
            default:
                strategy.searchOrder = ['symbols', 'trigram', 'summaries'];
        }
        
        return strategy;
    }

    /**
     * Generate COBOL-aware search queries
     */
    generateSearchQueries(classification) {
        const queries = [];
        
        // Add expanded terms as queries
        for (const term of classification.expandedTerms.slice(0, 10)) {
            queries.push({
                query: term,
                boost: classification.searchBoost.some(b => term.toLowerCase().includes(b.toLowerCase())) ? 2.0 : 1.0
            });
        }
        
        // Add specific patterns based on intent
        for (const name of classification.extractedNames) {
            switch (classification.intent) {
                case 'FIND_DEFINITION':
                    queries.push({ query: `01 ${name}`, boost: 2.0 });
                    queries.push({ query: `77 ${name}`, boost: 2.0 });
                    queries.push({ query: `COPY.*${name}`, boost: 1.5, isRegex: true });
                    break;
                    
                case 'FIND_CALLERS':
                    queries.push({ query: `PERFORM ${name}`, boost: 2.0 });
                    queries.push({ query: `CALL.*${name}`, boost: 2.0, isRegex: true });
                    break;
                    
                case 'FIND_CALLEES':
                    queries.push({ query: `${name}.*PERFORM`, boost: 1.5, isRegex: true });
                    break;
                    
                case 'FIND_DATABASE':
                    queries.push({ query: `EXEC SQL.*${name}`, boost: 2.0, isRegex: true });
                    queries.push({ query: `FROM ${name}`, boost: 1.5 });
                    queries.push({ query: `INTO ${name}`, boost: 1.5 });
                    break;
            }
        }
        
        return queries;
    }

    /**
     * Format results with COBOL context
     */
    formatResultContext(results, classification) {
        let context = '';
        
        // Add division context
        if (classification.division) {
            context += `## Searching in ${classification.division} DIVISION\n\n`;
        }
        
        // Add extracted names
        if (classification.extractedNames.length > 0) {
            context += `**Looking for:** ${classification.extractedNames.join(', ')}\n`;
        }
        
        // Add COBOL context hints
        if (classification.cobolContext.isParagraph) {
            context += `*Note: "${classification.extractedNames[0]}" appears to be a paragraph name*\n`;
        }
        if (classification.cobolContext.isDataItem) {
            context += `*Note: "${classification.extractedNames[0]}" appears to be a data item*\n`;
        }
        if (classification.cobolContext.isCopybook) {
            context += `*Note: "${classification.extractedNames[0]}" appears to be a copybook*\n`;
        }
        
        return context;
    }

    // ========================================
    // Private Helper Methods
    // ========================================

    _isCobolFile(filePath, language) {
        if (language === 'cobol' || language === 'cbl' || language === 'cob') return true;
        const ext = filePath.toLowerCase().split('.').pop();
        return ['cbl', 'cob', 'cobol', 'cpy', 'copy'].includes(ext);
    }

    _isDivisionKeyword(name) {
        const keywords = new Set([
            'IDENTIFICATION', 'ENVIRONMENT', 'DATA', 'PROCEDURE',
            'CONFIGURATION', 'INPUT-OUTPUT', 'FILE', 'WORKING-STORAGE',
            'LOCAL-STORAGE', 'LINKAGE', 'COMMUNICATION', 'REPORT', 'SCREEN',
            'FILE-CONTROL', 'I-O-CONTROL', 'DECLARATIVES'
        ]);
        return keywords.has(name.toUpperCase());
    }

    _isSqlKeyword(word) {
        const keywords = new Set([
            'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'NULL',
            'INSERT', 'UPDATE', 'DELETE', 'INTO', 'VALUES', 'SET',
            'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'ON',
            'ORDER', 'BY', 'GROUP', 'HAVING', 'DISTINCT', 'AS',
            'CURSOR', 'FETCH', 'OPEN', 'CLOSE', 'DECLARE'
        ]);
        return keywords.has(word.toUpperCase());
    }

    _extractCobolNames(query) {
        const names = [];
        
        // Match COBOL-style names (uppercase with hyphens)
        const cobolNamePattern = /\b([A-Z][A-Z0-9-]{2,})\b/g;
        let match;
        while ((match = cobolNamePattern.exec(query.toUpperCase()))) {
            const name = match[1];
            // Filter out common English words
            if (!this._isCommonWord(name) && !this._isDivisionKeyword(name)) {
                names.push(name);
            }
        }
        
        // Also check for quoted names
        const quotedPattern = /['"]([A-Z0-9-]+)['"]/gi;
        while ((match = quotedPattern.exec(query))) {
            names.push(match[1].toUpperCase());
        }
        
        return [...new Set(names)];
    }

    _isCommonWord(word) {
        const common = new Set([
            'THE', 'AND', 'FOR', 'WITH', 'ALL', 'THIS', 'THAT', 'WHAT',
            'WHERE', 'WHEN', 'HOW', 'WHO', 'WHY', 'WHICH', 'SHOW', 'FIND',
            'LIST', 'GET', 'ARE', 'NOT', 'FROM', 'INTO', 'DOES', 'HAVE'
        ]);
        return common.has(word.toUpperCase());
    }

    _expandTerms(query) {
        const terms = [query];
        const words = query.toLowerCase().split(/\s+/);
        
        for (const word of words) {
            // Check synonyms
            if (COBOL_SYNONYMS[word]) {
                terms.push(...COBOL_SYNONYMS[word]);
            }
            
            // Check partial matches
            for (const [key, synonyms] of Object.entries(COBOL_SYNONYMS)) {
                if (word.includes(key) || key.includes(word)) {
                    terms.push(...synonyms.slice(0, 3));  // Limit expansion
                }
            }
        }
        
        return [...new Set(terms)].slice(0, 20);  // Limit total terms
    }
}

// ============================================================
// COBOL-SPECIFIC SEARCH HELPERS
// ============================================================

/**
 * Extract all paragraphs from COBOL content
 */
function extractCobolParagraphs(content) {
    const paragraphs = [];
    const lines = content.split('\n');
    let inProcedure = false;
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // Check for PROCEDURE DIVISION
        if (/PROCEDURE\s+DIVISION/i.test(line)) {
            inProcedure = true;
            continue;
        }
        
        if (!inProcedure) continue;
        
        // Match paragraph name (starts in column 8-11, ends with period)
        const match = line.match(/^[\s]{0,6}([A-Z][A-Z0-9-]+)\.\s*$/i);
        if (match) {
            paragraphs.push({
                name: match[1].toUpperCase(),
                line: i + 1,
            });
        }
    }
    
    return paragraphs;
}

/**
 * Extract all data items from COBOL content
 */
function extractCobolDataItems(content) {
    const items = [];
    const pattern = /^\s*(01|05|10|15|20|25|77|88)\s+([A-Z][A-Z0-9-]*)\s*(PIC|PICTURE|VALUE|OCCURS|REDEFINES)?/gim;
    
    let match;
    while ((match = pattern.exec(content))) {
        const level = match[1];
        const name = match[2].toUpperCase();
        
        if (name !== 'FILLER') {
            items.push({
                level: parseInt(level),
                name: name,
                // Find line number
                line: content.substring(0, match.index).split('\n').length,
            });
        }
    }
    
    return items;
}

/**
 * Extract SQL statements from COBOL content
 */
function extractCobolSql(content) {
    const statements = [];
    const pattern = /EXEC\s+SQL([\s\S]*?)END-EXEC/gi;
    
    let match;
    while ((match = pattern.exec(content))) {
        const sql = match[1].trim();
        const line = content.substring(0, match.index).split('\n').length;
        
        // Determine SQL type
        let type = 'OTHER';
        if (/^\s*SELECT/i.test(sql)) type = 'SELECT';
        else if (/^\s*INSERT/i.test(sql)) type = 'INSERT';
        else if (/^\s*UPDATE/i.test(sql)) type = 'UPDATE';
        else if (/^\s*DELETE/i.test(sql)) type = 'DELETE';
        else if (/^\s*DECLARE\s+.*CURSOR/i.test(sql)) type = 'CURSOR';
        else if (/^\s*OPEN/i.test(sql)) type = 'OPEN_CURSOR';
        else if (/^\s*FETCH/i.test(sql)) type = 'FETCH';
        else if (/^\s*CLOSE/i.test(sql)) type = 'CLOSE_CURSOR';
        else if (/^\s*COMMIT/i.test(sql)) type = 'COMMIT';
        else if (/^\s*ROLLBACK/i.test(sql)) type = 'ROLLBACK';
        
        statements.push({
            type,
            sql: sql.substring(0, 200),  // Truncate for index
            line,
        });
    }
    
    return statements;
}

/**
 * Extract COPY statements from COBOL content
 */
function extractCobolCopybooks(content) {
    const copybooks = [];
    const pattern = /COPY\s+([A-Z0-9-]+)(?:\s+(?:OF|IN)\s+([A-Z0-9-]+))?(?:\s+REPLACING\s+[\s\S]*?)?(?:\.|$)/gi;
    
    let match;
    while ((match = pattern.exec(content))) {
        copybooks.push({
            name: match[1].toUpperCase(),
            library: match[2]?.toUpperCase() || null,
            line: content.substring(0, match.index).split('\n').length,
        });
    }
    
    return copybooks;
}

/**
 * Extract COBOL tables (OCCURS clauses) from content
 */
function extractCobolTables(content) {
    const tables = [];
    
    // Pattern for OCCURS clause
    const occursPattern = /^\s*(\d{2})\s+([A-Z][A-Z0-9-]+)[\s\S]*?OCCURS\s+(\d+)(?:\s+TO\s+(\d+))?\s+TIMES?(?:\s+DEPENDING\s+ON\s+([A-Z][A-Z0-9-]+))?(?:\s+INDEXED\s+BY\s+([A-Z][A-Z0-9-]+(?:\s*,?\s*[A-Z][A-Z0-9-]+)*))?/gim;
    
    let match;
    while ((match = occursPattern.exec(content))) {
        const level = parseInt(match[1]);
        const name = match[2].toUpperCase();
        const minOccurs = parseInt(match[3]);
        const maxOccurs = match[4] ? parseInt(match[4]) : minOccurs;
        const dependingOn = match[5]?.toUpperCase() || null;
        const indexes = match[6] ? match[6].toUpperCase().split(/[\s,]+/).filter(i => i) : [];
        
        tables.push({
            type: 'COBOL_TABLE',
            level,
            name,
            minOccurs,
            maxOccurs,
            dependingOn,
            indexes,
            line: content.substring(0, match.index).split('\n').length,
        });
    }
    
    return tables;
}

/**
 * Extract SQL table references from COBOL content
 */
function extractSqlTables(content) {
    const tables = new Map();  // Use Map to deduplicate
    
    // Patterns for SQL table references
    const patterns = [
        { regex: /FROM\s+([A-Z][A-Z0-9_]+)/gi, operation: 'SELECT' },
        { regex: /JOIN\s+([A-Z][A-Z0-9_]+)/gi, operation: 'JOIN' },
        { regex: /INTO\s+([A-Z][A-Z0-9_]+)/gi, operation: 'INSERT' },
        { regex: /UPDATE\s+([A-Z][A-Z0-9_]+)/gi, operation: 'UPDATE' },
        { regex: /DELETE\s+FROM\s+([A-Z][A-Z0-9_]+)/gi, operation: 'DELETE' },
    ];
    
    // SQL keywords to exclude
    const sqlKeywords = new Set([
        'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'NULL', 'INTO',
        'VALUES', 'SET', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'ON',
        'ORDER', 'BY', 'GROUP', 'HAVING', 'DISTINCT', 'AS', 'CURSOR',
        'FETCH', 'OPEN', 'CLOSE', 'DECLARE', 'TABLE', 'INDEX', 'VIEW'
    ]);
    
    for (const { regex, operation } of patterns) {
        let match;
        while ((match = regex.exec(content))) {
            const tableName = match[1].toUpperCase();
            
            // Skip SQL keywords
            if (sqlKeywords.has(tableName)) continue;
            
            // Skip COBOL-looking names (with hyphens)
            if (tableName.includes('-')) continue;
            
            if (!tables.has(tableName)) {
                tables.set(tableName, {
                    type: 'SQL_TABLE',
                    name: tableName,
                    operations: new Set([operation]),
                    lines: [content.substring(0, match.index).split('\n').length],
                });
            } else {
                tables.get(tableName).operations.add(operation);
                tables.get(tableName).lines.push(
                    content.substring(0, match.index).split('\n').length
                );
            }
        }
    }
    
    // Convert to array and operations to array
    return Array.from(tables.values()).map(t => ({
        ...t,
        operations: Array.from(t.operations),
    }));
}

/**
 * Extract file/record definitions (FD) from COBOL content
 */
function extractCobolFiles(content) {
    const files = [];
    
    // Pattern for FD (File Description)
    const fdPattern = /FD\s+([A-Z][A-Z0-9-]+)[\s\S]*?(?=(?:FD\s|SD\s|WORKING-STORAGE|LOCAL-STORAGE|LINKAGE|PROCEDURE\s+DIVISION|$))/gi;
    
    let match;
    while ((match = fdPattern.exec(content))) {
        const fileName = match[1].toUpperCase();
        const fdBlock = match[0];
        
        // Extract record names from the FD block
        const records = [];
        const recordPattern = /01\s+([A-Z][A-Z0-9-]+)/gi;
        let recMatch;
        while ((recMatch = recordPattern.exec(fdBlock))) {
            records.push(recMatch[1].toUpperCase());
        }
        
        files.push({
            type: 'FILE',
            name: fileName,
            records,
            line: content.substring(0, match.index).split('\n').length,
        });
    }
    
    return files;
}

/**
 * Get all tables (COBOL + SQL + Files) in a module/file
 */
function getAllTablesInModule(content, moduleName = null) {
    const result = {
        module: moduleName,
        cobolTables: extractCobolTables(content),
        sqlTables: extractSqlTables(content),
        files: extractCobolFiles(content),
        summary: {},
    };
    
    result.summary = {
        cobolTableCount: result.cobolTables.length,
        sqlTableCount: result.sqlTables.length,
        fileCount: result.files.length,
        totalTables: result.cobolTables.length + result.sqlTables.length + result.files.length,
    };
    
    return result;
}

/**
 * Get PERFORM calls from a paragraph
 */
function extractPerformCalls(content, startLine, endLine) {
    const lines = content.split('\n').slice(startLine - 1, endLine);
    const performs = [];
    const pattern = /PERFORM\s+([A-Z][A-Z0-9-]+)/gi;
    
    for (let i = 0; i < lines.length; i++) {
        let match;
        while ((match = pattern.exec(lines[i]))) {
            performs.push({
                target: match[1].toUpperCase(),
                line: startLine + i,
            });
        }
    }
    
    return performs;
}

/**
 * Handle "show tables in module" type queries
 * Returns formatted table information for a module
 * 
 * @param {string} moduleName - Module/program name or path pattern
 * @param {Map} contextFiles - Map of file paths to file contents
 * @param {Object} options - Options
 * @returns {Object} Table information
 */
function handleTableQuery(moduleName, contextFiles, options = {}) {
    const { includeDetails = true, log = console.log } = options;
    
    const result = {
        module: moduleName,
        matchedFiles: [],
        cobolTables: [],
        sqlTables: [],
        fileRecords: [],
        summary: {},
        formatted: '',
    };
    
    const moduleUpper = moduleName.toUpperCase();
    const modulePattern = new RegExp(moduleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    
    // Find files matching the module name
    for (const [filePath, file] of contextFiles) {
        const fileName = filePath.split('/').pop().toUpperCase();
        const content = file.content || '';
        
        // Check if file matches module pattern
        let isMatch = false;
        
        // Match by file name
        if (fileName.includes(moduleUpper) || modulePattern.test(fileName)) {
            isMatch = true;
        }
        
        // Match by PROGRAM-ID
        const progMatch = content.match(/PROGRAM-ID\.\s+([A-Z0-9-]+)/i);
        if (progMatch && progMatch[1].toUpperCase().includes(moduleUpper)) {
            isMatch = true;
        }
        
        // Match by directory/path
        if (filePath.toUpperCase().includes(moduleUpper)) {
            isMatch = true;
        }
        
        if (!isMatch) continue;
        
        result.matchedFiles.push(filePath);
        
        // Extract tables from this file
        const cobolTables = extractCobolTables(content);
        for (const table of cobolTables) {
            result.cobolTables.push({
                ...table,
                file: filePath,
                fileName: fileName,
            });
        }
        
        // Extract SQL tables
        const sqlTables = extractSqlTables(content);
        for (const table of sqlTables) {
            result.sqlTables.push({
                ...table,
                file: filePath,
                fileName: fileName,
            });
        }
        
        // Extract file records (FD)
        const files = extractCobolFiles(content);
        for (const f of files) {
            result.fileRecords.push({
                ...f,
                file: filePath,
                fileName: fileName,
            });
        }
    }
    
    // Build summary
    result.summary = {
        filesSearched: result.matchedFiles.length,
        cobolTableCount: result.cobolTables.length,
        sqlTableCount: result.sqlTables.length,
        fileRecordCount: result.fileRecords.length,
        totalTables: result.cobolTables.length + result.sqlTables.length + result.fileRecords.length,
    };
    
    // Format output
    result.formatted = formatTableResults(result, includeDetails);
    
    return result;
}

/**
 * Format table query results for display
 */
function formatTableResults(result, includeDetails = true) {
    let output = `## Tables in "${result.module}"\n\n`;
    output += `**Files matched:** ${result.matchedFiles.length}\n`;
    output += `**Total tables found:** ${result.summary.totalTables}\n\n`;
    
    // COBOL Tables (OCCURS)
    if (result.cobolTables.length > 0) {
        output += `### COBOL Tables (OCCURS) - ${result.cobolTables.length} found\n\n`;
        output += `| Table Name | Size | Indexed By | File | Line |\n`;
        output += `|------------|------|------------|------|------|\n`;
        
        for (const table of result.cobolTables) {
            const size = table.maxOccurs !== table.minOccurs 
                ? `${table.minOccurs}-${table.maxOccurs}` 
                : `${table.minOccurs}`;
            const indexes = table.indexes.length > 0 ? table.indexes.join(', ') : '-';
            const fileName = table.fileName.length > 20 
                ? table.fileName.substring(0, 17) + '...' 
                : table.fileName;
            
            output += `| ${table.name} | ${size} | ${indexes} | ${fileName} | ${table.line} |\n`;
        }
        output += '\n';
        
        if (includeDetails) {
            // Group by file for detailed view
            const byFile = new Map();
            for (const table of result.cobolTables) {
                if (!byFile.has(table.file)) byFile.set(table.file, []);
                byFile.get(table.file).push(table);
            }
            
            output += `**Details by file:**\n`;
            for (const [file, tables] of byFile) {
                output += `- **${file.split('/').pop()}**: ${tables.map(t => t.name).join(', ')}\n`;
            }
            output += '\n';
        }
    }
    
    // SQL Tables
    if (result.sqlTables.length > 0) {
        output += `### SQL Tables - ${result.sqlTables.length} found\n\n`;
        output += `| Table Name | Operations | File |\n`;
        output += `|------------|------------|------|\n`;
        
        for (const table of result.sqlTables) {
            const ops = table.operations.join(', ');
            const fileName = table.fileName.length > 25 
                ? table.fileName.substring(0, 22) + '...' 
                : table.fileName;
            
            output += `| ${table.name} | ${ops} | ${fileName} |\n`;
        }
        output += '\n';
    }
    
    // File Records (FD)
    if (result.fileRecords.length > 0) {
        output += `### File Definitions (FD) - ${result.fileRecords.length} found\n\n`;
        output += `| File Name | Records | Source File | Line |\n`;
        output += `|-----------|---------|-------------|------|\n`;
        
        for (const f of result.fileRecords) {
            const records = f.records.length > 0 ? f.records.join(', ') : '-';
            const fileName = f.fileName.length > 20 
                ? f.fileName.substring(0, 17) + '...' 
                : f.fileName;
            
            output += `| ${f.name} | ${records} | ${fileName} | ${f.line} |\n`;
        }
        output += '\n';
    }
    
    // No tables found
    if (result.summary.totalTables === 0) {
        output += `*No tables found in module "${result.module}"*\n\n`;
        if (result.matchedFiles.length === 0) {
            output += `**Note:** No files matched the module name. Try:\n`;
            output += `- Using a different module name\n`;
            output += `- Checking the file path contains "${result.module}"\n`;
            output += `- Using the program name from PROGRAM-ID\n`;
        }
    }
    
    return output;
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    CobolQueryClassifier,
    COBOL_SYNONYMS,
    COBOL_DIVISIONS,
    COBOL_NAMING_PATTERNS,
    COBOL_QUERY_INTENTS,
    // Helper functions
    extractCobolParagraphs,
    extractCobolDataItems,
    extractCobolSql,
    extractCobolCopybooks,
    extractPerformCalls,
    // Table extraction functions
    extractCobolTables,
    extractSqlTables,
    extractCobolFiles,
    getAllTablesInModule,
    // Query handlers
    handleTableQuery,
    formatTableResults,
};
