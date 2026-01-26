# ISO 20022 camt.053 - BankToCustomerStatement

## Message Overview
- **Message ID:** camt.053.001.08
- **Name:** BankToCustomerStatement
- **Purpose:** Bank to customer account statement

## Complete Schema

### GroupHeader (GrpHdr) - REQUIRED
```java
public class GroupHeader {
    String messageId;               // MsgId - max 35 chars - REQUIRED
    LocalDateTime creationDateTime; // CreDtTm - REQUIRED
    PartyIdentification messageRecipient; // MsgRcpt (optional)
    Pagination messagePagination;   // MsgPgntn (optional)
    String originalBusinessQuery;   // OrgnlBizQry (optional)
    String additionalInformation;   // AddtlInf (optional)
}
```

### Statement (Stmt) - REQUIRED (1..n)
```java
public class Statement {
    String id;                      // Id - max 35 chars - REQUIRED
    int statementPagination;        // StmtPgntn (optional)
    int electronicSequenceNumber;   // ElctrncSeqNb (optional)
    int reportingSequence;          // RptgSeq (optional)
    int legalSequenceNumber;        // LglSeqNb (optional)
    LocalDateTime creationDateTime; // CreDtTm (optional)
    DateTimePeriod fromToDate;      // FrToDt (optional)
    ReportingSource reportingSource; // RptgSrc (optional)
    CashAccount account;            // Acct - REQUIRED
    CashAccount relatedAccount;     // RltdAcct (optional)
    List<CashBalance> balance;      // Bal - REQUIRED
    TotalTransactions transactionsSummary; // TxsSummry (optional)
    List<ReportEntry> entry;        // Ntry (0..n)
    String additionalStatementInformation; // AddtlStmtInf (optional)
}
```

### CashBalance (Bal) - REQUIRED
```java
public class CashBalance {
    BalanceType type;               // Tp - REQUIRED
    CreditLine creditLine;          // CdtLine (optional)
    ActiveOrHistoricCurrencyAndAmount amount; // Amt - REQUIRED
    CreditDebitCode creditDebitIndicator; // CdtDbtInd - REQUIRED
    LocalDate date;                 // Dt - REQUIRED
    List<CashBalanceAvailability> availability; // Avlbty (optional)
}

public class BalanceType {
    BalanceType codeOrProprietary;  // CdOrPrtry
    BalanceSubType subType;         // SubTp (optional)
}

public enum BalanceTypeCode {
    OPBD, // Opening Booked
    CLBD, // Closing Booked
    OPAV, // Opening Available
    CLAV, // Closing Available
    FWAV, // Forward Available
    PRCD, // Previously Closed Booked
    ITBD, // Interim Booked
    ITAV, // Interim Available
    INFO  // Information
}
```

### ReportEntry (Ntry)
```java
public class ReportEntry {
    String entryReference;          // NtryRef - max 35 chars (optional)
    ActiveOrHistoricCurrencyAndAmount amount; // Amt - REQUIRED
    CreditDebitCode creditDebitIndicator; // CdtDbtInd - REQUIRED
    EntryStatus status;             // Sts - REQUIRED
    DateAndDateTime bookingDate;    // BookgDt (optional)
    DateAndDateTime valueDate;      // ValDt (optional)
    String accountServicerReference; // AcctSvcrRef - max 35 chars (optional)
    List<CashBalanceAvailability> availability; // Avlbty (optional)
    BankTransactionCode bankTransactionCode; // BkTxCd - REQUIRED
    boolean reversalIndicator;      // RvslInd (optional)
    List<EntryDetails> entryDetails; // NtryDtls (optional)
    String additionalEntryInformation; // AddtlNtryInf - max 500 chars (optional)
}

public class EntryStatus {
    EntryStatusCode code;           // Cd - BOOK, PDNG, INFO, FUTR
    String proprietary;             // Prtry
}

public enum EntryStatusCode {
    BOOK, // Booked
    PDNG, // Pending
    INFO, // Information
    FUTR  // Future
}
```

### EntryDetails (NtryDtls)
```java
public class EntryDetails {
    BatchInformation batch;         // Btch (optional)
    List<TransactionDetails> transactionDetails; // TxDtls (optional)
}
```

### TransactionDetails (TxDtls)
```java
public class TransactionDetails {
    TransactionReferences references; // Refs (optional)
    ActiveOrHistoricCurrencyAndAmount amount; // Amt (optional)
    CreditDebitCode creditDebitIndicator; // CdtDbtInd (optional)
    AmountAndCurrencyExchange amountDetails; // AmtDtls (optional)
    List<ChargesInformation> charges; // Chrgs (optional)
    String instructedAmount;        // InstdAmt (optional)
    CurrencyExchange currencyExchange; // CcyXchg (optional)
    TransactionParties relatedParties; // RltdPties (optional)
    TransactionAgents relatedAgents; // RltdAgts (optional)
    LocalInstrument localInstrument; // LclInstrm (optional)
    Purpose purpose;                // Purp (optional)
    RemittanceInformation remittanceInformation; // RmtInf (optional)
    String additionalTransactionInformation; // AddtlTxInf (optional)
}
```

### TransactionReferences
```java
public class TransactionReferences {
    MessageIdentification messageId; // MsgId (optional)
    String accountServicerReference; // AcctSvcrRef (optional)
    String paymentInformationId;    // PmtInfId (optional)
    String instructionId;           // InstrId (optional)
    String endToEndId;              // EndToEndId (optional)
    String transactionId;           // TxId (optional)
    String mandateId;               // MndtId (optional)
    String chequeNumber;            // ChqNb (optional)
    String clearingSystemReference; // ClrSysRef (optional)
    String accountOwnerTransactionId; // AcctOwnrTxId (optional)
    String accountServicerTransactionId; // AcctSvcrTxId (optional)
    String marketInfrastructureTransactionId; // MktInfrstrctrTxId (optional)
    String processingId;            // PrcgId (optional)
    List<ProprietaryReference> proprietary; // Prtry (optional)
}
```

### BankTransactionCode
```java
public class BankTransactionCode {
    BankTransactionCodeStructure domain; // Domn (optional)
    ProprietaryBankTransactionCode proprietary; // Prtry (optional)
}

public class BankTransactionCodeStructure {
    String domainCode;              // Cd - e.g., PMNT
    BankTransactionCodeFamily family; // Fmly
}

public class BankTransactionCodeFamily {
    String familyCode;              // Cd - e.g., RCDT (Received Credit Transfers)
    String subFamilyCode;           // SubFmlyCd - e.g., ESCT (SCT)
}
```

## XML Namespace
```
urn:iso:std:iso:20022:tech:xsd:camt.053.001.08
```
