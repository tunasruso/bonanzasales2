import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://lyfznzntclgitarujlab.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx5Znpuem50Y2xnaXRhcnVqbGFiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTE5MTM2OTgsImV4cCI6MjA2NzQ4OTY5OH0.UyUQzzKQ70p7RHw4TWHvUutMkGuo9VGZiGPdVZpVcs0';

export const supabase = createClient(supabaseUrl, supabaseKey);

export interface SalesRecord {
  id: number;
  recorder_id: string;
  sale_date: string;
  month: number;
  year: number;
  weekday: string;
  store: string;
  product: string;
  product_group: string;
  unit: string;
  quantity: number;
  quantity_pcs: number;
  quantity_kg: number;
  revenue: number;
}

export interface AggregatedData {
  key: string;
  revenue: number;
  quantity_kg: number;
  quantity_pcs: number;
  transactions: number;
}

// Helper to fetch all rows
async function fetchAll(query: any, batchSize = 1000) {
  let allData: any[] = [];
  let from = 0;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await query.range(from, from + batchSize - 1);

    if (error) {
      console.error('Error fetching batch:', error);
      throw error;
    }

    if (data && data.length > 0) {
      allData = [...allData, ...data];
      from += batchSize;

      // If we got less than requested, it's the last page
      if (data.length < batchSize) {
        hasMore = false;
      }
    } else {
      hasMore = false;
    }
  }
  return allData;
}

export async function fetchSalesData(
  startDate: string,
  endDate: string,
  stores?: string[],
  productGroups?: string[],
  products?: string[]
): Promise<SalesRecord[]> {
  let query = supabase
    .from('sales_analytics')
    .select('id, recorder_id, sale_date, month, year, weekday, store, product_group, product, unit, quantity, quantity_pcs, quantity_kg, revenue')
    .gte('sale_date', startDate)
    .lte('sale_date', endDate)
    .order('sale_date', { ascending: true })
    .order('id', { ascending: true });

  if (stores && stores.length > 0) {
    query = query.in('store', stores);
  }

  if (productGroups && productGroups.length > 0) {
    query = query.in('product_group', productGroups);
  }

  if (products && products.length > 0) {
    query = query.in('product', products);
  }

  try {
    const data = await fetchAll(query);
    return data;
  } catch (error) {
    console.error('Error fetching full sales data:', error);
    return [];
  }
}

export async function fetchExcludedSalesData(
  startDate: string,
  endDate: string,
  excludedPrefixes: string[],
  stores?: string[]
): Promise<SalesRecord[]> {
  if (excludedPrefixes.length === 0) return [];

  let query = supabase
    .from('sales_analytics')
    .select('id, recorder_id, sale_date, month, year, weekday, store, product_group, product, unit, quantity, quantity_pcs, quantity_kg, revenue')
    .gte('sale_date', startDate)
    .lte('sale_date', endDate)
    .order('sale_date', { ascending: true })
    .order('id', { ascending: true });

  if (stores && stores.length > 0) {
    query = query.in('store', stores);
  }

  const orFilter = excludedPrefixes
    .map((prefix) => `recorder_id.like.${prefix}_*`)
    .join(',');

  try {
    const data = await fetchAll(query.or(orFilter));
    return data;
  } catch (error) {
    console.error('Error fetching excluded sales data:', error);
    return [];
  }
}

export async function fetchDistinctValues(column: string): Promise<string[]> {
  const { data, error } = await supabase
    .rpc('get_distinct_values', { col_name: column });

  if (error) {
    console.error(`Error fetching ${column}:`, error);
    return [];
  }

  // RPC returns array of objects: [{ value: 'Store1' }, { value: 'Store2' }]
  // Or if we defined returns setof text -> returns array of strings?
  // Let's check return type. "returns table (value text)" -> [{ value: "..." }]
  return (data || []).map((item: any) => item.value).filter(Boolean);
}

export interface ProductWeight {
  id: number;
  product_group: string;
  product_name_pattern: string | null;
  avg_weight_kg: number;
  category: 'new' | 'second'; // Added category
  created_at: string;
}

// Helper: Get weight AND category
export function getProductCategoryAndWeight(record: any, weights: ProductWeight[]): {
  weight: number,
  category: 'new' | 'second',
  isAPlus: boolean,
  isBedding: boolean
} {
  const pGroup = record.product_group || '';
  const pName = record.product || '';
  const qty = Number(record.quantity_pcs || record.quantity);

  // Default to 'second' if no rule found
  let category: 'new' | 'second' = 'second';
  let avgWeight = 0;

  // Find matching rule
  let match = weights.find(w =>
    w.product_group === pGroup &&
    w.product_name_pattern &&
    pName.includes(w.product_name_pattern)
  );

  if (!match) {
    match = weights.find(w =>
      w.product_group === pGroup &&
      !w.product_name_pattern
    );
  }

  // Global pattern match (e.g. АКЦИЯ)
  if (!match) {
    match = weights.find(w =>
      w.product_name_pattern &&
      (w.product_group === '%' || w.product_group === 'АКЦИЯ') &&
      pName.includes(w.product_name_pattern)
    );
  }

  if (match) {
    category = match.category || 'second';
    avgWeight = Number(match.avg_weight_kg);
  }

  // Fallback for BEDDING/NEW that may be missing in DB rules
  const gNameL = pGroup.toLowerCase();
  const pNameL = pName.toLowerCase();
  const kpKeywords = ['кпб', 'пододеяльник', 'простын', 'наволоч', 'комплект постельного', 'полотен'];
  if (kpKeywords.some(k => gNameL.includes(k) || pNameL.includes(k))) {
    category = 'new';
    avgWeight = 0;
  }

  // Detection of specific subcategories for detailed report
  const isAPlus = (pName.includes('A+') || pName.includes('А+') || pName.includes('А!') || pName.includes('A!'));
  const isBedding = category === 'new';

  // Calculate total weight for this line
  if (category === 'new') {
    return { weight: 0, category: 'new', isAPlus, isBedding };
  }

  let calculated = 0;
  if (match && qty) {
    calculated = qty * avgWeight;
  }

  return { weight: calculated, category, isAPlus, isBedding };
}

// Kept for backward compatibility
export function calculateEstimatedWeight(record: any, weights: ProductWeight[]): number {
  return getProductCategoryAndWeight(record, weights).weight;
}


export interface DetailedKPI {
  revenue: number;
  kg: number;
  pcs: number;
  checks: number; // Final result is size
}

export interface ShopDetailedKPI {
  store: string;
  total: DetailedKPI;
  second: DetailedKPI;
  aPlus: DetailedKPI;
  bedding: DetailedKPI;
  revenueGrowth: number;
  totalPastRevenue: number;
  revenueGrowthWeek?: number;
  totalPastWeekRevenue?: number;
  secondKgGrowth: number;
  secondKgGrowthWeek?: number;
  pastSecondKg: number;
  pastWeekSecondKg?: number;
}

export async function fetchShopDetailedKPIs(
  startDate: string,
  endDate: string,
  stores?: string[]
) {
  // Determine if period is short (<= 7 days) for week-over-week comparison
  const start = new Date(startDate);
  const end = new Date(endDate);
  const daysDiff = Math.ceil((end.getTime() - start.getTime()) / (1000 * 3600 * 24)) + 1;
  const isShortPeriod = daysDiff <= 7;

  try {
    const { data, error } = await supabase.rpc('get_shop_kpis_aggregated', {
      p_start:    startDate,
      p_end:      endDate,
      p_stores:   stores && stores.length > 0 ? stores : null,
      p_is_short: isShortPeriod
    });

    if (error) { console.error('Error fetching shop KPIs (rpc):', error); return []; }
    if (!data) return [];

    const result: ShopDetailedKPI[] = (data as any[]).map(r => {
      const totalRev    = Number(r.total_revenue   || 0);
      const totalKg     = Number(r.total_kg        || 0);
      const totalPcs    = Number(r.total_pcs       || 0);
      const totalChecks = Number(r.total_checks    || 0);
      const secRev      = Number(r.second_revenue  || 0);
      const secKg       = Number(r.second_kg       || 0);
      const secPcs      = Number(r.second_pcs      || 0);
      const secChecks   = Number(r.second_checks   || 0);
      const apRev       = Number(r.aplus_revenue   || 0);
      const apKg        = Number(r.aplus_kg        || 0);
      const apChecks    = Number(r.aplus_checks    || 0);
      const bedRev      = Number(r.bedding_revenue || 0);
      const bedChecks   = Number(r.bedding_checks  || 0);
      const prevRev       = Number(r.prev_revenue        || 0);
      const prevWkRev     = Number(r.prev_week_revenue   || 0);
      const prevSecKg     = Number(r.prev_second_kg      || 0);
      const prevWkSecKg   = Number(r.prev_week_second_kg || 0);

      let revenueGrowth = 0;
      if (prevRev > 0) revenueGrowth = ((totalRev - prevRev) / prevRev) * 100;

      let revenueGrowthWeek: number | undefined = undefined;
      if (isShortPeriod) {
        revenueGrowthWeek = prevWkRev > 0
          ? ((totalRev - prevWkRev) / prevWkRev) * 100
          : (totalRev > 0 ? 100 : 0);
      }

      const secondKgGrowth = prevSecKg > 0 ? ((secKg - prevSecKg) / prevSecKg) * 100 : 0;
      const secondKgGrowthWeek: number | undefined = isShortPeriod
        ? (prevWkSecKg > 0 ? ((secKg - prevWkSecKg) / prevWkSecKg) * 100 : (secKg > 0 ? 100 : 0))
        : undefined;

      return {
        store: r.store,
        total:   { revenue: totalRev, kg: totalKg,  pcs: totalPcs, checks: totalChecks },
        second:  { revenue: secRev,   kg: secKg,    pcs: secPcs,   checks: secChecks   },
        aPlus:   { revenue: apRev,    kg: apKg,     pcs: 0,        checks: apChecks    },
        bedding: { revenue: bedRev,   kg: 0,        pcs: 0,        checks: bedChecks   },
        revenueGrowth,
        totalPastRevenue: prevRev,
        revenueGrowthWeek,
        totalPastWeekRevenue: isShortPeriod ? prevWkRev : undefined,
        secondKgGrowth,
        secondKgGrowthWeek,
        pastSecondKg:     prevSecKg,
        pastWeekSecondKg: isShortPeriod ? prevWkSecKg : undefined
      };
    });

    return result;
  } catch (error) {
    console.error('Error fetching shop detailed KPIs:', error);
    return [];
  }
}

export async function fetchKPIs(
  startDate: string,
  endDate: string,
  stores?: string[],
  productGroups?: string[],
  products?: string[]
) {
  try {
    const { data, error } = await supabase.rpc('get_kpis_aggregated', {
      p_start:    startDate,
      p_end:      endDate,
      p_stores:   stores        && stores.length        > 0 ? stores        : null,
      p_groups:   productGroups && productGroups.length > 0 ? productGroups : null,
      p_products: products      && products.length      > 0 ? products      : null
    });

    if (error) { console.error('Error fetching KPIs (rpc):', error); return null; }
    if (!data || data.length === 0) return null;

    const r = data[0];
    const totalRev    = Number(r.total_revenue   || 0);
    const totalKg     = Number(r.total_kg        || 0);
    const totalPcs    = Number(r.total_pcs       || 0);
    const totalChecks = Number(r.total_checks    || 0);
    const totalPos    = Number(r.total_positions || 0);
    const secRev      = Number(r.second_revenue  || 0);
    const secKg       = Number(r.second_kg       || 0);
    const secPcs      = Number(r.second_pcs      || 0);
    const secChecks   = Number(r.second_checks   || 0);
    const secPos      = Number(r.second_positions|| 0);
    const newRev      = Number(r.new_revenue     || 0);
    const newPcs      = Number(r.new_pcs         || 0);
    const newChecks   = Number(r.new_checks      || 0);
    const newPos      = Number(r.new_positions   || 0);

    return {
      total: {
        revenue:    totalRev,
        kg:         totalKg,
        pcs:        totalPcs,
        checks:     totalChecks,
        avgCheck:   totalChecks > 0 ? totalRev / totalChecks : 0,
        pricePerKg: totalKg    > 0 ? totalRev / totalKg     : 0,
        positions:  totalPos
      },
      second: {
        revenue:    secRev,
        kg:         secKg,
        pcs:        secPcs,
        checks:     secChecks,
        avgCheck:   secChecks > 0 ? secRev / secChecks : 0,
        pricePerKg: secKg     > 0 ? secRev / secKg     : 0,
        positions:  secPos
      },
      newGoods: {
        revenue:    newRev,
        kg:         0,
        pcs:        newPcs,
        checks:     newChecks,
        avgCheck:   newChecks > 0 ? newRev / newChecks : 0,
        pricePerKg: 0,
        positions:  newPos
      }
    };
  } catch (error) {
    console.error('Error fetching KPIs:', error);
    return null;
  }
}

export interface InventoryRecord {
  store: string;
  product: string;
  quantity: number;
  product_group?: string;
  unit?: string;
}

export async function fetchInventory(reportDate?: string): Promise<InventoryRecord[]> {
  try {
    // If a date is specified, find the closest snapshot_date <= reportDate
    let targetDate = reportDate;

    if (targetDate) {
      // Find the nearest snapshot date that is <= the requested date
      const { data: dates } = await supabase
        .from('inventory_analytics')
        .select('snapshot_date')
        .lte('snapshot_date', targetDate)
        .order('snapshot_date', { ascending: false })
        .limit(1);

      if (dates && dates.length > 0) {
        targetDate = dates[0].snapshot_date;
      }
    } else {
      // Find the latest snapshot date
      const { data: dates } = await supabase
        .from('inventory_analytics')
        .select('snapshot_date')
        .order('snapshot_date', { ascending: false })
        .limit(1);

      if (dates && dates.length > 0) {
        targetDate = dates[0].snapshot_date;
      }
    }

    let query = supabase
      .from('inventory_analytics')
      .select('store, product, quantity, product_group, unit')
      .order('id', { ascending: true });

    if (targetDate) {
      query = query.eq('snapshot_date', targetDate);
    }

    const data = await fetchAll(query);
    console.log(`📦 Inventory loaded: ${data.length} items for snapshot ${targetDate || 'latest'}`);
    return data;
  } catch (error) {
    console.error('Error fetching inventory:', error);
    return [];
  }
}

// Module-level cache for product weights (TTL: 1 hour)
let _weightsCache: { data: ProductWeight[]; timestamp: number } | null = null;
const WEIGHTS_CACHE_TTL = 60 * 60 * 1000;

export async function fetchProductWeights(): Promise<ProductWeight[]> {
  if (_weightsCache && Date.now() - _weightsCache.timestamp < WEIGHTS_CACHE_TTL) {
    return _weightsCache.data;
  }

  const { data, error } = await supabase
    .from('product_weights')
    .select('*');

  if (error) {
    console.error('Error fetching weights:', error);
    return [];
  }

  _weightsCache = { data: data as ProductWeight[], timestamp: Date.now() };
  return _weightsCache.data;
}

export type LoginResult = 'ok' | 'bad_credentials' | 'network_error';

export async function checkUser(username: string, password: string): Promise<LoginResult> {
  const uname = (username ?? '').trim();
  const pwd = (password ?? '').trim();
  if (!uname || !pwd) return 'bad_credentials';

  const { data, error } = await supabase
    .from('app_users')
    .select('id')
    .eq('username', uname)
    .eq('password', pwd)
    .limit(1);

  if (error) {
    console.error('checkUser network error:', error);
    return 'network_error';
  }
  return data && data.length > 0 ? 'ok' : 'bad_credentials';
}

export interface VisitorRecord {
  visit_date: string;
  store: string;
  visitor_count: number;
}

export async function fetchVisitors(
  startDate: string,
  endDate: string,
  stores?: string[]
): Promise<VisitorRecord[]> {
  let query = supabase
    .from('visitors_analytics')
    .select('visit_date, store, visitor_count')
    .gte('visit_date', startDate)
    .lte('visit_date', endDate)
    .order('visit_date', { ascending: true });

  if (stores && stores.length > 0) {
    query = query.in('store', stores);
  }

  try {
    const data = await fetchAll(query);
    return data || [];
  } catch (error) {
    console.error('Error fetching visitors:', error);
    return [];
  }
}
