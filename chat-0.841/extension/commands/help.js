/**
 * /help command
 */

function handle(ctx) {
    const { response } = ctx;
    
    response.markdown(`# 🔍 AstraCode Help

## 🚀 Full Modernization Pipeline

\`\`\`
@astra /requirements OFAC screening /fediso /gencode
\`\`\`

**From Confluence:**
\`\`\`
@astra /conf.r Design Spec /requirements /fediso /gencode
\`\`\`

Then publish back:
\`\`\`
@astra /conf.w Generated OFAC Service
\`\`\`

## Commands

| Command | Description | Example |
|---------|-------------|---------|
| \`/requirements\` | Extract business requirements | \`@astra /requirements OFAC\` |
| \`/fediso\` | Map to ISO 20022 | \`@astra /fediso wire transfer\` |
| \`/gencode\` | Generate Java code | \`@astra /gencode payment service\` |
| \`/deepwiki\` | Generate documentation | \`@astra /deepwiki query optimizer\` |
| \`/conf.r\` | Read Confluence page(s) | \`@astra /conf.r Page1, Page2\` |
| \`/conf.w\` | Write to Confluence | \`@astra /conf.w Page Title\` |
| \`/describe\` | Explain how code works | \`@astra /describe function_name\` |
| \`/find\` | Search for code | \`@astra /find partprune\` |
| \`/translate\` | Translate legacy code | \`@astra /translate PROC_NAME\` |
| \`/stats\` | Workspace statistics | \`@astra /stats\` |
| \`/history N\` | Use last N responses as context | \`@astra /history 3 clarify the API\` |
| \`/sources\` | Configure input sources (Quick Pick) | \`@astra /sources /requirements\` |
| \`/jira\` | Format as Jira issue | \`@astra /requirements OFAC /jira\` |
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

**Authentication Options:**

**Option 1: OAuth (Enterprise SSO)**
1. Register app at https://developer.atlassian.com/console/myapps/
2. Add OAuth 2.0, callback: \`vscode://astracode.astracode/auth/callback\`
3. Set \`astracode.confluence.clientId\`
4. Run **Confluence: Sign In** from command palette (Cmd+Shift+P)

**Option 2: API Token (Simple)**
\`\`\`json
{
  "astracode.confluence.baseUrl": "https://company.atlassian.net/wiki",
  "astracode.confluence.spaceKey": "DOCS",
  "astracode.confluence.username": "your.email@company.com",
  "astracode.confluence.apiToken": "your-api-token"
}
\`\`\`

**Read pages:**
\`\`\`
@astra /conf.r Architecture Overview
@astra /conf.r Page One, Page Two, Page Three
@astra /conf.r 123456789
@astra /conf.r https://company.atlassian.net/wiki/spaces/DEV/pages/123456789
\`\`\`

**Write pages:**
\`\`\`
@astra /deepwiki partition pruning
@astra /conf.w Partition Pruning Docs
\`\`\`

## 🧹 Clear Attachments

Press **Cmd+L** (Mac) / **Ctrl+L** (Windows) to start a new chat.
`);
    
    // Add configure sources button
    response.button({
        command: 'astracode.configureSources',
        title: '⚙️ Configure Input Sources'
    });
}

module.exports = { handle };
