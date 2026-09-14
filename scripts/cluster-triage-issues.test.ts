import { describe, expect, it } from 'vitest';
import {
  extractBeerIds,
  detectShop,
  classifyIssue,
  groupIntoClusters,
  type RawIssue,
} from './cluster-triage-issues';

describe('cluster-triage-issues', () => {
  it('extracts beer IDs from markdown table rows and backticks', () => {
    const text = `
| beer_id | brewery | name |
|---|---|---|
| 34250 | EvilTwin | Doughnut Break |
| 34251 | Stone | Arrogant Bastard |
Also see beer \`#34252\` and \`34253\`.
    `;
    const ids = extractBeerIds(text);
    expect(ids).toEqual(expect.arrayContaining([34250, 34251, 34252, 34253]));
  });

  it('detects source shop from scope or text', () => {
    expect(detectShop('some text', [{ col: 'source_url', op: 'contains', value: 'flasker.ua' }])).toBe('flasker');
    expect(detectShop('flasker rows with concatenated style')).toBe('flasker');
    expect(detectShop('winetime.com.ua adapter: bare brand')).toBe('winetime');
    expect(detectShop('beershop.eu Pinta rows')).toBe('beershop');
    expect(detectShop('random text with no shop')).toBeNull();
  });

  it('classifies issues into proper architectural loci', () => {
    const flaskerIssue: RawIssue = {
      number: 579,
      title: "[matcher-bug] flasker rows: brewery token concatenated with style/qualifier (EvilTwinImperial)",
      body: 'Scope: beer_ids 34250\n```triage-scope\n{"beer_ids":[34250],"where":[{"col":"source_url","op":"contains","value":"flasker"}]}\n```',
      labels: [{ name: 'orphan-triage' }, { name: 'matcher-bug' }],
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
    };

    const classified = classifyIssue(flaskerIssue);
    expect(classified.locus).toBe('adapter_bug');
    expect(classified.clusterKey).toBe('flasker-adapter');
    expect(classified.beerIds).toContain(34250);
    expect(classified.targetFiles).toContain('extension/src/sites/flasker.ts');
  });

  it('does not misclassify issues into shop adapters when a shop is only mentioned in comments', () => {
    const typoIssueWithCommentMentioningShop: RawIssue = {
      number: 476,
      title: '[matcher-bug] Bounded brewery-typo rescue (#472) misses when the registered brewery carries extra tokens',
      body: 'Scope: beer_ids 12345\n```triage-scope\n{"beer_ids":[12345],"where":[{"col":"candidates_count","op":">","value":0}]}\n```',
      labels: [{ name: 'orphan-triage' }, { name: 'matcher-bug' }],
      createdAt: '2026-08-20T00:00:00Z',
      updatedAt: '2026-08-20T00:00:00Z',
      comments: [
        {
          body: 'We noticed a similar pattern on flasker or onemorebeer with some beers.',
          createdAt: '2026-08-21T00:00:00Z',
        },
      ],
    };

    const classified = classifyIssue(typoIssueWithCommentMentioningShop);
    expect(classified.locus).toBe('matcher_gate_bug');
    expect(classified.clusterKey).toBe('typo-fuzzy-rescue');
    expect(classified.sourceShop).toBeNull();
  });

  it('clusters into shop adapter when shop is identified in body and issue is not a specific matcher bug', () => {
    const issueWithShopInBody: RawIssue = {
      number: 999,
      title: '[matcher-bug] rows: brewery token concatenated with style (EvilTwinImperial)',
      body: 'Flasker rows show EvilTwinImperial concatenated with beer style.\n```triage-scope\n{"beer_ids":[34250],"where":[]}\n```',
      labels: [{ name: 'orphan-triage' }, { name: 'matcher-bug' }],
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
    };

    const classified = classifyIssue(issueWithShopInBody);
    expect(classified.locus).toBe('adapter_bug');
    expect(classified.clusterKey).toBe('flasker-adapter');
    expect(classified.sourceShop).toBe('flasker');
  });

  it('prioritizes specific matcher categories over shop adapter when issue is not a parser bug', () => {
    const parentBrandIssue: RawIssue = {
      number: 545,
      title: '[matcher-bug] Beer registered on Untappd under a producer/parent brewer different from the shop brand token',
      body: 'Beershop.pl rows label a beer with the consumer brand...\n```triage-scope\n{"beer_ids":[35147],"where":[]}\n```',
      labels: [{ name: 'orphan-triage' }, { name: 'matcher-bug' }],
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
    };

    const classified = classifyIssue(parentBrandIssue);
    expect(classified.locus).toBe('entity_alias_bug');
    expect(classified.clusterKey).toBe('parent-portfolio-brand');
    expect(classified.sourceShop).toBe('beershop');
  });

  it('prefers structured scope.where source_url shop over incidental title shop mention', () => {
    const issueWithConflictingTitle: RawIssue = {
      number: 998,
      title: '[parser-bug] comparison with flasker catalogue grid layout',
      body: '```triage-scope\n{"beer_ids":[35147],"where":[{"col":"source_url","op":"contains","value":"beershop"}]}\n```',
      labels: [{ name: 'orphan-triage' }, { name: 'parser-bug' }],
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
    };

    const classified = classifyIssue(issueWithConflictingTitle);
    expect(classified.locus).toBe('adapter_bug');
    expect(classified.clusterKey).toBe('beershop-adapter');
    expect(classified.sourceShop).toBe('beershop');
  });

  it('recognizes adapter-bug label to prioritize adapter classification over matcher categories', () => {
    const adapterLabeledIssue: RawIssue = {
      number: 997,
      title: '[matcher-bug] parent brand token split incorrectly',
      body: 'Beershop rows have brand in brewery.\n```triage-scope\n{"beer_ids":[35147],"where":[]}\n```',
      labels: [{ name: 'orphan-triage' }, { name: 'adapter-bug' }],
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
    };

    const classified = classifyIssue(adapterLabeledIssue);
    expect(classified.locus).toBe('adapter_bug');
    expect(classified.clusterKey).toBe('beershop-adapter');
    expect(classified.sourceShop).toBe('beershop');
  });

  it('does not preempt matcher categories with shop from scope when issue is a matcher bug', () => {
    const matcherIssue: RawIssue = {
      number: 996,
      title: '[matcher-bug] Beer registered under a producer/parent brewer different from shop brand token',
      body: '```triage-scope\n{"beer_ids":[],"where":[{"col":"source_url","op":"contains","value":"beershop"}]}\n```',
      labels: [{ name: 'orphan-triage' }, { name: 'matcher-bug' }],
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
    };

    const classified = classifyIssue(matcherIssue);
    expect(classified.locus).toBe('entity_alias_bug');
    expect(classified.clusterKey).toBe('parent-portfolio-brand');
    expect(classified.sourceShop).toBe('beershop');
  });

  it('ignores negative operators in scope.where when detecting shop', () => {
    const issueWithNegativeScope: RawIssue = {
      number: 995,
      title: '[parser-bug] beershop banner parsing failure',
      body: '```triage-scope\n{"beer_ids":[],"where":[{"col":"source_url","op":"not_contains","value":"flasker"}]}\n```',
      labels: [{ name: 'orphan-triage' }, { name: 'parser-bug' }],
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
    };

    const classified = classifyIssue(issueWithNegativeScope);
    expect(classified.locus).toBe('adapter_bug');
    expect(classified.clusterKey).toBe('beershop-adapter');
    expect(classified.sourceShop).toBe('beershop');
  });

  it('recognizes underscored parser_bug and extension_bug labels', () => {
    const parserBugIssue: RawIssue = {
      number: 994,
      title: '[matcher-bug] parent brand token split incorrectly',
      body: 'Beershop rows have brand in brewery.\n```triage-scope\n{"beer_ids":[35147],"where":[]}\n```',
      labels: [{ name: 'orphan-triage' }, { name: 'parser_bug' }],
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
    };

    const classified = classifyIssue(parserBugIssue);
    expect(classified.locus).toBe('adapter_bug');
    expect(classified.clusterKey).toBe('beershop-adapter');
    expect(classified.sourceShop).toBe('beershop');
  });

  it('does not match shop mentioned only inside triage-scope block with negative operator', () => {
    const issueWithOnlyNegativeScope: RawIssue = {
      number: 993,
      title: '[parser-bug] banner parsing failure',
      body: '```triage-scope\n{"beer_ids":[],"where":[{"col":"source_url","op":"not_contains","value":"flasker"}]}\n```',
      labels: [{ name: 'orphan-triage' }, { name: 'parser-bug' }],
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
    };

    const classified = classifyIssue(issueWithOnlyNegativeScope);
    expect(classified.sourceShop).toBeNull();
    expect(classified.clusterKey).toBe('misc');
  });

  it('handles case-insensitive operators in scope.where like LIKE or CONTAINS', () => {
    const issueWithUppercaseOp: RawIssue = {
      number: 992,
      title: '[parser-bug] comparison with flasker catalogue grid layout',
      body: '```triage-scope\n{"beer_ids":[],"where":[{"col":"source_url","op":"LIKE","value":"beershop"}]}\n```',
      labels: [{ name: 'orphan-triage' }, { name: 'parser-bug' }],
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
    };

    const classified = classifyIssue(issueWithUppercaseOp);
    expect(classified.locus).toBe('adapter_bug');
    expect(classified.clusterKey).toBe('beershop-adapter');
    expect(classified.sourceShop).toBe('beershop');
  });

  it('blocks shop when scope.where explicitly excludes it even if mentioned in body prose', () => {
    const issueWithNegativeScopeAndBodyProse: RawIssue = {
      number: 991,
      title: '[parser-bug] banner parsing failure',
      body: 'We checked flasker but this is not flasker.\n```triage-scope\n{"beer_ids":[],"where":[{"col":"source_url","op":"!=","value":"flasker"}]}\n```',
      labels: [{ name: 'orphan-triage' }, { name: 'parser-bug' }],
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
    };

    const classified = classifyIssue(issueWithNegativeScopeAndBodyProse);
    expect(classified.sourceShop).toBeNull();
    expect(classified.clusterKey).toBe('misc');
  });

  it('handles malformed where array containing null without throwing', () => {
    const issueWithNullWhere: RawIssue = {
      number: 990,
      title: '[parser-bug] banner parsing failure',
      body: '```triage-scope\n{"beer_ids":[],"where":[null]}\n```',
      labels: [{ name: 'orphan-triage' }, { name: 'parser-bug' }],
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
    };

    expect(() => classifyIssue(issueWithNullWhere)).not.toThrow();
    const classified = classifyIssue(issueWithNullWhere);
    expect(classified.sourceShop).toBeNull();
    expect(classified.clusterKey).toBe('misc');
  });

  it('sanitizes string beer_ids in lenient scope to numbers and rejects partial/float tokens', () => {
    const issueWithStringBeerIds: RawIssue = {
      number: 989,
      title: '[parser-bug] banner parsing failure',
      body: '```triage-scope\n{"beer_ids":["34250", 34251, "invalid", "34250abc", "34251.9"], "where":[]}\n```',
      labels: [{ name: 'orphan-triage' }, { name: 'parser-bug' }],
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
    };

    const classified = classifyIssue(issueWithStringBeerIds);
    expect(classified.beerIds).toEqual([34250, 34251]);
    for (const id of classified.beerIds) {
      expect(typeof id).toBe('number');
      expect(Number.isInteger(id)).toBe(true);
    }
  });

  it('does not treat non-negative operators containing not substring like annotation as exclusions', () => {
    const issueWithAnnotationOp: RawIssue = {
      number: 988,
      title: '[parser-bug] flasker adapter needs update',
      body: '```triage-scope\n{"beer_ids":[],"where":[{"col":"source_url","op":"annotation","value":"flasker"}]}\n```',
      labels: [{ name: 'orphan-triage' }, { name: 'parser-bug' }],
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
    };

    const classified = classifyIssue(issueWithAnnotationOp);
    expect(classified.locus).toBe('adapter_bug');
    expect(classified.clusterKey).toBe('flasker-adapter');
    expect(classified.sourceShop).toBe('flasker');
  });

  it('treats negative operators containing not word like does_not_contain as exclusions', () => {
    const issueWithDoesNotContainOp: RawIssue = {
      number: 987,
      title: '[parser-bug] catalogue layout failure',
      body: 'Flasker mentioned in body.\n```triage-scope\n{"beer_ids":[],"where":[{"col":"source_url","op":"does_not_contain","value":"flasker"}]}\n```',
      labels: [{ name: 'orphan-triage' }, { name: 'parser-bug' }],
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
    };

    const classified = classifyIssue(issueWithDoesNotContainOp);
    expect(classified.sourceShop).toBeNull();
    expect(classified.clusterKey).toBe('misc');
  });

  it('classifies sinkholes and catch-all issues correctly', () => {
    const sinkholeIssue: RawIssue = {
      number: 334,
      title: "[matcher-bug] Matcher: name-stage disambiguation — shop base-name matches multiple Untappd variants",
      body: 'Scope: beer_ids 123\n```triage-scope\n{"beer_ids":[123],"where":[{"col":"candidates_count","op":">","value":0}]}\n```',
      labels: [{ name: 'orphan-triage' }, { name: 'matcher-bug' }, { name: 'saturated' }],
      createdAt: '2026-07-21T00:00:00Z',
      updatedAt: '2026-09-12T00:00:00Z',
    };

    const classified = classifyIssue(sinkholeIssue);
    expect(classified.locus).toBe('sinkhole_debris');
    expect(classified.clusterKey).toBe('sinkhole-debris');
    expect(classified.isSaturated).toBe(true);
  });

  it('groups classified issues and calculates impact scores', () => {
    const issues: RawIssue[] = [
      {
        number: 579,
        title: "[matcher-bug] flasker rows: EvilTwinImperial",
        body: '```triage-scope\n{"beer_ids":[34250],"where":[]}\n```',
        labels: [{ name: 'orphan-triage' }],
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-09-01T00:00:00Z',
      },
      {
        number: 566,
        title: "[matcher-bug] flasker Cyrillic section-header",
        body: '```triage-scope\n{"beer_ids":[34251, 34252],"where":[]}\n```',
        labels: [{ name: 'orphan-triage' }],
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-09-01T00:00:00Z',
      },
    ];

    const classified = issues.map(classifyIssue);
    const clusters = groupIntoClusters(classified);

    expect(clusters.length).toBe(1);
    const flaskerCluster = clusters[0];
    expect(flaskerCluster.key).toBe('flasker-adapter');
    expect(flaskerCluster.uniqueBeerIds.length).toBe(3);
    expect(flaskerCluster.impactScore).toBeGreaterThan(0);
    expect(flaskerCluster.locus).toBe('adapter_bug');
  });
});
