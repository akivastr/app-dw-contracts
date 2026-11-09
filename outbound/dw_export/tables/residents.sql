CREATE TABLE dw_export.residents (
    resident_id bigint NOT NULL,
    facility_id integer NOT NULL,
    external_ref text NOT NULL,
    status dw_export.resident_status DEFAULT 'admitted'::dw_export.resident_status NOT NULL,
    admitted_on date NOT NULL,
    discharged_on date,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    primary_payer text
);

COMMENT ON TABLE dw_export.residents IS 'One row per resident stay. Exported nightly.';

ALTER TABLE dw_export.residents ALTER COLUMN resident_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME dw_export.residents_resident_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

ALTER TABLE ONLY dw_export.residents
    ADD CONSTRAINT residents_pkey PRIMARY KEY (resident_id);

CREATE INDEX residents_facility_idx ON dw_export.residents USING btree (facility_id);

CREATE INDEX residents_updated_idx ON dw_export.residents USING btree (updated_at);

ALTER TABLE ONLY dw_export.residents
    ADD CONSTRAINT residents_facility_id_fkey FOREIGN KEY (facility_id) REFERENCES dw_export.facilities(facility_id);


--
--
