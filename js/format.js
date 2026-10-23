/**
 * format.js
 * 表示用フォーマッタ。グラフ・表・KPI・ツールチップで表記ゆれを起こさないよう一元化する。
 * null は「データ無し」を意味し、常に EM DASH で表示する (0 と区別するため)。
 */
(function (global) {
  'use strict';

  const EMPTY = '—';
  const integerFormatter = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 });
  const decimalFormatter = new Intl.NumberFormat('ja-JP', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  const isNum = (value) => typeof value === 'number' && Number.isFinite(value);

  function yen(value) {
    return isNum(value) ? '¥' + integerFormatter.format(Math.round(value)) : EMPTY;
  }

  function integer(value, unit) {
    return isNum(value) ? integerFormatter.format(Math.round(value)) + (unit || '') : EMPTY;
  }

  function percent(value, digits) {
    const fractionDigits = Number.isInteger(digits) ? digits : 2;
    return isNum(value) ? value.toFixed(fractionDigits) + '%' : EMPTY;
  }

  function decimal(value, unit) {
    return isNum(value) ? decimalFormatter.format(value) + (unit || '') : EMPTY;
  }

  /** グラフ軸用の短縮円表記 (例: 7,200,000 → 720万) */
  function compactYen(value) {
    if (!isNum(value)) return '';
    const abs = Math.abs(value);
    if (abs >= 1e8) return (value / 1e8).toFixed(1).replace(/\.0$/, '') + '億';
    if (abs >= 1e4) return integerFormatter.format(Math.round(value / 1e4)) + '万';
    return integerFormatter.format(value);
  }

  /** 比較比 (%)。基準が0以下・欠損なら null */
  function ratio(current, base) {
    return isNum(current) && isNum(base) && base > 0 ? (current / base) * 100 : null;
  }

  /** 差分ポイント (率同士の差) */
  function pointDiff(current, base) {
    return isNum(current) && isNum(base) ? current - base : null;
  }

  function ratioText(value) {
    return isNum(value) ? value.toFixed(1) + '%' : EMPTY;
  }

  function pointText(value) {
    if (!isNum(value)) return EMPTY;
    const sign = value > 0 ? '+' : '';
    return sign + value.toFixed(2) + 'pt';
  }

  global.Fmt = Object.freeze({
    EMPTY,
    isNum,
    yen,
    integer,
    percent,
    decimal,
    compactYen,
    ratio,
    pointDiff,
    ratioText,
    pointText
  });
})(window);
