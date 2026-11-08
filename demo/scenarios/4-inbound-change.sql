-- Changes to the inbound contract (what the warehouse pipeline writes into the app DB):
-- a new feed table, an optional column, and a required column the pipeline
-- doesn't know about yet (its inserts would start failing).
CREATE TABLE dw_ingest.therapy_minutes (
    resident_id  bigint NOT NULL,
    service_date date NOT NULL,
    discipline   text NOT NULL,
    minutes      integer NOT NULL,
    loaded_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (resident_id, service_date, discipline)
);
ALTER TABLE dw_ingest.payer_eligibility ADD COLUMN plan_name text;
ALTER TABLE dw_ingest.facility_kpis ADD COLUMN staffing_hours numeric(6,2) NOT NULL;
