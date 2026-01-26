/**
 * Confluence commands - Read and write pages
 * 
 * /conf.r <page1>, <page2>, ...  - Read one or more pages (title, ID, or URL)
 * /conf.w <title>                - Write/publish to Confluence
 * 
 * Authentication:
 * - OAuth 2.0 (enterprise) - Set clientId, use sign-in command
 * - API Token (simple) - Set username, apiToken, baseUrl
 */

const vscode = require('vscode');
const https = require('https');
const http = require('http');

function getConfluenceSettings() {
    const config = vscode.workspace.getConfiguration('astracode.confluence');
    return {
        baseUrl: config.get('baseUrl') || '',
        spaceKey: config.get('spaceKey') || '',
        parentPageId: config.get('parentPageId') || '',
        username: config.get('username') || '',
        apiToken: config.get('apiToken') || '',
        clientId: config.get('clientId') || ''
    };
}

/**
 * Make HTTP request to Confluence API
 */
function makeRequest(url, method, credentials, body = null) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        };
        
        // Set auth header based on credential type
        if (credentials.type === 'oauth') {
            headers['Authorization'] = `Bearer ${credentials.token}`;
        } else if (credentials.type === 'basic') {
            const auth = Buffer.from(`${credentials.username}:${credentials.token}`).toString('base64');
            headers['Authorization'] = `Basic ${auth}`;
        }
        
        const options = {
            hostname: urlObj.hostname,
            port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            method: method,
            headers
        };
        
        const client = urlObj.protocol === 'https:' ? https : http;
        
        const req = client.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(JSON.parse(data));
                    } catch {
                        resolve(data);
                    }
                } else {
                    // Parse error message from response
                    let errorMsg = `HTTP ${res.statusCode}`;
                    try {
                        const errorData = JSON.parse(data);
                        if (errorData.message) {
                            errorMsg = errorData.message;
                        } else if (errorData.errorMessage) {
                            errorMsg = errorData.errorMessage;
                        }
                    } catch {
                        // Use raw data if not JSON
                        if (data.length < 200) {
                            errorMsg += `: ${data}`;
                        }
                    }
                    
                    // Add helpful hints based on status code
                    switch (res.statusCode) {
                        case 401:
                            errorMsg = `Authentication failed (401). Check your API token or sign in again.`;
                            break;
                        case 403:
                            errorMsg = `Access denied (403). You may not have permission to access this page.`;
                            break;
                        case 404:
                            errorMsg = `Page not found (404). Check the page ID or title.`;
                            break;
                        case 429:
                            errorMsg = `Rate limited (429). Wait a moment and try again.`;
                            break;
                    }
                    
                    reject(new Error(errorMsg));
                }
            });
        });
        
        req.on('error', (e) => {
            if (e.code === 'ENOTFOUND') {
                reject(new Error(`Cannot connect to Confluence. Check your Base URL setting.`));
            } else if (e.code === 'ECONNREFUSED') {
                reject(new Error(`Connection refused. Is the Confluence URL correct?`));
            } else {
                reject(new Error(`Network error: ${e.message}`));
            }
        });
        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

/**
 * Build API URL based on auth type
 */
function buildApiUrl(credentials, path) {
    if (credentials.type === 'oauth' && credentials.cloudId) {
        // Atlassian Cloud API
        return `https://api.atlassian.com/ex/confluence/${credentials.cloudId}${path}`;
    }
    // Traditional REST API
    return `${credentials.baseUrl}/rest/api${path}`;
}

/**
 * Extract page ID from Confluence URL
 */
function extractPageIdFromUrl(input) {
    // Remove angle brackets if present (e.g., <https://...>)
    let url = input.trim().replace(/^<|>$/g, '');
    
    if (!url.includes('http')) {
        return null;
    }
    
    // Pattern: /pages/123456789/ or /pages/123456789/Page+Title
    const pagesMatch = url.match(/\/pages\/(\d+)/);
    if (pagesMatch) return pagesMatch[1];
    
    // Pattern: pageId=123456789
    const pageIdMatch = url.match(/pageId=(\d+)/);
    if (pageIdMatch) return pageIdMatch[1];
    
    // Pattern: /wiki/spaces/SPACE/pages/edit-v2/123456789
    const editMatch = url.match(/\/edit-v2\/(\d+)/);
    if (editMatch) return editMatch[1];
    
    // Pattern: /wiki/x/ABCDEF (tiny URL - can't extract ID directly)
    // For these we'd need to follow redirect, so skip for now
    
    return null;
}

/**
 * Extract base URL from a full Confluence URL
 */
function extractBaseUrlFromUrl(input) {
    // Remove angle brackets
    let url = input.trim().replace(/^<|>$/g, '');
    
    // Match https://company.atlassian.net/wiki
    const match = url.match(/(https?:\/\/[^\/]+\/wiki)/);
    return match ? match[1] : null;
}

/**
 * Convert Confluence storage format to markdown
 */
function confluenceToMarkdown(html) {
    let content = html;
    
    // Remove style/script
    content = content.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    content = content.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    
    // Headers
    content = content.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n');
    content = content.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n');
    content = content.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n');
    content = content.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n');
    
    // Code blocks
    content = content.replace(/<ac:structured-macro[^>]*ac:name="code"[^>]*>[\s\S]*?<ac:plain-text-body><!\[CDATA\[([\s\S]*?)\]\]><\/ac:plain-text-body>[\s\S]*?<\/ac:structured-macro>/gi, '\n```\n$1\n```\n');
    
    // Text formatting
    content = content.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**');
    content = content.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**');
    content = content.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*');
    content = content.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
    
    // Lists
    content = content.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');
    content = content.replace(/<\/?[uo]l[^>]*>/gi, '\n');
    
    // Tables
    content = content.replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, '|$1|\n');
    content = content.replace(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi, ' $1 |');
    content = content.replace(/<\/?table[^>]*>/gi, '\n');
    content = content.replace(/<\/?tbody[^>]*>/gi, '');
    
    // Links
    content = content.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
    
    // Line breaks
    content = content.replace(/<br\s*\/?>/gi, '\n');
    content = content.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n');
    content = content.replace(/<div[^>]*>([\s\S]*?)<\/div>/gi, '$1\n');
    
    // Remove remaining tags
    content = content.replace(/<[^>]+>/g, '');
    
    // Decode entities
    content = content.replace(/&nbsp;/g, ' ');
    content = content.replace(/&amp;/g, '&');
    content = content.replace(/&lt;/g, '<');
    content = content.replace(/&gt;/g, '>');
    
    // Clean whitespace
    content = content.replace(/\n{3,}/g, '\n\n');
    
    return content.trim();
}

/**
 * Convert markdown to Confluence storage format
 */
function markdownToConfluence(markdown) {
    let content = markdown;
    
    // Headers
    content = content.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    content = content.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    content = content.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    
    // Bold/italic
    content = content.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    content = content.replace(/\*(.+?)\*/g, '<em>$1</em>');
    
    // Code blocks
    content = content.replace(/```(\w+)?\n([\s\S]+?)```/g, (_, lang, code) => {
        const language = lang || 'text';
        return `<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">${language}</ac:parameter><ac:plain-text-body><![CDATA[${code.trim()}]]></ac:plain-text-body></ac:structured-macro>`;
    });
    
    // Inline code
    content = content.replace(/`([^`]+)`/g, '<code>$1</code>');
    
    // Lists
    content = content.replace(/^[\*\-] (.+)$/gm, '<li>$1</li>');
    content = content.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
    
    // Tables
    content = content.replace(/\|(.+)\|/g, (_, row) => {
        const cells = row.split('|').map(c => c.trim()).filter(c => c && !c.match(/^[-:]+$/));
        if (!cells.length) return '';
        return `<tr>${cells.map(c => `<td>${c}</td>`).join('')}</tr>`;
    });
    content = content.replace(/(<tr>.*<\/tr>\n?)+/g, '<table><tbody>$&</tbody></table>');
    
    // Paragraphs
    content = content.replace(/\n\n/g, '</p><p>');
    content = `<p>${content}</p>`;
    
    // Clean up
    content = content.replace(/<p><\/p>/g, '');
    content = content.replace(/<p>(<h[1-6]>)/g, '$1');
    content = content.replace(/(<\/h[1-6]>)<\/p>/g, '$1');
    content = content.replace(/<p>(<ul>)/g, '$1');
    content = content.replace(/(<\/ul>)<\/p>/g, '$1');
    content = content.replace(/<p>(<table>)/g, '$1');
    content = content.replace(/(<\/table>)<\/p>/g, '$1');
    content = content.replace(/<p>(<ac:structured-macro)/g, '$1');
    content = content.replace(/(<\/ac:structured-macro>)<\/p>/g, '$1');
    
    return content;
}

/**
 * Find page by title, ID, or URL
 */
async function findPage(credentials, settings, input, outputChannel) {
    const trimmed = input.trim().replace(/^<|>$/g, ''); // Remove angle brackets
    
    // Check if URL - also extract base URL from it
    const urlPageId = extractPageIdFromUrl(trimmed);
    if (urlPageId) {
        outputChannel?.appendLine(`[AstraCode] Finding page by URL, extracted ID: ${urlPageId}`);
        
        // Try to use base URL from the provided URL
        const urlBase = extractBaseUrlFromUrl(trimmed);
        let useCredentials = credentials;
        if (urlBase && credentials.type === 'token') {
            // Override base URL from the provided URL
            useCredentials = { ...credentials, baseUrl: urlBase };
            outputChannel?.appendLine(`[AstraCode] Using base URL from provided URL: ${urlBase}`);
        }
        
        const url = buildApiUrl(useCredentials, `/content/${urlPageId}?expand=body.storage,version`);
        outputChannel?.appendLine(`[AstraCode] API URL: ${url}`);
        return await makeRequest(url, 'GET', useCredentials);
    }
    
    // Check if numeric ID
    if (/^\d+$/.test(trimmed)) {
        outputChannel?.appendLine(`[AstraCode] Finding page by ID: ${trimmed}`);
        const url = buildApiUrl(credentials, `/content/${trimmed}?expand=body.storage,version`);
        return await makeRequest(url, 'GET', credentials);
    }
    
    // Search by title
    outputChannel?.appendLine(`[AstraCode] Searching for page by title: "${trimmed}"`);
    const url = buildApiUrl(credentials, `/content?title=${encodeURIComponent(trimmed)}&spaceKey=${settings.spaceKey}&expand=body.storage,version`);
    outputChannel?.appendLine(`[AstraCode] Search URL: ${url}`);
    const result = await makeRequest(url, 'GET', credentials);
    
    if (result.results && result.results.length > 0) {
        outputChannel?.appendLine(`[AstraCode] Found page: ${result.results[0].title}`);
        return result.results[0];
    }
    
    throw new Error(`Page not found: "${trimmed}" in space "${settings.spaceKey}"`);
}

/**
 * Save page (create or update)
 */
async function savePage(credentials, settings, title, content, existingPage = null) {
    if (existingPage) {
        const url = buildApiUrl(credentials, `/content/${existingPage.id}`);
        const body = {
            type: 'page',
            title,
            version: { number: existingPage.version.number + 1 },
            body: { storage: { value: content, representation: 'storage' } }
        };
        return await makeRequest(url, 'PUT', credentials, body);
    } else {
        const url = buildApiUrl(credentials, '/content');
        const body = {
            type: 'page',
            title,
            space: { key: settings.spaceKey },
            body: { storage: { value: content, representation: 'storage' } }
        };
        if (settings.parentPageId) {
            body.ancestors = [{ id: settings.parentPageId }];
        }
        return await makeRequest(url, 'POST', credentials, body);
    }
}

/**
 * Show configuration help
 */
function showConfigHelp(response, hasClientId) {
    response.markdown(`## 📚 Confluence Configuration Required

${hasClientId ? '**OAuth configured but not signed in.**\n\nRun: `Confluence: Sign In` from command palette (Cmd+Shift+P)' : `
**Option 1: OAuth (Recommended for Enterprise)**
1. Register app at https://developer.atlassian.com/console/myapps/
2. Add OAuth 2.0, set callback: \`vscode://astracode.astracode/auth/callback\`
3. Add to settings:
\`\`\`json
{
  "astracode.confluence.clientId": "your-client-id"
}
\`\`\`
4. Run \`Confluence: Sign In\` from command palette

**Option 2: API Token (Simple)**
\`\`\`json
{
  "astracode.confluence.baseUrl": "https://company.atlassian.net/wiki",
  "astracode.confluence.spaceKey": "DEV",
  "astracode.confluence.username": "your.email@company.com",
  "astracode.confluence.apiToken": "your-api-token"
}
\`\`\`
Get token: https://id.atlassian.com/manage-profile/security/api-tokens
`}

**Commands:**
| Command | Description |
|---------|-------------|
| \`/conf.r Page Title\` | Read a page |
| \`/conf.r Page1, Page2\` | Read multiple pages |
| \`/conf.r https://...\` | Read page by URL |
| \`/conf.w My Title\` | Publish to Confluence |
`);
}

/**
 * /conf.r - Read pages from Confluence
 */
async function handleRead(ctx) {
    const { query, response, outputChannel, confluenceAuth } = ctx;
    const settings = getConfluenceSettings();
    
    // Debug logging
    outputChannel?.appendLine(`[AstraCode] /conf.r: Checking credentials...`);
    outputChannel?.appendLine(`[AstraCode] Settings: baseUrl="${settings.baseUrl}", username="${settings.username}", apiToken=${settings.apiToken ? 'set' : 'empty'}, clientId=${settings.clientId ? 'set' : 'empty'}`);
    
    // Get credentials
    let credentials = null;
    let credentialError = null;
    
    if (confluenceAuth) {
        try {
            credentials = await confluenceAuth.getCredentials();
            outputChannel?.appendLine(`[AstraCode] Credentials result: ${credentials ? credentials.type : 'null'}`);
        } catch (e) {
            credentialError = e.message;
            outputChannel?.appendLine(`[AstraCode] Credential error: ${e.message}`);
        }
    } else {
        outputChannel?.appendLine(`[AstraCode] confluenceAuth is null/undefined`);
    }
    
    // Check what's missing and show specific error
    if (!credentials) {
        const hasOAuth = !!settings.clientId;
        const hasToken = !!(settings.apiToken && settings.username && settings.baseUrl);
        
        if (hasOAuth && !credentials) {
            // OAuth configured but not signed in
            response.markdown(`## ❌ Confluence: Not Signed In

**OAuth is configured but you need to sign in.**

1. Press \`Cmd+Shift+P\` (Mac) or \`Ctrl+Shift+P\` (Windows)
2. Type "Confluence: Sign In"
3. Complete authentication in browser

${credentialError ? `**Error:** ${credentialError}` : ''}
`);
            response.button({
                command: 'astracode.confluence.signIn',
                title: '🔑 Sign In to Confluence'
            });
        } else if (hasToken) {
            // Token configured but something wrong
            response.markdown(`## ❌ Confluence: Authentication Failed

**API Token credentials found but authentication failed.**

Check your settings:
- **Base URL:** \`${settings.baseUrl || '(not set)'}\`
- **Username:** \`${settings.username || '(not set)'}\`
- **API Token:** \`${settings.apiToken ? '••••••••' : '(not set)'}\`
- **Space Key:** \`${settings.spaceKey || '(not set)'}\`

${credentialError ? `**Error:** ${credentialError}` : ''}

**Get a new token:** https://id.atlassian.com/manage-profile/security/api-tokens
`);
        } else {
            // Nothing configured - show what we found
            response.markdown(`## ❌ Confluence: Not Configured

**No authentication configured.** Choose one option:

**Current settings detected:**
- Base URL: \`${settings.baseUrl || '(empty)'}\`
- Username: \`${settings.username || '(empty)'}\`
- API Token: \`${settings.apiToken ? '(set)' : '(empty)'}\`
- Space Key: \`${settings.spaceKey || '(empty)'}\`

${!settings.baseUrl || !settings.username || !settings.apiToken ? '⚠️ **One or more required fields are empty.**\n' : ''}

---

### Option 1: API Token (Recommended for personal use)

1. Open VS Code Settings (\`Cmd+,\`)
2. Search "astracode confluence"
3. Fill in:

| Setting | Value |
|---------|-------|
| Base Url | \`https://yourcompany.atlassian.net/wiki\` |
| Space Key | Your space key (e.g., \`DEV\`) |
| Username | Your email |
| Api Token | [Get token here](https://id.atlassian.com/manage-profile/security/api-tokens) |

---

### Option 2: OAuth (Enterprise SSO)

1. Register app at https://developer.atlassian.com/console/myapps/
2. Add OAuth 2.0, callback: \`vscode://astracode.astracode/auth/callback\`
3. Set \`astracode.confluence.clientId\` in settings
4. Run "Confluence: Sign In" from command palette
`);
        }
        return;
    }
    
    if (!query.trim()) {
        response.markdown(`**Usage:** \`@astra /conf.r <page title, ID, or URL>\`

**Examples:**
\`\`\`
@astra /conf.r Architecture Overview
@astra /conf.r Page One, Page Two, Page Three
@astra /conf.r 123456789
@astra /conf.r https://company.atlassian.net/wiki/spaces/DEV/pages/123456789
\`\`\`

**Pipe to other commands:**
\`\`\`
@astra /conf.r Design Spec /requirements
@astra /conf.r API Docs /requirements /fediso /gencode
\`\`\`
`);
        return;
    }
    
    // Debug: log the query
    outputChannel?.appendLine(`[AstraCode] /conf.r query: "${query}"`);
    
    // Parse page list - also handle angle brackets in URLs
    const pageNames = query.split(/[,\n]/).map(p => p.trim().replace(/^<|>$/g, '')).filter(p => p);
    
    outputChannel?.appendLine(`[AstraCode] /conf.r pages: ${JSON.stringify(pageNames)}`);
    
    response.markdown(`📖 **Reading ${pageNames.length} page(s) from Confluence...**\n\n`);
    
    let allContent = '';
    let allMarkdown = '';  // For piping to next command
    let successCount = 0;
    
    for (const pageName of pageNames) {
        try {
            response.progress(`Reading: ${pageName}...`);
            
            const page = await findPage(credentials, settings, pageName, outputChannel);
            const content = page.body?.storage?.value || '';
            const markdown = confluenceToMarkdown(content);
            
            let pageUrl;
            if (credentials.type === 'oauth') {
                pageUrl = `${credentials.baseUrl}/wiki/spaces/${settings.spaceKey}/pages/${page.id}`;
            } else {
                pageUrl = `${settings.baseUrl}/pages/viewpage.action?pageId=${page.id}`;
            }
            
            allContent += `\n---\n## 📄 ${page.title}\n\n`;
            allContent += `[Open in Confluence](${pageUrl})\n\n`;
            allContent += markdown + '\n';
            
            // Collect markdown for piping
            allMarkdown += `\n## ${page.title}\n\n${markdown}\n`;
            
            successCount++;
            
        } catch (error) {
            allContent += `\n---\n## ❌ ${pageName}\n\n`;
            allContent += `**Error:** ${error.message}\n`;
            outputChannel?.appendLine(`[AstraCode] Confluence error: ${error.message}`);
        }
    }
    
    response.markdown(allContent);
    response.markdown(`\n---\n✅ **Read ${successCount}/${pageNames.length} pages**`);
    
    // Set content for piping to next command
    ctx.pipedContent = allMarkdown;
    
    // Debug logging
    outputChannel?.appendLine(`[AstraCode] /conf.r: ${allMarkdown.length} chars for piping`);
}

/**
 * /conf.w - Write to Confluence
 */
async function handleWrite(ctx) {
    const { query, response, outputChannel, chatContext, confluenceAuth } = ctx;
    const settings = getConfluenceSettings();
    
    // Get credentials
    let credentials = null;
    let credentialError = null;
    
    if (confluenceAuth) {
        try {
            credentials = await confluenceAuth.getCredentials();
        } catch (e) {
            credentialError = e.message;
        }
    }
    
    // Check what's missing and show specific error
    if (!credentials) {
        const hasOAuth = !!settings.clientId;
        const hasToken = !!(settings.apiToken && settings.username && settings.baseUrl);
        
        if (hasOAuth && !credentials) {
            response.markdown(`## ❌ Confluence: Not Signed In

**OAuth is configured but you need to sign in.**

Press the button below or run "Confluence: Sign In" from command palette.

${credentialError ? `**Error:** ${credentialError}` : ''}
`);
            response.button({
                command: 'astracode.confluence.signIn',
                title: '🔑 Sign In to Confluence'
            });
        } else if (!hasToken) {
            response.markdown(`## ❌ Confluence: Not Configured

**Set up authentication in VS Code Settings (\`Cmd+,\`):**

| Setting | Value |
|---------|-------|
| \`astracode.confluence.baseUrl\` | \`https://yourcompany.atlassian.net/wiki\` |
| \`astracode.confluence.spaceKey\` | Your space key |
| \`astracode.confluence.username\` | Your email |
| \`astracode.confluence.apiToken\` | [Get token](https://id.atlassian.com/manage-profile/security/api-tokens) |
`);
        } else {
            response.markdown(`## ❌ Confluence: Authentication Failed

${credentialError ? `**Error:** ${credentialError}` : 'Check your credentials in settings.'}
`);
        }
        return;
    }
    
    // Check space key
    if (!settings.spaceKey) {
        response.markdown(`⚠️ **Space key required.** Set \`astracode.confluence.spaceKey\` in settings.`);
        return;
    }
    
    // Get content from previous response
    let contentToPublish = '';
    if (chatContext?.history?.length > 0) {
        for (let i = chatContext.history.length - 1; i >= 0; i--) {
            const turn = chatContext.history[i];
            if (turn.response?.length > 0) {
                for (const part of turn.response) {
                    if (part.value && typeof part.value === 'string') {
                        contentToPublish += part.value + '\n';
                    } else if (part.value?.value) {
                        contentToPublish += part.value.value + '\n';
                    }
                }
                if (contentToPublish.length > 100) break;
            }
        }
    }
    
    if (contentToPublish.length < 50) {
        response.markdown(`⚠️ **No content to publish.** Run a command first:
\`\`\`
@astra /deepwiki <topic>
@astra /conf.w My Page Title
\`\`\``);
        return;
    }
    
    const pageTitle = query.trim() || `AstraCode - ${new Date().toISOString().split('T')[0]}`;
    
    response.progress(`Publishing: ${pageTitle}...`);
    
    try {
        const confluenceContent = markdownToConfluence(contentToPublish);
        
        // Check if exists
        let existingPage = null;
        try {
            existingPage = await findPage(credentials, settings, pageTitle);
        } catch (e) {
            // Page doesn't exist
        }
        
        const result = await savePage(credentials, settings, pageTitle, confluenceContent, existingPage);
        const action = existingPage ? 'Updated' : 'Created';
        
        let pageUrl;
        if (credentials.type === 'oauth') {
            pageUrl = `${credentials.baseUrl}/wiki/spaces/${settings.spaceKey}/pages/${result.id}`;
        } else {
            pageUrl = `${settings.baseUrl}/pages/viewpage.action?pageId=${result.id}`;
        }
        
        response.markdown(`## ✅ ${action} Confluence Page

**Title:** ${pageTitle}
**Space:** ${settings.spaceKey}
**ID:** ${result.id}

[Open in Confluence →](${pageUrl})
`);
        
        outputChannel?.appendLine(`[AstraCode] ${action} page: ${pageUrl}`);
        
    } catch (error) {
        response.markdown(`## ❌ Publish Failed

**Error:** ${error.message}

**Troubleshooting:**
- Verify space key: \`${settings.spaceKey}\`
- Check write permissions
- Try signing out and back in
`);
        outputChannel?.appendLine(`[AstraCode] Publish error: ${error.message}`);
    }
}

module.exports = { handleRead, handleWrite };
