import { describe, expect, it } from 'vitest';

const { getControlPanelKeyboard, getControlPanelText } = require('./telegram');

describe('Telegram strategy controls', () => {
  it('renders only the requested three rate choices and six period choices', () => {
    const keyboard = getControlPanelKeyboard(null, {
      strategy_config: { rateStrategy: 'high_24h', periodDays: 30 },
    });
    const buttons = keyboard.reply_markup.inline_keyboard.flat();
    const callbackData = buttons.map((button: { callback_data: string }) => button.callback_data);

    expect(callbackData).toEqual(expect.arrayContaining([
      'strategy_current_avg', 'strategy_high_24h', 'strategy_high_30d',
      'period_2', 'period_10', 'period_30', 'period_60', 'period_90', 'period_120',
    ]));
    expect(callbackData).toContain('start_engine');
    expect(callbackData).not.toContain('get_diagnostics');
    expect(callbackData).not.toContain('toggle_compounding');
    expect(callbackData).not.toContain('toggle_auto_transfer');
    expect(getControlPanelText(null, { strategy_config: { rateStrategy: 'high_24h', periodDays: 30 } }))
      .not.toContain('即時決策診斷');
    expect(callbackData).not.toContain('pause_engine');
    expect(callbackData).not.toContain('resume_engine');
    expect(getControlPanelText(null, { strategy_config: { rateStrategy: 'high_24h', periodDays: 30 } }))
      .toContain('24 小時最高');
    expect(getControlPanelText(null, { strategy_config: { rateStrategy: 'high_24h', periodDays: 30 } }))
      .toContain('複利滾投</b>: 固定開啟');
    expect(getControlPanelText(null, { strategy_config: { rateStrategy: 'high_24h', periodDays: 30 } }))
      .toContain('單筆投入全部可用餘額');
    expect(getControlPanelText(null, { strategy_config: { rateStrategy: 'high_24h', periodDays: 30 } }))
      .not.toContain('自動劃轉');
  });
});
