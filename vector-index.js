/**
 * AstraCode Vector Indexing
 * TF-IDF embeddings and trigram search functionality
 */

const vscode = require('vscode');
const { VECTOR_CONFIG, TRIGRAM_CONFIG } = require('./config');
const { log } = require('./logging');
const pathUtils = require('./pathUtils');

// ============================================================
// TF-IDF Embedding
// ============================================================

/**
 * Build TF-IDF vocabulary from chunks
 */
function buildTfidfVocabulary(chunks, vocabulary) {
    log('Building TF-IDF vocabulary from', chunks.length, 'chunks');
    
    vocabulary.terms.clear();
    vocabulary.numDocs = chunks.length;
    vocabulary.built = false;
    
    // Count document frequency for each term
    const df = new Map(); // term -> number of documents containing it
    
    for (const chunk of chunks) {
        const terms = tokenize(chunk.text);
        const uniqueTerms = new Set(terms);
        
        for (const term of uniqueTerms) {
            df.set(term, (df.get(term) || 0) + 1);
        }
    }
    
    // Build vocabulary with IDF values
    let index = 0;
    for (const [term, docFreq] of df.entries()) {
        // Skip very rare terms (appear in < 2 docs) and very common terms (appear in > 50% of docs)
        if (docFreq < 2 || docFreq > chunks.length * 0.5) {
            continue;
        }
        
        vocabulary.terms.set(term, {
            index: index++,
            df: docFreq,
            idf: Math.log(chunks.length / docFreq)
        });
    }
    
    vocabulary.built = true;
    log('TF-IDF vocabulary built:', vocabulary.terms.size, 'terms');
    
    return vocabulary;
}

/**
 * Tokenize text for TF-IDF
 */
function tokenize(text) {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && w.length < 30);
}

/**
 * Generate TF-IDF embedding for text
 */
function generateTfidfEmbedding(text, vocabulary, dimensions = 384) {
    const embedding = new Float32Array(dimensions);
    
    if (!vocabulary.built || vocabulary.terms.size === 0) {
        // Fall back to simple hash embedding
        return simpleHashEmbedding(text, dimensions);
    }
    
    const terms = tokenize(text);
    const termCounts = new Map();
    
    // Count term frequencies
    for (const term of terms) {
        termCounts.set(term, (termCounts.get(term) || 0) + 1);
    }
    
    // Build TF-IDF vector
    for (const [term, count] of termCounts) {
        const vocabEntry = vocabulary.terms.get(term);
        if (vocabEntry) {
            const tf = count / terms.length;
            const tfidf = tf * vocabEntry.idf;
            const idx = vocabEntry.index % dimensions;
            embedding[idx] += tfidf;
        }
    }
    
    // L2 normalize
    let norm = 0;
    for (let i = 0; i < dimensions; i++) {
        norm += embedding[i] * embedding[i];
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
        for (let i = 0; i < dimensions; i++) {
            embedding[i] /= norm;
        }
    }
    
    return embedding;
}

/**
 * Simple hash-based embedding (fast, no dependencies)
 * Uses character n-grams and word frequencies to create a fixed-size vector
 */
function simpleHashEmbedding(text, dimensions = 384) {
    const embedding = new Float32Array(dimensions);
    
    // Normalize text
    const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
    const words = normalized.split(/\s+/).filter(w => w.length > 1);
    
    // Word-level features (TF-like)
    for (const word of words) {
        const hash = simpleHash(word);
        const idx = Math.abs(hash) % dimensions;
        embedding[idx] += 1;
        
        // Also add character trigrams for partial matching
        for (let i = 0; i < word.length - 2; i++) {
            const trigram = word.substring(i, i + 3);
            const trigramHash = simpleHash(trigram);
            const trigramIdx = Math.abs(trigramHash) % dimensions;
            embedding[trigramIdx] += 0.5;
        }
    }
    
    // Add bigrams for phrase matching
    for (let i = 0; i < words.length - 1; i++) {
        const bigram = words[i] + '_' + words[i + 1];
        const hash = simpleHash(bigram);
        const idx = Math.abs(hash) % dimensions;
        embedding[idx] += 0.7;
    }
    
    // L2 normalize
    let norm = 0;
    for (let i = 0; i < dimensions; i++) {
        norm += embedding[i] * embedding[i];
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
        for (let i = 0; i < dimensions; i++) {
            embedding[i] /= norm;
        }
    }
    
    return embedding;
}

/**
 * Simple string hash function (djb2)
 */
function simpleHash(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash) + str.charCodeAt(i);
        hash = hash & hash; // Convert to 32bit integer
    }
    return hash;
}

/**
 * Cosine similarity between two vectors
 */
function cosineSimilarity(a, b) {
    if (a.length !== b.length) return 0;
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    
    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
}

// ============================================================
// TRIGRAM INDEX (Zoekt-style)
// ============================================================

/**
 * Extract trigrams from text
 */
function extractTrigrams(text, caseSensitive = false) {
    const normalized = caseSensitive ? text : text.toLowerCase();
    const trigrams = [];
    
    for (let i = 0; i <= normalized.length - 3; i++) {
        const trigram = normalized.substring(i, i + 3);
        // Skip trigrams that are all whitespace
        if (!/^\s+$/.test(trigram)) {
            trigrams.push(trigram);
        }
    }
    
    return trigrams;
}

/**
 * Build trigram index for a file
 */
function indexFileForTrigrams(filePath, content, trigramIndex) {
    if (!content || content.length > TRIGRAM_CONFIG.MAX_FILE_SIZE) {
        return;
    }
    
    const normalized = TRIGRAM_CONFIG.CASE_SENSITIVE ? content : content.toLowerCase();
    const fileTrigramMap = new Map(); // trigram -> positions
    
    for (let i = 0; i <= normalized.length - 3; i++) {
        const trigram = normalized.substring(i, i + 3);
        if (/^\s+$/.test(trigram)) continue;
        
        if (!fileTrigramMap.has(trigram)) {
            fileTrigramMap.set(trigram, []);
        }
        
        const positions = fileTrigramMap.get(trigram);
        if (positions.length < TRIGRAM_CONFIG.MAX_POSITIONS_PER_FILE) {
            positions.push(i);
        }
    }
    
    // Add to global index
    for (const [trigram, positions] of fileTrigramMap) {
        if (!trigramIndex.index.has(trigram)) {
            trigramIndex.index.set(trigram, []);
        }
        trigramIndex.index.get(trigram).push({
            file: filePath,
            positions: positions
        });
    }
    
    // Store file content for verification
    trigramIndex.fileContent.set(filePath, content);
    trigramIndex.stats.files++;
}

/**
 * Search trigram index
 */
function searchTrigramIndex(query, trigramIndex, options = {}) {
    const { caseSensitive = false, maxResults = 100 } = options;
    
    if (query.length < TRIGRAM_CONFIG.MIN_QUERY_LENGTH) {
        return [];
    }
    
    const queryTrigrams = extractTrigrams(query, caseSensitive);
    if (queryTrigrams.length === 0) {
        return [];
    }
    
    // Find files that contain all query trigrams
    const fileMatches = new Map(); // file -> {positions, matchCount}
    
    for (const trigram of queryTrigrams) {
        const entries = trigramIndex.index.get(trigram);
        if (!entries) continue;
        
        for (const entry of entries) {
            if (!fileMatches.has(entry.file)) {
                fileMatches.set(entry.file, {
                    positions: new Set(),
                    trigramMatches: 0
                });
            }
            
            const match = fileMatches.get(entry.file);
            match.trigramMatches++;
            for (const pos of entry.positions) {
                match.positions.add(pos);
            }
        }
    }
    
    // Filter to files that match most trigrams and verify actual matches
    const results = [];
    const minTrigramMatch = Math.max(1, queryTrigrams.length * 0.5);
    
    for (const [file, match] of fileMatches) {
        if (match.trigramMatches < minTrigramMatch) continue;
        
        const content = trigramIndex.fileContent.get(file);
        if (!content) continue;
        
        // Verify actual matches in content
        const searchContent = caseSensitive ? content : content.toLowerCase();
        const searchQuery = caseSensitive ? query : query.toLowerCase();
        
        const lines = content.split('\n');
        const matches = [];
        let pos = 0;
        
        for (let lineNum = 0; lineNum < lines.length && matches.length < 20; lineNum++) {
            const line = lines[lineNum];
            const searchLine = caseSensitive ? line : line.toLowerCase();
            
            if (searchLine.includes(searchQuery)) {
                matches.push({
                    line: lineNum + 1,
                    context: line.trim().substring(0, 200)
                });
            }
        }
        
        if (matches.length > 0) {
            results.push({
                file: file,
                fileName: pathUtils.getFileName(file),
                matchCount: matches.length,
                matches: matches
            });
        }
    }
    
    // Sort by match count
    results.sort((a, b) => b.matchCount - a.matchCount);
    
    return results.slice(0, maxResults);
}

/**
 * Build trigram index (lightweight version)
 */
async function buildTrigramIndexLightweight(contextFiles, trigramIndex, options = {}) {
    const { maxFilesToIndex = 500, maxFileSize = 50000, showProgressUI = false, onProgress = null } = options;
    
    log('Building lightweight trigram index...');
    
    // Clear existing index
    trigramIndex.index.clear();
    trigramIndex.fileContent.clear();
    trigramIndex.stats = { trigrams: 0, files: 0, totalPositions: 0 };
    
    let indexed = 0;
    const filesToIndex = Array.from(contextFiles.entries()).slice(0, maxFilesToIndex);
    
    for (const [filePath, file] of filesToIndex) {
        const content = file.content;
        if (!content || content.length > maxFileSize) continue;
        
        indexFileForTrigrams(filePath, content, trigramIndex);
        indexed++;
        
        if (showProgressUI && onProgress && indexed % 50 === 0) {
            onProgress(Math.round((indexed / filesToIndex.length) * 100), `Indexing trigrams: ${indexed}/${filesToIndex.length}`);
        }
        
        // Yield to UI periodically
        if (indexed % 20 === 0) {
            await new Promise(r => setTimeout(r, 1));
        }
    }
    
    trigramIndex.stats.trigrams = trigramIndex.index.size;
    trigramIndex.lastUpdated = new Date();
    
    log(`Trigram index built: ${trigramIndex.stats.trigrams} unique trigrams from ${trigramIndex.stats.files} files`);
    
    return trigramIndex;
}

// ============================================================
// Vector Index Operations
// ============================================================

/**
 * Search vector index for similar chunks
 */
function searchVectorIndex(query, vectorIndex, vocabulary, topK = 10) {
    log('searchVectorIndex called - chunks:', vectorIndex.chunks.length, 'query:', query.substring(0, 50));
    
    if (vectorIndex.chunks.length === 0) {
        log('Vector index is empty');
        return [];
    }
    
    // Embed the query
    const queryEmbedding = generateTfidfEmbedding(query, vocabulary, vectorIndex.dimensions);
    log('Query embedded, dimensions:', queryEmbedding.length, 'model:', vectorIndex.model);
    
    // Calculate similarities
    const results = [];
    const dimensions = vectorIndex.dimensions;
    
    for (let i = 0; i < vectorIndex.chunks.length; i++) {
        const chunk = vectorIndex.chunks[i];
        
        // Get embedding from flat array
        const chunkEmbedding = vectorIndex.embeddings 
            ? vectorIndex.embeddings.slice(i * dimensions, (i + 1) * dimensions)
            : chunk.embedding;
        
        if (!chunkEmbedding) continue;
        
        const similarity = cosineSimilarity(queryEmbedding, chunkEmbedding);
        
        if (similarity >= VECTOR_CONFIG.SIMILARITY_THRESHOLD) {
            results.push({
                ...chunk,
                similarity,
                source: 'vector'
            });
        }
    }
    
    // Sort by similarity and return top K
    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, topK);
}

/**
 * Get vector index statistics
 */
function getVectorIndexStats(vectorIndex) {
    if (vectorIndex.chunks.length === 0) {
        return null;
    }
    
    const files = new Set(vectorIndex.chunks.map(c => c.file));
    const types = {};
    for (const chunk of vectorIndex.chunks) {
        types[chunk.type] = (types[chunk.type] || 0) + 1;
    }
    
    return {
        chunks: vectorIndex.chunks.length,
        files: files.size,
        types,
        dimensions: vectorIndex.dimensions,
        model: vectorIndex.model,
        lastUpdated: vectorIndex.lastUpdated,
        memorySizeMB: vectorIndex.embeddings 
            ? (vectorIndex.embeddings.byteLength / (1024 * 1024)).toFixed(2)
            : 0
    };
}

/**
 * Save vector index to disk
 */
async function saveVectorIndex(vectorIndex) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return;
    
    try {
        const astraDir = vscode.Uri.joinPath(workspaceFolder.uri, '.astra', 'vectors');
        await vscode.workspace.fs.createDirectory(astraDir);
        
        // Save chunks metadata (without embeddings)
        const chunksData = vectorIndex.chunks.map(c => ({
            id: c.id,
            file: c.file,
            fileName: c.fileName,
            startLine: c.startLine,
            endLine: c.endLine,
            type: c.type,
            symbolName: c.symbolName,
            textLength: c.text.length
        }));
        
        const metadata = {
            version: 1,
            model: vectorIndex.model,
            dimensions: vectorIndex.dimensions,
            chunkCount: vectorIndex.chunks.length,
            lastUpdated: vectorIndex.lastUpdated?.toISOString(),
            chunks: chunksData
        };
        
        const metadataUri = vscode.Uri.joinPath(astraDir, 'index.json');
        await vscode.workspace.fs.writeFile(metadataUri, Buffer.from(JSON.stringify(metadata, null, 2)));
        
        // Save embeddings as binary
        if (vectorIndex.embeddings) {
            const embeddingsUri = vscode.Uri.joinPath(astraDir, 'embeddings.bin');
            const buffer = Buffer.from(vectorIndex.embeddings.buffer);
            await vscode.workspace.fs.writeFile(embeddingsUri, buffer);
        }
        
        log(`Vector index saved: ${vectorIndex.chunks.length} chunks`);
        
    } catch (error) {
        log('Error saving vector index:', error.message);
    }
}

/**
 * Load vector index from disk
 */
async function loadVectorIndex(vectorIndex) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return false;
    
    try {
        const astraDir = vscode.Uri.joinPath(workspaceFolder.uri, '.astra', 'vectors');
        
        // Load metadata
        const metadataUri = vscode.Uri.joinPath(astraDir, 'index.json');
        const metadataBytes = await vscode.workspace.fs.readFile(metadataUri);
        const metadata = JSON.parse(Buffer.from(metadataBytes).toString('utf8'));
        
        // Load embeddings
        const embeddingsUri = vscode.Uri.joinPath(astraDir, 'embeddings.bin');
        const embeddingsBytes = await vscode.workspace.fs.readFile(embeddingsUri);
        const embeddings = new Float32Array(embeddingsBytes.buffer.slice(
            embeddingsBytes.byteOffset,
            embeddingsBytes.byteOffset + embeddingsBytes.byteLength
        ));
        
        // Reconstruct chunks
        vectorIndex.chunks = metadata.chunks.map((c, i) => ({
            ...c,
            text: '', // Will be populated if needed
            embedding: embeddings.slice(i * metadata.dimensions, (i + 1) * metadata.dimensions)
        }));
        
        vectorIndex.embeddings = embeddings;
        vectorIndex.dimensions = metadata.dimensions;
        vectorIndex.model = metadata.model;
        vectorIndex.lastUpdated = metadata.lastUpdated ? new Date(metadata.lastUpdated) : null;
        
        log(`Vector index loaded: ${vectorIndex.chunks.length} chunks`);
        return true;
        
    } catch (error) {
        log('No vector index found or error loading:', error.message);
        return false;
    }
}

/**
 * Clear vector index
 */
async function clearVectorIndex(vectorIndex) {
    vectorIndex.chunks = [];
    vectorIndex.embeddings = null;
    vectorIndex.lastUpdated = null;
    
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
        try {
            const vectorsDir = vscode.Uri.joinPath(workspaceFolder.uri, '.astra', 'vectors');
            await vscode.workspace.fs.delete(vectorsDir, { recursive: true });
            log('Vector index directory deleted');
        } catch (e) {
            // Directory may not exist
        }
    }
    
    log('Vector index cleared');
}

module.exports = {
    // TF-IDF
    buildTfidfVocabulary,
    tokenize,
    generateTfidfEmbedding,
    simpleHashEmbedding,
    simpleHash,
    cosineSimilarity,
    
    // Trigram
    extractTrigrams,
    indexFileForTrigrams,
    searchTrigramIndex,
    buildTrigramIndexLightweight,
    
    // Vector
    searchVectorIndex,
    getVectorIndexStats,
    saveVectorIndex,
    loadVectorIndex,
    clearVectorIndex
};
