import type { TemplateFields } from './bug-report-types';

const HIDDEN = '[приховано]';
const PROFILE = /(?:https?:\/\/)?(?:www\.)?untappd\.com\/user\/[A-Za-z0-9_]+(?:\/[^\s]*)?/gi;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const HANDLE = /(?<![\p{L}\p{N}_])@[A-Za-z0-9_]{3,}\b/gu;
const DATE_OR_PHONE = /\b\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?|(?<![\p{L}\p{N}_])\+?\(?\d(?:[ .()\-]{0,2}\d){8,14}\)?(?![\p{L}\p{N}_])/gu;
const PHONE_SHAPE = /^\+?\(?\d(?:[ .()\-]?\d){8,14}\)?$/;

export function redact(text: string): string {
  return text
    .replace(PROFILE, HIDDEN)
    .replace(EMAIL, HIDDEN)
    .replace(HANDLE, HIDDEN)
    .replace(DATE_OR_PHONE, (match) => {
      if (/^\d{4}-\d{2}-\d{2}/.test(match)) return match;
      return PHONE_SHAPE.test(match.replace(/\) /g, ')')) ? HIDDEN : match;
    });
}

export function redactFields(f: TemplateFields): TemplateFields {
  return {
    title: redact(f.title), summary: redact(f.summary), where: redact(f.where),
    subjects: f.subjects.map(redact), expected: redact(f.expected), actual: redact(f.actual),
    steps: f.steps.map(redact), screenEvidence: f.screenEvidence.map(redact),
    newEvidence: redact(f.newEvidence),
  };
}
