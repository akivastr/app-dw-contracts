CREATE VIEW dw_export.active_census AS
 SELECT f.facility_id,
    f.facility_name,
    count(r.resident_id) AS active_residents
   FROM (dw_export.facilities f
     LEFT JOIN dw_export.residents r ON (((r.facility_id = f.facility_id) AND (r.status = 'admitted'::dw_export.resident_status))))
  GROUP BY f.facility_id, f.facility_name;
