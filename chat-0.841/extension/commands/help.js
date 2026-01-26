/**
 * /help command
 */

function handle(ctx) {
    const { response } = ctx;
    
    response.markdown(`# 🔍 AstraCode Help

## 🚀 Iterative Code Generation Workflow

\`\`\`
@astra /gencode /source llm pacs.008 credit transfer service
@astra /augment add input validation
@astra /augment /source h,w learn exception handling from MT103
@astra /augment add logging and metrics
@astra /jira epic
\`\`\`

## 📥 Source Modifier

Use \`/source\` to control where commands get input:

| Source | Meaning |
|--------|---------|
| \`llm\` | Pure LLM (no context) |
| \`h\` | History (previous response) - **default** |
| \`w\` | Workspace search |
| \`a\` | Attachments |

**Combine sources:** \`/source h,w\` or \`/source h,w,a\`

## Commands

| Command | Description | Example |
|---------|-------------|---------|
| \`/gencode\` | Generate Java code | \`@astra /gencode /source llm pacs.008\` |
| \`/augment\` | Enhance code iteratively | \`@astra /augment add retry logic\` |
| \`/requirements\` | Extract business requirements | \`@astra /requirements OFAC\` |
| \`/logic\` | Extract business logic | \`@astra /logic MT103\` |
| \`/fediso\` | Map to ISO 20022 | \`@astra /fediso wire transfer\` |
| \`/deepwiki\` | Generate documentation | \`@astra /deepwiki query optimizer\` |
| \`/jira\` | Format as Jira issue | \`@astra /jira epic\` |
| \`/conf.r\` | Read Confluence page(s) | \`@astra /conf.r Page1, Page2\` |
| \`/conf.w\` | Write to Confluence | \`@astra /conf.w Page Title\` |
| \`/describe\` | Explain how code works | \`@astra /describe function_name\` |
| \`/find\` | Search for code | \`@astra /find partprune\` |
| \`/translate\` | Translate legacy code | \`@astra /translate PROC_NAME\` |
| \`/history N\` | Use last N responses | \`@astra /history 3 clarify\` |
| \`/sources\` | Configure input sources | \`@astra /sources\` |
| \`/clear\` | Clear context help | \`@astra /clear\` |

## ⚙️ Code Generation Settings

Configure in **VS Code Settings** (Cmd+,) → search "astracode":

| Setting | Options | Default |
|---------|---------|---------|
| \`codegen.framework\` | springboot, quarkus, micronaut | **springboot** |
| \`codegen.messaging\` | kafka, rabbitmq, activemq, sqs | **kafka** |
| \`codegen.architecture\` | microservice, lambda, monolith | **microservice** |
| \`codegen.deployment\` | ocp, kubernetes, aws-lambda, vm | **kubernetes** |
| \`codegen.persistence\` | jpa, jdbc, mongodb, dynamodb | **jpa** |

## 📚 Confluence Integration

**Option 1: API Token (Simple)**
\`\`\`json
{
  "astracode.confluence.baseUrl": "https://company.atlassian.net/wiki",
  "astracode.confluence.spaceKey": "DOCS",
  "astracode.confluence.username": "your.email@company.com",
  "astracode.confluence.apiToken": "your-api-token"
}
\`\`\`

**Option 2: OAuth (Enterprise)**
1. Register at https://developer.atlassian.com/console/myapps/
2. Set \`astracode.confluence.clientId\`
3. Run **Confluence: Sign In** (Cmd+Shift+P)

## 🔄 Pipeline Examples

\`\`\`
@astra /requirements OFAC /fediso /gencode
@astra /conf.r Design Spec /requirements /jira
@astra /logic MT103 /gencode /augment add validation
\`\`\`
`);
    
    // Add configure sources button
    response.button({
        command: 'astracode.configureSources',
        title: '⚙️ Configure Input Sources'
    });
}

module.exports = { handle };
