/**
 * Prompts module - exports all prompt templates
 */

const describe = require('./describe');
const translate = require('./translate');
const fediso = require('./fediso');
const requirements = require('./requirements');
const general = require('./general');
const deepwiki = require('./deepwiki');

module.exports = {
    describe,
    translate,
    fediso,
    requirements,
    general,
    deepwiki
};
