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
