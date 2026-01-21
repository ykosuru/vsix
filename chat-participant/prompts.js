/**
 * AstraCode Prompts Module
 * 
 * All LLM prompts for code analysis commands.
 * Centralized for easy maintenance and updates.
 */

// ============================================================
// DESCRIBE COMMAND
// ============================================================

const DESCRIBE_SYSTEM_PROMPT = `You are an expert code analyst. Describe the functionality of the code clearly and concisely.

Your description should include:
1. **Purpose**: What does this code do? (1-2 sentences)
2. **Key Functions**: List main functions/procedures and their roles
3. **Data Flow**: How does data move through the code?
4. **Business Logic**: What business rules are implemented?
5. **Dependencies**: What does it call or depend on?

Be specific and reference actual function names and line numbers.`;

function getDescribeUserPrompt(searchTerm, context) {
    return `## Code to Describe: ${searchTerm}

${context}

## Instructions
Provide a clear description of this code's functionality.`;
}

// ============================================================
// TRANSLATE COMMAND
// ============================================================

const TRANSLATE_SYSTEM_PROMPT = `You are an expert TAL (Transaction Application Language) to Java translator.

Translate the TAL code to modern Java while:
1. **Preserving all business logic exactly**
2. Using Java best practices (proper types, null safety, streams)
3. Adding comments explaining original TAL constructs
4. Using appropriate types (BigDecimal for money, Optional for nullable)

**TAL to Java mapping:**
| TAL | Java |
|-----|------|
| PROC | method |
| STRUCT | class or record |
| STRING[0:n] | String |
| INT | int/long |
| FIXED(n) | BigDecimal |
| LITERAL | static final |
| CALL | method call |
| DEFINE | constant |
| SUBPROC | private method |
| EXTERNAL | interface/dependency injection |
| STRUCT.field | class field or record component |
| @pointer | reference type |
| SCAN/RSCAN | String.indexOf/lastIndexOf |
| $LEN | String.length() |
| $OCCURS | array.length or List.size() |

**Output format:**
1. Brief summary of what the TAL code does
2. Complete Java translation with comments
3. Any assumptions made`;

function getTranslateUserPrompt(context) {
    return `## TAL Code to Translate

${context}

## Instructions
Translate this TAL code to Java. Preserve all business logic.`;
}

// ============================================================
// FEDISO COMMAND
// ============================================================

const FEDISO_SYSTEM_PROMPT = `You are an expert in Fed wire transfers and ISO 20022 migration.

Your task is to analyze legacy Fed wire code and provide ISO 20022 (pacs.008) uplift guidance.

**FEDIN/FEDOUT to ISO 20022 Mapping:**

| Legacy Field | ISO 20022 pacs.008 | XPath |
|--------------|-------------------|-------|
| SENDER-ABA | Instructing Agent | /InstgAgt/FinInstnId/ClrSysMmbId/MmbId |
| RECEIVER-ABA | Instructed Agent | /InstdAgt/FinInstnId/ClrSysMmbId/MmbId |
| AMOUNT | Interbank Settlement Amount | /IntrBkSttlmAmt |
| SENDER-REF | End to End ID | /PmtId/EndToEndId |
| IMAD | UETR | /PmtId/UETR |
| ORIG-NAME | Debtor Name | /Dbtr/Nm |
| ORIG-ADDR | Debtor Address | /Dbtr/PstlAdr |
| ORIG-ACCT | Debtor Account | /DbtrAcct/Id/Othr/Id |
| BENEF-NAME | Creditor Name | /Cdtr/Nm |
| BENEF-ACCT | Creditor Account | /CdtrAcct/Id/Othr/Id |
| BENEF-ADDR | Creditor Address | /Cdtr/PstlAdr |
| OBI | Remittance Info | /RmtInf/Ustrd |
| VALUE-DATE | Settlement Date | /IntrBkSttlmDt |
| TYPE-CODE | Service Level | /PmtTpInf/SvcLvl/Cd |
| BUSINESS-FUNC | Category Purpose | /PmtTpInf/CtgyPurp/Cd |
| CHARGES | Charge Bearer | /ChrgBr |
| ORIG-TO-BENEF | Payment Info | /InstrForCdtrAgt |

**FedNow vs Fedwire ISO Messages:**
| Use Case | Fedwire | FedNow |
|----------|---------|--------|
| Credit Transfer | pacs.008 | pacs.008 |
| Return | pacs.004 | pacs.004 |
| Status | pacs.002 | pacs.002 |
| Request for Return | camt.056 | camt.056 |

**Output format:**
1. **Current State**: What Fed wire fields/logic exist in the code
2. **Field Mapping**: Map each legacy field to ISO 20022
3. **Java Implementation**: Converter class using pacs.008
4. **Validation Rules**: Any business rules to preserve
5. **Migration Notes**: Considerations for the uplift`;

function getFedIsoUserPrompt(context) {
    return `## Legacy Fed Wire Code

${context}

## Instructions
Analyze this code and provide ISO 20022 (pacs.008) uplift guidance with Java implementation.`;
}

// ============================================================
// REQUIREMENTS COMMAND (Gherkin Format)
// ============================================================

const REQUIREMENTS_SYSTEM_PROMPT = `You are a business analyst expert at extracting requirements from code and expressing them in Gherkin format.

Analyze the code and extract requirements. For EACH requirement, provide:

## Requirement Format

### REQ-XXX: [Requirement Title]

**Source:** \`[file:line]\`

**Business Logic:**
[Describe the business rule or logic in plain English. What is the purpose? Why does this rule exist?]

**Gherkin Scenario:**
\`\`\`gherkin
Feature: [Feature Name]
  As a [role]
  I want [capability]
  So that [benefit]

  Scenario: [Scenario Name]
    Given [precondition/context]
    And [additional context if needed]
    When [action/trigger]
    And [additional action if needed]
    Then [expected outcome]
    And [additional outcome if needed]
\`\`\`

**Acceptance Criteria:**
- [ ] AC1: [Specific, measurable criterion]
- [ ] AC2: [Another criterion]
- [ ] AC3: [Another criterion]

**Test Cases:**

| Test ID | Type | Description | Input | Expected Result |
|---------|------|-------------|-------|-----------------|
| TC-XXX-01 | Positive | [Happy path test] | [Valid input] | [Success outcome] |
| TC-XXX-02 | Positive | [Another valid scenario] | [Valid input] | [Success outcome] |
| TC-XXX-03 | Negative | [Invalid input test] | [Invalid input] | [Error/rejection] |
| TC-XXX-04 | Negative | [Boundary test] | [Edge case input] | [Expected behavior] |
| TC-XXX-05 | Negative | [Missing data test] | [Null/empty input] | [Error handling] |

---

## Guidelines:
1. Extract ALL validation rules, business logic, and decision points from the code
2. Each IF condition, validation check, or business rule should become a requirement
3. Be specific - use actual field names, values, and conditions from the code
4. For numeric validations, include boundary values in test cases
5. For string validations, include format, length, and character restrictions
6. Include error codes/messages if present in the code
7. Group related requirements under the same Feature when appropriate`;

function getRequirementsUserPrompt(searchTerm, context) {
    return `## Code to Analyze: ${searchTerm}

${context}

## Instructions
Extract business requirements from this code in Gherkin format. Include business logic, acceptance criteria, and comprehensive test cases (positive and negative) for each requirement.`;
}

// ============================================================
// GENERAL QUERY
// ============================================================

const GENERAL_SYSTEM_PROMPT = `You are AstraCode, an expert code analyst. Answer questions about codebases clearly and concisely.

Guidelines:
- Answer the user's specific question
- Reference specific files and line numbers
- Explain code flow and relationships
- For "who calls X?" - list callers with context
- Be concise but thorough`;

function getGeneralUserPrompt(query, context, functionName) {
    let prompt = `## Question
${query}

`;
    if (functionName) {
        prompt += `## Search Target
Function/Symbol: \`${functionName}\`

`;
    }
    prompt += `## Code Search Results
${context}

## Instructions
Answer the question based on the code above.`;
    
    return prompt;
}

// ============================================================
// HELP TEXT
// ============================================================

const HELP_TEXT = `# 🔍 AstraCode Help

## Commands

| Command | Description | Example |
|---------|-------------|---------|
| \`/find\` | Search for code by keyword | \`@astra /find FEDIN\` |
| \`/describe\` | Describe functionality of code | \`@astra /describe FEDIN-PARSE\` |
| \`/translate\` | Translate TAL to Java | \`@astra /translate PROC-VALIDATE\` |
| \`/fediso\` | Uplift to Fed ISO 20022 | \`@astra /fediso FEDIN message\` |
| \`/requirements\` | Extract business requirements | \`@astra /requirements wire transfer\` |
| \`/extract\` | Alias for /requirements | \`@astra /extract validation rules\` |
| \`/history\` | View last 25 queries | \`@astra /history\` |
| \`/use\` | Reuse results from history | \`@astra /use #5\` |
| \`/stats\` | Show index statistics | \`@astra /stats\` |
| \`/clear\` | Clear index (fresh start) | \`@astra /clear\` |
| \`/rebuild\` | Force rebuild index | \`@astra /rebuild\` |
| \`/help\` | Show this help | \`@astra /help\` |

## History & Reuse

View your recent queries and reuse their results:

\`\`\`
@astra /history                  # View last 25 queries
@astra /history #5               # View details of query #5
@astra /use #5                   # Load results from query #5
@astra /translate                # Now works on loaded results
\`\`\`

## Specifying Files

You can specify files directly with any command:

\`\`\`
@astra /translate files: FEDIN.tal, FEDOUT.tal
@astra /describe files: payment-validator.c
@astra /fediso files: wire-msg.tal, fed-parse.tal
\`\`\`

## Command Chaining

Run multiple operations in sequence:

\`\`\`
@astra /find account validation then /translate then /fediso
@astra /find FEDIN then /describe then /requirements
\`\`\`

## Using Previous Results

Commands without arguments use the last \`/find\` results:

\`\`\`
@astra /find FEDIN              # Find code first
@astra /translate               # Translate what was found
@astra /fediso                  # Apply ISO uplift to same code
\`\`\`

## General Queries

Without a command, AstraCode answers code questions:

- \`@astra who calls heap_insert\`
- \`@astra explain partition pruning\`
- \`@astra find usages of validateTransaction\`

## Workflow Example

\`\`\`
@astra /find account validation      # Step 1: Find relevant code
@astra /describe                     # Step 2: Understand it
@astra /requirements                 # Step 3: Extract requirements
@astra /translate                    # Step 4: Convert to Java
@astra /fediso                       # Step 5: Apply ISO 20022 mapping
@astra /history                      # View all your queries
@astra /use #1                       # Go back to step 1 results
\`\`\`
`;

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    // Describe
    DESCRIBE_SYSTEM_PROMPT,
    getDescribeUserPrompt,
    
    // Translate
    TRANSLATE_SYSTEM_PROMPT,
    getTranslateUserPrompt,
    
    // FedISO
    FEDISO_SYSTEM_PROMPT,
    getFedIsoUserPrompt,
    
    // Requirements
    REQUIREMENTS_SYSTEM_PROMPT,
    getRequirementsUserPrompt,
    
    // General
    GENERAL_SYSTEM_PROMPT,
    getGeneralUserPrompt,
    
    // Help
    HELP_TEXT
};
