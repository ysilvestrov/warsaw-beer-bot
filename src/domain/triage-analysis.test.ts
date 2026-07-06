import {
  AnalysisSchema, buildTriagePrompt, ANALYSIS_TOOL_SCHEMA,
} from './triage-analysis';
import type { UntriagedFailure } from '../storage/enrich_failures';

const orphan: UntriagedFailure = {
  beer_id: 7, brewery: 'Nepomucen', name: 'Hazy Disco', search_url: 'https://s',
  source_url: 'https://shop.example', candidates_count: 3,
  candidates_summary: 'Nepo Brewing Hazy Disco|Other Beer', fail_count: 4,
  last_at: '2026-07-04T10:00:00Z',
};

test('AnalysisSchema: accepts a valid payload', () => {
  const a = AnalysisSchema.parse({
    verdicts: [{
      beer_id: 7, review_class: 'matcher_bug', review_note: 'alias gap',
      issue_number: null, new_issue_key: 'alias-nepomucen',
    }],
    new_issues: [{ key: 'alias-nepomucen', title: 'Alias: Nepomucen → Nepo Brewing',
      body: 'examples…', labels: ['orphan-triage'] }],
  });
  expect(a.verdicts[0].beer_id).toBe(7);
});

test('AnalysisSchema: rejects unknown review_class', () => {
  expect(() => AnalysisSchema.parse({
    verdicts: [{ beer_id: 1, review_class: 'meh', review_note: 'x',
      issue_number: null, new_issue_key: null }],
    new_issues: [],
  })).toThrow();
});

test('buildTriagePrompt: contains orphans, issues and class definitions', () => {
  const p = buildTriagePrompt({
    orphans: [orphan],
    openIssues: [{ number: 228, title: 'nano-noise tokens', body: 'strip nano', labels: ['orphan-triage'] }],
  });
  expect(p).toContain('"beer_id": 7');
  expect(p).toContain('#228');
  for (const cls of ['parser_bug', 'matcher_bug', 'not_on_untappd', 'wontfix']) {
    expect(p).toContain(cls);
  }
});

test('ANALYSIS_TOOL_SCHEMA: strict-compatible (no open objects)', () => {
  const check = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return;
    const o = node as Record<string, unknown>;
    if (o.type === 'object') {
      expect(o.additionalProperties).toBe(false);
      expect(Object.keys(o.properties as object).sort())
        .toEqual([...(o.required as string[])].sort());
    }
    for (const v of Object.values(o)) check(v);
  };
  check(ANALYSIS_TOOL_SCHEMA);
});
