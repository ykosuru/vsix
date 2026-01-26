/**
 * /clear command - Guide user to clear context
 */

async function handle(ctx) {
    const { response, request } = ctx;
    
    const attachmentCount = request?.references?.length || 0;
    
    response.markdown(`## 🧹 Clear Context

${attachmentCount > 0 ? `⚠️ **${attachmentCount} attachment(s) still in session**` : '✅ No attachments detected'}

### To Clear Attachments

Press **Cmd+L** (Mac) or **Ctrl+L** (Windows) to start a new chat.

This is the only reliable way to clear attachments - the X button hides them but they persist in the session.
`);
}

module.exports = { handle };
