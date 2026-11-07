// "12 407": a narrow no-break space groups thousands, as the spec's widget table writes them.
export function count(n: number): string {
  return n.toLocaleString('en-US').replace(/,/g, ' ');
}
