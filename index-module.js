/**
 * AstraCode Index Module v5.1
 * 
 * Code indexing, parsing, and symbol extraction for multiple languages.
 * Extracted from extension.js for modularity.
 * 
 * Exports:
 * - CodeIndex: Class to manage code indexes
 * - detectLanguage: Detect language from file path
 * - isBinaryFile: Check if file is binary
 * - parseFile: Parse a file and extract symbols
 * - Language parsers
 */

// ============================================================
// LANGUAGE DETECTION
// ============================================================

/**
 * Detect programming language from file path
 * @param {string} filePath - Path to the file
 * @returns {string} Language identifier
 */
function detectLanguage(filePath) {
    const ext = filePath.split('.').pop().toLowerCase();
    const langMap = {
        // Legacy - COBOL
        'cbl': 'cobol', 'cob': 'cobol', 'cobol': 'cobol', 'cpy': 'cobol', 'pco': 'cobol',
        // Legacy - TAL/TACL
        'tal': 'tal', 'tacl': 'tacl', 'tac': 'tacl',
        // C family
        'c': 'c', 'h': 'c',
        'cpp': 'cpp', 'cc': 'cpp', 'cxx': 'cpp', 'hpp': 'cpp', 'hxx': 'cpp',
        // Java/JVM
        'java': 'java', 'scala': 'scala', 'kt': 'kotlin', 'groovy': 'groovy',
        // C#/.NET
        'cs': 'csharp', 'csx': 'csharp',
        // Python
        'py': 'python', 'pyw': 'python', 'pyx': 'python',
        // JavaScript/TypeScript
        'js': 'javascript', 'jsx': 'javascript', 'mjs': 'javascript', 'cjs': 'javascript',
        'ts': 'typescript', 'tsx': 'typescript', 'mts': 'typescript', 'cts': 'typescript',
        'd.ts': 'typescript',
        // SQL variants
        'sql': 'sql', 'ddl': 'sql', 'dml': 'sql', 'prc': 'sql', 'fnc': 'sql',
        'pks': 'sql', 'pkb': 'sql', 'trg': 'sql', 'vw': 'sql', 'plsql': 'sql',
        'psql': 'sql', 'tsql': 'sql',
        // Web
        'html': 'html', 'htm': 'html', 'css': 'css', 'scss': 'scss', 'sass': 'sass',
        // Data
        'json': 'json', 'xml': 'xml', 'yaml': 'yaml', 'yml': 'yaml',
        'csv': 'csv', 'tsv': 'tsv',
        // Shell/Scripts
        'sh': 'bash', 'bash': 'bash', 'zsh': 'zsh', 'fish': 'fish',
        'ps1': 'powershell', 'bat': 'batch', 'cmd': 'batch',
        // Other languages
        'go': 'go', 'rs': 'rust', 'rb': 'ruby', 'php': 'php',
        'swift': 'swift', 'fs': 'fsharp', 'vb': 'vb',
        'pl': 'perl', 'r': 'r', 'lua': 'lua',
        // Config
        'md': 'markdown', 'txt': 'text', 'log': 'log',
        'ini': 'ini', 'cfg': 'ini', 'conf': 'ini', 'properties': 'properties',
        'toml': 'toml', 'env': 'env',
        // Documents
        'pdf': 'pdf', 'doc': 'document', 'docx': 'document', 'rtf': 'document'
    };
    return langMap[ext] || ext || 'text';
}

/**
 * Get file extension for a target language
 * @param {string} language - Language name
 * @returns {string} File extension
 */
function getFileExtension(language) {
    const extensions = {
        'java': 'java', 'javascript': 'js', 'typescript': 'ts',
        'python': 'py', 'c': 'c', 'cpp': 'cpp', 'c++': 'cpp',
        'csharp': 'cs', 'c#': 'cs', 'go': 'go', 'golang': 'go',
        'rust': 'rs', 'ruby': 'rb', 'php': 'php', 'swift': 'swift',
        'kotlin': 'kt', 'scala': 'scala', 'cobol': 'cbl', 'tal': 'tal',
        'perl': 'pl', 'lua': 'lua', 'r': 'R', 'shell': 'sh', 'bash': 'sh',
        'powershell': 'ps1', 'html': 'html', 'css': 'css', 'sql': 'sql',
        'json': 'json', 'yaml': 'yaml', 'xml': 'xml'
    };
    return extensions[language.toLowerCase()] || language.toLowerCase();
}

/**
 * Check if a file is binary (should be skipped)
 * @param {string} filename - File name
 * @returns {boolean} True if binary
 */
function isBinaryFile(filename) {
    const binaryExts = [
        'exe', 'dll', 'so', 'dylib', 'bin', 'obj', 'o', 'a', 'lib',
        'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'svg',
        'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
        'zip', 'tar', 'gz', 'rar', '7z', 'jar', 'war',
        'mp3', 'mp4', 'wav', 'avi', 'mov', 'mkv',
        'ttf', 'otf', 'woff', 'woff2', 'eot',
        'class', 'pyc', 'pyo'
    ];
    const ext = filename.split('.').pop().toLowerCase();
    return binaryExts.includes(ext);
}

// ============================================================
// LANGUAGE PARSERS
// ============================================================

/**
 * Parse C/C++ style code
 */
function parseCStyle(content, lines) {
    const symbols = [];
    let match;
    
    // Function definitions
    const funcRegex = /^[\s]*(?:static\s+)?(?:inline\s+)?(?:const\s+)?(\w+(?:\s*\*)*)\s+(\w+)\s*\(([^)]*)\)\s*(?:\{|$)/gm;
    while ((match = funcRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({
            name: match[2],
            type: 'function',
            returnType: match[1].trim(),
            params: match[3].trim(),
            line: lineNum,
            signature: `${match[1].trim()} ${match[2]}(${match[3].trim()})`
        });
    }
    
    // Struct/class/enum definitions
    const structRegex = /\b(?:struct|class|union|enum)\s+(\w+)/g;
    while ((match = structRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({ name: match[1], type: 'struct', line: lineNum });
    }
    
    // #define macros
    const defineRegex = /^#define\s+(\w+)(?:\(([^)]*)\))?/gm;
    while ((match = defineRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({
            name: match[1],
            type: match[2] ? 'macro-function' : 'macro',
            params: match[2] || '',
            line: lineNum
        });
    }
    
    // Global variables
    const globalRegex = /^(?:static\s+)?(?:const\s+)?(\w+(?:\s*\*)*)\s+(\w+)\s*(?:=|;)/gm;
    while ((match = globalRegex.exec(content)) !== null) {
        const before = content.substring(0, match.index);
        const braceCount = (before.match(/\{/g) || []).length - (before.match(/\}/g) || []).length;
        if (braceCount === 0) {
            const lineNum = before.split('\n').length;
            symbols.push({
                name: match[2],
                type: 'variable',
                dataType: match[1].trim(),
                line: lineNum,
                scope: 'global'
            });
        }
    }
    
    return symbols;
}

/**
 * Parse Java style code
 */
function parseJavaStyle(content, lines) {
    const symbols = [];
    let match;
    
    // Class definitions
    const classRegex = /\b(?:public\s+)?(?:abstract\s+)?(?:final\s+)?(?:class|interface|enum)\s+(\w+)/g;
    while ((match = classRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({ name: match[1], type: 'class', line: lineNum });
    }
    
    // Method definitions
    const methodRegex = /(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?(\w+(?:<[^>]+>)?)\s+(\w+)\s*\(([^)]*)\)/g;
    while ((match = methodRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        if (!['if', 'for', 'while', 'switch', 'catch'].includes(match[2])) {
            symbols.push({
                name: match[2],
                type: 'method',
                returnType: match[1],
                params: match[3].trim(),
                line: lineNum,
                signature: `${match[1]} ${match[2]}(${match[3].trim()})`
            });
        }
    }
    
    // Fields
    const fieldRegex = /(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?(\w+(?:<[^>]+>)?)\s+(\w+)\s*[=;]/g;
    while ((match = fieldRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({
            name: match[2],
            type: 'field',
            dataType: match[1],
            line: lineNum
        });
    }
    
    return symbols;
}

/**
 * Parse C# code
 */
function parseCSharp(content, lines) {
    const symbols = [];
    let match;
    
    // Class/interface/struct
    const classRegex = /\b(?:public|private|internal|protected)?\s*(?:abstract|sealed|static|partial)?\s*(?:class|interface|struct|enum|record)\s+(\w+)/g;
    while ((match = classRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({ name: match[1], type: 'class', line: lineNum });
    }
    
    // Methods
    const methodRegex = /(?:public|private|internal|protected)?\s*(?:static|virtual|override|async)?\s*(\w+(?:<[^>]+>)?)\s+(\w+)\s*\(([^)]*)\)/g;
    while ((match = methodRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        if (!['if', 'for', 'foreach', 'while', 'switch', 'catch', 'using'].includes(match[2])) {
            symbols.push({
                name: match[2],
                type: 'method',
                returnType: match[1],
                params: match[3].trim(),
                line: lineNum
            });
        }
    }
    
    // Properties
    const propRegex = /(?:public|private|internal|protected)?\s*(?:static|virtual|override)?\s*(\w+(?:<[^>]+>)?)\s+(\w+)\s*\{/g;
    while ((match = propRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({ name: match[2], type: 'property', dataType: match[1], line: lineNum });
    }
    
    return symbols;
}

/**
 * Parse JavaScript/TypeScript style code
 */
function parseJSStyle(content, lines) {
    const symbols = [];
    let match;
    
    // Classes
    const classRegex = /\bclass\s+(\w+)/g;
    while ((match = classRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({ name: match[1], type: 'class', line: lineNum });
    }
    
    // Named functions
    const funcRegex = /\bfunction\s+(\w+)\s*\(/g;
    while ((match = funcRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({ name: match[1], type: 'function', line: lineNum });
    }
    
    // Arrow functions and function expressions
    const arrowRegex = /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:function|\([^)]*\)\s*=>|\w+\s*=>)/g;
    while ((match = arrowRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({ name: match[1], type: 'function', line: lineNum });
    }
    
    // Method shorthand in objects/classes
    const methodRegex = /^\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/gm;
    while ((match = methodRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        if (!['if', 'for', 'while', 'switch', 'catch', 'function'].includes(match[1])) {
            symbols.push({ name: match[1], type: 'method', line: lineNum });
        }
    }
    
    // TypeScript interfaces and types
    const interfaceRegex = /\binterface\s+(\w+)/g;
    while ((match = interfaceRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({ name: match[1], type: 'interface', line: lineNum });
    }
    
    const typeRegex = /\btype\s+(\w+)\s*=/g;
    while ((match = typeRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({ name: match[1], type: 'type', line: lineNum });
    }
    
    return symbols;
}

/**
 * Parse Python code
 */
function parsePython(content, lines) {
    const symbols = [];
    let match;
    
    // Classes
    const classRegex = /^class\s+(\w+)/gm;
    while ((match = classRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({ name: match[1], type: 'class', line: lineNum });
    }
    
    // Functions and methods
    const funcRegex = /^(\s*)def\s+(\w+)\s*\(([^)]*)\)/gm;
    while ((match = funcRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        const indent = match[1].length;
        symbols.push({
            name: match[2],
            type: indent > 0 ? 'method' : 'function',
            params: match[3].trim(),
            line: lineNum
        });
    }
    
    // Module-level variables
    const varRegex = /^(\w+)\s*=/gm;
    while ((match = varRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        if (!match[1].startsWith('_') && match[1] === match[1].toUpperCase()) {
            symbols.push({ name: match[1], type: 'constant', line: lineNum });
        }
    }
    
    return symbols;
}

/**
 * Parse SQL code
 */
function parseSQL(content, lines) {
    const symbols = [];
    let match;
    
    // Tables
    const tableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:\w+\.)?(\w+)/gi;
    while ((match = tableRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({ name: match[1], type: 'table', line: lineNum });
    }
    
    // Views
    const viewRegex = /CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+(?:\w+\.)?(\w+)/gi;
    while ((match = viewRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({ name: match[1], type: 'view', line: lineNum });
    }
    
    // Procedures
    const procRegex = /CREATE\s+(?:OR\s+REPLACE\s+)?PROCEDURE\s+(?:\w+\.)?(\w+)/gi;
    while ((match = procRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({ name: match[1], type: 'procedure', line: lineNum });
    }
    
    // Functions
    const funcRegex = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:\w+\.)?(\w+)/gi;
    while ((match = funcRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({ name: match[1], type: 'function', line: lineNum });
    }
    
    // Triggers
    const triggerRegex = /CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+(?:\w+\.)?(\w+)/gi;
    while ((match = triggerRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({ name: match[1], type: 'trigger', line: lineNum });
    }
    
    return symbols;
}

/**
 * Parse COBOL code
 */
function parseCobol(content, lines) {
    const symbols = [];
    let match;
    
    // Program ID
    const progRegex = /PROGRAM-ID\.\s+(\S+)/gi;
    while ((match = progRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({ name: match[1].replace('.', ''), type: 'program', line: lineNum });
    }
    
    // Sections
    const sectionRegex = /^\s{7}(\w[\w-]+)\s+SECTION\./gim;
    while ((match = sectionRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({ name: match[1], type: 'section', line: lineNum });
    }
    
    // Paragraphs (simplified - lines starting in area A with a name followed by period)
    const paraRegex = /^\s{7}(\w[\w-]+)\.\s*$/gm;
    while ((match = paraRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        const name = match[1];
        // Skip known non-paragraph lines
        if (!name.match(/^(WORKING-STORAGE|FILE|DATA|PROCEDURE|ENVIRONMENT|IDENTIFICATION|CONFIGURATION)/i)) {
            symbols.push({ name: name, type: 'paragraph', line: lineNum });
        }
    }
    
    // Data items (level numbers 01-49, 77)
    const dataRegex = /^\s{7}(0[1-9]|[1-4][0-9]|77)\s+(\w[\w-]+)/gm;
    while ((match = dataRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        const level = parseInt(match[1]);
        symbols.push({
            name: match[2],
            type: level === 1 || level === 77 ? 'record' : 'field',
            level: level,
            line: lineNum
        });
    }
    
    return symbols;
}

/**
 * Parse TAL code
 */
function parseTal(content, lines) {
    const symbols = [];
    let match;
    
    // Procedures
    const procRegex = /^(?:INT|STRING)?\s*PROC\s+(\w+)/gim;
    while ((match = procRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({ name: match[1], type: 'procedure', line: lineNum });
    }
    
    // Subprocedures
    const subprocRegex = /^(?:INT|STRING)?\s*SUBPROC\s+(\w+)/gim;
    while ((match = subprocRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({ name: match[1], type: 'subproc', line: lineNum });
    }
    
    // Defines
    const defineRegex = /^DEFINE\s+(\w+)/gim;
    while ((match = defineRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({ name: match[1], type: 'define', line: lineNum });
    }
    
    // Literals
    const literalRegex = /^LITERAL\s+(\w+)/gim;
    while ((match = literalRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({ name: match[1], type: 'literal', line: lineNum });
    }
    
    // Structs
    const structRegex = /^STRUCT\s+(\w+)/gim;
    while ((match = structRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({ name: match[1], type: 'struct', line: lineNum });
    }
    
    // Global variables
    const varRegex = /^(INT|STRING|FIXED|REAL)\s+(?:\.\s*)?(\w+)/gim;
    while ((match = varRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({
            name: match[2],
            type: 'variable',
            dataType: match[1].toUpperCase(),
            line: lineNum
        });
    }
    
    return symbols;
}

/**
 * Parse Go code
 */
function parseGo(content, lines) {
    const symbols = [];
    let match;
    
    // Package
    const pkgRegex = /^package\s+(\w+)/m;
    match = pkgRegex.exec(content);
    if (match) {
        symbols.push({ name: match[1], type: 'package', line: 1 });
    }
    
    // Functions
    const funcRegex = /^func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(/gm;
    while ((match = funcRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({ name: match[1], type: 'function', line: lineNum });
    }
    
    // Types (struct, interface)
    const typeRegex = /^type\s+(\w+)\s+(?:struct|interface)/gm;
    while ((match = typeRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({ name: match[1], type: 'type', line: lineNum });
    }
    
    // Constants
    const constRegex = /^const\s+(\w+)/gm;
    while ((match = constRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({ name: match[1], type: 'constant', line: lineNum });
    }
    
    // Variables
    const varRegex = /^var\s+(\w+)/gm;
    while ((match = varRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({ name: match[1], type: 'variable', line: lineNum });
    }
    
    return symbols;
}

/**
 * Parse Rust code
 */
function parseRust(content, lines) {
    const symbols = [];
    let match;
    
    // Functions
    const funcRegex = /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/gm;
    while ((match = funcRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({ name: match[1], type: 'function', line: lineNum });
    }
    
    // Structs
    const structRegex = /^(?:pub\s+)?struct\s+(\w+)/gm;
    while ((match = structRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({ name: match[1], type: 'struct', line: lineNum });
    }
    
    // Enums
    const enumRegex = /^(?:pub\s+)?enum\s+(\w+)/gm;
    while ((match = enumRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({ name: match[1], type: 'enum', line: lineNum });
    }
    
    // Traits
    const traitRegex = /^(?:pub\s+)?trait\s+(\w+)/gm;
    while ((match = traitRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({ name: match[1], type: 'trait', line: lineNum });
    }
    
    // Impl blocks
    const implRegex = /^impl(?:<[^>]+>)?\s+(?:(\w+)\s+for\s+)?(\w+)/gm;
    while ((match = implRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        const name = match[1] ? `${match[1]} for ${match[2]}` : match[2];
        symbols.push({ name: name, type: 'impl', line: lineNum });
    }
    
    // Modules
    const modRegex = /^(?:pub\s+)?mod\s+(\w+)/gm;
    while ((match = modRegex.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        symbols.push({ name: match[1], type: 'module', line: lineNum });
    }
    
    return symbols;
}

/**
 * Generic parser for unknown languages
 */
function parseGeneric(content, lines) {
    const symbols = [];
    let match;
    
    // Generic function patterns
    const funcPatterns = [
        /\bfunction\s+(\w+)/gi,
        /\bdef\s+(\w+)/gi,
        /\bsub\s+(\w+)/gi,
        /\bprocedure\s+(\w+)/gi,
        /\bproc\s+(\w+)/gi
    ];
    
    for (const pattern of funcPatterns) {
        while ((match = pattern.exec(content)) !== null) {
            const lineNum = content.substring(0, match.index).split('\n').length;
            if (!symbols.some(s => s.name === match[1] && s.line === lineNum)) {
                symbols.push({ name: match[1], type: 'function', line: lineNum });
            }
        }
    }
    
    // Generic class patterns
    const classPatterns = [
        /\bclass\s+(\w+)/gi,
        /\bstruct\s+(\w+)/gi,
        /\binterface\s+(\w+)/gi
    ];
    
    for (const pattern of classPatterns) {
        while ((match = pattern.exec(content)) !== null) {
            const lineNum = content.substring(0, match.index).split('\n').length;
            if (!symbols.some(s => s.name === match[1] && s.line === lineNum)) {
                symbols.push({ name: match[1], type: 'class', line: lineNum });
            }
        }
    }
    
    return symbols;
}

// ============================================================
// MAIN PARSE FUNCTION
// ============================================================

/**
 * Generate a summary from function name
 */
function generateSummaryFromName(name) {
    // Convert camelCase or snake_case to words
    return name
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/_/g, ' ')
        .toLowerCase()
        .replace(/^\w/, c => c.toUpperCase());
}

/**
 * Generate a simple function summary from code
 */
function generateFunctionSummary(content, lineNum, language) {
    const lines = content.split('\n');
    if (lineNum < 1 || lineNum > lines.length) return null;
    
    // Look for comment above function
    let summary = null;
    for (let i = lineNum - 2; i >= Math.max(0, lineNum - 5); i--) {
        const line = lines[i].trim();
        if (line.startsWith('//') || line.startsWith('#') || line.startsWith('*') || line.startsWith('--')) {
            summary = line.replace(/^[\/\*#-]+\s*/, '').trim();
            if (summary.length > 10) break;
        } else if (line.length > 0 && !line.startsWith('/*') && !line.startsWith('"""')) {
            break;
        }
    }
    
    return summary;
}

/**
 * Parse a file and extract symbols
 * @param {string} filePath - Path to the file
 * @param {string} content - File content
 * @param {string} language - Programming language
 * @returns {Object} Parsed file info with symbols
 */
function parseFile(filePath, content, language) {
    const lines = content.split('\n');
    
    const parsers = {
        'c': parseCStyle, 'cpp': parseCStyle, 'h': parseCStyle,
        'java': parseJavaStyle, 'kotlin': parseJavaStyle, 'scala': parseJavaStyle,
        'csharp': parseCSharp,
        'javascript': parseJSStyle, 'typescript': parseJSStyle,
        'python': parsePython,
        'sql': parseSQL,
        'cobol': parseCobol,
        'tal': parseTal,
        'go': parseGo,
        'rust': parseRust,
        'default': parseGeneric
    };
    
    const parser = parsers[language] || parsers['default'];
    const fileSymbols = parser(content, lines);
    
    // Add summaries to callable symbols
    const callableTypes = new Set([
        'function', 'procedure', 'method', 'subproc', 'constructor',
        'section', 'paragraph', 'program', 'macro'
    ]);
    
    for (const symbol of fileSymbols) {
        if (callableTypes.has(symbol.type) && symbol.line) {
            const summary = generateFunctionSummary(content, symbol.line, language);
            symbol.summary = summary || generateSummaryFromName(symbol.name);
        }
    }
    
    return {
        path: filePath,
        language,
        symbols: fileSymbols,
        lineCount: lines.length
    };
}

// ============================================================
// CODE INDEX CLASS
// ============================================================

/**
 * CodeIndex - Manages code indexing and symbol tracking
 */
class CodeIndex {
    constructor() {
        this.files = new Map();           // file path -> file info with symbols
        this.symbols = new Map();         // symbol name -> definition info
        this.variables = new Map();       // variable name@file -> variable info
        this.callGraph = new Map();       // function -> functions it calls
        this.reverseCallGraph = new Map(); // function -> functions that call it
        this.dependencies = new Map();    // file -> files it depends on
        this.summaries = new Map();       // function@file -> LLM-generated summary
        this.fileSummaries = new Map();   // file path -> LLM-generated file summary
        this.overallSummary = null;       // High-level summary of entire codebase
        this.discoveredDomain = null;     // Domain info discovered from code
        this.lastUpdated = null;
    }
    
    /**
     * Clear all indexes
     */
    clear() {
        this.files.clear();
        this.symbols.clear();
        this.variables.clear();
        this.callGraph.clear();
        this.reverseCallGraph.clear();
        this.dependencies.clear();
        this.summaries.clear();
        this.fileSummaries.clear();
        this.overallSummary = null;
        this.discoveredDomain = null;
        this.lastUpdated = null;
    }
    
    /**
     * Add a parsed file to the index
     */
    addFile(parsedFile) {
        this.files.set(parsedFile.path, parsedFile);
        
        for (const symbol of parsedFile.symbols) {
            // Add to symbols map with file-qualified key
            const key = `${symbol.name}@${parsedFile.path}`;
            this.symbols.set(key, {
                ...symbol,
                file: parsedFile.path
            });
            
            // Also add without file qualification for lookup by name
            if (!this.symbols.has(symbol.name)) {
                this.symbols.set(symbol.name, {
                    ...symbol,
                    file: parsedFile.path
                });
            }
        }
        
        this.lastUpdated = new Date();
    }
    
    /**
     * Remove a file from the index
     */
    removeFile(filePath) {
        const file = this.files.get(filePath);
        if (!file) return;
        
        // Remove symbols
        for (const symbol of file.symbols) {
            this.symbols.delete(`${symbol.name}@${filePath}`);
        }
        
        this.files.delete(filePath);
        this.fileSummaries.delete(filePath);
        this.lastUpdated = new Date();
    }
    
    /**
     * Get statistics about the index
     */
    getStats() {
        const types = {};
        for (const [, symbol] of this.symbols) {
            types[symbol.type] = (types[symbol.type] || 0) + 1;
        }
        
        return {
            files: this.files.size,
            symbols: this.symbols.size,
            variables: this.variables.size,
            callGraphEdges: Array.from(this.callGraph.values()).reduce((sum, s) => sum + s.size, 0),
            types,
            lastUpdated: this.lastUpdated
        };
    }
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    CodeIndex,
    detectLanguage,
    getFileExtension,
    isBinaryFile,
    parseFile,
    generateSummaryFromName,
    generateFunctionSummary,
    // Individual parsers (for testing/extension)
    parsers: {
        parseCStyle,
        parseJavaStyle,
        parseCSharp,
        parseJSStyle,
        parsePython,
        parseSQL,
        parseCobol,
        parseTal,
        parseGo,
        parseRust,
        parseGeneric
    }
};
