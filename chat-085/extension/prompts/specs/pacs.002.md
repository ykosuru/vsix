# ISO 20022 pacs.002 - FIToFIPaymentStatusReport

## Message Overview
- **Message ID:** pacs.002.001.10
- **Name:** FIToFIPaymentStatusReport
- **Purpose:** Payment status report from FI to FI

## Complete Schema

### GroupHeader (GrpHdr) - REQUIRED
```java
public class GroupHeader {
    String messageId;               // MsgId - max 35 chars
    LocalDateTime creationDateTime; // CreDtTm
    BranchAndFinancialInstitution instructingAgent; // InstgAgt
    BranchAndFinancialInstitution instructedAgent;  // InstdAgt
}
```

### OriginalGroupInformationAndStatus (OrgnlGrpInfAndSts)
```java
public class OriginalGroupInformationAndStatus {
    String originalMessageId;           // OrgnlMsgId - max 35 chars
    String originalMessageNameId;       // OrgnlMsgNmId - e.g., "pacs.008.001.08"
    String originalCreationDateTime;    // OrgnlCreDtTm
    String originalNumberOfTransactions; // OrgnlNbOfTxs
    BigDecimal originalControlSum;      // OrgnlCtrlSum
    TransactionGroupStatus groupStatus; // GrpSts
    List<StatusReasonInformation> statusReasonInformation; // StsRsnInf
    int numberOfTransactionsPerStatus;  // NbOfTxsPerSts
}
```

### TransactionInformationAndStatus (TxInfAndSts)
```java
public class TransactionInformationAndStatus {
    String statusId;                    // StsId - max 35 chars
    String originalInstructionId;       // OrgnlInstrId
    String originalEndToEndId;          // OrgnlEndToEndId
    String originalTransactionId;       // OrgnlTxId
    String originalUetr;                // OrgnlUETR
    TransactionIndividualStatus transactionStatus; // TxSts - ACCP, ACSP, ACSC, ACTC, RJCT, PDNG
    List<StatusReasonInformation> statusReasonInformation;
    ChargesInformation chargesInformation;
    LocalDateTime acceptanceDateTime;   // AccptncDtTm
    AccountIdentification debtorAccount; // DbtrAcctSvcr
    AccountIdentification creditorAccount; // CdtrAcctSvcr
    LocalDate effectiveInterbankSettlementDate; // FctvIntrBkSttlmDt
    ActiveCurrencyAndAmount interbankSettlementAmount; // IntrBkSttlmAmt
}
```

### StatusReasonInformation
```java
public class StatusReasonInformation {
    PartyIdentification originator;     // Orgtr
    StatusReason reason;                // Rsn
    List<String> additionalInformation; // AddtlInf - max 105 chars each
}

public class StatusReason {
    ExternalStatusReason code;          // Cd - external code
    String proprietary;                 // Prtry - max 35 chars
}
```

## Status Codes
```java
public enum TransactionIndividualStatus {
    ACCP, // Accepted Customer Profile
    ACSP, // Accepted Settlement In Progress
    ACSC, // Accepted Settlement Completed
    ACTC, // Accepted Technical Validation
    ACWC, // Accepted With Change
    PDNG, // Pending
    RCVD, // Received
    RJCT  // Rejected
}

// Common rejection codes
public enum ExternalStatusReason {
    AC01, // Incorrect Account Number
    AC04, // Closed Account
    AC06, // Blocked Account
    AG01, // Transaction Forbidden
    AG02, // Invalid Bank Operation Code
    AM01, // Zero Amount
    AM02, // Not Allowed Amount
    AM03, // Not Allowed Currency
    AM04, // Insufficient Funds
    AM05, // Duplication
    BE01, // Inconsistent With End Customer
    CURR, // Incorrect Currency
    CUST, // Requested By Customer
    MS03, // Not Specified Reason Agent Generated
    NARR, // Narrative (see additional info)
    RC01, // Bank Identifier Incorrect
    TM01  // Invalid Cut Off Time
}
```
