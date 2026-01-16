/**
 * AstraCode Search Module v5.1
 * Modular search with Overview/Detailed modes, O(1) indexes, and optional vector (semantic) search
 */

// All callable types across languages (matches generateCodeSummaries in extension.js)
const CALLABLE_TYPES = new Set([
    'function', 'procedure', 'method', 'subproc',  // Common: C, Java, TAL
    'section', 'paragraph', 'program',              // COBOL
    'trigger',                                      // SQL
    'define', 'macro',                              // Preprocessor
    'forward', 'external'                           // TAL declarations
]);

let codeIndex = null;
let trigramIndex = null;
let vectorIndex = null;
let contextFiles = null;
let pathUtils = null;
let log = console.log;
let showProgress = () => {};

// New index structures
const symbolTrigramIndex = new Map();
const fileTrigramIndex = new Map();
const fileNameIndex = new Map();
const fileExtensionIndex = new Map();
const fileDirectoryIndex = new Map();
const moduleSummaryIndex = new Map();

let searchMode = 'detailed';

function initialize(codeIdx, trigramIdx, vectorIdx, ctxFiles, pathUtil, logFn, progressFn) {
    codeIndex = codeIdx;
    trigramIndex = trigramIdx;
    vectorIndex = vectorIdx;
    contextFiles = ctxFiles;
    pathUtils = pathUtil;
    if (logFn) log = logFn;
    if (progressFn) showProgress = progressFn;
    log('Search module initialized');
}

function buildSearchIndexes() {
    const start = Date.now();
    buildSymbolTrigramIndex();
    buildFileIndexes();
    buildModuleSummaryIndex();
    log(`Search indexes built in ${Date.now() - start}ms`);
    return { symbolTrigrams: symbolTrigramIndex.size, fileNames: fileNameIndex.size, modules: moduleSummaryIndex.size };
}

function buildSymbolTrigramIndex() {
    symbolTrigramIndex.clear();
    for (const [key, symbol] of codeIndex.symbols) {
        if (!key.includes('@')) continue;
        for (const tri of extractTrigrams(symbol.name.toLowerCase())) {
            if (!symbolTrigramIndex.has(tri)) symbolTrigramIndex.set(tri, new Set());
            symbolTrigramIndex.get(tri).add(key);
        }
    }
}

function buildFileIndexes() {
    fileTrigramIndex.clear();
    fileNameIndex.clear();
    fileExtensionIndex.clear();
    fileDirectoryIndex.clear();
    
    for (const [filePath] of contextFiles) {
        const fileName = pathUtils.getFileName(filePath).toLowerCase();
        const ext = pathUtils.getExtension(filePath).toLowerCase();
        const dir = pathUtils.getParentDir(filePath);
        
        if (!fileNameIndex.has(fileName)) fileNameIndex.set(fileName, []);
        fileNameIndex.get(fileName).push(filePath);
        
        if (ext) {
            if (!fileExtensionIndex.has(ext)) fileExtensionIndex.set(ext, []);
            fileExtensionIndex.get(ext).push(filePath);
        }
        
        if (dir) {
            if (!fileDirectoryIndex.has(dir)) fileDirectoryIndex.set(dir, []);
            fileDirectoryIndex.get(dir).push(filePath);
        }
        
        for (const tri of extractTrigrams(pathUtils.getBaseName(filePath).toLowerCase())) {
            if (!fileTrigramIndex.has(tri)) fileTrigramIndex.set(tri, new Set());
            fileTrigramIndex.get(tri).add(filePath);
        }
    }
}

function buildModuleSummaryIndex() {
    moduleSummaryIndex.clear();
    const dirFiles = new Map();
    for (const [filePath, summary] of codeIndex.fileSummaries) {
        const dir = pathUtils.getParentDir(filePath);
        if (!dir) continue;
        if (!dirFiles.has(dir)) dirFiles.set(dir, []);
        dirFiles.get(dir).push({ file: filePath, name: pathUtils.getFileName(filePath), summary });
    }
    
    for (const [dir, files] of dirFiles) {
        let funcCount = 0;
        for (const [key, symbol] of codeIndex.symbols) {
            if (key.includes('@') && symbol.file && pathUtils.getParentDir(symbol.file) === dir) {
                if (CALLABLE_TYPES.has(symbol.type)) funcCount++;
            }
        }
        moduleSummaryIndex.set(dir, {
            path: dir, name: pathUtils.getFileName(dir) || dir,
            summary: files.slice(0, 10).map(f => `${f.name}: ${f.summary}`).join('\n'),
            fileCount: files.length, functionCount: funcCount
        });
    }
}

function clearSearchIndexes() {
    symbolTrigramIndex.clear();
    fileTrigramIndex.clear();
    fileNameIndex.clear();
    fileExtensionIndex.clear();
    fileDirectoryIndex.clear();
    moduleSummaryIndex.clear();
}

// Layer 1: Atomic Lookups
function lookupSymbolByKey(key) { return codeIndex.symbols.get(key) || null; }
function lookupSymbolsByName(name) {
    const results = [], nameLower = name.toLowerCase();
    for (const [key, symbol] of codeIndex.symbols) {
        if (key.includes('@') && symbol.name.toLowerCase() === nameLower) results.push({ ...symbol, key });
    }
    return results;
}
function lookupFilesByName(fileName) { return fileNameIndex.get(fileName.toLowerCase()) || []; }
function lookupFilesByExtension(ext) { return fileExtensionIndex.get(ext.toLowerCase()) || []; }
function lookupFilesInDirectory(dir) { return fileDirectoryIndex.get(dir) || []; }
function lookupCallers(funcName) { const c = codeIndex.reverseCallGraph.get(funcName); return c ? Array.from(c) : []; }
function lookupCallees(funcName) { const c = codeIndex.callGraph.get(funcName); return c ? Array.from(c) : []; }
function lookupFunctionSummary(key) { return codeIndex.summaries.get(key) || null; }
function lookupFileSummary(filePath) { return codeIndex.fileSummaries.get(filePath) || null; }
function lookupModuleSummary(dir) { return moduleSummaryIndex.get(dir) || null; }

// Layer 2: Find Functions
function findSymbolsByPattern(pattern, options = {}) {
    const { type = null, maxResults = 50 } = options;
    const patternLower = pattern.toLowerCase();
    const trigrams = extractTrigrams(patternLower);
    
    if (trigrams.length === 0 || symbolTrigramIndex.size === 0) {
        return findSymbolsByPatternFallback(patternLower, type, maxResults);
    }
    
    let candidates = null;
    for (const tri of trigrams) {
        const matches = symbolTrigramIndex.get(tri);
        if (!matches || matches.size === 0) return [];
        candidates = candidates === null ? new Set(matches) : new Set([...candidates].filter(k => matches.has(k)));
        if (candidates.size === 0) return [];
    }
    
    const results = [];
    for (const key of candidates) {
        const symbol = codeIndex.symbols.get(key);
        if (!symbol || (type && symbol.type !== type)) continue;
        const score = fuzzyMatchScore(patternLower, symbol.name.toLowerCase());
        if (score >= 30) results.push({ ...symbol, key, matchScore: score });
    }
    return results.sort((a, b) => b.matchScore - a.matchScore).slice(0, maxResults);
}

function findSymbolsByPatternFallback(pattern, type, maxResults) {
    const results = [];
    for (const [key, symbol] of codeIndex.symbols) {
        if (!key.includes('@') || (type && symbol.type !== type)) continue;
        const score = fuzzyMatchScore(pattern, symbol.name.toLowerCase());
        if (score >= 30) results.push({ ...symbol, key, matchScore: score });
        if (results.length >= maxResults * 2) break;
    }
    return results.sort((a, b) => b.matchScore - a.matchScore).slice(0, maxResults);
}

function findSymbolsByType(type, options = {}) {
    const { inDirectory = null, maxResults = 100 } = options;
    const results = [];
    for (const [key, symbol] of codeIndex.symbols) {
        if (!key.includes('@') || symbol.type !== type) continue;
        if (inDirectory && pathUtils.getParentDir(symbol.file) !== inDirectory) continue;
        results.push({ ...symbol, key });
        if (results.length >= maxResults) break;
    }
    return results;
}

function findFilesByPattern(pattern, options = {}) {
    const { maxResults = 50 } = options;
    const patternLower = pattern.toLowerCase();
    const results = new Set();
    const exact = fileNameIndex.get(patternLower);
    if (exact) exact.forEach(p => results.add(p));
    
    if (patternLower.length >= 3) {
        for (const tri of extractTrigrams(patternLower)) {
            const matches = fileTrigramIndex.get(tri);
            if (matches) matches.forEach(m => {
                if (pathUtils.getBaseName(m).toLowerCase().includes(patternLower)) results.add(m);
            });
        }
    }
    return Array.from(results).slice(0, maxResults);
}

function findTextInCode(text, options = {}) {
    const { caseSensitive = false, maxResults = 50 } = options;
    if (text.length < 3 || !trigramIndex || trigramIndex.index.size === 0) return [];
    
    const searchTrigrams = extractTrigrams(caseSensitive ? text : text.toLowerCase());
    if (searchTrigrams.length === 0) return [];
    
    let candidateFiles = null;
    for (const tri of searchTrigrams) {
        const fileList = trigramIndex.index.get(tri);
        if (!fileList || fileList.length === 0) return [];
        const files = new Set(fileList.map(f => f.file));
        candidateFiles = candidateFiles === null ? files : new Set([...candidateFiles].filter(f => files.has(f)));
        if (candidateFiles.size === 0) return [];
    }
    
    const results = [], query = caseSensitive ? text : text.toLowerCase();
    for (const filePath of candidateFiles) {
        const file = contextFiles.get(filePath);
        if (!file) continue;
        const content = caseSensitive ? file.content : file.content.toLowerCase();
        const lines = file.content.split('\n');
        
        // Pre-compute line start positions for efficient lookup
        const lineStarts = [0];
        for (let i = 0; i < lines.length; i++) {
            lineStarts.push(lineStarts[i] + lines[i].length + 1); // +1 for newline
        }
        
        let pos = 0;
        while ((pos = content.indexOf(query, pos)) !== -1) {
            // Binary search for line number
            let lo = 0, hi = lines.length - 1;
            while (lo < hi) {
                const mid = Math.floor((lo + hi + 1) / 2);
                if (lineStarts[mid] <= pos) lo = mid;
                else hi = mid - 1;
            }
            const lineNum = lo;
            results.push({ file: filePath, fileName: pathUtils.getFileName(filePath), line: lineNum + 1, context: lines[lineNum]?.substring(0, 150) || '' });
            pos += query.length;
            if (results.length >= maxResults) break;
        }
        if (results.length >= maxResults) break;
    }
    return results;
}

function findModulesByPattern(pattern, options = {}) {
    const { maxResults = 20 } = options;
    const patternLower = pattern.toLowerCase();
    const results = [];
    for (const [dir, modInfo] of moduleSummaryIndex) {
        if (modInfo.name.toLowerCase().includes(patternLower) || dir.toLowerCase().includes(patternLower)) {
            results.push(modInfo);
            if (results.length >= maxResults) break;
        }
    }
    return results;
}

// New: Vector-based symbol search
function cosineSimilarity(vecA, vecB) {
    if (vecA.length !== vecB.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dot += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function findSymbolsByVector(queryVector, options = {}) {
    const { maxResults = 50, minSimilarity = 0.35 } = options;
    if (!vectorIndex || vectorIndex.size === 0 || !Array.isArray(queryVector) || queryVector.length === 0) return [];

    const results = [];
    for (const [key, vec] of vectorIndex) {
        if (!Array.isArray(vec)) continue;
        const symbol = lookupSymbolByKey(key);
        if (!symbol || !key.includes('@')) continue;

        const similarity = cosineSimilarity(queryVector, vec);
        if (similarity >= minSimilarity) {
            results.push({ ...symbol, key, matchScore: Math.round(similarity * 100) });
        }
    }

    results.sort((a, b) => b.matchScore - a.matchScore);
    return results.slice(0, maxResults);
}

// Layer 3: Get Functions
function getCodeLines(filePath, startLine, endLine) {
    const file = contextFiles.get(filePath);
    if (!file) return '';
    const lines = file.content.split('\n');
    const start = Math.max(0, startLine - 1), end = Math.min(lines.length - 1, endLine - 1);
    return lines.slice(start, end + 1).map((line, i) => `${(start + i + 1).toString().padStart(5)}: ${line}`).join('\n');
}

function getCodeBlockForSymbol(symbol, options = {}) {
    const { contextBefore = 2, contextAfter = 30 } = options;
    const file = contextFiles.get(symbol.file);
    if (!file) return { code: '', startLine: 0, endLine: 0, fileName: '' };
    const lines = file.content.split('\n');
    const startLine = Math.max(1, symbol.line - contextBefore);
    const endLine = Math.min(lines.length, symbol.line + contextAfter);
    return { code: getCodeLines(symbol.file, startLine, endLine), startLine, endLine, fileName: pathUtils.getFileName(symbol.file) };
}

function getCodeBlockForMatch(filePath, matchLine, options = {}) {
    const { contextLines = 8 } = options;
    const file = contextFiles.get(filePath);
    if (!file) return { code: '', startLine: 0, endLine: 0, fileName: '' };
    const lines = file.content.split('\n');
    const startLine = Math.max(1, matchLine - contextLines);
    const endLine = Math.min(lines.length, matchLine + contextLines);
    const code = lines.slice(startLine - 1, endLine).map((line, i) => {
        const lineNum = startLine + i;
        return `${lineNum.toString().padStart(5)}: ${lineNum === matchLine ? '>>> ' : '    '}${line}`;
    }).join('\n');
    return { code, startLine, endLine, fileName: pathUtils.getFileName(filePath) };
}

function getSymbolsInFile(filePath) {
    const results = [];
    for (const [key, symbol] of codeIndex.symbols) {
        if (key.includes('@') && symbol.file === filePath) results.push({ ...symbol, key });
    }
    return results.sort((a, b) => a.line - b.line);
}

// Layer 4: Trace Functions
function traceCallersOf(funcName, options = {}) {
    const { maxDepth = 3 } = options;
    const visited = new Set([funcName]), levels = [];
    let current = [funcName];
    for (let d = 0; d < maxDepth; d++) {
        const next = [];
        for (const fn of current) {
            for (const caller of lookupCallers(fn)) {
                if (!visited.has(caller)) { visited.add(caller); next.push(caller); }
            }
        }
        if (next.length === 0) break;
        levels.push(next);
        current = next;
    }
    return { root: funcName, direction: 'callers', levels };
}

function traceCalleesOf(funcName, options = {}) {
    const { maxDepth = 3 } = options;
    const visited = new Set([funcName]), levels = [];
    let current = [funcName];
    for (let d = 0; d < maxDepth; d++) {
        const next = [];
        for (const fn of current) {
            for (const callee of lookupCallees(fn)) {
                if (!visited.has(callee)) { visited.add(callee); next.push(callee); }
            }
        }
        if (next.length === 0) break;
        levels.push(next);
        current = next;
    }
    return { root: funcName, direction: 'callees', levels };
}

// Layer 5: Composite Searches
function searchWhereIsDefined(name) {
    const symbols = findSymbolsByPattern(name, { maxResults: 20 });
    const codeBlocks = symbols.slice(0, 10).map(sym => ({ symbol: sym, ...getCodeBlockForSymbol(sym) }));
    return { symbols, codeBlocks };
}

function searchWhoCallsFunction(funcName) {
    const symbols = findSymbolsByPattern(funcName, { maxResults: 5 });
    const funcSymbol = symbols.find(s => CALLABLE_TYPES.has(s.type));
    if (!funcSymbol) return { function: null, callers: [], callerDetails: [], codeBlocks: [] };
    
    const callers = lookupCallers(funcSymbol.name);
    const callerDetails = callers.map(c => lookupSymbolsByName(c)[0]).filter(Boolean);
    const codeBlocks = callerDetails.slice(0, 8).map(c => ({ caller: c.name, ...getCodeBlockForSymbol(c, { contextAfter: 20 }) }));
    const funcBlock = getCodeBlockForSymbol(funcSymbol);
    return { function: funcSymbol, functionCode: funcBlock, callers, callerDetails, codeBlocks };
}

function searchWhatFunctionCalls(funcName) {
    const symbols = findSymbolsByPattern(funcName, { maxResults: 5 });
    const funcSymbol = symbols.find(s => CALLABLE_TYPES.has(s.type));
    if (!funcSymbol) return { function: null, callees: [], calleeDetails: [] };
    
    const callees = lookupCallees(funcSymbol.name);
    const calleeDetails = callees.map(c => lookupSymbolsByName(c)[0]).filter(Boolean);
    const funcBlock = getCodeBlockForSymbol(funcSymbol, { contextAfter: 50 });
    return { function: funcSymbol, functionCode: funcBlock, callees, calleeDetails };
}

function searchTextInCode(text, options = {}) {
    const { contextLines = 8 } = options;
    const matches = findTextInCode(text, { maxResults: 30 });
    const codeBlocks = [], seen = new Set();
    for (const match of matches) {
        const key = `${match.file}:${Math.floor(match.line / 10)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        codeBlocks.push({ file: match.file, matchLine: match.line, ...getCodeBlockForMatch(match.file, match.line, { contextLines }) });
    }
    return { matches, codeBlocks };
}

function searchModuleOverview(moduleName) {
    const modules = findModulesByPattern(moduleName);
    if (modules.length === 0) return { module: null, files: [], functions: [], summary: null };
    const module = modules[0];
    const files = lookupFilesInDirectory(module.path).map(f => ({ path: f, name: pathUtils.getFileName(f), summary: lookupFileSummary(f) }));
    
    // Get all callable types (not just function/procedure)
    const functions = [];
    for (const type of CALLABLE_TYPES) {
        functions.push(...findSymbolsByType(type, { inDirectory: module.path }));
    }
    const functionDetails = functions.slice(0, 30).map(fn => ({ ...fn, summary: lookupFunctionSummary(fn.key)?.summary }));
    return { module, files, functions: functionDetails, summary: module.summary };
}

// Layer 6: Orchestrators
function executeOverviewSearch(query, options = {}) {
    const terms = extractSearchTerms(query);
    const results = { type: 'overview', modules: [], files: [], functions: [], callFlows: [] };
    
    for (const term of terms) {
        for (const mod of findModulesByPattern(term, { maxResults: 5 })) {
            if (!results.modules.some(m => m.path === mod.path)) results.modules.push(mod);
        }
    }
    
    for (const [filePath, summary] of codeIndex.fileSummaries) {
        if (matchesTerms(summary + ' ' + pathUtils.getFileName(filePath), terms)) {
            results.files.push({ file: filePath, name: pathUtils.getFileName(filePath), summary });
        }
    }
    results.files = results.files.slice(0, 20);
    
    for (const [key, info] of codeIndex.summaries) {
        if (matchesTerms(info.summary + ' ' + info.name, terms)) results.functions.push(info);
    }
    results.functions = results.functions.slice(0, 30);
    
    // Add semantically similar functions if queryVector provided
    if (options.queryVector) {
        const vectorSyms = findSymbolsByVector(options.queryVector, { maxResults: 40, minSimilarity: 0.35 });
        const existingNames = new Set(results.functions.map(f => f.name));
        for (const vsym of vectorSyms) {
            if (CALLABLE_TYPES.has(vsym.type)) {
                const info = codeIndex.summaries.get(vsym.key);
                if (info && !existingNames.has(info.name)) {
                    results.functions.push(info);
                    existingNames.add(info.name);
                }
            }
        }
        results.functions = results.functions.slice(0, 30); // re-cap
    }
    
    for (const fn of results.functions.slice(0, 5)) {
        const callers = lookupCallers(fn.name), callees = lookupCallees(fn.name);
        if (callers.length || callees.length) results.callFlows.push({ name: fn.name, callers, callees });
    }
    
    return { ...results, context: formatOverviewResults(results) };
}

function executeDetailedSearch(query, options = {}) {
    const terms = extractSearchTerms(query);
    const results = { type: 'detailed', symbols: [], codeBlocks: [], callTraces: [] };
    
    for (const term of terms) {
        for (const sym of findSymbolsByPattern(term, { maxResults: 15 })) {
            if (!results.symbols.some(s => s.key === sym.key)) results.symbols.push(sym);
        }
    }
    
    for (const term of terms) {
        for (const filePath of findFilesByPattern(term, { maxResults: 10 })) {
            for (const sym of getSymbolsInFile(filePath).slice(0, 10)) {
                if (!results.symbols.some(s => s.key === sym.key)) results.symbols.push({ ...sym, matchScore: 85 });
            }
        }
    }
    
    // Merge with vector results and sort by relevance
    const symMap = new Map();
    for (const sym of results.symbols) {
        const score = sym.matchScore || 80;
        symMap.set(sym.key, { ...sym, matchScore: score });
    }
    
    if (options.queryVector) {
        const vectorSyms = findSymbolsByVector(options.queryVector, { maxResults: 60, minSimilarity: 0.35 });
        for (const vsym of vectorSyms) {
            const existing = symMap.get(vsym.key);
            const newScore = vsym.matchScore;
            if (!existing || newScore > (existing.matchScore || 0)) {
                symMap.set(vsym.key, vsym);
            }
        }
    }
    
    results.symbols = Array.from(symMap.values())
        .sort((a, b) => (b.matchScore || 80) - (a.matchScore || 80));
    
    const seen = new Set();
    for (const sym of results.symbols.slice(0, 20)) {
        const key = `${sym.file}:${Math.floor(sym.line / 15)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.codeBlocks.push({ symbol: sym.name, type: sym.type, ...getCodeBlockForSymbol(sym) });
    }
    
    if (/call|trace|who|where.*called|caller|callee/i.test(query)) {
        for (const sym of results.symbols.slice(0, 5)) {
            if (CALLABLE_TYPES.has(sym.type)) {
                results.callTraces.push({ name: sym.name, callers: lookupCallers(sym.name), callees: lookupCallees(sym.name) });
            }
        }
    }
    
    return { ...results, context: formatDetailedResults(results) };
}

async function executeSearch(query, options = {}) {
    const mode = options.mode || searchMode;
    const start = Date.now();
    const results = mode === 'overview' ? executeOverviewSearch(query, options) : executeDetailedSearch(query, options);
    results.elapsed = Date.now() - start;
    results.mode = mode;
    return results;
}

// Formatting
function formatOverviewResults(results) {
    let ctx = '# Search Results (Overview)\n\n';
    if (results.modules.length) {
        ctx += '## Modules\n';
        for (const m of results.modules) ctx += `### ${m.name}/ (${m.fileCount} files)\n${m.summary}\n\n`;
    }
    if (results.files.length) {
        ctx += '## Files\n';
        for (const f of results.files) ctx += `- **${f.name}**: ${f.summary}\n`;
        ctx += '\n';
    }
    if (results.functions.length) {
        ctx += '## Functions\n';
        for (const fn of results.functions) ctx += `- **${fn.name}**: ${fn.summary}\n`;
        ctx += '\n';
    }
    if (results.callFlows.length) {
        ctx += '## Call Relationships\n';
        for (const f of results.callFlows) {
            ctx += `**${f.name}**:\n`;
            if (f.callers.length) ctx += `  ← Called by: ${f.callers.join(', ')}\n`;
            if (f.callees.length) ctx += `  → Calls: ${f.callees.join(', ')}\n`;
        }
    }
    return ctx;
}

function formatDetailedResults(results) {
    let ctx = '# Search Results (Detailed)\n\n';
    if (results.symbols.length) {
        ctx += '## Symbols Found\n';
        for (const s of results.symbols.slice(0, 25)) {
            ctx += `- **${s.name}** (${s.type}) → ${pathUtils.getFileName(s.file)}:${s.line}\n`;
        }
        ctx += '\n';
    }
    if (results.codeBlocks.length) {
        ctx += '## Source Code\n\n';
        for (const b of results.codeBlocks.slice(0, 15)) {
            ctx += `### ${b.fileName} (lines ${b.startLine}-${b.endLine})${b.symbol ? ' - ' + b.symbol : ''}\n\`\`\`\n${b.code}\n\`\`\`\n\n`;
        }
    }
    if (results.callTraces.length) {
        ctx += '## Call Traces\n';
        for (const t of results.callTraces) {
            ctx += `**${t.name}**:\n`;
            if (t.callers.length) ctx += `  ← Called by: ${t.callers.slice(0, 8).join(', ')}\n`;
            if (t.callees.length) ctx += `  → Calls: ${t.callees.slice(0, 8).join(', ')}\n`;
        }
    }
    return ctx;
}

// Helpers
function extractTrigrams(text) {
    const tris = [];
    for (let i = 0; i <= text.length - 3; i++) {
        const tri = text.substring(i, i + 3);
        if (!/^\s+$/.test(tri)) tris.push(tri);
    }
    return tris;
}

function extractSearchTerms(query) {
    const stop = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'what', 'where', 'when', 'how', 'why', 'show', 'find', 'search', 'get', 'list', 'me', 'my', 'all', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'and', 'or', 'code', 'function', 'file', 'does', 'do']);
    const words = query.replace(/['"]/g, '').split(/[\s,;|]+/).filter(w => w.length >= 2);
    const terms = [];
    for (const word of words) {
        if (stop.has(word.toLowerCase())) continue;
        terms.push(word);
        const parts = word.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ').split(/\s+/);
        for (const part of parts.filter(p => p.length >= 3 && !stop.has(p.toLowerCase()))) {
            if (part !== word && !terms.includes(part)) terms.push(part);
        }
    }
    return terms.slice(0, 15);
}

function matchesTerms(text, terms) {
    const lower = text.toLowerCase();
    return terms.some(t => lower.includes(t.toLowerCase()));
}

function fuzzyMatchScore(query, target) {
    if (query === target) return 100;
    if (target.includes(query)) return 80 + Math.min(20, (query.length / target.length) * 20);
    if (target.startsWith(query)) return 75;
    const parts = target.replace(/[-_]/g, ' ').split(/\s+/);
    for (const part of parts) {
        if (part.includes(query)) return 60;
        if (part.startsWith(query)) return 55;
    }
    let qi = 0, matches = 0;
    for (let ti = 0; ti < target.length && qi < query.length; ti++) {
        if (target[ti] === query[qi]) { matches++; qi++; }
    }
    if (qi === query.length) return 30 + Math.min(20, (matches / target.length) * 20);
    return 0;
}

module.exports = {
    initialize, buildSearchIndexes, clearSearchIndexes,
    lookupSymbolByKey, lookupSymbolsByName, lookupFilesByName, lookupFilesByExtension,
    lookupFilesInDirectory, lookupCallers, lookupCallees, lookupFunctionSummary, lookupFileSummary, lookupModuleSummary,
    findSymbolsByPattern, findSymbolsByType, findFilesByPattern, findTextInCode, findModulesByPattern,
    findSymbolsByVector,
    getCodeLines, getCodeBlockForSymbol, getCodeBlockForMatch, getSymbolsInFile,
    traceCallersOf, traceCalleesOf,
    searchWhereIsDefined, searchWhoCallsFunction, searchWhatFunctionCalls, searchTextInCode, searchModuleOverview,
    executeOverviewSearch, executeDetailedSearch, executeSearch,
    extractTrigrams, extractSearchTerms, fuzzyMatchScore,
    get searchMode() { return searchMode; },
    set searchMode(v) { searchMode = v; },
    get symbolTrigramIndex() { return symbolTrigramIndex; },
    get fileTrigramIndex() { return fileTrigramIndex; },
    get moduleSummaryIndex() { return moduleSummaryIndex; }
};
