import { Markup } from 'telegraf';
import type { Translator } from '../i18n/types';

export const langKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('🇺🇦 Українська', 'lang:uk')],
    [Markup.button.callback('🇵🇱 Polski', 'lang:pl')],
    [Markup.button.callback('🇬🇧 English', 'lang:en')],
  ]);

export const filtersKeyboard = (t: Translator) =>
  Markup.inlineKeyboard([
    [Markup.button.callback('IPA', 'style:IPA'), Markup.button.callback('Pils', 'style:Pils')],
    [Markup.button.callback('Stout', 'style:Stout'), Markup.button.callback('Sour', 'style:Sour')],
    [Markup.button.callback('min 3.5', 'rating:3.5'), Markup.button.callback('min 3.8', 'rating:3.8')],
    [Markup.button.callback(t('filters.reset_button'), 'reset')],
  ]);
