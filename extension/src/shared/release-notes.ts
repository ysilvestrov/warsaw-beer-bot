// Extracts the body of a keep-a-changelog section: everything between the
// `## [version] - date` heading and the next `## ` heading (or EOF), trimmed.
export function extractNotes(changelog: string, version: string): string {
  const lines = changelog.split('\n');
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headRe = new RegExp(`^##\\s*\\[${escaped}\\]`);
  const start = lines.findIndex((l) => headRe.test(l));
  if (start === -1) throw new Error(`CHANGELOG.md has no section for ${version}`);
  const rest = lines.slice(start + 1);
  const endRel = rest.findIndex((l) => /^##\s/.test(l));
  const body = (endRel === -1 ? rest : rest.slice(0, endRel)).join('\n').trim();
  if (!body) throw new Error(`CHANGELOG.md section for ${version} is empty`);
  return body;
}
