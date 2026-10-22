/**
 * Re-creates data/sources/raw/ (git-ignored) from the public sources the provenance records name.
 *
 *   npx tsx scripts/fetch-raw-sources.ts [--only nasr|dtpp|osm|aip|docs[,..]] [--out <dir>] [--list] [--verbose]
 *
 * Groups
 *   nasr  FAA NASR 2026-10-01 CSV zips (nfdc.faa.gov), unzipped to nasr_2026-10-01/x_<NAME>_CSV/ as
 *         scripts/extract-nasr-airport.ts expects; the two NASR cycle pages
 *   dtpp  d-TPP cycle 2610 metafile, every PDF the five FAA airports' *-procedures.json list (local_file paths), the
 *         KACY FAA MVA product files (raw/mva/)
 *   osm   Overpass RE-FETCH per airport, same query as the committed GeoJSON (its `query` property), written to
 *         overpass_<slug>_raw.json. The committed *-taxiways.geojson carry the original osm_base_timestamp and ARE the
 *         record: a fresh pull has a newer base timestamp, is labelled RE-FETCH and must never be converted over them.
 *   aip   EGLL: UK AIP (NATS eAIP) pages, the 62 AD 2.24 chart PDFs, NATS terms, Heathrow runway alternation
 *   docs  EUROCONTROL ACD pages, FAA JO 7110.126A / 7110.65 / AIM pages, CAP 413, runway-use and noise documents,
 *         AWC / NWS weather samples
 *
 * Every file is validated (PDF header, XML / JSON parse, zip integrity), compared with the size recorded in
 * data/sources/README.md or the JSON provenance where one is recorded, and reported as
 *   MATCH       valid, size equals the recorded size
 *   MISMATCH    valid, size differs from the recorded size (source changed or record wrong)
 *   UNRECORDED  valid, no size is recorded anywhere
 *   REFETCH     live or re-fetched content (Overpass, AWC / NWS samples) that differs from the record by design
 *   MISSING     the source answers 404 / 410 / 403 (reported, not retried)
 *   FAILED      network error or validation failure after the retries
 *
 * Idempotent: an existing file that validates is kept, not downloaded again. User-Agent as in the project brief,
 * concurrency 4 (1 per host for overpass-api.de), retries with exponential backoff.
 *
 * Terms: the UK AIP is (c) NATS Limited and the EUROCONTROL ACD pages say "Copyright permission must be sought" to
 * redistribute. They are fetched for local provenance only. data/sources/raw/ is git-ignored: never commit it.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type Group = 'nasr' | 'dtpp' | 'osm' | 'aip' | 'docs';
type Kind = 'pdf' | 'xml' | 'json' | 'zip' | 'html' | 'text';
type Status = 'MATCH' | 'MISMATCH' | 'UNRECORDED' | 'REFETCH' | 'MISSING' | 'FAILED';

interface Item {
  group: Group;
  /** Source label for the report (what the count is per). */
  source: string;
  /** Path relative to the output directory. */
  rel: string;
  url: string;
  kind: Kind;
  /** Size recorded in README / JSON provenance, bytes. */
  expectBytes?: number;
  /** Where that size is recorded. */
  expectFrom?: string;
  /** Live or re-fetched content: a size difference is expected, report REFETCH instead of MISMATCH. */
  volatile?: string;
  /** Extra text that must occur in the body (sanity check on HTML pages). */
  mustContain?: string;
  /** Overpass items only: committed GeoJSON, to compare the OSM base timestamp. */
  geojson?: string;
}

interface Result {
  item: Item;
  status: Status;
  bytes: number;
  note: string;
  downloaded: boolean;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SRC = path.join(REPO, 'data', 'sources');
const UA = 'atc-simulator-research/1.0 (+https://github.com/ejq17/atc-simulator)';
const RETRIES = 4;
const CONCURRENCY = 4;
const NASR_CYCLE = '2026-10-01';
const NASR_PREFIX = '01_Oct_2026';
const NASR_BASE = 'https://nfdc.faa.gov/webContent/28DaySub/extra';
const NASR_NAMES = ['APT', 'ATC', 'CLS_ARSP', 'COM', 'DP', 'FIX', 'FRQ', 'ILS', 'NAV', 'STAR'];
const NASR_PAGE = `https://www.faa.gov/air_traffic/flight_info/aeronav/aero_data/NASR_Subscription/${NASR_CYCLE}/`;
const AIRPORTS = ['kacy', 'kmht', 'kbos', 'kphl', 'kpgd', 'egll'] as const;
const FAA_AIRPORTS = ['kacy', 'kmht', 'kbos', 'kphl', 'kpgd'] as const;
const EAIP = 'https://www.aurora.nats.co.uk/htmlAIP/Publications/2026-10-01-AIRAC';
const ACD = 'https://learningzone.eurocontrol.int/ilp/customs/ATCPFDB/details.aspx?ICAO=';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------------------------------
// Arguments

function parseArgs(argv: string[]) {
  const groups = new Set<Group>();
  let out = path.join(SRC, 'raw');
  let list = false;
  let verbose = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--only') {
      for (const g of (argv[++i] ?? '').split(',')) {
        if (!['nasr', 'dtpp', 'osm', 'aip', 'docs'].includes(g)) throw new Error(`--only: unknown group "${g}"`);
        groups.add(g as Group);
      }
    } else if (a === '--out') out = path.resolve(argv[++i] ?? '');
    else if (a === '--list') list = true;
    else if (a === '--verbose') verbose = true;
    else throw new Error(`unknown argument ${a}\nusage: fetch-raw-sources.ts [--only nasr|dtpp|osm|aip|docs] [--out <dir>] [--list] [--verbose]`);
  }
  if (groups.size === 0) for (const g of ['nasr', 'dtpp', 'osm', 'aip', 'docs'] as Group[]) groups.add(g);
  return { groups, out, list, verbose };
}

// ---------------------------------------------------------------------------------------------------------------------
// Plan: which files, from where, with which recorded size

type J = Record<string, unknown>;
const readJson = (file: string): J => JSON.parse(fs.readFileSync(file, 'utf8')) as J;

/** Every object with a `url` and a `local_file` (the `pdf` blocks of the procedures JSON), first occurrence wins. */
function collectPdfBlocks(node: unknown, into: Map<string, { url: string; bytes?: number }>): void {
  if (Array.isArray(node)) {
    for (const v of node) collectPdfBlocks(v, into);
  } else if (node && typeof node === 'object') {
    const o = node as J;
    if (typeof o.url === 'string' && typeof o.local_file === 'string' && !into.has(o.local_file)) {
      into.set(o.local_file, { url: o.url, bytes: typeof o.bytes === 'number' ? o.bytes : undefined });
    }
    for (const v of Object.values(o)) collectPdfBlocks(v, into);
  }
}

function planNasr(): Item[] {
  const items: Item[] = NASR_NAMES.map((name) => ({
    group: 'nasr' as const,
    source: 'NASR CSV zips',
    rel: `nasr_${NASR_CYCLE}/${NASR_PREFIX}_${name}_CSV.zip`,
    url: `${NASR_BASE}/${NASR_PREFIX}_${name}_CSV.zip`,
    kind: 'zip' as const,
  }));
  items.push(
    { group: 'nasr', source: 'NASR cycle pages', rel: `nasr_${NASR_CYCLE}.html`, url: NASR_PAGE, kind: 'html', mustContain: NASR_PREFIX, volatile: 'FAA page, edited after the cycle starts' },
    { group: 'nasr', source: 'NASR cycle pages', rel: 'nasr_index.html', url: 'https://www.faa.gov/air_traffic/flight_info/aeronav/aero_data/NASR_Subscription/', kind: 'html', volatile: 'FAA index page, changes every cycle' },
  );
  return items;
}

function planDtpp(): Item[] {
  const items: Item[] = [
    {
      group: 'dtpp',
      source: 'd-TPP metafile',
      rel: 'd-TPP_Metafile_2610.xml',
      url: 'https://aeronav.faa.gov/d-tpp/2610/xml_data/d-TPP_Metafile.xml',
      kind: 'xml',
      mustContain: 'digital_tpp',
    },
  ];
  for (const slug of FAA_AIRPORTS) {
    const blocks = new Map<string, { url: string; bytes?: number }>();
    collectPdfBlocks(readJson(path.join(SRC, `${slug}-procedures.json`)), blocks);
    for (const [local, b] of blocks) {
      items.push({
        group: 'dtpp',
        source: `d-TPP PDFs ${slug.toUpperCase()}`,
        rel: local.replace(/^raw\//, ''),
        url: b.url,
        kind: 'pdf',
        expectBytes: b.bytes,
        expectFrom: `${slug}-procedures.json`,
      });
    }
  }
  // FAA MVA product files named by kacy-mva.json (_provenance.files); kacy.ts reads raw/mva/ACY_MVA_FUS3.kml.
  const mva = readJson(path.join(SRC, 'kacy-mva.json'))._provenance as { files: Record<string, string> };
  const mvaUrls = new Set<string>();
  for (const v of Object.values(mva.files)) {
    const m = /https:\/\/\S+?\.(kml|xml|pdf)\b/.exec(v);
    if (m) mvaUrls.add(m[0]);
  }
  for (const url of mvaUrls) {
    const ext = url.slice(url.lastIndexOf('.') + 1);
    items.push({
      group: 'dtpp',
      source: 'FAA MVA (KACY)',
      rel: `mva/${url.slice(url.lastIndexOf('/') + 1)}`,
      url,
      kind: ext === 'pdf' ? 'pdf' : 'xml',
      volatile: 'MVA charts are not on a regular cycle; a newer revision than the 2026-10-17 record is possible',
    });
  }
  return items;
}

function planOsm(): Item[] {
  return AIRPORTS.map((slug) => {
    const gj = readJson(path.join(SRC, `${slug}-taxiways.geojson`)).properties as { query: string };
    // The KACY GeoJSON stores the query without the quotes around aeroway; the Overpass result is identical.
    const q = `[out:json][timeout:90]; ${gj.query.replace('nwr[aeroway~', 'nwr["aeroway"~')}`;
    return {
      group: 'osm' as const,
      source: 'Overpass RE-FETCH',
      rel: `overpass_${slug}_raw.json`,
      url: `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(q)}`,
      kind: 'json' as const,
      volatile: `RE-FETCH, not the committed record (committed GeoJSON osm_base_timestamp stays authoritative)`,
      geojson: `${slug}-taxiways.geojson`,
      expectBytes: slug === 'egll' ? 903015 : undefined,
      expectFrom: slug === 'egll' ? 'README EGLL downloads table' : undefined,
    };
  });
}

/** AD 2.24 chart links of the eAIP page: label "AD 2.EGLL-8-1" -> graphics/487994.pdf. */
function parseChartLinks(html: string): { name: string; url: string }[] {
  const out: { name: string; url: string }[] = [];
  const seen = new Set<string>();
  const re = /<a[^>]*href="\.\.\/\.\.\/graphics\/(\d+\.pdf)"[^>]*>\s*(AD[\s ]2\.EGLL-\d+-\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const name = `EGLL_${m[2].replace(/[\s\u00a0]/g, '')}.pdf`;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, url: `${EAIP}/graphics/${m[1]}` });
  }
  return out;
}

async function planAip(out: string): Promise<Item[]> {
  const ad2Url = `${EAIP}/html/eAIP/EG-AD-2.EGLL-en-GB.html`;
  const items: Item[] = [
    { group: 'aip', source: 'EGLL eAIP pages', rel: 'egll/aip_index.html', url: 'https://nats-uk.ead-it.com/cms-nats/opencms/en/Publications/AIP/', kind: 'html', expectBytes: 20010, expectFrom: 'README EGLL downloads table', volatile: 'NATS index page, changes every AIRAC' },
    { group: 'aip', source: 'EGLL eAIP pages', rel: 'egll/index-en-GB.html', url: `${EAIP}/html/index-en-GB.html`, kind: 'html' },
    { group: 'aip', source: 'EGLL eAIP pages', rel: 'egll/EG-AD-2.EGLL-en-GB.html', url: ad2Url, kind: 'html', expectBytes: 739746, expectFrom: 'README EGLL downloads table', mustContain: 'EGLL' },
  ];
  for (const p of ['GEN-0.1', 'GEN-0.2', 'GEN-1.7', 'GEN-2.2', 'GEN-3.5', 'ENR-4.1', 'ENR-4.4']) {
    items.push({ group: 'aip', source: 'EGLL eAIP pages', rel: `egll/EG-${p}-en-GB.html`, url: `${EAIP}/html/eAIP/EG-${p}-en-GB.html`, kind: 'html' });
  }
  items.push(
    { group: 'aip', source: 'EGLL NATS terms', rel: 'egll/nats_terms.html', url: 'https://nats-uk.ead-it.com/cms-nats/opencms/en/agb/', kind: 'html', volatile: 'the committed copy was a text extract (nats_terms.txt)' },
    { group: 'aip', source: 'Heathrow operator pages', rel: 'egll/heathrow_runway_alternation.html', url: 'https://www.heathrow.com/company/local-community/noise/operations/runway-alternation', kind: 'html', volatile: 'operator page, edited without notice' },
    {
      group: 'aip',
      source: 'Heathrow operator pages',
      rel: 'egll/Heathrow_Runway_Alternation_Programme_2026.pdf',
      url: 'https://www.heathrow.com/content/dam/heathrow/web/common/documents/company/local-community/noise/operations/runway-alternation/Heathrow_Runway_Alternation_Programme_2026.pdf',
      kind: 'pdf',
      expectBytes: 177157,
      expectFrom: 'README EGLL downloads table',
    },
    { group: 'aip', source: 'Heathrow operator pages', rel: 'egll/heathrow_airline_contact_info.html', url: 'https://www.heathrow.com/airline-contact-info', kind: 'html', volatile: 'operator page, edited without notice' },
  );
  // The 62 charts: links come from the AD 2.EGLL page itself (fetched, or read from the output directory).
  const proc = new Map<string, { url: string; bytes?: number }>();
  collectPdfBlocks(readJson(path.join(SRC, 'egll-procedures.json')), proc);
  const bytesByUrl = new Map([...proc.values()].map((v) => [v.url, v.bytes]));
  const ad2 = path.join(out, 'egll/EG-AD-2.EGLL-en-GB.html');
  let html = '';
  if (fs.existsSync(ad2)) html = fs.readFileSync(ad2, 'utf8');
  if (!/graphics\/\d+\.pdf/.test(html)) {
    const res = await fetchWithRetry(ad2Url);
    html = res.ok ? res.body.toString('utf8') : '';
  }
  const links = parseChartLinks(html);
  if (links.length === 0) console.error('aip: no AD 2.24 chart links found on the AD 2.EGLL page');
  for (const l of links) {
    items.push({ group: 'aip', source: 'EGLL AD 2.24 charts', rel: `egll_aip_pdfs/${l.name}`, url: l.url, kind: 'pdf', expectBytes: bytesByUrl.get(l.url), expectFrom: bytesByUrl.get(l.url) ? 'egll-procedures.json' : undefined });
  }
  return items;
}

/** Unique values of a regex over the docs and the profile that cite them. */
function citedPages(re: RegExp): string[] {
  const files = [...fs.readdirSync(path.join(REPO, 'docs')).filter((f) => f.endsWith('.md')).map((f) => path.join(REPO, 'docs', f)), path.join(REPO, 'src/game/references.ts')];
  const found = new Set<string>();
  for (const f of files) for (const m of fs.readFileSync(f, 'utf8').matchAll(re)) found.add(m[1]);
  return [...found].sort();
}

function planDocs(): Item[] {
  const items: Item[] = [];
  // EUROCONTROL ACD pages: every type whose source cites raw/realism/eurocontrol_acd_<TYPE>.html.
  const perf = fs.readFileSync(path.join(SRC, 'aircraft-performance.json'), 'utf8');
  const types = [...new Set([...perf.matchAll(/eurocontrol_acd_([A-Z0-9]+)\.html/g)].map((m) => m[1]))].sort();
  for (const t of types) {
    items.push({ group: 'docs', source: 'EUROCONTROL ACD', rel: `realism/eurocontrol_acd_${t}.html`, url: `${ACD}${t}`, kind: 'html', mustContain: t, volatile: 'ACD is a live database; fetched for local provenance only (copyright permission needed to redistribute)' });
  }
  // Documents aircraft-performance.json names beside the ACD pages.
  const named: [string, string][] = [
    ['airbus_AC_A320_0624.pdf', 'https://aircraft.airbus.com/sites/g/files/jlcbta126/files/2024-06/AC_A320_0624.pdf'],
    ['befa_POH_Cessna_172S.pdf', 'https://www.befa.org/wp-content/uploads/2019/12/POH-Cessna-172S.pdf'],
    ['easa_tcds_IM.A.051_c172.pdf', 'https://www.easa.europa.eu/es/downloads/7423/en'],
  ];
  for (const [f, url] of named) items.push({ group: 'docs', source: 'Performance documents', rel: `realism/${f}`, url, kind: 'pdf' });
  items.push(
    { group: 'docs', source: 'Performance documents', rel: 'realism/ecfr_14cfr91_117.json', url: 'https://www.ecfr.gov/current/title-14/part-91/section-91.117', kind: 'html', volatile: 'eCFR is a living text (the committed copy was a JSON API response)' },
    { group: 'docs', source: 'Performance documents', rel: 'realism/textron_172.html', url: 'https://cessna.txtav.com/en/piston/cessna-skyhawk', kind: 'html', volatile: 'manufacturer page, edited without notice' },
    { group: 'docs', source: 'FAA JO 7110.126A', rel: 'realism/faa_JO_7110.126A.pdf', url: 'https://www.faa.gov/documentLibrary/media/Order/JO_7110.126A.pdf', kind: 'pdf' },
  );
  // JO 7110.65 and AIM pages the docs and src/game/references.ts cite (anchors stripped).
  for (const p of citedPages(/atpubs\/atc_html\/(chap\d+_section_\d+)\.html/g)) {
    items.push({ group: 'docs', source: 'FAA JO 7110.65 pages', rel: `realism/faa_7110_65_${p}.html`, url: `https://www.faa.gov/air_traffic/publications/atpubs/atc_html/${p}.html`, kind: 'html', volatile: 'FAA publishes a new change roughly every 6 months' });
  }
  for (const p of citedPages(/atpubs\/aim_html\/(chap\d+_section_\d+)\.html/g)) {
    items.push({ group: 'docs', source: 'FAA AIM pages', rel: `realism/faa_aim_${p}.html`, url: `https://www.faa.gov/air_traffic/publications/atpubs/aim_html/${p}.html`, kind: 'html', volatile: 'FAA publishes a new change roughly every 6 months' });
  }
  items.push(
    { group: 'docs', source: 'CAP 413', rel: 'cap413/CAP413_Edition24.pdf', url: 'https://www.caa.co.uk/publication/download/18165', kind: 'pdf', expectBytes: 2989016, expectFrom: 'README EGLL downloads table' },
    // KBOS / KPHL runway-use documents (kbos-runway-configurations.json, kphl-runway-configurations.json).
    { group: 'docs', source: 'Runway-use documents', rel: 'kbos_runway_use_docs/mcac_logan101.pdf', url: 'https://massportcac.org/wp-content/uploads/2017/06/Final-BOS-Update-MCAC-Logan-101-060817.pdf', kind: 'pdf' },
    { group: 'docs', source: 'Runway-use documents', rel: 'kbos_runway_use_docs/faa_appendixA.pdf', url: 'https://www.faa.gov/sites/faa.gov/files/air_traffic/environmental_issues/ared_documentation/Appendix_A_Noise_Modeling_06032013.pdf', kind: 'pdf' },
    { group: 'docs', source: 'Runway-use documents', rel: 'kbos_runway_use_docs/mcac_brief2016.pdf', url: 'https://massportcac.org/wp-content/uploads/2017/03/Massport-Briefing-to-MassportCAC-Annual-Mtg-12-08-2016.pdf', kind: 'pdf' },
    { group: 'docs', source: 'Runway-use documents', rel: 'kphl_runway_config/noise_office.html', url: 'https://phl.org/Noise-Office', kind: 'html', volatile: 'operator page, edited without notice' },
    { group: 'docs', source: 'Runway-use documents', rel: 'kphl_runway_config/nem2010_part1.pdf', url: 'https://www.phl.org/drupalbin/media/2010%20Noise%20Exposure%20Maps%20Report_Part1.pdf', kind: 'pdf' },
    { group: 'docs', source: 'Runway-use documents', rel: 'kphl_traffic/phl_airlines.html', url: 'https://www.phl.org/about/airlines', kind: 'html', volatile: 'operator page, edited without notice' },
    // Weather: API documentation and sample responses (data/sources/weather-api.md). Samples are live, they differ.
    { group: 'docs', source: 'AWC / NWS weather', rel: 'awc_api_docs.html', url: 'https://aviationweather.gov/data/api/', kind: 'html', volatile: 'API documentation page' },
    { group: 'docs', source: 'AWC / NWS weather', rel: 'awc_metar_KACY.json', url: 'https://aviationweather.gov/api/data/metar?ids=KACY&format=json', kind: 'json', volatile: 'SAMPLE response, differs on every fetch' },
    { group: 'docs', source: 'AWC / NWS weather', rel: 'awc_taf_KACY.json', url: 'https://aviationweather.gov/api/data/taf?ids=KACY&format=json', kind: 'json', volatile: 'SAMPLE response, differs on every fetch' },
    { group: 'docs', source: 'AWC / NWS weather', rel: 'awc_metar_EGLL.json', url: 'https://aviationweather.gov/api/data/metar?ids=EGLL&format=json', kind: 'json', volatile: 'SAMPLE response, differs on every fetch' },
  );
  for (const icao of ['KBOS', 'KPHL', 'KPGD']) {
    items.push({ group: 'docs', source: 'AWC / NWS weather', rel: `nws_${icao}_latest.json`, url: `https://api.weather.gov/stations/${icao}/observations/latest`, kind: 'json', volatile: 'SAMPLE response, differs on every fetch' });
  }
  return items;
}

// ---------------------------------------------------------------------------------------------------------------------
// Download

interface Fetched {
  ok: boolean;
  status: number;
  body: Buffer;
  error?: string;
}

/** 404 / 410 / 403 / 401 / 451 are final answers: reported, not retried. */
const FINAL_HTTP = new Set([400, 401, 403, 404, 410, 451]);

const hostLimit = new Map<string, { limit: number; active: number }>();
async function withHost<T>(url: string, fn: () => Promise<T>): Promise<T> {
  const host = new URL(url).host;
  const slot = hostLimit.get(host) ?? { limit: host === 'overpass-api.de' ? 1 : CONCURRENCY, active: 0 };
  hostLimit.set(host, slot);
  while (slot.active >= slot.limit) await sleep(200);
  slot.active++;
  try {
    return await fn();
  } finally {
    slot.active--;
  }
}

async function fetchWithRetry(url: string): Promise<Fetched> {
  let last = '';
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await withHost(url, () => fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, signal: AbortSignal.timeout(180_000), redirect: 'follow' }));
      if (res.ok) {
        const body = Buffer.from(await res.arrayBuffer());
        const len = Number(res.headers.get('content-length') ?? 0);
        if (len && !res.headers.get('content-encoding') && body.length !== len) throw new Error(`truncated (${body.length} of ${len} bytes)`);
        return { ok: true, status: res.status, body };
      }
      if (FINAL_HTTP.has(res.status)) return { ok: false, status: res.status, body: Buffer.alloc(0), error: `HTTP ${res.status}` };
      last = `HTTP ${res.status}`;
      // Overpass answers 429 / 502 / 503 / 504 when busy: wait longer.
      if ([429, 502, 503, 504].includes(res.status)) await sleep(15_000 * attempt);
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    if (attempt < RETRIES) await sleep(1000 * 2 ** (attempt - 1));
  }
  return { ok: false, status: 0, body: Buffer.alloc(0), error: last };
}

// ---------------------------------------------------------------------------------------------------------------------
// Validation

const hasXmllint = (() => {
  try {
    execFileSync('xmllint', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** Returns null when the file is a valid instance of its kind, else the reason. */
function validate(file: string, item: Item): string | null {
  const size = fs.statSync(file).size;
  if (size === 0) return 'empty file';
  if (item.kind === 'zip') {
    try {
      execFileSync('unzip', ['-tq', file], { stdio: 'pipe' });
      return null;
    } catch {
      return 'zip integrity test failed';
    }
  }
  if (item.kind === 'pdf') {
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(5);
    fs.readSync(fd, head, 0, 5, 0);
    fs.closeSync(fd);
    return head.toString('latin1') === '%PDF-' && size > 1000 ? null : 'not a PDF (missing %PDF- header)';
  }
  if (item.kind === 'xml') {
    if (hasXmllint) {
      try {
        execFileSync('xmllint', ['--noout', '--stream', file], { stdio: 'pipe' });
      } catch {
        return 'XML does not parse (xmllint)';
      }
    } else if (!/^\s*<\?xml|^\s*</.test(fs.readFileSync(file, 'utf8').slice(0, 200))) return 'not XML';
    if (item.mustContain && !fs.readFileSync(file, 'utf8').includes(item.mustContain)) return `XML lacks "${item.mustContain}"`;
    return null;
  }
  const text = fs.readFileSync(file, 'utf8');
  if (item.kind === 'json') {
    try {
      JSON.parse(text);
    } catch {
      return 'JSON does not parse';
    }
    return null;
  }
  if (item.rel.endsWith('.json')) {
    // eCFR-style: the committed copy was an API JSON response; an HTML page is accepted as a re-fetch.
    return text.length > 200 ? null : 'too short';
  }
  if (!/<html|<!doctype html/i.test(text.slice(0, 5000))) return 'not an HTML page';
  if (item.mustContain && !text.includes(item.mustContain)) return `page lacks "${item.mustContain}"`;
  return null;
}

function unzipIfNeeded(item: Item, out: string): string | null {
  const m = /_([A-Z_]+)_CSV\.zip$/.exec(item.rel);
  if (!m || item.group !== 'nasr') return null;
  const dir = path.join(out, path.dirname(item.rel), `x_${m[1]}_CSV`);
  const hasCsv = fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.toLowerCase().endsWith('.csv'));
  if (!hasCsv) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('unzip', ['-oq', path.join(out, item.rel), '-d', dir], { stdio: 'pipe' });
  }
  return fs.readdirSync(dir).some((f) => f.toLowerCase().endsWith('.csv')) ? null : `no CSV inside ${path.basename(item.rel)}`;
}

function osmBaseTimestamp(file: string): { base: string; elements: number } | null {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { osm3s?: { timestamp_osm_base?: string }; elements?: unknown[] };
    if (!j.osm3s?.timestamp_osm_base || !Array.isArray(j.elements)) return null;
    return { base: j.osm3s.timestamp_osm_base, elements: j.elements.length };
  } catch {
    return null;
  }
}

async function process1(item: Item, out: string): Promise<Result> {
  const dest = path.join(out, item.rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let downloaded = false;
  let reason = fs.existsSync(dest) ? validate(dest, item) : 'absent';
  if (item.group === 'osm' && !reason && !osmBaseTimestamp(dest)) reason = 'not an Overpass response';
  if (reason) {
    const res = await fetchWithRetry(item.url);
    if (!res.ok) {
      const missing = FINAL_HTTP.has(res.status);
      return { item, status: missing ? 'MISSING' : 'FAILED', bytes: 0, note: res.error ?? 'download failed', downloaded };
    }
    const tmp = `${dest}.part`;
    fs.writeFileSync(tmp, res.body);
    const bad = validate(tmp, item) ?? (item.group === 'osm' && !osmBaseTimestamp(tmp) ? 'not an Overpass response' : null);
    if (bad) {
      fs.rmSync(tmp, { force: true });
      return { item, status: 'FAILED', bytes: res.body.length, note: `invalid download: ${bad}`, downloaded };
    }
    fs.renameSync(tmp, dest);
    downloaded = true;
  }
  const bytes = fs.statSync(dest).size;
  const unzipErr = unzipIfNeeded(item, out);
  if (unzipErr) return { item, status: 'FAILED', bytes, note: unzipErr, downloaded };

  let note = '';
  if (item.group === 'osm') {
    const now = osmBaseTimestamp(dest);
    const committed = (readJson(path.join(SRC, item.geojson ?? '')).properties as { osm_base_timestamp?: string }).osm_base_timestamp;
    note = `RE-FETCH: osm_base ${now?.base} (${now?.elements} elements) vs committed ${committed}${item.expectBytes ? `; recorded ${item.expectBytes} B` : ''}`;
    return { item, status: 'REFETCH', bytes, note, downloaded };
  }
  if (item.expectBytes !== undefined) {
    if (bytes === item.expectBytes) return { item, status: 'MATCH', bytes, note: '', downloaded };
    if (item.volatile) return { item, status: 'REFETCH', bytes, note: `${item.volatile}; ${bytes} B vs recorded ${item.expectBytes} B`, downloaded };
    return { item, status: 'MISMATCH', bytes, note: `${bytes} B vs recorded ${item.expectBytes} B (${item.expectFrom})`, downloaded };
  }
  if (item.volatile) return { item, status: 'REFETCH', bytes, note: item.volatile, downloaded };
  return { item, status: 'UNRECORDED', bytes, note: 'no size recorded', downloaded };
}

// ---------------------------------------------------------------------------------------------------------------------
// Main

async function pool<T, R>(xs: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const results = Array.from<R>({ length: xs.length });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, xs.length) }, async () => {
      while (next < xs.length) {
        const i = next++;
        results[i] = await fn(xs[i], i);
      }
    }),
  );
  return results;
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function main() {
  const { groups, out, list, verbose } = parseArgs(process.argv.slice(2));
  fs.mkdirSync(out, { recursive: true });
  const items: Item[] = [];
  if (groups.has('nasr')) items.push(...planNasr());
  if (groups.has('dtpp')) items.push(...planDtpp());
  if (groups.has('osm')) items.push(...planOsm());
  if (groups.has('aip')) items.push(...(await planAip(out)));
  if (groups.has('docs')) items.push(...planDocs());

  // One entry per destination.
  const byRel = new Map<string, Item>();
  for (const it of items) if (!byRel.has(it.rel)) byRel.set(it.rel, it);
  const plan = [...byRel.values()];
  console.log(`output ${out}\n${plan.length} files in groups ${[...groups].join(', ')}`);
  if (list) {
    for (const it of plan) console.log(`${it.group}\t${it.rel}\t${it.url}`);
    return;
  }
  if (groups.has('aip')) console.log('note: UK AIP content is (c) NATS Limited and EUROCONTROL ACD pages need copyright permission to redistribute: fetched for local provenance only, never commit data/sources/raw/.');

  let done = 0;
  const results = await pool(plan, CONCURRENCY, async (it) => {
    const r = await process1(it, out);
    done++;
    if (done % 25 === 0 || done === plan.length) process.stderr.write(`  ${done}/${plan.length}\n`);
    return r;
  });

  // Manifest (merged with the previous one) and TSV report.
  const manifestPath = path.join(out, 'fetch-manifest.json');
  let manifest: Record<string, unknown> = {};
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  } catch {
    manifest = {};
  }
  const now = new Date().toISOString();
  for (const r of results) {
    if (r.status === 'MISSING' || r.status === 'FAILED') continue;
    const prev = manifest[r.item.rel] as { retrieved?: string } | undefined;
    manifest[r.item.rel] = { url: r.item.url, bytes: r.bytes, sha256: sha256(path.join(out, r.item.rel)), retrieved: r.downloaded ? now : (prev?.retrieved ?? 'kept from an earlier run'), status: r.status, note: r.note };
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 1)}\n`);
  fs.writeFileSync(path.join(out, 'fetch-report.tsv'), `status\tgroup\tsource\tfile\tbytes\turl\tnote\n${results.map((r) => [r.status, r.item.group, r.item.source, r.item.rel, r.bytes, r.item.url, r.note].join('\t')).join('\n')}\n`);

  // Summary: per source, counts per status.
  const statuses: Status[] = ['MATCH', 'MISMATCH', 'UNRECORDED', 'REFETCH', 'MISSING', 'FAILED'];
  const bySource = new Map<string, Result[]>();
  for (const r of results) bySource.set(r.item.source, [...(bySource.get(r.item.source) ?? []), r]);
  const w = Math.max(...[...bySource.keys()].map((k) => k.length), 6);
  console.log(`\n${'source'.padEnd(w)}  files  ${statuses.map((s) => s.padStart(10)).join(' ')}  downloaded`);
  for (const [src, rs] of bySource) {
    console.log(`${src.padEnd(w)}  ${String(rs.length).padStart(5)}  ${statuses.map((s) => String(rs.filter((r) => r.status === s).length).padStart(10)).join(' ')}  ${rs.filter((r) => r.downloaded).length}`);
  }
  console.log(`${'TOTAL'.padEnd(w)}  ${String(results.length).padStart(5)}  ${statuses.map((s) => String(results.filter((r) => r.status === s).length).padStart(10)).join(' ')}  ${results.filter((r) => r.downloaded).length}`);

  const shown = results.filter((r) => verbose || r.status === 'MISMATCH' || r.status === 'MISSING' || r.status === 'FAILED' || r.item.group === 'osm' || r.note.startsWith('SAMPLE'));
  if (shown.length) console.log('\nrows needing attention (all rows: fetch-report.tsv in the output directory)');
  for (const r of shown) console.log(`${r.status.padEnd(10)} ${r.item.rel}  ${r.note}  <${r.item.url.length > 110 ? `${r.item.url.slice(0, 110)}...` : r.item.url}>`);
  if (results.some((r) => r.status === 'MISSING' || r.status === 'FAILED')) process.exitCode = 2;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
