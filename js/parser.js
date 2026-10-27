/**
 * parser.js
 * 時間帯別実績CSVを解析し、08:00〜23:00 の固定16枠へ正規化する。
 *
 * 設計方針:
 * - 列位置ではなく「ヘッダ名」で列を特定する (出力システムによる列順・先頭空列の揺れに耐えるため)
 * - 数値化できない値は NaN ではなく null とし、「0円」と「データ無し(営業時間外)」を区別する
 * - DOM には一切触れない純粋関数群 (描画層と分離してテスト容易性を確保)
 */
(function (global) {
  'use strict';

  /** 分析対象とする時間帯 (店舗・曜日で営業時間が違っても表示フォーマットを統一するため固定) */
  const HOUR_START = 8;
  const HOUR_END = 23;
  const SLOT_COUNT = HOUR_END - HOUR_START + 1;

  /** 入力の上限 (異常に大きいCSVによるブラウザのフリーズを防止) */
  const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;
  const MAX_ROWS = 2000;
  const MAX_COLS = 100;
  const MAX_CELL_LENGTH = 1000;
  const MAX_META_TEXT_LENGTH = 50;

  /** CSV の値引率と再計算値の乖離をこれ以上で警告する (単位: ポイント) */
  const RATE_TOLERANCE_POINT = 0.05;

  /**
   * 列名エイリアス。正規化 (全角→半角・空白除去) 後の完全一致で判定する。
   * 部分一致にしないのは「値引」が「値引率」「値引累計」に誤マッチするのを防ぐため。
   */
  const COLUMN_ALIASES = Object.freeze({
    time:            ['時間', '時間帯', '時刻'],
    sales:           ['金額', '売上', '売上金額', '売上高'],
    customers:       ['客数'],
    items:           ['打数', '点数', '売上点数'],
    discount:        ['値引', '値引金額', '値引額', '割引', '割引金額'],
    discountRate:    ['値引率', '割引率'],
    cumSales:        ['累計金額', '金額累計', '売上累計', '累計売上'],
    cumCustomers:    ['客数累計', '累計客数'],
    cumItems:        ['打数累計', '累計打数'],
    cumDiscount:     ['値引累計', '累計値引', '値引金額累計', '割引累計'],
    cumDiscountRate: ['値引累計率', '累計値引率', '割引累計率']
  });

  const REQUIRED_COLUMNS = Object.freeze(['time', 'sales', 'customers', 'items']);

  const WEEKDAY_LABELS = Object.freeze(['日', '月', '火', '水', '木', '金', '土']);

  /** 業務エラー (利用者に表示してよいメッセージのみを持つ) */
  class CsvFormatError extends Error {
    constructor(message) {
      super(message);
      this.name = 'CsvFormatError';
    }
  }

  // ---------------------------------------------------------------------------
  // 文字列ユーティリティ
  // ---------------------------------------------------------------------------

  /** 全角英数記号を半角化し、前後空白を除去する */
  function toHalfWidth(text) {
    return String(text)
      .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
      .replace(/\u3000/g, ' ')
      .trim();
  }

  /** ヘッダ比較用: 半角化 + 全空白除去 */
  function normalizeHeader(text) {
    return toHalfWidth(text).replace(/\s+/g, '');
  }

  /** 表示用テキストの無害化: 制御文字・双方向制御文字を除去し長さ制限 */
  function sanitizeDisplayText(text, maxLength) {
    const cleaned = String(text ?? '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '')
      .trim();
    const limit = maxLength || MAX_META_TEXT_LENGTH;
    return cleaned.length > limit ? cleaned.slice(0, limit) + '…' : cleaned;
  }

  /**
   * "¥1,234 " / "2,057" / "1.50%" / "▲500" / "(500)" を数値化する。
   * @returns {number|null} 数値化不能・空は null
   */
  function parseNumber(raw) {
    if (raw === null || raw === undefined) return null;
    let text = toHalfWidth(raw);
    if (text === '' || text === '-' || text === '—') return null;

    let negative = false;
    if (/^[▲△]/.test(text)) {
      negative = true;
      text = text.slice(1);
    }
    if (/^\(.*\)$/.test(text)) {
      negative = true;
      text = text.slice(1, -1);
    }
    text = text.replace(/[¥\\,円%\s]/g, '');
    if (!/^-?\d+(\.\d+)?$/.test(text)) return null;

    const value = Number(text);
    if (!Number.isFinite(value)) return null;
    return negative ? -value : value;
  }

  /**
   * "08:00" / "8:00" / "8" / "8時" / "08:00-09:00" から「時」を取り出す。
   * @returns {number|null}
   */
  function parseHour(raw) {
    if (typeof raw === 'number' && raw > 0 && raw < 1) {
      // Excel の時刻シリアル値 (1日=1.0) の対応
      const hourFromSerial = Math.round(raw * 24);
      if (hourFromSerial >= 0 && hourFromSerial <= 24) return hourFromSerial;
    }
    const text = toHalfWidth(raw ?? '');
    const match = /^(\d{1,2})(?:[:：]\d{2})?(?:時)?/.exec(text);
    if (!match) return null;
    const hour = Number(match[1]);
    return Number.isInteger(hour) && hour >= 0 && hour <= 24 ? hour : null;
  }

  function formatHourLabel(hour) {
    return String(hour).padStart(2, '0') + ':00';
  }

  // ---------------------------------------------------------------------------
  // デコード & CSV 分解
  // ---------------------------------------------------------------------------

  /**
   * UTF-8 (BOM有無) を優先し、不正バイトがあれば Shift_JIS としてデコードする。
   * @param {ArrayBuffer} buffer
   */
  function decodeCsvBuffer(buffer) {
    const bytes = new Uint8Array(buffer);
    try {
      // fatal: true で不正シーケンス時に例外 → Shift_JIS 判定に利用
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    } catch (utf8Error) {
      try {
        return new TextDecoder('shift_jis', { fatal: true }).decode(bytes);
      } catch (sjisError) {
        throw new CsvFormatError('文字コードを判別できませんでした。UTF-8 または Shift_JIS のCSVを指定してください。');
      }
    }
  }

  /**
   * RFC4180 準拠の CSV 分解 (ダブルクォート内のカンマ・改行・"" エスケープに対応)。
   * @param {string} text
   * @returns {string[][]}
   */
  function splitCsvRows(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let inQuotes = false;

    const pushCell = () => {
      if (cell.length > MAX_CELL_LENGTH) {
        throw new CsvFormatError('CSVのセル内容が長すぎます。正しい時間帯別実績CSVか確認してください。');
      }
      row.push(cell);
      cell = '';
      if (row.length > MAX_COLS) {
        throw new CsvFormatError('CSVの列数が上限 (' + MAX_COLS + '列) を超えています。');
      }
    };
    const pushRow = () => {
      pushCell();
      // 内容が完全に空の行は配列に追加せずメモリを節約
      if (row.some((c) => c.trim().length > 0)) {
        rows.push(row);
      }
      row = [];
      if (rows.length > MAX_ROWS) {
        throw new CsvFormatError('CSVの行数が上限 (' + MAX_ROWS + '行) を超えています。');
      }
    };

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') {
            cell += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          cell += ch;
        }
        continue;
      }
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        pushCell();
      } else if (ch === '\r') {
        if (text[i + 1] === '\n') i++;
        pushRow();
      } else if (ch === '\n') {
        pushRow();
      } else {
        cell += ch;
      }
    }
    if (cell.length > 0 || row.length > 0) pushRow();
    return rows;
  }

  // ---------------------------------------------------------------------------
  // 構造解析
  // ---------------------------------------------------------------------------

  /** 行内の「ラベル」セルの次にある非空セルを返す (例: 年月日, 2026年10月22日) */
  function findLabeledValue(rows, labels, searchLimit) {
    const normalizedLabels = labels.map(normalizeHeader);
    const limit = Math.min(rows.length, searchLimit);
    for (let r = 0; r < limit; r++) {
      const cells = rows[r];
      for (let c = 0; c < cells.length; c++) {
        if (!normalizedLabels.includes(normalizeHeader(cells[c]))) continue;
        for (let k = c + 1; k < cells.length; k++) {
          if (String(cells[k]).trim() !== '') return String(cells[k]).trim();
        }
      }
    }
    return null;
  }

  /** "2026年10月22日" / "2026/10/22" / "2026-10-22" を解析 */
  function parseDateText(text) {
    if (!text) return null;
    const match = /(\d{4})\s*[年/\-.]\s*(\d{1,2})\s*[月/\-.]\s*(\d{1,2})/.exec(toHalfWidth(text));
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(year, month - 1, day);
    // 2月30日などの不正日付は Date が繰り上げるため、往復一致で検証する
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      return null;
    }
    return { year, month, day, weekday: WEEKDAY_LABELS[date.getDay()] };
  }

  /** ファイル名中の 8桁日付 (YYYYMMDD) を推定日付として使う (年月日行が無いCSV向け) */
  function parseDateFromFileName(fileName) {
    const match = /(20\d{2})(\d{2})(\d{2})/.exec(String(fileName || ''));
    return match ? parseDateText(match[1] + '/' + match[2] + '/' + match[3]) : null;
  }

  /** 「時間」と「金額」を含む行をヘッダとみなし、列キー→列番号のマップを返す */
  function locateHeader(rows) {
    for (let r = 0; r < rows.length; r++) {
      const normalized = rows[r].map(normalizeHeader);
      const columnIndex = {};
      Object.keys(COLUMN_ALIASES).forEach((key) => {
        const aliases = COLUMN_ALIASES[key];
        const idx = normalized.findIndex((name) => aliases.includes(name));
        if (idx !== -1) columnIndex[key] = idx;
      });
      if (columnIndex.time !== undefined && columnIndex.sales !== undefined) {
        return { headerRowIndex: r, columnIndex };
      }
    }
    return null;
  }

  /** 店舗合計ブロック (総金額/総客数/総打数/総割引/割引率) の読み取り */
  function findStoreTotals(rows, startRow) {
    for (let r = startRow; r < rows.length; r++) {
      const row = rows[r];
      const normalized = row.map(normalizeHeader);
      const salesIdx = normalized.findIndex((h) => ['総金額', '店舗合計', '合計金額'].includes(h));
      if (salesIdx === -1) continue;

      // ヘッダ行の次の行に値があるパターン、または同じ行の右側に値があるパターンの両方を探索
      const valueRow = (r + 1 < rows.length && rows[r + 1].length > 0) ? rows[r + 1] : row;
      const pick = (labels) => {
        for (let i = 0; i < labels.length; i++) {
          const idx = normalized.indexOf(labels[i]);
          if (idx !== -1) {
            const val = parseNumber(valueRow[idx]);
            if (val !== null) return val;
          }
        }
        return null;
      };

      const sales = pick(['総金額', '店舗合計', '合計金額', '金額']);
      if (sales !== null) {
        return {
          sales,
          customers: pick(['総客数', '客数']),
          items: pick(['総打数', '打数', '総点数', '点数']),
          discount: pick(['総割引', '総値引', '値引', '割引', '値引金額', '割引金額']),
          discountRate: pick(['割引率', '値引率'])
        };
      }
    }
    return null;
  }

  /** 値引率 = 値引 ÷ (金額 + 値引) ×100 (CSV実データで検算済みの定義) */
  function calcDiscountRate(discount, sales) {
    if (discount === null || sales === null) return null;
    const gross = sales + discount;
    return gross > 0 ? (discount / gross) * 100 : null;
  }

  function safeDivide(numerator, denominator) {
    if (numerator === null || denominator === null || denominator === 0) return null;
    return numerator / denominator;
  }

  function createEmptySlot(hour) {
    return {
      hour,
      label: formatHourLabel(hour),
      hasData: false,
      sales: null,
      customers: null,
      items: null,
      discount: null,
      discountRate: null,
      cumSales: null,
      cumCustomers: null,
      cumItems: null,
      cumDiscount: null,
      cumDiscountRate: null,
      avgSpend: null,
      avgItemPrice: null
    };
  }

  /**
   * 時間帯行を固定16枠に格納し、累計・率・派生指標を補完する。
   * CSVに累計列があればそれを優先し、無い場合のみ再計算する。
   */
  function buildSlots(rows, headerRowIndex, columnIndex, warnings) {
    const cell = (row, key) => (columnIndex[key] === undefined ? null : row[columnIndex[key]]);

    // CSV内に存在する有効時間帯の範囲を事前スキャン (標準 8〜23時をベースに、早朝・深夜があれば拡張)
    let minHour = HOUR_START;
    let maxHour = HOUR_END;
    for (let r = headerRowIndex + 1; r < rows.length; r++) {
      const hour = parseHour(cell(rows[r], 'time'));
      if (hour !== null) {
        if (hour < minHour) minHour = Math.max(0, hour);
        if (hour > maxHour) maxHour = Math.min(24, hour);
      }
    }

    const slots = [];
    for (let h = minHour; h <= maxHour; h++) slots.push(createEmptySlot(h));

    const duplicateHours = new Set();

    for (let r = headerRowIndex + 1; r < rows.length; r++) {
      const row = rows[r];
      const hour = parseHour(cell(row, 'time'));
      if (hour === null) continue;

      const sales = parseNumber(cell(row, 'sales'));
      const customers = parseNumber(cell(row, 'customers'));
      const items = parseNumber(cell(row, 'items'));
      if (sales === null && customers === null && items === null) continue;

      const slotIndex = hour - minHour;
      if (slotIndex < 0 || slotIndex >= slots.length) continue;
      const slot = slots[slotIndex];
      if (slot.hasData) {
        duplicateHours.add(slot.label);
        continue;
      }

      slot.hasData = true;
      slot.sales = sales;
      slot.customers = customers;
      slot.items = items;
      slot.discount = parseNumber(cell(row, 'discount'));
      slot.discountRate = parseNumber(cell(row, 'discountRate'));
      slot.cumSales = parseNumber(cell(row, 'cumSales'));
      slot.cumCustomers = parseNumber(cell(row, 'cumCustomers'));
      slot.cumItems = parseNumber(cell(row, 'cumItems'));
      slot.cumDiscount = parseNumber(cell(row, 'cumDiscount'));
      slot.cumDiscountRate = parseNumber(cell(row, 'cumDiscountRate'));
    }

    if (duplicateHours.size > 0) {
      warnings.push('重複した時間帯 (' + Array.from(duplicateHours).join(', ') + ') は最初の行のみ採用しました。');
    }

    // 累計・率の補完 (範囲外時間帯を除外した 08時起点の累計)
    const running = { sales: 0, customers: 0, items: 0, discount: 0 };
    let rateMismatch = false;
    slots.forEach((slot) => {
      if (!slot.hasData) return;
      running.sales += slot.sales ?? 0;
      running.customers += slot.customers ?? 0;
      running.items += slot.items ?? 0;
      running.discount += slot.discount ?? 0;

      const computedRate = calcDiscountRate(slot.discount, slot.sales);
      if (slot.discountRate === null) {
        slot.discountRate = computedRate;
      } else if (computedRate !== null && Math.abs(slot.discountRate - computedRate) > RATE_TOLERANCE_POINT) {
        rateMismatch = true;
      }

      if (slot.cumSales === null) slot.cumSales = running.sales;
      if (slot.cumCustomers === null) slot.cumCustomers = running.customers;
      if (slot.cumItems === null) slot.cumItems = running.items;
      if (slot.cumDiscount === null && slot.discount !== null) slot.cumDiscount = running.discount;
      if (slot.cumDiscountRate === null) slot.cumDiscountRate = calcDiscountRate(slot.cumDiscount, slot.cumSales);

      slot.avgSpend = safeDivide(slot.sales, slot.customers);
      slot.avgItemPrice = safeDivide(slot.sales, slot.items);
    });

    if (rateMismatch) {
      warnings.push('CSVの値引率が「値引 ÷ (金額 + 値引)」の計算値と一致しない時間帯があります。CSVの値をそのまま表示しています。');
    }
    return slots;
  }

  function summarizeSlots(slots) {
    const active = slots.filter((s) => s.hasData);
    const sum = (key) => active.reduce((acc, s) => acc + (s[key] ?? 0), 0);
    const hasDiscount = active.some((s) => s.discount !== null);

    const sales = sum('sales');
    const customers = sum('customers');
    const items = sum('items');
    const discount = hasDiscount ? sum('discount') : null;

    const peakOf = (key) => {
      let best = null;
      active.forEach((s) => {
        if (s[key] !== null && (best === null || s[key] > best[key])) best = s;
      });
      return best ? { label: best.label, value: best[key], index: best.hour - HOUR_START } : null;
    };

    return {
      activeSlotCount: active.length,
      firstLabel: active.length ? active[0].label : null,
      lastLabel: active.length ? active[active.length - 1].label : null,
      sales,
      customers,
      items,
      discount,
      discountRate: calcDiscountRate(discount, sales),
      avgSpend: safeDivide(sales, customers),
      avgItemPrice: safeDivide(sales, items),
      itemsPerCustomer: safeDivide(items, customers),
      peak: {
        sales: peakOf('sales'),
        customers: peakOf('customers'),
        items: peakOf('items'),
        discountRate: peakOf('discountRate')
      }
    };
  }

  /**
   * メインエントリ: CSV の ArrayBuffer を解析して分析用データセットを返す。
   * @param {ArrayBuffer} buffer
   * @param {string} fileName
   */
  function parseHourlySalesCsv(buffer, fileName) {
    if (!(buffer instanceof ArrayBuffer)) {
      throw new CsvFormatError('ファイルの読み込みに失敗しました。');
    }
    if (buffer.byteLength === 0) {
      throw new CsvFormatError('空のファイルです。');
    }
    if (buffer.byteLength > MAX_FILE_SIZE_BYTES) {
      throw new CsvFormatError('ファイルサイズが上限 (50MB) を超えています。');
    }

    const ext = (fileName.slice((fileName.lastIndexOf('.') - 1 >>> 0) + 2) || '').toLowerCase();
    const isExcel = ['xlsx', 'xls', 'xlsm', 'xlsb'].includes(ext);
    const isCsv = (ext === 'csv');

    if (!isExcel && !isCsv) {
      throw new CsvFormatError('サポートされていないファイル形式です。CSVまたはExcelファイル（.xlsx, .xls等）を指定してください。');
    }

    let rows;
    if (isExcel) {
      if (typeof global.XLSX === 'undefined') {
        throw new CsvFormatError('Excel解析ライブラリ (XLSX) が読み込まれていません。');
      }
      let workbook;
      try {
        // Excel読み込み時: 計算式やHTML装飾を排除し、評価済みの「値のみ」を取得
        workbook = global.XLSX.read(new Uint8Array(buffer), {
          type: 'array',
          cellFormula: false, // 計算式(.f)は読み込まず破棄
          cellHTML: false,    // HTML装飾は除外
          cellText: false,    // 書式化文字列ではなく生値
          cellStyles: false,  // スタイル除外
          raw: true           // 生の値のみ保持
        });
      } catch (e) {
        throw new CsvFormatError('Excelファイルの読み込みに失敗しました: ' + (e.message || ''));
      }

      if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
        throw new CsvFormatError('Excelファイル内に有効なシートが存在しません。');
      }

      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];

      // 防御策: セルオブジェクト内に数式(.f)が残存している場合は完全に消去し「値のみ」にする
      if (firstSheet) {
        for (const cellKey in firstSheet) {
          if (cellKey.charCodeAt(0) === 33) continue; // '!' で始まるメタデータ(!ref等)はスキップ
          const cell = firstSheet[cellKey];
          if (cell && typeof cell === 'object' && 'f' in cell) {
            delete cell.f;
          }
        }
      }

      rows = global.XLSX.utils.sheet_to_json(firstSheet, {
        header: 1,
        defval: '',
        raw: true // フォーマット文字列ではなく生の値（値のみ）を取得
      });
    } else {
      const text = decodeCsvBuffer(buffer);
      rows = splitCsvRows(text);
    }

    if (!rows || rows.length === 0) {
      throw new CsvFormatError('データが空です。');
    }
    const header = locateHeader(rows);
    if (!header) {
      throw new CsvFormatError('「時間」「金額」の列見出しが見つかりません。時間帯別実績データ（CSV/Excel）を指定してください。');
    }
    const missing = REQUIRED_COLUMNS.filter((key) => header.columnIndex[key] === undefined);
    if (missing.length > 0) {
      const names = missing.map((key) => COLUMN_ALIASES[key][0]);
      throw new CsvFormatError('必須列が不足しています: ' + names.join(', '));
    }

    const warnings = [];
    const slots = buildSlots(rows, header.headerRowIndex, header.columnIndex, warnings);
    const totals = summarizeSlots(slots);
    if (totals.activeSlotCount === 0) {
      throw new CsvFormatError('時間帯データが1件も見つかりませんでした。');
    }

    const storeTotals = findStoreTotals(rows, header.headerRowIndex + 1);
    if (storeTotals && storeTotals.sales !== null) {
      if (Math.round(storeTotals.sales) !== Math.round(totals.sales)) {
        warnings.push('CSVの店舗合計 (総金額: ' + storeTotals.sales.toLocaleString() + '円) と時間帯スロットの合計 (' + Math.round(totals.sales).toLocaleString() + '円) に差があります。基幹システムの確定値である店舗合計を採用しました。');
      }
      totals.sales = storeTotals.sales;
      if (storeTotals.customers !== null) totals.customers = storeTotals.customers;
      if (storeTotals.items !== null) totals.items = storeTotals.items;
      if (storeTotals.discount !== null) totals.discount = storeTotals.discount;
      totals.discountRate = storeTotals.discountRate ?? calcDiscountRate(totals.discount, totals.sales);
      totals.avgSpend = safeDivide(totals.sales, totals.customers);
      totals.avgItemPrice = safeDivide(totals.sales, totals.items);
      totals.itemsPerCustomer = safeDivide(totals.items, totals.customers);
    }

    const safeFileName = sanitizeDisplayText(fileName, 120);
    const dateInfo = parseDateText(findLabeledValue(rows, ['年月日', '日付', '営業日'], header.headerRowIndex))
      || parseDateFromFileName(fileName);
    const storeName = sanitizeDisplayText(findLabeledValue(rows, ['店名', '店舗名', '店舗'], header.headerRowIndex) || '店舗名不明');

    let dateLabel = '日付不明';
    let isoDate = null;
    if (dateInfo) {
      const mm = String(dateInfo.month).padStart(2, '0');
      const dd = String(dateInfo.day).padStart(2, '0');
      dateLabel = dateInfo.year + '/' + mm + '/' + dd + '(' + dateInfo.weekday + ')';
      isoDate = dateInfo.year + '-' + mm + '-' + dd;
    }

    return {
      meta: { fileName: safeFileName, storeName, dateLabel, isoDate, weekday: dateInfo ? dateInfo.weekday : null },
      slots,
      totals,
      hasDiscountColumn: header.columnIndex.discount !== undefined,
      warnings
    };
  }

  /**
   * 複数の解析済みデータセットを合算 (sum) または平均 (avg) する。
   * @param {Array<object>} dataSets HourlyParser.parse で解析された結果の配列
   * @param {'sum'|'avg'} mode 'sum' = 合算, 'avg' = 1ファイル/日あたり平均
   */
  function aggregateDataSets(dataSets, mode) {
    if (!Array.isArray(dataSets) || dataSets.length === 0) return null;
    const aggMode = mode === 'avg' ? 'avg' : 'sum';
    if (dataSets.length === 1) {
      const single = dataSets[0];
      return Object.assign({}, single, {
        aggMode,
        fileCount: 1,
        sourceFiles: [single.meta.fileName]
      });
    }

    const fileCount = dataSets.length;
    const warnings = [];
    dataSets.forEach((ds) => {
      if (ds.warnings && ds.warnings.length > 0) {
        ds.warnings.forEach((w) => {
          if (!warnings.includes(w)) warnings.push(ds.meta.storeName + ': ' + w);
        });
      }
    });

    const slots = [];
    const running = { sales: 0, customers: 0, items: 0, discount: 0 };
    const hasAnyDiscount = dataSets.some((ds) => ds.hasDiscountColumn);

    // 全データセットに含まれる時間帯の最小・最大を特定
    let startHour = HOUR_START;
    let endHour = HOUR_END;
    dataSets.forEach((ds) => {
      ds.slots.forEach((s) => {
        if (s.hasData) {
          if (s.hour < startHour) startHour = s.hour;
          if (s.hour > endHour) endHour = s.hour;
        }
      });
    });

    for (let h = startHour; h <= endHour; h++) {
      const slot = createEmptySlot(h);
      let sumSales = 0;
      let sumCust = 0;
      let sumItems = 0;
      let sumDisc = 0;
      let hasDataInAny = false;
      let hasDiscInAny = false;

      dataSets.forEach((ds) => {
        const s = ds.slots.find((item) => item.hour === h);
        if (s && s.hasData) {
          hasDataInAny = true;
          sumSales += s.sales ?? 0;
          sumCust += s.customers ?? 0;
          sumItems += s.items ?? 0;
          if (s.discount !== null) {
            sumDisc += s.discount;
            hasDiscInAny = true;
          }
        }
      });

      if (hasDataInAny) {
        slot.hasData = true;
        if (aggMode === 'sum') {
          slot.sales = sumSales;
          slot.customers = sumCust;
          slot.items = sumItems;
          slot.discount = hasDiscInAny ? sumDisc : null;
        } else {
          // 平均モード (日商平均):
          // 全時間帯の平均の合算が正確に日商平均 (全売上 ÷ fileCount) に一致するよう、全ファイル数 (日数) で除算
          slot.sales = Math.round(sumSales / fileCount);
          slot.customers = Math.round(sumCust / fileCount);
          slot.items = Math.round(sumItems / fileCount);
          slot.discount = hasDiscInAny ? Math.round(sumDisc / fileCount) : null;
        }

        slot.discountRate = calcDiscountRate(slot.discount, slot.sales);
        slot.avgSpend = safeDivide(slot.sales, slot.customers);
        slot.avgItemPrice = safeDivide(slot.sales, slot.items);

        running.sales += slot.sales ?? 0;
        running.customers += slot.customers ?? 0;
        running.items += slot.items ?? 0;
        running.discount += slot.discount ?? 0;

        slot.cumSales = running.sales;
        slot.cumCustomers = running.customers;
        slot.cumItems = running.items;
        slot.cumDiscount = hasDiscInAny ? running.discount : null;
        slot.cumDiscountRate = calcDiscountRate(slot.cumDiscount, slot.cumSales);
      }

      slots.push(slot);
    }

    // 各ファイルの確定合計値から全体の合計・平均を算出 (基幹システムと完全一致させる)
    const totalSales = dataSets.reduce((acc, ds) => acc + (ds.totals.sales ?? 0), 0);
    const totalCustomers = dataSets.reduce((acc, ds) => acc + (ds.totals.customers ?? 0), 0);
    const totalItems = dataSets.reduce((acc, ds) => acc + (ds.totals.items ?? 0), 0);
    const totalDiscount = dataSets.reduce((acc, ds) => acc + (ds.totals.discount ?? 0), 0);

    const slotSummary = summarizeSlots(slots);

    let totals;
    if (aggMode === 'sum') {
      totals = {
        activeSlotCount: slotSummary.activeSlotCount,
        firstLabel: slotSummary.firstLabel,
        lastLabel: slotSummary.lastLabel,
        sales: totalSales,
        customers: totalCustomers,
        items: totalItems,
        discount: hasAnyDiscount ? totalDiscount : null,
        discountRate: calcDiscountRate(totalDiscount, totalSales),
        avgSpend: safeDivide(totalSales, totalCustomers),
        avgItemPrice: safeDivide(totalSales, totalItems),
        itemsPerCustomer: safeDivide(totalItems, totalCustomers),
        peak: slotSummary.peak
      };
    } else {
      // 平均モード (日商平均): 全売上・客数・打数をファイル数 (日数) で除算
      const avgSales = Math.round(totalSales / fileCount);
      const avgCust = Math.round(totalCustomers / fileCount);
      const avgItems = Math.round(totalItems / fileCount);
      const avgDisc = hasAnyDiscount ? Math.round(totalDiscount / fileCount) : null;
      totals = {
        activeSlotCount: slotSummary.activeSlotCount,
        firstLabel: slotSummary.firstLabel,
        lastLabel: slotSummary.lastLabel,
        sales: avgSales,
        customers: avgCust,
        items: avgItems,
        discount: avgDisc,
        discountRate: calcDiscountRate(avgDisc, avgSales),
        avgSpend: safeDivide(avgSales, avgCust),
        avgItemPrice: safeDivide(avgSales, avgItems),
        itemsPerCustomer: safeDivide(avgItems, avgCust),
        peak: slotSummary.peak
      };
    }

    // メタ情報の集約
    const dates = Array.from(new Set(dataSets.map((ds) => ds.meta.isoDate).filter(Boolean))).sort();
    const stores = Array.from(new Set(dataSets.map((ds) => ds.meta.storeName).filter(Boolean)));
    const dateLabels = Array.from(new Set(dataSets.map((ds) => ds.meta.dateLabel).filter(Boolean)));

    let dateLabel = '';
    if (dates.length === 1) {
      dateLabel = dateLabels[0] || dates[0];
    } else if (dates.length > 1) {
      dateLabel = dates[0].slice(5) + '〜' + dates[dates.length - 1].slice(5) + ' (' + dates.length + '日分)';
    } else {
      dateLabel = fileCount + 'ファイル';
    }

    let storeName = '';
    if (stores.length === 1) {
      storeName = stores[0];
    } else if (stores.length <= 3) {
      storeName = stores.join(', ');
    } else {
      storeName = stores.length + '店舗';
    }

    const modePrefix = aggMode === 'avg' ? '【平均】' : '【合算】';
    const displayLabel = modePrefix + ' ' + dateLabel + ' ' + storeName + ' (' + fileCount + '件)';

    return {
      meta: {
        fileName: fileCount + 'ファイル' + (aggMode === 'avg' ? '_平均' : '_合算'),
        storeName,
        dateLabel,
        displayLabel,
        isoDate: dates.length === 1 ? dates[0] : null,
        fileCount,
        stores,
        dates
      },
      slots,
      totals,
      hasDiscountColumn: hasAnyDiscount,
      aggMode,
      fileCount,
      sourceFiles: dataSets.map((ds) => ds.meta.fileName),
      warnings
    };
  }

  global.HourlyParser = Object.freeze({
    parse: parseHourlySalesCsv,
    aggregate: aggregateDataSets,
    sanitizeDisplayText,
    CsvFormatError,
    HOUR_START,
    HOUR_END,
    SLOT_COUNT,
    MAX_FILE_SIZE_BYTES,
    // テスト用に公開 (副作用なしの純粋関数)
    _internal: Object.freeze({ parseNumber, parseHour, splitCsvRows, calcDiscountRate, parseDateText })
  });
})(window);

