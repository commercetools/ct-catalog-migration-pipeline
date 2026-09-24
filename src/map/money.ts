/**
 * Decimal amount → commercetools minor units.
 *
 * The conversion is done on the digit string, never via parseFloat. A binary
 * float cannot represent most decimal amounts exactly, and the error shows up
 * as an off-by-one cent on a small fraction of records — which is the worst
 * kind of migration defect, because it looks like everything worked.
 *
 * More decimal places than the currency allows is refused rather than rounded.
 * Rounding here would silently change a price, and nobody reviews a price they
 * were not told changed.
 */

import type { Money } from '../model/plan.js';
import type { TypedMoney } from '@commercetools/importapi-sdk';

export type MoneyResult = { ok: true; money: Money } | { ok: false; reason: string };

export function toTypedMoney(
  amount: string,
  currency: string,
  fractionDigits: number,
): MoneyResult {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(amount);
  if (!match) {
    return {
      ok: false,
      reason: `'${amount}' is not a decimal amount. Expected digits with an optional single decimal point.`,
    };
  }

  const [, sign, whole, rawFraction = ''] = match;

  // Trailing zeros beyond the currency's precision carry no value, so trim them
  // before deciding whether precision would actually be lost: "19.9900" is a
  // legitimate 2-digit amount, while "19.9901" is not.
  const fraction = rawFraction.replace(/0+$/, '');

  if (fraction.length > fractionDigits) {
    return {
      ok: false,
      reason:
        `'${amount}' has ${fraction.length} decimal place(s) but ${currency} allows ` +
        `${fractionDigits}. Rounding would silently change the price, so this is refused. ` +
        'Fix the amount in the adapter, or correct ' +
        `market.currencyFractionDigits.${currency} if ${fractionDigits} is wrong.`,
    };
  }

  const padded = fraction.padEnd(fractionDigits, '0');
  const digits = `${whole}${padded}`.replace(/^0+(?=\d)/, '');
  const centAmount = Number(`${sign}${digits}`);

  if (!Number.isSafeInteger(centAmount)) {
    return {
      ok: false,
      reason: `'${amount}' in ${currency} exceeds the safe integer range in minor units.`,
    };
  }

  return {
    ok: true,
    money: { type: 'centPrecision', currencyCode: currency, centAmount, fractionDigits },
  };
}

/**
 * Renders minor units back to a decimal string, for verification and reports.
 *
 * Takes the full `TypedMoney` union because that is what a PriceDraftImport
 * carries. This pipeline only ever emits `centPrecision`, but a plan that came
 * from somewhere else may hold `highPrecision`, whose amount lives in
 * `preciseAmount` rather than `centAmount`.
 *
 * `fractionDigits` is optional on both (the platform fills it from the
 * currency), so an absent value is treated as 2 rather than producing NaN.
 */
export function fromTypedMoney(money: TypedMoney): string {
  const fractionDigits = money.fractionDigits ?? 2;
  const amount =
    money.type === 'highPrecision' ? money.preciseAmount : money.centAmount;
  const negative = amount < 0;
  const digits = String(Math.abs(amount)).padStart(fractionDigits + 1, '0');
  const cut = digits.length - fractionDigits;
  const whole = digits.slice(0, cut);
  const fraction = digits.slice(cut);
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}
