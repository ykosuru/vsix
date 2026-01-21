/**
 * AstraCode Context Builder v2.0
 * 
 * IMPROVED: Relevance-aware hierarchical summarization
 * 
 * Key improvements over v1:
 * 1. TWO-TIER CONTEXT: High-relevance results kept verbatim, only low-relevance summarized
 * 2. QUERY-AWARE SCORING: Chunks scored by relevance to query before any summarization
 * 3. CODE-PRESERVING: Summarization extracts structured facts + preserves key code
 * 4. FILE PRIORITY: Files containing query terms get full representation
 * 
 * The core insight: Search already ranked results by relevance. Don't lose that ranking
 * by treating all chunks equally during summarization.
 */

// ============================================================
// CONFIGURATION
// ============================================================

const CONFIG = {
    // Context limits
    MAX_CONTEXT_CHARS: 48000,           // ~12K tokens total
    
    // Two-tier allocation
    PRIMARY_CONTEXT_RATIO: 0.65,        // 65% for high-relevance (verbatim)
    SECONDARY_CONTEXT_RATIO: 0.35,      // 35% for summarized supporting context
    
    // Relevance thresholds
    HIGH_RELEVANCE_SCORE: 70,           // Symbols >= this score go to primary
    MEDIUM_RELEVANCE_SCORE: 40,         // Symbols >= this go to secondary
    
    // Per-item limits
    MAX_PRIMARY_SYMBOLS: 25,            // Top N symbols kept verbatim
    MAX_PRIMARY_CODE_BLOCKS: 12,        // Top N code blocks kept verbatim
    MAX_SECONDARY_CHUNKS: 8,            // Max chunks to summarize
    
    // Code block limits
    MAX_CODE_BLOCK_LINES: 80,           // Lines per code block
    
    // Summarization
    CHUNK_SIZE_CHARS: 10000,            // ~2500 tokens per chunk
    SUMMARY_TARGET_CHARS: 1500,         // Target size for summaries
    MAX_HIERARCHY_LEVELS: 2,            // Max summarization passes
    
    // File-level priority
    PRIORITY_FILE_PATTERNS: [           // Files matching query terms get priority
        // Will be populated dynamically from query
    ]
};

// ============================================================
// MAIN ENTRY POINT
// ============================================================

/**
 * Build optimized context for LLM from search results
 * Uses two-tier strategy: verbatim high-relevance + summarized low-relevance
 * 
 * @param {Object} searchResults - Results from CodebaseIndex.search()
 * @param {string} query - Original user query
 * @param {Object} options - Options including llmClient for summarization
 * @returns {Object} { context, method, stats }
 */
async function buildContext(searchResults, query, options = {}) {
    const {
        llmClient = null,
        log = console.log,
        onProgress = null,
        maxContextChars = CONFIG.MAX_CONTEXT_CHARS
    } = options;
    
    const stats = {
        method: 'two_tier',
        originalSymbols: searchResults.symbols?.length || 0,
        originalCodeBlocks: searchResults.codeBlocks?.length || 0,
        primarySymbols: 0,
        primaryCodeBlocks: 0,
        secondaryChunks: 0,
        summarized: false,
        originalSize: 0,
        finalSize: 0,
        summarizationTime: 0
    };
    
    log(`Context builder: Starting with ${stats.originalSymbols} symbols, ${stats.originalCodeBlocks} code blocks`);
    
    // Step 1: Extract query terms for relevance scoring
    const queryTerms = extractQueryTerms(query);
    log(`Context builder: Query terms: ${queryTerms.join(', ')}`);
    
    // Step 2: Score and partition results by relevance (with optional LLM ranking)
    const { primary, secondary } = await partitionByRelevance(searchResults, queryTerms, log, {
        llmClient,
        query
    });
    stats.primarySymbols = primary.symbols.length;
    stats.primaryCodeBlocks = primary.codeBlocks.length;
    
    log(`Context builder: Primary (high-relevance): ${primary.symbols.length} symbols, ${primary.codeBlocks.length} code blocks`);
    log(`Context builder: Secondary (to summarize): ${secondary.symbols.length} symbols, ${secondary.codeBlocks.length} code blocks`);
    
    // Step 3: Build primary context (verbatim, high-relevance)
    const primaryBudget = Math.floor(maxContextChars * CONFIG.PRIMARY_CONTEXT_RATIO);
    const primaryContext = buildPrimaryContext(primary, query, primaryBudget);
    log(`Context builder: Primary context size: ${(primaryContext.length / 1024).toFixed(1)}KB`);
    
    // Step 4: Build secondary context (summarized if needed)
    const secondaryBudget = maxContextChars - primaryContext.length - 500; // Leave room for headers
    let secondaryContext = '';
    
    if (secondary.symbols.length > 0 || secondary.codeBlocks.length > 0) {
        const secondaryRaw = buildSecondaryRawContext(secondary);
        stats.originalSize = primaryContext.length + secondaryRaw.length;
        
        if (secondaryRaw.length <= secondaryBudget) {
            // Fits without summarization
            secondaryContext = secondaryRaw;
            log(`Context builder: Secondary context fits (${(secondaryRaw.length / 1024).toFixed(1)}KB)`);
        } else if (llmClient) {
            // Need to summarize
            onProgress?.('Summarizing supporting context...');
            const startTime = Date.now();
            
            secondaryContext = await summarizeSecondaryContext(
                secondary, 
                query, 
                queryTerms,
                llmClient, 
                secondaryBudget,
                { log, onProgress }
            );
            
            stats.summarized = true;
            stats.summarizationTime = Date.now() - startTime;
            stats.secondaryChunks = Math.ceil(secondaryRaw.length / CONFIG.CHUNK_SIZE_CHARS);
            log(`Context builder: Summarized secondary in ${stats.summarizationTime}ms`);
        } else {
            // No LLM - smart truncate
            secondaryContext = smartTruncateContext(secondaryRaw, secondaryBudget);
            log(`Context builder: Truncated secondary context`);
        }
    }
    
    // Step 5: Combine into final context
    const finalContext = assembleFinalContext(primaryContext, secondaryContext, query, searchResults);
    stats.finalSize = finalContext.length;
    
    log(`Context builder: Final context: ${(stats.finalSize / 1024).toFixed(1)}KB`);
    
    return { context: finalContext, stats };
}

// ============================================================
// QUERY ANALYSIS
// ============================================================

/**
 * Extract meaningful terms from query for relevance scoring
 */
function extractQueryTerms(query) {
    // Common stop words to filter out
    const stopWords = new Set([
        'how', 'what', 'where', 'when', 'why', 'which', 'who',
        'does', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
        'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
        'of', 'with', 'by', 'from', 'as', 'into', 'through', 'during',
        'this', 'that', 'these', 'those', 'it', 'its',
        'can', 'could', 'would', 'should', 'will', 'shall', 'may', 'might',
        'explain', 'describe', 'show', 'tell', 'work', 'works', 'working'
    ]);
    
    return query
        .toLowerCase()
        .replace(/[^a-z0-9_\s]/g, ' ')
        .split(/\s+/)
        .filter(term => term.length >= 2 && !stopWords.has(term))
        .map(term => term.replace(/_/g, ''));  // Also match without underscores
}

/**
 * Score how relevant a symbol/file is to the query
 * 
 * Uses multiple matching strategies:
 * 1. Exact/substring matches in filename (highest)
 * 2. Trigram matches for fuzzy filename matching (e.g., "pruning" matches "partprune")
 * 3. Symbol name matches
 * 4. Summary/signature matches
 */
function scoreRelevance(item, queryTerms) {
    // Start with a small base score (don't let search matchScore dominate)
    let score = Math.min(item.matchScore || 0, 30);  // Cap base score contribution
    
    const name = (item.name || '').toLowerCase();
    const file = (item.file || '').toLowerCase();
    const fileName = file.split('/').pop() || '';  // Just the filename
    const fileNameNoExt = fileName.replace(/\.[^.]+$/, '');  // Remove extension
    const summary = (item.summary || '').toLowerCase();
    const signature = (item.signature || '').toLowerCase();
    
    // Track if ANY query term matched (for minimum threshold)
    let queryTermMatched = false;
    
    for (const term of queryTerms) {
        // === FILENAME MATCHING (Highest Priority) ===
        
        // Strategy 1: Exact substring match
        if (fileName.includes(term)) {
            score += 150;  // Strongest signal
            queryTermMatched = true;
        }
        // Strategy 2: Trigram matching for fuzzy filename match
        // "pruning" has trigrams [pru, run, uni, nin, ing]
        // "partprune" has trigrams [par, art, rtp, tpr, pru, run, une]
        // Overlap [pru, run] = 2 trigrams = good match
        else {
            const trigramScore = trigramSimilarity(term, fileNameNoExt);
            if (trigramScore >= 0.4) {  // 40%+ trigram overlap
                score += Math.floor(trigramScore * 120);  // Up to +120 for perfect match
                queryTermMatched = true;
            }
        }
        
        // Strategy 3: Stem matching (pruning -> prun)
        const termStem = term.length > 4 ? term.substring(0, term.length - 3) : term;
        if (termStem.length >= 4 && fileNameNoExt.includes(termStem)) {
            score += 80;
            queryTermMatched = true;
        }
        
        // File path (directory) contains term
        if (!fileName.includes(term) && file.includes(term)) {
            score += 40;
            queryTermMatched = true;
        }
        
        // === SYMBOL NAME MATCHING ===
        
        // Exact name match
        if (name === term) {
            score += 80;
            queryTermMatched = true;
        }
        // Word boundary match (e.g., "partition" in "make_partition_pruneinfo")
        else if (name.includes(term)) {
            const termPattern = new RegExp(`(^|_)${term}(_|$)`, 'i');
            if (termPattern.test(name)) {
                score += 60;  // Word boundary
            } else {
                score += 35;  // Substring
            }
            queryTermMatched = true;
        }
        // Trigram match for symbol names
        else {
            const symTrigramScore = trigramSimilarity(term, name);
            if (symTrigramScore >= 0.5) {
                score += Math.floor(symTrigramScore * 50);
                queryTermMatched = true;
            }
        }
        
        // === CONTENT MATCHING ===
        
        if (summary.includes(term)) {
            score += 25;
            queryTermMatched = true;
        }
        
        if (signature.includes(term)) {
            score += 15;
            queryTermMatched = true;
        }
    }
    
    // Boost data structures
    if (['struct', 'typedef', 'class', 'enum', 'type'].includes(item.type)) {
        score += 15;
    }
    
    // Penalty for symbols that didn't match ANY query term
    if (!queryTermMatched) {
        score = Math.max(score * 0.3, 10);
    }
    
    return score;
}

/**
 * Calculate trigram similarity between two strings
 * Returns 0-1 where 1 is identical
 */
function trigramSimilarity(str1, str2) {
    if (!str1 || !str2 || str1.length < 3 || str2.length < 3) return 0;
    
    const getTrigrams = (s) => {
        const t = new Set();
        const normalized = s.toLowerCase().replace(/[^a-z0-9]/g, '');
        for (let i = 0; i <= normalized.length - 3; i++) {
            t.add(normalized.substring(i, i + 3));
        }
        return t;
    };
    
    const t1 = getTrigrams(str1);
    const t2 = getTrigrams(str2);
    
    if (t1.size === 0 || t2.size === 0) return 0;
    
    let intersection = 0;
    for (const tri of t1) {
        if (t2.has(tri)) intersection++;
    }
    
    // Jaccard similarity
    const union = t1.size + t2.size - intersection;
    return union > 0 ? intersection / union : 0;
}

// ============================================================
// RELEVANCE PARTITIONING
// ============================================================

/**
 * Partition search results into primary (high-relevance) and secondary (lower-relevance)
 * Uses LLM to score file relevance when available
 */
async function partitionByRelevance(searchResults, queryTerms, log, options = {}) {
    const { llmClient = null, query = '' } = options;
    
    const primary = { symbols: [], codeBlocks: [], files: new Set() };
    const secondary = { symbols: [], codeBlocks: [], files: new Set() };
    
    // Step 1: Group all search results by file
    const fileGroups = groupResultsByFile(searchResults);
    log(`Context builder: Grouped results into ${fileGroups.size} files`);
    
    // Step 2: Score files - use LLM if available, otherwise heuristics
    let scoredFiles;
    const canUseLLM = llmClient && typeof llmClient.completeForAnalysis === 'function' && query && fileGroups.size > 0;
    
    if (canUseLLM) {
        log(`Context builder: Using LLM to score ${Math.min(fileGroups.size, 15)} files...`);
        scoredFiles = await scoreFilesWithLLM(fileGroups, query, llmClient, log);
    } else {
        const reason = !llmClient ? 'no llmClient' : 
                       typeof llmClient.completeForAnalysis !== 'function' ? 'no completeForAnalysis method' :
                       !query ? 'no query' : 'no files';
        log(`Context builder: Using heuristic scoring (${reason})`);
        scoredFiles = scoreFilesWithHeuristics(fileGroups, queryTerms);
    }
    
    // Step 3: Apply scores to symbols and sort
    const scoredSymbols = applyFileScoresToSymbols(searchResults.symbols || [], scoredFiles, queryTerms);
    
    // Log top files
    const topFiles = Array.from(scoredFiles.entries())
        .sort((a, b) => b[1].score - a[1].score)
        .slice(0, 5)
        .map(([f, data]) => `${f.split('/').pop()}(${data.score}${data.llmScored ? '*' : ''})`);
    log(`Context builder: Top files by relevance: ${topFiles.join(', ')}`);
    
    // Step 4: Partition symbols based on scores
    for (let i = 0; i < scoredSymbols.length; i++) {
        const sym = scoredSymbols[i];
        
        // High relevance OR top N symbols -> primary
        if (sym.relevanceScore >= CONFIG.HIGH_RELEVANCE_SCORE || i < CONFIG.MAX_PRIMARY_SYMBOLS) {
            primary.symbols.push(sym);
            primary.files.add(sym.file);
        }
        // Medium relevance -> secondary
        else if (sym.relevanceScore >= CONFIG.MEDIUM_RELEVANCE_SCORE) {
            secondary.symbols.push(sym);
            secondary.files.add(sym.file);
        }
    }
    
    // Partition code blocks
    const codeBlocks = searchResults.codeBlocks || [];
    for (let i = 0; i < codeBlocks.length; i++) {
        const block = codeBlocks[i];
        if (primary.files.has(block.file) && primary.codeBlocks.length < CONFIG.MAX_PRIMARY_CODE_BLOCKS) {
            primary.codeBlocks.push(block);
        } else if (i < 20) {
            secondary.codeBlocks.push(block);
        }
    }
    
    return { primary, secondary };
}

/**
 * Group all search results by file, combining symbols and code blocks
 */
function groupResultsByFile(searchResults) {
    const fileGroups = new Map();
    
    // Group symbols
    for (const sym of (searchResults.symbols || [])) {
        const file = sym.file || 'unknown';
        if (!fileGroups.has(file)) {
            fileGroups.set(file, { 
                symbols: [], 
                codeBlocks: [], 
                matchSources: new Set(),
                totalMatchScore: 0
            });
        }
        const group = fileGroups.get(file);
        group.symbols.push(sym);
        group.totalMatchScore += sym.matchScore || 0;
        if (sym.matchSource) {
            group.matchSources.add(sym.matchSource);
        }
    }
    
    // Group code blocks
    for (const block of (searchResults.codeBlocks || [])) {
        const file = block.file || 'unknown';
        if (!fileGroups.has(file)) {
            fileGroups.set(file, { 
                symbols: [], 
                codeBlocks: [], 
                matchSources: new Set(),
                totalMatchScore: 0
            });
        }
        fileGroups.get(file).codeBlocks.push(block);
    }
    
    return fileGroups;
}

/**
 * Score files using LLM - asks LLM to rate relevance 1-10 for each file
 * 
 * This is the KEY improvement: instead of heuristics, we ask the LLM directly
 * "How relevant is this file to answering the user's question?"
 */
async function scoreFilesWithLLM(fileGroups, query, llmClient, log) {
    const scoredFiles = new Map();
    
    // Prepare file summaries for LLM (limit to top 15 files by match count)
    const filesToScore = Array.from(fileGroups.entries())
        .sort((a, b) => b[1].symbols.length - a[1].symbols.length)
        .slice(0, 15);
    
    // Build compact representation of each file for LLM
    const fileSummaries = filesToScore.map(([filePath, group]) => {
        const fileName = filePath.split('/').pop();
        const topSymbols = group.symbols
            .slice(0, 5)
            .map(s => `${s.name}(${s.type})`)
            .join(', ');
        const matchSources = Array.from(group.matchSources).join(', ');
        
        // Include a code snippet if available
        let codePreview = '';
        if (group.codeBlocks.length > 0 && group.codeBlocks[0].code) {
            const code = group.codeBlocks[0].code.split('\n').slice(0, 8).join('\n');
            codePreview = `\nCode preview:\n${code}`;
        } else if (group.symbols.length > 0 && group.symbols[0].signature) {
            codePreview = `\nSignature: ${group.symbols[0].signature}`;
        }
        
        return {
            filePath,
            summary: `FILE: ${fileName}
Symbols (${group.symbols.length}): ${topSymbols || 'none'}
Match sources: ${matchSources || 'unknown'}${codePreview}`
        };
    });
    
    // Create LLM prompt
    const prompt = `You are scoring source code files for relevance to a user's question.

USER QUESTION: "${query}"

Score each file from 1-10 based on how likely it contains the answer:
- 10: Definitely contains the core implementation
- 7-9: Likely contains important related code  
- 4-6: Might have some relevant information
- 1-3: Unlikely to be relevant

FILES TO SCORE:
${fileSummaries.map((f, i) => `\n[${i + 1}] ${f.summary}`).join('\n')}

Respond with ONLY a JSON object mapping filename to score:
{"filename1.c": 8, "filename2.c": 3, ...}

Consider:
- File names often indicate purpose (e.g., "partprune.c" for partition pruning)
- Symbol names reveal functionality
- Match sources indicate how the file was found`;

    try {
        const response = await llmClient.completeForAnalysis(prompt, {
            maxTokens: 300,
            temperature: 0.1
        });
        
        // Parse JSON response
        const jsonMatch = response.match(/\{[^{}]*\}/);
        if (jsonMatch) {
            const scores = JSON.parse(jsonMatch[0]);
            
            for (const [filePath, group] of filesToScore) {
                const fileName = filePath.split('/').pop();
                // Try to find score by filename (case-insensitive)
                let llmScore = null;
                for (const [key, value] of Object.entries(scores)) {
                    if (key.toLowerCase() === fileName.toLowerCase() || 
                        fileName.toLowerCase().includes(key.toLowerCase().replace(/\.[^.]+$/, ''))) {
                        llmScore = value;
                        break;
                    }
                }
                
                if (llmScore !== null) {
                    // Convert 1-10 score to 0-300 range for consistency with old scoring
                    const normalizedScore = llmScore * 30;
                    scoredFiles.set(filePath, {
                        score: normalizedScore,
                        llmScore: llmScore,
                        llmScored: true,
                        symbolCount: group.symbols.length
                    });
                    log(`Context builder: LLM scored ${fileName}: ${llmScore}/10 -> ${normalizedScore}`);
                } else {
                    // Fallback to heuristic for files LLM didn't score
                    const heuristicScore = scoreFileWithHeuristics(filePath, group, query.toLowerCase().split(/\s+/));
                    scoredFiles.set(filePath, {
                        score: heuristicScore,
                        llmScored: false,
                        symbolCount: group.symbols.length
                    });
                }
            }
        }
    } catch (error) {
        log(`Context builder: LLM scoring failed: ${error.message}, falling back to heuristics`);
        // Fall back to heuristic scoring
        return scoreFilesWithHeuristics(fileGroups, query.toLowerCase().split(/\s+/));
    }
    
    // Score any remaining files not sent to LLM with heuristics
    for (const [filePath, group] of fileGroups) {
        if (!scoredFiles.has(filePath)) {
            const heuristicScore = scoreFileWithHeuristics(filePath, group, query.toLowerCase().split(/\s+/));
            scoredFiles.set(filePath, {
                score: heuristicScore,
                llmScored: false,
                symbolCount: group.symbols.length
            });
        }
    }
    
    return scoredFiles;
}

/**
 * Score files using heuristics (fallback when LLM not available)
 */
function scoreFilesWithHeuristics(fileGroups, queryTerms) {
    const scoredFiles = new Map();
    
    for (const [filePath, group] of fileGroups) {
        const score = scoreFileWithHeuristics(filePath, group, queryTerms);
        scoredFiles.set(filePath, {
            score,
            llmScored: false,
            symbolCount: group.symbols.length
        });
    }
    
    return scoredFiles;
}

/**
 * Score a single file using heuristics
 */
function scoreFileWithHeuristics(filePath, group, queryTerms) {
    let score = 0;
    const fileName = (filePath.split('/').pop() || '').toLowerCase();
    const fileNameNoExt = fileName.replace(/\.[^.]+$/, '');
    
    // Track matched terms for multi-match bonus
    const matchedTerms = new Set();
    
    for (const term of queryTerms) {
        // Filename exact match
        if (fileName.includes(term)) {
            score += 150;
            matchedTerms.add(term);
        }
        // Trigram match
        else {
            const triScore = trigramSimilarity(term, fileNameNoExt);
            if (triScore >= 0.4) {
                score += Math.floor(triScore * 120);
                matchedTerms.add(term);
            }
        }
        
        // Symbol name matches
        for (const sym of group.symbols.slice(0, 10)) {
            const symName = (sym.name || '').toLowerCase();
            if (symName.includes(term)) {
                score += 20;
                matchedTerms.add(term);
            }
        }
    }
    
    // Multi-term bonus: files matching multiple query terms are more relevant
    if (queryTerms.length >= 2 && matchedTerms.size >= 2) {
        score *= (1 + (matchedTerms.size - 1) * 0.3);
    }
    
    // Penalty for single-term match when query has multiple terms
    if (queryTerms.length >= 2 && matchedTerms.size <= 1) {
        score *= 0.7;
    }
    
    // Bonus for files found by multiple search methods
    score += group.matchSources.size * 10;
    
    return Math.round(score);
}

/**
 * Apply file scores to individual symbols
 */
function applyFileScoresToSymbols(symbols, scoredFiles, queryTerms) {
    return symbols.map(sym => {
        const fileData = scoredFiles.get(sym.file);
        const fileScore = fileData ? fileData.score : 50;
        
        // Combine file score with symbol-specific scoring
        let symbolBonus = 0;
        const symName = (sym.name || '').toLowerCase();
        
        for (const term of queryTerms) {
            if (symName.includes(term)) {
                symbolBonus += 30;
            }
        }
        
        // Data structures get a bonus
        if (['struct', 'typedef', 'class', 'enum', 'type'].includes(sym.type)) {
            symbolBonus += 15;
        }
        
        return {
            ...sym,
            relevanceScore: fileScore + symbolBonus,
            fileScore,
            llmScored: fileData?.llmScored || false
        };
    }).sort((a, b) => b.relevanceScore - a.relevanceScore);
}

// ============================================================
// PRIMARY CONTEXT (VERBATIM)
// ============================================================

/**
 * Build primary context from high-relevance results
 * These are kept VERBATIM - no summarization
 */
function buildPrimaryContext(primary, query, maxChars) {
    const parts = [];
    let currentSize = 0;
    
    // Group symbols by file for better organization
    const byFile = new Map();
    for (const sym of primary.symbols) {
        const file = sym.file || 'unknown';
        if (!byFile.has(file)) byFile.set(file, []);
        byFile.get(file).push(sym);
    }
    
    // Process files in order of total relevance
    const fileOrder = Array.from(byFile.entries())
        .map(([file, syms]) => ({
            file,
            syms,
            totalScore: syms.reduce((sum, s) => sum + (s.relevanceScore || 0), 0)
        }))
        .sort((a, b) => b.totalScore - a.totalScore);
    
    for (const { file, syms } of fileOrder) {
        const fileName = file.split('/').pop();
        let fileSection = `\n## 📄 ${fileName}\n`;
        fileSection += `Path: \`${file}\`\n\n`;
        
        // Sort symbols within file by relevance
        syms.sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0));
        
        for (const sym of syms) {
            const symText = formatSymbolVerbatim(sym);
            
            if (currentSize + fileSection.length + symText.length < maxChars) {
                fileSection += symText;
            }
        }
        
        if (fileSection.length > 100) {  // Has actual content
            parts.push(fileSection);
            currentSize += fileSection.length;
        }
        
        if (currentSize >= maxChars * 0.95) break;
    }
    
    // Add code blocks that aren't already covered
    const coveredSymbols = new Set(primary.symbols.map(s => s.name));
    for (const block of primary.codeBlocks) {
        if (!coveredSymbols.has(block.symbol)) {
            const blockText = formatCodeBlockVerbatim(block);
            if (currentSize + blockText.length < maxChars) {
                parts.push(blockText);
                currentSize += blockText.length;
            }
        }
    }
    
    return parts.join('\n');
}

/**
 * Format a symbol with full detail (verbatim, no summarization)
 */
function formatSymbolVerbatim(sym) {
    const lang = detectLanguage(sym.file);
    let text = `### ${sym.type}: \`${sym.name}\`\n`;
    text += `Line: ${sym.line || 0}`;
    if (sym.relevanceScore) {
        text += ` | Relevance: ${sym.relevanceScore.toFixed(0)}`;
    }
    text += '\n';
    
    if (sym.signature) {
        text += `\`\`\`${lang}\n${sym.signature}\n\`\`\`\n`;
    }
    
    if (sym.summary) {
        text += `> ${sym.summary}\n`;
    }
    
    // Include code if available
    if (sym.code) {
        const codeLines = sym.code.split('\n').slice(0, CONFIG.MAX_CODE_BLOCK_LINES);
        text += `\`\`\`${lang}\n${codeLines.join('\n')}\n\`\`\`\n`;
    }
    
    return text + '\n';
}

/**
 * Format a code block verbatim
 */
function formatCodeBlockVerbatim(block) {
    const lang = detectLanguage(block.file);
    const fileName = block.file?.split('/').pop() || 'unknown';
    
    let text = `### Code: ${fileName}:${block.startLine || block.line || 0}`;
    if (block.symbol) {
        text += ` (${block.symbol})`;
    }
    text += '\n';
    
    const code = (block.code || '').split('\n').slice(0, CONFIG.MAX_CODE_BLOCK_LINES).join('\n');
    text += `\`\`\`${lang}\n${code}\n\`\`\`\n\n`;
    
    return text;
}

// ============================================================
// SECONDARY CONTEXT (SUMMARIZED)
// ============================================================

/**
 * Build raw secondary context (before summarization)
 */
function buildSecondaryRawContext(secondary) {
    const parts = [];
    
    for (const sym of secondary.symbols) {
        let text = `${sym.type}: ${sym.name} @ ${sym.file?.split('/').pop()}:${sym.line}\n`;
        if (sym.signature) text += `  ${sym.signature}\n`;
        if (sym.summary) text += `  ${sym.summary}\n`;
        if (sym.code) {
            const shortCode = sym.code.split('\n').slice(0, 20).join('\n');
            text += `\`\`\`\n${shortCode}\n\`\`\`\n`;
        }
        parts.push(text);
    }
    
    for (const block of secondary.codeBlocks) {
        let text = `Code @ ${block.file?.split('/').pop()}:${block.startLine || block.line}\n`;
        if (block.code) {
            const shortCode = block.code.split('\n').slice(0, 15).join('\n');
            text += `\`\`\`\n${shortCode}\n\`\`\`\n`;
        }
        parts.push(text);
    }
    
    return parts.join('\n---\n');
}

/**
 * Summarize secondary context using LLM
 * Key: Query-aware summarization that extracts RELEVANT facts
 */
async function summarizeSecondaryContext(secondary, query, queryTerms, llmClient, maxChars, options = {}) {
    const { log = console.log, onProgress = null } = options;
    
    // Group into chunks by file
    const chunks = createQueryAwareChunks(secondary, queryTerms);
    log(`Context builder: Created ${chunks.length} chunks for summarization`);
    
    if (chunks.length === 0) {
        return '';
    }
    
    // Summarize each chunk with query-aware prompt
    const summaries = [];
    for (let i = 0; i < Math.min(chunks.length, CONFIG.MAX_SECONDARY_CHUNKS); i++) {
        onProgress?.(`Summarizing chunk ${i + 1}/${Math.min(chunks.length, CONFIG.MAX_SECONDARY_CHUNKS)}...`);
        
        const chunk = chunks[i];
        const summary = await summarizeChunkForQuery(chunk, query, queryTerms, llmClient, log);
        if (summary && summary.trim().length > 50) {
            summaries.push(summary);
        }
    }
    
    // Combine summaries
    let combined = summaries.join('\n\n---\n\n');
    
    // If still too large, do one more aggregation pass
    if (combined.length > maxChars && summaries.length > 2) {
        log(`Context builder: Aggregating ${summaries.length} summaries...`);
        onProgress?.('Aggregating summaries...');
        combined = await aggregateSummaries(summaries, query, llmClient, maxChars);
    }
    
    // Final truncation if needed
    if (combined.length > maxChars) {
        combined = combined.substring(0, maxChars - 50) + '\n\n[Additional context truncated]';
    }
    
    return combined;
}

/**
 * Create chunks that group related content and prioritize query-relevant files
 */
function createQueryAwareChunks(secondary, queryTerms) {
    const chunks = [];
    
    // Group by file
    const byFile = new Map();
    for (const sym of secondary.symbols) {
        const file = sym.file || 'unknown';
        if (!byFile.has(file)) byFile.set(file, { symbols: [], codeBlocks: [] });
        byFile.get(file).symbols.push(sym);
    }
    for (const block of secondary.codeBlocks) {
        const file = block.file || 'unknown';
        if (!byFile.has(file)) byFile.set(file, { symbols: [], codeBlocks: [] });
        byFile.get(file).codeBlocks.push(block);
    }
    
    // Score files by query relevance
    const scoredFiles = Array.from(byFile.entries()).map(([file, content]) => {
        let score = 0;
        const fileLower = file.toLowerCase();
        for (const term of queryTerms) {
            if (fileLower.includes(term)) score += 20;
        }
        for (const sym of content.symbols) {
            score += sym.relevanceScore || 0;
        }
        return { file, content, score };
    }).sort((a, b) => b.score - a.score);
    
    // Create chunks from highest-scored files first
    for (const { file, content } of scoredFiles) {
        let chunkText = `## File: ${file.split('/').pop()}\n`;
        chunkText += `Path: ${file}\n\n`;
        
        for (const sym of content.symbols.slice(0, 8)) {
            chunkText += `### ${sym.type}: ${sym.name} (line ${sym.line})\n`;
            if (sym.signature) chunkText += `Signature: ${sym.signature}\n`;
            if (sym.summary) chunkText += `Summary: ${sym.summary}\n`;
            if (sym.code) {
                const shortCode = sym.code.split('\n').slice(0, 25).join('\n');
                chunkText += `\`\`\`\n${shortCode}\n\`\`\`\n`;
            }
            chunkText += '\n';
        }
        
        for (const block of content.codeBlocks.slice(0, 3)) {
            chunkText += `### Code block at line ${block.startLine || block.line}\n`;
            if (block.code) {
                const shortCode = block.code.split('\n').slice(0, 20).join('\n');
                chunkText += `\`\`\`\n${shortCode}\n\`\`\`\n`;
            }
            chunkText += '\n';
        }
        
        // Split large chunks
        if (chunkText.length > CONFIG.CHUNK_SIZE_CHARS) {
            const parts = splitChunk(chunkText, CONFIG.CHUNK_SIZE_CHARS);
            chunks.push(...parts);
        } else if (chunkText.length > 200) {
            chunks.push(chunkText);
        }
    }
    
    return chunks;
}

/**
 * Summarize a single chunk with query-aware extraction
 * KEY: This prompt focuses on extracting FACTS relevant to the query
 */
async function summarizeChunkForQuery(chunk, query, queryTerms, llmClient, log) {
    const termsStr = queryTerms.join(', ');
    
    const prompt = `You are extracting code facts to answer: "${query}"

CODE TO ANALYZE:
${chunk}

EXTRACT the following (ONLY if present in the code above):

1. **Data Structures** relevant to "${termsStr}":
   - Struct/type name, file, key fields and their purpose
   
2. **Functions** that implement or support "${termsStr}":
   - Function name, signature, what it does, key parameters
   
3. **Algorithm Steps** visible in this code:
   - What operations are performed, in what order
   
4. **Key Code Snippets** (copy verbatim if important):
   - Critical conditionals, loops, or calls

RULES:
- Extract ONLY facts from the code above
- Include file:line references
- Copy important code snippets verbatim (max 10 lines each)
- If nothing relevant to "${termsStr}", respond with "No relevant content"
- Keep response under ${CONFIG.SUMMARY_TARGET_CHARS} characters

EXTRACTED FACTS:`;

    try {
        const result = await llmClient.complete(prompt, {
            maxTokens: 600,
            temperature: 0.2  // Low temperature for factual extraction
        });
        return result || '';
    } catch (error) {
        log(`Error summarizing chunk: ${error.message}`);
        // Fallback: keep first part of chunk
        return chunk.substring(0, CONFIG.SUMMARY_TARGET_CHARS) + '\n[truncated]';
    }
}

/**
 * Aggregate multiple summaries into a coherent whole
 */
async function aggregateSummaries(summaries, query, llmClient, maxChars) {
    const combined = summaries.join('\n\n---\n\n');
    
    const prompt = `Combine these code analysis summaries to answer: "${query}"

SUMMARIES TO COMBINE:
${combined}

Create a unified summary that:
1. Merges duplicate information
2. Preserves ALL function names, signatures, and file locations
3. Keeps important code snippets verbatim
4. Organizes by: Data Structures → Functions → Algorithm Flow
5. Removes redundancy but NOT detail

Keep response under ${maxChars} characters.

COMBINED SUMMARY:`;

    try {
        const result = await llmClient.complete(prompt, {
            maxTokens: Math.floor(maxChars / 4),  // ~4 chars per token
            temperature: 0.2
        });
        return result || combined.substring(0, maxChars);
    } catch (error) {
        return combined.substring(0, maxChars);
    }
}

// ============================================================
// FINAL ASSEMBLY
// ============================================================

/**
 * Assemble final context from primary and secondary parts
 */
function assembleFinalContext(primaryContext, secondaryContext, query, searchResults) {
    let context = `# Code Analysis Context\n\n`;
    context += `**Query:** ${query}\n`;
    context += `**Search Results:** ${searchResults.symbols?.length || 0} symbols, `;
    context += `${searchResults.codeBlocks?.length || 0} code blocks\n\n`;
    context += `---\n\n`;
    
    // Primary context (high relevance, verbatim)
    if (primaryContext.trim()) {
        context += `# PRIMARY RESULTS (High Relevance)\n`;
        context += primaryContext;
        context += '\n\n';
    }
    
    // Secondary context (supporting, possibly summarized)
    if (secondaryContext.trim()) {
        context += `# SUPPORTING CONTEXT\n`;
        context += secondaryContext;
    }
    
    return context;
}

// ============================================================
// UTILITIES
// ============================================================

/**
 * Split large text into smaller chunks
 */
function splitChunk(text, maxSize) {
    const chunks = [];
    const lines = text.split('\n');
    let current = '';
    
    for (const line of lines) {
        if (current.length + line.length > maxSize && current.length > 0) {
            chunks.push(current);
            current = '';
        }
        current += line + '\n';
    }
    
    if (current.length > 0) {
        chunks.push(current);
    }
    
    return chunks;
}

/**
 * Detect language from file path
 */
function detectLanguage(filePath) {
    if (!filePath) return 'c';
    const ext = filePath.split('.').pop()?.toLowerCase();
    const langMap = {
        'c': 'c', 'h': 'c',
        'cpp': 'cpp', 'cc': 'cpp', 'cxx': 'cpp', 'hpp': 'cpp',
        'js': 'javascript', 'jsx': 'javascript',
        'ts': 'typescript', 'tsx': 'typescript',
        'py': 'python',
        'java': 'java',
        'go': 'go',
        'rs': 'rust',
        'rb': 'ruby',
        'sql': 'sql',
        'cbl': 'cobol', 'cob': 'cobol',
        'tal': 'tal'
    };
    return langMap[ext] || ext || 'c';
}

/**
 * Smart truncation fallback when no LLM available
 */
function smartTruncateContext(context, maxChars) {
    if (context.length <= maxChars) return context;
    
    const lines = context.split('\n');
    const result = [];
    let currentSize = 0;
    
    // Priority 1: Headers and structure definitions (40%)
    for (const line of lines) {
        if (line.startsWith('#') || line.startsWith('**') || 
            line.includes('struct') || line.includes('typedef') ||
            line.includes('function:') || line.includes('Signature:')) {
            if (currentSize + line.length < maxChars * 0.4) {
                result.push(line);
                currentSize += line.length + 1;
            }
        }
    }
    
    // Priority 2: Code blocks (next 40%)
    let inCodeBlock = false;
    let codeBlockLines = [];
    for (const line of lines) {
        if (line.startsWith('```')) {
            if (inCodeBlock && codeBlockLines.length > 0) {
                const block = codeBlockLines.join('\n');
                if (currentSize + block.length < maxChars * 0.8) {
                    result.push(...codeBlockLines);
                    currentSize += block.length;
                }
                codeBlockLines = [];
            }
            inCodeBlock = !inCodeBlock;
            result.push(line);
            currentSize += line.length + 1;
        } else if (inCodeBlock) {
            codeBlockLines.push(line);
        }
    }
    
    // Priority 3: Fill with remaining content
    for (const line of lines) {
        if (!result.includes(line) && line.trim().length > 0) {
            if (currentSize + line.length < maxChars) {
                result.push(line);
                currentSize += line.length + 1;
            }
        }
    }
    
    return result.join('\n') + '\n\n[Context truncated]';
}

// ============================================================
// LEGACY COMPATIBILITY
// ============================================================

/**
 * Legacy function for backwards compatibility
 */
function buildInitialContext(searchResults, query) {
    // Call new function with no LLM (will use smart truncation)
    const result = buildPrimaryContext(
        { symbols: searchResults.symbols || [], codeBlocks: searchResults.codeBlocks || [] },
        query,
        CONFIG.MAX_CONTEXT_CHARS
    );
    return result;
}

/**
 * Legacy hierarchical summarize
 */
async function hierarchicalSummarize(searchResults, query, llmClient, options = {}) {
    const { log = console.log, onProgress = null, maxContextChars = CONFIG.MAX_CONTEXT_CHARS } = options;
    
    const queryTerms = extractQueryTerms(query);
    const { primary, secondary } = partitionByRelevance(searchResults, queryTerms, log);
    
    const primaryContext = buildPrimaryContext(primary, query, Math.floor(maxContextChars * 0.6));
    
    let secondaryContext = '';
    if (secondary.symbols.length > 0) {
        secondaryContext = await summarizeSecondaryContext(
            secondary, query, queryTerms, llmClient, 
            maxContextChars - primaryContext.length - 500,
            { log, onProgress }
        );
    }
    
    return {
        context: assembleFinalContext(primaryContext, secondaryContext, query, searchResults),
        chunksProcessed: Math.ceil(secondary.symbols.length / 10),
        levels: 1
    };
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    buildContext,
    buildInitialContext,
    hierarchicalSummarize,
    smartTruncateContext,
    extractQueryTerms,
    scoreRelevance,
    trigramSimilarity,
    partitionByRelevance,
    scoreFilesWithLLM,
    groupResultsByFile,
    CONFIG
};
