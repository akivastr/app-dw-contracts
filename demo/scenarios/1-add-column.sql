-- Non-breaking: the app team adds a nullable column to an exported table.
ALTER TABLE dw_export.residents ADD COLUMN primary_payer text;
