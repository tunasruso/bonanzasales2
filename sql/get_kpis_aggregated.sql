-- get_kpis_aggregated — server-side mirror of the client logic in
-- src/lib/supabase.ts::getProductCategoryAndWeight + calculateKpisFromSales.
--
-- Classification priority (first match wins):
--   1. product_weights WHERE product_group = s.product_group AND pattern IS NOT NULL AND s.product LIKE '%'||pattern||'%'
--   2. product_weights WHERE product_group = s.product_group AND pattern IS NULL
--   3. product_weights WHERE product_group IN ('%','АКЦИЯ') AND pattern IS NOT NULL AND s.product LIKE '%'||pattern||'%'
-- Then KPB-keyword override forces category='new', avg_weight=0.
-- No classification match AND no KPB keywords → default category='second', avg_weight=0.
--
-- Row weight (matches client `rowKg = estimate > 0 ? estimate : quantity_kg`):
--   if match AND avg_weight > 0  →  quantity_pcs * avg_weight
--   else                          →  quantity_kg
-- For category='new' the client returns weight=0, so its kg is not counted.
--
-- total.kg is the sum over ALL rows (matching client line `total.kg += rowKg`),
-- which in practice equals second.kg because only category='new' rows contribute 0
-- AND new rows have qty_kg=0 in data.

CREATE OR REPLACE FUNCTION get_kpis_aggregated(
  p_start      date,
  p_end        date,
  p_stores     text[]   DEFAULT NULL,
  p_groups     text[]   DEFAULT NULL,
  p_products   text[]   DEFAULT NULL
)
RETURNS TABLE (
  total_revenue    numeric,
  total_kg         numeric,
  total_pcs        numeric,
  total_checks     bigint,
  total_positions  bigint,
  second_revenue   numeric,
  second_kg        numeric,
  second_pcs       numeric,
  second_checks    bigint,
  second_positions bigint,
  new_revenue      numeric,
  new_pcs          numeric,
  new_checks       bigint,
  new_positions    bigint
)
LANGUAGE sql
STABLE
AS $$
  WITH base AS (
    SELECT
      s.revenue,
      s.quantity_pcs,
      s.quantity_kg,
      s.recorder_id,
      s.product,
      s.product_group,
      -- exact match: same group + pattern substring in product name
      (SELECT w.id FROM product_weights w
        WHERE w.product_group = s.product_group
          AND w.product_name_pattern IS NOT NULL
          AND s.product LIKE '%' || w.product_name_pattern || '%'
        ORDER BY w.id LIMIT 1)                                          AS match_id_1,
      -- group only (no pattern)
      (SELECT w.id FROM product_weights w
        WHERE w.product_group = s.product_group
          AND w.product_name_pattern IS NULL
        ORDER BY w.id LIMIT 1)                                          AS match_id_2,
      -- global pattern (% or АКЦИЯ)
      (SELECT w.id FROM product_weights w
        WHERE w.product_name_pattern IS NOT NULL
          AND w.product_group IN ('%', 'АКЦИЯ')
          AND s.product LIKE '%' || w.product_name_pattern || '%'
        ORDER BY w.id LIMIT 1)                                          AS match_id_3,
      -- KPB/bedding keyword forces category=new
      (lower(COALESCE(s.product_group,'')) ~ '(кпб|пододеяльник|простын|наволоч|комплект постельного|полотен)'
       OR lower(COALESCE(s.product,''))       ~ '(кпб|пододеяльник|простын|наволоч|комплект постельного|полотен)')
                                                                        AS is_kpb
    FROM sales_analytics s
    WHERE s.sale_date BETWEEN p_start AND p_end
      AND (p_stores   IS NULL OR s.store         = ANY(p_stores))
      AND (p_groups   IS NULL OR s.product_group = ANY(p_groups))
      AND (p_products IS NULL OR s.product       = ANY(p_products))
  ),
  resolved AS (
    SELECT
      b.*,
      w.id           AS match_id,
      w.category     AS match_category,
      w.avg_weight_kg AS match_weight
    FROM base b
    LEFT JOIN product_weights w
      ON w.id = COALESCE(b.match_id_1, b.match_id_2, b.match_id_3)
  ),
  typed AS (
    SELECT
      r.revenue,
      r.quantity_pcs,
      r.recorder_id,
      CASE
        WHEN r.is_kpb THEN 'new'
        ELSE COALESCE(r.match_category, 'second')
      END AS category,
      CASE
        WHEN r.is_kpb THEN 0
        WHEN r.match_id IS NOT NULL AND r.match_weight > 0 THEN r.quantity_pcs * r.match_weight
        ELSE COALESCE(r.quantity_kg, 0)
      END AS row_kg
    FROM resolved r
  )
  SELECT
    SUM(revenue)::numeric                                                          AS total_revenue,
    SUM(CASE WHEN category = 'new' THEN 0 ELSE row_kg END)::numeric                AS total_kg,
    SUM(quantity_pcs)::numeric                                                     AS total_pcs,
    COUNT(DISTINCT NULLIF(split_part(COALESCE(recorder_id,''), '_', 1), ''))::bigint AS total_checks,
    COUNT(*)::bigint                                                               AS total_positions,
    SUM(CASE WHEN category = 'second' THEN revenue      ELSE 0 END)::numeric       AS second_revenue,
    SUM(CASE WHEN category = 'second' THEN row_kg       ELSE 0 END)::numeric       AS second_kg,
    SUM(CASE WHEN category = 'second' THEN quantity_pcs ELSE 0 END)::numeric       AS second_pcs,
    COUNT(DISTINCT CASE WHEN category = 'second' THEN NULLIF(split_part(COALESCE(recorder_id,''), '_', 1), '') END)::bigint AS second_checks,
    COUNT(CASE WHEN category = 'second' THEN 1 END)::bigint                        AS second_positions,
    SUM(CASE WHEN category = 'new' THEN revenue      ELSE 0 END)::numeric          AS new_revenue,
    SUM(CASE WHEN category = 'new' THEN quantity_pcs ELSE 0 END)::numeric          AS new_pcs,
    COUNT(DISTINCT CASE WHEN category = 'new' THEN NULLIF(split_part(COALESCE(recorder_id,''), '_', 1), '') END)::bigint AS new_checks,
    COUNT(CASE WHEN category = 'new' THEN 1 END)::bigint                           AS new_positions
  FROM typed;
$$;
