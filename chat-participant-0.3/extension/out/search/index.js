/**
 * Search module - exports all search functionality
 */

const { GrepIndex } = require('./grep-index');
const { analyzeQuery, executeSearch } = require('./query-analyzer');
const {
    dedupeResults,
    dedupeAndLimit,
    groupByFile,
    formatSnippet,
    formatResultsForLLM,
    formatFileReferences,
    extractKeywords,
    searchWorkspace,
    generateSearchVariations,
    dedupeAndRank,
    formatSourceList
} = require('./search-utils');

module.exports = {
    GrepIndex,
    analyzeQuery,
    executeSearch,
    dedupeResults,
    dedupeAndLimit,
    groupByFile,
    formatSnippet,
    formatResultsForLLM,
    formatFileReferences,
    extractKeywords,
    searchWorkspace,
    generateSearchVariations,
    dedupeAndRank,
    formatSourceList
};
