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
const gencode = require('./gencode');
const clear = require('./clear');
const confluence = require('./confluence');
const history = require('./history');

const commands = {
    help: help.handle,
    find: find.handle,
    describe: describe.handle,
    translate: translate.handle,
    fediso: fediso.handle,
    iso: fediso.handle,                    // alias
    requirements: requirements.handle,
    reqs: requirements.handle,              // alias
    gencode: gencode.handle,
    code: gencode.handle,                   // alias
    deepwiki: deepwiki.handle,
    wiki: deepwiki.handle,                  // alias
    clear: clear.handle,
    reset: clear.handle,                    // alias
    history: history.handle,
    hist: history.handle,                   // alias
    'conf.r': confluence.handleRead,        // read from Confluence
    'conf.w': confluence.handleWrite,       // write to Confluence
    general: general.handle
};

const PIPELINE_COMMANDS = [
    'find', 'describe', 'translate', 'fediso', 'iso',
    'requirements', 'reqs', 'gencode', 'code',
    'deepwiki', 'wiki', 'conf.r', 'conf.w', 'history', 'hist'
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
