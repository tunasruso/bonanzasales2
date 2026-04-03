import sys
print("DEBUG: Script initialized...", flush=True)

import requests
import json
import logging
import os
from datetime import datetime
from decimal import Decimal
import psycopg2

print("DEBUG: Imports complete.", flush=True)

# ═══════════════════════════════════════════════════════════════════════════════
# CONFIGURATION
# ═══════════════════════════════════════════════════════════════════════════════

# 1C PostgreSQL Database
DB_CONFIG = {
    'host': os.getenv('POSTGRES_HOST'),
    'user': os.getenv('POSTGRES_USER'),
    'password': os.getenv('POSTGRES_PASSWORD'),
    'dbname': os.getenv('POSTGRES_DB', 'Roznica'),
    'port': os.getenv('POSTGRES_PORT', 5432)
}

# Supabase
SUPABASE_URL = "https://lyfznzntclgitarujlab.supabase.co"
SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx5Znpuem50Y2xnaXRhcnVqbGFiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTE5MTM2OTgsImV4cCI6MjA2NzQ4OTY5OH0.UyUQzzKQ70p7RHw4TWHvUutMkGuo9VGZiGPdVZpVcs0"

# Column mappings (verified)
WAREHOUSE_REF = '_Fld53725RRef'
NOMENCLATURE_REF = '_Fld53716RRef'
REVENUE_COL = '_Fld53732'
QUANTITY_COL = '_Fld53731'
RECORDER_REF = '_RecorderRRef'
# Document1009 = Расходная накладная. Это перемещение на другое юрлицо,
# а не розничная продажа, поэтому не должно попадать в sales_analytics.
EXCLUDED_RECORDER_TREF_HEX = '000003f1'

# Batch size for Supabase inserts
BATCH_SIZE = 500

class DecimalEncoder(json.JSONEncoder):
    def default(self, o):
        if isinstance(o, Decimal):
            return float(o)
        return super(DecimalEncoder, self).default(o)

# ═══════════════════════════════════════════════════════════════════════════════
# LOGGING
# ═══════════════════════════════════════════════════════════════════════════════

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s | %(levelname)s | %(message)s',
    datefmt='%H:%M:%S',
    stream=sys.stdout
)
log = logging.getLogger(__name__)

# ═══════════════════════════════════════════════════════════════════════════════
# DATABASE CONNECTION
# ═══════════════════════════════════════════════════════════════════════════════

def get_db_connection():
    """Establish connection to PostgreSQL database."""
    return psycopg2.connect(**DB_CONFIG)


# ═══════════════════════════════════════════════════════════════════════════════
# DATA EXTRACTION FROM 1C
# ═══════════════════════════════════════════════════════════════════════════════

def extract_all_sales(cursor):
    """Extract ALL sales data from 1C database."""
    log.info("Extracting sales data (Since Jan 1 2026)...")
    
    # Using encode(..., 'hex') to get readable strings for ID generation
    query = f"""
    SELECT 
        s._Period AS sale_date_1c,
        w._Description AS warehouse,
        m._Description AS store,
        n._Description AS product,
        u._Description AS unit,
        s.{QUANTITY_COL} AS quantity,
        s.{REVENUE_COL} AS revenue,
        encode(s.{RECORDER_REF}, 'hex') AS recorder_id_hex,
        s._LineNo AS line_number
    FROM _AccumRg53715 s
    INNER JOIN _Reference640 w ON s.{WAREHOUSE_REF} = w._IDRRef
    LEFT JOIN _Reference640 m ON w._ParentIDRRef = m._IDRRef
    LEFT JOIN _Reference387 n ON s.{NOMENCLATURE_REF} = n._IDRRef
    LEFT JOIN _Reference188 u ON n._Fld9817RRef = u._IDRRef
    WHERE s._Period >= '2026-01-01 00:00:00'
      AND s._RecorderTRef <> decode(%s, 'hex')
    ORDER BY s._Period
    """
    
    cursor.execute(query, (EXCLUDED_RECORDER_TREF_HEX,))
    rows = cursor.fetchall()
    log.info(f"Fetched {len(rows):,} total sales records")
    
    return rows


def extract_product_group(product_name):
    """Extract product group from product name."""
    if not product_name:
        return 'Без группы'
    
    name = str(product_name).strip()
    
    patterns = [
        'Аксессуары', 'Брюки', 'Дети', 'Джемпер', 'Куртки', 
        'Обувь', 'Платье', 'Рубашки', 'Сопутка', 'Спорт',
        'Текстиль', 'Трикотаж', 'АКЦИЯ', 'Наволочка', 'Пододеяльник',
        'Простыня', 'Полотенце'
    ]
    
    for pattern in patterns:
        if pattern.lower() in name.lower():
            if '.' in name:
                return name.split('.')[0].strip()
            return pattern
    
    if len(name) > 30:
        return name.split()[0] if ' ' in name else name[:30]
    return name


def get_unit_type(unit):
    """Determine unit type (kg or pcs)."""
    if not unit:
        return 'pcs'
    unit_str = str(unit).lower().strip()
    if 'кг' in unit_str or 'kg' in unit_str:
        return 'kg'
    return 'pcs'


def transform_row(row):
    """Transform a raw database row into Supabase record format."""
    sale_date, warehouse, store, product, unit, quantity, revenue, recorder_id_hex, line_number = row
    
    if not sale_date:
        return None
        
    # Handle None store
    store = store if store else warehouse
    if not store:
        return None
    
    product_group = extract_product_group(product)
    unit_type = get_unit_type(unit)
    
    quantity = float(quantity) if quantity else 0
    revenue = float(revenue) if revenue else 0
    
    # Create unique ID using recorder_id + line_number
    unique_id = f"{recorder_id_hex}_{line_number}"
    
    return {
        'sale_date': sale_date.isoformat(),
        'day_of_month': sale_date.day,
        'week_number': sale_date.isocalendar()[1],
        'month': sale_date.month,
        'quarter': (sale_date.month - 1) // 3 + 1,
        'year': sale_date.year,
        'weekday': sale_date.strftime('%A'),
        'warehouse': warehouse,
        'store': store,
        'product': product,
        'product_group': product_group,
        'unit': unit,
        'unit_type': unit_type,
        'quantity': quantity,
        'quantity_pcs': quantity,
        'quantity_kg': quantity if unit_type == 'kg' else 0,
        'revenue': revenue,
        'recorder_id': unique_id
    }


# ═══════════════════════════════════════════════════════════════════════════════
# SUPABASE UPLOAD
# ═══════════════════════════════════════════════════════════════════════════════

def upload_to_supabase(records):
    """Upload records to Supabase in batches using UPSERT."""
    print(f"DEBUG: Starting upload of {len(records)} records...", flush=True)
    log.info(f"Uploading {len(records):,} records to Supabase (UPSERT)...")
    
    headers = {
        'apikey': SUPABASE_KEY,
        'Authorization': f'Bearer {SUPABASE_KEY}',
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates' # Handles duplicates by updating
    }
    
    url = f"{SUPABASE_URL}/rest/v1/sales_analytics?on_conflict=recorder_id"
    
    total_uploaded = 0
    errors = 0
    
    for i in range(0, len(records), BATCH_SIZE):
        batch = records[i:i + BATCH_SIZE]
        
        try:
            response = requests.post(
                url, 
                headers=headers, 
                data=json.dumps(batch, cls=DecimalEncoder)
            )
            
            if response.status_code in [200, 201]:
                total_uploaded += len(batch)
                if (i // BATCH_SIZE + 1) % 10 == 0:
                    log.info(f"  Uploaded {total_uploaded:,} / {len(records):,} records...")
            else:
                errors += 1
                log.error(f"  Batch error: {response.status_code} - {response.text[:200]}")
                
        except Exception as e:
            errors += 1
            log.error(f"  Upload exception: {e}")
    
    log.info(f"✅ Upload complete: {total_uploaded:,} records, {errors} errors")
    return total_uploaded


# ═══════════════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════════════

def main():
    print()
    print("═" * 70)
    print("  LiderTeks 1C → Supabase Sales Sync (Postgres)")
    print("═" * 70)
    print()
    
    # Connect to PostgreSQL
    log.info("Connecting to PostgreSQL...")
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        log.info("✅ Connected")
    except Exception as e:
        log.error(f"Failed to connect: {e}")
        return 1
    
    # Extract all sales
    try:
        rows = extract_all_sales(cursor)
    except Exception as e:
        log.error(f"Extraction failed: {e}")
        if conn: conn.close()
        return 1
    
    # Transform data
    log.info("Transforming data...")
    records = []
    skipped = 0
    
    for row in rows:
        record = transform_row(row)
        if record:
            records.append(record)
        else:
            skipped += 1
    
    log.info(f"Transformed {len(records):,} records ({skipped} skipped)")
    
    # Close connection
    cursor.close()
    conn.close()
    
    if not records:
        log.info("No records to sync.")
        return 0
    
    # Upload to Supabase (UPSERT)
    log.info(f"Deduplicating {len(records):,} records...")
    unique_map = {}
    for r in records:
        unique_map[r['recorder_id']] = r
    
    deduped_records = list(unique_map.values())
    log.info(f"Unique records: {len(deduped_records):,} (removed {len(records) - len(deduped_records)} duplicates)")

    upload_to_supabase(deduped_records)
    
    # Summary
    print()
    print("═" * 70)
    log.info("SYNC COMPLETE")
    print("═" * 70)
    
    return 0


if __name__ == "__main__":
    main()
