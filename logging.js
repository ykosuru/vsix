/**
 * AstraCode Logging Utilities
 * Centralized logging and progress reporting
 */

const vscode = require('vscode');

// Module state
let _outputChannel = null;
let _chatWebviewView = null;
let _summaryStatusBarItem = null;

/**
 * Initialize the logging module
 */
function initialize(outputChannel) {
    _outputChannel = outputChannel;
}

/**
 * Set the chat webview view for UI updates
 */
function setWebviewView(webviewView) {
    _chatWebviewView = webviewView;
}

/**
 * Set the status bar item for summary progress
 */
function setStatusBarItem(statusBarItem) {
    _summaryStatusBarItem = statusBarItem;
}

/**
 * Main logging function
 */
function log(...args) {
    const timestamp = new Date().toISOString().substring(11, 23);
    const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
    _outputChannel?.appendLine(`[${timestamp}] ${message}`);
    console.log(`[AstraCode] ${message}`);
}

/**
 * Debug log that shows in chat panel when debug mode is enabled
 * Use this for user-visible debug information
 */
function debugLog(category, message, data = null) {
    const config = vscode.workspace.getConfiguration('astra');
    const debugMode = config.get('debugMode', false);
    
    // Always log to output channel
    log(`[${category}]`, message, data || '');
    
    // If debug mode is on, also show in chat
    if (debugMode && _chatWebviewView) {
        let debugText = `\nðŸ”§ **[${category}]** ${message}`;
        if (data !== null) {
            if (typeof data === 'object') {
                debugText += `\n\`\`\`json\n${JSON.stringify(data, null, 2).substring(0, 500)}\n\`\`\``;
            } else {
                debugText += `: \`${data}\``;
            }
        }
        debugText += '\n';
        
        _chatWebviewView.webview.postMessage({ 
            type: 'appendResponse', 
            text: debugText 
        });
    }
}

/**
 * Show progress message in chat UI (user-visible)
 * Used to show what the agent is doing during search/planning
 */
function showProgress(message, type = 'info') {
    const icons = {
        'search': 'ðŸ”',
        'index': 'ðŸ“Š',
        'grep': 'ðŸ“',
        'found': 'âœ…',
        'step': 'â–¶ï¸',
        'info': 'â„¹ï¸',
        'warn': 'âš ï¸'
    };
    const icon = icons[type] || icons.info;
    const formatted = `\n${icon} *${message}*\n`;
    
    _chatWebviewView?.webview.postMessage({ 
        type: 'appendResponse', 
        text: formatted 
    });
    log(`PROGRESS: ${message}`);
}

/**
 * Update summary progress in both webview and status bar
 * @param {number} progress - 0-100, or -1 to hide
 * @param {string} message - Status message
 * @param {number} [count] - Final count (on completion)
 */
function updateSummaryStatus(progress, message, count) {
    // Update webview progress indicator
    _chatWebviewView?.webview.postMessage({ 
        type: 'summaryProgress',
        progress: progress,
        message: message,
        count: count
    });
    
    // Update VS Code status bar item
    if (_summaryStatusBarItem) {
        if (progress >= 0 && progress < 100) {
            _summaryStatusBarItem.text = `$(sync~spin) ${message}`;
            _summaryStatusBarItem.tooltip = `AstraCode: Generating function summaries (${progress}%)`;
            _summaryStatusBarItem.show();
        } else if (progress >= 100) {
            _summaryStatusBarItem.text = `$(check) ${count || 0} summaries`;
            _summaryStatusBarItem.tooltip = `AstraCode: ${count || 0} function summaries generated`;
            // Hide after 5 seconds
            setTimeout(() => {
                if (_summaryStatusBarItem) {
                    _summaryStatusBarItem.hide();
                }
            }, 5000);
        } else {
            _summaryStatusBarItem.hide();
        }
    }
    
    log(`SUMMARY: ${message} (${progress}%)`);
}

/**
 * Post a message to the webview
 */
function postMessage(message) {
    _chatWebviewView?.webview.postMessage(message);
}

/**
 * Append text response to the chat
 */
function appendResponse(text) {
    _chatWebviewView?.webview.postMessage({ 
        type: 'appendResponse', 
        text 
    });
}

/**
 * Finalize the response (indicate completion)
 */
function finalizeResponse() {
    _chatWebviewView?.webview.postMessage({ type: 'finalizeResponse' });
}

/**
 * Set processing state in the UI
 */
function setProcessing(processing) {
    _chatWebviewView?.webview.postMessage({ type: 'setProcessing', processing });
}

module.exports = {
    initialize,
    setWebviewView,
    setStatusBarItem,
    log,
    debugLog,
    showProgress,
    updateSummaryStatus,
    postMessage,
    appendResponse,
    finalizeResponse,
    setProcessing
};
