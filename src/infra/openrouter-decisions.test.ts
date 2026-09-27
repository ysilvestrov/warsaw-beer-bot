import { expect, test, vi } from 'vitest';
import type { IssueCandidate } from '../domain/bug-report-types';
import { candidateCriteria, createJevSelector, fitCandidates } from './openrouter-decisions';

const open: IssueCandidate = {
  number: 10, title: 'Missing badge', state: 'open',
  labels: ['extension-bug', 'Severity-3', 'effort/S'],
  createdAt: '2026-01-01T00:00:00Z', closedAt: null,
};
const closed: IssueCandidate = {
  number: 11, title: 'Wrong rating', state: 'closed',
  labels: ['matcher-bug', 'bug', 'Severity-2', 'effort/M'],
  createdAt: '2026-01-02T00:00:00Z', closedAt: '2026-03-01T00:00:00Z',
};

function response(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('candidateCriteria maps open and closed issues without severity or effort labels', () => {
  expect(candidateCriteria([open, closed])).toEqual({
    i10: '#10 [open] extension-bug — Missing badge',
    i11: '#11 [closed] matcher-bug, bug — Wrong rating',
    none: 'None of the listed issues describes this same problem.',
  });
});

test('fitCandidates keeps all candidates below the budget', () => {
  expect(fitCandidates([open, closed], 1000)).toEqual({ kept: [open, closed], truncated: false });
});

test('fitCandidates drops the oldest closed issue before newer closed and open issues', () => {
  const newerClosed = { ...closed, number: 12, closedAt: '2026-04-01T00:00:00Z' };
  expect(fitCandidates([open, closed, newerClosed], 65))
    .toEqual({ kept: [open, newerClosed], truncated: true });
});

test('fitCandidates drops the oldest open issue after closed issues are gone', () => {
  const newerOpen = { ...open, number: 13, createdAt: '2026-02-01T00:00:00Z' };
  expect(fitCandidates([open, newerOpen], 45))
    .toEqual({ kept: [newerOpen], truncated: true });
});

test('Jev sends the exact decision request and returns four keys when none ranks third', async () => {
  const candidates = [1, 2, 3, 4].map((number) => ({ ...open, number, title: `Issue ${number}` }));
  const fetchImpl = vi.fn().mockResolvedValue(response(200, {
    answers: { duplicate_of: { probabilities: { i4: 0.5, i2: 0.4, none: 0.3, i1: 0.2, i3: 0.1 } } },
  }));
  const result = await createJevSelector({ apiKey: 'secret', model: 'jev-model', fetchImpl })
    .select({ source: 'extension', category: 'no_badge', text: 'Badge missing' }, candidates);
  expect(result).toEqual({ numbers: [4, 2, 1, 3], truncated: false });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const [url, init] = fetchImpl.mock.calls[0];
  expect(url).toBe('https://openrouter.ai/api/alpha/decisions');
  expect(init.method).toBe('POST');
  expect(init.headers).toEqual({ Authorization: 'Bearer secret', 'Content-Type': 'application/json' });
  expect(JSON.parse(init.body)).toEqual({
    model: 'jev-model',
    state: { source: 'extension', category: 'no_badge', report: 'Badge missing' },
    questions: { duplicate_of: {
      type: 'choice',
      instructions: 'Which existing GitHub issue describes the same defect as the user report? Titles are developer-facing and may use technical terms for the symptom the user describes.',
      criteria: {
        i1: '#1 [open] extension-bug — Issue 1',
        i2: '#2 [open] extension-bug — Issue 2',
        i3: '#3 [open] extension-bug — Issue 3',
        i4: '#4 [open] extension-bug — Issue 4',
        none: 'None of the listed issues describes this same problem.',
      },
    } },
  });
});

test('Jev breaks equal probability ties by key and ignores unknown keys', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(response(200, {
    answers: { duplicate_of: { probabilities: { i10: 0.5, i9: 0.5, i999: 0.6, none: 0.4 } } },
  }));
  const result = await createJevSelector({ apiKey: 'secret', model: 'jev-model', fetchImpl })
    .select({ source: 'bot', category: 'other', text: 'Broken' }, [open, { ...open, number: 9 }]);
  expect(result).toEqual({ numbers: [10, 9], truncated: false });
});

test('Jev reports HTTP 429 as HttpStatusError without retrying', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(response(429, { message: 'rate limit' }));
  await expect(createJevSelector({ apiKey: 'secret', model: 'jev-model', fetchImpl })
    .select({ source: 'bot', category: 'other', text: 'Broken' }, []))
    .rejects.toMatchObject({ name: 'HttpStatusError', status: 429 });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test('Jev rejects a missing probabilities object as a plain Error', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(response(200, { answers: { duplicate_of: {} } }));
  await expect(createJevSelector({ apiKey: 'secret', model: 'jev-model', fetchImpl })
    .select({ source: 'bot', category: 'other', text: 'Broken' }, []))
    .rejects.toThrow('Jev response has no probabilities');
});
