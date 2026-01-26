# ISO 20022 pacs.008 - FIToFICustomerCreditTransfer

## Message Overview
- **Message ID:** pacs.008.001.08
- **Name:** FIToFICustomerCreditTransfer
- **Purpose:** Financial institution to financial institution customer credit transfer

## Complete Schema

### Root Element
```
Document/FIToFICstmrCdtTrf
```

### GroupHeader (GrpHdr) - REQUIRED
```java
public class GroupHeader {
    String messageId;           // MsgId - Unique message identifier (max 35 chars)
    LocalDateTime creationDateTime; // CreDtTm - Message creation timestamp
    int numberOfTransactions;   // NbOfTxs - Number of transactions in message
    BigDecimal controlSum;      // CtrlSum - Total amount (optional)
    SettlementInformation settlementInformation; // SttlmInf
    PaymentTypeInformation paymentTypeInformation; // PmtTpInf (optional)
    InstructingAgent instructingAgent; // InstgAgt (optional)
    InstructedAgent instructedAgent;   // InstdAgt (optional)
}
```

### SettlementInformation (SttlmInf) - REQUIRED
```java
public class SettlementInformation {
    SettlementMethod settlementMethod; // SttlmMtd - INDA, INGA, COVE, CLRG
    SettlementAccount settlementAccount; // SttlmAcct (optional)
    ClearingSystem clearingSystem;     // ClrSys (optional)
    BranchAndFinancialInstitution instructingReimbursementAgent; // InstgRmbrsmntAgt
    BranchAndFinancialInstitution instructedReimbursementAgent;  // InstdRmbrsmntAgt
    BranchAndFinancialInstitution thirdReimbursementAgent;       // ThrdRmbrsmntAgt
}

public enum SettlementMethod {
    INDA, // Instructed Agent
    INGA, // Instructing Agent
    COVE, // Cover Method
    CLRG  // Clearing System
}
```

### CreditTransferTransactionInformation (CdtTrfTxInf) - REQUIRED (1..n)
```java
public class CreditTransferTransaction {
    // Payment Identification - REQUIRED
    PaymentIdentification paymentId;
    
    // Payment Type Information (optional)
    PaymentTypeInformation paymentTypeInfo;
    
    // Interbank Settlement Amount - REQUIRED
    ActiveCurrencyAndAmount interbankSettlementAmount; // IntrBkSttlmAmt
    
    // Interbank Settlement Date (optional)
    LocalDate interbankSettlementDate; // IntrBkSttlmDt
    
    // Settlement Priority (optional)
    Priority3Code settlementPriority; // SttlmPrty - HIGH, NORM
    
    // Settlement Time Indication (optional)
    SettlementTimeIndication settlementTimeIndication;
    
    // Settlement Time Request (optional)
    SettlementTimeRequest settlementTimeRequest;
    
    // Instructed Amount (optional)
    ActiveOrHistoricCurrencyAndAmount instructedAmount; // InstdAmt
    
    // Exchange Rate (optional)
    BigDecimal exchangeRate; // XchgRate
    
    // Charge Bearer - REQUIRED
    ChargeBearerType chargeBearer; // ChrgBr - DEBT, CRED, SHAR, SLEV
    
    // Charges Information (optional, 0..n)
    List<ChargesInformation> chargesInformation;
    
    // Previous Instructing Agents (optional)
    List<BranchAndFinancialInstitution> previousInstructingAgents;
    
    // Instructing Agent (optional)
    BranchAndFinancialInstitution instructingAgent;
    
    // Instructed Agent (optional)
    BranchAndFinancialInstitution instructedAgent;
    
    // Intermediary Agents (optional, up to 3)
    BranchAndFinancialInstitution intermediaryAgent1;
    BranchAndFinancialInstitution intermediaryAgent2;
    BranchAndFinancialInstitution intermediaryAgent3;
    
    // Ultimate Debtor (optional)
    PartyIdentification ultimateDebtor;
    
    // Debtor - REQUIRED
    PartyIdentification debtor;
    
    // Debtor Account (optional)
    CashAccount debtorAccount;
    
    // Debtor Agent - REQUIRED
    BranchAndFinancialInstitution debtorAgent;
    
    // Debtor Agent Account (optional)
    CashAccount debtorAgentAccount;
    
    // Creditor Agent - REQUIRED
    BranchAndFinancialInstitution creditorAgent;
    
    // Creditor Agent Account (optional)
    CashAccount creditorAgentAccount;
    
    // Creditor - REQUIRED
    PartyIdentification creditor;
    
    // Creditor Account (optional)
    CashAccount creditorAccount;
    
    // Ultimate Creditor (optional)
    PartyIdentification ultimateCreditor;
    
    // Purpose (optional)
    Purpose purpose;
    
    // Regulatory Reporting (optional, 0..10)
    List<RegulatoryReporting> regulatoryReporting;
    
    // Related Remittance Information (optional, 0..10)
    List<RemittanceLocation> relatedRemittanceInformation;
    
    // Remittance Information (optional)
    RemittanceInformation remittanceInformation;
    
    // Supplementary Data (optional)
    List<SupplementaryData> supplementaryData;
}
```

### PaymentIdentification (PmtId) - REQUIRED
```java
public class PaymentIdentification {
    String instructionId;        // InstrId - max 35 chars (optional)
    String endToEndId;           // EndToEndId - max 35 chars - REQUIRED
    String transactionId;        // TxId - max 35 chars - REQUIRED (unique)
    String uetr;                 // UETR - UUID format - REQUIRED for gpi
    String clearingSystemReference; // ClrSysRef - max 35 chars (optional)
}
```

### PartyIdentification
```java
public class PartyIdentification {
    String name;                          // Nm - max 140 chars
    PostalAddress postalAddress;          // PstlAdr
    OrganisationIdentification organisationId; // OrgId
    PrivateIdentification privateId;      // PrvtId
    String countryOfResidence;            // CtryOfRes - ISO 3166 country code
    ContactDetails contactDetails;        // CtctDtls
}
```

### PostalAddress
```java
public class PostalAddress {
    AddressType addressType;       // AdrTp
    String department;             // Dept - max 70 chars
    String subDepartment;          // SubDept - max 70 chars
    String streetName;             // StrtNm - max 70 chars
    String buildingNumber;         // BldgNb - max 16 chars
    String buildingName;           // BldgNm - max 35 chars
    String floor;                  // Flr - max 70 chars
    String postBox;                // PstBx - max 16 chars
    String room;                   // Room - max 70 chars
    String postCode;               // PstCd - max 16 chars
    String townName;               // TwnNm - max 35 chars
    String townLocationName;       // TwnLctnNm - max 35 chars
    String districtName;           // DstrctNm - max 35 chars
    String countrySubDivision;     // CtrySubDvsn - max 35 chars
    String country;                // Ctry - ISO 3166 alpha-2
    List<String> addressLine;      // AdrLine - max 7 lines, 70 chars each
}
```

### BranchAndFinancialInstitution
```java
public class BranchAndFinancialInstitution {
    FinancialInstitutionIdentification financialInstitutionId; // FinInstnId
    BranchData branchId;           // BrnchId
}

public class FinancialInstitutionIdentification {
    String bicfi;                  // BICFI - 8 or 11 chars (BIC/SWIFT)
    ClearingSystemMemberIdentification clearingSystemMemberId; // ClrSysMmbId
    String lei;                    // LEI - 20 chars
    String name;                   // Nm - max 140 chars
    PostalAddress postalAddress;   // PstlAdr
    GenericFinancialIdentification other; // Othr
}
```

### CashAccount
```java
public class CashAccount {
    AccountIdentification id;      // Id - IBAN or Other
    AccountType type;              // Tp
    String currency;               // Ccy - ISO 4217
    String name;                   // Nm - max 70 chars
    PartyIdentification proxy;     // Prxy
}

public class AccountIdentification {
    String iban;                   // IBAN - max 34 chars
    GenericAccountIdentification other; // Othr
}
```

### ActiveCurrencyAndAmount
```java
public class ActiveCurrencyAndAmount {
    String currency;               // Ccy attribute - ISO 4217 (3 chars)
    BigDecimal amount;             // Value - max 18 digits, 5 decimal places
}
```

### ChargesInformation
```java
public class ChargesInformation {
    ActiveOrHistoricCurrencyAndAmount amount; // Amt
    BranchAndFinancialInstitution agent;      // Agt
    ChargeBearerType chargeType;              // Tp (optional)
}

public enum ChargeBearerType {
    DEBT, // Debtor pays all charges
    CRED, // Creditor pays all charges
    SHAR, // Shared charges
    SLEV  // Following Service Level
}
```

### RemittanceInformation
```java
public class RemittanceInformation {
    List<String> unstructured;     // Ustrd - max 140 chars each
    List<StructuredRemittanceInformation> structured; // Strd
}

public class StructuredRemittanceInformation {
    ReferredDocumentInformation referredDocumentInformation;
    ReferredDocumentAmount referredDocumentAmount;
    CreditorReferenceInformation creditorReferenceInformation;
    PartyIdentification invoicer;
    PartyIdentification invoicee;
    TaxRemittance taxRemittance;
    Garnishment garnishmentRemittance;
    List<String> additionalRemittanceInformation; // max 3, 140 chars each
}
```

### RegulatoryReporting
```java
public class RegulatoryReporting {
    RegulatoryReportingType debitCreditReportingIndicator; // DbtCdtRptgInd
    RegulatoryAuthority authority;  // Authrty
    List<StructuredRegulatoryReporting> details; // Dtls
}
```

## Enums

```java
public enum SettlementMethod { INDA, INGA, COVE, CLRG }
public enum ChargeBearerType { DEBT, CRED, SHAR, SLEV }
public enum Priority3Code { HIGH, NORM }
public enum CreditDebitCode { CRDT, DBIT }
```

## Validation Rules

1. **MessageId** - Must be unique per sender
2. **UETR** - Must be valid UUID format (xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx)
3. **BIC** - Must be 8 or 11 characters, valid SWIFT format
4. **IBAN** - Must pass MOD-97 check
5. **Currency** - Must be valid ISO 4217 code
6. **Country** - Must be valid ISO 3166-1 alpha-2
7. **Amount** - Max 18 digits total, 5 decimal places
8. **EndToEndId** - Must be unique for tracking
9. **TransactionId** - Must be unique within message

## XML Namespace
```
urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08
```

## Sample Generation Requirements

When generating pacs.008 code:
1. Include ALL fields from schema above
2. Use proper Java types (BigDecimal for amounts, LocalDate/LocalDateTime for dates)
3. Add JSR-380 validation annotations (@NotNull, @Size, @Pattern)
4. Include JAXB annotations for XML serialization
5. Add Lombok @Data, @Builder, @NoArgsConstructor, @AllArgsConstructor
6. Create enums for all coded values
7. Add utility methods for IBAN/BIC validation
8. Include proper equals/hashCode based on business keys
