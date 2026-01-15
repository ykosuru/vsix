/**
 * AstraCode Path Utilities
 * 
 * Cross-platform path handling for Windows/Mac/Linux compatibility.
 * VS Code internally uses forward slashes, but Windows file system uses backslashes.
 * This module ensures consistent path handling across all platforms.
 * 
 * Usage:
 *   const pathUtils = require('./pathUtils');
 *   const fileName = pathUtils.getFileName(filePath);
 *   const normalized = pathUtils.normalizePath(filePath);
 */

const path = require('path');
const os = require('os');

/**
 * Check if running on Windows
 */
const isWindows = os.platform() === 'win32';

/**
 * Normalize path separators to forward slashes (VS Code standard)
 * This ensures consistent behavior when splitting/joining paths
 * 
 * @param {string} filePath - Path to normalize
 * @returns {string} - Path with forward slashes
 */
function normalizePath(filePath) {
    if (!filePath) return filePath;
    if (typeof filePath !== 'string') return filePath;
    
    // Convert backslashes to forward slashes
    // This is safe on all platforms - forward slashes work everywhere
    return filePath.replace(/\\/g, '/');
}

/**
 * Get the file name from a path (cross-platform)
 * Equivalent to path.split('/').pop() but works on Windows
 * 
 * @param {string} filePath - Full file path
 * @returns {string} - Just the file name
 */
function getFileName(filePath) {
    if (!filePath) return 'unknown';
    if (typeof filePath !== 'string') return 'unknown';
    
    // path.basename handles both separators correctly
    return path.basename(filePath);
}

/**
 * Get the parent directory name from a path
 * Equivalent to path.split('/').slice(-2, -1)[0]
 * 
 * @param {string} filePath - Full file path
 * @returns {string} - Parent directory name
 */
function getParentDirName(filePath) {
    if (!filePath) return '';
    if (typeof filePath !== 'string') return '';
    
    const dirPath = path.dirname(filePath);
    return path.basename(dirPath) || '';
}

/**
 * Get the full parent directory path
 * 
 * @param {string} filePath - Full file path  
 * @returns {string} - Parent directory path
 */
function getParentDir(filePath) {
    if (!filePath) return '';
    if (typeof filePath !== 'string') return '';
    
    return path.dirname(filePath);
}

/**
 * Join path segments (cross-platform)
 * Uses path.join which handles separators correctly per platform
 * 
 * @param {...string} parts - Path segments to join
 * @returns {string} - Joined path
 */
function joinPath(...parts) {
    return path.join(...parts);
}

/**
 * Split path into segments (cross-platform)
 * Works correctly whether path uses / or \ separators
 * 
 * @param {string} filePath - Path to split
 * @returns {string[]} - Array of path segments
 */
function splitPath(filePath) {
    if (!filePath) return [];
    if (typeof filePath !== 'string') return [];
    
    // Normalize first, then split
    const normalized = normalizePath(filePath);
    return normalized.split('/').filter(Boolean);
}

/**
 * Get path segments from the end
 * Equivalent to path.split('/').slice(-n)
 * 
 * @param {string} filePath - Full file path
 * @param {number} count - Number of segments from end
 * @returns {string[]} - Last n path segments
 */
function getPathTail(filePath, count) {
    const parts = splitPath(filePath);
    return parts.slice(-count);
}

/**
 * Get path segments from the start
 * Equivalent to path.split('/').slice(0, n)
 * 
 * @param {string} filePath - Full file path
 * @param {number} count - Number of segments from start
 * @returns {string[]} - First n path segments
 */
function getPathHead(filePath, count) {
    const parts = splitPath(filePath);
    return parts.slice(0, count);
}

/**
 * Get a specific path segment by index from the end
 * Equivalent to path.split('/').slice(-n, -m)[0]
 * 
 * @param {string} filePath - Full file path
 * @param {number} fromEnd - Index from end (1 = last, 2 = second to last)
 * @returns {string} - The path segment
 */
function getSegmentFromEnd(filePath, fromEnd) {
    const parts = splitPath(filePath);
    if (fromEnd > parts.length) return '';
    return parts[parts.length - fromEnd] || '';
}

/**
 * Check if path ends with a specific file name
 * 
 * @param {string} filePath - Full file path
 * @param {string} fileName - File name to check
 * @returns {boolean}
 */
function pathEndsWith(filePath, fileName) {
    if (!filePath || !fileName) return false;
    return getFileName(filePath).toLowerCase() === fileName.toLowerCase();
}

/**
 * Get relative path from base to target
 * 
 * @param {string} basePath - Base directory path
 * @param {string} targetPath - Target file path
 * @returns {string} - Relative path
 */
function getRelativePath(basePath, targetPath) {
    if (!basePath || !targetPath) return targetPath || '';
    return path.relative(basePath, targetPath);
}

/**
 * Get temp directory with proper path joining
 * 
 * @param {string} subDir - Optional subdirectory name
 * @returns {string} - Temp directory path
 */
function getTempDir(subDir) {
    const tmpDir = os.tmpdir();
    if (subDir) {
        return path.join(tmpDir, subDir);
    }
    return tmpDir;
}

/**
 * Create a temp file path
 * 
 * @param {string} fileName - File name
 * @param {string} subDir - Optional subdirectory
 * @returns {string} - Full temp file path
 */
function getTempFilePath(fileName, subDir) {
    if (subDir) {
        return path.join(os.tmpdir(), subDir, fileName);
    }
    return path.join(os.tmpdir(), fileName);
}

/**
 * Get file extension (with dot)
 * 
 * @param {string} filePath - File path
 * @returns {string} - Extension like ".js" or ""
 */
function getExtension(filePath) {
    if (!filePath) return '';
    return path.extname(filePath);
}

/**
 * Get file name without extension
 * 
 * @param {string} filePath - File path
 * @returns {string} - File name without extension
 */
function getBaseName(filePath) {
    if (!filePath) return '';
    const fileName = getFileName(filePath);
    const ext = getExtension(fileName);
    return ext ? fileName.slice(0, -ext.length) : fileName;
}

/**
 * Normalize a path for display (use forward slashes for consistency)
 * 
 * @param {string} filePath - Path to normalize for display
 * @returns {string} - Display-friendly path
 */
function toDisplayPath(filePath) {
    return normalizePath(filePath);
}

/**
 * Convert to native path (use platform separators)
 * Use this when passing to native OS functions
 * 
 * @param {string} filePath - Path to convert
 * @returns {string} - Native path
 */
function toNativePath(filePath) {
    if (!filePath) return filePath;
    if (typeof filePath !== 'string') return filePath;
    
    // path.normalize uses the correct separator for the platform
    return path.normalize(filePath);
}

module.exports = {
    // Platform detection
    isWindows,
    
    // Core path operations
    normalizePath,
    getFileName,
    getParentDirName,
    getParentDir,
    joinPath,
    splitPath,
    
    // Path segment access
    getPathTail,
    getPathHead,
    getSegmentFromEnd,
    
    // Path utilities
    pathEndsWith,
    getRelativePath,
    getExtension,
    getBaseName,
    
    // Temp directory helpers
    getTempDir,
    getTempFilePath,
    
    // Display/native conversion
    toDisplayPath,
    toNativePath
};
