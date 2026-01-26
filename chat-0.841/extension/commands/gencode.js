/**
 * /gencode command - Generate Java code from requirements
 * 
 * Usage:
 * @astra /gencode /source llm pacs.008 service     - Pure LLM generation
 * @astra /gencode /source h pacs.008               - From history (default)
 * @astra /gencode /source h,w pacs.008             - History + workspace
 * @astra /requirements OFAC /gencode               - Piped (uses pipe content)
 * 
 * Sources:
 *   llm - Pure LLM (no context, exclusive)
 *   h   - History (previous response) - DEFAULT
 *   w   - Workspace search
 *   a   - Attachments
 * 
 * Uses VS Code settings for configuration:
 * - astracode.codegen.framework: springboot, quarkus, micronaut
 * - astracode.codegen.messaging: kafka, rabbitmq, activemq, jms
 * - astracode.codegen.architecture: microservice, lambda, monolith
 * - astracode.codegen.deployment: ocp, kubernetes, aws-lambda, vm
 * - astracode.codegen.persistence: jpa, jdbc, r2dbc, mongodb
 */

const vscode = require('vscode');
const path = require('path');
const { streamResponse } = require('../llm/copilot');
const { getWorkspaceContext } = require('../llm/workspace-search');

/**
 * Parse /source modifier from query
 */
function parseSourceModifier(query) {
    const sourceMatch = query.match(/^\/source\s+([a-z,]+)\s*/i);
    
    if (sourceMatch) {
        const sourceStr = sourceMatch[1].toLowerCase();
        const cleanQuery = query.slice(sourceMatch[0].length).trim();
        
        if (sourceStr === 'llm') {
            return { sources: { llm: true, h: false, w: false, a: false }, cleanQuery };
        }
        
        return {
            sources: {
                llm: false,
                h: sourceStr.includes('h'),
                w: sourceStr.includes('w'),
                a: sourceStr.includes('a')
            },
            cleanQuery
        };
    }
    
    // Default: history only
    return { sources: { llm: false, h: true, w: false, a: false }, cleanQuery: query };
}

/**
 * Get code generation settings from VS Code configuration
 */
function getCodeGenSettings() {
    const config = vscode.workspace.getConfiguration('astracode.codegen');
    
    return {
        framework: config.get('framework') || 'springboot',
        messaging: config.get('messaging') || 'kafka',
        architecture: config.get('architecture') || 'microservice',
        deployment: config.get('deployment') || 'kubernetes',
        persistence: config.get('persistence') || 'jpa',
        javaVersion: config.get('javaVersion') || '17',
        includeTests: config.get('includeTests') !== false,
        includeDocker: config.get('includeDocker') !== false
    };
}

function buildSystemPrompt(settings) {
    return `You are an expert Java developer generating production-ready code.

TARGET STACK:
- Language: Java ${settings.javaVersion}
- Framework: ${getFrameworkDetails(settings.framework)}
- Messaging: ${getMessagingDetails(settings.messaging)}
- Architecture: ${getArchitectureDetails(settings.architecture)}
- Deployment: ${getDeploymentDetails(settings.deployment)}
- Persistence: ${getPersistenceDetails(settings.persistence)}

CODE GENERATION RULES:
1. Generate complete, compilable Java code
2. Follow framework best practices and conventions
3. Include proper error handling and logging
4. Use dependency injection appropriately
5. Add JavaDoc comments for public methods
6. Use meaningful variable and method names
7. Include input validation
${settings.includeTests ? '8. Include unit test stubs with JUnit 5' : ''}
${settings.includeDocker ? '9. Include Dockerfile and docker-compose.yml if applicable' : ''}

OUTPUT FORMAT:
For each component, provide:
1. Package structure recommendation
2. Complete Java source files with full imports
3. Configuration files (application.yml, etc.)
4. Build file snippets (pom.xml dependencies or build.gradle)
${settings.includeTests ? '5. Test class stubs' : ''}
${settings.includeDocker ? '6. Docker configuration' : ''}

Use code blocks with filenames:
\`\`\`java
// File: src/main/java/com/example/service/PaymentService.java
package com.example.service;
...
\`\`\``;
}

function getFrameworkDetails(framework) {
    const frameworks = {
        'springboot': 'Spring Boot 3.x with Spring Web, Spring Data',
        'quarkus': 'Quarkus with RESTEasy, Panache',
        'micronaut': 'Micronaut with HTTP Server, Data',
        'jakarta': 'Jakarta EE 10 with JAX-RS, CDI'
    };
    return frameworks[framework] || frameworks['springboot'];
}

function getMessagingDetails(messaging) {
    const options = {
        'kafka': 'Apache Kafka with Spring Kafka or Kafka Clients',
        'rabbitmq': 'RabbitMQ with Spring AMQP',
        'activemq': 'ActiveMQ with JMS',
        'jms': 'JMS 2.0 with generic provider',
        'sqs': 'AWS SQS with AWS SDK',
        'none': 'No messaging (REST/HTTP only)'
    };
    return options[messaging] || options['kafka'];
}

function getArchitectureDetails(architecture) {
    const options = {
        'microservice': 'Microservices pattern with REST APIs, separate deployable units',
        'lambda': 'AWS Lambda / Serverless functions, stateless handlers',
        'monolith': 'Modular monolith with clean architecture layers',
        'hexagonal': 'Hexagonal/Ports & Adapters architecture'
    };
    return options[architecture] || options['microservice'];
}

function getDeploymentDetails(deployment) {
    const options = {
        'ocp': 'OpenShift Container Platform with S2I builds',
        'kubernetes': 'Kubernetes with Helm charts',
        'aws-lambda': 'AWS Lambda with SAM/CDK',
        'aws-ecs': 'AWS ECS/Fargate containers',
        'vm': 'Traditional VM deployment with systemd services',
        'docker': 'Docker containers with docker-compose'
    };
    return options[deployment] || options['kubernetes'];
}

function getPersistenceDetails(persistence) {
    const options = {
        'jpa': 'JPA/Hibernate with Spring Data JPA',
        'jdbc': 'JDBC Template with raw SQL',
        'r2dbc': 'R2DBC for reactive database access',
        'mongodb': 'MongoDB with Spring Data MongoDB',
        'dynamodb': 'AWS DynamoDB with SDK'
    };
    return options[persistence] || options['jpa'];
}

async function handle(ctx) {
    const { query, response, outputChannel, token, request, chatContext, isPiped, previousOutput, pipedContent: ctxPipedContent } = ctx;
    
    const settings = getCodeGenSettings();
    
    // Parse /source modifier
    const { sources, cleanQuery } = parseSourceModifier(query);
    
    // Check for piped content (from pipeline like /requirements /gencode)
    const pipedContent = ctxPipedContent || '';
    const hasPipedContent = pipedContent.length > 100;
    
    // If piped, always use piped content regardless of /source
    const usePipedContent = hasPipedContent;
    
    // Gather content based on sources
    let historyContent = '';
    let workspaceContent = '';
    let attachmentContent = '';
    let workspaceFiles = [];
    let attachmentNames = [];
    
    // History (default unless llm or piped)
    if ((sources.h || (!sources.llm && !usePipedContent)) && !usePipedContent) {
        if (chatContext?.history?.length > 0) {
            for (let i = chatContext.history.length - 1; i >= 0; i--) {
                const turn = chatContext.history[i];
                if (turn.response?.length > 0) {
                    for (const part of turn.response) {
                        if (part.value && typeof part.value === 'string') {
                            historyContent += part.value + '\n';
                        } else if (part.value?.value) {
                            historyContent += part.value.value + '\n';
                        }
                    }
                    if (historyContent.length > 100) break;
                }
            }
        }
    }
    
    // Workspace
    if (sources.w && cleanQuery.trim()) {
        response.progress('Searching workspace...');
        const searchResult = await getWorkspaceContext(cleanQuery, {
            maxFiles: 15,
            maxLinesPerFile: 300
        });
        workspaceContent = searchResult.context || '';
        workspaceFiles = searchResult.files || [];
    }
    
    // Attachments
    if (sources.a && request?.references?.length > 0) {
        response.progress('Reading attachments...');
        for (const ref of request.references) {
            try {
                if (ref.id && typeof ref.id === 'string') {
                    const uri = vscode.Uri.parse(ref.id);
                    const data = await vscode.workspace.fs.readFile(uri);
                    const content = Buffer.from(data).toString('utf8');
                    const fileName = path.basename(uri.fsPath);
                    attachmentContent += `\n### ${fileName}\n${content.slice(0, 30000)}\n`;
                    attachmentNames.push(fileName);
                }
            } catch (e) {
                outputChannel?.appendLine(`[AstraCode] Error reading attachment: ${e.message}`);
            }
        }
    }
    
    // Determine what content we have
    const hasHistory = historyContent.length > 100;
    const hasWorkspace = workspaceContent.length > 100;
    const hasAttachments = attachmentContent.length > 100;
    const hasAnyContext = usePipedContent || hasHistory || hasWorkspace || hasAttachments;
    
    // Show help if no input
    if (!cleanQuery.trim() && !hasAnyContext && !sources.llm) {
        response.markdown(`**Usage:** \`@astra /gencode [/source <sources>] <description>\`

**Sources:**
| Source | Meaning |
|--------|---------|
| \`llm\` | Pure LLM generation (no context) |
| \`h\` | History (previous response) - **default** |
| \`w\` | Workspace search |
| \`a\` | Attachments |

**Examples:**
\`\`\`
@astra /gencode /source llm pacs.008 credit transfer service
@astra /gencode pacs.008 service                     ← uses previous response
@astra /gencode /source h,w pacs.008 with MT103 patterns
@astra /requirements OFAC /gencode                    ← piped
\`\`\`

**Current Settings:** (change in VS Code Settings → AstraCode)

| Setting | Value |
|---------|-------|
| Framework | \`${settings.framework}\` |
| Messaging | \`${settings.messaging}\` |
| Architecture | \`${settings.architecture}\` |
| Deployment | \`${settings.deployment}\` |
| Persistence | \`${settings.persistence}\` |

**Workflow:**
\`\`\`
@astra /gencode /source llm pacs.008 service     ← Fresh generation
@astra /augment add exception handling            ← Enhance iteratively
@astra /augment /source h,w learn from MT103      ← Add workspace patterns
\`\`\`
`);
        response.button({
            command: 'astracode.configureSources',
            title: '⚙️ Configure Input Sources'
        });
        return;
    }
    
    // Show settings and sources
    response.markdown(`## ⚙️ Code Generation

| Setting | Value |
|---------|-------|
| Framework | **${settings.framework}** |
| Architecture | **${settings.architecture}** |
| Persistence | **${settings.persistence}** |

`);
    
    // Build sources summary
    const sourcesUsed = [];
    if (sources.llm) sourcesUsed.push('🤖 LLM only');
    if (usePipedContent) sourcesUsed.push(`🔗 Piped${previousOutput ? ` from /${previousOutput.command}` : ''}`);
    if (hasHistory && !usePipedContent) sourcesUsed.push('📜 History');
    if (hasWorkspace) sourcesUsed.push(`🔍 Workspace (${workspaceFiles.length} files)`);
    if (hasAttachments) sourcesUsed.push(`📎 Attachments (${attachmentNames.length})`);
    
    response.markdown(`**📥 Sources:** ${sourcesUsed.join(', ') || 'None'}\n\n`);
    
    // Show file details
    if (workspaceFiles.length > 0) {
        let details = `<details><summary>📂 Workspace files (${workspaceFiles.length})</summary>\n\n`;
        for (const f of workspaceFiles.slice(0, 15)) {
            details += `- \`${f.path}\`\n`;
        }
        details += `\n</details>\n\n`;
        response.markdown(details);
    }
    
    response.markdown(`## 📝 Generated Code\n\n`);
    
    // Build prompt
    let userPrompt = '';
    
    if (sources.llm) {
        // Pure LLM - just the instruction
        userPrompt = `Generate Java code for: ${cleanQuery}

Generate complete, production-ready code with no external context.
`;
    } else {
        userPrompt = `Generate Java code for: ${cleanQuery || 'the following requirements'}

`;
        
        if (usePipedContent) {
            userPrompt += `## Requirements/Input (from pipeline)
${pipedContent.slice(0, 50000)}

`;
        } else if (hasHistory) {
            userPrompt += `## Requirements/Input (from previous response)
${historyContent.slice(0, 50000)}

`;
        }
        
        if (hasWorkspace) {
            userPrompt += `## Reference Code from Workspace
${workspaceContent.slice(0, 30000)}

Use the above as reference for patterns and business logic.

`;
        }
        
        if (hasAttachments) {
            userPrompt += `## Reference from Attachments
${attachmentContent}

`;
        }
    }
    
    userPrompt += `Generate complete, production-ready Java code following the configured stack.

Include:
1. **Package structure** - recommended organization
2. **Domain/Entity classes** - with proper annotations
3. **Service layer** - business logic implementation
4. **Controller/API layer** - REST endpoints or message handlers
5. **Repository/DAO layer** - data access
6. **Configuration** - application.yml, security config, etc.
7. **Build dependencies** - pom.xml or build.gradle snippets
${settings.includeTests ? '8. **Test stubs** - JUnit 5 test classes' : ''}
${settings.includeDocker ? '9. **Docker files** - Dockerfile, docker-compose.yml' : ''}

Ensure the code handles:
- Input validation
- Error handling with proper exceptions
- Logging (SLF4J)
- Transaction management where needed`;

    const systemPrompt = buildSystemPrompt(settings);
    const generatedContent = await streamResponse(systemPrompt, userPrompt, response, outputChannel, token);
    
    // Set for piping/augmenting
    ctx.pipedContent = generatedContent;
    
    // Suggest next steps
    response.markdown(`

---
**Next steps:**
- \`@astra /augment add exception handling\`
- \`@astra /augment /source h,w learn patterns from MT103\`
- \`@astra /jira\` → Create ticket
`);
}

module.exports = { handle };
