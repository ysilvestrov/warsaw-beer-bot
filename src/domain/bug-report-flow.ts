import { categoriesFor } from './bug-report-categories';
import type { MediaKind, ReportCategory, ReportSource } from './bug-report-types';

export type DraftStep = 'source' | 'category' | 'text' | 'media' | 'confirm';
export interface DraftMedia { fileId: string; kind: MediaKind; fileSize: number | null; ext: string }
export interface Draft {
  step: DraftStep;
  source: ReportSource | null;
  category: ReportCategory | null;
  text: string | null;
  media: DraftMedia[];
  updatedAt: string;
}
export type Keyboard =
  | { kind: 'sources' }
  | { kind: 'categories'; source: ReportSource }
  | { kind: 'media' }
  | { kind: 'confirm' };
export type ReplyParam = string | number | { t: string };
export interface Reply { key: string; params?: Record<string, ReplyParam>; keyboard?: Keyboard }
export type FlowEvent =
  | { type: 'start'; submittedToday: number; banned: boolean; available: boolean; privateChat: boolean }
  | { type: 'cancel' }
  | { type: 'pick_source'; source: ReportSource }
  | { type: 'pick_category'; category: ReportCategory }
  | { type: 'text'; text: string }
  | { type: 'media'; media: DraftMedia }
  | { type: 'media_done' }
  | { type: 'submit'; submittedToday: number };
export interface Submission { source: ReportSource; category: ReportCategory; text: string; media: DraftMedia[] }
export interface FlowResult {
  draft: Draft | null;
  replies: Reply[];
  passThrough: boolean;
  submission?: Submission;
}

export const DRAFT_TTL_MS = 30 * 60 * 1000;
export const MAX_MEDIA = 3;
export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
export const MIN_TEXT = 10;
export const DAILY_USER_LIMIT = 3;

export function stepFlow(stored: Draft | null, event: FlowEvent, now: Date): FlowResult {
  const draft = stored && now.getTime() - new Date(stored.updatedAt).getTime() <= DRAFT_TTL_MS
    ? { ...stored, updatedAt: now.toISOString() } : null;
  const reply = (key: string): FlowResult => ({ draft: null, replies: [{ key }], passThrough: false });

  if (event.type === 'start') {
    if (!event.privateChat) return reply('report.private_only');
    if (!event.available) return reply('report.unavailable');
    if (event.banned) return reply('report.banned');
    if (event.submittedToday >= DAILY_USER_LIMIT) return reply('report.limit');
    return {
      draft: { step: 'source', source: null, category: null, text: null, media: [], updatedAt: now.toISOString() },
      replies: [{ key: 'report.ask_source', keyboard: { kind: 'sources' } }], passThrough: false,
    };
  }

  if (!draft) {
    if (event.type === 'text' || event.type === 'media' || event.type === 'cancel') {
      return { draft: null, replies: [], passThrough: true };
    }
    return reply('report.expired');
  }

  switch (event.type) {
    case 'cancel': return reply('report.cancelled');
    case 'pick_source':
      if (draft.step !== 'source') break;
      return {
        draft: { ...draft, step: 'category', source: event.source },
        replies: [{ key: 'report.ask_category', keyboard: { kind: 'categories', source: event.source } }],
        passThrough: false,
      };
    case 'pick_category':
      if (draft.step !== 'category' || !draft.source ||
        !categoriesFor(draft.source).some((category) => category.key === event.category)) break;
      return {
        draft: { ...draft, step: 'text', category: event.category },
        replies: [{ key: 'report.ask_text' }], passThrough: false,
      };
    case 'text': {
      if (draft.step !== 'text' || event.text.startsWith('/')) {
        return { draft, replies: [], passThrough: true };
      }
      const trimmed = event.text.trim();
      if (trimmed.length < MIN_TEXT) {
        return { draft, replies: [{ key: 'report.too_short' }], passThrough: false };
      }
      return {
        draft: { ...draft, step: 'media', text: trimmed },
        replies: [{ key: 'report.ask_media', keyboard: { kind: 'media' } }], passThrough: false,
      };
    }
    case 'media':
      if (draft.step !== 'media') return { draft, replies: [], passThrough: true };
      if (event.media.fileSize !== null && event.media.fileSize > MAX_MEDIA_BYTES) {
        return { draft, replies: [{ key: 'report.media_too_big' }], passThrough: false };
      }
      if (draft.media.length >= MAX_MEDIA) {
        return { draft, replies: [{ key: 'report.media_full' }], passThrough: false };
      }
      return {
        draft: { ...draft, media: [...draft.media, event.media] },
        replies: [{ key: 'report.media_added', params: { n: draft.media.length + 1, max: MAX_MEDIA } }],
        passThrough: false,
      };
    case 'media_done':
      if (draft.step !== 'media') break;
      return {
        draft: { ...draft, step: 'confirm' },
        replies: [{ key: 'report.confirm', params: {
          source: { t: `report.source.${draft.source}` },
          category: { t: `report.cat.${draft.category}` },
          text: draft.text ?? '', media: draft.media.length,
        }, keyboard: { kind: 'confirm' } }], passThrough: false,
      };
    case 'submit':
      if (draft.step !== 'confirm') break;
      if (event.submittedToday >= DAILY_USER_LIMIT) return reply('report.limit');
      return {
        draft: null, replies: [], passThrough: false,
        submission: { source: draft.source!, category: draft.category!, text: draft.text!, media: draft.media },
      };
  }
  return { draft, replies: [], passThrough: false };
}
