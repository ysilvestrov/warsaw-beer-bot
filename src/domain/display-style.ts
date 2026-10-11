// #835: a pub sometimes types a whole beer description into ontap's subtitle, which the parser stores
// as the tap's style. Measured on all 940 distinct `taps.style` values in prod (2026-10-11): both rules
// below catch 6 of 6 descriptions and 0 of 934 styles. The naive "period + space + letter" hits six
// real styles through the abbreviation "w." — hence three letters before the period and an uppercase
// letter after it. This decides only what is PRINTED: the DB, the matcher and the style filter keep
// reading the raw field.

/** Longest real style seen is 116 code points, shortest description 144; 120 is a choice, not a measurement. */
export const STYLE_MAX_LENGTH = 120;

const SENTENCE_BREAK = /\p{L}{3,}[.!?]\s+\p{Lu}/u;

export function isDescription(style: string): boolean {
  return SENTENCE_BREAK.test(style) || [...style].length > STYLE_MAX_LENGTH;
}

/** The style to print for a tap: the pub's own, unless it is a description — then the catalogue's, if any. */
export function displayStyle(tapStyle: string | null, catalogStyle: string | null): string | null {
  if (tapStyle === null) return null;
  return isDescription(tapStyle) ? catalogStyle : tapStyle;
}
