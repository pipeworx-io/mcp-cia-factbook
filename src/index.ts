interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Country reference data — keyless, from the dataset REST Countries is built on.
 *
 * WHY THIS EXISTS: restcountries.com deprecated v3.1 and every path on that
 * host now 301s to a static `legacy.json` that returns **HTTP 200** with
 * `{success:false, data:null, errors:[…]}`. Callers that check `res.ok` sail
 * straight past it, then find the body isn't the array they expected and
 * normalize to `[]`. That is exactly what happened here: the `countries` pack
 * returned `{results:[]}` for every query for an unknown number of days without
 * throwing once, and `geo.get_country` blew up on `data[0].name` and had the
 * resulting TypeError misreported to callers as "a required value was missing".
 * v5 exists but requires an API key, which this pack has never needed.
 *
 * So we go to the source: `mledoze/countries` is the open dataset REST
 * Countries itself packages. It's CC-BY-SA, served by jsDelivr, and pinned to a
 * TAG rather than @master — country data changes on the order of once a year,
 * and an unpinned ref means an upstream edit can silently reshape our output.
 *
 * The lesson encoded below: a data source that stops working must FAIL, loudly.
 * Every branch that can't produce real country data throws. Returning an empty
 * array on a broken upstream is what let the original bug hide.
 */

/** Pinned deliberately — see the file header. Bump only with a schema re-check. */
const DATASET_URL = 'https://cdn.jsdelivr.net/gh/mledoze/countries@v4.1.1/countries.json';

/**
 * Population is the one field the dataset doesn't carry, and it's one of the
 * most-asked country facts, so we merge it from the World Bank (keyless).
 * `mrnev=1` = most recent non-empty value per country, so this is one ~50KB
 * call for all ~260 of them rather than a per-country lookup.
 */
const POPULATION_URL =
  'https://api.worldbank.org/v2/country/all/indicator/SP.POP.TOTL?format=json&mrnev=1&per_page=400';

interface CountryRecord {
  name: { common: string; official: string };
  capital?: string[];
  region: string;
  subregion?: string;
  /** null when the World Bank has no series for this territory (see mergePopulation). */
  population: number | null;
  /** Year the population figure is from — omitted when population is null. */
  population_year?: string;
  area?: number;
  languages?: Record<string, string>;
  currencies?: Record<string, { name: string; symbol: string }>;
  flag?: string;
  cca2: string;
  cca3: string;
  flags: { png: string; svg: string };
  latlng?: [number, number];
  borders?: string[];
  tld?: string[];
}

interface RawCountry {
  name?: { common?: string; official?: string };
  capital?: string[];
  region?: string;
  subregion?: string;
  area?: number;
  languages?: Record<string, string>;
  currencies?: Record<string, { name: string; symbol: string }>;
  flag?: string;
  cca2?: string;
  cca3?: string;
  latlng?: [number, number];
  borders?: string[];
  tld?: string[];
}

/**
 * Isolate-lifetime memo. Holds the PROMISE so concurrent requests in the same
 * isolate share one fetch instead of each pulling 1.2MB. Cleared on failure —
 * caching a rejection would turn one bad minute into a dead isolate.
 */
let cache: Promise<CountryRecord[]> | null = null;

function flagUrls(cca2: string): { png: string; svg: string } {
  // flagcdn keys off the lowercase alpha-2 code; this is the same CDN REST
  // Countries served its `flags` field from, so consumers see unchanged URLs.
  const k = cca2.toLowerCase();
  return { png: `https://flagcdn.com/w320/${k}.png`, svg: `https://flagcdn.com/${k}.svg` };
}

/**
 * Best-effort. The World Bank going down must NOT re-break the pack the way
 * restcountries did — a country with a null population is still a useful
 * answer, an exception is not. Callers get `population: null`, which is
 * honest, rather than a stale or invented number.
 */
async function fetchPopulations(): Promise<Map<string, { value: number; year: string }>> {
  const out = new Map<string, { value: number; year: string }>();
  try {
    const res = await fetch(POPULATION_URL);
    if (!res.ok) return out;
    const body = (await res.json()) as unknown;
    // Shape is [meta, rows]; anything else means the API changed under us.
    if (!Array.isArray(body) || body.length < 2 || !Array.isArray(body[1])) return out;
    for (const row of body[1] as { countryiso3code?: string; value?: number; date?: string }[]) {
      const iso3 = row?.countryiso3code;
      if (iso3 && typeof row.value === 'number') {
        out.set(iso3.toUpperCase(), { value: row.value, year: row.date ?? '' });
      }
    }
  } catch {
    // Swallow deliberately — see the doc comment. The caller still gets countries.
  }
  return out;
}

async function loadFresh(): Promise<CountryRecord[]> {
  const res = await fetch(DATASET_URL);
  if (!res.ok) {
    throw new Error(`Country dataset unavailable: HTTP ${res.status} from jsDelivr`);
  }
  const raw = (await res.json()) as unknown;
  // The restcountries failure was a 200 whose BODY was wrong. Check the shape,
  // not just the status, and refuse to serve a plausible-looking empty result.
  if (!Array.isArray(raw) || raw.length < 100) {
    throw new Error(
      `Country dataset malformed: expected an array of ~250 countries, got ${
        Array.isArray(raw) ? `${raw.length} entries` : typeof raw
      }`,
    );
  }

  const populations = await fetchPopulations();

  const records: CountryRecord[] = [];
  for (const c of raw as RawCountry[]) {
    // Every downstream mapper reads name.common and cca2; an entry missing
    // either can't be rendered, so drop it here rather than at five call sites.
    if (!c?.name?.common || !c.cca2 || !c.cca3) continue;
    const pop = populations.get(c.cca3.toUpperCase());
    records.push({
      name: { common: c.name.common, official: c.name.official ?? c.name.common },
      capital: c.capital,
      region: c.region ?? '',
      subregion: c.subregion,
      population: pop?.value ?? null,
      ...(pop?.year ? { population_year: pop.year } : {}),
      area: c.area,
      languages: c.languages,
      currencies: c.currencies,
      flag: c.flag,
      cca2: c.cca2,
      cca3: c.cca3,
      flags: flagUrls(c.cca2),
      latlng: c.latlng,
      borders: c.borders,
      tld: c.tld,
    });
  }

  if (records.length < 100) {
    throw new Error(`Country dataset malformed: only ${records.length} usable entries`);
  }
  return records;
}

/** Load (and memoize) the full country list. Throws if the data is unusable. */
async function loadCountries(): Promise<CountryRecord[]> {
  if (!cache) {
    cache = loadFresh().catch((err) => {
      cache = null; // don't pin a failure for the isolate's lifetime
      throw err;
    });
  }
  return cache;
}

// ── Query helpers ──────────────────────────────────────────────────────
// Substring/case-insensitive matching throughout, because these back
// natural-language tools where the caller types "holland" or "eur", not an
// exact key. Sorting is by population desc where the tool shows a list, with
// nulls last so a missing World Bank series doesn't push a country to the top.

function norm$shared(s: string): string {
  return s.trim().toLowerCase();
}

/** Population-desc comparator that keeps null populations at the end. */
function byPopulationDesc(a: CountryRecord, b: CountryRecord): number {
  if (a.population === b.population) return a.name.common.localeCompare(b.name.common);
  if (a.population === null) return 1;
  if (b.population === null) return -1;
  return b.population - a.population;
}

async function findCountriesByName(query: string): Promise<CountryRecord[]> {
  const q = norm$shared(query);
  if (!q) return [];
  const all = await loadCountries();
  // Exact common/official match wins outright — "Niger" must not be buried
  // under "Nigeria" just because the substring pass matches both.
  const exact = all.filter((c) => norm$shared(c.name.common) === q || norm$shared(c.name.official) === q);
  if (exact.length) return exact;
  return all
    .filter((c) => norm$shared(c.name.common).includes(q) || norm$shared(c.name.official).includes(q))
    .sort(byPopulationDesc);
}

async function findCountryByCode(code: string): Promise<CountryRecord | null> {
  const c = norm$shared(code);
  if (!c) return null;
  const all = await loadCountries();
  return all.find((x) => norm$shared(x.cca2) === c || norm$shared(x.cca3) === c) ?? null;
}

async function findCountriesByRegion(region: string): Promise<CountryRecord[]> {
  const r = norm$shared(region);
  if (!r) return [];
  const all = await loadCountries();
  return all
    .filter((c) => norm$shared(c.region) === r || norm$shared(c.subregion ?? '') === r)
    .sort(byPopulationDesc);
}

async function findCountriesByLanguage(language: string): Promise<CountryRecord[]> {
  const l = norm$shared(language);
  if (!l) return [];
  const all = await loadCountries();
  // Match the language NAME ("Estonian") or its ISO-639-3 key ("est"), since
  // callers supply either and the dataset stores both.
  return all
    .filter((c) =>
      Object.entries(c.languages ?? {}).some(
        ([key, name]) => norm$shared(key) === l || norm$shared(name).includes(l),
      ),
    )
    .sort(byPopulationDesc);
}

async function findCountriesByCurrency(currency: string): Promise<CountryRecord[]> {
  const cur = norm$shared(currency);
  if (!cur) return [];
  const all = await loadCountries();
  // Match the code ("EUR"), the name ("Euro"), or a partial name ("dollar"),
  // which is how these tools are actually called.
  return all
    .filter((c) =>
      Object.entries(c.currencies ?? {}).some(
        ([code, meta]) => norm$shared(code) === cur || norm$shared(meta?.name ?? '').includes(cur),
      ),
    )
    .sort((a, b) => a.name.common.localeCompare(b.name.common));
}


/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}${responseHints(res)}`,
    res.url,
    res.status,
  );
}

/**
 * Facts about a FAILED response that live in its headers, not its body, appended
 * so the gateway's classifier (which only ever sees this string) can tell a limit
 * from a wall from a refusal (fleet #3477). Both are standard, both are absent on
 * almost every response, and neither is invented: `Retry-After` is the server
 * saying "come back later" (the one thing that makes a 403 a throttle), and
 * Cloudflare marks a bot challenge with `cf-mitigated: challenge`.
 */
function responseHints(res: Response): string {
  const hints: string[] = [];
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) hints.push(`retry-after: ${retryAfter.slice(0, 40)}`);
  if ((res.headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge') hints.push('Cloudflare bot challenge (cf-mitigated: challenge)');
  return hints.length ? ` (${hints.join('; ')})` : '';
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ── Bounded readers — peak memory, not just wall time (fleet #3322) ──────
//
// `parseJson` above does `await res.text()` then `JSON.parse(raw)`, so a
// multi-megabyte upstream body is held TWICE at peak: once as the raw string
// and once as the object graph (which for an array of small objects runs
// several times the byte size). Nothing in `workers/gateway` can see that
// peak — it happens inside the pack, before any gateway code holds a payload —
// which is why the gateway-side payload caps of #3293 and #3320 did not move
// the 503/1102 rate at all.
//
// Measured on the live gateway, 2026-10-19, sha fa5de5c34, direct tools/call:
//   statcan_list_cubes  8,049,566 B   <- one upstream array, no limit argument
//   gnomad_gene BRCA1   2,732,706 B
// Five of those in flight at the quality runner's width is ~40 MB of parse
// peak against a 128 MB isolate; Cloudflare kills the isolate and every
// request in flight returns 503/1102, which is why the victims look random.
//
// `readJsonArrayPrefix` is the fix for the dominant shape: an upstream that
// returns one enormous top-level JSON array with no server-side paging. It
// parses elements off the stream and DISCARDS the consumed bytes, so peak
// retained memory is one element plus one chunk rather than the whole body,
// and it cancels the body as soon as it has what it was asked for.

/** Default ceiling for a single upstream JSON body read into an isolate.
 *  Chosen so the known tail (statcan 8.0 MB, gnomad 2.7 MB) is bounded well
 *  below the point where a handful of concurrent reads exhausts 128 MB. */
const DEFAULT_MAX_JSON_BYTES = 1_500_000;

interface JsonArrayPrefix<T> {
  /** The decoded elements, at most `maxItems` of them. */
  items: T[];
  /** True when the upstream array had more elements than we read. */
  truncated: boolean;
  /** Bytes actually pulled off the socket — the number that bounds memory. */
  bytesRead: number;
  /** `Content-Length` if the upstream declared one, else null. */
  declaredBytes: number | null;
}

/**
 * Read the FIRST `maxItems` elements of a top-level JSON array off a response
 * stream without ever materialising the whole body.
 *
 * Use this instead of `parseJson` when the upstream returns one big array and
 * offers no `limit`/`offset` of its own. Peak retained memory is one element
 * plus the current chunk; the body is cancelled as soon as `maxItems` is
 * reached, so the remaining megabytes are never transferred at all.
 *
 *     const { items, truncated } = await readJsonArrayPrefix<Cube>(
 *       res, 'StatCan WDS', { maxItems: limit + offset });
 *
 * `maxBytes` is a second, independent backstop for a pathological element (a
 * single 50 MB object): hitting it stops the read and sets `truncated`, rather
 * than throwing, because a partial answer plus an explicit truncated flag is
 * more useful to a caller than an error.
 */
async function readJsonArrayPrefix<T>(
  res: Response,
  name: string,
  opts: { maxItems: number; maxBytes?: number },
): Promise<JsonArrayPrefix<T>> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  const declaredRaw = Number(res.headers.get('content-length'));
  const declaredBytes = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  // No streaming body available (a mock, or an already-buffered response):
  // fall back to the whole-text path so behaviour stays correct, just unbounded.
  if (!res.body) {
    const all = await parseJson<T[]>(res, name);
    if (!Array.isArray(all)) throw new Error(`upstream_down: ${name} returned ${typeof all} where a JSON array was expected.`);
    return {
      items: all.slice(0, opts.maxItems),
      truncated: all.length > opts.maxItems,
      bytesRead: declaredBytes ?? 0,
      declaredBytes,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const items: T[] = [];

  let buf = '';
  let scan = 0;
  let bytesRead = 0;
  let started = false; // consumed the opening '['
  let arrayEnded = false;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let elemStart = -1;
  let truncated = false;

  const push = (text: string) => {
    const t = text.trim();
    if (!t) return;
    items.push(JSON.parse(t) as T);
  };

  try {
    outer: while (items.length < opts.maxItems && !arrayEnded) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      buf += decoder.decode(value, { stream: true });
      if (bytesRead > maxBytes) { truncated = true; break; }

      for (; scan < buf.length; scan++) {
        const ch = buf[scan];

        if (inStr) {
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') inStr = false;
          continue;
        }

        if (!started) {
          if (ch === '[') { started = true; continue; }
          if (ch.trim() === '') continue;
          throw new Error(
            `upstream_down: ${name} returned a body that does not begin with a JSON array (saw ${JSON.stringify(ch)}). ` +
              'This reader is only for upstreams that answer with one top-level array.',
          );
        }

        if (ch === '"') { if (depth === 0 && elemStart < 0) elemStart = scan; inStr = true; continue; }

        if (ch === '{' || ch === '[') {
          if (depth === 0 && elemStart < 0) elemStart = scan;
          depth++;
          continue;
        }

        if (ch === '}' || ch === ']') {
          if (depth > 0) {
            depth--;
            if (depth === 0 && elemStart >= 0) {
              push(buf.slice(elemStart, scan + 1));
              elemStart = -1;
              if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
            }
            continue;
          }
          // depth 0 and a closing bracket: the end of the top-level array.
          if (elemStart >= 0) { push(buf.slice(elemStart, scan)); elemStart = -1; }
          arrayEnded = true;
          break outer;
        }

        if (ch === ',' && depth === 0) {
          if (elemStart >= 0) {
            push(buf.slice(elemStart, scan));
            elemStart = -1;
            if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
          }
          continue;
        }

        // A bare scalar element (number / true / false / null).
        if (depth === 0 && elemStart < 0 && ch.trim() !== '') elemStart = scan;
      }

      // Drop everything already consumed. THIS is what bounds memory: without
      // it `buf` grows to the full body and the reader is streaming in name only.
      if (elemStart >= 0) {
        buf = buf.slice(elemStart);
        scan -= elemStart;
        elemStart = 0;
      } else {
        buf = buf.slice(scan);
        scan = 0;
      }
    }
  } finally {
    // Cancel rather than drain: the point is that the remaining megabytes are
    // never transferred. A cancel on an already-finished body is a no-op.
    await reader.cancel().catch(() => {});
  }

  return { items, truncated, bytesRead, declaredBytes };
}

/**
 * `parseJson`, with a hard ceiling on how many bytes are read.
 *
 * For an upstream whose body is not a single array (so `readJsonArrayPrefix`
 * does not apply) but which can still answer with megabytes. Unlike the array
 * reader this one THROWS when the cap is hit, because a truncated prefix of an
 * arbitrary JSON document is not parseable and there is no partial answer to
 * hand back. A declared `Content-Length` over the cap is refused before a
 * single chunk is read.
 */
async function parseJsonBounded<T>(
  res: Response,
  name: string,
  maxBytes: number = DEFAULT_MAX_JSON_BYTES,
): Promise<T> {
  const declaredRaw = Number(res.headers.get('content-length'));
  const declared = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  const tooBig = (n: number) =>
    new Error(
      `upstream_down: ${name} answered with ${n.toLocaleString()} bytes, over this pack's ${maxBytes.toLocaleString()}-byte ceiling. ` +
        'The body is not read past the ceiling on purpose — a few concurrent reads of a body that size exhaust the ' +
        'Worker isolate and take every other in-flight request down with them. Narrow the request (a smaller range, ' +
        'a specific id, or a lower limit) and retry.',
    );

  if (declared !== null && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooBig(declared);
  }
  if (!res.body) return parseJson<T>(res, name);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let bytesRead = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) throw tooBig(bytesRead);
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected. ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON. ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}
/**
 * CIA World Factbook MCP — country profiles from The World Factbook.
 *
 * The CIA published The World Factbook as public-domain country profiles and
 * discontinued it in February 2026. Its final edition survives as the
 * factbook.json open archive (maintained by the factbook project on GitHub,
 * CC0), one JSON document per entity keyed by the Factbook's own two-letter
 * GEC code (Austria is `au`, Germany is `gm` — NOT ISO). This pack calls that
 * archive per request; nothing is copied.
 *
 * Tools:
 * - factbook_country:  one entity's profile, by section (government, economy, people…)
 * - factbook_compare:  named fields side by side across several countries
 * - factbook_fields:   the sections and field names an entity carries
 * - factbook_entities: list / search the 261 entities (countries, territories, oceans, EU, World)
 */

import { ENTITIES } from './entities.js';

const UA = 'pipeworx-cia-factbook/1.0 (+https://pipeworx.io)';
const BASE = 'https://raw.githubusercontent.com/factbook/factbook.json/master';

const SOURCE = 'CIA, The World Factbook (final edition)';
const LICENCE = 'Public domain (US government work); the factbook project archive is CC0-1.0';
// The archive's last data update before the CIA took the Factbook down in
// February 2026 ("auto-update week 4", 2026-01-22). The source is gone, so
// this date will not move.
const DATA_AS_OF = '2026-01-22';
const EDITION_NOTE =
  'The CIA discontinued The World Factbook in February 2026; this is its final edition. Figures carry their own estimate year (e.g. "2024 est.").';

const DEFAULT_SECTIONS = ['Introduction', 'Geography', 'People and Society', 'Government', 'Economy'];

async function pwFetch(url: string): Promise<Response> {
  return fetchWithTimeout(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } }, 'CIA World Factbook archive');
}

// ── Entity resolution ──────────────────────────────────────────────────

interface Entity { code: string; region: string; name: string; long_name: string }

const ALL: Entity[] = ENTITIES.map(([code, region, name, long_name]) => ({ code, region, name, long_name }));

function norm(s: string): string {
  return s
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/^the /, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Everyday names the Factbook spells differently. Values are GEC codes. */
const ALIASES: Record<string, string> = {
  'usa': 'us', 'us': 'us', 'america': 'us', 'united states of america': 'us',
  'uk': 'uk', 'britain': 'uk', 'great britain': 'uk', 'england': 'uk', 'scotland': 'uk', 'wales': 'uk',
  'myanmar': 'bm', 'turkiye': 'tu', 'czech republic': 'ez', 'ivory coast': 'iv', 'cote divoire': 'iv',
  'swaziland': 'wz', 'macedonia': 'mk', 'east timor': 'tt', 'vatican': 'vt', 'vatican city': 'vt', 'holy see': 'vt',
  'democratic republic of the congo': 'cg', 'drc': 'cg', 'congo kinshasa': 'cg', 'dr congo': 'cg',
  'republic of the congo': 'cf', 'congo brazzaville': 'cf', 'congo republic': 'cf',
  'gambia': 'ga', 'bahamas': 'bf', 'micronesia': 'fm', 'cape verde': 'cv',
  'korea': 'ks', 'south korea': 'ks', 'republic of korea': 'ks', 'north korea': 'kn', 'dprk': 'kn',
  'uae': 'ae', 'emirates': 'ae', 'holland': 'nl', 'netherlands': 'nl', 'persia': 'ir', 'ceylon': 'ce',
  'palestine': 'we', 'gaza': 'gz', 'gaza strip': 'gz', 'eu': 'ee', 'europe union': 'ee', 'world': 'xx',
  'russian federation': 'rs', 'viet nam': 'vm', 'lao': 'la', 'macao': 'mc', 'spitsbergen': 'sv',
};

const BY_CODE = new Map(ALL.map((e) => [e.code, e]));
const BY_NAME = new Map<string, Entity>();
for (const e of ALL) {
  BY_NAME.set(norm(e.name), e);
  if (e.long_name) BY_NAME.set(norm(e.long_name), e);
}

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

function closeMatches(q: string, n = 5): string[] {
  const nq = norm(q);
  return ALL
    .map((e) => {
      const nn = norm(e.name);
      const score = nn.includes(nq) || nq.includes(nn) ? 0 : editDistance(nq, nn) / Math.max(nq.length, nn.length);
      return { name: e.name, score };
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, n)
    .map((m) => m.name);
}

type Resolved = { entity: Entity; matched_by: string } | { entity: null; close_matches: string[] };

async function resolve(input: string): Promise<Resolved> {
  const raw = String(input ?? '').trim();
  const q = norm(raw);
  if (!q) return { entity: null, close_matches: [] };

  // "gec:au" forces a Factbook code; bare 2/3-letter input is read as ISO first.
  const gec = /^gec[: ]([a-z]{2})$/i.exec(raw);
  if (gec && BY_CODE.has(gec[1].toLowerCase())) return { entity: BY_CODE.get(gec[1].toLowerCase())!, matched_by: 'gec_code' };

  const exact = BY_NAME.get(q);
  if (exact) return { entity: exact, matched_by: 'name' };
  const alias = ALIASES[q];
  if (alias && BY_CODE.has(alias)) return { entity: BY_CODE.get(alias)!, matched_by: 'alias' };

  if (/^[a-z]{2,3}$/i.test(raw)) {
    try {
      const iso = await findCountryByCode(raw);
      if (iso) {
        for (const cand of [iso.name.common, iso.name.official]) {
          const n = norm(cand);
          const hit = BY_NAME.get(n) ?? (ALIASES[n] ? BY_CODE.get(ALIASES[n]) : undefined);
          if (hit) return { entity: hit, matched_by: 'iso_code' };
        }
      }
    } catch { /* the ISO lookup is a convenience; fall through to the Factbook's own codes */ }
    const byGec = BY_CODE.get(raw.toLowerCase());
    if (byGec && raw.length === 2) return { entity: byGec, matched_by: 'gec_code' };
  }

  // A unique prefix / substring match on the short name ("Bosnia", "Saint Lucia").
  const partial = ALL.filter((e) => norm(e.name).startsWith(q) || (q.length >= 4 && (norm(e.name).includes(q) || norm(e.long_name).includes(q))));
  if (partial.length === 1) return { entity: partial[0], matched_by: 'partial_name' };

  return { entity: null, close_matches: partial.length > 1 ? partial.slice(0, 8).map((e) => e.name) : closeMatches(raw) };
}

function notFound(country: string, close: string[]) {
  return {
    found: false,
    reason: 'unknown_country',
    query: country,
    close_matches: close,
    hint: close.length
      ? `No Factbook entity is named "${country}". Did you mean: ${close.join(', ')}? factbook_entities lists every entity.`
      : 'Pass a country or territory name (e.g. "Kenya"), an ISO code (e.g. "KE"), or "gec:<code>". factbook_entities lists every entity.',
    source: SOURCE,
    data_as_of: DATA_AS_OF,
  };
}

// ── Profile fetch + flattening ─────────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', ndash: '–', mdash: '—', deg: '°' };
const ACCENTS: Record<string, string> = { acute: '́', grave: '̀', circ: '̂', uml: '̈', tilde: '̃', cedil: '̧', ring: '̊' };

function cleanText(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&([a-zA-Z])(acute|grave|circ|uml|tilde|cedil|ring);/g, (_, c, k) => (c + ACCENTS[k]).normalize('NFC'))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/g, (m, k) => NAMED_ENTITIES[k] ?? m)
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** `{ "text": "x" }` leaves become `"x"`; every string loses its markup. */
function flatten(v: unknown): unknown {
  if (typeof v === 'string') return cleanText(v);
  if (Array.isArray(v)) return v.map(flatten);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1 && keys[0] === 'text') return flatten(o.text);
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = flatten(o[k]);
    return out;
  }
  return v;
}

type Profile = Record<string, Record<string, unknown>>;

async function loadProfile(e: Entity): Promise<Profile> {
  const res = await pwFetch(`${BASE}/${e.region}/${e.code}.json`);
  if (!res.ok) throw new Error(`CIA World Factbook archive returned HTTP ${res.status} for ${e.name} — try again shortly`);
  const body = (await res.json()) as Profile;
  if (!body || typeof body !== 'object' || Object.keys(body).length === 0) {
    throw new Error(`CIA World Factbook archive returned an empty profile for ${e.name}`);
  }
  return body;
}

function entityInfo(e: Entity) {
  return { name: e.name, long_name: e.long_name || undefined, gec_code: e.code, region: e.region };
}

function pickSections(profile: Profile, requested: unknown): { sections: Record<string, unknown>; missing: string[] } {
  const available = Object.keys(profile);
  let wanted: string[];
  if (requested === 'all' || (Array.isArray(requested) && requested.some((r) => String(r).toLowerCase() === 'all'))) {
    wanted = available;
  } else if (Array.isArray(requested) && requested.length) {
    wanted = requested.map(String);
  } else if (typeof requested === 'string' && requested.trim()) {
    wanted = requested.split(',').map((s) => s.trim()).filter(Boolean);
  } else {
    wanted = DEFAULT_SECTIONS;
  }
  const sections: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const w of wanted) {
    const nw = norm(w);
    const key = available.find((a) => norm(a) === nw) ?? available.find((a) => norm(a).startsWith(nw) || norm(a).includes(nw));
    if (key) sections[key] = flatten(profile[key]);
    else missing.push(w);
  }
  return { sections, missing };
}

/** Find a field by name across every section; exact (case-insensitive) beats substring. "Section > Field" pins the section. */
function findField(profile: Profile, field: string): { section: string; field: string; value: unknown } | null {
  let sectionFilter: string | null = null;
  let f = field;
  const pin = /^(.+?)\s*[>:]\s*(.+)$/.exec(field);
  if (pin && Object.keys(profile).some((s) => norm(s) === norm(pin[1]))) {
    sectionFilter = norm(pin[1]);
    f = pin[2];
  }
  const nf = norm(f);
  const sections = Object.keys(profile).filter((s) => !sectionFilter || norm(s) === sectionFilter);
  for (const pass of ['exact', 'prefix', 'substring'] as const) {
    for (const s of sections) {
      const sec = profile[s];
      if (!sec || typeof sec !== 'object') continue;
      for (const k of Object.keys(sec)) {
        const nk = norm(k);
        const ok = pass === 'exact' ? nk === nf : pass === 'prefix' ? nk.startsWith(nf) : nk.includes(nf);
        if (ok) return { section: s, field: k, value: flatten(sec[k]) };
      }
    }
  }
  return null;
}

// ── Tools ──────────────────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'factbook_country',
    description:
      'CIA World Factbook country profile (final 2026 edition): background history, geography, population and demographics, ethnic groups, languages, religions, government type, capital, constitution, legal system, executive and legislative branches, economy (GDP, growth, inflation, exports, imports, debt), energy, military, transnational issues. Use for "tell me about Kenya", "what type of government does Chile have", "Factbook profile of Vietnam". Accepts a country or territory name, an ISO code, or "gec:<code>". Returns the five core sections by default; pass sections to choose others or "all".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        country: { type: 'string', description: 'Country or territory name ("Kenya", "South Korea", "Greenland"), ISO 3166 code ("KE", "KOR"), or a Factbook code as "gec:ke".' },
        sections: {
          type: 'array',
          items: { type: 'string' },
          description: 'Sections to return. Default: Introduction, Geography, People and Society, Government, Economy. Others: Environment, Energy, Communications, Transportation, Military and Security, Space, Terrorism, Transnational Issues. ["all"] returns every section (~35 KB).',
        },
      },
      required: ['country'],
    },
  },
  {
    name: 'factbook_compare',
    description:
      'Compare CIA World Factbook fields side by side across up to 10 countries — population, median age, life expectancy, real GDP per capita, GDP growth, inflation, unemployment, public debt, military expenditures, area, internet users, etc. Use for "compare population and GDP per capita of Kenya, Nigeria and Ghana" or "life expectancy in Japan vs Germany". Field names match the Factbook headings (case-insensitive, partial match allowed; "Economy > Exports" pins a section). factbook_fields lists the exact names.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        countries: { type: 'array', items: { type: 'string' }, description: 'Two to ten country names or ISO codes, e.g. ["Kenya", "Nigeria", "Ghana"].' },
        fields: { type: 'array', items: { type: 'string' }, description: 'Factbook field names, e.g. ["Population", "Real GDP per capita", "Life expectancy at birth"]. Max 10.' },
      },
      required: ['countries', 'fields'],
    },
  },
  {
    name: 'factbook_fields',
    description:
      'List the sections and field names the CIA World Factbook carries for a country (e.g. Economy → "Real GDP per capita", "Inflation rate (consumer prices)", "Exports - partners"). Use before factbook_compare to find the exact field to ask for. Defaults to the United States profile, which carries the full field set.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        country: { type: 'string', description: 'Country name or ISO code. Default "United States".' },
      },
    },
  },
  {
    name: 'factbook_entities',
    description:
      'List or search the 261 entities in the CIA World Factbook — sovereign countries, dependencies and territories, the oceans, the European Union and the World — with their Factbook (GEC) codes and regions. Use to find how the Factbook names a place ("Burma", "Congo (Brazzaville)", "DRC") or to list every entity in a region such as africa or central-america-n-caribbean.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Name substring to search, e.g. "guinea" or "island". Omit to list all.' },
        region: {
          type: 'string',
          enum: ['africa', 'antarctica', 'australia-oceania', 'central-america-n-caribbean', 'central-asia', 'east-n-southeast-asia', 'europe', 'middle-east', 'north-america', 'oceans', 'south-america', 'south-asia', 'world'],
          description: 'Restrict to one Factbook region.',
        },
        limit: { type: 'number', description: 'Max rows (default 50, max 300).' },
      },
    },
  },
];

function envelope<T extends object>(body: T) {
  return { ...body, source: SOURCE, licence: LICENCE, data_as_of: DATA_AS_OF, edition_note: EDITION_NOTE };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'factbook_country': {
      const country = String(args.country ?? '');
      const r = await resolve(country);
      if (!r.entity) return notFound(country, r.close_matches);
      const profile = await loadProfile(r.entity);
      const { sections, missing } = pickSections(profile, args.sections);
      if (Object.keys(sections).length === 0) {
        return {
          found: false, reason: 'unknown_section', entity: entityInfo(r.entity), requested: args.sections,
          available_sections: Object.keys(profile), hint: 'Pass section names from available_sections, or ["all"].',
          source: SOURCE, data_as_of: DATA_AS_OF,
        };
      }
      return envelope({
        found: true,
        entity: entityInfo(r.entity),
        matched_by: r.matched_by,
        sections,
        ...(missing.length ? { sections_not_found: missing } : {}),
        other_sections: Object.keys(profile).filter((s) => !(s in sections)),
      });
    }

    case 'factbook_compare': {
      const countries = (Array.isArray(args.countries) ? args.countries : String(args.countries ?? '').split(',')).map((c) => String(c).trim()).filter(Boolean);
      const fields = (Array.isArray(args.fields) ? args.fields : String(args.fields ?? '').split(',')).map((f) => String(f).trim()).filter(Boolean);
      if (countries.length === 0) throw new Error('countries is required — e.g. ["Kenya", "Nigeria"]');
      if (fields.length === 0) throw new Error('fields is required — e.g. ["Population", "Real GDP per capita"]; factbook_fields lists them');
      if (countries.length > 10) throw new Error(`At most 10 countries per call (got ${countries.length})`);
      if (fields.length > 10) throw new Error(`At most 10 fields per call (got ${fields.length})`);

      const resolved = await Promise.all(countries.map((c) => resolve(c)));
      const unknown = countries
        .map((c, i) => ({ c, r: resolved[i] }))
        .filter((x) => !x.r.entity)
        .map((x) => ({ query: x.c, close_matches: (x.r as { close_matches: string[] }).close_matches }));
      const known = resolved.filter((r): r is { entity: Entity; matched_by: string } => !!r.entity);
      if (known.length === 0) {
        return { found: false, reason: 'unknown_country', unknown_countries: unknown, hint: 'None of the countries matched a Factbook entity; factbook_entities lists them.', source: SOURCE, data_as_of: DATA_AS_OF };
      }
      const profiles = await Promise.all(known.map((r) => loadProfile(r.entity)));
      const rows = known.map((r, i) => {
        const values: Record<string, unknown> = {};
        for (const f of fields) {
          const hit = findField(profiles[i], f);
          values[f] = hit ? { section: hit.section, field: hit.field, value: hit.value } : null;
        }
        return { country: r.entity.name, gec_code: r.entity.code, values };
      });
      const unmatchedFields = fields.filter((f) => rows.every((row) => row.values[f] === null));
      if (unmatchedFields.length === fields.length) {
        return {
          found: false, reason: 'unknown_field', fields, hint: 'No requested field exists in these profiles; factbook_fields lists the exact field names.',
          source: SOURCE, data_as_of: DATA_AS_OF,
        };
      }
      return envelope({
        found: true,
        countries: rows,
        ...(unmatchedFields.length ? { fields_not_found: unmatchedFields } : {}),
        ...(unknown.length ? { unknown_countries: unknown } : {}),
      });
    }

    case 'factbook_fields': {
      const country = String(args.country ?? '').trim() || 'United States';
      const r = await resolve(country);
      if (!r.entity) return notFound(country, r.close_matches);
      const profile = await loadProfile(r.entity);
      const sections: Record<string, string[]> = {};
      for (const [s, v] of Object.entries(profile)) sections[s] = v && typeof v === 'object' ? Object.keys(v) : [];
      return envelope({
        found: true,
        entity: entityInfo(r.entity),
        section_count: Object.keys(sections).length,
        field_count: Object.values(sections).reduce((n, f) => n + f.length, 0),
        sections,
      });
    }

    case 'factbook_entities': {
      const q = args.query ? norm(String(args.query)) : '';
      const region = args.region ? String(args.region).toLowerCase() : '';
      const regions = new Set(ALL.map((e) => e.region));
      if (region && !regions.has(region)) {
        throw new Error(`Unknown region "${args.region}". Valid: ${[...regions].sort().join(', ')}`);
      }
      const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 300);
      const hits = ALL.filter((e) => (!region || e.region === region) && (!q || norm(e.name).includes(q) || norm(e.long_name).includes(q) || e.code === q));
      if (hits.length === 0) {
        return {
          found: false, reason: 'no_match', query: args.query, region: region || undefined,
          close_matches: q ? closeMatches(String(args.query)) : [],
          hint: 'Try a shorter name fragment, or omit query to list every entity in the region.',
          source: SOURCE, data_as_of: DATA_AS_OF,
        };
      }
      return envelope({
        found: true,
        total: hits.length,
        returned: Math.min(hits.length, limit),
        truncated: hits.length > limit,
        ...(hits.length > limit ? { hint: 'Narrow with query or region, or raise limit (max 300).' } : {}),
        entities: hits.slice(0, limit).map(entityInfo),
      });
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
