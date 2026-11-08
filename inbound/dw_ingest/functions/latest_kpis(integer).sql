CREATE FUNCTION dw_ingest.latest_kpis(p_facility integer) RETURNS SETOF dw_ingest.facility_kpis
    LANGUAGE sql STABLE
    AS $$
    SELECT * FROM dw_ingest.facility_kpis
    WHERE facility_id = p_facility
    ORDER BY kpi_month DESC
    LIMIT 12
$$;
