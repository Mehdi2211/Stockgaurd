# Requirements Document

## Introduction

The Cash Register Monitoring module gives shop owners a real-time view of their physical cash register. It tracks every money movement (initialization, cash sales, withdrawals, deposits, refunds, adjustments) in an append-only ledger (`cash_movements`), computes a theoretical balance at any time from that ledger plus cash sales sourced from the existing `sales` table, and lets the owner record a physical count to surface any discrepancy between theory and reality.

The feature is accessible only to users with the `OWNER` role and lives at `/owner/caisse` in the StockGuard React frontend. All monetary amounts are stored as `bigint` in millimes (1 DT = 1 000 millimes) to avoid floating-point rounding — consistent with the rest of the StockGuard schema.

## Glossary

- **Cash_Register_Page**: The React page at `/owner/caisse` that orchestrates the entire cash-register monitoring UI.
- **Cash_API**: The Express.js router mounted at `/api/cash` that handles all cash-register endpoints.
- **Cash_Movements_Table**: The append-only `cash_movements` PostgreSQL table that records every manual cash event.
- **Theoretical_Balance**: The computed expected cash amount: `SUM(cash_movements.amount WHERE type ≠ 'VERIFICATION') + SUM(sales.total WHERE customer_id IS NULL)`, both bounded to the selected period.
- **Cash_Sale**: A row in the `sales` table where `customer_id IS NULL`.
- **Credit_Sale**: A row in the `sales` table where `customer_id IS NOT NULL`. Credit sales do not affect the cash register balance.
- **Movement_Type**: One of `INITIALIZATION`, `WITHDRAWAL`, `DEPOSIT`, `CASH_REFUND`, `ADJUSTMENT`, or `VERIFICATION`.
- **Discrepancy**: The arithmetic difference between the owner's physically counted amount and the Theoretical_Balance. A discrepancy is a signal for investigation — not proof of theft.
- **Verification**: A snapshot movement of type `VERIFICATION` that records a physical count event. Its `amount` is always 0; the counted amount and discrepancy are encoded in the `description` field.
- **Millimes**: The smallest monetary unit used throughout StockGuard (1 DT = 1 000 millimes). All monetary values in the database are stored as `bigint` millimes.
- **Auth_Middleware**: The existing Express.js middleware that authenticates requests and exposes `req.shopId`, `req.userId`, and `req.role`.
- **KioskContext**: The existing React context that exposes the authenticated session (shop ID, role, etc.) to all pages.
- **Owner**: A user whose `role = 'OWNER'` in the `app_users` table.

---

## Requirements

### Requirement 1: Session Initialization

**User Story:** As an owner, I want to record an opening balance for my cash register, so that the theoretical balance calculation starts from a known, accurate baseline.

#### Acceptance Criteria

1. WHEN an owner submits an initialization action with a positive amount, THE Cash_API SHALL insert a row of type `INITIALIZATION` with that amount into the Cash_Movements_Table and return HTTP 201 with the inserted row.
2. IF the submitted initialization amount is zero or negative, THEN THE Cash_API SHALL return HTTP 400 with a French error message.
3. WHEN an initialization row is inserted, THE Cash_API SHALL record the authenticated owner's `userId` as `admin_id` and use a server-side timestamp for `created_at` — never values from the request body.
4. WHEN no initialization movement exists for the selected period, THE Cash_Register_Page SHALL display an empty-state prompt instructing the owner to perform an initialization action.

---

### Requirement 2: Theoretical Balance Computation

**User Story:** As an owner, I want the system to automatically compute the expected cash amount in the register, so that I can compare it against my physical count without manual arithmetic.

#### Acceptance Criteria

1. WHEN the owner requests a summary for a period [from, to], THE Cash_API SHALL compute the Theoretical_Balance as `COALESCE(SUM(cash_movements.amount WHERE type ≠ 'VERIFICATION'), 0) + COALESCE(SUM(sales.total WHERE customer_id IS NULL), 0)`, both filtered to the given period and shop.
2. THE Cash_API SHALL exclude `VERIFICATION` rows from the Theoretical_Balance sum, because verifications are snapshots and not cash flows.
3. THE Cash_API SHALL exclude Credit_Sale rows (`customer_id IS NOT NULL`) from the Theoretical_Balance sum.
4. WHEN no movements or cash sales exist for the selected period, THE Cash_API SHALL return `theoreticalBalance: 0` rather than an error.
5. WHEN the owner requests a summary without specifying a period, THE Cash_API SHALL default the period to the current calendar day.

---

### Requirement 3: Cash Verification (Physical Count)

**User Story:** As an owner, I want to record a physical cash count and immediately see any discrepancy, so that I can detect and investigate shortages or surpluses in a timely manner.

#### Acceptance Criteria

1. WHEN an owner submits a verification action, THE Cash_Register_Page SHALL compute the discrepancy as `countedMillimes − theoreticalBalance` before making an API call, and display the result to the owner for confirmation.
2. WHEN `discrepancy = 0`, THE Cash_Register_Page SHALL indicate a balanced register (status `BALANCED`).
3. WHEN `discrepancy < 0`, THE Cash_Register_Page SHALL indicate a shortage (status `SHORTAGE`) and display the negative difference.
4. WHEN `discrepancy > 0`, THE Cash_Register_Page SHALL indicate a surplus (status `SURPLUS`) and display the positive difference.
5. WHEN the owner confirms a verification, THE Cash_API SHALL insert a `VERIFICATION` row with `amount = 0` and a `description` field encoding both the counted amount and the discrepancy in the format `"Comptage: {countedMillimes}, Écart: {discrepancy}"`.
6. IF a verification is submitted with `amount ≠ 0`, THEN THE Cash_API SHALL return HTTP 400 with a French error message.
7. THE Cash_Register_Page SHALL present the discrepancy as a financial signal requiring investigation — not as an accusation of theft.

---

### Requirement 4: Cash Withdrawals and Deposits

**User Story:** As an owner, I want to record withdrawals and deposits into the cash register, so that all manual cash movements are tracked and reflected in the theoretical balance.

#### Acceptance Criteria

1. WHEN an owner submits a withdrawal with a negative amount, THE Cash_API SHALL insert a `WITHDRAWAL` row with that negative amount and return HTTP 201 with the inserted row.
2. IF a withdrawal is submitted with a zero or positive amount, THEN THE Cash_API SHALL return HTTP 400 with a French error message.
3. WHEN an owner submits a deposit with a positive amount, THE Cash_API SHALL insert a `DEPOSIT` row with that positive amount and return HTTP 201 with the inserted row.
4. IF a deposit is submitted with a zero or negative amount, THEN THE Cash_API SHALL return HTTP 400 with a French error message.
5. THE Cash_Register_Page SHALL convert the owner's DT input to millimes by computing `ROUND(inputDT × 1000)` before sending the value to the Cash_API — no floating-point amounts SHALL reach the database.

---

### Requirement 5: Cash Refunds

**User Story:** As an owner, I want to record cash refunds linked to a previous sale, so that money returned to customers is correctly subtracted from the theoretical balance.

#### Acceptance Criteria

1. WHEN an owner submits a cash refund with a negative amount and a valid `sale_id`, THE Cash_API SHALL insert a `CASH_REFUND` row with that negative amount, linked to the specified sale, and return HTTP 201.
2. IF a cash refund is submitted with a zero or positive amount, THEN THE Cash_API SHALL return HTTP 400 with a French error message.
3. THE Cash_API SHALL enforce that only `CASH_REFUND` rows may carry a non-null `sale_id`; for all other movement types, `sale_id` SHALL be `NULL`.

---

### Requirement 6: Append-Only Ledger Integrity

**User Story:** As an owner, I want the cash movement ledger to be append-only, so that the audit trail is tamper-proof and every historical balance can be reproduced at any time.

#### Acceptance Criteria

1. THE Cash_API SHALL never issue UPDATE or DELETE SQL statements against the Cash_Movements_Table.
2. WHEN a movement is successfully inserted, THE Cash_API SHALL return the full inserted row; subsequent corrections MUST be made by inserting a new compensating movement (e.g., an `ADJUSTMENT`).
3. THE Cash_API SHALL record `admin_id` from the authenticated session on every inserted row, never from the request body, to ensure authorship cannot be forged.

---

### Requirement 7: Movement History and Period Filtering

**User Story:** As an owner, I want to browse all cash movements for a selected period, so that I can review the register's activity and investigate discrepancies.

#### Acceptance Criteria

1. WHEN the owner requests movement history, THE Cash_API SHALL return movements paginated with a default page size of 50 rows, ordered by `created_at` descending.
2. WHEN the owner specifies `from` and `to` query parameters as valid ISO date strings, THE Cash_API SHALL filter movements to rows whose `created_at` falls within that period.
3. WHEN the owner specifies no period, THE Cash_API SHALL default to the current calendar day.
4. THE Cash_API SHALL return the total row count alongside paginated results so the Cash_Register_Page can render pagination controls.

---

### Requirement 8: Owner-Only Access Control

**User Story:** As a system administrator, I want all cash register endpoints to be restricted to the OWNER role, so that cashiers cannot view or modify the cash register ledger.

#### Acceptance Criteria

1. WHILE a request to any `/api/cash/*` endpoint is received with a non-OWNER role, THE Auth_Middleware SHALL reject the request with HTTP 403 before the route handler executes.
2. WHILE a request to any `/api/cash/*` endpoint is received without valid authentication, THE Auth_Middleware SHALL reject the request with HTTP 401 before the route handler executes.
3. THE Cash_Register_Page SHALL be accessible only via the `/owner/caisse` route, which is part of the owner-only section of the application.

---

### Requirement 9: Amount Formatting and Display

**User Story:** As an owner, I want all monetary amounts displayed in DT with three decimal places, so that I can read register figures without mental conversion.

#### Acceptance Criteria

1. THE Cash_Register_Page SHALL display all monetary amounts using the format `{(millimes / 1000).toFixed(3)} DT` (e.g., `12.500 DT`).
2. WHEN the owner enters an amount in DT, THE Cash_Register_Page SHALL accept up to three decimal places and reject non-numeric input before any API call is made.
3. IF the owner enters a non-numeric or negative amount for an action that requires a positive value, THEN THE Cash_Register_Page SHALL display a French validation message and prevent the form from submitting.

---

### Requirement 10: Summary Card Display

**User Story:** As an owner, I want a summary card at the top of the cash register page showing key figures at a glance, so that I can quickly assess the register's current state without scrolling through the history.

#### Acceptance Criteria

1. WHEN the Cash_Register_Page loads, THE Cash_Register_Page SHALL fetch and display the Theoretical_Balance, the period's total cash sales, and the total of other movements.
2. WHEN a last Verification exists for the selected period, THE Cash_Register_Page SHALL display the date, counted amount, and discrepancy from that last Verification in the summary card.
3. WHEN no Verification exists for the selected period, THE Cash_Register_Page SHALL display a prompt encouraging the owner to perform a physical count.
4. WHEN an owner action completes successfully, THE Cash_Register_Page SHALL automatically refresh the summary card and the movement list without requiring a manual page reload.

---

### Requirement 11: Error Handling and Resilience

**User Story:** As an owner, I want clear French error messages when something goes wrong, so that I understand what happened and can correct the issue.

#### Acceptance Criteria

1. WHEN the Cash_API receives a movement type not in the allowed set `{INITIALIZATION, WITHDRAWAL, DEPOSIT, CASH_REFUND, ADJUSTMENT, VERIFICATION}`, THE Cash_API SHALL return HTTP 400 with a French error message.
2. IF a PostgreSQL CHECK constraint violation occurs (error code `23514`), THEN THE Cash_API SHALL return HTTP 400 with a French error message rather than HTTP 500.
3. WHEN a network request fails or the server returns HTTP 5xx, THE Cash_Register_Page SHALL display a French retry message and leave the form open with the owner's current input intact.
4. WHEN the description field is empty or blank, THE Cash_API SHALL return HTTP 400 with a French error message requiring a non-empty description.
