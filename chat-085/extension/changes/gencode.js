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
const fs = require('fs');
const { streamResponse } = require('../llm/copilot');
const { getWorkspaceContext } = require('../llm/workspace-search');

/**
 * Load base gencode prompt from file
 */
function loadBasePrompt() {
    try {
        const promptPath = path.join(__dirname, '..', 'prompts', 'gencode.md');
        return fs.readFileSync(promptPath, 'utf8');
    } catch (e) {
        return `Generate complete, production-ready code. No stubs or placeholders.`;
    }
}

/**
 * Load spec file from prompts/specs/ folder
 * Supports: .md, .xsd, .xml
 */
function loadSpec(specName) {
    // Normalize spec name (remove dots, lowercase)
    const normalized = specName.toLowerCase().replace(/\./g, '');
    
    // Try various file patterns and extensions
    const extensions = ['.md', '.xsd', '.xml', '.json'];
    const basenames = [normalized, specName, specName.toLowerCase()];
    
    for (const base of basenames) {
        for (const ext of extensions) {
            try {
                const specPath = path.join(__dirname, '..', 'prompts', 'specs', base + ext);
                if (fs.existsSync(specPath)) {
                    const content = fs.readFileSync(specPath, 'utf8');
                    const fileType = ext.slice(1); // 'md', 'xsd', 'xml'
                    return {
                        name: specName,
                        content,
                        type: fileType
                    };
                }
            } catch (e) {
                // Continue to next candidate
            }
        }
    }
    
    return null;
}

/**
 * Format spec content based on file type
 */
function formatSpecContent(spec) {
    if (!spec) return '';
    
    if (spec.type === 'xsd') {
        return `## XML Schema (XSD): ${spec.name}

**XSD-to-Java Mapping Rules:**
| XSD Type | Java Type |
|----------|-----------|
| xs:string | String |
| xs:decimal | BigDecimal |
| xs:integer | BigInteger |
| xs:int | int |
| xs:long | long |
| xs:boolean | boolean |
| xs:date | LocalDate |
| xs:dateTime | LocalDateTime |
| xs:time | LocalTime |

**Requirements:**
1. Generate a Java class for EVERY complexType
2. Generate an enum for EVERY simpleType with enumeration
3. Add @XmlRootElement, @XmlElement, @XmlType annotations
4. Add validation: @NotNull for required, @Size for length restrictions, @Pattern for patterns
5. Implement ALL nested elements as inner classes or references
6. Use List<T> for maxOccurs="unbounded"
7. Use Optional<T> or null for minOccurs="0"

\`\`\`xml
${spec.content}
\`\`\`

Generate COMPLETE Java classes for every type - no stubs.`;
    }
    
    if (spec.type === 'xml') {
        return `## XML Sample: ${spec.name}

**Instructions:** Generate Java classes matching this XML structure exactly.
- Create a class for each element with children
- Include ALL attributes and child elements
- Add JAXB annotations for serialization
- Infer types from values (numbers, dates, strings)

\`\`\`xml
${spec.content}
\`\`\`

Generate COMPLETE Java classes - no stubs.`;
    }
    
    if (spec.type === 'json') {
        return `## JSON Schema/Sample: ${spec.name}

**Instructions:** Generate Java classes matching this JSON structure.
- Create a class for each object
- Include ALL fields
- Add Jackson annotations (@JsonProperty, etc.)
- Infer appropriate Java types

\`\`\`json
${spec.content}
\`\`\`

Generate COMPLETE Java classes - no stubs.`;
    }
    
    // Markdown - return as-is with header
    return `## Specification: ${spec.name}

${spec.content}`;
}

/**
 * List available specs with their types
 */
function listAvailableSpecs() {
    try {
        const specsDir = path.join(__dirname, '..', 'prompts', 'specs');
        if (fs.existsSync(specsDir)) {
            return fs.readdirSync(specsDir)
                .filter(f => /\.(md|xsd|xml|json)$/.test(f))
                .map(f => {
                    const ext = path.extname(f).slice(1);
                    const name = f.replace(/\.(md|xsd|xml|json)$/, '');
                    return { name, ext };
                });
        }
    } catch (e) {
        // Ignore
    }
    return [];
}

/**
 * Parse /source, /spec, and /in modifiers from query
 */
function parseModifiers(query) {
    let cleanQuery = query;
    let sources = { llm: false, h: true, w: false, a: false };
    let specName = null;
    let folderFilter = null;  // { include: [], exclude: [] }
    
    // Parse /source
    const sourceMatch = cleanQuery.match(/^\/source\s+([a-z,]+)\s*/i);
    if (sourceMatch) {
        const sourceStr = sourceMatch[1].toLowerCase();
        cleanQuery = cleanQuery.slice(sourceMatch[0].length).trim();
        
        if (sourceStr === 'llm') {
            sources = { llm: true, h: false, w: false, a: false };
        } else {
            sources = {
                llm: false,
                h: sourceStr.includes('h'),
                w: sourceStr.includes('w'),
                a: sourceStr.includes('a')
            };
        }
    }
    
    // Parse /in (folder filter)
    const inMatch = cleanQuery.match(/^\/in\s+([^\s\/]+(?:\s*,\s*[^\s\/]+)*)\s*/i);
    if (inMatch) {
        const parts = inMatch[1].split(',').map(f => f.trim()).filter(f => f);
        cleanQuery = cleanQuery.slice(inMatch[0].length).trim();
        
        const include = [];
        const exclude = [];
        
        for (const part of parts) {
            if (part.startsWith('-')) {
                exclude.push(part.slice(1).toLowerCase());
            } else {
                include.push(part.toLowerCase());
            }
        }
        
        folderFilter = { include, exclude };
    }
    
    // Parse /spec
    const specMatch = cleanQuery.match(/^\/spec\s+(\S+)\s*/i);
    if (specMatch) {
        specName = specMatch[1];
        cleanQuery = cleanQuery.slice(specMatch[0].length).trim();
    }
    
    return { sources, specName, folderFilter, cleanQuery };
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
    
    // Parse /source, /spec, and /in modifiers
    const { sources, specName, folderFilter, cleanQuery } = parseModifiers(query);
    
    // Load spec if requested
    let loadedSpec = null;
    if (specName) {
        loadedSpec = loadSpec(specName);
        if (!loadedSpec) {
            const availableSpecs = listAvailableSpecs();
            response.markdown(`⚠️ **Spec not found:** \`${specName}\`

**Available specs in \`prompts/specs/\`:**
${availableSpecs.length > 0 ? availableSpecs.map(s => `- \`${s.name}\` (${s.ext})`).join('\n') : '- (none)'}

**To add a spec:** Create \`prompts/specs/${specName}.md\` (or .xsd, .xml, .json)
`);
            return;
        }
    }
    
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
    
    // Check if we have history
    const hasHistory = historyContent.length > 100;
    
    // AUTO-WORKSPACE FALLBACK: If no history and no explicit /source llm, search workspace
    const shouldSearchWorkspace = sources.w || (!sources.llm && !usePipedContent && !hasHistory && cleanQuery.trim());
    
    // Workspace
    if (shouldSearchWorkspace && cleanQuery.trim()) {
        const filterMsg = folderFilter ? 
            (folderFilter.include?.length ? ` in ${folderFilter.include.join(',')}` : '') +
            (folderFilter.exclude?.length ? ` excluding ${folderFilter.exclude.join(',')}` : '') : '';
        response.progress(`Searching workspace${filterMsg}...`);
        const searchResult = await getWorkspaceContext(cleanQuery, {
            maxFiles: 15,
            maxLinesPerFile: 300,
            folderFilter
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
    const hasWorkspace = workspaceContent.length > 100;
    const hasAttachments = attachmentContent.length > 100;
    const hasAnyContext = usePipedContent || hasHistory || hasWorkspace || hasAttachments;
    
    // Show help if no input
    if (!cleanQuery.trim() && !hasAnyContext && !sources.llm) {
        const availableSpecs = listAvailableSpecs();
        response.markdown(`# /gencode - Generate Java Code

**Usage:** \`@astra /gencode [/source <s>] [/spec <n>] <description>\`

## Source Behavior

| Scenario | Sources Used |
|----------|--------------|
| Has history | Uses history (default) |
| No history | **Auto-searches workspace** |
| Piped content | Uses piped content |
| \`/source llm\` | Pure LLM (no context) |

## Source Options

| Source | Meaning |
|--------|---------|
| \`llm\` | Fresh generation (no context) |
| \`h\` | Use previous response |
| \`w\` | Search workspace |
| \`a\` | Use attachments |

## Folder Filter (/in)

| Example | Effect |
|---------|--------|
| \`/in payments\` | Only search in payments folder |
| \`/in -docs\` | Exclude docs folder |
| \`/in src,-test\` | Include src, exclude test |

## Examples

**Direct generation (auto-searches workspace):**
\`\`\`
@astra /gencode create pacs.008 implementation
\`\`\`

**Search specific folder:**
\`\`\`
@astra /gencode /source w /in payments-repo create handler
\`\`\`

**Fresh generation with spec:**
\`\`\`
@astra /gencode /source llm /spec pacs008 credit transfer service
\`\`\`

**Pipeline (uses piped requirements):**
\`\`\`
@astra /requirements OFAC /fediso /gencode
\`\`\`

## Specs (/spec)

Load domain schemas from \`prompts/specs/\`:

**Available:** ${availableSpecs.length > 0 ? availableSpecs.map(s => `\`${s.name}\` (${s.ext})`).join(', ') : '(none - add .xsd/.xml/.json/.md files)'}

## Current Settings

| Setting | Value |
|---------|-------|
| Framework | \`${settings.framework}\` |
| Architecture | \`${settings.architecture}\` |
| Persistence | \`${settings.persistence}\` |

*Change in VS Code Settings -> search "astracode"*
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
    if (hasWorkspace) {
        // Show if auto-fallback was used
        const isAutoFallback = !sources.w && !hasHistory && !usePipedContent;
        let wsLabel = `🔍 Workspace${isAutoFallback ? ' (auto)' : ''} (${workspaceFiles.length} files)`;
        if (folderFilter) {
            const filterParts = [];
            if (folderFilter.include?.length) filterParts.push(`in ${folderFilter.include.join(',')}`);
            if (folderFilter.exclude?.length) filterParts.push(`excl ${folderFilter.exclude.join(',')}`);
            if (filterParts.length) wsLabel += ` [${filterParts.join(', ')}]`;
        }
        sourcesUsed.push(wsLabel);
    }
    if (hasAttachments) sourcesUsed.push(`📎 Attachments (${attachmentNames.length})`);
    
    // Show loaded spec
    if (loadedSpec) {
        sourcesUsed.push(`📋 Spec: ${loadedSpec.name} (${loadedSpec.type})`);
    }
    
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
    
    // Add loaded spec if provided (formatted based on type)
    if (loadedSpec) {
        userPrompt += formatSpecContent(loadedSpec);
        userPrompt += `\n---\n\n`;
    }
    
    if (sources.llm) {
        // Pure LLM - just the instruction (with spec if provided)
        userPrompt += `## Request
Generate Java code for: ${cleanQuery}

${loadedSpec ? 'Implement ALL fields and nested classes from the specification above. Include validation, builders, and proper Java types.' : 'Generate complete, production-ready code.'}
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

**IMPORTANT: Follow these existing patterns from the workspace:**
${workspaceContent.slice(0, 30000)}

**Requirements:**
1. Follow the SAME naming conventions used in the workspace
2. Use the SAME package structure and organization
3. Integrate with existing services (if any Service interfaces are shown)
4. Follow the SAME coding style and patterns
5. Extend existing models/contexts if appropriate

`;
        }
        
        if (hasAttachments) {
            userPrompt += `## Reference from Attachments
${attachmentContent}

`;
        }
    }
    
    userPrompt += `Generate complete, production-ready Java code following the configured stack.

${loadedSpec ? `**CRITICAL - Specification Implementation Requirements:**
- Implement ALL classes, fields, and nested types from the specification
- Use proper Java types: BigDecimal for money/amounts, LocalDate/LocalDateTime for dates
- Add JSR-380 validation annotations (@NotNull, @Size, @Pattern, @Valid)
- Add JAXB annotations for XML serialization if needed (@XmlRootElement, @XmlElement, @XmlType)
- Use Lombok annotations (@Data, @Builder, @NoArgsConstructor, @AllArgsConstructor)
- Implement ALL enums with proper values
- Add utility methods for domain-specific validation
- Include proper equals/hashCode based on business keys

` : ''}Include:
1. **Package structure** - recommended organization
2. **Domain/Entity classes** - with ALL fields and proper annotations
3. **Service layer** - COMPLETE business logic implementation (no stubs)
4. **Controller/API layer** - REST endpoints or message handlers
5. **Repository/DAO layer** - data access
6. **Configuration** - application.yml, security config, etc.
7. **Build dependencies** - pom.xml or build.gradle snippets
${settings.includeTests ? '8. **Test classes** - JUnit 5 tests with real assertions' : ''}
${settings.includeDocker ? '9. **Docker files** - Dockerfile, docker-compose.yml' : ''}

**CRITICAL - No stubs or placeholders:**
- Every method must have REAL implementation
- No TODO comments
- No empty method bodies
- No placeholder return values`;

    // Load base prompt and combine with stack-specific prompt
    const basePrompt = loadBasePrompt();
    const stackPrompt = buildSystemPrompt(settings);
    const systemPrompt = `${basePrompt}

---

${stackPrompt}`;

    const generatedContent = await streamResponse(systemPrompt, userPrompt, response, outputChannel, token);
    
    // Set for piping/augmenting
    ctx.pipedContent = generatedContent;
    
    // Suggest next steps
    response.markdown(`

---
**Next steps:**
- \`@astra /augment add exception handling\`
- \`@astra /augment /source h,w learn patterns from workspace\`
- \`@astra /jira\` → Create ticket
`);
}

module.exports = { handle };
