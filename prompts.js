/**
 * AstraCode Prompt Library v5.6 - FULLY GENERIC & CLEAN
 * 
 * - No domain-specific assumptions (PostgreSQL removed)
 * - Works for any codebase: C/C++, Rust, Java, Go, etc.
 * - Strong grounding with positive/negative examples
 * - Code-first philosophy: show actual code snippets
 * - Two-phase extraction support
 * - Data structures prioritized
 * - Verified call chains only
 */

const GROUNDING_RULES = `
## CRITICAL: CODE-GROUNDED ANSWERS ONLY

### REQUIRED for every claim:
- Cite exact location: \`function_name()\` in file.c:123
- Show actual code snippet (not paraphrase)
- Quote variable names, struct fields, return types exactly

### EVIDENCE HIERARCHY (strongest to weakest):
1. Actual code snippet with line number
2. Function signature from the code
3. Comment in the code
4. File/function naming pattern

### WHEN EVIDENCE IS MISSING:
- Write: "No evidence found in provided code for [specific aspect]"
- DO NOT use: "typically", "usually", "probably", "in most implementations"
- DO NOT invent function names or behavior

### EXAMPLE OF GOOD CITATION:
"The legality check occurs in \`is_valid_join()\` at relations.c:354:
\`\`\`c
static bool
is_valid_join(Context *ctx, Relation *a, Relation *b, JoinInfo *info)
{
    foreach(node, ctx->constraints)
    ...
}
\`\`\`
This function validates join constraints by iterating over the context's constraint list."

### EXAMPLE OF BAD CITATION (DO NOT DO THIS):
"The is_valid_join() function usually checks if joins are allowed."
^ Missing: file location, line number, actual code, specific mechanism
`;

const ALGORITHM_GUIDANCE = `
## MANDATORY STRUCTURE FOR "HOW/EXPLAIN/DESCRIBE" QUESTIONS

You are analyzing source code to explain how something works. Think step-by-step.
CRITICAL: Show actual code, not summaries of what code "does".

### SECTION 1: Quick Summary (2-3 sentences)
What does this feature do? One paragraph, grounded in visible code.

### SECTION 2: Key Data Structures (SHOW FIRST)
Before explaining the algorithm, show the data structures it operates on.
\`\`\`c
// From state.h:42
typedef struct SystemState {
    int active_count;
    void *context;
    List *connections;
    ...
} SystemState;
\`\`\`
Explain: What does each key field store? How is it used?

### SECTION 3: Entry Points and Call Flow
Show the ACTUAL call chain from code (not assumed):
\`\`\`
Entry: main() in main.c:100
  └─► initialize_system() in init.c:200
      └─► create_context() in context.c:500
\`\`\`
For each function, cite file:line and show its signature.

### SECTION 4: Core Algorithm Steps
For each step, show ACTUAL code:

**Step 1: [Phase Name]**
Purpose: What this step accomplishes
Location: \`function()\` in file.c:line
\`\`\`c
// Actual code from the file - not paraphrased
actual_code_here();
\`\`\`
Explanation: What the code does and why

**Step 2: [Phase Name]**
...continue pattern...

### SECTION 5: Key Functions Reference
| Function | File:Line | Purpose | Inputs → Outputs |
|----------|-----------|---------|------------------|
| create_context() | context.c:500 | Initialize core state | (config) → Context* |

### SECTION 6: Validation & Error Handling
Show actual error checks from code:
\`\`\`c
// From file.c:123
if (ptr == NULL)
    return ERROR_NULL_POINTER;
\`\`\`

### SECTION 7: Key Insights / Notes
- Any optimizations visible in code
- Limitations noted in comments
- Areas where code is incomplete in provided context

## CRITICAL REMINDERS:
1. EVERY claim needs file:line citation
2. Show CODE SNIPPETS, not prose summaries  
3. Distinguish configuration/setup code from core execution logic when relevant
4. If you see only headers, say "Implementation not in provided code"
5. Empty sections = "No evidence in provided code" (don't skip)
`;

// Single, clean JSON extraction prompt (no PostgreSQL)
const JSON_EXTRACTION_PROMPT = (findings, question, subQuestions) => `## FINDINGS FROM CODE ANALYSIS
${findings}

## ORIGINAL QUESTION
${question}

## SUB-QUESTIONS
${subQuestions.map((sq, i) => `${i+1}. ${sq}`).join('\n')}

## TASK: Extract Structured Facts

Output ONLY valid JSON. Extract ACTUAL data from findings - do not invent.

{
  "summary": "2-3 sentences describing what the code does based on evidence",
  
  "data_structures": [
    {
      "name": "StructName",
      "file": "file.h",
      "line": 42,
      "purpose": "what it represents",
      "key_fields": ["field1: usage", "field2: usage"]
    }
  ],
  
  "entry_points": [
    {
      "function": "func_name",
      "file": "file.c",
      "line": 100,
      "called_from": "where it's invoked or 'external API'"
    }
  ],
  
  "key_functions": [
    {
      "name": "function_name",
      "file": "file.c",
      "line": 200,
      "signature": "ReturnType func(Arg1, Arg2)",
      "purpose": "what it does",
      "key_logic": "brief description of algorithm"
    }
  ],
  
  "call_flow": [
    {
      "caller": "func_a",
      "callee": "func_b",
      "file": "file.c",
      "line": 150,
      "call_code": "actual line of code making the call"
    }
  ],
  
  "key_files": [
    {
      "file": "filename.c",
      "purpose": "what this file implements",
      "main_functions": ["func1", "func2"]
    }
  ],
  
  "answers": [
    {
      "question": "sub-question text",
      "answer": "answer with specifics from code",
      "evidence": ["file.c:123", "other.c:456"]
    }
  ],
  
  "notes": ["limitations", "areas needing more code"]
}

## CRITICAL RULES:
1. Output ONLY JSON - no markdown, no text before/after
2. Start with { end with }
3. Extract REAL data - never invent function names or line numbers
4. SKIP build files: Makefile, CMakeLists.txt, meson.build, README
5. Empty array [] if no data for a category

BEGIN JSON:`;

// Optional: Code extraction prompt (if used in chunk analysis)
const CODE_EXTRACTION_PROMPT = `
## TASK: Extract Code Evidence

From the provided code context, extract ACTUAL CODE relevant to the question.
Do not summarize - copy the exact code with its location.

### OUTPUT FORMAT (JSON):
{
  "data_structures": [ /* same format as above */ ],
  "functions": [ /* same format as above */ ],
  "call_chains": [ /* same format as above */ ],
  "error_checks": [ /* same format as above */ ]
}

RULES:
1. Only include code ACTUALLY PRESENT
2. Copy code verbatim
3. Include line numbers
4. Empty array [] if no findings
`;

// System Prompts
const SystemPrompts = {
    default: () => `You are AstraCode, an expert code analyst. You explain code by SHOWING code.

${GROUNDING_RULES}

## RESPONSE PRINCIPLES
1. Lead with code snippets, not prose
2. Every claim → file:line citation
3. Data structures before algorithms
4. Call chains must show actual call sites
5. "No evidence" is better than invention`,

    strictGrounding: () => `Code analyst in STRICT MODE.

${GROUNDING_RULES}

Show code. Cite lines. No assumptions.`
};

// Query Prompts
const QueryPrompts = {
    directQuestion: (context, indexSummary, query) => {
        const isHowQuestion = /\b(how|explain|describe|what happens|walk.?through|detail|analyze|mechanism|implementation|algorithm|process)\b/i.test(query);
        
        return `## CODE CONTEXT
${context}

## CODE INDEX
${indexSummary}

## QUESTION
${query}

${GROUNDING_RULES}

${isHowQuestion ? ALGORITHM_GUIDANCE : `
## ANSWER REQUIREMENTS
1. Direct answer in first sentence
2. Code snippet showing evidence
3. File:line citation
4. If not found: "No evidence in provided code"
`}

Your response:`;
    },

    synthesize: (query, combinedAnalyses) => {
        const isHowQuestion = /\b(how|explain|describe|what happens|walk.?through|detail|analyze|mechanism|implementation|algorithm|process)\b/i.test(query);

        return `## TASK: Synthesize Final Answer

${GROUNDING_RULES}

${isHowQuestion ? ALGORITHM_GUIDANCE : ''}

## Question
${query}

## Combined Findings
${combinedAnalyses}

## RULES
1. Merge duplicates, prioritize execution logic
2. ${isHowQuestion ? 'FOLLOW MANDATORY STRUCTURE EXACTLY' : 'Answer clearly and directly'}
3. Keep file:line citations
4. Show actual code snippets
5. No generic claims without evidence

Final answer:`;
    },

    analyzeChunk: (context, query, chunkNum, totalChunks) => `## Code Chunk ${chunkNum}/${totalChunks}
${context}

## Question
${query}

## TASK: Extract Evidence
Extract ACTUAL CODE relevant to the question. Do not summarize.

### For functions:
\`\`\`
FUNCTION: function_name()
FILE: filename.c:line
SIGNATURE: return_type function_name(params)
KEY CODE:
[paste actual code block]
PURPOSE: what this code does
CALLS: called functions (with file:line if visible)
CALLED BY: callers (if visible)
\`\`\`

### For data structures:
\`\`\`
STRUCT: StructName
FILE: header.h:line
DEFINITION:
[paste actual struct]
KEY FIELDS:
- field1: purpose
- field2: purpose
\`\`\`

### RULES:
- Copy code VERBATIM
- Include line numbers
- Skip build files (Makefile, README, etc.)
- If irrelevant: "No relevant code for this question"

Extracted evidence:`,

    general: (context, query) => `## CODE
${context}

## QUESTION
${query}

${GROUNDING_RULES}

Answer with code evidence:`
};

// Tool & Summary Prompts unchanged from your v5.5 (they were already good)
const ToolPrompts = { /* ... your existing ToolPrompts */ };
const SummaryPrompts = { /* ... your existing SummaryPrompts */ };
const NotFoundResponses = { /* ... your existing NotFoundResponses */ };

// Main Export
const PromptLibrary = {
    system: SystemPrompts,
    query: QueryPrompts,
    tools: ToolPrompts,
    summary: SummaryPrompts,
    notFound: NotFoundResponses,
    
    GROUNDING_RULES,
    ALGORITHM_GUIDANCE,
    CODE_EXTRACTION_PROMPT,
    JSON_EXTRACTION_PROMPT,
    
    get(path) {
        const parts = path.split('.');
        let current = this;
        for (const part of parts) {
            current = current[part];
            if (!current) throw new Error(`Prompt not found: ${path}`);
        }
        return current;
    },
    
    list() {
        const paths = [];
        const traverse = (obj, prefix = '') => {
            for (const key of Object.keys(obj)) {
                if (['get', 'list', 'GROUNDING_RULES', 'ALGORITHM_GUIDANCE', 'CODE_EXTRACTION_PROMPT', 'JSON_EXTRACTION_PROMPT'].includes(key)) continue;
                const path = prefix ? `${prefix}.${key}` : key;
                if (typeof obj[key] === 'function') {
                    paths.push(path);
                } else if (typeof obj[key] === 'object' && obj[key] !== null) {
                    traverse(obj[key], path);
                }
            }
        };
        traverse(this);
        return paths;
    }
};

module.exports = {
    PromptLibrary,
    SystemPrompts,
    QueryPrompts,
    ToolPrompts,
    SummaryPrompts,
    NotFoundResponses,
    GROUNDING_RULES,
    ALGORITHM_GUIDANCE,
    CODE_EXTRACTION_PROMPT,
    JSON_EXTRACTION_PROMPT
};

