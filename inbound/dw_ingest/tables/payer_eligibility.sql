CREATE TABLE dw_ingest.payer_eligibility (
    resident_id bigint NOT NULL,
    payer_code text NOT NULL,
    coverage_start date NOT NULL,
    coverage_end date,
    loaded_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY dw_ingest.payer_eligibility
    ADD CONSTRAINT payer_eligibility_pkey PRIMARY KEY (resident_id, payer_code, coverage_start);


--
--
