CREATE TABLE dw_ingest.facility_kpis (
    facility_id integer NOT NULL,
    kpi_month date NOT NULL,
    occupancy_pct numeric(5,2),
    readmission_pct numeric(5,2),
    loaded_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY dw_ingest.facility_kpis
    ADD CONSTRAINT facility_kpis_pkey PRIMARY KEY (facility_id, kpi_month);
