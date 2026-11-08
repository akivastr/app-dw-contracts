-- Breaking: a column the warehouse reads is dropped, another changes type,
-- and a NOT NULL constraint is relaxed.
ALTER TABLE dw_export.residents DROP COLUMN external_ref;
ALTER TABLE dw_export.assessments ALTER COLUMN total_score TYPE integer USING total_score::integer;
ALTER TABLE dw_export.assessments ALTER COLUMN reference_date DROP NOT NULL;
