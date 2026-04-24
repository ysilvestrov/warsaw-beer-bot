import { Markup } from 'telegraf';

export const filtersKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('IPA', 'style:IPA'), Markup.button.callback('Pils', 'style:Pils')],
    [Markup.button.callback('Stout', 'style:Stout'), Markup.button.callback('Sour', 'style:Sour')],
    [Markup.button.callback('min 3.5', 'rating:3.5'), Markup.button.callback('min 3.8', 'rating:3.8')],
    [Markup.button.callback('Скинути', 'reset')],
  ]);
