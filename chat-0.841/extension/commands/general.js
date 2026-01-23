/**
 * General query handler - searches workspace and includes context
 * Supports follow-up questions using chat history
 */

const { streamResponse } = require('../llm/copilot');
const { getWorkspaceContext } = require('../llm/workspace-search');

const systemPrompt = `You are an expert code analyst. Analyze the provided source code to answer the user's question.
Reference specific files, functions, and line numbers from the code shown.
Be thorough but concise. Base your answer ONLY on the code provided below.

If there's previous conversation context, use it to understand follow-up questions.`;

/**
 * Extract previous conversation from chat history
 */
function getPreviousConversation(chatContext, maxTurns = 3) {
    let conversation = '';
    
    if (!chatContext?.history?.length) {
        return '';
    }
    
    // Get last N turns
    const recentHistory = chatContext.history.slice(-maxTurns);
    
    for (const turn of recentHistory) {
        // Get user message
        if (turn.participant === 'astra' || turn.command) {
            const userQuery = turn.prompt || turn.command || '';
            if (userQuery) {
                conversation += `**User:** ${userQuery}\n\n`;
            }
        }
        
        // Get assistant response
        if (turn.response?.length > 0) {
            let responseText = '';
            for (const part of turn.response) {
                if (part.value && typeof part.value === 'string') {
                    responseText += part.value;
                } else if (part.value?.value) {
                    responseText += part.value.value;
                }
            }
            if (responseText) {
                // Truncate long responses
                const truncated = responseText.length > 2000 
                    ? responseText.slice(0, 2000) + '\n... [truncated]' 
                    : responseText;
                conversation += `**Assistant:** ${truncated}\n\n`;
            }
        }
    }
    
    return conversation;
}

/**
 * Detect if this is a follow-up question
 */
function isFollowUp(query) {
    const followUpPatterns = [
        /^(what|how|why|can you|could you|please|also|and|but)\s/i,
        /^(explain|tell me|show me|give me)\s(more|that|this|it)/i,
        /\b(that|this|it|those|these|the same|above|previous)\b/i,
        /^(yes|no|ok|sure|thanks|thank you)/i,
        /\?$/,  // Questions
        /^(more|again|another|different)/i
    ];
    
    return followUpPatterns.some(p => p.test(query.trim()));
}

async function handle(ctx) {
    const { query, response, outputChannel, token, chatContext } = ctx;
    
    if (!query.trim()) {
        response.markdown(`**Ask me about your code!**

**Examples:**
- \`@astra how does authentication work?\`
- \`@astra explain partition pruning\`
- \`@astra /describe UserService\`

**Follow-up questions work too:**
- \`@astra\` "how does login work?"
- \`@astra\` "what about the logout flow?"
- \`@astra\` "show me the error handling"`);
        
        // Add configure sources button
        response.button({
            command: 'astracode.configureSources',
            title: '⚙️ Configure Input Sources'
        });
        return;
    }
    
    // Check for previous conversation
    const previousConversation = getPreviousConversation(chatContext);
    const hasHistory = previousConversation.length > 100;
    const seemsLikeFollowUp = isFollowUp(query);
    
    // Search workspace for relevant files
    response.progress('Searching workspace...');
    const { context, files, totalLines } = await getWorkspaceContext(query);
    
    // If no files found but we have history, still try to answer
    if ((!context || files.length === 0) && !hasHistory) {
        response.markdown(`⚠️ **No matching files found for:** "${query}"

**Try:**
- More specific terms (e.g., function names, file names)
- \`@astra /find <term>\` to search for specific code`);
        return;
    }
    
    // Show context being used
    if (files && files.length > 0) {
        let filesUsed = `📄 **Found ${files.length} files** (${totalLines.toLocaleString()} lines)\n\n`;
        filesUsed += `<details><summary>📂 Files analyzed</summary>\n\n`;
        for (const f of files.slice(0, 25)) {
            filesUsed += `- \`${f.path}\`\n`;
        }
        if (files.length > 25) {
            filesUsed += `- *...and ${files.length - 25} more*\n`;
        }
        filesUsed += `\n</details>\n\n`;
        response.markdown(filesUsed);
    } else if (hasHistory) {
        response.markdown(`💬 *Using previous conversation context...*\n\n`);
    }
    
    // Build prompt with conversation history
    let userPrompt = '';
    
    if (hasHistory && seemsLikeFollowUp) {
        userPrompt = `## Previous Conversation
${previousConversation}

## Follow-up Question
${query}

`;
    } else {
        userPrompt = `## Question
${query}

`;
    }
    
    if (context) {
        userPrompt += `## Source Code Context
${context}

`;
    }
    
    userPrompt += `Based on ${context ? 'the code above' : 'the previous conversation'}, please answer the question.${context ? ' Reference specific files and line numbers.' : ''}`;

    await streamResponse(systemPrompt, userPrompt, response, outputChannel, token);
}

module.exports = { handle };
