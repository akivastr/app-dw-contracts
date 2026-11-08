# Example: what reviewers see

This is the PR the workflow opens for demo scenario `2-breaking-export-change`
(someone drops a column the warehouse reads, changes a column type, and relaxes
a NOT NULL). It gets the labels `schema-change` and `breaking`, and the
CODEOWNERS for `outbound/` are requested as reviewers.

---

### PR title

**[Demo: 2-breaking-export-change] Breaking schema contract changes**

### PR description (generated)

## Schema contract changes

> [!CAUTION]
> This PR contains **breaking** changes. Coordinate with the other side before the next pipeline run.

**2 breaking · 1 review**

### Outbound (app DB → data warehouse)
_the warehouse pipeline reads these_

| | Object | Change |
|---|---|---|
| 🔴 Breaking | `dw_export.assessments` | Column `total_score` type changed `numeric(6,2)` → `integer` |
| 🔴 Breaking | `dw_export.residents` | Column `external_ref` `text NOT NULL` removed |
| 🟡 Review | `dw_export.assessments` | Column `reference_date` now allows NULL |

### Inbound (data warehouse → app DB)
_the warehouse pipeline writes these_

No changes.

---
_Opened automatically by the schema snapshot workflow. The **Files changed** tab shows the exact DDL. Merging this PR records the new state as the baseline._

### Files changed tab

```diff
diff --git a/outbound/dw_export/tables/assessments.sql b/outbound/dw_export/tables/assessments.sql
index 87edd6e..e97b851 100644
--- a/outbound/dw_export/tables/assessments.sql
+++ b/outbound/dw_export/tables/assessments.sql
@@ -2,8 +2,8 @@ CREATE TABLE dw_export.assessments (
     assessment_id bigint NOT NULL,
     resident_id bigint NOT NULL,
     assessment_type text NOT NULL,
-    reference_date date NOT NULL,
-    total_score numeric(6,2),
+    reference_date date,
+    total_score integer,
     completed_at timestamp with time zone
 );
 
diff --git a/outbound/dw_export/tables/residents.sql b/outbound/dw_export/tables/residents.sql
index f340e11..d514c11 100644
--- a/outbound/dw_export/tables/residents.sql
+++ b/outbound/dw_export/tables/residents.sql
@@ -1,7 +1,6 @@
 CREATE TABLE dw_export.residents (
     resident_id bigint NOT NULL,
     facility_id integer NOT NULL,
-    external_ref text NOT NULL,
     status dw_export.resident_status DEFAULT 'admitted'::dw_export.resident_status NOT NULL,
     admitted_on date NOT NULL,
     discharged_on date,
```
