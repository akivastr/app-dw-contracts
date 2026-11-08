CREATE TABLE dw_export.assessments (
    assessment_id bigint NOT NULL,
    resident_id bigint NOT NULL,
    assessment_type text NOT NULL,
    reference_date date,
    total_score integer,
    completed_at timestamp with time zone
);

ALTER TABLE dw_export.assessments ALTER COLUMN assessment_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME dw_export.assessments_assessment_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

ALTER TABLE ONLY dw_export.assessments
    ADD CONSTRAINT assessments_pkey PRIMARY KEY (assessment_id);

CREATE INDEX assessments_resident_idx ON dw_export.assessments USING btree (resident_id, reference_date);

ALTER TABLE ONLY dw_export.assessments
    ADD CONSTRAINT assessments_resident_id_fkey FOREIGN KEY (resident_id) REFERENCES dw_export.residents(resident_id);
