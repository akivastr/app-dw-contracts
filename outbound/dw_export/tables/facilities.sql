CREATE TABLE dw_export.facilities (
    facility_id integer NOT NULL,
    facility_name text NOT NULL,
    state_code character(2) NOT NULL,
    bed_count integer NOT NULL,
    CONSTRAINT facilities_bed_count_check CHECK ((bed_count > 0))
);

ALTER TABLE ONLY dw_export.facilities
    ADD CONSTRAINT facilities_pkey PRIMARY KEY (facility_id);
