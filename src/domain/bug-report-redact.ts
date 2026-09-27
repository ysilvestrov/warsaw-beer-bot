import type { TemplateFields } from './bug-report-types';

const HIDDEN = '[приховано]';
// '.' is not a general phone separator: space-separated ratings ("4.0 4.1 4.2 4.0 4.2") would
// read as a 10-digit number and screen evidence would lose them. Dotted phones are caught only
// in the two shapes a rating list never takes: a leading '+', or 3-digit groups (ddd.ddd.ddd).
const PROFILE = /(?:https?:\/\/)?(?:www\.)?untappd\.com\/user\/[A-Za-z0-9_]+(?:\/[^\s]*)?/gi;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const HANDLE = /(?<![\p{L}\p{N}_])@[A-Za-z0-9_]{3,}\b/gu;
const DATE_OR_PHONE = /\b\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?|(?<![\p{L}\p{N}_])\+?\(?\d(?:[ ()\-]{0,2}\d){8,14}\)?(?![\p{L}\p{N}_])/gu;
const PHONE_SHAPE = /^\+?\(?\d(?:[ ()\-]?\d){8,14}\)?$/;
const DOTTED_PHONE = /(?<![\p{L}\p{N}_.])(?:\+\d(?:[ .()\-]{0,2}\d){8,14}|\d{3}\.\d{3}\.\d{3}(?:\.\d{3})?)(?![\p{L}\p{N}_]|\.\d)/gu;

export function redact(text: string): string {
  return text
    .replace(PROFILE, HIDDEN)
    .replace(EMAIL, HIDDEN)
    .replace(HANDLE, HIDDEN)
    .replace(DOTTED_PHONE, HIDDEN)
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
