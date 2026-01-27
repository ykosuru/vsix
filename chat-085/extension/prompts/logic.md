# Business Logic Extraction Instructions

## Purpose

Extract ALL business logic from the provided code. Be exhaustive - do not skip any logic.

---

## Output Format

**CRITICAL: Only include sections that have actual content. SKIP sections entirely if nothing was found.**

Use this structure (include only non-empty sections):

```
## Business Logic: [Functionality Name]

### Input Processing
[Only if inputs are received/parsed/validated]

- **Input:** [field/parameter] - [type] - [validation rules]

### Validations & Preconditions
[Only if validation checks exist]

| # | Field/Condition | Rule | Error if Failed |
|---|----------------|------|-----------------|
| V1 | [field] | [must be / must not be] | [error code/message] |

### Conditional Logic
[Only if if/then/else branching exists]

- **C1:** IF [condition] THEN [outcome]
- **C2:** IF [condition] THEN [outcome] ELSE [outcome]

### Switch/Case Logic
[Only if switch statements exist]

SWITCH [variable]
    CASE [value1]: [action]
    CASE [value2]: [action]
    DEFAULT: [action]

### Calculations & Transformations
[Only if calculations/formulas exist]

| # | Calculation | Formula | Notes |
|---|-------------|---------|-------|
| CALC1 | [name] | [formula/expression] | [when applied] |

### Data Manipulations
[Only if string/array/data operations exist]

- **M1:** [operation] - [description]

### Loops & Iterations
[Only if loops exist - skip if no loops found]

- **L1:** FOR EACH [item] IN [collection]: [action]

### External System Calls
[Only if external API/DB/service calls exist]

| System | Operation | Request | Expected Response |
|--------|-----------|---------|-------------------|
| [system name] | [GET/POST/etc] | [payload] | [response] |

### Response Code Handling
[Only if response/status code handling exists]

| Source | Code/Status | Meaning | Action Taken |
|--------|-------------|---------|--------------|
| [system] | [code] | [meaning] | [action] |

### Exception Handling
[Only if try/catch/error handling exists - skip if none found]

| Exception Type | Trigger Condition | Handling Action |
|----------------|-------------------|-----------------|
| [exception] | [when thrown] | [catch action] |

### Output Processing
[Only if results are formatted/returned/persisted]

- **Output:** [field/response] - [type] - [format/destination]

### State Changes
[Only if database/file/state modifications exist]

| Entity | Operation | Condition |
|--------|-----------|-----------|
| [table/file] | [INSERT/UPDATE/DELETE] | [when] |

### Business Rules Summary
[Always include if any rules were found]

| Rule ID | Rule Description | Source (file:line) |
|---------|------------------|-------------------|
| BR-001 | [rule] | [location] |
```

---

## CRITICAL OUTPUT RULES

1. **SKIP EMPTY SECTIONS:** Do NOT output a section header if there's nothing to put under it
2. **No placeholders:** Never write "None found" or "N/A" - just omit the section
3. **No empty tables:** If a table would have zero rows, don't include it
4. **Quality over quantity:** Only include meaningful, actionable logic

**BAD (don't do this):**
```
### Loops & Iterations
None found.

### Exception Handling
N/A
```

**GOOD (do this):**
```
[Section simply not included because no loops/exceptions were found]
```

---

## Extraction Guidelines

1. **Be Exhaustive:** Extract EVERY piece of logic that EXISTS
2. **Include Edge Cases:** Capture all boundary conditions
3. **Trace to Source:** Reference file:line numbers where possible
4. **Preserve Intent:** Explain WHAT the logic does and WHY
5. **Skip Empty:** If a category has no findings, don't mention it
