/**
 * Commands registry
 */

const help = require('./help');
const find = require('./find');
const describe = require('./describe');
const translate = require('./translate');
const fediso = require('./fediso');
const requirements = require('./requirements');
const general = require('./general');
const deepwiki = require('./deepwiki');

const commands = {
    help: help.handle,
    find: find.handle,
    describe: describe.handle,
    translate: translate.handle,
    fediso: fediso.handle,
    requirements: requirements.handle,
    extract: requirements.handle,
    deepwiki: deepwiki.handle,
    wiki: deepwiki.handle,
    general: general.handle
};

// Commands that benefit from workspace context
const PIPELINE_COMMANDS = [
    'find', 'describe', 'translate', 'fediso', 
    'requirements', 'extract', 'deepwiki', 'wiki'
];

function getHandler(command) {
    return commands[command] || commands.general;
}

function hasCommand(command) {
    return command in commands;
}

function listCommands() {
    return Object.keys(commands).filter(c => c !== 'general');
}

module.exports = {
    commands,
    getHandler,
    hasCommand,
    listCommands,
    PIPELINE_COMMANDS
};
