const EXCLUDED_RECORDERS_ENDPOINT = '/api/excluded-recorder-prefixes';
const FALLBACK_PREFIXES = [
  // Existing bad data already loaded into sales_analytics from Document1009.
  '94e1080027086f9511f12dcc82563689',
];

export async function fetchExcludedRecorderPrefixes(): Promise<string[]> {
  try {
    const response = await fetch(EXCLUDED_RECORDERS_ENDPOINT);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    if (!Array.isArray(data?.prefixes)) {
      return FALLBACK_PREFIXES;
    }

    return Array.from(new Set([
      ...FALLBACK_PREFIXES,
      ...data.prefixes.filter((value: unknown): value is string => typeof value === 'string' && value.length > 0),
    ]));
  } catch (error) {
    console.error('Error fetching excluded recorder prefixes:', error);
    return FALLBACK_PREFIXES;
  }
}
