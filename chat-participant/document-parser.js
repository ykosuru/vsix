/**
 * AstraCode Document Parser
 * 
 * Extracts text from binary document formats:
 * - PDF (.pdf)
 * - Excel (.xlsx, .xls)
 * - Word (.docx)
 * 
 * Dependencies (add to package.json):
 *   "pdf-parse": "^1.1.1",
 *   "xlsx": "^0.18.5",
 *   "mammoth": "^1.6.0"
 */

let pdfParse, xlsx, mammoth;

// Lazy-load dependencies to avoid startup errors if not installed
function loadDependencies() {
    if (!pdfParse) {
        try { pdfParse = require('pdf-parse'); } catch (e) { pdfParse = null; }
    }
    if (!xlsx) {
        try { xlsx = require('xlsx'); } catch (e) { xlsx = null; }
    }
    if (!mammoth) {
        try { mammoth = require('mammoth'); } catch (e) { mammoth = null; }
    }
}

/**
 * Check which document parsers are available
 */
function getAvailableParsers() {
    loadDependencies();
    return {
        pdf: !!pdfParse,
        excel: !!xlsx,
        word: !!mammoth
    };
}

/**
 * Parse a PDF file and extract text
 * @param {Buffer} buffer - PDF file contents
 * @param {string} filePath - Path for error reporting
 * @returns {Promise<{text: string, metadata: object}>}
 */
async function parsePDF(buffer, filePath) {
    loadDependencies();
    if (!pdfParse) {
        throw new Error('pdf-parse not installed. Run: npm install pdf-parse');
    }
    
    try {
        const data = await pdfParse(buffer);
        return {
            text: data.text,
            metadata: {
                pages: data.numpages,
                info: data.info,
                format: 'pdf'
            }
        };
    } catch (e) {
        throw new Error(`Failed to parse PDF ${filePath}: ${e.message}`);
    }
}

/**
 * Parse an Excel file and extract text
 * @param {Buffer} buffer - Excel file contents
 * @param {string} filePath - Path for error reporting
 * @returns {Promise<{text: string, metadata: object}>}
 */
async function parseExcel(buffer, filePath) {
    loadDependencies();
    if (!xlsx) {
        throw new Error('xlsx not installed. Run: npm install xlsx');
    }
    
    try {
        const workbook = xlsx.read(buffer, { type: 'buffer' });
        const sheets = [];
        let fullText = '';
        
        for (const sheetName of workbook.SheetNames) {
            const sheet = workbook.Sheets[sheetName];
            const sheetText = xlsx.utils.sheet_to_txt(sheet);
            sheets.push({ name: sheetName, rows: sheetText.split('\n').length });
            fullText += `\n=== Sheet: ${sheetName} ===\n${sheetText}\n`;
        }
        
        return {
            text: fullText.trim(),
            metadata: {
                sheets: sheets,
                sheetCount: workbook.SheetNames.length,
                format: 'excel'
            }
        };
    } catch (e) {
        throw new Error(`Failed to parse Excel ${filePath}: ${e.message}`);
    }
}

/**
 * Parse a Word document and extract text
 * @param {Buffer} buffer - Word file contents
 * @param {string} filePath - Path for error reporting
 * @returns {Promise<{text: string, metadata: object}>}
 */
async function parseWord(buffer, filePath) {
    loadDependencies();
    if (!mammoth) {
        throw new Error('mammoth not installed. Run: npm install mammoth');
    }
    
    try {
        const result = await mammoth.extractRawText({ buffer: buffer });
        return {
            text: result.value,
            metadata: {
                messages: result.messages,
                format: 'word'
            }
        };
    } catch (e) {
        throw new Error(`Failed to parse Word ${filePath}: ${e.message}`);
    }
}

/**
 * Parse a document based on file extension
 * @param {Buffer} buffer - File contents
 * @param {string} filePath - File path (used to determine type)
 * @returns {Promise<{text: string, metadata: object}|null>}
 */
async function parseDocument(buffer, filePath) {
    const ext = filePath.toLowerCase().split('.').pop();
    
    switch (ext) {
        case 'pdf':
            return await parsePDF(buffer, filePath);
        
        case 'xlsx':
        case 'xls':
            return await parseExcel(buffer, filePath);
        
        case 'docx':
            return await parseWord(buffer, filePath);
        
        default:
            return null;
    }
}

/**
 * Get supported document extensions
 */
function getSupportedDocumentExtensions() {
    return ['pdf', 'xlsx', 'xls', 'docx'];
}

/**
 * Check if a file is a supported document type
 */
function isSupportedDocument(filePath) {
    const ext = filePath.toLowerCase().split('.').pop();
    return getSupportedDocumentExtensions().includes(ext);
}

/**
 * Format parsed document for indexing
 * Adds metadata header to help with search context
 */
function formatDocumentForIndex(parsed, filePath) {
    const filename = filePath.split(/[/\\]/).pop();
    let header = `[Document: ${filename}]\n`;
    header += `[Format: ${parsed.metadata.format}]\n`;
    
    if (parsed.metadata.pages) {
        header += `[Pages: ${parsed.metadata.pages}]\n`;
    }
    if (parsed.metadata.sheetCount) {
        header += `[Sheets: ${parsed.metadata.sheetCount}]\n`;
    }
    
    header += '\n';
    
    return header + parsed.text;
}

module.exports = {
    getAvailableParsers,
    parsePDF,
    parseExcel,
    parseWord,
    parseDocument,
    getSupportedDocumentExtensions,
    isSupportedDocument,
    formatDocumentForIndex
};
