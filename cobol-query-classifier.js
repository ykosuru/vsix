/**
 * AstraCode COBOL Query Classifier v2.0
 * 
 * Specialized query understanding and expansion for COBOL codebases.
 * Features:
 * - COBOL-specific terminology mapping
 * - Query intent recognition (definitions, callers, tables, etc.)
 * - PRE-INDEXED tables (no file scanning on queries)
 * - Module-aware search
 * 
 * Usage:
 *   const { CobolQueryClassifier } = require('./cobol-query-classifier');
 *   const classifier = new CobolQueryClassifier({ log: console.log });
 *   classifier.learnFromCodebase(contextFiles, codeIndex);  // Indexes tables here
 *   const result = classifier.classify(userQuery);
 *   const tables = classifier.getAllTables();  // Instant lookup, no scanning
 */

// ============================================================
// COBOL KNOWLEDGE BASE
// ============================================================

const COBOL_SYNONYMS = {
    'function': ['paragraph', 'section', 'procedure', 'proc'],
    'method': ['paragraph', 'section', 'procedure'],
    'procedure': ['paragraph', 'section', 'perform'],
    'call': ['perform', 'call using', 'invoke'],
    'return': ['goback', 'stop run', 'exit program'],
    'loop': ['perform until', 'perform varying', 'perform times'],
    'if': ['if', 'evaluate', 'when'],
    'switch': ['evaluate', 'when'],
    'variable': ['data item', 'working-storage', 'pic', 'ws-', '01 level', '77 level'],
    'field': ['data item', 'pic', 'elementary item', 'group item'],
    'constant': ['88 level', 'value', 'zeros', 'spaces'],
    'string': ['pic x', 'pic a', 'alphanumeric'],
    'number': ['pic 9', 'pic s9', 'comp', 'comp-3'],
    'array': ['occurs', 'table', 'indexed by'],
    'table': ['occurs', 'indexed by', 'search'],
    'record': ['01 level', 'fd', 'group item', 'copybook'],
    'file': ['fd', 'select', 'file-control'],
    'read': ['read', 'read next', 'read into'],
    'write': ['write', 'write from', 'rewrite'],
    'database': ['exec sql', 'db2', 'cursor'],
    'sql': ['exec sql', 'sqlcode', 'sqlca'],
    'query': ['select', 'cursor', 'fetch'],
    'error': ['on exception', 'invalid key', 'at end', 'sqlcode'],
    'module': ['program-id', 'division', 'section', 'copy'],
    'import': ['copy', 'copybook'],
    'assign': ['move', 'set', 'initialize', 'compute'],
    'calculate': ['compute', 'add', 'subtract', 'multiply', 'divide'],
    'validate': ['inspect', 'verify', 'if numeric'],
};

const COBOL_DIVISIONS = {
    'IDENTIFICATION': { keywords: ['program-id', 'author'], purpose: 'Program metadata' },
    'ENVIRONMENT': { keywords: ['file-control', 'select', 'assign'], purpose: 'File assignments' },
    'DATA': { keywords: ['working-storage', 'fd', 'pic', 'occurs', 'copy'], purpose: 'Data definitions' },
    'PROCEDURE': { keywords: ['perform', 'call', 'move', 'if', 'exec sql'], purpose: 'Executable code' }
};

const COBOL_QUERY_INTENTS = [
    {
        patterns: [
            /(?:show|list|find|get)\s+(?:all\s+)?(?:the\s+)?tables?\s+in\s+(?:the\s+)?(\S+)/i,
            /tables?\s+(?:in|for|of)\s+(?:the\s+)?(\S+)\s+(?:module|program)/i,
            /(\S+)\s+(?:module|program)\s+tables?/i,
        ],
        intent: 'LIST_TABLES_IN_MODULE',
        division: 'DATA',
        extractName: true,
        searchBoost: ['occurs', 'indexed by', 'exec sql', 'fd']
    },
    {
        patterns: [
            /(?:show|list|find|get)\s+(?:all\s+)?tables?$/i,
            /(?:show|list|find|get)\s+(?:all\s+)?(?:cobol\s+)?tables?/i,
            /what\s+tables?\s+(?:are\s+)?(?:defined|used)/i,
        ],
        intent: 'LIST_ALL_TABLES',
        division: 'DATA',
        extractName: false,
        searchBoost: ['occurs', 'indexed by']
    },
    {
        patterns: [
            /(?:show|list|find|get)\s+(?:all\s+)?(?:sql|db2|database)\s+tables?/i,
            /what\s+(?:sql|db2)\s+tables?/i,
        ],
        intent: 'LIST_SQL_TABLES',
        division: 'PROCEDURE',
        extractName: false,
        searchBoost: ['exec sql', 'from', 'into']
    },
    {
        patterns: [
            /where\s+is\s+(\S+)\s+defined/i,
            /definition\s+of\s+(\S+)/i,
            /find\s+(\S+)\s+definition/i,
        ],
        intent: 'FIND_DEFINITION',
        division: 'DATA',
        extractName: true,
        searchBoost: ['01', '77', 'pic', 'working-storage', 'copy']
    },
    {
        patterns: [
            /who\s+calls\s+(\S+)/i,
            /what\s+calls\s+(\S+)/i,
            /callers?\s+of\s+(\S+)/i,
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
        ],
        intent: 'FIND_CALLEES',
        division: 'PROCEDURE',
        extractName: true,
        searchBoost: ['perform', 'call using']
    },
    {
        patterns: [
            /copybooks?/i,
            /copy\s+statements?/i,
            /what\s+copybooks?/i,
        ],
        intent: 'FIND_COPYBOOKS',
        division: 'DATA',
        extractName: false,
        searchBoost: ['copy', '.cpy']
    },
    {
        patterns: [
            /list\s+(?:all\s+)?(?:paragraphs?|sections?)/i,
            /show\s+(?:all\s+)?(?:paragraphs?|sections?)/i,
        ],
        intent: 'LIST_PARAGRAPHS',
        division: 'PROCEDURE',
        extractName: false,
        searchBoost: ['paragraph', 'section', 'perform']
    },
    {
        patterns: [
            /how\s+(?:does|is)\s+(\S+)\s+(?:work|processed|validated)/i,
            /explain\s+(\S+)/i,
        ],
        intent: 'EXPLAIN_LOGIC',
        division: 'PROCEDURE',
        extractName: true,
        searchBoost: ['perform', 'if', 'evaluate', 'compute']
    },
    {
        patterns: [
            /error\s+handling/i,
            /exception\s+handling/i,
        ],
        intent: 'FIND_ERROR_HANDLING',
        division: 'PROCEDURE',
        extractName: false,
        searchBoost: ['on exception', 'invalid key', 'sqlcode']
    },
];

const SQL_KEYWORDS = new Set([
    'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'NULL', 'INTO',
    'VALUES', 'SET', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'ON',
    'ORDER', 'BY', 'GROUP', 'HAVING', 'DISTINCT', 'AS', 'CURSOR',
    'FETCH', 'OPEN', 'CLOSE', 'DECLARE', 'TABLE', 'INDEX', 'VIEW'
]);

const DIVISION_KEYWORDS = new Set([
    'IDENTIFICATION', 'ENVIRONMENT', 'DATA', 'PROCEDURE',
    'CONFIGURATION', 'INPUT-OUTPUT', 'FILE', 'WORKING-STORAGE',
    'LOCAL-STORAGE', 'LINKAGE', 'FILE-CONTROL', 'DECLARATIVES'
]);

const COMMON_WORDS = new Set([
    'THE', 'AND', 'FOR', 'WITH', 'ALL', 'THIS', 'THAT', 'WHAT',
    'WHERE', 'WHEN', 'HOW', 'WHO', 'WHY', 'SHOW', 'FIND', 'LIST',
    'GET', 'ARE', 'NOT', 'FROM', 'INTO', 'DOES', 'HAVE', 'TABLES',
    'TABLE', 'MODULE', 'PROGRAM', 'FILE', 'FILES'
]);


// ============================================================
// COBOL QUERY CLASSIFIER CLASS
// ============================================================

class CobolQueryClassifier {
    constructor(options = {}) {
        this.log = options.log || console.log;
        
        this.learnedPatterns = {
            programNames: new Set(),
            paragraphNames: new Set(),
            dataItemNames: new Set(),
            copybookNames: new Set(),
            tableNames: new Set(),
            fileNames: new Set(),
        };
        
        // PRE-INDEXED TABLES - extracted ONCE during learnFromCodebase
        this.indexedTables = {
            cobolTables: [],
            sqlTables: [],
            fileRecords: [],
            byFile: new Map(),
            byModule: new Map(),
        };
        
        this.initialized = false;
    }

    /**
     * Learn from codebase and PRE-INDEX all tables
     * Tables are extracted ONCE here, not on every query
     */
    learnFromCodebase(contextFiles, codeIndex) {
        this.log('CobolQueryClassifier: Learning from codebase...');
        const startTime = Date.now();
        
        let programCount = 0, paragraphCount = 0, dataItemCount = 0;
        let copybookCount = 0, cobolTableCount = 0, sqlTableCount = 0;
        
        // Clear previous data
        this.learnedPatterns = {
            programNames: new Set(),
            paragraphNames: new Set(),
            dataItemNames: new Set(),
            copybookNames: new Set(),
            tableNames: new Set(),
            fileNames: new Set(),
        };
        
        this.indexedTables = {
            cobolTables: [],
            sqlTables: [],
            fileRecords: [],
            byFile: new Map(),
            byModule: new Map(),
        };
        
        for (const [filePath, file] of contextFiles) {
            const content = file.content || '';
            const language = (file.language || '').toLowerCase();
            
            if (!this._isCobolFile(filePath, language)) continue;
            
            const fileName = filePath.split('/').pop() || filePath;
            const fileNameUpper = fileName.toUpperCase();
            
            this.indexedTables.byFile.set(filePath, {
                cobolTables: [],
                sqlTables: [],
                fileRecords: []
            });
            
            // Extract PROGRAM-ID
            const progMatch = content.match(/PROGRAM-ID\.\s+([A-Z0-9-]+)/i);
            if (progMatch) {
                const progName = progMatch[1].toUpperCase();
                this.learnedPatterns.programNames.add(progName);
                programCount++;
                
                if (!this.indexedTables.byModule.has(progName)) {
                    this.indexedTables.byModule.set(progName, []);
                }
                this.indexedTables.byModule.get(progName).push(filePath);
            }
            
            // Map by file name
            const baseFileName = fileNameUpper.replace(/\.(CBL|COB|COBOL|CPY|TXT)$/i, '');
            if (baseFileName) {
                if (!this.indexedTables.byModule.has(baseFileName)) {
                    this.indexedTables.byModule.set(baseFileName, []);
                }
                if (!this.indexedTables.byModule.get(baseFileName).includes(filePath)) {
                    this.indexedTables.byModule.get(baseFileName).push(filePath);
                }
            }
            
            // Extract paragraphs
            let match;
            const paragraphPattern = /^[\s]{0,6}([A-Z][A-Z0-9-]{2,})\.\s*$/gm;
            while ((match = paragraphPattern.exec(content))) {
                const name = match[1].toUpperCase();
                if (!DIVISION_KEYWORDS.has(name)) {
                    this.learnedPatterns.paragraphNames.add(name);
                    paragraphCount++;
                }
            }
            
            // Extract data items
            const dataPattern = /^\s*(01|77|05|10|15|20|88)\s+([A-Z][A-Z0-9-]+)/gm;
            while ((match = dataPattern.exec(content))) {
                const name = match[2].toUpperCase();
                if (name !== 'FILLER') {
                    this.learnedPatterns.dataItemNames.add(name);
                    dataItemCount++;
                }
            }
            
            // Extract copybooks
            const copyPattern = /COPY\s+([A-Z0-9-]+)/gi;
            while ((match = copyPattern.exec(content))) {
                this.learnedPatterns.copybookNames.add(match[1].toUpperCase());
                copybookCount++;
            }
            
            // PRE-INDEX: COBOL Tables (OCCURS)
            const occursPattern = /^\s*(\d{2})\s+([A-Z][A-Z0-9-]+)[^\n]*?OCCURS\s+(\d+)(?:\s+TO\s+(\d+))?\s+TIMES?(?:[^\n]*?DEPENDING\s+ON\s+([A-Z][A-Z0-9-]+))?(?:[^\n]*?INDEXED\s+BY\s+([A-Z][A-Z0-9-,\s]+))?/gim;
            
            while ((match = occursPattern.exec(content))) {
                const table = {
                    level: parseInt(match[1]),
                    name: match[2].toUpperCase(),
                    minOccurs: parseInt(match[3]),
                    maxOccurs: match[4] ? parseInt(match[4]) : parseInt(match[3]),
                    dependingOn: match[5]?.toUpperCase() || null,
                    indexes: match[6] ? match[6].toUpperCase().split(/[\s,]+/).filter(i => i) : [],
                    file: filePath,
                    fileName: fileName,
                    line: content.substring(0, match.index).split('\n').length,
                };
                
                this.indexedTables.cobolTables.push(table);
                this.indexedTables.byFile.get(filePath).cobolTables.push(table);
                cobolTableCount++;
            }
            
            // PRE-INDEX: SQL Tables
            const sqlPatterns = [
                { regex: /\bFROM\s+([A-Z][A-Z0-9_]+)/gi, operation: 'SELECT' },
                { regex: /\bJOIN\s+([A-Z][A-Z0-9_]+)/gi, operation: 'JOIN' },
                { regex: /\bINTO\s+([A-Z][A-Z0-9_]+)/gi, operation: 'INSERT' },
                { regex: /\bUPDATE\s+([A-Z][A-Z0-9_]+)/gi, operation: 'UPDATE' },
                { regex: /\bDELETE\s+FROM\s+([A-Z][A-Z0-9_]+)/gi, operation: 'DELETE' },
            ];
            
            const sqlTablesInFile = new Map();
            for (const { regex, operation } of sqlPatterns) {
                regex.lastIndex = 0;
                while ((match = regex.exec(content))) {
                    const tableName = match[1].toUpperCase();
                    if (SQL_KEYWORDS.has(tableName) || tableName.includes('-')) continue;
                    
                    if (!sqlTablesInFile.has(tableName)) {
                        sqlTablesInFile.set(tableName, {
                            name: tableName,
                            operations: new Set(),
                            lines: [],
                            file: filePath,
                            fileName: fileName,
                        });
                    }
                    sqlTablesInFile.get(tableName).operations.add(operation);
                    sqlTablesInFile.get(tableName).lines.push(
                        content.substring(0, match.index).split('\n').length
                    );
                }
            }
            
            for (const [tableName, info] of sqlTablesInFile) {
                const table = {
                    name: info.name,
                    operations: Array.from(info.operations),
                    line: info.lines[0] || 1,
                    file: filePath,
                    fileName: fileName,
                };
                this.indexedTables.sqlTables.push(table);
                this.indexedTables.byFile.get(filePath).sqlTables.push(table);
                this.learnedPatterns.tableNames.add(tableName);
                sqlTableCount++;
            }
            
            // PRE-INDEX: FD records
            const fdPattern = /\bFD\s+([A-Z][A-Z0-9-]+)/gi;
            while ((match = fdPattern.exec(content))) {
                const fdName = match[1].toUpperCase();
                this.learnedPatterns.fileNames.add(fdName);
                const rec = {
                    name: fdName,
                    file: filePath,
                    fileName: fileName,
                    line: content.substring(0, match.index).split('\n').length,
                };
                this.indexedTables.fileRecords.push(rec);
                this.indexedTables.byFile.get(filePath).fileRecords.push(rec);
            }
        }
        
        this.initialized = true;
        const elapsed = Date.now() - startTime;
        this.log(`CobolQueryClassifier: Learned in ${elapsed}ms - ${programCount} programs, ${cobolTableCount} COBOL tables, ${sqlTableCount} SQL tables`);
        
        return {
            programs: this.learnedPatterns.programNames.size,
            paragraphs: this.learnedPatterns.paragraphNames.size,
            dataItems: this.learnedPatterns.dataItemNames.size,
            copybooks: this.learnedPatterns.copybookNames.size,
            indexedCobolTables: this.indexedTables.cobolTables.length,
            indexedSqlTables: this.indexedTables.sqlTables.length,
        };
    }

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
        
        const normalizedQuery = query.trim();
        
        for (const intentDef of COBOL_QUERY_INTENTS) {
            for (const pattern of intentDef.patterns) {
                const match = normalizedQuery.match(pattern);
                if (match) {
                    result.intent = intentDef.intent;
                    result.division = intentDef.division;
                    result.searchBoost = [...intentDef.searchBoost];
                    result.confidence = 0.8;
                    
                    if (intentDef.extractName && match[1]) {
                        const name = match[1].toUpperCase().replace(/['"]/g, '');
                        if (!COMMON_WORDS.has(name)) {
                            result.extractedNames.push(name);
                        }
                    }
                    break;
                }
            }
            if (result.intent !== 'GENERAL_SEARCH') break;
        }
        
        const cobolNames = this._extractCobolNames(normalizedQuery);
        for (const name of cobolNames) {
            if (!result.extractedNames.includes(name)) {
                result.extractedNames.push(name);
            }
        }
        
        for (const name of result.extractedNames) {
            if (this.learnedPatterns.paragraphNames.has(name)) {
                result.cobolContext.isParagraph = true;
            }
            if (this.learnedPatterns.dataItemNames.has(name)) {
                result.cobolContext.isDataItem = true;
            }
            if (this.learnedPatterns.tableNames.has(name)) {
                result.cobolContext.isSqlTable = true;
            }
            if (this.learnedPatterns.programNames.has(name)) {
                result.cobolContext.isProgram = true;
            }
        }
        
        result.expandedTerms = this._expandTerms(normalizedQuery);
        for (const name of result.extractedNames) {
            if (!result.expandedTerms.includes(name)) {
                result.expandedTerms.push(name);
            }
            result.expandedTerms.push(`PERFORM ${name}`);
        }
        
        result.expandedTerms = [...new Set(result.expandedTerms)];
        result.searchBoost = [...new Set(result.searchBoost)];
        
        return result;
    }

    // ============================================================
    // TABLE QUERY METHODS - Use pre-indexed data, NO FILE SCANNING
    // ============================================================

    getAllTables() {
        return {
            cobolTables: this.indexedTables.cobolTables,
            sqlTables: this.indexedTables.sqlTables,
            fileRecords: this.indexedTables.fileRecords,
            summary: {
                cobolTableCount: this.indexedTables.cobolTables.length,
                sqlTableCount: this.indexedTables.sqlTables.length,
                fileRecordCount: this.indexedTables.fileRecords.length,
            }
        };
    }

    getTablesInModule(moduleName) {
        const moduleUpper = moduleName.toUpperCase();
        const result = {
            module: moduleName,
            matchedFiles: [],
            cobolTables: [],
            sqlTables: [],
            fileRecords: [],
        };
        
        let files = this.indexedTables.byModule.get(moduleUpper) || [];
        
        if (files.length === 0) {
            for (const [modName, modFiles] of this.indexedTables.byModule) {
                if (modName.includes(moduleUpper) || moduleUpper.includes(modName)) {
                    files = [...files, ...modFiles.filter(f => !files.includes(f))];
                }
            }
        }
        
        result.matchedFiles = [...files];
        
        for (const filePath of files) {
            const fileData = this.indexedTables.byFile.get(filePath);
            if (fileData) {
                result.cobolTables.push(...fileData.cobolTables);
                result.sqlTables.push(...fileData.sqlTables);
                result.fileRecords.push(...fileData.fileRecords);
            }
        }
        
        return result;
    }

    searchTables(pattern) {
        const regex = new RegExp(pattern, 'i');
        return {
            cobolTables: this.indexedTables.cobolTables.filter(t => regex.test(t.name)),
            sqlTables: this.indexedTables.sqlTables.filter(t => regex.test(t.name)),
            fileRecords: this.indexedTables.fileRecords.filter(t => regex.test(t.name)),
        };
    }

    getTablesInFile(filePath) {
        return this.indexedTables.byFile.get(filePath) || {
            cobolTables: [], sqlTables: [], fileRecords: []
        };
    }

    // ============================================================
    // PRIVATE HELPERS
    // ============================================================

    _isCobolFile(filePath, language) {
        if (['cobol', 'cbl', 'cob'].includes(language)) return true;
        const ext = (filePath || '').toLowerCase().split('.').pop();
        return ['cbl', 'cob', 'cobol', 'cpy', 'copy'].includes(ext);
    }

    _extractCobolNames(query) {
        const names = [];
        const pattern = /\b([A-Z][A-Z0-9-]{2,})\b/g;
        const queryUpper = query.toUpperCase();
        let match;
        
        while ((match = pattern.exec(queryUpper))) {
            const name = match[1];
            if (!COMMON_WORDS.has(name) && !DIVISION_KEYWORDS.has(name)) {
                names.push(name);
            }
        }
        return [...new Set(names)];
    }

    _expandTerms(query) {
        const terms = [query];
        const words = query.toLowerCase().split(/\s+/);
        
        for (const word of words) {
            if (COBOL_SYNONYMS[word]) {
                terms.push(...COBOL_SYNONYMS[word]);
            }
        }
        return [...new Set(terms)].slice(0, 15);
    }
}

module.exports = {
    CobolQueryClassifier,
    COBOL_SYNONYMS,
    COBOL_DIVISIONS,
    COBOL_QUERY_INTENTS,
    SQL_KEYWORDS,
    DIVISION_KEYWORDS,
};
