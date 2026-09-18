import { execSync } from 'node:child_process';
import { parseScopeBlock, stripScopeBlocks } from '../src/domain/triage-scope';

export type ArchitecturalLocus =
  | 'adapter_bug'
  | 'query_normalizer_bug'
  | 'entity_alias_bug'
  | 'matcher_gate_bug'
  | 'sinkhole_debris'
  | 'other';

export interface RawIssue {
  number: number;
  title: string;
  body: string;
  labels: { name: string }[];
  createdAt: string;
  updatedAt: string;
  comments?: { body: string; createdAt: string }[];
}

export interface ClassifiedIssue {
  number: number;
  title: string;
  labels: string[];
  locus: ArchitecturalLocus;
  clusterKey: string;
  clusterTitle: string;
  sourceShop: string | null;
  beerIds: number[];
  isSaturated: boolean;
  targetFiles: string[];
}

export interface IssueCluster {
  key: string;
  title: string;
  locus: ArchitecturalLocus;
  issues: ClassifiedIssue[];
  uniqueBeerIds: number[];
  targetFiles: string[];
  systemicLeverage: number; // 1 (low) - 5 (high)
  blastRadius: number;      // 1 (narrow/safe) - 5 (broad/risky)
  complexity: number;       // 1 (simple) - 5 (complex)
  impactScore: number;      // calculated
  recommendedAction: string;
}

// Regex to discover beer IDs from markdown table rows or mentions (e.g. "| 34250 |", "| **37334** |", "`#34250`", "рядок 31170", "row 31180")
const TABLE_BEER_ID_RE = /\|\s*(?:\*{1,2})?(\d{2,6})(?:\*{1,2})?\s*\|/g;
const CODE_BEER_ID_RE = /`#?(\d{2,6})`/g;
const ROW_BEER_ID_RE = /(?:row|рядок|beer_id|catalog beer)\s*[:#]?\s*(?:\*{1,2}|`?)(\d{2,6})(?:\*{1,2}|`?)/gi;

export function extractBeerIds(text: string): number[] {
  const ids = new Set<number>();
  let match: RegExpExecArray | null;

  TABLE_BEER_ID_RE.lastIndex = 0;
  while ((match = TABLE_BEER_ID_RE.exec(text)) !== null) {
    const id = parseInt(match[1], 10);
    if (!isNaN(id) && id > 0) ids.add(id);
  }

  CODE_BEER_ID_RE.lastIndex = 0;
  while ((match = CODE_BEER_ID_RE.exec(text)) !== null) {
    const id = parseInt(match[1], 10);
    if (!isNaN(id) && id > 0) ids.add(id);
  }

  ROW_BEER_ID_RE.lastIndex = 0;
  while ((match = ROW_BEER_ID_RE.exec(text)) !== null) {
    const id = parseInt(match[1], 10);
    if (!isNaN(id) && id > 0) ids.add(id);
  }

  return Array.from(ids);
}

export function getExcludedShops(scopeWhere?: { col: string; op: string; value?: unknown }[]): Set<string> {
  const excluded = new Set<string>();
  if (!scopeWhere) return excluded;
  for (const term of scopeWhere) {
    if (term && typeof term === 'object' && typeof term.value === 'string') {
      const opNormalized = term.op?.toLowerCase().trim().replace(/[- ]/g, '_') ?? '';
      // Null and empty checks assert presence rather than value exclusion
      const isPresenceCheck = opNormalized.includes('null') || opNormalized.includes('empty');
      const isNegative =
        !isPresenceCheck &&
        (opNormalized === '!=' ||
          opNormalized === '<>' ||
          opNormalized.startsWith('!') ||
          opNormalized.startsWith('not_') ||
          opNormalized.startsWith('non_') ||
          opNormalized.includes('_not_') ||
          opNormalized.includes('_non_') ||
          opNormalized.endsWith('_not') ||
          opNormalized.endsWith('_non'));
      if (term.col === 'source_url' && isNegative) {
        const val = term.value.toLowerCase();
        for (const s of [
          'flasker',
          'winetime',
          'beershop',
          'beerfreak',
          'onemorebeer',
          'bierloods22',
          'hoptimaal',
          'funkyshop',
        ]) {
          if (val.includes(s)) excluded.add(s);
        }
      }
    }
  }
  return excluded;
}

export function detectShop(text: string, scopeWhere?: { col: string; op: string; value?: unknown }[]): string | null {
  if (scopeWhere) {
    for (const term of scopeWhere) {
      if (term && typeof term === 'object' && typeof term.value === 'string') {
        const opLower = term.op?.toLowerCase() ?? '';
        const isPositiveMatch =
          opLower === 'contains' || opLower === '=' || opLower === 'eq' || opLower === 'like';
        if (term.col === 'source_url' && isPositiveMatch) {
          const val = term.value.toLowerCase();
          if (val.includes('flasker')) return 'flasker';
          if (val.includes('winetime')) return 'winetime';
          if (val.includes('beershop')) return 'beershop';
          if (val.includes('beerfreak')) return 'beerfreak';
          if (val.includes('onemorebeer')) return 'onemorebeer';
          if (val.includes('bierloods22')) return 'bierloods22';
          if (val.includes('hoptimaal')) return 'hoptimaal';
          if (val.includes('funkyshop')) return 'funkyshop';
        }
      }
    }
  }

  const lower = text.toLowerCase();
  if (lower.includes('flasker')) return 'flasker';
  if (lower.includes('winetime')) return 'winetime';
  if (lower.includes('beershop')) return 'beershop';
  if (lower.includes('beerfreak')) return 'beerfreak';
  if (lower.includes('onemorebeer') || lower.includes('one more beer')) return 'onemorebeer';
  // internal-cron only if explicitly in title or as a defect target, not prompt boilerplate
  if (/\[parser-bug\].*internal-cron/i.test(text) || /internal-cron rows/i.test(text)) return 'internal-cron';
  return null;
}

export function parseScopeBlockLenient(body: string): {
  beer_ids?: number[];
  where?: { col: string; op: string; value?: unknown }[];
} | null {
  const strict = parseScopeBlock(body);
  if (strict) return strict;
  const m = /```triage-scope\s*\n([\s\S]*?)\n?```/.exec(body);
  if (!m) return null;
  try {
    const raw = JSON.parse(m[1]);
    if (raw && typeof raw === 'object') {
      const beerIds = Array.isArray(raw.beer_ids)
        ? (raw.beer_ids
            .map((id: unknown) => {
              if (typeof id === 'number' && Number.isInteger(id)) return id;
              if (typeof id === 'string' && /^\d+$/.test(id.trim())) return parseInt(id.trim(), 10);
              return null;
            })
            .filter((id: number | null): id is number => id !== null && id > 0))
        : undefined;

      const whereTerms = Array.isArray(raw.where)
        ? raw.where.filter(
            (t: unknown): t is { col: string; op: string; value?: unknown } =>
              Boolean(
                t &&
                  typeof t === 'object' &&
                  typeof (t as any).col === 'string' &&
                  typeof (t as any).op === 'string',
              ),
          )
        : undefined;

      return {
        beer_ids: beerIds,
        where: whereTerms,
      };
    }
  } catch {
    // ignore
  }
  return null;
}

export function classifyIssue(issue: RawIssue): ClassifiedIssue {
  const labels = issue.labels.map((l) => l.name);
  const isSaturated = labels.includes('saturated');
  const scope = parseScopeBlockLenient(issue.body);

  const combinedText = [
    issue.title,
    issue.body,
    ...(issue.comments ?? []).map((c) => c.body),
  ].join('\n');

  // Beer IDs from scope + tables in body/comments
  const idSet = new Set<number>(scope?.beer_ids ?? []);
  for (const id of extractBeerIds(combinedText)) {
    idSet.add(id);
  }

  const excludedShops = getExcludedShops(scope?.where as any);
  const shopFromScope = detectShop('', scope?.where as any);
  const shopFromTitle = detectShop(issue.title);
  const cleanBody = stripScopeBlocks(issue.body);
  const shopFromBody = detectShop(cleanBody);

  let shop: string | null = null;
  if (shopFromScope && !excludedShops.has(shopFromScope)) {
    shop = shopFromScope;
  } else if (shopFromTitle && !excludedShops.has(shopFromTitle)) {
    shop = shopFromTitle;
  } else if (shopFromBody && !excludedShops.has(shopFromBody)) {
    shop = shopFromBody;
  }

  const titleLower = issue.title.toLowerCase();
  const isParserBug =
    labels.some((l) =>
      [
        'parser-bug',
        'parser_bug',
        'adapter-bug',
        'adapter_bug',
        'extension-bug',
        'extension_bug',
      ].includes(l)
    ) ||
    titleLower.includes('parser-bug') ||
    titleLower.includes('parser_bug') ||
    titleLower.includes('adapter');
  const hasShopInTitle = Boolean(
    (shopFromTitle && !excludedShops.has(shopFromTitle)) || titleLower.includes('internal-cron')
  );

  let locus: ArchitecturalLocus = 'other';
  let clusterKey = 'misc';
  let clusterTitle = 'Miscellaneous';
  let targetFiles: string[] = [];

  // Sinkholes / Dumping grounds: Broad catch-all issues
  if (issue.number === 334 || issue.number === 405 || issue.number === 406) {
    locus = 'sinkhole_debris';
    clusterKey = 'sinkhole-debris';
    clusterTitle = 'Unresolved Sinkholes (Overbroad Scopes needing Decomposition)';
    targetFiles = ['enrich_failures (production DB remap)'];
  }
  // Collabs and multi-brewery
  else if (
    titleLower.includes('collab') ||
    titleLower.includes('multi-brewery') ||
    titleLower.includes('partner brewer') ||
    /collab.*partner/i.test(issue.title)
  ) {
    locus = 'query_normalizer_bug';
    clusterKey = 'collab-multi-brewery';
    clusterTitle = 'Collab & Multi-Brewery Splitting in Queries and Matcher';
    targetFiles = [
      'src/domain/normalize.ts',
      'src/domain/matcher.ts',
      'src/domain/untappd-lookup.ts',
    ];
  }
  // Shop Adapters (title-specified shop or explicit parser/adapter bug)
  else if (
    (hasShopInTitle || isParserBug) &&
    shop === 'flasker'
  ) {
    locus = 'adapter_bug';
    clusterKey = 'flasker-adapter';
    clusterTitle = 'Flasker Shop Adapter & Scraper Extraction';
    targetFiles = [
      'extension/src/sites/flasker.ts',
      'extension/scripts/gen-flasker-breweries.ts',
      'extension/src/sites/flasker-breweries.generated.ts',
    ];
  } else if (
    (hasShopInTitle || isParserBug) &&
    shop === 'winetime'
  ) {
    locus = 'adapter_bug';
    clusterKey = 'winetime-adapter';
    clusterTitle = 'WineTime Shop Adapter';
    targetFiles = ['extension/src/sites/winetime.ts'];
  } else if (
    (hasShopInTitle || isParserBug) &&
    shop === 'beershop'
  ) {
    locus = 'adapter_bug';
    clusterKey = 'beershop-adapter';
    clusterTitle = 'BeerShop.eu Series & Title Banner Splitting';
    targetFiles = ['extension/src/sites/beershop.ts'];
  } else if (
    (hasShopInTitle || isParserBug) &&
    shop === 'beerfreak'
  ) {
    locus = 'adapter_bug';
    clusterKey = 'beerfreak-adapter';
    clusterTitle = 'BeerFreak Shop Adapter';
    targetFiles = ['extension/src/sites/beerfreak.ts'];
  } else if (
    (hasShopInTitle || isParserBug) &&
    shop === 'onemorebeer'
  ) {
    locus = 'adapter_bug';
    clusterKey = 'onemorebeer-adapter';
    clusterTitle = 'OneMoreBeer Shop Adapter';
    targetFiles = ['extension/src/sites/onemorebeer.ts'];
  } else if (
    (hasShopInTitle || isParserBug) &&
    (shop === 'internal-cron' || titleLower.includes('internal-cron'))
  ) {
    locus = 'adapter_bug';
    clusterKey = 'internal-cron-parser';
    clusterTitle = 'Internal-cron Scraper Tap Placeholders';
    targetFiles = ['src/jobs/enrich.ts'];
  }
  // Parent/Portfolio brands
  else if (
    titleLower.includes('parent') ||
    titleLower.includes('portfolio-owner') ||
    titleLower.includes('producer/parent') ||
    titleLower.includes('brand as brewery') ||
    titleLower.includes('cider producers: brand line') ||
    titleLower.includes('blue moon') ||
    titleLower.includes('kauno alus')
  ) {
    locus = 'entity_alias_bug';
    clusterKey = 'parent-portfolio-brand';
    clusterTitle = 'Parent/Portfolio & Conglomerate Brand Resolution';
    targetFiles = [
      'src/domain/brewery-alias.ts',
      'src/domain/matcher.ts',
    ];
  }
  // Query-Zeroing Descriptors & Noise Tokens
  else if (
    titleLower.includes('descriptor') ||
    titleLower.includes('packaging/format') ||
    titleLower.includes('can, pack') ||
    titleLower.includes('style tail') ||
    titleLower.includes('trailing style') ||
    titleLower.includes('niepasteryzowane') ||
    titleLower.includes('over-constrain') ||
    titleLower.includes('edition/descriptor') ||
    titleLower.includes('градус') ||
    titleLower.includes('десітк') ||
    titleLower.includes('dvanáctka') ||
    titleLower.includes('desítka') ||
    titleLower.includes('vintage') ||
    titleLower.includes('year-aware')
  ) {
    locus = 'query_normalizer_bug';
    clusterKey = 'query-zeroing-descriptors';
    clusterTitle = 'Query-Zeroing Descriptors, Vintage & Plato Grade';
    targetFiles = [
      'src/domain/normalize.ts',
      'src/domain/untappd-lookup.ts',
      'src/domain/czech-grade.ts',
      'src/domain/matcher.ts',
    ];
  }
  // Typo & Fuzzy Rescue
  else if (
    titleLower.includes('typo') ||
    titleLower.includes('edit-distance') ||
    titleLower.includes('fused brewery token') ||
    titleLower.includes('ідентичність цифр') ||
    titleLower.includes('нумерує серію') ||
    titleLower.includes('digit identity') ||
    titleLower.includes('правило #636')
  ) {
    locus = 'matcher_gate_bug';
    clusterKey = 'typo-fuzzy-rescue';
    clusterTitle = 'Bounded Typo, Fused Token & Numeric Identity Rescue';
    targetFiles = [
      'src/domain/matcher.ts',
      'src/domain/untappd-lookup.ts',
      'src/domain/name-identity.ts',
    ];
  }
  // Empty & Style-Only Name Identity Collapse
  else if (
    titleLower.includes('normalizes to empty') ||
    titleLower.includes('нормалізується в порожнечу') ||
    titleLower.includes('лише зі стилю') ||
    titleLower.includes('bare brewery alias when the beer name normalizes') ||
    (titleLower.includes('назва крана') && titleLower.includes('стилю'))
  ) {
    locus = 'matcher_gate_bug';
    clusterKey = 'empty-style-name-collapse';
    clusterTitle = 'Empty & Style-Only Name Identity Collapse';
    targetFiles = [
      'src/domain/matcher.ts',
      'src/domain/untappd-lookup.ts',
      'src/domain/name-identity.ts',
    ];
  }
  // Search Depth & Pool Saturation
  else if (
    titleLower.includes('hitsperpage') ||
    titleLower.includes('sibling pool') ||
    titleLower.includes('truncates the exact match') ||
    titleLower.includes('pool saturation')
  ) {
    locus = 'query_normalizer_bug';
    clusterKey = 'search-depth-truncation';
    clusterTitle = 'Algolia Search Depth & Sibling Pool Saturation';
    targetFiles = [
      'src/domain/untappd-lookup.ts',
    ];
  }
  // Language & Transliteration
  else if (
    titleLower.includes('transliteration') ||
    titleLower.includes('translation') ||
    titleLower.includes('cyrillic')
  ) {
    locus = 'entity_alias_bug';
    clusterKey = 'transliteration-language';
    clusterTitle = 'Cyrillic Transliteration & Language Translation Maps';
    targetFiles = [
      'src/domain/normalize.ts',
      'src/domain/matcher.ts',
    ];
  }
  // Fallback Shop Adapters (shop detected in body/scope, no specific matcher category claimed it)
  else if (shop === 'flasker') {
    locus = 'adapter_bug';
    clusterKey = 'flasker-adapter';
    clusterTitle = 'Flasker Shop Adapter & Scraper Extraction';
    targetFiles = [
      'extension/src/sites/flasker.ts',
      'extension/scripts/gen-flasker-breweries.ts',
      'extension/src/sites/flasker-breweries.generated.ts',
    ];
  } else if (shop === 'winetime') {
    locus = 'adapter_bug';
    clusterKey = 'winetime-adapter';
    clusterTitle = 'WineTime Shop Adapter';
    targetFiles = ['extension/src/sites/winetime.ts'];
  } else if (shop === 'beershop') {
    locus = 'adapter_bug';
    clusterKey = 'beershop-adapter';
    clusterTitle = 'BeerShop.eu Series & Title Banner Splitting';
    targetFiles = ['extension/src/sites/beershop.ts'];
  } else if (shop === 'beerfreak') {
    locus = 'adapter_bug';
    clusterKey = 'beerfreak-adapter';
    clusterTitle = 'BeerFreak Shop Adapter';
    targetFiles = ['extension/src/sites/beerfreak.ts'];
  } else if (shop === 'onemorebeer') {
    locus = 'adapter_bug';
    clusterKey = 'onemorebeer-adapter';
    clusterTitle = 'OneMoreBeer Shop Adapter';
    targetFiles = ['extension/src/sites/onemorebeer.ts'];
  } else if (shop === 'internal-cron' || titleLower.includes('internal-cron')) {
    locus = 'adapter_bug';
    clusterKey = 'internal-cron-parser';
    clusterTitle = 'Internal-cron Scraper Tap Placeholders';
    targetFiles = ['src/jobs/enrich.ts'];
  }

  return {
    number: issue.number,
    title: issue.title,
    labels,
    locus,
    clusterKey,
    clusterTitle,
    sourceShop: shop,
    beerIds: Array.from(idSet),
    isSaturated,
    targetFiles,
  };
}

export function groupIntoClusters(classifiedIssues: ClassifiedIssue[]): IssueCluster[] {
  const clusterMap = new Map<string, IssueCluster>();

  for (const iss of classifiedIssues) {
    let cluster = clusterMap.get(iss.clusterKey);
    if (!cluster) {
      cluster = {
        key: iss.clusterKey,
        title: iss.clusterTitle,
        locus: iss.locus,
        issues: [],
        uniqueBeerIds: [],
        targetFiles: Array.from(new Set(iss.targetFiles)),
        systemicLeverage: 3,
        blastRadius: 2,
        complexity: 2,
        impactScore: 0,
        recommendedAction: '',
      };
      clusterMap.set(iss.clusterKey, cluster);
    }
    cluster.issues.push(iss);
    for (const f of iss.targetFiles) {
      if (!cluster.targetFiles.includes(f)) cluster.targetFiles.push(f);
    }
  }

  const clusters = Array.from(clusterMap.values());

  for (const c of clusters) {
    const allBeerIds = new Set<number>();
    for (const iss of c.issues) {
      for (const id of iss.beerIds) allBeerIds.add(id);
    }
    c.uniqueBeerIds = Array.from(allBeerIds);

    // Fine-tune leverage and blast radius by locus
    switch (c.locus) {
      case 'adapter_bug':
        c.systemicLeverage = 5; // fixes root cause of many issues in one shop
        c.blastRadius = 1;      // zero impact on other shops or global matching
        c.complexity = 2;
        c.recommendedAction = 'Fix shop DOM adapter and catalog extractor in extension/src/sites/';
        break;
      case 'query_normalizer_bug':
        c.systemicLeverage = 4;
        c.blastRadius = 2;      // affects query construction, needs guard
        c.complexity = 2;
        c.recommendedAction = 'Add clean rule in normalize.ts or additional ladder rung in untappd-lookup.ts';
        break;
      case 'entity_alias_bug':
        c.systemicLeverage = 3;
        c.blastRadius = 2;      // alias matching is safely constrained
        c.complexity = 2;
        c.recommendedAction = 'Add parent-brand hierarchical mapping or curated alias pairs';
        break;
      case 'matcher_gate_bug':
        c.systemicLeverage = 3;
        c.blastRadius = 3;      // higher risk of false-positive collision
        c.complexity = 3;
        c.recommendedAction = 'Bounded rescue with strict ABV corroboration';
        break;
      case 'sinkhole_debris':
        c.systemicLeverage = 2;
        c.blastRadius = 1;
        c.complexity = 4;       // tedious decomposition and row remapping
        c.recommendedAction = 'Decompose catch-all issues, remap confirmed rows, and close or narrow scope';
        break;
      default:
        c.systemicLeverage = 2;
        c.blastRadius = 2;
        c.complexity = 2;
        c.recommendedAction = 'Review and adjudicate individual rows';
        break;
    }

    if (c.key === 'empty-style-name-collapse') {
      c.systemicLeverage = 5;
      c.blastRadius = 2;
      c.complexity = 3;
      c.recommendedAction = 'Guard against empty normalized names and bare brewery aliases in identity sets';
    } else if (c.key === 'search-depth-truncation') {
      c.systemicLeverage = 4;
      c.blastRadius = 1;
      c.complexity = 2;
      c.recommendedAction = 'Re-query on saturated Algolia candidate pools (nbHits > hitsPerPage)';
    }

    // Impact formula: (uniqueBeerCount * leverage * 10) / (blastRadius * complexity)
    // Minimum count of 1 so zero-beer issues still register
    const effectiveBeerCount = Math.max(c.uniqueBeerIds.length, c.issues.length * 2);
    c.impactScore = Math.round((effectiveBeerCount * c.systemicLeverage * 10) / (c.blastRadius * c.complexity));
  }

  // Sort descending by impact score
  clusters.sort((a, b) => b.impactScore - a.impactScore);
  return clusters;
}

export function fetchOpenOrphanIssues(): RawIssue[] {
  const stdout = execSync(
    'gh issue list --state open --label orphan-triage --limit 500 --json number,title,body,labels,createdAt,updatedAt,comments',
    { encoding: 'utf-8', maxBuffer: 20 * 1024 * 1024 }
  );
  return JSON.parse(stdout) as RawIssue[];
}

export function formatClusterReportMarkdown(clusters: IssueCluster[]): string {
  const lines: string[] = [];
  lines.push('# Orphan-Triage Issue Clusters & Impact Analysis');
  lines.push(`_Generated: ${new Date().toISOString()}_`);
  lines.push('');
  lines.push('| Rank | Cluster | Locus | Issues | Unique Beers | Leverage | Blast Radius | Impact Score |');
  lines.push('|:---:|---|---|:---:|:---:|:---:|:---:|:---:|');

  clusters.forEach((c, idx) => {
    lines.push(
      `| **${idx + 1}** | **${c.title}** | \`${c.locus}\` | ${c.issues.length} | ${c.uniqueBeerIds.length} | ${c.systemicLeverage}/5 | ${c.blastRadius}/5 | **${c.impactScore}** |`
    );
  });

  lines.push('');
  lines.push('---');
  lines.push('');

  clusters.forEach((c, idx) => {
    lines.push(`### ${idx + 1}. ${c.title} (Score: ${c.impactScore})`);
    lines.push(`- **Architectural Locus:** \`${c.locus}\``);
    lines.push(`- **Target Implementation Files:** ${c.targetFiles.map((f) => `\`${f}\``).join(', ')}`);
    lines.push(`- **Recommended Action:** ${c.recommendedAction}`);
    lines.push(`- **Unique Beer IDs (${c.uniqueBeerIds.length}):** ${c.uniqueBeerIds.slice(0, 15).join(', ')}${c.uniqueBeerIds.length > 15 ? '...' : ''}`);
    lines.push('- **Included Issues:**');
    for (const iss of c.issues) {
      const sat = iss.isSaturated ? ' `[saturated]`' : '';
      lines.push(`  - [#${iss.number}](https://github.com/ysilvestrov/warsaw-beer-bot/issues/${iss.number}) ${iss.title}${sat} (${iss.beerIds.length} beers)`);
    }
    lines.push('');
  });

  return lines.join('\n');
}

// CLI runner when executed directly
if (process.argv[1] && /cluster-triage-issues(?:\.[cm]?[jt]s)?$/i.test(process.argv[1])) {
  try {
    const issues = fetchOpenOrphanIssues();
    const classified = issues.map(classifyIssue);
    const clusters = groupIntoClusters(classified);

    const asMarkdown = process.argv.includes('--markdown');
    const asJson = process.argv.includes('--json');

    if (asJson) {
      console.log(JSON.stringify(clusters, null, 2));
    } else if (asMarkdown) {
      console.log(formatClusterReportMarkdown(clusters));
    } else {
      console.log(`\nFound ${issues.length} open orphan-triage issues across ${clusters.length} architectural clusters:\n`);
      for (let i = 0; i < clusters.length; i++) {
        const c = clusters[i];
        console.log(
          `#${i + 1} [Score: ${c.impactScore}] ${c.title} (${c.issues.length} issues, ${c.uniqueBeerIds.length} beers, locus: ${c.locus})`
        );
        for (const iss of c.issues) {
          console.log(`    - #${iss.number}: ${iss.title.slice(0, 75)}`);
        }
      }
    }
  } catch (err) {
    console.error('Failed to cluster triage issues:', err);
    process.exit(1);
  }
}
