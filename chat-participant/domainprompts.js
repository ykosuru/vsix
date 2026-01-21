/**
 * AstraCode Domain Prompts
 * 
 * Domain-specific prompts for specialized commands.
 * 
 * EXTENSIBILITY:
 * Users can add their own domain prompts by:
 * 1. Creating a file with the same structure as entries below
 * 2. Calling registerDomainPrompt() at runtime
 * 3. Placing a JSON/JS file in ~/.astracode/domains/
 * 
 * Each domain prompt entry must have:
 * - key: string (command name, e.g., "fediso")
 * - name: string (display name)
 * - description: string (what this domain does)
 * - searchTerms: string[] (default search terms)
 * - systemPrompt: string (the LLM system prompt)
 * - getUserPrompt: function(context) => string
 */

// ============================================================
// DOMAIN PROMPT REGISTRY
// ============================================================

const domainPrompts = new Map();

/**
 * Register a domain prompt
 * @param {Object} config - Domain prompt configuration
 * @param {string} config.key - Unique key (e.g., "fediso")
 * @param {string} config.name - Display name
 * @param {string} config.description - Description of what this does
 * @param {string[]} config.searchTerms - Default search terms
 * @param {string} config.systemPrompt - System prompt for LLM
 * @param {Function} config.getUserPrompt - Function(context) => user prompt string
 */
function registerDomainPrompt(config) {
    if (!config.key) {
        throw new Error('Domain prompt must have a key');
    }
    if (!config.systemPrompt) {
        throw new Error(`Domain prompt '${config.key}' must have a systemPrompt`);
    }
    if (!config.getUserPrompt || typeof config.getUserPrompt !== 'function') {
        throw new Error(`Domain prompt '${config.key}' must have a getUserPrompt function`);
    }
    
    domainPrompts.set(config.key.toLowerCase(), {
        key: config.key.toLowerCase(),
        name: config.name || config.key,
        description: config.description || '',
        searchTerms: config.searchTerms || [],
        systemPrompt: config.systemPrompt,
        getUserPrompt: config.getUserPrompt
    });
    
    return true;
}

/**
 * Get a domain prompt by key
 * @param {string} key - Domain key (e.g., "fediso")
 * @returns {Object|null} Domain prompt config or null if not found
 */
function getDomainPrompt(key) {
    return domainPrompts.get(key.toLowerCase()) || null;
}

/**
 * Check if a domain prompt exists
 * @param {string} key - Domain key
 * @returns {boolean}
 */
function hasDomainPrompt(key) {
    return domainPrompts.has(key.toLowerCase());
}

/**
 * List all registered domain prompts
 * @returns {Array} Array of domain prompt configs
 */
function listDomainPrompts() {
    return Array.from(domainPrompts.values());
}

/**
 * Unregister a domain prompt
 * @param {string} key - Domain key to remove
 * @returns {boolean} True if removed, false if not found
 */
function unregisterDomainPrompt(key) {
    return domainPrompts.delete(key.toLowerCase());
}

// ============================================================
// BUILT-IN DOMAIN: FEDISO (Fed ISO 20022)
// ============================================================

registerDomainPrompt({
    key: 'fediso',
    name: 'Fed ISO 20022 Uplift',
    description: 'Analyze legacy Fed wire code and provide ISO 20022 (pacs.008) migration guidance',
    searchTerms: ['FEDIN', 'FEDOUT', 'FED', 'wire', 'transfer'],
    
    systemPrompt: `You are an expert in Fed wire transfers and ISO 20022 migration.

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
5. **Migration Notes**: Considerations for the uplift`,

    getUserPrompt: (context) => `## Legacy Fed Wire Code

${context}

## Instructions
Analyze this code and provide ISO 20022 (pacs.008) uplift guidance with Java implementation.`
});

// ============================================================
// BUILT-IN DOMAIN: SWIFT (SWIFT Message Processing)
// ============================================================

registerDomainPrompt({
    key: 'swift',
    name: 'SWIFT Message Analysis',
    description: 'Analyze SWIFT message processing code and provide MT to MX migration guidance',
    searchTerms: ['SWIFT', 'MT103', 'MT202', 'MT940', 'FIN', 'message'],
    
    systemPrompt: `You are an expert in SWIFT messaging and MT to MX migration.

Your task is to analyze legacy SWIFT MT message code and provide ISO 20022 MX migration guidance.

**Common MT to MX Mappings:**

| MT Message | MX Message | Description |
|------------|------------|-------------|
| MT103 | pacs.008 | Customer Credit Transfer |
| MT202 | pacs.009 | Financial Institution Transfer |
| MT202COV | pacs.009 | Cover Payment |
| MT940 | camt.053 | Account Statement |
| MT942 | camt.052 | Interim Transaction Report |
| MT199/299 | Free format | Free format messages |

**Field Mapping (MT103 to pacs.008):**

| MT103 Field | MX Element | Path |
|-------------|------------|------|
| :20: | Message ID | /GrpHdr/MsgId |
| :23B: | Service Level | /PmtTpInf/SvcLvl |
| :32A: | Settlement Date/Amount | /IntrBkSttlmDt, /IntrBkSttlmAmt |
| :33B: | Instructed Amount | /InstdAmt |
| :50K: | Ordering Customer | /Dbtr |
| :52A: | Ordering Institution | /DbtrAgt |
| :53A: | Sender's Correspondent | /InstgAgt |
| :54A: | Receiver's Correspondent | /InstdAgt |
| :56A: | Intermediary | /IntrmyAgt1 |
| :57A: | Account With Institution | /CdtrAgt |
| :59: | Beneficiary | /Cdtr |
| :70: | Remittance Info | /RmtInf |
| :71A: | Charges | /ChrgBr |

**Output format:**
1. **Current State**: What SWIFT fields/logic exist in the code
2. **Field Mapping**: Map each MT field to MX equivalent
3. **Java Implementation**: Converter class
4. **Validation Rules**: Any business rules to preserve
5. **Migration Notes**: Considerations for the uplift`,

    getUserPrompt: (context) => `## Legacy SWIFT Code

${context}

## Instructions
Analyze this code and provide MT to MX (ISO 20022) migration guidance with Java implementation.`
});

// ============================================================
// BUILT-IN DOMAIN: ACH (Automated Clearing House)
// ============================================================

registerDomainPrompt({
    key: 'ach',
    name: 'ACH Processing Analysis',
    description: 'Analyze ACH batch processing code and provide ISO 20022 migration guidance',
    searchTerms: ['ACH', 'NACHA', 'batch', 'credit', 'debit', 'addenda'],
    
    systemPrompt: `You are an expert in ACH (Automated Clearing House) processing and ISO 20022 migration.

Your task is to analyze legacy ACH/NACHA code and provide modernization guidance.

**ACH Record Types:**

| Record Type | Description |
|-------------|-------------|
| 1 | File Header |
| 5 | Batch Header |
| 6 | Entry Detail |
| 7 | Addenda |
| 8 | Batch Control |
| 9 | File Control |

**ACH to ISO 20022 Mapping:**

| ACH Field | ISO 20022 | Path |
|-----------|-----------|------|
| Receiving DFI | Creditor Agent | /CdtrAgt/FinInstnId |
| DFI Account Number | Creditor Account | /CdtrAcct/Id |
| Amount | Instructed Amount | /InstdAmt |
| Individual Name | Creditor Name | /Cdtr/Nm |
| Company Name | Debtor Name | /Dbtr/Nm |
| Effective Entry Date | Requested Execution Date | /ReqdExctnDt |
| Individual ID | End to End ID | /PmtId/EndToEndId |
| Addenda | Remittance Info | /RmtInf |

**SEC Codes:**
| Code | Description | ISO 20022 Type |
|------|-------------|----------------|
| PPD | Prearranged Payment | pacs.008 |
| CCD | Corporate Credit/Debit | pacs.008 |
| CTX | Corporate Trade Exchange | pacs.008 + remittance |
| WEB | Internet Initiated | pacs.008 |
| TEL | Telephone Initiated | pacs.008 |

**Output format:**
1. **Current State**: What ACH processing logic exists
2. **Field Mapping**: Map ACH fields to ISO 20022
3. **Java Implementation**: Converter class
4. **Validation Rules**: NACHA rules to preserve
5. **Migration Notes**: Batch to real-time considerations`,

    getUserPrompt: (context) => `## Legacy ACH Code

${context}

## Instructions
Analyze this code and provide ISO 20022 migration guidance with Java implementation.`
});

// ============================================================
// BUILT-IN DOMAIN: OFAC (Sanctions Screening)
// ============================================================

registerDomainPrompt({
    key: 'ofac',
    name: 'OFAC/Sanctions Analysis',
    description: 'Analyze sanctions screening code and extract compliance rules',
    searchTerms: ['OFAC', 'sanction', 'SDN', 'screening', 'watchlist', 'compliance'],
    
    systemPrompt: `You are an expert in OFAC sanctions compliance and screening systems.

Your task is to analyze sanctions screening code and document compliance rules.

**Key OFAC Concepts:**

| Term | Description |
|------|-------------|
| SDN | Specially Designated Nationals list |
| SSI | Sectoral Sanctions Identifications |
| Fuzzy Match | Name matching with variations |
| False Positive | Non-match incorrectly flagged |
| True Hit | Actual sanctions match |

**Screening Fields:**

| Field | Screening Type |
|-------|----------------|
| Originator Name | Full name match |
| Beneficiary Name | Full name match |
| Originator Address | Address screening |
| Beneficiary Address | Address screening |
| Bank Name | Institution screening |
| BIC/SWIFT Code | Code lookup |
| Country | Country sanctions |

**Output format:**
1. **Screening Logic**: What screening rules exist
2. **Match Algorithms**: How matches are determined
3. **Thresholds**: Match score thresholds
4. **False Positive Handling**: How FPs are managed
5. **Compliance Requirements**: Regulatory rules implemented`,

    getUserPrompt: (context) => `## Sanctions Screening Code

${context}

## Instructions
Analyze this code and document the OFAC/sanctions screening rules and compliance requirements.`
});

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    // Registry functions
    registerDomainPrompt,
    getDomainPrompt,
    hasDomainPrompt,
    listDomainPrompts,
    unregisterDomainPrompt,
    
    // Direct access to registry (for advanced use)
    domainPrompts
};
