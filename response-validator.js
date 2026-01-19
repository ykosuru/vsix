/**
 * AstraCode Response Validator
 * 
 * Validates LLM responses against the provided code context to detect hallucinations.
 * 
 * Usage:
 *   const { ResponseValidator } = require('./response-validator');
 *   const validator = new ResponseValidator(codeIndex, contextFiles);
 *   const result = validator.validate(response, query);
 *   if (!result.isValid) {
 *       // Handle hallucination
 *   }
 */

// ============================================================
// HALLUCINATION PATTERNS
// ============================================================

/**
 * Phrases that often indicate the LLM is making things up
 */
const HALLUCINATION_INDICATORS = [
    // Hedging phrases that suggest guessing
    /\btypically\b/i,
    /\busually\b/i,
    /\bgenerally\b/i,
    /\bcommonly\b/i,
    /\bnormally\b/i,
    /\boften\b/i,
    /\bprobably\b/i,
    /\blikely\b/i,
    /\bmight\b.*\bbe\b/i,
    /\bcould\b.*\bbe\b/i,
    /\bwould\b.*\bbe\b/i,
    /\bshould\b.*\bbe\b/i,
    /\bassuming\b/i,
    /\bpresumably\b/i,
    
    // Standard library assumptions
    /\bstandard\s+(library|implementation|behavior|practice)\b/i,
    /\bby\s+convention\b/i,
    /\bin\s+most\s+(cases|implementations)\b/i,
    /\bas\s+is\s+common\b/i,
    
    // External knowledge indicators
    /\bbased\s+on\s+(my|general)\s+knowledge\b/i,
    /\bfrom\s+what\s+I\s+know\b/i,
    /\bin\s+similar\s+systems\b/i,
    /\bother\s+implementations\b/i,
    
    // Speculation
    /\bI\s+believe\b/i,
    /\bI\s+think\b/i,
    /\bI\s+assume\b/i,
    /\bI\s+expect\b/i,
    /\bI\s+imagine\b/i,
    /\bI\s+suppose\b/i
];

/**
 * Phrases that indicate good grounding
 */
const GROUNDING_INDICATORS = [
    /\bin\s+`?[\w.]+`?\s*,?\s*(line|at line)\s+\d+/i,     // "in file.c, line 42"
    /\b(line|lines)\s+\d+(-\d+)?\b/i,                      // "line 42" or "lines 42-50"
    /\bthe\s+(function|method|class|variable)\s+`?\w+`?\s+(in|at|from)\b/i,
    /\bfound\s+in\b/i,
    /\bshown\s+in\b/i,
    /\bvisible\s+in\b/i,
    /\baccording\s+to\s+the\s+code\b/i,
    /\bthe\s+code\s+shows\b/i,
    /\bas\s+defined\s+in\b/i
];

// ============================================================
// RESPONSE VALIDATOR CLASS
// ============================================================

class ResponseValidator {
    /**
     * @param {Object} codeIndex - The code index with symbols, files, etc.
     * @param {Map} contextFiles - Map of file paths to file contents
     * @param {Object} options - Validation options
     */
    constructor(codeIndex, contextFiles, options = {}) {
        this.codeIndex = codeIndex;
        this.contextFiles = contextFiles;
        this.options = {
            strictMode: options.strictMode || false,
            minCitationRatio: options.minCitationRatio || 0.1, // At least 10% of claims should have citations
            maxHallucinationScore: options.maxHallucinationScore || 3,
            logFn: options.logFn || console.log
        };
        
        // Build lookup sets for fast validation
        this._buildLookups();
    }

    /**
     * Build lookup sets from the code index
     */
    _buildLookups() {
        this.knownSymbols = new Set();
        this.knownFiles = new Set();
        this.knownFunctions = new Set();
        this.knownVariables = new Set();
        
        // Extract symbol names
        if (this.codeIndex?.symbols) {
            for (const [key, symbol] of this.codeIndex.symbols) {
                this.knownSymbols.add(symbol.name.toLowerCase());
                if (['function', 'method', 'procedure'].includes(symbol.type)) {
                    this.knownFunctions.add(symbol.name.toLowerCase());
                }
                if (['variable', 'parameter', 'field'].includes(symbol.type)) {
                    this.knownVariables.add(symbol.name.toLowerCase());
                }
            }
        }
        
        // Extract file names
        if (this.contextFiles) {
            for (const [path] of this.contextFiles) {
                const fileName = path.split('/').pop().toLowerCase();
                this.knownFiles.add(fileName);
                // Also add without extension
                const baseName = fileName.replace(/\.[^.]+$/, '');
                this.knownFiles.add(baseName);
            }
        }
        
        this.options.logFn(`[Validator] Built lookups: ${this.knownSymbols.size} symbols, ${this.knownFiles.size} files`);
    }

    /**
     * Validate a response against the code context
     * @param {string} response - The LLM response to validate
     * @param {string} query - The original user query
     * @returns {Object} Validation result
     */
    validate(response, query) {
        const result = {
            isValid: true,
            confidence: 1.0,
            issues: [],
            warnings: [],
            citations: [],
            unknownReferences: [],
            hallucinationScore: 0,
            groundingScore: 0
        };
        
        // Check for hallucination indicators
        const hallucinationMatches = this._checkHallucinationIndicators(response);
        result.hallucinationScore = hallucinationMatches.length;
        if (hallucinationMatches.length > 0) {
            result.warnings.push({
                type: 'hallucination_indicators',
                message: `Found ${hallucinationMatches.length} phrases that may indicate speculation`,
                matches: hallucinationMatches.slice(0, 5) // Limit to 5
            });
        }
        
        // Check for grounding indicators
        const groundingMatches = this._checkGroundingIndicators(response);
        result.groundingScore = groundingMatches.length;
        result.citations = groundingMatches;
        
        // Extract and validate function/symbol references
        const symbolRefs = this._extractSymbolReferences(response);
        for (const ref of symbolRefs) {
            if (!this._isKnownSymbol(ref)) {
                result.unknownReferences.push(ref);
            }
        }
        
        if (result.unknownReferences.length > 0) {
            result.issues.push({
                type: 'unknown_symbols',
                message: `Response mentions ${result.unknownReferences.length} symbols not found in attached code`,
                symbols: result.unknownReferences.slice(0, 10)
            });
        }
        
        // Extract and validate file references
        const fileRefs = this._extractFileReferences(response);
        for (const ref of fileRefs) {
            if (!this._isKnownFile(ref)) {
                result.issues.push({
                    type: 'unknown_file',
                    message: `Response mentions file "${ref}" which is not in attached code`,
                    file: ref
                });
            }
        }
        
        // Calculate overall validity
        result.isValid = this._calculateValidity(result);
        result.confidence = this._calculateConfidence(result);
        
        return result;
    }

    /**
     * Check for hallucination indicator phrases
     */
    _checkHallucinationIndicators(text) {
        const matches = [];
        for (const pattern of HALLUCINATION_INDICATORS) {
            const match = text.match(pattern);
            if (match) {
                matches.push({
                    pattern: pattern.toString(),
                    match: match[0],
                    index: match.index
                });
            }
        }
        return matches;
    }

    /**
     * Check for grounding indicator phrases
     */
    _checkGroundingIndicators(text) {
        const matches = [];
        for (const pattern of GROUNDING_INDICATORS) {
            const match = text.match(new RegExp(pattern, 'gi'));
            if (match) {
                matches.push(...match);
            }
        }
        return matches;
    }

    /**
     * Extract symbol/function references from response
     */
    _extractSymbolReferences(text) {
        const refs = new Set();
        
        // Pattern: `functionName` or `functionName()`
        const backtickPattern = /`(\w+)(?:\(\))?`/g;
        let match;
        while ((match = backtickPattern.exec(text)) !== null) {
            refs.add(match[1].toLowerCase());
        }
        
        // Pattern: function functionName or the functionName function
        const functionPattern = /\b(?:function|method|procedure)\s+(\w+)\b/gi;
        while ((match = functionPattern.exec(text)) !== null) {
            refs.add(match[1].toLowerCase());
        }
        
        // Pattern: calls to X, calling X
        const callPattern = /\b(?:calls?(?:\s+to)?|calling)\s+(\w+)\b/gi;
        while ((match = callPattern.exec(text)) !== null) {
            refs.add(match[1].toLowerCase());
        }
        
        return Array.from(refs);
    }

    /**
     * Extract file references from response
     */
    _extractFileReferences(text) {
        const refs = new Set();
        
        // Pattern: filename.ext
        const filePattern = /\b([\w-]+\.(c|h|java|py|js|ts|cpp|hpp|tal|cob|cbl|go|rs|sql))\b/gi;
        let match;
        while ((match = filePattern.exec(text)) !== null) {
            refs.add(match[1].toLowerCase());
        }
        
        // Pattern: in `filename`
        const backtickFilePattern = /\bin\s+`([\w.-]+)`/gi;
        while ((match = backtickFilePattern.exec(text)) !== null) {
            refs.add(match[1].toLowerCase());
        }
        
        return Array.from(refs);
    }

    /**
     * Check if a symbol is known
     */
    _isKnownSymbol(name) {
        const lower = name.toLowerCase();
        
        // Check direct match
        if (this.knownSymbols.has(lower)) return true;
        
        // Check common variations (e.g., with/without underscores)
        const variations = [
            lower.replace(/_/g, ''),
            lower.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()
        ];
        
        for (const v of variations) {
            if (this.knownSymbols.has(v)) return true;
        }
        
        // Allow common language keywords
        const keywords = new Set(['if', 'else', 'for', 'while', 'return', 'int', 'void', 'char', 'string', 'null', 'true', 'false', 'this', 'self']);
        if (keywords.has(lower)) return true;
        
        return false;
    }

    /**
     * Check if a file is known
     */
    _isKnownFile(name) {
        const lower = name.toLowerCase();
        return this.knownFiles.has(lower) || this.knownFiles.has(lower.replace(/\.[^.]+$/, ''));
    }

    /**
     * Calculate overall validity
     */
    _calculateValidity(result) {
        // Invalid if too many unknown symbols
        if (result.unknownReferences.length > 5) {
            return false;
        }
        
        // Invalid if hallucination score too high with no grounding
        if (result.hallucinationScore > this.options.maxHallucinationScore && result.groundingScore === 0) {
            return false;
        }
        
        // Invalid if unknown files are mentioned
        const unknownFileIssues = result.issues.filter(i => i.type === 'unknown_file');
        if (unknownFileIssues.length > 2) {
            return false;
        }
        
        return true;
    }

    /**
     * Calculate confidence score (0-1)
     */
    _calculateConfidence(result) {
        let confidence = 1.0;
        
        // Reduce for hallucination indicators
        confidence -= result.hallucinationScore * 0.1;
        
        // Reduce for unknown references
        confidence -= result.unknownReferences.length * 0.05;
        
        // Boost for grounding indicators
        confidence += Math.min(result.groundingScore * 0.05, 0.2);
        
        // Reduce for unknown file references
        const unknownFileCount = result.issues.filter(i => i.type === 'unknown_file').length;
        confidence -= unknownFileCount * 0.15;
        
        return Math.max(0, Math.min(1, confidence));
    }

    /**
     * Filter a response to remove likely hallucinated content
     * @param {string} response - The response to filter
     * @returns {Object} Filtered response and removed parts
     */
    filterResponse(response) {
        const lines = response.split('\n');
        const filtered = [];
        const removed = [];
        
        for (const line of lines) {
            // Check if line contains unknown symbols
            const refs = this._extractSymbolReferences(line);
            const unknownRefs = refs.filter(r => !this._isKnownSymbol(r));
            
            // Check if line has high hallucination indicators
            const hallucinationMatches = this._checkHallucinationIndicators(line);
            
            // Keep line if it's grounded or neutral
            if (unknownRefs.length === 0 && hallucinationMatches.length < 2) {
                filtered.push(line);
            } else {
                removed.push({
                    line: line,
                    reason: unknownRefs.length > 0 ? 'unknown_symbols' : 'speculation',
                    details: unknownRefs.length > 0 ? unknownRefs : hallucinationMatches.map(m => m.match)
                });
            }
        }
        
        return {
            filtered: filtered.join('\n'),
            removed: removed,
            wasModified: removed.length > 0
        };
    }

    /**
     * Append a disclaimer if validation shows issues
     * @param {string} response - The response
     * @param {Object} validationResult - Result from validate()
     * @returns {string} Response with disclaimer if needed
     */
    appendDisclaimer(response, validationResult) {
        if (validationResult.isValid && validationResult.confidence > 0.7) {
            return response;
        }
        
        let disclaimer = '\n\n---\n⚠️ **Note**: ';
        
        if (validationResult.unknownReferences.length > 0) {
            disclaimer += `Some referenced items (${validationResult.unknownReferences.slice(0, 3).join(', ')}) were not found in the attached code. `;
        }
        
        if (validationResult.hallucinationScore > 2) {
            disclaimer += 'Parts of this response may be based on general knowledge rather than the attached code. ';
        }
        
        disclaimer += 'Please verify against the source files.';
        
        return response + disclaimer;
    }

    /**
     * Update the code index (call when index changes)
     */
    updateIndex(codeIndex, contextFiles) {
        this.codeIndex = codeIndex;
        this.contextFiles = contextFiles;
        this._buildLookups();
    }
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    ResponseValidator,
    HALLUCINATION_INDICATORS,
    GROUNDING_INDICATORS
};
