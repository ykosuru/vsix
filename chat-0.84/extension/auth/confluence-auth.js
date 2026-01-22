/**
 * Confluence OAuth 2.0 Authentication
 * 
 * Supports:
 * 1. OAuth 2.0 (3LO) - Enterprise SSO via Atlassian
 * 2. API Token - Simple auth for personal use
 * 
 * For OAuth setup:
 * 1. Register app at https://developer.atlassian.com/console/myapps/
 * 2. Add OAuth 2.0 with callback: vscode://astracode.astracode/auth/callback
 * 3. Set astracode.confluence.clientId in VS Code settings
 */

const vscode = require('vscode');
const https = require('https');

const SCOPES = [
    'read:confluence-content.all',
    'write:confluence-content',
    'read:confluence-space.summary',
    'offline_access'
].join(' ');

/**
 * Get stored OAuth tokens from VS Code secret storage
 */
async function getStoredTokens(secrets) {
    try {
        const json = await secrets.get('astracode.confluence.oauth');
        return json ? JSON.parse(json) : null;
    } catch {
        return null;
    }
}

/**
 * Store OAuth tokens securely
 */
async function storeTokens(secrets, tokens) {
    tokens.storedAt = Date.now();
    await secrets.store('astracode.confluence.oauth', JSON.stringify(tokens));
}

/**
 * Clear stored tokens (sign out)
 */
async function clearTokens(secrets) {
    await secrets.delete('astracode.confluence.oauth');
}

/**
 * Exchange authorization code for tokens
 */
function exchangeCodeForTokens(code, clientId, redirectUri) {
    return new Promise((resolve, reject) => {
        const body = new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: clientId,
            code: code,
            redirect_uri: redirectUri
        }).toString();

        const req = https.request({
            hostname: 'auth.atlassian.com',
            path: '/oauth/token',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': body.length
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    resolve(JSON.parse(data));
                } else {
                    reject(new Error(`Token exchange failed: ${data}`));
                }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

/**
 * Refresh access token
 */
function refreshAccessToken(refreshToken, clientId) {
    return new Promise((resolve, reject) => {
        const body = new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: clientId,
            refresh_token: refreshToken
        }).toString();

        const req = https.request({
            hostname: 'auth.atlassian.com',
            path: '/oauth/token',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': body.length
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    const tokens = JSON.parse(data);
                    tokens.refresh_token = tokens.refresh_token || refreshToken;
                    resolve(tokens);
                } else {
                    reject(new Error(`Refresh failed: ${data}`));
                }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

/**
 * Get accessible Confluence cloud sites
 */
function getAccessibleSites(accessToken) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'api.atlassian.com',
            path: '/oauth/token/accessible-resources',
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Accept': 'application/json'
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    resolve(JSON.parse(data));
                } else {
                    reject(new Error(`Failed to get sites: ${data}`));
                }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

/**
 * Main auth class
 */
class ConfluenceAuth {
    constructor(context) {
        this.context = context;
        this.secrets = context.secrets;
        this._pendingAuth = null;
    }

    /**
     * Get valid credentials (OAuth token or API token)
     */
    async getCredentials() {
        const config = vscode.workspace.getConfiguration('astracode.confluence');
        
        // Check for API token (simple auth)
        const apiToken = config.get('apiToken');
        const username = config.get('username');
        const baseUrl = config.get('baseUrl');
        
        if (apiToken && username && baseUrl) {
            return {
                type: 'basic',
                username,
                token: apiToken,
                baseUrl
            };
        }

        // Check for OAuth
        const clientId = config.get('clientId');
        if (!clientId) {
            return null;
        }

        const tokens = await getStoredTokens(this.secrets);
        if (!tokens) {
            return null;
        }

        // Check if expired (with 5 min buffer)
        const expiresIn = tokens.expires_in || 3600;
        const storedAt = tokens.storedAt || 0;
        const expiresAt = storedAt + (expiresIn * 1000);
        
        if (Date.now() > expiresAt - 300000) {
            // Try refresh
            if (tokens.refresh_token) {
                try {
                    const newTokens = await refreshAccessToken(tokens.refresh_token, clientId);
                    newTokens.cloudId = tokens.cloudId;
                    newTokens.baseUrl = tokens.baseUrl;
                    newTokens.siteName = tokens.siteName;
                    await storeTokens(this.secrets, newTokens);
                    return {
                        type: 'oauth',
                        token: newTokens.access_token,
                        cloudId: tokens.cloudId,
                        baseUrl: tokens.baseUrl
                    };
                } catch (e) {
                    await clearTokens(this.secrets);
                    return null;
                }
            }
            return null;
        }

        return {
            type: 'oauth',
            token: tokens.access_token,
            cloudId: tokens.cloudId,
            baseUrl: tokens.baseUrl
        };
    }

    /**
     * Check if authenticated
     */
    async isAuthenticated() {
        return (await this.getCredentials()) !== null;
    }

    /**
     * Start OAuth sign-in flow
     */
    async signIn() {
        const config = vscode.workspace.getConfiguration('astracode.confluence');
        const clientId = config.get('clientId');
        
        if (!clientId) {
            const choice = await vscode.window.showQuickPick(
                ['Configure OAuth (recommended for enterprise)', 'Use API Token (simple)'],
                { placeHolder: 'How do you want to authenticate?' }
            );
            
            if (choice?.includes('API Token')) {
                await vscode.commands.executeCommand(
                    'workbench.action.openSettings', 
                    'astracode.confluence'
                );
                throw new Error('Configure API token in settings, then try again');
            }
            
            throw new Error(
                'Set astracode.confluence.clientId for OAuth.\n' +
                'Register app at: https://developer.atlassian.com/console/myapps/'
            );
        }

        // Generate state
        const state = Math.random().toString(36).substring(2, 15);
        
        // Callback URI
        const callbackUri = await vscode.env.asExternalUri(
            vscode.Uri.parse(`${vscode.env.uriScheme}://astracode.astracode/auth/callback`)
        );

        // Build auth URL
        const authUrl = new URL('https://auth.atlassian.com/authorize');
        authUrl.searchParams.set('audience', 'api.atlassian.com');
        authUrl.searchParams.set('client_id', clientId);
        authUrl.searchParams.set('scope', SCOPES);
        authUrl.searchParams.set('redirect_uri', callbackUri.toString());
        authUrl.searchParams.set('state', state);
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('prompt', 'consent');

        // Store state
        await this.context.globalState.update('confluence.oauth.state', state);
        await this.context.globalState.update('confluence.oauth.redirectUri', callbackUri.toString());

        // Open browser
        vscode.window.showInformationMessage('Opening browser for Confluence sign-in...');
        await vscode.env.openExternal(vscode.Uri.parse(authUrl.toString()));

        // Return promise that resolves when callback received
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this._pendingAuth = null;
                reject(new Error('Authentication timed out (2 minutes)'));
            }, 120000);

            this._pendingAuth = { resolve, reject, timeout, state };
        });
    }

    /**
     * Handle OAuth callback
     */
    async handleCallback(uri) {
        if (!this._pendingAuth) {
            vscode.window.showErrorMessage('No pending authentication');
            return;
        }

        const { resolve, reject, timeout, state: expectedState } = this._pendingAuth;
        clearTimeout(timeout);
        this._pendingAuth = null;

        try {
            const query = new URLSearchParams(uri.query);
            const code = query.get('code');
            const state = query.get('state');
            const error = query.get('error');

            if (error) {
                throw new Error(`OAuth error: ${error}`);
            }

            if (state !== expectedState) {
                throw new Error('State mismatch - please try again');
            }

            if (!code) {
                throw new Error('No authorization code received');
            }

            // Exchange code for tokens
            const config = vscode.workspace.getConfiguration('astracode.confluence');
            const clientId = config.get('clientId');
            const redirectUri = this.context.globalState.get('confluence.oauth.redirectUri');

            const tokens = await exchangeCodeForTokens(code, clientId, redirectUri);

            // Get accessible sites
            const sites = await getAccessibleSites(tokens.access_token);
            
            if (sites.length === 0) {
                throw new Error('No accessible Confluence sites found for this account');
            }

            // Let user pick site if multiple
            let site = sites[0];
            if (sites.length > 1) {
                const picked = await vscode.window.showQuickPick(
                    sites.map(s => ({ label: s.name, detail: s.url, site: s })),
                    { placeHolder: 'Select Confluence site' }
                );
                if (!picked) {
                    throw new Error('No site selected');
                }
                site = picked.site;
            }

            // Store tokens with site info
            tokens.cloudId = site.id;
            tokens.baseUrl = site.url;
            tokens.siteName = site.name;
            await storeTokens(this.secrets, tokens);

            vscode.window.showInformationMessage(`✅ Signed in to Confluence: ${site.name}`);
            resolve(tokens);

        } catch (e) {
            vscode.window.showErrorMessage(`Confluence auth failed: ${e.message}`);
            reject(e);
        }
    }

    /**
     * Sign out
     */
    async signOut() {
        await clearTokens(this.secrets);
        vscode.window.showInformationMessage('Signed out of Confluence');
    }
}

module.exports = { ConfluenceAuth, getStoredTokens, storeTokens, clearTokens };
