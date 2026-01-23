/**
 * /gencode command - Generate Java code from requirements
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
    
    // Check for directly piped content from previous command
    const pipedContent = ctxPipedContent || '';
    const hasPipedContent = pipedContent.length > 100;
    
    // Extract previous response from chat history (fallback)
    let previousResponse = '';
    if (!hasPipedContent && chatContext && chatContext.history && chatContext.history.length > 0) {
        // Look for the most recent assistant response
        for (let i = chatContext.history.length - 1; i >= 0; i--) {
            const turn = chatContext.history[i];
            // Check if it's an assistant response (ChatResponseTurn)
            if (turn.response && turn.response.length > 0) {
                // Extract text from response parts
                for (const part of turn.response) {
                    if (part.value && typeof part.value === 'string') {
                        previousResponse += part.value + '\n';
                    } else if (part.value && part.value.value) {
                        previousResponse += part.value.value + '\n';
                    }
                }
                if (previousResponse.length > 100) break; // Found substantial content
            }
        }
    }
    
    // Combine piped content and chat history
    const inputContent = hasPipedContent ? pipedContent : previousResponse;
    const hasPreviousContext = hasPipedContent || previousResponse.length > 200;
    
    // Debug logging
    if (outputChannel) {
        outputChannel.appendLine(`[AstraCode] /gencode: isPiped=${isPiped}, hasPipedContent=${hasPipedContent}, pipedContent.length=${pipedContent.length}, hasPreviousContext=${hasPreviousContext}`);
    }
    
    // Show help if no input available
    if (!query.trim() && !hasPreviousContext) {
        response.markdown(`**Usage:** \`@astra /gencode <requirements or feature>\`

Generates Java code from requirements.

**Examples:**
- \`@astra /gencode\` ← uses previous response as input
- \`@astra /requirements OFAC screening /gencode\` ← piped
- \`@astra /gencode payment validation service\`

**Current Settings:** (change in VS Code Settings → AstraCode)

| Setting | Value |
|---------|-------|
| Framework | \`${settings.framework}\` |
| Messaging | \`${settings.messaging}\` |
| Architecture | \`${settings.architecture}\` |
| Deployment | \`${settings.deployment}\` |
| Persistence | \`${settings.persistence}\` |
| Java Version | \`${settings.javaVersion}\` |

**Workflow:**
1. Run \`@astra /requirements OFAC screening\`
2. Then run \`@astra /gencode\` ← uses output from step 1

**Or chain:** \`@astra /requirements OFAC /fediso /gencode\`

${isPiped ? `\n⚠️ **Piped but no content received.** The previous command may not have produced output.` : ''}`);
        
        // Add configure sources button
        response.button({
            command: 'astracode.configureSources',
            title: '⚙️ Configure Input Sources'
        });
        return;
    }
    
    // Show current settings
    response.markdown(`## ⚙️ Code Generation Settings

| Setting | Value |
|---------|-------|
| Framework | **${settings.framework}** |
| Messaging | **${settings.messaging}** |
| Architecture | **${settings.architecture}** |
| Deployment | **${settings.deployment}** |
| Persistence | **${settings.persistence}** |

`);
    
    // Note the source of input
    if (hasPreviousContext && !query.trim()) {
        response.markdown(`📋 *Using previous response as input...*\n\n`);
    } else if (isPiped && previousOutput) {
        response.markdown(`🔗 *Generating code from \`/${previousOutput.command}\` output...*\n\n`);
    }
    
    // Check for attached documents
    let attachedDocs = '';
    let attachedDocNames = [];
    
    if (request && request.references && request.references.length > 0) {
        response.progress('Reading attached specifications...');
        
        for (const ref of request.references) {
            try {
                let content = '';
                let fileName = '';
                
                if (ref.id && typeof ref.id === 'string') {
                    const uri = vscode.Uri.parse(ref.id);
                    const fileContent = await vscode.workspace.fs.readFile(uri);
                    content = Buffer.from(fileContent).toString('utf8');
                    fileName = path.basename(uri.fsPath);
                } else if (ref.value && typeof ref.value === 'string') {
                    content = ref.value;
                    fileName = 'attached-spec';
                }
                
                if (content) {
                    attachedDocNames.push(fileName);
                    const maxChars = 30000;
                    if (content.length > maxChars) {
                        content = content.slice(0, maxChars) + '\n... [truncated]';
                    }
                    attachedDocs += `\n### ${fileName}\n${content}\n`;
                }
            } catch (e) {
                outputChannel?.appendLine(`[AstraCode] Error reading attachment: ${e.message}`);
            }
        }
    }
    
    // Search workspace for context only if we have a query
    let context = '';
    let files = [];
    
    if (query.trim()) {
        response.progress('Analyzing requirements...');
        const searchResult = await getWorkspaceContext(query, {
            maxFiles: 10,
            maxLinesPerFile: 200
        });
        context = searchResult.context;
        files = searchResult.files;
    }
    
    // Show all input sources
    const fileCount = files?.length || 0;
    const pipedFrom = hasPipedContent && previousOutput ? previousOutput.command : null;
    
    let sourcesUsed = '**📥 Input Sources:**\n\n';
    let hasAnySources = false;
    
    if (hasPreviousContext) {
        sourcesUsed += `- 🔗 **Piped content** ${pipedFrom ? `from \`/${pipedFrom}\`` : '(from previous response)'}\n`;
        hasAnySources = true;
    }
    
    if (fileCount > 0) {
        sourcesUsed += `- 🔍 **Reference code** (${fileCount} files)\n`;
        hasAnySources = true;
    }
    
    if (attachedDocNames.length > 0) {
        sourcesUsed += `- 📎 **Attached docs** (${attachedDocNames.length})\n`;
        hasAnySources = true;
    }
    
    if (hasAnySources) {
        sourcesUsed += '\n';
        
        if (files && files.length > 0) {
            sourcesUsed += `<details><summary>📂 Reference code (${files.length} files)</summary>\n\n`;
            for (const f of files.slice(0, 15)) {
                sourcesUsed += `- \`${f.path}\`\n`;
            }
            sourcesUsed += `\n</details>\n\n`;
        }
        if (attachedDocNames.length > 0) {
            sourcesUsed += `<details><summary>📎 Attached docs (${attachedDocNames.length})</summary>\n\n`;
            for (const name of attachedDocNames) {
                sourcesUsed += `- \`${name}\`\n`;
            }
            sourcesUsed += `\n</details>\n\n`;
        }
        response.markdown(sourcesUsed);
    }
    
    response.markdown(`## 📝 Generated Code\n\n`);
    
    // Build prompt
    let userPrompt = '';
    
    // If using piped content or previous response as input
    if (hasPreviousContext && !query.trim()) {
        userPrompt = `Generate Java code based on these requirements:

## Input Content
${inputContent.slice(0, 50000)}

`;
    } else {
        userPrompt = `Generate Java code for: ${query}

`;
    }

    if (context) {
        userPrompt += `## Legacy/Reference Code (for understanding business logic)
${context}

`;
    }

    if (attachedDocs) {
        userPrompt += `## Additional Specifications
${attachedDocs}

`;
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
    await streamResponse(systemPrompt, userPrompt, response, outputChannel, token);
}

module.exports = { handle };
