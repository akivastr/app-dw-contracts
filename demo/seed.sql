-- Demo app database with the two contract schemas.
-- All data structures are fictional; there is no real or patient data here.
--
--   dw_export : app DB -> SQL Server data warehouse (the warehouse pipeline reads these)
--   dw_ingest : data warehouse -> app DB (the warehouse pipeline writes these)
--
-- The public schema stands in for the rest of the app. It is not tracked, so
-- changes there never open a PR.

CREATE SCHEMA dw_export;
CREATE SCHEMA dw_ingest;

-- ---------------------------------------------------------------- untracked
CREATE TABLE public.app_users (
    id         serial PRIMARY KEY,
    email      text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- outbound
CREATE TYPE dw_export.resident_status AS ENUM ('admitted', 'discharged', 'on_leave');

CREATE TABLE dw_export.facilities (
    facility_id   integer PRIMARY KEY,
    facility_name text NOT NULL,
    state_code    char(2) NOT NULL,
    bed_count     integer NOT NULL CHECK (bed_count > 0)
);

CREATE TABLE dw_export.residents (
    resident_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    facility_id    integer NOT NULL REFERENCES dw_export.facilities (facility_id),
    external_ref   text NOT NULL,
    status         dw_export.resident_status NOT NULL DEFAULT 'admitted',
    admitted_on    date NOT NULL,
    discharged_on  date,
    updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX residents_facility_idx ON dw_export.residents (facility_id);
CREATE INDEX residents_updated_idx ON dw_export.residents (updated_at);
COMMENT ON TABLE dw_export.residents IS 'One row per resident stay. Exported nightly.';

CREATE TABLE dw_export.assessments (
    assessment_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    resident_id     bigint NOT NULL REFERENCES dw_export.residents (resident_id),
    assessment_type text NOT NULL,
    reference_date  date NOT NULL,
    total_score     numeric(6,2),
    completed_at    timestamptz
);
CREATE INDEX assessments_resident_idx ON dw_export.assessments (resident_id, reference_date);

CREATE VIEW dw_export.active_census AS
SELECT f.facility_id, f.facility_name, count(r.resident_id) AS active_residents
FROM dw_export.facilities f
LEFT JOIN dw_export.residents r
       ON r.facility_id = f.facility_id AND r.status = 'admitted'
GROUP BY f.facility_id, f.facility_name;

-- ---------------------------------------------------------------- inbound
CREATE TABLE dw_ingest.payer_eligibility (
    resident_id    bigint NOT NULL,
    payer_code     text NOT NULL,
    coverage_start date NOT NULL,
    coverage_end   date,
    loaded_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (resident_id, payer_code, coverage_start)
);

CREATE TABLE dw_ingest.facility_kpis (
    facility_id     integer NOT NULL,
    kpi_month       date NOT NULL,
    occupancy_pct   numeric(5,2),
    readmission_pct numeric(5,2),
    loaded_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (facility_id, kpi_month)
);

CREATE FUNCTION dw_ingest.latest_kpis(p_facility integer)
RETURNS SETOF dw_ingest.facility_kpis
LANGUAGE sql STABLE AS $$
    SELECT * FROM dw_ingest.facility_kpis
    WHERE facility_id = p_facility
    ORDER BY kpi_month DESC
    LIMIT 12
$$;
