import type { ReportCategory, ReportContext, TemplateFields } from './bug-report-types';

const CATEGORY_LABELS: Record<ReportCategory, string> = {
  wrong_beer: 'Не те пиво / чужий рейтинг',
  no_rating: 'Пиво без рейтингу',
  had_status: 'Неправильно «пив / не пив»',
  stale_data: 'Застарілі або хибні дані паба / кранів / крамниці',
  route: 'Маршрут або карта',
  no_badge: 'Позначка не з\'являється на сторінці крамниці',
  ext_broken: 'Розширення не працює: вхід, встановлення, оновлення, меню',
  bot_broken: 'Бот не відповідає, зависає або видає помилку',
  text_ui: 'Текст, переклад, оформлення',
  other: 'Інше',
};

function clamp(value: string, limit: number, multiline = false): string {
  const normalized = (multiline ? value.trim() : value.trim().replace(/[\r\n]+/g, ' '))
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const chars = [...normalized];
  return chars.length > limit ? `${chars.slice(0, limit - 1).join('')}…` : normalized;
}

function clampItems(items: string[], limit: number): string[] {
  return items.map((item) => item.trim()).filter((item) => item.length > 0)
    .slice(0, 5).map((item) => clamp(item, limit));
}

export function clampFields(f: TemplateFields): TemplateFields {
  return {
    title: clamp(f.title, 100), summary: clamp(f.summary, 300, true),
    where: clamp(f.where, 200), subjects: clampItems(f.subjects, 100),
    expected: clamp(f.expected, 200), actual: clamp(f.actual, 200),
    steps: clampItems(f.steps, 150), screenEvidence: clampItems(f.screenEvidence, 150),
    newEvidence: clamp(f.newEvidence, 300, true),
  };
}

function shown(value: string): string {
  return value || '—';
}

function media(ctx: ReportContext): string {
  if (ctx.mediaStored > 0) {
    const failed = ctx.mediaFailed > 0 ? `, не збережено: ${ctx.mediaFailed}` : '';
    return `${ctx.mediaStored} файл(и), лише на сервері: \`bug-reports/${ctx.reportId}/\`${failed}`;
  }
  return ctx.mediaFailed > 0 ? `не збережено (${ctx.mediaFailed})` : 'немає';
}

function issueSections(f: TemplateFields, ctx: ReportContext, includeEstimate: boolean, related: number[]): string {
  const steps = f.steps.length > 0 ? `\n\n## Кроки\n${f.steps.map((step, i) => `${i + 1}. ${step}`).join('\n')}` : '';
  const screens = f.screenEvidence.length > 0
    ? `\n\n## Видно на скріншотах\n${f.screenEvidence.map((line) => `- ${line}`).join('\n')}` : '';
  const relatedLine = related.length > 0
    ? `\n\n**Схожі (оцінка агента):** ${related.map((number) => `#${number}`).join(', ')}` : '';
  const version = ctx.source === 'bot' ? '—' : ctx.latestExtensionVersion
    ? `невідома (остання опублікована: ${ctx.latestExtensionVersion})` : 'невідома';
  const estimate = includeEstimate ? '\nSeverity і effort — оцінка агента.' : '';
  return `## Симптом
${shown(f.summary)}

**Де:** ${shown(f.where)}
**Об'єкти:** ${f.subjects.length > 0 ? f.subjects.join(', ') : '—'}
**Очікувано:** ${shown(f.expected)}
**Фактично:** ${shown(f.actual)}${steps}${screens}${relatedLine}

## Контекст
| Джерело | Категорія | Версія розширення | Місто | Мова |
|---|---|---|---|---|
| ${ctx.source === 'bot' ? 'Бот' : 'Розширення'} | ${CATEGORY_LABELS[ctx.category]} | ${version} | ${shown(ctx.city ?? '')} | ${ctx.locale} |
${estimate}
Скарга R-${ctx.reportId} · медіа: ${media(ctx)}
<!-- bug-report:${ctx.reportId} -->`;
}

export function renderIssueBody(f: TemplateFields, ctx: ReportContext, related: number[]): string {
  return issueSections(f, ctx, true, related);
}

export function renderDuplicateComment(f: TemplateFields, ctx: ReportContext): string {
  return `**Нове в цій скарзі:** ${shown(f.newEvidence)}\n\n${issueSections(f, ctx, false, [])}`;
}
