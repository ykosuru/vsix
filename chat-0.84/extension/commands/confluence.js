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
                    reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 500)}`));
                }
            });
        });
        
        req.on('error', reject);
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
    if (!input.includes('http')) {
        return null;
    }
    
    // Pattern: /pages/123456789/
    const pagesMatch = input.match(/\/pages\/(\d+)/);
    if (pagesMatch) return pagesMatch[1];
    
    // Pattern: pageId=123456789
    const pageIdMatch = input.match(/pageId=(\d+)/);
    if (pageIdMatch) return pageIdMatch[1];
    
    return null;
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
async function findPage(credentials, settings, input) {
    const trimmed = input.trim();
    
    // Check if URL
    const urlPageId = extractPageIdFromUrl(trimmed);
    if (urlPageId) {
        const url = buildApiUrl(credentials, `/content/${urlPageId}?expand=body.storage,version`);
        return await makeRequest(url, 'GET', credentials);
    }
    
    // Check if numeric ID
    if (/^\d+$/.test(trimmed)) {
        const url = buildApiUrl(credentials, `/content/${trimmed}?expand=body.storage,version`);
        return await makeRequest(url, 'GET', credentials);
    }
    
    // Search by title
    const url = buildApiUrl(credentials, `/content?title=${encodeURIComponent(trimmed)}&spaceKey=${settings.spaceKey}&expand=body.storage,version`);
    const result = await makeRequest(url, 'GET', credentials);
    
    if (result.results && result.results.length > 0) {
        return result.results[0];
    }
    
    throw new Error(`Page not found: "${trimmed}"`);
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
    
    // Get credentials
    let credentials = null;
    if (confluenceAuth) {
        credentials = await confluenceAuth.getCredentials();
    }
    
    if (!credentials) {
        showConfigHelp(response, !!settings.clientId);
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
    
    // Parse page list
    const pageNames = query.split(/[,\n]/).map(p => p.trim()).filter(p => p);
    
    response.markdown(`📖 **Reading ${pageNames.length} page(s) from Confluence...**\n\n`);
    
    let allContent = '';
    let allMarkdown = '';  // For piping to next command
    let successCount = 0;
    
    for (const pageName of pageNames) {
        try {
            response.progress(`Reading: ${pageName}...`);
            
            const page = await findPage(credentials, settings, pageName);
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
}

/**
 * /conf.w - Write to Confluence
 */
async function handleWrite(ctx) {
    const { query, response, outputChannel, chatContext, confluenceAuth } = ctx;
    const settings = getConfluenceSettings();
    
    // Get credentials
    let credentials = null;
    if (confluenceAuth) {
        credentials = await confluenceAuth.getCredentials();
    }
    
    if (!credentials) {
        showConfigHelp(response, !!settings.clientId);
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
