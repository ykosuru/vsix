/**
 * AstraCode Webview HTML Content
 * Full chat interface HTML/CSS/JS - extracted from original extension.js
 */

function getWebviewContent() {
        return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }
        
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: var(--vscode-sideBar-background);
            display: flex;
            flex-direction: column;
            height: 100vh;
            padding: 8px;
        }
        
        /* Indexing Banner */
        .indexing-banner {
            background: var(--vscode-inputValidation-infoBackground, #063b49);
            border: 1px solid var(--vscode-inputValidation-infoBorder, #007acc);
            border-radius: 4px;
            padding: 10px 12px;
            margin-bottom: 8px;
            display: none;
        }
        .indexing-banner.show {
            display: block;
        }
        .indexing-banner .banner-title {
            font-weight: bold;
            margin-bottom: 6px;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .indexing-banner .banner-title .spinner {
            display: inline-block;
            width: 14px;
            height: 14px;
            border: 2px solid var(--vscode-foreground);
            border-top-color: transparent;
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        .indexing-banner .banner-phase {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 4px;
        }
        .indexing-banner .banner-stats {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }
        .indexing-banner .banner-progress {
            height: 4px;
            background: var(--vscode-progressBar-background, #0e639c);
            border-radius: 2px;
            margin-top: 8px;
            width: 0%;
            transition: width 0.3s ease;
        }
        .indexing-banner.complete {
            background: var(--vscode-inputValidation-infoBackground, #063b49);
            border-color: #4ec9b0;
        }
        .indexing-banner.complete .banner-title {
            color: #4ec9b0;
        }
        
        /* Disabled input state */
        .input-container.disabled textarea {
            opacity: 0.5;
            cursor: not-allowed;
            background: var(--vscode-input-background);
        }
        .input-container.disabled button {
            opacity: 0.5;
            cursor: not-allowed;
            pointer-events: none;
        }
        .input-container.disabled .input-hint {
            display: none;
        }
        .input-disabled-overlay {
            display: none;
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: transparent;
            cursor: not-allowed;
            z-index: 10;
        }
        .input-container.disabled .input-disabled-overlay {
            display: block;
        }
        
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 8px 0;
            border-bottom: 1px solid var(--vscode-panel-border);
            margin-bottom: 8px;
        }
        
        .mode-selector {
            display: flex;
            gap: 4px;
        }
        
        .mode-btn {
            padding: 4px 8px;
            border: 1px solid var(--vscode-button-border);
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            cursor: pointer;
            font-size: 11px;
            border-radius: 3px;
        }
        
        .mode-btn.active {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        
        .status {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }
        
        .status-indicator {
            display: inline-block;
            width: 8px;
            height: 8px;
            border-radius: 50%;
            margin-right: 4px;
        }
        
        .status-indicator.local { background: #4ec9b0; }
        .status-indicator.api { background: #569cd6; }
        .status-indicator.auto { background: #dcdcaa; }
        
        .search-mode-toggle {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 6px 8px;
            background: var(--vscode-editor-background);
            border-radius: 4px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .search-mode-toggle .toggle-label { font-size: 10px; color: var(--vscode-descriptionForeground); }
        .search-mode-toggle .toggle-options { display: flex; gap: 2px; }
        .search-mode-toggle input[type="radio"] { display: none; }
        .search-mode-toggle .toggle-btn {
            padding: 3px 8px;
            font-size: 11px;
            border-radius: 3px;
            cursor: pointer;
            transition: all 0.15s;
        }
        .search-mode-toggle input:checked + .toggle-btn {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .search-mode-toggle input:not(:checked) + .toggle-btn {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        
        .chat-container {
            flex: 1;
            overflow-y: auto;
            padding: 8px 0;
        }
        
        .message {
            margin-bottom: 12px;
            padding: 8px 12px;
            border-radius: 6px;
            max-width: 95%;
        }
        
        .message.user {
            background: var(--vscode-input-background);
            margin-left: auto;
        }
        
        .message.assistant {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
        }
        
        .message-divider {
            display: flex;
            align-items: center;
            margin: 12px 0;
            gap: 12px;
        }
        
        .message-divider::before,
        .message-divider::after {
            content: '';
            flex: 1;
            height: 1px;
            background: linear-gradient(to right, transparent, var(--vscode-panel-border), transparent);
        }
        
        .message-divider-dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: var(--vscode-panel-border);
        }
        
        /* Conversation separator between Q&A pairs */
        .conversation-separator {
            margin: 20px 0;
            padding: 0 10px;
        }
        
        .conversation-hr {
            border: none;
            height: 1px;
            background: linear-gradient(to right, 
                transparent, 
                var(--vscode-panel-border) 20%, 
                var(--vscode-panel-border) 80%, 
                transparent);
            margin: 0;
        }
        
        .message-header {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 4px;
        }
        
        .message-content {
            white-space: pre-wrap;
            word-wrap: break-word;
        }
        
        .message-content code {
            background: var(--vscode-textCodeBlock-background);
            padding: 1px 4px;
            border-radius: 3px;
            font-family: var(--vscode-editor-font-family);
        }
        
        .message-content pre {
            background: var(--vscode-textCodeBlock-background);
            padding: 8px;
            border-radius: 4px;
            overflow-x: auto;
            margin: 8px 0;
        }
        
        .message-content pre.code-block {
            position: relative;
            cursor: pointer;
        }
        
        .message-content pre.code-block:hover {
            outline: 1px solid var(--vscode-focusBorder);
        }
        
        .message-content pre.code-block::after {
            content: 'Click to copy';
            position: absolute;
            top: 4px;
            right: 4px;
            font-size: 10px;
            opacity: 0;
            transition: opacity 0.2s;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 2px 6px;
            border-radius: 3px;
        }
        
        .message-content pre.code-block:hover::after {
            opacity: 1;
        }
        
        .message-content pre.code-block.copied::after {
            content: 'Copied!';
            opacity: 1;
            background: var(--vscode-testing-iconPassed);
        }
        
        .message-content .file-link {
            cursor: pointer;
            color: var(--vscode-textLink-foreground);
            text-decoration: underline;
            background-color: var(--vscode-textCodeBlock-background);
            padding: 2px 6px;
            border-radius: 4px;
            display: inline-block;
        }
        
        .message-content .file-link:hover {
            color: var(--vscode-textLink-activeForeground);
            background-color: var(--vscode-button-hoverBackground);
        }
        
        .message-content .doc-link-btn {
            cursor: pointer;
            color: var(--vscode-button-foreground);
            background-color: var(--vscode-button-background);
            border: none;
            padding: 6px 12px;
            border-radius: 4px;
            font-size: 13px;
            font-weight: 500;
            margin: 4px 0;
            display: inline-block;
        }
        
        .message-content .doc-link-btn:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        
        /* Keep Exploring section */
        .explore-section {
            margin-top: 16px;
            padding: 12px;
            background: var(--vscode-textBlockQuote-background, rgba(127, 127, 127, 0.1));
            border-radius: 6px;
            border-left: 3px solid var(--vscode-textLink-foreground, #3794ff);
        }
        
        .explore-section .explore-title {
            font-weight: 600;
            margin-bottom: 8px;
            color: var(--vscode-textLink-foreground, #3794ff);
        }
        
        .explore-section .explore-btn {
            display: block;
            width: 100%;
            text-align: left;
            cursor: pointer;
            color: var(--vscode-foreground);
            background: var(--vscode-button-secondaryBackground);
            border: 1px solid var(--vscode-button-border, transparent);
            padding: 8px 12px;
            border-radius: 4px;
            font-size: 13px;
            margin: 4px 0;
            transition: background 0.15s ease;
            pointer-events: auto;
        }
        
        .explore-section .explore-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
            border-color: var(--vscode-textLink-foreground, #3794ff);
            cursor: pointer;
        }
        
        .explore-section .explore-btn .explore-topic,
        .explore-section .explore-btn .explore-desc {
            pointer-events: none;
        }
        
        .explore-section .explore-btn .explore-topic {
            font-weight: 500;
            color: var(--vscode-textLink-foreground, #3794ff);
        }
        
        .explore-section .explore-btn .explore-desc {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-top: 2px;
        }
        
        .message-content .external-link {
            color: var(--vscode-textLink-foreground);
            text-decoration: underline;
        }
        
        .message-content .external-link:hover {
            color: var(--vscode-textLink-activeForeground);
        }
        
        .message-content h1, .message-content h2, .message-content h3 {
            margin: 12px 0 8px 0;
            font-weight: 600;
        }
        
        .message-content h1 { font-size: 1.3em; }
        .message-content h2 { font-size: 1.15em; }
        .message-content h3 { font-size: 1.05em; }
        
        .message-content hr {
            border: none;
            border-top: 1px solid var(--vscode-panel-border);
            margin: 12px 0;
        }
        
        .message-content blockquote {
            border-left: 3px solid var(--vscode-textBlockQuote-border);
            padding-left: 10px;
            margin: 8px 0;
            color: var(--vscode-textBlockQuote-foreground);
        }
        
        .input-container {
            padding-top: 8px;
            border-top: 1px solid var(--vscode-panel-border);
        }
        
        .input-row {
            display: flex;
            gap: 8px;
        }
        
        .input-actions {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-top: 8px;
            gap: 8px;
        }
        
        .action-right {
            display: flex;
            gap: 8px;
        }
        
        .input-hint {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            margin-top: 4px;
            opacity: 0.8;
        }
        
        #addFilesBtn {
            padding: 6px 12px;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-button-border);
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
        }
        
        #addFilesBtn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        
        #chatInput {
            flex: 1;
            padding: 8px;
            border: 1px solid var(--vscode-input-border);
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: 4px;
            font-family: inherit;
            font-size: inherit;
            resize: none;
            min-height: 60px;
        }
        
        #chatInput:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }
        
        #sendBtn {
            padding: 8px 16px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            align-self: flex-end;
        }
        
        #sendBtn:hover {
            background: var(--vscode-button-hoverBackground);
        }
        
        #sendBtn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        
        #cancelBtn {
            padding: 8px 12px;
            background: linear-gradient(135deg, #f44336, #c62828) !important;
            color: white !important;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            align-self: flex-end;
            font-weight: 600;
            animation: pulse 1.5s infinite;
        }
        
        #cancelBtn:hover {
            background: linear-gradient(135deg, #ef5350, #e53935) !important;
        }
        
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.7; }
        }
        
        .context-summary {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            padding: 4px 0;
        }
        
        .loading {
            display: flex;
            align-items: center;
            gap: 8px;
            color: var(--vscode-descriptionForeground);
        }
        
        .loading-dots::after {
            content: '';
            animation: dots 1.5s steps(4, end) infinite;
        }
        
        @keyframes dots {
            0%, 20% { content: ''; }
            40% { content: '.'; }
            60% { content: '..'; }
            80%, 100% { content: '...'; }
        }
        
        .empty-state {
            text-align: center;
            color: var(--vscode-descriptionForeground);
            padding: 40px 20px;
        }
        
        .empty-state h3 {
            margin-bottom: 8px;
            color: var(--vscode-foreground);
        }
        
        .quick-actions {
            display: flex;
            flex-wrap: wrap;
            gap: 4px;
            margin-top: 12px;
            justify-content: center;
        }
        
        .quick-action {
            padding: 4px 8px;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-button-border);
            border-radius: 12px;
            cursor: pointer;
            font-size: 11px;
        }
        
        .quick-action:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        
        .quick-actions-bar {
            display: flex;
            flex-wrap: wrap;
            gap: 4px;
            margin-bottom: 8px;
            justify-content: center;
        }
        
        .quick-action-btn {
            padding: 4px 10px;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-button-border);
            border-radius: 12px;
            cursor: pointer;
            font-size: 11px;
        }
        
        .quick-action-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        
        /* Code Docs dropdown container */
        .docs-dropdown {
            position: relative;
            display: inline-block;
        }
        
        .docs-dropdown-btn {
            padding: 4px 10px;
            background: rgba(33, 150, 243, 0.2) !important;
            color: #64B5F6 !important;
            border: 1px solid rgba(33, 150, 243, 0.4) !important;
            border-radius: 12px;
            cursor: pointer;
            font-size: 11px;
            font-weight: 500;
        }
        
        .docs-dropdown-btn:hover {
            background: rgba(33, 150, 243, 0.35) !important;
            border-color: rgba(33, 150, 243, 0.6) !important;
        }
        
        .docs-dropdown-panel {
            display: none;
            position: absolute;
            bottom: 100%;
            left: 50%;
            transform: translateX(-50%);
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
            padding: 12px;
            margin-bottom: 8px;
            min-width: 280px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            z-index: 100;
        }
        
        .docs-dropdown-panel.show {
            display: block;
        }
        
        .docs-dropdown-title {
            font-size: 12px;
            font-weight: 600;
            color: var(--vscode-foreground);
            margin-bottom: 10px;
            text-align: center;
        }
        
        .docs-option {
            display: flex;
            align-items: flex-start;
            padding: 8px;
            border-radius: 6px;
            cursor: pointer;
            margin-bottom: 6px;
            border: 1px solid transparent;
            transition: all 0.15s ease;
        }
        
        .docs-option:hover {
            background: var(--vscode-list-hoverBackground);
        }
        
        .docs-option.selected {
            background: var(--vscode-list-activeSelectionBackground);
            border-color: var(--vscode-focusBorder);
        }
        
        .docs-option input[type="radio"] {
            margin-right: 10px;
            margin-top: 2px;
            accent-color: var(--vscode-button-background);
        }
        
        .docs-option-content {
            flex: 1;
        }
        
        .docs-option-label {
            font-size: 12px;
            font-weight: 600;
            color: var(--vscode-foreground);
            display: flex;
            align-items: center;
            gap: 6px;
        }
        
        .docs-option-desc {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            margin-top: 4px;
            line-height: 1.4;
        }
        
        .docs-generate-btn {
            width: 100%;
            padding: 8px 16px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 500;
            margin-top: 8px;
        }
        
        .docs-generate-btn:hover {
            background: var(--vscode-button-hoverBackground);
        }
        
        /* Module name input in docs dropdown */
        .docs-module-input {
            padding: 8px 0;
            margin-bottom: 8px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .docs-module-input label {
            display: block;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 4px;
        }
        .docs-module-input input {
            width: 100%;
            padding: 6px 8px;
            border: 1px solid var(--vscode-input-border);
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: 4px;
            font-size: 12px;
        }
        .docs-module-input input:focus {
            outline: none;
            border-color: var(--vscode-focusBorder);
        }
        .docs-dropdown-subtitle {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            padding: 4px 0 8px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        
        .docs-hint {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            text-align: center;
            margin-top: 8px;
            padding-top: 8px;
            border-top: 1px solid var(--vscode-panel-border);
        }
        
        /* Graph button - subtle green */
        .graph-btn {
            background: rgba(76, 175, 80, 0.2) !important;
            color: #81C784 !important;
            border: 1px solid rgba(76, 175, 80, 0.4) !important;
            font-weight: 500;
        }
        
        .graph-btn:hover {
            background: rgba(76, 175, 80, 0.35) !important;
            border-color: rgba(76, 175, 80, 0.6) !important;
        }
        
        /* Semantic Search button - subtle purple */
        .search-btn {
            background: rgba(124, 77, 255, 0.2) !important;
            color: #B39DDB !important;
            border: 1px solid rgba(124, 77, 255, 0.4) !important;
            font-weight: 500;
        }
        
        .search-btn:hover {
            background: rgba(124, 77, 255, 0.35) !important;
            border-color: rgba(124, 77, 255, 0.6) !important;
        }
        
        /* System Prompt Section */
        .system-prompt-section {
            border-bottom: 1px solid var(--vscode-panel-border);
            margin-bottom: 8px;
        }
        
        .system-prompt-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 6px 0;
            cursor: pointer;
            user-select: none;
        }
        
        .system-prompt-header:hover {
            background: var(--vscode-list-hoverBackground);
        }
        
        .system-prompt-title {
            font-size: 11px;
            font-weight: 600;
            color: var(--vscode-foreground);
            display: flex;
            align-items: center;
            gap: 6px;
        }
        
        .system-prompt-toggle {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            transition: transform 0.2s ease;
        }
        
        .system-prompt-toggle.expanded {
            transform: rotate(180deg);
        }
        
        .system-prompt-content {
            display: none;
            padding: 8px 0;
        }
        
        .system-prompt-content.show {
            display: block;
        }
        
        .system-prompt-textarea {
            width: 100%;
            min-height: 120px;
            max-height: 300px;
            padding: 8px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            font-family: var(--vscode-editor-font-family), monospace;
            font-size: 11px;
            line-height: 1.4;
            resize: vertical;
        }
        
        .system-prompt-textarea:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }
        
        .system-prompt-actions {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-top: 8px;
            gap: 8px;
        }
        
        .system-prompt-btn {
            padding: 4px 10px;
            font-size: 11px;
            border-radius: 4px;
            cursor: pointer;
            border: 1px solid var(--vscode-button-border);
        }
        
        .system-prompt-save {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        
        .system-prompt-save:hover {
            background: var(--vscode-button-hoverBackground);
        }
        
        .system-prompt-reset {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        
        .system-prompt-reset:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        
        .system-prompt-status {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            flex: 1;
        }
        
        .system-prompt-status.saved {
            color: #4CAF50;
        }
        
        .system-prompt-indicator {
            font-size: 10px;
            padding: 2px 6px;
            border-radius: 8px;
            background: rgba(255, 193, 7, 0.2);
            color: #FFC107;
        }
        
        .system-prompt-indicator.default {
            background: rgba(76, 175, 80, 0.2);
            color: #81C784;
        }
        
        .system-prompt-indicator.custom {
            background: rgba(255, 193, 7, 0.2);
            color: #FFC107;
        }
        
        .add-files-big {
            padding: 12px 24px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            margin: 16px 0;
        }
        
        .add-files-big:hover {
            background: var(--vscode-button-hoverBackground);
        }
        
        .context-bar {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 4px 0;
            border-bottom: 1px solid var(--vscode-panel-border);
            margin-bottom: 4px;
        }
        
        .context-files-list {
            display: flex;
            flex-wrap: wrap;
            gap: 4px;
            flex: 1;
            max-height: 60px;
            overflow: hidden;
            transition: max-height 0.3s ease;
        }
        
        .context-files-list.expanded {
            max-height: 200px;
            overflow-y: auto;
        }
        
        .context-summary {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 4px 8px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            border-radius: 10px;
            font-size: 11px;
            cursor: pointer;
        }
        
        .context-summary:hover {
            opacity: 0.9;
        }
        
        .context-summary .expand-icon {
            font-size: 10px;
            transition: transform 0.2s;
        }
        
        .context-summary.expanded .expand-icon {
            transform: rotate(180deg);
        }
        
        .context-file-chip {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 2px 6px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            border-radius: 10px;
            font-size: 11px;
        }
        
        .context-file-chip .remove-file {
            cursor: pointer;
            opacity: 0.7;
            font-size: 10px;
        }
        
        .context-file-chip .remove-file:hover {
            opacity: 1;
        }
        
        .clear-context-btn {
            padding: 2px 6px;
            background: transparent;
            color: var(--vscode-descriptionForeground);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 3px;
            cursor: pointer;
            font-size: 10px;
            white-space: nowrap;
        }
        
        .clear-context-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
            color: var(--vscode-foreground);
        }
        
        .context-actions {
            display: flex;
            gap: 4px;
            align-items: center;
        }
        
        .index-btn {
            padding: 2px 6px;
            background: transparent;
            color: var(--vscode-descriptionForeground);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 3px;
            cursor: pointer;
            font-size: 10px;
            white-space: nowrap;
        }
        
        .index-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
            color: var(--vscode-foreground);
        }
        
        /* Index Progress - Inline version (no layout shift) */
        .index-progress-inline {
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 2px 8px;
            background: var(--vscode-editor-background);
            border-radius: 4px;
            border: 1px solid var(--vscode-panel-border);
            font-size: 11px;
        }
        
        .index-progress-text-inline {
            color: var(--vscode-descriptionForeground);
            min-width: 80px;
        }
        
        /* Summary Progress - distinct styling */
        #summaryProgressInline {
            background: linear-gradient(135deg, var(--vscode-editor-background), rgba(100, 149, 237, 0.1));
            border-color: rgba(100, 149, 237, 0.3);
        }
        
        #summaryProgressText {
            min-width: 140px;
            color: var(--vscode-textLink-foreground);
        }
        
        /* Flashing Indexing Indicator */
        .indexing-indicator {
            font-size: 14px;
            animation: flash-bulb 0.8s ease-in-out infinite;
        }
        
        @keyframes flash-bulb {
            0%, 100% { 
                opacity: 1; 
                filter: brightness(1) drop-shadow(0 0 4px #ffd700);
            }
            50% { 
                opacity: 0.4; 
                filter: brightness(0.6) drop-shadow(0 0 0px #ffd700);
            }
        }
    </style>
</head>
<body>
    <div class="header">
        <div class="mode-selector">
            <button class="mode-btn" data-mode="auto" title="Smart detection">Auto</button>
            <button class="mode-btn" data-mode="local" title="Use context files only">Local</button>
            <button class="mode-btn" data-mode="api" title="Search API server">API</button>
        </div>
        <div class="status">
            <span class="status-indicator auto"></span>
            <span id="statusText">Auto Mode</span>
        </div>
    </div>
    
    <div class="search-mode-toggle">
        <span class="toggle-label">Search:</span>
        <div class="toggle-options">
            <label title="Search summaries only"><input type="radio" name="searchMode" value="overview"/><span class="toggle-btn">📋 Overview</span></label>
            <label title="Search source code"><input type="radio" name="searchMode" value="detailed" checked/><span class="toggle-btn">💻 Code</span></label>
        </div>
    </div>
    
    <div class="system-prompt-section">
        <div class="system-prompt-header" id="systemPromptHeader">
            <div class="system-prompt-title">
                <span>⚙️ System Prompt</span>
                <span class="system-prompt-indicator default" id="systemPromptIndicator">Default</span>
            </div>
            <span class="system-prompt-toggle" id="systemPromptToggle">▼</span>
        </div>
        <div class="system-prompt-content" id="systemPromptContent">
            <textarea class="system-prompt-textarea" id="systemPromptTextarea" placeholder="Customize how AstraCode responds. This prompt is prepended to every query.

Example:
- Focus on payment processing domain
- Always provide code examples
- Use formal technical language
- Reference specific frameworks"></textarea>
            <div class="system-prompt-actions">
                <span class="system-prompt-status" id="systemPromptStatus">Prepended to every query</span>
                <button class="system-prompt-btn system-prompt-reset" id="resetSystemPromptBtn">Reset to Default</button>
                <button class="system-prompt-btn system-prompt-save" id="saveSystemPromptBtn">Save</button>
            </div>
        </div>
    </div>
    
    <!-- Indexing Status Banner -->
    <div id="indexingBanner" class="indexing-banner">
        <div class="banner-title">
            <span class="spinner"></span>
            <span id="bannerTitle">Indexing in progress...</span>
        </div>
        <div id="bannerPhase" class="banner-phase">📂 Parsing files...</div>
        <div id="bannerStats" class="banner-stats">0 files | 0 symbols</div>
        <div id="bannerProgress" class="banner-progress"></div>
    </div>
    
    <div id="contextBar" class="context-bar" style="display: none;">
        <div id="contextFilesList" class="context-files-list"></div>
        <div class="context-actions">
            <div id="indexProgressInline" class="index-progress-inline" style="display: none;">
                <span id="indexingIndicator" class="indexing-indicator">💡</span>
                <span id="indexProgressText" class="index-progress-text-inline">0%</span>
            </div>
            <div id="summaryProgressInline" class="index-progress-inline" style="display: none;">
                <span class="indexing-indicator">📚</span>
                <span id="summaryProgressText" class="index-progress-text-inline">Summaries...</span>
            </div>
            <button id="rebuildIndexBtn" class="index-btn" title="Rebuild code index">🔄 Rebuild</button>
            <button id="clearContextBtn" class="clear-context-btn" title="Clear all files and index">🗑️ Clear All</button>
        </div>
    </div>
    
    <div id="chatContainer" class="chat-container">
        <div class="empty-state">
            <h3><span style="color: #FFD700;">★</span> AstraCode Assistant</h3>
            <p>Add files to context, then ask questions</p>
            <button class="add-files-big" id="addFilesBigBtn">📎 Add Files to Context</button>
        </div>
    </div>
    
    <div class="input-container" id="inputContainer">
        <div class="input-disabled-overlay" id="inputDisabledOverlay"></div>
        <div id="quickActionsBar" class="quick-actions-bar">
            <button class="quick-action-btn" data-prompt="Find bugs and issues">🐛 Debug</button>
            <button class="quick-action-btn graph-btn" data-command="openCallGraphInBrowser">⬡ Graph</button>
            <button class="quick-action-btn search-btn" data-command="semanticSearch">🧠 Search</button>
            <div class="docs-dropdown">
                <button class="docs-dropdown-btn" id="docsDropdownBtn">📄 Code Docs ▾</button>
                <div class="docs-dropdown-panel" id="docsDropdownPanel">
                    <div class="docs-dropdown-title">Generate Documentation</div>
                    
                    <!-- Module Name Input -->
                    <div class="docs-module-input">
                        <label for="moduleNameInput">Module/Feature Name:</label>
                        <input type="text" id="moduleNameInput" placeholder="e.g., PaymentProcessor, AuthModule">
                    </div>
                    
                    <!-- Focus Area (Optional) -->
                    <div class="docs-module-input">
                        <label for="focusAreaInput">Focus Area (optional):</label>
                        <input type="text" id="focusAreaInput" placeholder="e.g., validation, error handling, permissions">
                    </div>
                    
                    <div class="docs-dropdown-subtitle">Choose Type</div>
                    
                    <!-- Business Docs (DEFAULT) -->
                    <label class="docs-option selected" data-type="business">
                        <input type="radio" name="docType" value="business" checked>
                        <div class="docs-option-content">
                            <div class="docs-option-label">📊 Business Documentation</div>
                            <div class="docs-option-desc">What it does, who benefits, business rules, value delivered.</div>
                        </div>
                    </label>
                    
                    <!-- Business Rules Only -->
                    <label class="docs-option" data-type="businessRules">
                        <input type="radio" name="docType" value="businessRules">
                        <div class="docs-option-content">
                            <div class="docs-option-label">📋 Business Rules</div>
                            <div class="docs-option-desc">Extract validation logic, constraints, and rules from code.</div>
                        </div>
                    </label>
                    
                    <!-- Use Cases & Requirements -->
                    <label class="docs-option" data-type="useCases">
                        <input type="radio" name="docType" value="useCases">
                        <div class="docs-option-content">
                            <div class="docs-option-label">👥 Use Cases & Requirements</div>
                            <div class="docs-option-desc">Users, personas, use cases, requirements, user stories.</div>
                        </div>
                    </label>
                    
                    <!-- Technical Docs -->
                    <label class="docs-option" data-type="technical">
                        <input type="radio" name="docType" value="technical">
                        <div class="docs-option-content">
                            <div class="docs-option-label">🔧 Technical Documentation</div>
                            <div class="docs-option-desc">API reference, data structures, call graphs. For developers.</div>
                        </div>
                    </label>
                    
                    <button class="docs-generate-btn" id="generateDocsBtn">Generate Documentation</button>
                    <div class="docs-hint">💡 Opens in editor window. Preview shown in chat.</div>
                </div>
            </div>
        </div>
        <div class="input-row">
            <textarea id="chatInput" placeholder="Ask a question... (Ctrl+Enter to send)" rows="2"></textarea>
        </div>
        <div class="input-actions">
            <button id="addFilesBtn" title="Add files to context">📎 Add Files</button>
            <div class="action-right">
                <button id="cancelBtn" style="display:none" title="Cancel current task">⏹️ Cancel</button>
                <button id="sendBtn">Send</button>
            </div>
        </div>
        <div class="input-hint">
            💡 Right-click file in Explorer → "AstraCode: Add File to Context"
        </div>
    </div>
    
    <script>
        const vscode = acquireVsCodeApi();
        
        // Elements
        const chatContainer = document.getElementById('chatContainer');
        const chatInput = document.getElementById('chatInput');
        const sendBtn = document.getElementById('sendBtn');
        const addFilesBtn = document.getElementById('addFilesBtn');
        const statusText = document.getElementById('statusText');
        const contextBar = document.getElementById('contextBar');
        const contextFilesList = document.getElementById('contextFilesList');
        const clearContextBtn = document.getElementById('clearContextBtn');
        const modeBtns = document.querySelectorAll('.mode-btn');
        const quickActions = document.querySelectorAll('.quick-action');
        
        let currentMode = 'auto';
        let isProcessing = false;
        let contextFilesData = []; // Store file paths for removal
        
        // System Prompt Elements
        const systemPromptHeader = document.getElementById('systemPromptHeader');
        const systemPromptToggle = document.getElementById('systemPromptToggle');
        const systemPromptContent = document.getElementById('systemPromptContent');
        const systemPromptTextarea = document.getElementById('systemPromptTextarea');
        const systemPromptIndicator = document.getElementById('systemPromptIndicator');
        const systemPromptStatus = document.getElementById('systemPromptStatus');
        const saveSystemPromptBtn = document.getElementById('saveSystemPromptBtn');
        const resetSystemPromptBtn = document.getElementById('resetSystemPromptBtn');
        
        // Toggle system prompt panel
        systemPromptHeader.addEventListener('click', () => {
            const isExpanded = systemPromptContent.classList.toggle('show');
            systemPromptToggle.classList.toggle('expanded', isExpanded);
            
            // Request current system prompt when opening
            if (isExpanded) {
                vscode.postMessage({ type: 'getSystemPrompt' });
            }
        });
        
        // Save system prompt
        saveSystemPromptBtn.addEventListener('click', () => {
            const newPrompt = systemPromptTextarea.value.trim();
            vscode.postMessage({ type: 'setSystemPrompt', prompt: newPrompt });
            
            systemPromptStatus.textContent = 'Saving...';
            systemPromptStatus.classList.remove('saved');
        });
        
        // Reset to default
        resetSystemPromptBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'resetSystemPrompt' });
            systemPromptStatus.textContent = 'Resetting...';
        });
        
        // Add files button (small)
        addFilesBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'addFiles' });
        });
        
        // Add files button (big - in empty state)
        const addFilesBigBtn = document.getElementById('addFilesBigBtn');
        if (addFilesBigBtn) {
            addFilesBigBtn.addEventListener('click', () => {
                vscode.postMessage({ type: 'addFiles' });
            });
        }
        
        // Clear context button
        clearContextBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'clearContext' });
        });
        
        // Rebuild index button
        const rebuildIndexBtn = document.getElementById('rebuildIndexBtn');
        
        if (rebuildIndexBtn) {
            rebuildIndexBtn.addEventListener('click', () => {
                vscode.postMessage({ type: 'command', command: 'rebuildIndex' });
            });
        }
        
        // Mode selection
        modeBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                currentMode = btn.dataset.mode;
                modeBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                
                document.querySelector('.status-indicator').className = 'status-indicator ' + currentMode;
                
                vscode.postMessage({ type: 'setMode', mode: currentMode });
            });
        });
        
        // Quick actions (in empty state)
        quickActions.forEach(btn => {
            btn.addEventListener('click', () => {
                if (btn.dataset.command) {
                    vscode.postMessage({ type: 'command', command: btn.dataset.command });
                } else if (btn.dataset.prompt) {
                    chatInput.value = btn.dataset.prompt;
                    chatInput.focus();
                }
            });
        });
        
        // Persistent quick action buttons (always visible above input)
        document.querySelectorAll('.quick-action-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                if (btn.dataset.command) {
                    vscode.postMessage({ type: 'command', command: btn.dataset.command });
                } else if (btn.dataset.prompt) {
                    chatInput.value = btn.dataset.prompt;
                    chatInput.focus();
                    // Optionally auto-send
                    // sendMessage();
                }
            });
        });
        
        // Documentation dropdown handlers
        const docsDropdownBtn = document.getElementById('docsDropdownBtn');
        const docsDropdownPanel = document.getElementById('docsDropdownPanel');
        const generateDocsBtn = document.getElementById('generateDocsBtn');
        const docOptions = document.querySelectorAll('.docs-option');
        
        // Toggle dropdown
        docsDropdownBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            docsDropdownPanel.classList.toggle('show');
        });
        
        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.docs-dropdown')) {
                docsDropdownPanel.classList.remove('show');
            }
        });
        
        // Handle option selection
        docOptions.forEach(option => {
            option.addEventListener('click', () => {
                docOptions.forEach(o => o.classList.remove('selected'));
                option.classList.add('selected');
                option.querySelector('input[type="radio"]').checked = true;
            });
        });
        
        // Generate documentation button
        generateDocsBtn.addEventListener('click', () => {
            const selectedType = document.querySelector('input[name="docType"]:checked').value;
            const moduleName = document.getElementById('moduleNameInput').value.trim() || 'Codebase';
            const focusArea = document.getElementById('focusAreaInput').value.trim() || '';
            docsDropdownPanel.classList.remove('show');
            
            // Send message to generate documentation
            vscode.postMessage({ 
                type: 'generateDocumentation', 
                docType: selectedType,
                moduleName: moduleName,
                focusArea: focusArea
            });
        });
        
        // Send message
        function sendMessage() {
            const text = chatInput.value.trim();
            if (!text || isProcessing) return;
            
            chatInput.value = '';
            vscode.postMessage({ type: 'chat', text });
        }
        
        sendBtn.addEventListener('click', sendMessage);
        
        // Search mode toggle
        document.querySelectorAll('input[name="searchMode"]').forEach(r => {
            r.addEventListener('change', e => vscode.postMessage({ type: 'setSearchMode', mode: e.target.value }));
        });
        vscode.postMessage({ type: 'getSearchMode' });
        
        // Cancel button
        document.getElementById('cancelBtn')?.addEventListener('click', () => {
            vscode.postMessage({ type: 'cancelTask' });
        });
        
        chatInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                sendMessage();
            }
        });
        
        // Receive messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            
            switch (message.type) {
                case 'updateChat':
                    renderChat(message.history);
                    break;
                case 'updateStatus':
                    updateStatus(message.status);
                    break;
                case 'setProcessing':
                    isProcessing = message.processing;
                    sendBtn.disabled = isProcessing;
                    
                    // Show/hide cancel button
                    const cancelBtn = document.getElementById('cancelBtn');
                    if (cancelBtn) {
                        cancelBtn.style.display = isProcessing ? 'inline-block' : 'none';
                    }
                    
                    if (isProcessing) {
                        addLoadingIndicator();
                        sendBtn.textContent = '⏳';
                    } else {
                        removeLoadingIndicator();
                        sendBtn.textContent = 'Send';
                    }
                    break;
                case 'appendResponse':
                    appendToLastMessage(message.text);
                    break;
                case 'replaceLastResponse':
                    replaceLastResponse(message.text);
                    break;
                case 'finalizeResponse':
                    finalizeLastMessage();
                    break;
                case 'newConversation':
                    // Start a new Q&A pair - finalize previous and create separator
                    finalizeLastMessage();
                    startNewConversation(message.question);
                    break;
                case 'renderChat':
                    // Handle the renderChat message type from extension
                    renderChat(message.history);
                    break;
                case 'updateChat':
                    // Legacy handler - same as renderChat
                    renderChat(message.history);
                    break;
                case 'indexProgress':
                    showIndexProgress(message.progress, message.message, message.stats);
                    break;
                case 'indexingStatus':
                    updateIndexingBanner(message);
                    break;
                case 'summaryProgress':
                    showSummaryProgress(message.progress, message.message, message.count);
                    break;
                case 'systemPromptUpdate':
                    // Update the system prompt textarea and indicator
                    systemPromptTextarea.value = message.prompt || '';
                    
                    if (message.isDefault) {
                        systemPromptIndicator.textContent = 'Default';
                        systemPromptIndicator.classList.add('default');
                        systemPromptIndicator.classList.remove('custom');
                    } else {
                        systemPromptIndicator.textContent = 'Custom';
                        systemPromptIndicator.classList.remove('default');
                        systemPromptIndicator.classList.add('custom');
                    }
                    
                    if (message.saved) {
                        systemPromptStatus.textContent = '✓ Saved';
                        systemPromptStatus.classList.add('saved');
                        setTimeout(() => {
                            systemPromptStatus.textContent = 'Prepended to every query';
                            systemPromptStatus.classList.remove('saved');
                        }, 2000);
                    }
                    break;
                case 'searchModeUpdate':
                    const modeRadio = document.querySelector(\`input[name="searchMode"][value="\${message.mode}"]\`);
                    if (modeRadio) modeRadio.checked = true;
                    break;
                case 'restoreHistory':
                    // Restore chat history from persistence
                    if (message.history && message.history.length > 0) {
                        renderChat(message.history);
                        console.log('Restored', message.history.length, 'messages from persistence');
                    }
                    break;
            }
        });
        
        // Index progress indicator - uses inline element (no layout shift)
        function showIndexProgress(progress, message, stats) {
            const progressContainer = document.getElementById('indexProgressInline');
            const progressText = document.getElementById('indexProgressText');
            const contextBar = document.getElementById('contextBar');
            
            if (!progressContainer || !progressText) return;
            
            if (progress < 100) {
                // Show progress - ALSO ensure contextBar is visible
                if (contextBar) contextBar.style.display = 'flex';
                progressContainer.style.display = 'flex';
                progressText.textContent = message;
            } else {
                // Complete - show briefly then hide
                progressText.textContent = '✓ Done';
                setTimeout(() => {
                    progressContainer.style.display = 'none';
                }, 1500);
            }
            
            // Also update the banner
            updateIndexingBannerFromProgress(progress, message, stats);
        }
        
        // Update indexing banner from progress messages
        function updateIndexingBannerFromProgress(progress, message, stats) {
            const banner = document.getElementById('indexingBanner');
            const bannerTitle = document.getElementById('bannerTitle');
            const bannerPhase = document.getElementById('bannerPhase');
            const bannerStats = document.getElementById('bannerStats');
            const bannerProgress = document.getElementById('bannerProgress');
            const inputContainer = document.getElementById('inputContainer');
            
            if (!banner) return;
            
            if (progress < 100) {
                // Show banner and disable input
                banner.classList.add('show');
                banner.classList.remove('complete');
                inputContainer?.classList.add('disabled');
                chatInput.placeholder = '⏳ Please wait for indexing to complete...';
                chatInput.disabled = true;
                
                bannerTitle.textContent = 'Indexing in progress...';
                bannerPhase.textContent = message || 'Processing...';
                bannerProgress.style.width = progress + '%';
                
                // Use stats object if provided, otherwise parse from message
                if (stats && (stats.files > 0 || stats.symbols > 0)) {
                    const statsParts = [];
                    if (stats.files > 0) statsParts.push(stats.files + ' files');
                    if (stats.symbols > 0) statsParts.push(stats.symbols + ' symbols');
                    if (stats.functions > 0) statsParts.push(stats.functions + ' functions');
                    bannerStats.textContent = statsParts.join(' | ');
                } else {
                    // Fallback: extract stats from message
                    const statsMatch = message?.match(/(\d+)\s*files.*?(\d+)\s*symbols/i);
                    if (statsMatch) {
                        bannerStats.textContent = statsMatch[1] + ' files | ' + statsMatch[2] + ' symbols';
                    }
                }
            } else {
                // Complete - show success briefly then hide
                banner.classList.add('complete');
                bannerTitle.innerHTML = '✅ Index ready';
                bannerPhase.textContent = message || 'Ready for queries';
                bannerProgress.style.width = '100%';
                
                // Use stats object for final display
                if (stats && (stats.files > 0 || stats.symbols > 0)) {
                    const statsParts = [];
                    if (stats.files > 0) statsParts.push(stats.files + ' files');
                    if (stats.symbols > 0) statsParts.push(stats.symbols + ' symbols');
                    if (stats.functions > 0) statsParts.push(stats.functions + ' functions');
                    bannerStats.textContent = statsParts.join(' | ');
                }
                
                // Enable input
                inputContainer?.classList.remove('disabled');
                chatInput.placeholder = 'Ask a question... (Ctrl+Enter to send)';
                chatInput.disabled = false;
                
                // Hide banner after delay
                setTimeout(() => {
                    banner.classList.remove('show');
                    banner.classList.remove('complete');
                }, 3000);
            }
        }
        
        // Update indexing banner from IndexingState
        function updateIndexingBanner(state) {
            const banner = document.getElementById('indexingBanner');
            const bannerTitle = document.getElementById('bannerTitle');
            const bannerPhase = document.getElementById('bannerPhase');
            const bannerStats = document.getElementById('bannerStats');
            const bannerProgress = document.getElementById('bannerProgress');
            const inputContainer = document.getElementById('inputContainer');
            
            if (!banner) return;
            
            const phaseMessages = {
                'idle': '',
                'parsing': '📂 Parsing files...',
                'symbols': '🔍 Extracting symbols...',
                'trigrams': '📊 Building trigram index...',
                'search': '🔎 Building search indexes...',
                'summaries': '🤖 Generating summaries...',
                'inverted': '📚 Adding summaries to inverted index...',
                'ready': '✅ Ready'
            };
            
            if (state.isIndexing || state.isSummarizing) {
                // Show banner and disable input
                banner.classList.add('show');
                banner.classList.remove('complete');
                inputContainer?.classList.add('disabled');
                chatInput.placeholder = '⏳ Please wait for indexing to complete...';
                chatInput.disabled = true;
                
                if (state.isSummarizing && !state.isIndexing) {
                    bannerTitle.textContent = 'Generating summaries...';
                } else {
                    bannerTitle.textContent = 'Indexing in progress...';
                }
                
                bannerPhase.textContent = phaseMessages[state.phase] || state.phaseName || 'Processing...';
                bannerProgress.style.width = state.progress + '%';
                
                // Build stats line
                const statsParts = [];
                if (state.stats?.files > 0) statsParts.push(state.stats.files + ' files');
                if (state.stats?.symbols > 0) statsParts.push(state.stats.symbols + ' symbols');
                if (state.stats?.summaries > 0) statsParts.push(state.stats.summaries + ' summaries');
                if (state.stats?.terms > 0) statsParts.push(state.stats.terms + ' search terms');
                bannerStats.textContent = statsParts.join(' | ') || 'Starting...';
                
            } else if (state.isReady) {
                // Complete - show success
                banner.classList.add('show');
                banner.classList.add('complete');
                bannerTitle.innerHTML = '✅ Index ready - summaries added to search';
                bannerPhase.textContent = 'All indexes built. Ready for queries.';
                bannerProgress.style.width = '100%';
                
                // Build final stats
                const statsParts = [];
                if (state.stats?.files > 0) statsParts.push(state.stats.files + ' files');
                if (state.stats?.symbols > 0) statsParts.push(state.stats.symbols + ' symbols');
                if (state.stats?.summaries > 0) statsParts.push(state.stats.summaries + ' summaries');
                if (state.stats?.terms > 0) statsParts.push(state.stats.terms + ' search terms');
                bannerStats.textContent = statsParts.join(' | ');
                
                // Enable input
                inputContainer?.classList.remove('disabled');
                chatInput.placeholder = 'Ask a question... (Ctrl+Enter to send)';
                chatInput.disabled = false;
                
                // Hide banner after delay
                setTimeout(() => {
                    banner.classList.remove('show');
                    banner.classList.remove('complete');
                }, 5000);
            } else {
                // Not indexing, hide banner
                banner.classList.remove('show');
                inputContainer?.classList.remove('disabled');
                chatInput.placeholder = 'Ask a question... (Ctrl+Enter to send)';
                chatInput.disabled = false;
            }
        }
        
        // Summary progress indicator
        function showSummaryProgress(progress, message, count) {
            const progressContainer = document.getElementById('summaryProgressInline');
            const progressText = document.getElementById('summaryProgressText');
            
            if (!progressContainer || !progressText) return;
            
            if (progress < 100) {
                // Show progress
                progressContainer.style.display = 'flex';
                progressText.textContent = message || 'Summarizing...';
            } else {
                // Complete - show count briefly then hide
                progressText.textContent = count ? '✓ ' + count + ' summaries' : '✓ Done';
                setTimeout(() => {
                    progressContainer.style.display = 'none';
                }, 3000);
            }
        }
        
        function renderChat(history) {
            if (!history || history.length === 0) {
                chatContainer.innerHTML = \`
                    <div class="empty-state">
                        <h3><span style="color: #FFD700;">★</span> AstraCode Assistant</h3>
                        <p>Add files to context, then ask questions</p>
                        <button class="add-files-big" id="addFilesBigBtnDynamic">📎 Add Files to Context</button>
                    </div>
                \`;
                
                // Attach add files button listener
                const addBtn = document.getElementById('addFilesBigBtnDynamic');
                if (addBtn) {
                    addBtn.addEventListener('click', () => {
                        vscode.postMessage({ type: 'addFiles' });
                    });
                }
                return;
            }
            
            chatContainer.innerHTML = history.map((msg, index) => {
                const messageHtml = \`
                    <div class="message \${msg.role}">
                        <div class="message-header">\${msg.role === 'user' ? 'You' : 'AstraCode'}</div>
                        <div class="message-content">\${escapeHtml(msg.content)}</div>
                    </div>
                \`;
                // Add divider after user message (before assistant response)
                const divider = (msg.role === 'user' && index < history.length - 1) ? 
                    '<div class="message-divider"><div class="message-divider-dot"></div></div>' : '';
                return messageHtml + divider;
            }).join('');
            
            chatContainer.scrollTop = chatContainer.scrollHeight;
        }
        
        function updateStatus(status) {
            statusText.textContent = status.text;
            
            // Update mode buttons
            modeBtns.forEach(btn => {
                btn.classList.toggle('active', btn.dataset.mode === status.mode);
            });
            
            document.querySelector('.status-indicator').className = 'status-indicator ' + status.mode;
            
            // Update context files bar
            if (status.files && status.files.length > 0) {
                contextBar.style.display = 'flex';
                contextFilesData = status.files;
                
                const fileCount = status.files.length;
                const COLLAPSE_THRESHOLD = 10; // Show summary if more than this many files
                
                if (fileCount > COLLAPSE_THRESHOLD) {
                    // Show collapsed summary view for large file counts
                    contextFilesList.innerHTML = 
                        '<div class="context-summary" id="contextSummary">' +
                            '<span>📁 ' + fileCount + ' files in context</span>' +
                            '<span class="expand-icon">▼</span>' +
                        '</div>' +
                        '<div id="contextFilesExpanded" class="context-files-expanded" style="display:none; flex-wrap:wrap; gap:4px; margin-top:4px; max-height:150px; overflow-y:auto;">' +
                            status.files.map((file, index) => 
                                '<span class="context-file-chip">' +
                                    file.name +
                                    '<span class="remove-file" data-index="' + index + '" title="Remove">✕</span>' +
                                '</span>'
                            ).join('') +
                        '</div>';
                    
                    // Toggle expand/collapse
                    const summary = document.getElementById('contextSummary');
                    const expanded = document.getElementById('contextFilesExpanded');
                    if (summary && expanded) {
                        summary.addEventListener('click', () => {
                            const isExpanded = expanded.style.display !== 'none';
                            expanded.style.display = isExpanded ? 'none' : 'flex';
                            summary.classList.toggle('expanded', !isExpanded);
                        });
                    }
                    
                    // Add click handlers for remove buttons
                    contextFilesList.querySelectorAll('.remove-file').forEach(btn => {
                        btn.addEventListener('click', (e) => {
                            e.stopPropagation();
                            const index = parseInt(e.target.dataset.index);
                            const file = contextFilesData[index];
                            if (file) {
                                vscode.postMessage({ type: 'removeFile', path: file.path });
                            }
                        });
                    });
                } else {
                    // Show all files as chips for small counts
                    contextFilesList.innerHTML = status.files.map((file, index) => 
                        '<span class="context-file-chip">' +
                            file.name +
                            '<span class="remove-file" data-index="' + index + '" title="Remove">✕</span>' +
                        '</span>'
                    ).join('');
                    
                    // Add click handlers for remove buttons
                    contextFilesList.querySelectorAll('.remove-file').forEach(btn => {
                        btn.addEventListener('click', (e) => {
                            const index = parseInt(e.target.dataset.index);
                            const file = contextFilesData[index];
                            if (file) {
                                vscode.postMessage({ type: 'removeFile', path: file.path });
                            }
                        });
                    });
                }
            } else {
                contextBar.style.display = 'none';
                contextFilesList.innerHTML = '';
            }
        }
        
        function addLoadingIndicator() {
            const existing = document.querySelector('.loading');
            if (existing) return;
            
            // Add divider before assistant response
            const existingDivider = chatContainer.querySelector('.message-divider:last-child');
            if (!existingDivider) {
                const divider = document.createElement('div');
                divider.className = 'message-divider';
                divider.innerHTML = '<div class="message-divider-dot"></div>';
                chatContainer.appendChild(divider);
            }
            
            const loading = document.createElement('div');
            loading.className = 'message assistant loading';
            loading.innerHTML = '<div class="loading-dots">Thinking</div>';
            chatContainer.appendChild(loading);
            chatContainer.scrollTop = chatContainer.scrollHeight;
        }
        
        function removeLoadingIndicator() {
            const loading = document.querySelector('.loading');
            if (loading) loading.remove();
        }
        
        function appendToLastMessage(text) {
            removeLoadingIndicator();
            
            let lastMsg = chatContainer.querySelector('.message.assistant:last-child');
            if (!lastMsg || lastMsg.classList.contains('loading')) {
                lastMsg = document.createElement('div');
                lastMsg.className = 'message assistant';
                lastMsg.innerHTML = '<div class="message-header">AstraCode</div><div class="message-content"></div>';
                chatContainer.appendChild(lastMsg);
            }
            
            const content = lastMsg.querySelector('.message-content');
            content.textContent += text;
            chatContainer.scrollTop = chatContainer.scrollHeight;
            
            // Limit to last 10 conversations (20 messages max)
            limitChatHistory();
        }
        
        function startNewConversation(question) {
            removeLoadingIndicator();
            
            // Finalize any previous assistant message
            finalizeLastMessage();
            
            // Add conversation separator if there's existing content
            const existingMessages = chatContainer.querySelectorAll('.message');
            if (existingMessages.length > 0) {
                const separator = document.createElement('div');
                separator.className = 'conversation-separator';
                separator.innerHTML = '<hr class="conversation-hr">';
                chatContainer.appendChild(separator);
            }
            
            // Create user message
            const userMsg = document.createElement('div');
            userMsg.className = 'message user';
            userMsg.innerHTML = '<div class="message-header">You</div><div class="message-content"></div>';
            userMsg.querySelector('.message-content').textContent = question;
            chatContainer.appendChild(userMsg);
            
            // Create new assistant message (empty, ready for response)
            const assistantMsg = document.createElement('div');
            assistantMsg.className = 'message assistant';
            assistantMsg.innerHTML = '<div class="message-header">AstraCode</div><div class="message-content"></div>';
            chatContainer.appendChild(assistantMsg);
            
            chatContainer.scrollTop = chatContainer.scrollHeight;
            
            // Limit history
            limitChatHistory();
        }
        
        function limitChatHistory() {
            // Keep only last 10 conversations (user + assistant pairs + separators)
            const messages = chatContainer.querySelectorAll('.message');
            const separators = chatContainer.querySelectorAll('.conversation-separator');
            
            // Count conversation pairs (each pair = 1 user + 1 assistant message)
            const maxMessages = 20; // 10 conversations × 2 messages
            
            if (messages.length > maxMessages) {
                // Remove oldest messages and their separators
                const toRemove = messages.length - maxMessages;
                for (let i = 0; i < toRemove; i++) {
                    const msg = messages[i];
                    // Also remove preceding separator if any
                    const prevSibling = msg.previousElementSibling;
                    if (prevSibling && prevSibling.classList.contains('conversation-separator')) {
                        prevSibling.remove();
                    }
                    msg.remove();
                }
            }
        }
        
        function replaceLastResponse(text) {
            const lastMsg = chatContainer.querySelector('.message.assistant:last-child');
            if (lastMsg && !lastMsg.classList.contains('loading')) {
                const content = lastMsg.querySelector('.message-content');
                if (content) {
                    content.textContent = text;
                }
            }
        }
        
        // Called when response is complete - converts plain text to rendered markdown with clickable links
        function finalizeLastMessage() {
            const lastMsg = chatContainer.querySelector('.message.assistant:last-child');
            if (lastMsg && !lastMsg.classList.contains('loading')) {
                const content = lastMsg.querySelector('.message-content');
                if (content && content.textContent) {
                    // Convert plain text to rendered markdown
                    content.innerHTML = renderMarkdown(content.textContent);
                    chatContainer.scrollTop = chatContainer.scrollHeight;
                }
            }
        }
        
        // Simple markdown renderer for code blocks and file links
        // Simple markdown renderer for code blocks and formatting
        function renderMarkdown(text) {
            // Escape HTML first
            let html = text
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
            
            // Render fenced code blocks (using String.fromCharCode to avoid template issues)
            const tick = String.fromCharCode(96); // backtick character
            // More forgiving regex - newline before closing backticks is optional
            const codeBlockRegex = new RegExp(tick + tick + tick + '(\\\\w*)\\\\n?([\\\\s\\\\S]*?)\\\\n?' + tick + tick + tick, 'g');
            
            // Track code block positions to protect them from further processing
            const codeBlocks = [];
            html = html.replace(codeBlockRegex, function(match, lang, code) {
                const placeholder = '___CODEBLOCK_' + codeBlocks.length + '___';
                codeBlocks.push('<pre class="code-block" data-lang="' + lang + '"><code>' + code + '</code></pre>');
                return placeholder;
            });
            
            // Render inline code and protect from further processing
            const inlineCodeRegex = new RegExp(tick + '([^' + tick + ']+)' + tick, 'g');
            const inlineCodes = [];
            html = html.replace(inlineCodeRegex, function(match, code) {
                const placeholder = '___INLINECODE_' + inlineCodes.length + '___';
                inlineCodes.push('<code class="inline-code">' + code + '</code>');
                return placeholder;
            });
            
            // Render headers
            html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
            html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
            html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
            
            // Render bold
            html = html.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
            
            // Render italic - but NOT if it looks like a comment (/* or */)
            // Only match standalone *text* not part of /* */
            html = html.replace(/(?<![\\/*])\\*([^\\*\\n]+)\\*(?![\\/*])/g, '<em>$1</em>');
            
            // Render horizontal rules
            html = html.replace(/^---$/gm, '<hr>');
            
            // Render blockquotes
            html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
            
            // Render markdown links [text](url)
            // Handle command: links specially - convert to clickable buttons
            html = html.replace(/\\[([^\\]]+)\\]\\(command:([^)]+)\\)/g, function(match, text, command) {
                // Decode the command URL and extract the file URI
                try {
                    const decoded = decodeURIComponent(command);
                    // Extract the command name and args
                    const parts = decoded.split('?');
                    const cmdName = parts[0];
                    const args = parts[1] ? JSON.parse(parts[1]) : [];
                    // Store as data attributes for click handler
                    return '<button class="doc-link-btn" data-command="' + cmdName + '" data-args="' + encodeURIComponent(JSON.stringify(args)) + '">' + text + '</button>';
                } catch (e) {
                    return '<button class="doc-link-btn" data-command="' + command + '">' + text + '</button>';
                }
            });
            
            // Render regular markdown links
            html = html.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" class="external-link">$1</a>');
            
            // Preserve line breaks
            html = html.replace(/\\n/g, '<br>');
            
            // Restore code blocks
            for (let i = 0; i < codeBlocks.length; i++) {
                html = html.replace('___CODEBLOCK_' + i + '___', codeBlocks[i]);
            }
            
            // Restore inline codes and add file link detection
            for (let i = 0; i < inlineCodes.length; i++) {
                let code = inlineCodes[i];
                // Check if it's a file path
                const pathMatch = code.match(/<code class="inline-code">([^<]+)<\\/code>/);
                if (pathMatch) {
                    const filePath = pathMatch[1];
                    // Check for file extensions (relative or absolute paths)
                    // Match both: myfile.md and C:\\Users\\path\\myfile.md and /tmp/myfile.md
                    const hasFileExt = /\\.(java|py|js|ts|c|cpp|go|rs|rb|cs|kt|swift|php|sql|md|txt|json|xml|html|yaml|yml|tal|cbl|cobol)$/i.test(filePath);
                    // Also check if it looks like a full path (starts with / or drive letter)
                    const isFullPath = /^([A-Za-z]:|[\\/])/.test(filePath);
                    
                    if (hasFileExt) {
                        code = '<code class="inline-code file-link" data-path="' + filePath + '" title="Click to open in VS Code">📄 ' + filePath + '</code>';
                    }
                }
                html = html.replace('___INLINECODE_' + i + '___', code);
            }
            
            // Detect and convert "Keep Exploring" sections to clickable buttons
            // This runs AFTER all placeholders are restored so inline code renders properly
            // At this point: <br> for line breaks, <strong> for bold, <code> for inline code
            const exploreMatch = html.match(/🔍\\s*Keep Exploring|<strong>Keep Exploring:?<\\/strong>|<h[23]>\\s*Keep Exploring:?\\s*<\\/h[23]>/i);
            if (exploreMatch) {
                const exploreStart = html.indexOf(exploreMatch[0]);
                const beforeExplore = html.substring(0, exploreStart);
                const afterExplore = html.substring(exploreStart);
                
                let exploreHtml = '<div class="explore-section"><div class="explore-title">🔍 Keep Exploring</div>';
                let foundBullets = false;
                
                // Split by <br> and process each line
                const lines = afterExplore.split(/<br>/);
                for (let i = 0; i < lines.length && i < 10; i++) {
                    const line = lines[i];
                    const trimmed = line.trim();
                    
                    // Strip HTML to check content
                    const plainText = trimmed.replace(/<[^>]+>/g, '').trim();
                    
                    // Skip header lines - check plain text for "keep exploring" anywhere
                    if (plainText.toLowerCase().includes('keep exploring')) continue;
                    if (plainText.match(/^🔍/)) continue;
                    
                    // Skip empty or very short lines
                    if (plainText.length < 20) continue;
                    
                    // This looks like a topic line - has substantial text
                    // Remove leading bullet if present
                    let topicHtml = trimmed.replace(/^[-•]\\s*/, '');
                    
                    // Must have meaningful content (questions typically have ?)
                    const queryText = topicHtml.replace(/<[^>]+>/g, '').trim();
                    if (queryText.length < 15) continue;
                    
                    // Split on first colon to separate topic from description (if present)
                    let displayTopic = topicHtml;
                    let desc = '';
                    const colonMatch = queryText.match(/^([^:]+\\??):(.+)$/);
                    if (colonMatch && colonMatch[1].length > 10) {
                        // Find the colon in the HTML version
                        const htmlColonIdx = topicHtml.indexOf(':');
                        if (htmlColonIdx > 10) {
                            displayTopic = topicHtml.substring(0, htmlColonIdx);
                            desc = topicHtml.substring(htmlColonIdx + 1).trim();
                        }
                    }
                    
                    // Use just the topic part (before colon) for the query if it's a question
                    let queryForBtn = queryText;
                    if (colonMatch && colonMatch[1].includes('?')) {
                        queryForBtn = colonMatch[1].trim();
                    }
                    
                    exploreHtml += '<button class="explore-btn" data-query="' + queryForBtn.replace(/"/g, '&quot;').substring(0, 200) + '">';
                    exploreHtml += '<div class="explore-topic">' + displayTopic + '</div>';
                    if (desc && desc.length > 5) {
                        // Clean up description
                        const cleanDesc = desc.replace(/<[^>]+>/g, '').substring(0, 150);
                        exploreHtml += '<div class="explore-desc">' + cleanDesc + '</div>';
                    }
                    exploreHtml += '</button>';
                    foundBullets = true;
                }
                
                exploreHtml += '</div>';
                
                if (foundBullets) {
                    html = beforeExplore + exploreHtml;
                }
            }
            
            return html;
        }
        
        function escapeHtml(text) {
            // Now use the markdown renderer instead
            return renderMarkdown(text);
        }
        
        // Add click handler for file links
        document.addEventListener('click', function(e) {
            if (e.target.classList.contains('file-link')) {
                const filePath = e.target.dataset.path || e.target.textContent;
                if (filePath) {
                    vscode.postMessage({ type: 'openFile', filePath: filePath });
                }
            }
            // Handle doc-link-btn clicks (command links from markdown)
            if (e.target.classList.contains('doc-link-btn')) {
                const command = e.target.dataset.command;
                let args = [];
                try {
                    args = JSON.parse(decodeURIComponent(e.target.dataset.args || '[]'));
                } catch (err) {
                    console.log('Could not parse args:', err);
                }
                if (command) {
                    // For vscode.open command, extract the URI
                    if (command === 'vscode.open' && args.length > 0) {
                        vscode.postMessage({ type: 'openFileUri', fileUri: args[0] });
                    } else {
                        vscode.postMessage({ type: 'executeCommand', command: command, args: args });
                    }
                }
            }
            // Handle explore button clicks - submit the query directly
            if (e.target.classList.contains('explore-btn') || e.target.closest('.explore-btn')) {
                e.preventDefault();
                e.stopPropagation();
                const btn = e.target.classList.contains('explore-btn') ? e.target : e.target.closest('.explore-btn');
                const query = btn.dataset.query;
                console.log('[AstraCode] Explore button clicked, query:', query);
                if (query) {
                    // Send the message - type must be 'chat' to match extension handler
                    vscode.postMessage({ type: 'chat', text: query });
                }
                return; // Don't process other click handlers
            }
            // Handle code block clicks (copy to clipboard)
            if (e.target.closest('.code-block')) {
                const code = e.target.closest('.code-block').textContent;
                navigator.clipboard.writeText(code).then(function() {
                    // Show brief "copied" feedback
                    const block = e.target.closest('.code-block');
                    block.classList.add('copied');
                    setTimeout(function() { block.classList.remove('copied'); }, 1000);
                });
            }
        });
        
        // Set initial active mode
        document.querySelector('.mode-btn[data-mode="auto"]').classList.add('active');
    </script>
</body>
</html>`;
}

module.exports = { getWebviewContent };
