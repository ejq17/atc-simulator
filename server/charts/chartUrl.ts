/**
 * Pure URL allow-list for the chart proxy. No Node or DOM imports so it can be
 * unit tested (and reused) anywhere.
 *
 * Only official FAA d-TPP PDFs are proxied:
 *   https://aeronav.faa.gov/d-tpp/<4-digit cycle>/<name>.pdf
 *
 * The brief gave `\.pdf$`; the FAA publishes these files with an UPPERCASE
 * extension (`00669AD.PDF`), so both spellings are accepted. Nothing else
 * (no query string, fragment, port, userinfo, path traversal, other host or
 * scheme) can match: the file name is limited to [A-Za-z0-9_].
 */
export const CHART_URL_PATTERN = /^https:\/\/aeronav\.faa\.gov\/d-tpp\/\d{4}\/[A-Za-z0-9_]+\.(?:pdf|PDF)$/;

export function isAllowedChartUrl(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 200 && CHART_URL_PATTERN.test(value);
}
