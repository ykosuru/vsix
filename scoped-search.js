/**
 * AstraCode Scoped Search
 * 
 * Integrates with existing webview chat UI.
 * 
 * CHAT COMMANDS:
 *   /grep <keywords>   - Find related files using grep full-text search
 *   /grep              - Show current scope status  
 *   /ungrep            - Exit scoped mode
 * 
 * SEARCH STRATEGY:
 *   1. Uses grep (full-text content search) as primary method
 *   2. Combines with vector search for semantic similarity
 *   3. Falls back to keyword matching if indexes unavailable
 */

// ============================================================
// STATE
// ============================================================

const scopeState = {
    isActive: false,
    query: '',
    files: new Set(),
    
    activate(query, files) {
        this.isActive = true;
        this.query = query;
        this.files = new Set(files);
    },
    
    deactivate() {
        this.isActive = false;
        this.query = '';
        this.files.clear();
    },
    
    addFiles(files) {
        for (const f of files) this.files.add(f);
    },
    
    hasFile(path) {
        return this.files.has(path);
    },
    
    getStatus() {
        return {
            isActive: this.isActive,
            query: this.query,
            fileCount: this.files.size,
            files: Array.from(this.files).map(p => ({
                path: p,
                name: p.split('/').pop()
            }))
        };
    },
    
    /**
     * Get scoped files as a Map (filtered from contextFiles)
     * Returns all contextFiles if scope is not active
     * @param {Map} contextFiles - The full context files map
     * @returns {Map} - Filtered map of scoped files
     */
    getScopedFiles(contextFiles) {
        if (!this.isActive || this.files.size === 0) {
            return contextFiles;
        }
        
        const scopedMap = new Map();
        
        // Build a set of file name suffixes for flexible matching
        // e.g., "/Users/x/postgres/src/backend/brin.c" -> ["brin.c", "backend/brin.c", ...]
        const scopeSuffixes = new Set();
        for (const p of this.files) {
            scopeSuffixes.add(p);
            const parts = p.split('/').filter(Boolean);
            for (let i = 0; i < Math.min(parts.length, 5); i++) {
                scopeSuffixes.add(parts.slice(-(i + 1)).join('/'));
            }
        }
        
        // Helper to check if a path matches
        const matchesScope = (filePath) => {
            if (scopeSuffixes.has(filePath)) return true;
            const parts = filePath.split('/').filter(Boolean);
            for (let i = 0; i < Math.min(parts.length, 5); i++) {
                if (scopeSuffixes.has(parts.slice(-(i + 1)).join('/'))) return true;
            }
            return false;
        };
        
        for (const [path, data] of contextFiles) {
            if (matchesScope(path)) {
                scopedMap.set(path, data);
            }
        }
        
        // Debug: show sample paths if nothing matched
        if (scopedMap.size === 0 && contextFiles.size > 0) {
            const contextSample = Array.from(contextFiles.keys()).slice(0, 3);
            const scopeSample = Array.from(this.files).slice(0, 3);
            console.log(`[getScopedFiles] No matches! Context paths: ${contextSample.join(', ')}`);
            console.log(`[getScopedFiles] Scope paths: ${scopeSample.join(', ')}`);
        }
        
        return scopedMap;
    }
};

// ============================================================
// FILE SEARCH
// ============================================================

/**
 * Find files matching query - uses grep + vector + LLM ranking
 * 
 * @param {string} query - User's scope query
 * @param {object} codebaseIndex - The codebase index with files and symbols
 * @param {object} options - Options including vectorIndex, vocabulary, grepIndex, llmClient, log
 */
async function findMatchingFiles(query, codebaseIndex, options = {}) {
    const { maxResults = 50, log = () => {}, invertedIndex = null, vectorIndex = null, vocabulary = null, grepIndex = null, llmClient = null } = options;
    
    // Safety check
    if (!codebaseIndex || !codebaseIndex.files) {
        log('[Scope] ERROR: codebaseIndex or codebaseIndex.files is null');
        return [];
    }
    
    log(`[Scope] Finding files for: "${query}"`);
    log(`[Scope] Files in index: ${codebaseIndex.files.size}`);
    
    const allResults = new Map(); // path -> result object
    
    // Method 1: Grep search (full-text content search) - MOST RELIABLE
    if (grepIndex && typeof grepIndex.searchLiteral === 'function') {
        log('[Scope] Trying grep search (full-text content)');
        const terms = parseTerms(query);
        
        // Separate phrases (contain spaces) from single words
        const phrases = terms.filter(t => t.includes(' '));
        const words = terms.filter(t => !t.includes(' '));
        
        if (phrases.length > 0) {
            log(`[Scope] Exact phrases: ${phrases.map(p => `"${p}"`).join(', ')}`);
        }
        if (words.length > 0) {
            log(`[Scope] Individual words: ${words.join(', ')}`);
        }
        
        // File extensions to include (code files only)
        const codeExtensions = new Set([
            'c', 'h', 'cpp', 'hpp', 'cc', 'cxx', 'hxx',
            'java', 'py', 'js', 'ts', 'jsx', 'tsx',
            'go', 'rs', 'rb', 'pl', 'pm', 'php',
            'cs', 'vb', 'swift', 'kt', 'scala',
            'cob', 'cbl', 'tal', 'pco'
        ]);
        
        // Track which phrases need fallback (found 0 results)
        const phraseFallbacks = [];
        
        // Helper to search a term and add results
        const searchTerm = (term, isPhrase, isFallbackWord = false, fallbackPhrase = null) => {
            try {
                const grepResults = grepIndex.searchLiteral(term, {
                    caseSensitive: false,
                    maxResults: 2000,
                    includeContext: false
                });
                
                if (grepResults && grepResults.results && grepResults.results.length > 0) {
                    log(`[Scope] Grep found ${grepResults.results.length} matches for ${isPhrase ? `"${term}"` : term}${isFallbackWord ? ' (fallback)' : ''}`);
                    
                    // Aggregate by file
                    const fileCounts = new Map();
                    for (const r of grepResults.results) {
                        const fileName = r.file.split('/').pop();
                        const ext = fileName.split('.').pop()?.toLowerCase();
                        if (!codeExtensions.has(ext)) continue;
                        
                        const count = fileCounts.get(r.file) || 0;
                        fileCounts.set(r.file, count + 1);
                    }
                    
                    log(`[Scope] Grep aggregated to ${fileCounts.size} code files`);
                    
                    // Add files to results
                    for (const [filePath, matchCount] of fileCounts) {
                        const fileName = filePath.split('/').pop();
                        
                        // Scoring: phrases > words, fallback words track which phrase they came from
                        const baseScore = isPhrase ? 65 : (isFallbackWord ? 55 : 50);
                        const score = Math.round(baseScore + Math.log2(matchCount + 1) * 6);
                        
                        if (allResults.has(filePath)) {
                            const existing = allResults.get(filePath);
                            existing.score = Math.max(existing.score, score) + 15;
                            existing.grepMatches = (existing.grepMatches || 0) + matchCount;
                            existing.source = existing.source === 'vector' ? 'grep+vector' : 
                                             existing.source.includes('grep') ? existing.source : 'grep+' + existing.source;
                            // Track fallback word matches for AND-like scoring
                            if (isFallbackWord && fallbackPhrase) {
                                existing.fallbackMatches = existing.fallbackMatches || new Set();
                                existing.fallbackMatches.add(term);
                            }
                        } else {
                            const result = {
                                path: filePath,
                                name: fileName,
                                directory: getShortDir(filePath),
                                score: score,
                                grepMatches: matchCount,
                                symbols: [],
                                source: 'grep',
                                selected: false
                            };
                            if (isFallbackWord && fallbackPhrase) {
                                result.fallbackMatches = new Set([term]);
                                result.fallbackPhrase = fallbackPhrase;
                            }
                            allResults.set(filePath, result);
                        }
                    }
                    return fileCounts.size;
                }
                return 0;
            } catch (e) {
                log(`[Scope] Grep search error for "${term}": ${e.message}`);
                return 0;
            }
        };
        
        // First pass: search all terms
        for (const term of terms) {
            const isPhrase = term.includes(' ');
            const found = searchTerm(term, isPhrase);
            
            // If phrase found nothing, queue it for fallback
            if (isPhrase && found === 0) {
                phraseFallbacks.push(term);
            }
        }
        
        // Second pass: fallback for phrases that found nothing
        // Split phrase into words and search each, then boost files matching ALL words
        for (const phrase of phraseFallbacks) {
            const phraseWords = phrase.split(/\s+/).filter(w => w.length >= 2);
            log(`[Scope] Phrase "${phrase}" found 0 results, falling back to words: ${phraseWords.join(', ')}`);
            
            for (const word of phraseWords) {
                searchTerm(word, false, true, phrase);
            }
        }
        
        // Boost files that matched ALL words from a fallback phrase (AND-like behavior)
        if (phraseFallbacks.length > 0) {
            for (const [filePath, result] of allResults) {
                if (result.fallbackMatches && result.fallbackPhrase) {
                    const phraseWords = result.fallbackPhrase.split(/\s+/).filter(w => w.length >= 2);
                    const matchedCount = result.fallbackMatches.size;
                    const totalWords = phraseWords.length;
                    
                    if (matchedCount === totalWords) {
                        // File contains ALL words from the phrase - big bonus!
                        result.score += 25;
                        result.matchedAllWords = true;
                        log(`[Scope] Boost: ${result.name} matched all ${totalWords} words from "${result.fallbackPhrase}"`);
                    } else if (matchedCount > 1) {
                        // Partial match bonus
                        result.score += 10;
                    }
                }
            }
        }
        
        log(`[Scope] After grep: ${allResults.size} unique files`);
        
        // Log top grep files for debugging
        const topGrep = Array.from(allResults.values())
            .filter(r => r.source?.includes('grep'))
            .sort((a, b) => b.grepMatches - a.grepMatches)
            .slice(0, 10);
        log(`[Scope] Top grep files: ${topGrep.map(f => `${f.name}(${f.grepMatches})`).join(', ')}`);
    } else {
        log('[Scope] Grep index not available');
    }
    
    // Method 2: Vector search (semantic similarity)
    if (vectorIndex && vectorIndex.chunks && vectorIndex.chunks.length > 0) {
        log(`[Scope] Trying vector search (${vectorIndex.chunks.length} chunks)`);
        const vectorResults = findFilesUsingVectorIndex(query, vectorIndex, vocabulary, { 
            maxResults: maxResults * 2, 
            log 
        });
        
        if (vectorResults && vectorResults.length > 0) {
            log(`[Scope] Vector search found ${vectorResults.length} files`);
            for (const r of vectorResults) {
                if (allResults.has(r.path)) {
                    // Combine with existing grep result
                    const existing = allResults.get(r.path);
                    existing.score = Math.max(existing.score, r.score) + 10;
                    existing.vectorScore = r.score;
                    existing.source = 'grep+vector';
                } else {
                    allResults.set(r.path, { 
                        ...r, 
                        source: 'vector',
                        vectorScore: r.score 
                    });
                }
            }
        }
    } else {
        log('[Scope] Vector index not available');
    }
    
    // Method 3: Inverted index search (TF-IDF on symbols)
    if (invertedIndex && typeof invertedIndex.search === 'function') {
        log('[Scope] Trying inverted index search');
        const indexResults = findFilesUsingInvertedIndex(query, invertedIndex, { 
            maxResults: maxResults * 2, 
            log 
        });
        
        if (indexResults && indexResults.length > 0) {
            log(`[Scope] Inverted index found ${indexResults.length} files`);
            for (const r of indexResults) {
                if (allResults.has(r.path)) {
                    // Combine scores - file found by both methods gets bonus
                    const existing = allResults.get(r.path);
                    existing.score = Math.max(existing.score, r.score) + 20; // Bonus for appearing in both
                    existing.invertedScore = r.score;
                    existing.source = 'both';
                    // Merge symbols
                    const allSymbols = [...new Set([...(existing.symbols || []), ...(r.symbols || [])])];
                    existing.symbols = allSymbols.slice(0, 4);
                } else {
                    allResults.set(r.path, { 
                        ...r, 
                        source: 'inverted',
                        invertedScore: r.score 
                    });
                }
            }
        }
    } else {
        log('[Scope] Inverted index not available');
    }
    
    // Method 3: Keyword fallback if nothing found
    if (allResults.size === 0) {
        log('[Scope] Using keyword fallback');
        return findFilesKeywordMatch(query, codebaseIndex, { maxResults, log });
    }
    
    // Method 4: Sibling directory expansion
    // Find directories whose NAME matches the query term, then include ALL sibling directories
    // e.g., for "index", find .../access/index/, then include .../access/gin/, .../access/gist/, etc.
    
    const terms = parseTerms(query);
    const siblingGrandparents = new Set();  // grandparent paths where we found a matching dir
    const matchedParentDirs = new Map();    // grandparent -> Set of parent dirs that matched query
    
    log(`[Scope] Looking for directories matching: ${terms.join(', ')}`);
    
    // Scan all files to find directories whose name matches query terms
    for (const [filePath] of codebaseIndex.files) {
        const parts = filePath.split('/');
        if (parts.length >= 3) {
            const parentDir = parts[parts.length - 2];  // directory containing the file
            const parentDirLower = parentDir.toLowerCase();
            
            // Check if directory name matches any search term
            for (const term of terms) {
                if (parentDirLower === term || 
                    parentDirLower.startsWith(term) || 
                    parentDirLower.endsWith(term)) {
                    const grandparent = parts.slice(0, -2).join('/');
                    siblingGrandparents.add(grandparent);
                    
                    if (!matchedParentDirs.has(grandparent)) {
                        matchedParentDirs.set(grandparent, new Set());
                    }
                    matchedParentDirs.get(grandparent).add(parentDir);
                    break;
                }
            }
        }
    }
    
    log(`[Scope] Found ${siblingGrandparents.size} grandparent dirs with matching subdirs`);
    for (const [gp, parents] of matchedParentDirs) {
        log(`[Scope]   ${gp} -> matched: ${[...parents].join(', ')}`);
    }
    
    // Now find ALL sibling directories (not just the matched ones)
    if (siblingGrandparents.size > 0 && codebaseIndex.files) {
        let addedFromSiblings = 0;
        const foundSiblingDirs = new Set();
        
        for (const [filePath] of codebaseIndex.files) {
            if (allResults.has(filePath)) continue;
            
            const parts = filePath.split('/');
            if (parts.length >= 3) {
                const grandparent = parts.slice(0, -2).join('/');
                const parentDir = parts[parts.length - 2];
                
                // Check if this file is in a sibling directory of a matched directory
                if (siblingGrandparents.has(grandparent)) {
                    // Skip if it's the SAME directory that matched (we already have those from search)
                    const matched = matchedParentDirs.get(grandparent);
                    if (matched && matched.has(parentDir)) continue;
                    
                    const fileName = parts[parts.length - 1];
                    const ext = fileName.split('.').pop()?.toLowerCase();
                    
                    // Only include code files
                    if (['c', 'h', 'cpp', 'hpp', 'py', 'java', 'js', 'ts', 'go', 'rs'].includes(ext)) {
                        foundSiblingDirs.add(parentDir);
                        
                        allResults.set(filePath, {
                            path: filePath,
                            name: fileName,
                            directory: getShortDir(filePath),
                            score: 40,  // Sibling score
                            symbols: [],
                            source: 'sibling',
                            siblingDir: parentDir,
                            selected: false
                        });
                        addedFromSiblings++;
                    }
                }
            }
        }
        
        if (addedFromSiblings > 0) {
            log(`[Scope] Added ${addedFromSiblings} files from ${foundSiblingDirs.size} sibling dirs: ${[...foundSiblingDirs].slice(0, 10).join(', ')}${foundSiblingDirs.size > 10 ? '...' : ''}`);
        }
    }
    
    // Convert to array and boost direct keyword matches
    const results = Array.from(allResults.values());
    // terms already declared above in sibling expansion section
    
    for (const result of results) {
        const fileName = result.name.toLowerCase().replace(/\.[^.]+$/, '');
        
        for (const term of terms) {
            if (fileName === term) {
                result.score += 50;
                result.keywordMatch = 'exact';
            } else if (fileName.startsWith(term)) {
                result.score += 30;
                result.keywordMatch = result.keywordMatch || 'prefix';
            } else if (fileName.includes(term)) {
                result.score += 15;
                result.keywordMatch = result.keywordMatch || 'contains';
            }
        }
    }
    
    // Sort by combined score
    results.sort((a, b) => b.score - a.score);
    
    // Update selection based on scores
    const topScore = results[0]?.score || 0;
    const threshold = Math.max(30, topScore * 0.4);
    for (const r of results) {
        r.selected = r.score >= threshold;
    }
    
    log(`[Scope] Combined search found ${results.length} unique files`);
    
    // If we have many results and an LLM client, use it to rank by relevance
    if (results.length > 20 && llmClient) {
        log(`[Scope] Using LLM (via Copilot) to rank ${results.length} files for query: "${query}"`);
        try {
            const rankedResults = await rankFilesWithLLM(query, results.slice(0, 100), { log, llmClient });
            if (rankedResults && rankedResults.length > 0) {
                log(`[Scope] LLM ranked ${rankedResults.length} files`);
                return rankedResults.slice(0, maxResults);
            }
        } catch (e) {
            log(`[Scope] LLM ranking failed, using score-based ranking: ${e.message}`);
        }
    }
    
    return results.slice(0, maxResults);
}

/**
 * Use LLM (via GitHub Copilot) to rank files by relevance to the query
 * This is a fast ranking step to narrow down to the most relevant files
 */
async function rankFilesWithLLM(query, files, options = {}) {
    const { log = () => {}, llmClient = null } = options;
    
    if (!llmClient) {
        log('[Scope] No LLM client available for ranking');
        return null;
    }
    
    // Prepare file list for LLM - include directory context
    const fileList = files.map((f, i) => {
        const dir = f.directory || f.path.split('/').slice(-3, -1).join('/');
        const matches = f.grepMatches ? `(${f.grepMatches} matches)` : '';
        return `${i + 1}. ${f.name} [${dir}] ${matches}`;
    }).join('\n');
    
    const prompt = `You are a code analysis assistant helping to find relevant source files.

Developer query: "${query}"

Below are ${files.length} source files that contain keyword matches.
Select the 50 most relevant files for understanding/implementing "${query}".
Consider: file names that directly relate to the topic, core implementation files vs utilities, directory structure hints.

Files:
${fileList}

Return ONLY comma-separated file numbers (1-indexed), most relevant first. Example: 3,7,1,15,22,...
No explanation, just the numbers.`;

    try {
        log(`[Scope] Calling LLM to rank ${files.length} files...`);
        
        // Use classify() method for quick classification task
        const response = await llmClient.classify(prompt);
        
        log(`[Scope] LLM response: ${response.substring(0, 100)}...`);
        
        // Parse the response - extract numbers
        const numbers = response.match(/\d+/g);
        if (!numbers || numbers.length === 0) {
            log('[Scope] LLM returned no valid numbers');
            return null;
        }
        
        // Map numbers back to files
        const rankedFiles = [];
        const seen = new Set();
        
        for (const numStr of numbers) {
            const idx = parseInt(numStr, 10) - 1;  // Convert to 0-based
            if (idx >= 0 && idx < files.length && !seen.has(idx)) {
                seen.add(idx);
                const file = { ...files[idx] };  // Clone to avoid mutation
                file.llmRank = rankedFiles.length + 1;
                file.score = 100 - rankedFiles.length;  // Re-score based on LLM rank
                file.source = (file.source || '') + '+LLM';
                rankedFiles.push(file);
            }
            if (rankedFiles.length >= 50) break;
        }
        
        log(`[Scope] LLM ranked ${rankedFiles.length} files as most relevant`);
        return rankedFiles;
        
    } catch (e) {
        log(`[Scope] LLM ranking error: ${e.message}`);
        return null;
    }
}

// Store expanded terms for display
let lastExpandedTerms = [];

function toSingular(word) {
    if (word.endsWith('ies') && word.length > 4) return word.slice(0, -3) + 'y';
    if (word.endsWith('es') && word.length > 4) return word.slice(0, -2);
    if (word.endsWith('s') && word.length > 3) return word.slice(0, -1);
    return word;
}

/**
 * Parse query into search terms
 * - Quoted phrases like "BRIN index" are kept as single terms (exact phrase search)
 * - Unquoted words are separate terms (OR search)
 * 
 * Examples:
 *   "BRIN index" → ["brin index"]
 *   BRIN index → ["brin", "index"]
 *   "BRIN index" optimization → ["brin index", "optimization"]
 */
function parseTerms(query) {
    const stops = new Set(['the','a','an','and','or','in','on','to','for','of','how','what','where','is','are','explain','show','find','me','does','work']);
    
    const terms = [];
    let remaining = query;
    
    // Step 1: Extract quoted phrases (exact phrase search)
    const quotePattern = /"([^"]+)"/g;
    let match;
    while ((match = quotePattern.exec(query)) !== null) {
        const phrase = match[1].toLowerCase().trim();
        if (phrase.length >= 2) {
            terms.push(phrase);  // Keep as single term
        }
        // Remove from remaining
        remaining = remaining.replace(match[0], ' ');
    }
    
    // Step 2: Parse remaining unquoted words as separate terms
    const words = remaining.toLowerCase().replace(/[^a-z0-9_\s]/g, ' ').split(/\s+/)
        .filter(t => t.length >= 2 && !stops.has(t));
    
    for (const word of words) {
        terms.push(word);
    }
    
    // Step 3: Add singular forms for individual words (not phrases)
    const withSingulars = new Set();
    for (const t of terms) {
        withSingulars.add(t);
        // Only add singular for single words, not phrases
        if (!t.includes(' ')) {
            withSingulars.add(toSingular(t));
        }
    }
    
    return Array.from(withSingulars);
}

// ============================================================
// VECTOR INDEX-BASED FILE DISCOVERY (Semantic Similarity)
// ============================================================

/**
 * Find files using the vector index (TF-IDF embeddings)
 * Catches semantic relationships that literal matching misses
 */
function findFilesUsingVectorIndex(query, vectorIndex, vocabulary, options = {}) {
    const { maxResults = 40, log = () => {}, topK = 100 } = options;
    
    if (!vectorIndex || !vectorIndex.chunks || vectorIndex.chunks.length === 0) {
        log('[Scope] Vector index not available or empty');
        return null;
    }
    
    log(`[Scope] Using vector search for: "${query}"`);
    log(`[Scope] Vector index has ${vectorIndex.chunks.length} chunks`);
    
    // Import embedding functions
    let generateTfidfEmbedding, simpleHashEmbedding, cosineSimilarity;
    try {
        const vectorModule = require('./vector-index');
        generateTfidfEmbedding = vectorModule.generateTfidfEmbedding;
        simpleHashEmbedding = vectorModule.simpleHashEmbedding;
        cosineSimilarity = vectorModule.cosineSimilarity;
    } catch (e) {
        log(`[Scope] Could not load vector-index module: ${e.message}`);
        return null;
    }
    
    // Embed the query
    const dimensions = vectorIndex.dimensions || 384;
    const queryEmbedding = vocabulary && vocabulary.built 
        ? generateTfidfEmbedding(query, vocabulary, dimensions)
        : simpleHashEmbedding(query, dimensions);
    
    // Search vector index for similar chunks
    const chunkResults = [];
    
    for (let i = 0; i < vectorIndex.chunks.length; i++) {
        const chunk = vectorIndex.chunks[i];
        
        // Get embedding
        const chunkEmbedding = vectorIndex.embeddings 
            ? vectorIndex.embeddings.slice(i * dimensions, (i + 1) * dimensions)
            : chunk.embedding;
        
        if (!chunkEmbedding) continue;
        
        const similarity = cosineSimilarity(queryEmbedding, chunkEmbedding);
        
        if (similarity > 0.1) {  // Low threshold to get candidates
            chunkResults.push({
                file: chunk.file,
                fileName: chunk.fileName,
                symbolName: chunk.symbolName,
                type: chunk.type,
                similarity
            });
        }
    }
    
    // Sort by similarity
    chunkResults.sort((a, b) => b.similarity - a.similarity);
    
    log(`[Scope] Vector search found ${chunkResults.length} matching chunks`);
    
    // Aggregate by file - each file gets max similarity + bonus for multiple matches
    const fileScores = new Map();
    const fileSymbols = new Map();
    
    for (const chunk of chunkResults.slice(0, topK)) {
        const file = chunk.file;
        
        if (!fileScores.has(file)) {
            fileScores.set(file, { maxSim: 0, count: 0, fileName: chunk.fileName });
            fileSymbols.set(file, []);
        }
        
        const score = fileScores.get(file);
        score.maxSim = Math.max(score.maxSim, chunk.similarity);
        score.count++;
        
        // Collect symbol names
        if (chunk.symbolName && fileSymbols.get(file).length < 4) {
            fileSymbols.get(file).push(chunk.symbolName);
        }
    }
    
    // Convert to results array with combined score
    const results = [];
    for (const [filePath, score] of fileScores) {
        // Combined score: max similarity * 100 + bonus for multiple matches
        const combinedScore = Math.round(score.maxSim * 100) + Math.min(score.count * 2, 20);
        
        results.push({
            path: filePath,
            name: score.fileName || filePath.split('/').pop(),
            directory: getShortDir(filePath),
            score: combinedScore,
            similarity: score.maxSim,
            matchCount: score.count,
            symbols: fileSymbols.get(filePath) || [],
            selected: combinedScore >= 40
        });
    }
    
    // Sort by combined score
    results.sort((a, b) => b.score - a.score);
    
    log(`[Scope] Aggregated to ${results.length} unique files`);
    if (results.length > 0) {
        log(`[Scope] Top vector matches: ${results.slice(0, 5).map(r => `${r.name}(${r.score})`).join(', ')}`);
    }
    
    return results.slice(0, maxResults);
}

// ============================================================
// INVERTED INDEX-BASED FILE DISCOVERY
// ============================================================

/**
 * Find files using the inverted index (TF-IDF search)
 * The inverted index is already built during index phase
 */
function findFilesUsingInvertedIndex(query, invertedIndex, options = {}) {
    const { maxResults = 40, log = () => {}, topK = 200 } = options;
    
    if (!invertedIndex || typeof invertedIndex.search !== 'function') {
        log('[Scope] Inverted index not available or no search method');
        return null;  // Signal to use fallback
    }
    
    log(`[Scope] Using inverted index search for: "${query}"`);
    
    // Search the inverted index - it returns results with TF-IDF scores
    let searchResults;
    try {
        searchResults = invertedIndex.search(query, {
            maxResults: topK,
            expandSynonyms: true,  // Use learned synonyms
            boostExact: true
        });
    } catch (e) {
        log(`[Scope] Inverted index search error: ${e.message}`);
        return null;
    }
    
    if (!searchResults || searchResults.length === 0) {
        log('[Scope] Inverted index returned no results');
        return null;
    }
    
    log(`[Scope] Inverted index found ${searchResults.length} results`);
    
    // Aggregate by file - collect scores and metadata
    const fileScores = new Map();
    const fileSymbols = new Map();
    
    for (const result of searchResults) {
        // Extract file path from the result
        // Results might be symbols, code blocks, or files
        const filePath = result.file || result.filePath || result.docId;
        if (!filePath) continue;
        
        if (!fileScores.has(filePath)) {
            fileScores.set(filePath, { 
                maxScore: 0, 
                totalScore: 0,
                count: 0, 
                fileName: filePath.split('/').pop()
            });
            fileSymbols.set(filePath, []);
        }
        
        const fileData = fileScores.get(filePath);
        fileData.maxScore = Math.max(fileData.maxScore, result.score || 0);
        fileData.totalScore += result.score || 0;
        fileData.count++;
        
        // Collect symbol/function names
        const symbolName = result.symbolName || result.symbol || result.name;
        if (symbolName && fileSymbols.get(filePath).length < 4) {
            if (!fileSymbols.get(filePath).includes(symbolName)) {
                fileSymbols.get(filePath).push(symbolName);
            }
        }
    }
    
    // Convert to results array
    const results = [];
    for (const [filePath, data] of fileScores) {
        // Combined score: normalize and add bonus for multiple matches
        const normalizedScore = Math.min(Math.round(data.maxScore * 20), 100);
        const countBonus = Math.min(data.count * 3, 30);
        const combinedScore = normalizedScore + countBonus;
        
        results.push({
            path: filePath,
            name: data.fileName,
            directory: getShortDir(filePath),
            score: combinedScore,
            matchCount: data.count,
            symbols: fileSymbols.get(filePath) || [],
            selected: combinedScore >= 40
        });
    }
    
    // Sort by combined score
    results.sort((a, b) => b.score - a.score);
    
    log(`[Scope] Aggregated to ${results.length} unique files`);
    if (results.length > 0) {
        log(`[Scope] Top files: ${results.slice(0, 5).map(r => `${r.name}(${r.score})`).join(', ')}`);
    }
    
    return results.slice(0, maxResults);
}

/**
 * Fallback: Simple keyword-based file matching
 * Used when inverted index is not available
 */
function findFilesKeywordMatch(query, codebaseIndex, options = {}) {
    const { maxResults = 40, log = () => {} } = options;
    
    const terms = parseTerms(query);
    log(`[Scope] Keyword fallback for: "${query}" -> [${terms.join(', ')}]`);
    
    const results = [];
    
    for (const [path] of codebaseIndex.files) {
        const score = scoreFileKeywords(path, terms, codebaseIndex);
        if (score > 0) {
            let symbols = [];
            try {
                if (typeof codebaseIndex._getSymbolsInFile === 'function') {
                    symbols = codebaseIndex._getSymbolsInFile(path, 4).map(s => s.name);
                }
            } catch (e) {}
            
            results.push({ 
                path, 
                name: path.split('/').pop(),
                directory: getShortDir(path),
                score, 
                symbols,
                selected: score >= 50
            });
        }
    }
    
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, maxResults);
}

/**
 * Score file by keyword matching (fallback method)
 */
function scoreFileKeywords(path, terms, codebaseIndex) {
    const name = path.split('/').pop().toLowerCase();
    const nameNoExt = name.replace(/\.[^.]+$/, '');
    let score = 0;
    
    for (const term of terms) {
        const singular = toSingular(term);
        const variants = [term, singular].filter((v, i, a) => a.indexOf(v) === i);
        
        for (const t of variants) {
            if (nameNoExt === t) score += 100;
            else if (nameNoExt.startsWith(t)) score += 60;
            else if (name.includes(t)) score += 25;
            if (path.toLowerCase().includes('/' + t + '/')) score += 15;
        }
    }
    
    // Symbol bonus
    try {
        let syms = [];
        if (typeof codebaseIndex._getSymbolsInFile === 'function') {
            syms = codebaseIndex._getSymbolsInFile(path, 30) || [];
        } else if (codebaseIndex.symbols) {
            syms = Array.from(codebaseIndex.symbols.values())
                .filter(s => s.file === path)
                .slice(0, 30);
        }
        
        for (const sym of syms) {
            const symName = (sym.name || '').toLowerCase();
            for (const t of terms) {
                if (symName.includes(t) || symName.includes(toSingular(t))) {
                    score += 2;
                }
            }
        }
    } catch (e) {}
    
    return Math.min(score, 200);
}

function getShortDir(path) {
    const parts = path.split('/');
    parts.pop();
    return parts.slice(-2).join('/');
}

// ============================================================
// COMMAND HANDLING
// ============================================================

/**
 * Check if message is a grep/scope command
 * Returns { isCommand, type, args } or null
 * 
 * Supports both /grep and /scope for backward compatibility
 */
function parseScopeCommand(message) {
    const trimmed = message.trim();
    const lower = trimmed.toLowerCase();
    
    // /ungrep or /unscope
    if (lower === '/ungrep' || lower === '/unscope') {
        return { isCommand: true, type: 'unscope' };
    }
    
    // /grep or /scope (status)
    if (lower === '/grep' || lower === '/scope') {
        return { isCommand: true, type: 'status' };
    }
    
    // /grep <keywords> or /scope <keywords>
    const match = trimmed.match(/^\/(grep|scope)\s+(.+)$/i);
    if (match) {
        return { isCommand: true, type: 'search', args: match[2].trim() };
    }
    
    return null;
}

/**
 * Handle scope command
 * Returns object with webview messages to send
 * 
 * @param {object} command - Parsed command {type, args}
 * @param {object} codebaseIndex - The codebase index
 * @param {object} options - Options including invertedIndex, vectorIndex, vocabulary, grepIndex, llmClient, log
 */
async function handleScopeCommand(command, codebaseIndex, options = {}) {
    const { log = () => {}, invertedIndex = null, vectorIndex = null, vocabulary = null, grepIndex = null, llmClient = null } = options;
    
    // /unscope
    if (command.type === 'unscope') {
        const wasActive = scopeState.isActive;
        const prevCount = scopeState.files.size;
        scopeState.deactivate();
        
        return {
            messages: [{
                type: 'scopeStatus',
                status: null
            }, {
                type: 'appendResponse',
                text: wasActive 
                    ? `\n📂 **Scope Deactivated**\nWas: ${prevCount} files. Now searching all files.\n\n`
                    : `\nNo scope was active.\n\n`
            }]
        };
    }
    
    // /scope (status)
    if (command.type === 'status') {
        const status = scopeState.getStatus();
        
        if (!status.isActive) {
            return {
                messages: [{
                    type: 'appendResponse',
                    text: `\n📂 **No Scope Active**\n\nUse \`/grep <keywords>\` to narrow search to specific files.\nExample: \`/grep index build\`\n\n`
                }]
            };
        }
        
        const fileList = status.files.slice(0, 10).map(f => `  • ${f.name}`).join('\n');
        const more = status.files.length > 10 ? `\n  • ... and ${status.files.length - 10} more` : '';
        
        return {
            messages: [{
                type: 'appendResponse',
                text: `\n🔍 **Scope Active:** ${status.fileCount} files\nQuery: "${status.query}"\n\n${fileList}${more}\n\nUse \`/ungrep\` to search all files.\n\n`
            }]
        };
    }
    
    // /scope <keywords>
    if (command.type === 'search') {
        // Check if codebaseIndex exists and has files
        if (!codebaseIndex || !codebaseIndex.files || codebaseIndex.files.size === 0) {
            return {
                messages: [{
                    type: 'appendResponse',
                    text: `\n⚠️ **No files indexed.** Please add files and rebuild the index first.\n\n`
                }]
            };
        }
        
        // Use combined grep + vector + inverted index + LLM ranking search
        const files = await findMatchingFiles(command.args, codebaseIndex, { 
            log, 
            invertedIndex,
            vectorIndex,
            vocabulary,
            grepIndex,
            llmClient
        });
        
        // Determine which methods were used
        const hasGrep = grepIndex && typeof grepIndex.searchLiteral === 'function';
        const hasVector = vectorIndex && vectorIndex.chunks && vectorIndex.chunks.length > 0;
        const hasInverted = invertedIndex && typeof invertedIndex.search === 'function';
        const hasLLM = llmClient !== null;
        
        if (files.length === 0) {
            return {
                messages: [{
                    type: 'appendResponse',
                    text: `\n⚠️ No files found matching "${command.args}"\n\n` +
                          `Search methods: ${hasGrep ? 'Grep ✓' : 'Grep ✗'} ${hasVector ? 'Vector ✓' : 'Vector ✗'} ${hasInverted ? 'TF-IDF ✓' : 'TF-IDF ✗'}\n` +
                          `Try different keywords or check if files are indexed.\n\n`
                }]
            };
        }
        
        // Auto-select top files based on score
        // When LLM-ranked, trust the LLM ordering and take top 50
        // Otherwise use threshold-based selection
        const usedLLM = files.some(f => f.source?.includes('LLM'));
        let autoSelected;
        
        if (usedLLM) {
            // LLM already ranked by relevance - take top 50
            autoSelected = files.slice(0, 50);
        } else {
            // Traditional threshold-based selection
            const threshold = Math.max(30, files[0].score * 0.4);
            autoSelected = files.filter(f => {
                if (f.score >= threshold) return true;
                if (f.source === 'sibling' && f.score >= 35) return true;
                return false;
            }).slice(0, 30);  // Cap at 30 for non-LLM
        }
        
        if (autoSelected.length === 0) {
            // Fall back to top 5 if no high-scoring files
            autoSelected = files.slice(0, 5);
        }
        
        // Activate scope with selected files
        const selectedPaths = autoSelected.map(f => f.path);
        scopeState.activate(command.args, selectedPaths);
        
        // Build file list for display - show source method
        const fileList = autoSelected.map(f => {
            const syms = f.symbols?.length > 0 ? ` → ${f.symbols.slice(0, 3).join(', ')}` : '';
            const matchType = f.keywordMatch ? ` [${f.keywordMatch}]` : '';
            const grepInfo = f.grepMatches ? ` (${f.grepMatches} matches)` : '';
            const allWordsTag = f.matchedAllWords ? ' ✓' : '';  // Mark files matching all words
            let sourceTag = '';
            
            // Simplified tags when LLM is used
            if (f.source?.includes('LLM')) {
                // LLM ranked - show original source briefly
                if (f.source?.includes('grep') && f.source?.includes('vector')) sourceTag = ' [G+V]';
                else if (f.source?.includes('grep')) sourceTag = ' [G]';
                else if (f.source?.includes('vector')) sourceTag = ' [V]';
                // Don't show +LLM on every line since header says "LLM-ranked"
            } else {
                if (f.source?.includes('grep') && f.source?.includes('vector')) sourceTag = ' [G+V]';
                else if (f.source === 'grep') sourceTag = ' [G]';
                else if (f.source === 'both' || f.source === 'vector+inverted') sourceTag = ' [V+T]';
                else if (f.source === 'vector') sourceTag = ' [V]';
                else if (f.source === 'sibling') sourceTag = f.siblingDir ? ` [sibling:${f.siblingDir}]` : ' [S]';
                else if (f.source === 'inverted') sourceTag = ' [T]';
            }
            return `  • **${f.name}** (${f.score})${matchType}${sourceTag}${grepInfo}${allWordsTag}${syms}`;
        }).join('\n');
        
        // Count sibling files
        const siblingCount = autoSelected.filter(f => f.source === 'sibling').length;
        const siblingDirs = [...new Set(autoSelected.filter(f => f.siblingDir).map(f => f.siblingDir))];
        
        const moreFiles = files.length > autoSelected.length 
            ? `\n\n*${files.length - autoSelected.length} more files matched but weren't selected.*` 
            : '';
        
        // Show search info with sibling expansion note
        const topMatches = files.slice(0, 8).map(f => f.name.replace(/\.[^.]+$/, ''));
        const uniqueMatches = [...new Set(topMatches)].slice(0, 6);
        
        // Check if phrase fallback was used
        const usedPhraseFallback = files.some(f => f.fallbackPhrase);
        const filesMatchedAllWords = files.filter(f => f.matchedAllWords).length;
        
        // Build search methods string
        const methodParts = [];
        if (hasGrep) methodParts.push('Grep');
        if (hasVector) methodParts.push('Vector');
        if (hasInverted) methodParts.push('TF-IDF');
        // Check if LLM ranking was used (usedLLM already computed above)
        if (usedLLM) methodParts.push('LLM-ranked');
        const searchMethods = methodParts.length > 0 ? methodParts.join(' + ') : 'Keyword';
        
        let searchNote = `\n*${searchMethods} search found: ${uniqueMatches.join(', ')}${files.length > 6 ? '...' : ''}*`;
        if (usedPhraseFallback) {
            const fallbackPhrase = files.find(f => f.fallbackPhrase)?.fallbackPhrase;
            searchNote += `\n*📝 Exact phrase "${fallbackPhrase}" not found, searched individual words instead`;
            if (filesMatchedAllWords > 0) {
                searchNote += ` (${filesMatchedAllWords} files contain all words)*`;
            } else {
                searchNote += '*';
            }
        }
        if (siblingDirs.length > 0) {
            searchNote += `\n*+ sibling dirs: ${siblingDirs.slice(0, 5).join(', ')}${siblingDirs.length > 5 ? '...' : ''}*`;
        }
        searchNote += '\n';
        
        return {
            messages: [{
                type: 'appendResponse',
                text: `\n🔍 **Scope Activated:** ${autoSelected.length} files${usedLLM ? ' (🤖 LLM-ranked)' : ''}\n` +
                      `Query: "${command.args}"${searchNote}\n` +
                      `**Selected files:**\n${fileList}${moreFiles}\n\n` +
                      `Your searches will now focus on these files.\n` +
                      `Use \`/ungrep\` to search all files again.\n\n`
            }, {
                type: 'scopeStatus',
                status: scopeState.getStatus()
            }]
        };
    }
    
    return { messages: [] };
}

/**
 * Apply scope selection (called when user confirms in webview)
 */
function applyScopeSelection(query, selectedPaths) {
    if (selectedPaths.length === 0) {
        return {
            success: false,
            messages: [{
                type: 'appendResponse',
                text: `\n⚠️ No files selected. Scope not activated.\n\n`
            }, {
                type: 'scopeStatus',
                status: null
            }]
        };
    }
    
    scopeState.activate(query, selectedPaths);
    
    const fileList = selectedPaths.slice(0, 5).map(p => `  • ${p.split('/').pop()}`).join('\n');
    const more = selectedPaths.length > 5 ? `\n  • ... and ${selectedPaths.length - 5} more` : '';
    
    return {
        success: true,
        messages: [{
            type: 'appendResponse',
            text: `\n🔍 **Scope Activated**\n${selectedPaths.length} files selected:\n\n${fileList}${more}\n\nYour searches will now focus on these files.\nUse \`/ungrep\` to search all files again.\n\n`
        }, {
            type: 'scopeStatus',
            status: scopeState.getStatus()
        }]
    };
}

// ============================================================
// SEARCH FILTERING
// ============================================================

/**
 * Filter search results to only include scoped files
 * Call this after codebaseIndex.search()
 */
function filterResultsToScope(searchResults) {
    if (!scopeState.isActive) {
        return searchResults;
    }
    
    const originalCount = searchResults.symbols?.length || 0;
    
    const filtered = {
        ...searchResults,
        symbols: (searchResults.symbols || []).filter(s => scopeState.hasFile(s.file)),
        codeBlocks: (searchResults.codeBlocks || []).filter(b => scopeState.hasFile(b.file)),
        files: (searchResults.files || []).filter(f => scopeState.hasFile(f.path)),
    };
    
    filtered._scopeInfo = {
        isScoped: true,
        fileCount: scopeState.files.size,
        originalSymbols: originalCount,
        filteredSymbols: filtered.symbols.length
    };
    
    return filtered;
}

/**
 * Get current scope status for webview
 */
function getScopeStatus() {
    if (scopeState.isActive) {
        return scopeState.getStatus();
    }
    // Return a default status object when not active (never return null)
    return {
        isActive: false,
        query: '',
        fileCount: 0,
        files: []
    };
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    // State
    scopeState,
    
    // Command handling
    parseScopeCommand,
    handleScopeCommand,
    applyScopeSelection,
    
    // Search
    findMatchingFiles,
    filterResultsToScope,
    getScopeStatus,
    
    // Get scoped files (convenience wrapper)
    getScopedFiles: (contextFiles) => scopeState.getScopedFiles(contextFiles)
};
