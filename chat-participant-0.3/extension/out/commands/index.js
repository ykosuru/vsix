/**
 * Commands registry - central routing for all commands
 */

const help = require('./help');
const find = require('./find');
const describe = require('./describe');
const translate = require('./translate');
const fediso = require('./fediso');
const requirements = require('./requirements');
const general = require('./general');
const deepwiki = require('./deepwiki');

// Command registry
const commands = {
    help: help.handle,
    find: find.handle,
    describe: describe.handle,
    translate: translate.handle,
    fediso: fediso.handle,
    requirements: requirements.handle,
    extract: requirements.handle,  // Alias
    deepwiki: deepwiki.handle,
    wiki: deepwiki.handle,  // Alias
    general: general.handle
};

/**
 * Get handler for a command
 * @param {string} command - Command name or null for general
 * @returns {Function} Command handler
 */
function getHandler(command) {
    return commands[command] || commands.general;
}

/**
 * Check if command exists
 * @param {string} command - Command name
 * @returns {boolean}
 */
function hasCommand(command) {
    return command in commands;
}

/**
 * Get all available commands
 * @returns {string[]}
 */
function listCommands() {
    return Object.keys(commands).filter(c => c !== 'general');
}

module.exports = {
    commands,
    getHandler,
    hasCommand,
    listCommands
};
