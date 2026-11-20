## ADDED Requirements

### Requirement: Defect domain

The defect ledger MUST support a `domain` field with values `product` and `harness`.

#### Scenario: Legacy row without domain

- GIVEN a defect ledger row without `domain`
- WHEN the system reads it
- THEN the row is treated as `product`

### Requirement: Domain counters

The report MUST show separate counters for product and harness defects.

#### Scenario: Mixed campaign

- GIVEN valid kept rows with both product and harness domains
- WHEN the report is generated
- THEN both counters are visible

### Requirement: Scoring unchanged

Adding domain reporting MUST NOT change `hardening_score_v2`.

#### Scenario: Same inputs

- GIVEN the same ledger and same test run
- WHEN domain reporting is added
- THEN the primary metric remains unchanged

### Requirement: Valid rows only

Only valid kept rows MUST be counted.

#### Scenario: Discarded row

- GIVEN a row with `status:"discard"`
- WHEN counters are calculated
- THEN it is counted in neither domain
