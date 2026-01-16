/**
 * Path Utilities for AstraCode
 */
const path = require('path');

function normalizePath(filePath) {
    return filePath ? filePath.replace(/\\/g, '/') : '';
}

function getFileName(filePath) {
    if (!filePath) return '';
    const parts = normalizePath(filePath).split('/');
    return parts[parts.length - 1] || '';
}

function getBaseName(filePath) {
    const fileName = getFileName(filePath);
    const dotIndex = fileName.lastIndexOf('.');
    return dotIndex > 0 ? fileName.substring(0, dotIndex) : fileName;
}

function getExtension(filePath) {
    const fileName = getFileName(filePath);
    const dotIndex = fileName.lastIndexOf('.');
    return dotIndex > 0 ? fileName.substring(dotIndex) : '';
}

function getParentDir(filePath) {
    if (!filePath) return '';
    const parts = normalizePath(filePath).split('/');
    parts.pop();
    return parts.join('/');
}

function getParentDirName(filePath) {
    if (!filePath) return '';
    const parentDir = getParentDir(filePath);
    return getFileName(parentDir);
}

function splitPath(filePath) {
    if (!filePath) return [];
    return normalizePath(filePath).split('/').filter(p => p.length > 0);
}

function getDirName(filePath) {
    return getFileName(getParentDir(filePath));
}

function joinPath(...segments) {
    return normalizePath(path.join(...segments));
}

function isAbsolute(filePath) {
    return path.isAbsolute(filePath);
}

function getRelativePath(from, to) {
    return normalizePath(path.relative(from, to));
}

function isInsideDirectory(filePath, dirPath) {
    const nFile = normalizePath(filePath);
    const nDir = normalizePath(dirPath);
    return nFile.startsWith(nDir + '/') || nFile === nDir;
}

module.exports = {
    normalizePath, getFileName, getBaseName, getExtension,
    getParentDir, getParentDirName, splitPath, getDirName, 
    joinPath, isAbsolute, getRelativePath, isInsideDirectory
};
