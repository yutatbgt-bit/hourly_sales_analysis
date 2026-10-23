/**
 * app.js
 * 画面制御: 複数ファイル読込 / 合算・平均集約 / 時間帯区分カスタマイズ / IndexedDB永続化 / KPI / グラフ / テーブル / テーマ / 全画面 / リセット
 *
 * セキュリティ方針:
 * - DOM 生成は createElement + textContent のみ (innerHTML 等は使用しない)
 * - 外部スクリプト・外部通信は遮断 (IndexedDB と localStorage のみ)
 * - フレーム内表示を拒否 (Clickjacking 対策)
 */
(function (global) {
  'use strict';

  // Clickjacking 対策: 他サイトの iframe 内で操作させない
  if (global.top !== global.self) {
    document.body.replaceChildren();
    return;
  }

  const Parser = global.HourlyParser;
  const HourlyChart = global.HourlyChart;
  const HourlyStorage = global.HourlyStorage;
  const Fmt = global.Fmt;

  const THEME_STORAGE_KEY = 'hourly_sales_theme';
  const ALLOWED_THEMES = Object.freeze(['dark', 'light']);
  const STATUS_AUTO_HIDE_MS = 6000;
  const MAX_EXPORT_NAME_LENGTH = 100;

  /** デフォルトの時間帯区分: 朝・昼・夜 の3区分 */
  const DEFAULT_TIME_BANDS = Object.freeze([
    { id: 'b_morning', name: '朝', from: 8,  to: 10, enabled: true, color: '#7dd3fc' },
    { id: 'b_lunch',   name: '昼', from: 11, to: 16, enabled: true, color: '#38bdf8' },
    { id: 'b_night',   name: '夜', from: 17, to: 23, enabled: true, color: '#a855f7' }
  ]);

  /** プリセット定義 */
  const BAND_PRESETS = Object.freeze({
    standard: [
      { id: 'b_morning', name: '朝', from: 8,  to: 10, enabled: true, color: '#7dd3fc' },
      { id: 'b_lunch',   name: '昼', from: 11, to: 16, enabled: true, color: '#38bdf8' },
      { id: 'b_night',   name: '夜', from: 17, to: 23, enabled: true, color: '#a855f7' }
    ],
    detail_5: [
      { id: 'b_morning',   name: '朝',   from: 8,  to: 10, enabled: true, color: '#7dd3fc' },
      { id: 'b_lunch',     name: '昼',   from: 11, to: 13, enabled: true, color: '#38bdf8' },
      { id: 'b_afternoon', name: '午後', from: 14, to: 16, enabled: true, color: '#34d399' },
      { id: 'b_evening',   name: '夕方', from: 17, to: 19, enabled: true, color: '#d4af37' },
      { id: 'b_night',     name: '夜',   from: 20, to: 23, enabled: true, color: '#a855f7' }
    ],
    lunch_dinner: [
      { id: 'b_lunch',     name: '昼', from: 11, to: 14, enabled: true, color: '#38bdf8' },
      { id: 'b_dinner',    name: '夜', from: 17, to: 21, enabled: true, color: '#a855f7' }
    ],
    morning_night: [
      { id: 'b_morning',   name: '朝', from: 8,  to: 11, enabled: true, color: '#7dd3fc' },
      { id: 'b_night',     name: '夜', from: 18, to: 23, enabled: true, color: '#a855f7' }
    ],
    three_shifts: [
      { id: 'b_morning', name: '朝', from: 8,  to: 10, enabled: true, color: '#7dd3fc' },
      { id: 'b_lunch',   name: '昼', from: 11, to: 16, enabled: true, color: '#38bdf8' },
      { id: 'b_night',   name: '夜', from: 17, to: 23, enabled: true, color: '#a855f7' }
    ]
  });

  const BAND_COLORS = Object.freeze(['#7dd3fc', '#38bdf8', '#34d399', '#d4af37', '#a855f7', '#fb7185', '#fbbf24', '#818cf8', '#2dd4bf']);

  /** テーブル列定義 (group: hour=時間帯値 / cum=累計 / cmp=比較) */
  const TABLE_COLUMNS = Object.freeze([
    { key: 'hour',            label: '時間',       group: 'hour', format: null },
    { key: 'sales',           label: '金額',       group: 'hour', format: Fmt.yen, heat: 'sales' },
    { key: 'customers',       label: '客数',       group: 'hour', format: (v) => Fmt.integer(v), heat: 'customers' },
    { key: 'items',           label: '打数',       group: 'hour', format: (v) => Fmt.integer(v), heat: 'items' },
    { key: 'discount',        label: '値引',       group: 'hour', format: Fmt.yen, heat: 'discount' },
    { key: 'discountRate',    label: '値引率',     group: 'hour', format: (v) => Fmt.percent(v), heat: 'discount-rate' },
    { key: 'cumSales',        label: '金額累計',   group: 'cum',  format: Fmt.yen },
    { key: 'cumCustomers',    label: '客数累計',   group: 'cum',  format: (v) => Fmt.integer(v) },
    { key: 'cumItems',        label: '打数累計',   group: 'cum',  format: (v) => Fmt.integer(v) },
    { key: 'cumDiscount',     label: '値引累計',   group: 'cum',  format: Fmt.yen },
    { key: 'cumDiscountRate', label: '値引累計率', group: 'cum',  format: (v) => Fmt.percent(v) }
  ]);

  const COMPARE_COLUMNS = Object.freeze([
    { key: 'cmpSales',        label: '売上 比較比', source: 'sales',        mode: 'ratio' },
    { key: 'cmpCustomers',    label: '客数 比較比', source: 'customers',    mode: 'ratio' },
    { key: 'cmpItems',        label: '打数 比較比', source: 'items',        mode: 'ratio' },
    { key: 'cmpDiscountRate', label: '値引率 差',   source: 'discountRate', mode: 'point' }
  ]);

  const state = {
    rawMainFiles: [],     // アップロードされた個別の解析済みデータセット配列
    rawCompareFiles: [],  // 比較スロットのデータセット配列
    aggMode: 'sum',       // 'sum' | 'avg'
    primary: null,        // 集約済みメインデータセット
    compare: null,        // 集約済み比較データセット
    timeBands: JSON.parse(JSON.stringify(DEFAULT_TIME_BANDS)),
    visibility: { sales: true, customers: true, items: true, discountRate: true, discount: false },
    sort: { key: 'hour', direction: 'asc' },
    activeRowIndex: null,
    loadSequence: { main: 0, compare: 0 },
    statusTimerId: null
  };

  const dom = {};
  const rowByIndex = new Map();

  // ---------------------------------------------------------------------------
  // 初期化
  // ---------------------------------------------------------------------------

  function cacheDom() {
    const ids = [
      'status-message', 'file-input-main', 'file-input-compare', 'file-name-main', 'file-name-compare',
      'drop-zone-main', 'drop-zone-compare', 'btn-mode-sum', 'btn-mode-avg', 'btn-export-png',
      'btn-toggle-table', 'btn-reset-data', 'btn-fullscreen', 'btn-theme-toggle', 'chart-main-title',
      'chart-sub-title', 'chart-wrapper', 'chart-placeholder', 'main-chart-canvas', 'chart-tooltip',
      'compare-legend', 'legend-main-label', 'legend-compare-label', 'share-section', 'share-bar',
      'share-legend', 'btn-toggle-band-settings', 'band-settings-panel', 'band-list', 'btn-add-band',
      'btn-close-band-settings', 'table-container', 'table-header-row', 'table-body', 'table-foot',
      'kpi-sales-label', 'kpi-customers-label', 'kpi-items-label', 'kpi-peak-split', 'kpi-peak-split-sub',
      'kpi-peak-split-badge'
    ];
    ids.forEach((id) => {
      const node = document.getElementById(id);
      if (node) dom[id] = node;
    });
  }

  async function init() {
    cacheDom();
    initTheme();
    initFullscreen();
    setupDropZone(dom['drop-zone-main'], dom['file-input-main'], 'main');
    setupDropZone(dom['drop-zone-compare'], dom['file-input-compare'], 'compare');
    setupPlaceholderDrop();
    preventWindowFileDrop();

    if (dom['btn-mode-sum']) {
      dom['btn-mode-sum'].addEventListener('click', () => setAggMode('sum'));
    }
    if (dom['btn-mode-avg']) {
      dom['btn-mode-avg'].addEventListener('click', () => setAggMode('avg'));
    }

    dom['btn-export-png'].addEventListener('click', exportPng);
    dom['btn-toggle-table'].addEventListener('click', toggleTable);
    dom['btn-reset-data'].addEventListener('click', resetAllData);
    dom['btn-theme-toggle'].addEventListener('click', toggleTheme);

    document.querySelectorAll('.metric-chip').forEach((chip) => {
      chip.addEventListener('click', () => toggleMetric(chip));
    });

    setupBandSettingsEvents();
    renderTableHeader();
    renderEmptyTable();

    // データの永続化復元 (IndexedDB)
    await restorePersistedState();
    renderBandSettingsList();
  }

  // ---------------------------------------------------------------------------
  // 時間帯区分カスタマイズ
  // ---------------------------------------------------------------------------

  function setupBandSettingsEvents() {
    if (dom['btn-toggle-band-settings']) {
      dom['btn-toggle-band-settings'].addEventListener('click', () => {
        const panel = dom['band-settings-panel'];
        const isHidden = panel.classList.contains('hidden');
        panel.classList.toggle('hidden', !isHidden);
        dom['btn-toggle-band-settings'].textContent = isHidden ? '時間帯区分を閉じる ▲' : '時間帯区分を設定';
        dom['btn-toggle-band-settings'].setAttribute('aria-expanded', String(isHidden));
        if (isHidden) renderBandSettingsList();
      });
    }

    if (dom['btn-close-band-settings']) {
      dom['btn-close-band-settings'].addEventListener('click', () => {
        dom['band-settings-panel'].classList.add('hidden');
        dom['btn-toggle-band-settings'].textContent = '時間帯区分を設定';
        dom['btn-toggle-band-settings'].setAttribute('aria-expanded', 'false');
      });
    }

    if (dom['btn-add-band']) {
      dom['btn-add-band'].addEventListener('click', () => {
        const nextIdx = state.timeBands.length + 1;
        const color = BAND_COLORS[(nextIdx - 1) % BAND_COLORS.length];
        state.timeBands.push({
          id: 'b_' + Date.now(),
          name: '区分' + nextIdx,
          from: 12,
          to: 13,
          enabled: true,
          color: color
        });
        renderBandSettingsList();
        applyBandChanges();
      });
    }

    document.querySelectorAll('.btn-preset').forEach((btn) => {
      btn.addEventListener('click', () => {
        const presetKey = btn.dataset.preset;
        if (presetKey === 'reset' || presetKey === 'standard') {
          state.timeBands = JSON.parse(JSON.stringify(DEFAULT_TIME_BANDS));
        } else if (BAND_PRESETS[presetKey]) {
          state.timeBands = JSON.parse(JSON.stringify(BAND_PRESETS[presetKey]));
        }
        renderBandSettingsList();
        applyBandChanges();
        showStatus('時間帯区分のプリセットを適用しました。', 'info');
      });
    });
  }

  function renderBandSettingsList() {
    const list = dom['band-list'];
    if (!list) return;
    list.replaceChildren();

    state.timeBands.forEach((band, index) => {
      const row = document.createElement('div');
      row.className = 'band-row' + (band.enabled ? '' : ' disabled');

      // 有効チェックボックス
      const cbLabel = document.createElement('label');
      cbLabel.className = 'band-checkbox-label';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'band-checkbox';
      cb.checked = Boolean(band.enabled);
      cb.addEventListener('change', () => {
        band.enabled = cb.checked;
        row.classList.toggle('disabled', !cb.checked);
        applyBandChanges();
      });
      cbLabel.appendChild(cb);
      cbLabel.appendChild(document.createTextNode('有効'));
      row.appendChild(cbLabel);

      // 区分名入力
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'band-name-input';
      nameInput.value = band.name;
      nameInput.placeholder = '区分名';
      nameInput.maxLength = 15;
      nameInput.addEventListener('input', () => {
        band.name = Parser.sanitizeDisplayText(nameInput.value, 15) || '区分';
        applyBandChanges();
      });
      row.appendChild(nameInput);

      // 時間帯範囲 (from 〜 to)
      const rangeGroup = document.createElement('div');
      rangeGroup.className = 'band-range-group';

      const selectFrom = createHourSelect(band.from, (val) => {
        band.from = val;
        if (band.from > band.to) {
          band.to = band.from;
          selectTo.value = String(band.to);
        }
        applyBandChanges();
      });

      const sep = document.createElement('span');
      sep.textContent = '〜';

      const selectTo = createHourSelect(band.to, (val) => {
        band.to = val;
        if (band.to < band.from) {
          band.from = band.to;
          selectFrom.value = String(band.from);
        }
        applyBandChanges();
      });

      rangeGroup.append(selectFrom, sep, selectTo);
      row.appendChild(rangeGroup);

      // カラーピッカー
      const colorInput = document.createElement('input');
      colorInput.type = 'color';
      colorInput.className = 'band-color-picker';
      colorInput.value = band.color || '#38bdf8';
      colorInput.title = '区分の表示色を変更';
      colorInput.addEventListener('input', () => {
        band.color = colorInput.value;
        applyBandChanges();
      });
      row.appendChild(colorInput);

      // 削除ボタン
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'btn-remove-band';
      removeBtn.textContent = '削除';
      removeBtn.title = 'この区分を削除';
      removeBtn.addEventListener('click', () => {
        state.timeBands.splice(index, 1);
        renderBandSettingsList();
        applyBandChanges();
      });
      row.appendChild(removeBtn);

      list.appendChild(row);
    });
  }

  function createHourSelect(selectedHour, onChange) {
    const select = document.createElement('select');
    select.className = 'band-time-select';
    for (let h = Parser.HOUR_START; h <= Parser.HOUR_END; h++) {
      const opt = document.createElement('option');
      opt.value = String(h);
      opt.textContent = String(h).padStart(2, '0') + ':00';
      if (h === selectedHour) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => {
      onChange(Number(select.value));
    });
    return select;
  }

  function applyBandChanges() {
    if (state.primary) {
      renderShareBar(state.primary);
      renderKpiPeakSplit(state.primary, state.compare);
    }
    persistCurrentState();
  }

  // ---------------------------------------------------------------------------
  // IndexedDB 永続化 & 復元
  // ---------------------------------------------------------------------------

  async function persistCurrentState() {
    if (!HourlyStorage) return;
    const dataToSave = {
      rawMainFiles: state.rawMainFiles,
      rawCompareFiles: state.rawCompareFiles,
      aggMode: state.aggMode,
      timeBands: state.timeBands,
      visibility: state.visibility,
      sort: state.sort
    };
    await HourlyStorage.saveState(dataToSave);
  }

  async function restorePersistedState() {
    if (!HourlyStorage) return;
    try {
      const saved = await HourlyStorage.loadState();
      if (!saved) return;

      if (Array.isArray(saved.rawMainFiles) && saved.rawMainFiles.length > 0) {
        state.rawMainFiles = saved.rawMainFiles;
      }
      if (Array.isArray(saved.rawCompareFiles) && saved.rawCompareFiles.length > 0) {
        state.rawCompareFiles = saved.rawCompareFiles;
      }
      if (saved.aggMode === 'sum' || saved.aggMode === 'avg') {
        state.aggMode = saved.aggMode;
      }
      if (Array.isArray(saved.timeBands) && saved.timeBands.length > 0) {
        state.timeBands = saved.timeBands;
      }
      if (saved.visibility && typeof saved.visibility === 'object') {
        Object.assign(state.visibility, saved.visibility);
        document.querySelectorAll('.metric-chip').forEach((chip) => {
          const k = chip.dataset.metric;
          if (k in state.visibility) {
            chip.setAttribute('aria-pressed', String(state.visibility[k]));
          }
        });
      }
      if (saved.sort && saved.sort.key) {
        state.sort = saved.sort;
      }

      updateAggModeButtons();
      recomputeAggregates();
      if (state.primary) {
        updateFilePill('main', state.primary);
        if (state.compare) updateFilePill('compare', state.compare);
        updateDashboard();
        showStatus('保存されていた前回の分析データを復元しました。', 'info');
      }
    } catch (e) {
      console.warn('[HourlySales] failed to restore state:', e);
    }
  }

  // ---------------------------------------------------------------------------
  // 集約モード (合算 / 平均)
  // ---------------------------------------------------------------------------

  function setAggMode(mode) {
    if (state.aggMode === mode) return;
    state.aggMode = mode;
    updateAggModeButtons();
    recomputeAggregates();
    updateDashboard();
    persistCurrentState();
  }

  function updateAggModeButtons() {
    if (dom['btn-mode-sum']) {
      dom['btn-mode-sum'].classList.toggle('active', state.aggMode === 'sum');
    }
    if (dom['btn-mode-avg']) {
      dom['btn-mode-avg'].classList.toggle('active', state.aggMode === 'avg');
    }
  }

  function recomputeAggregates() {
    if (state.rawMainFiles.length > 0) {
      state.primary = Parser.aggregate(state.rawMainFiles, state.aggMode);
      updateFilePill('main', state.primary);
    } else {
      state.primary = null;
      updateFilePill('main', null);
    }

    if (state.rawCompareFiles.length > 0) {
      state.compare = Parser.aggregate(state.rawCompareFiles, state.aggMode);
      updateFilePill('compare', state.compare);
    } else {
      state.compare = null;
      updateFilePill('compare', null);
    }
  }

  // ---------------------------------------------------------------------------
  // ファイル読込 (複数ファイル対応)
  // ---------------------------------------------------------------------------

  function setupDropZone(zone, input, slot) {
    input.addEventListener('change', () => {
      if (input.files && input.files.length > 0) {
        handleFiles(Array.from(input.files), slot);
      }
      input.value = '';
    });

    zone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        input.click();
      }
    });

    ['dragenter', 'dragover'].forEach((type) => {
      zone.addEventListener(type, (event) => {
        event.preventDefault();
        zone.classList.add('drag-over');
      });
    });
    ['dragleave', 'dragend'].forEach((type) => {
      zone.addEventListener(type, () => zone.classList.remove('drag-over'));
    });
    zone.addEventListener('drop', (event) => {
      event.preventDefault();
      event.stopPropagation();
      zone.classList.remove('drag-over');
      const files = event.dataTransfer && event.dataTransfer.files ? Array.from(event.dataTransfer.files) : [];
      if (files.length > 0) handleFiles(files, slot);
    });
  }

  function setupPlaceholderDrop() {
    const wrapper = dom['chart-wrapper'];
    if (!wrapper) return;
    wrapper.addEventListener('dragover', (event) => {
      if (!state.primary) event.preventDefault();
    });
    wrapper.addEventListener('drop', (event) => {
      if (state.primary) return;
      event.preventDefault();
      event.stopPropagation();
      const files = event.dataTransfer && event.dataTransfer.files ? Array.from(event.dataTransfer.files) : [];
      if (files.length > 0) handleFiles(files, 'main');
    });
  }

  function preventWindowFileDrop() {
    global.addEventListener('dragover', (event) => event.preventDefault());
    global.addEventListener('drop', (event) => event.preventDefault());
  }

  /**
   * 複数ファイルの非同期読み込み・解析
   * @param {Array<File>} files
   * @param {'main'|'compare'} slot
   */
  async function handleFiles(files, slot) {
    const csvFiles = files.filter((f) => /\.csv$/i.test(f.name));
    if (csvFiles.length === 0) {
      showStatus('CSVファイル (.csv) を指定してください。', 'error');
      return;
    }

    const sequence = ++state.loadSequence[slot];
    showStatus(csvFiles.length + '件のファイルを読み込み解析中...', 'info', 0);

    const parsedSets = [];
    const errors = [];

    for (let i = 0; i < csvFiles.length; i++) {
      const file = csvFiles[i];
      if (file.size === 0) {
        errors.push(file.name + ': 空のファイルです');
        continue;
      }
      if (file.size > Parser.MAX_FILE_SIZE_BYTES) {
        errors.push(file.name + ': サイズ超過 (上限5MB)');
        continue;
      }

      try {
        const buffer = await file.arrayBuffer();
        const ds = Parser.parse(buffer, file.name);
        parsedSets.push(ds);
      } catch (err) {
        errors.push(file.name + ': ' + (err.message || '形式不正'));
      }
    }

    if (sequence !== state.loadSequence[slot]) return;

    if (parsedSets.length === 0) {
      showStatus('読み込み失敗: ' + errors.join(' ／ '), 'error', 0);
      return;
    }

    if (slot === 'main') {
      state.rawMainFiles = parsedSets;
    } else {
      state.rawCompareFiles = parsedSets;
    }

    recomputeAggregates();
    updateDashboard();
    await persistCurrentState();

    const targetSet = slot === 'main' ? state.primary : state.compare;
    const slotName = slot === 'main' ? '分析データ' : '比較データ';
    let msg = slotName + '（' + parsedSets.length + 'ファイル）を正常に読み込みました: ' + targetSet.meta.dateLabel;
    if (errors.length > 0) {
      msg += ' (※一部スキップ: ' + errors.join(', ') + ')';
      showStatus(msg, 'warning', 0);
    } else {
      showStatus(msg, 'success');
    }
  }

  function updateFilePill(slot, dataSet) {
    const pill = dom[slot === 'main' ? 'file-name-main' : 'file-name-compare'];
    if (!pill) return;
    if (!dataSet) {
      pill.textContent = slot === 'main' ? '分析: 未読込' : '比較: 未読込';
      pill.removeAttribute('title');
      pill.classList.add('hidden');
      return;
    }
    const prefix = slot === 'main' ? '分析: ' : '比較: ';
    const countText = dataSet.fileCount > 1 ? ' (' + dataSet.fileCount + '件)' : '';
    pill.textContent = prefix + dataSet.meta.dateLabel + ' ' + dataSet.meta.storeName + countText;
    pill.setAttribute('title', dataSet.sourceFiles ? dataSet.sourceFiles.join('\n') : dataSet.meta.fileName);
    pill.classList.remove('hidden');
  }

  // ---------------------------------------------------------------------------
  // ダッシュボード描画
  // ---------------------------------------------------------------------------

  function updateDashboard() {
    const primary = state.primary;
    const compare = primary ? state.compare : null;
    const hasData = Boolean(primary);

    dom['chart-placeholder'].classList.toggle('hidden', hasData);
    dom['main-chart-canvas'].classList.toggle('hidden', !hasData);
    dom['share-section'].classList.toggle('hidden', !hasData);
    dom['compare-legend'].classList.toggle('hidden', !compare);
    dom['btn-export-png'].disabled = !hasData;

    if (!hasData) {
      HourlyChart.destroyAll();
      resetKpis();
      renderTableHeader();
      renderEmptyTable();
      dom['chart-sub-title'].textContent = '08:00 〜 23:00 / CSVを読み込むと表示されます';
      return;
    }

    updateTitles(primary, compare);
    renderKpis(primary, compare);
    HourlyChart.renderMain(dom['main-chart-canvas'], dom['chart-tooltip'], primary, compare, state.visibility, setActiveRow);
    syncDiscountChipAvailability(primary);
    renderShareBar(primary);
    renderTableHeader();
    renderTable();
  }

  function updateTitles(primary, compare) {
    const modeLabel = state.aggMode === 'avg' ? '【時間帯平均】' : '【時間帯合算】';
    let subtitle = modeLabel + ' ' + primary.meta.dateLabel + ' ' + primary.meta.storeName + ' ／ 08:00 〜 23:00';
    if (primary.fileCount > 1) subtitle += ' (' + primary.fileCount + 'ファイル)';
    if (compare) {
      subtitle += ' ／ 比較: ' + compare.meta.dateLabel + ' ' + compare.meta.storeName + (compare.fileCount > 1 ? ' (' + compare.fileCount + '件)' : '');
    }
    dom['chart-sub-title'].textContent = subtitle;
    dom['legend-main-label'].textContent = '分析: ' + primary.meta.dateLabel + ' ' + primary.meta.storeName + (primary.fileCount > 1 ? ' (' + primary.fileCount + '件)' : '');
    dom['legend-compare-label'].textContent = compare ? '比較: ' + compare.meta.dateLabel + ' ' + compare.meta.storeName + (compare.fileCount > 1 ? ' (' + compare.fileCount + '件)' : '') : '比較データ';
  }

  function syncDiscountChipAvailability(primary) {
    const chip = document.querySelector('.metric-chip[data-metric="discount"]');
    if (!chip) return;
    chip.disabled = !primary.hasDiscountColumn;
    chip.title = primary.hasDiscountColumn ? '' : 'このCSVには値引列がありません';
  }

  function setTextWithPop(id, text) {
    const node = document.getElementById(id);
    if (!node) return;
    node.textContent = text;
    node.classList.remove('value-updated');
    void node.offsetWidth;
    node.classList.add('value-updated');
  }

  function setText(id, text) {
    const node = document.getElementById(id);
    if (node) node.textContent = text;
  }

  function renderBadge(slotId, numericDiff, text, goodDirection) {
    const slotNode = document.getElementById(slotId);
    if (!slotNode) return;
    slotNode.replaceChildren();
    if (text === null) return;
    const badge = document.createElement('span');
    let tone = 'badge-neutral';
    if (Fmt.isNum(numericDiff) && numericDiff !== 0) {
      const isGood = goodDirection === 'up' ? numericDiff > 0 : numericDiff < 0;
      tone = isGood ? 'badge-up' : 'badge-down';
    }
    badge.className = 'kpi-badge ' + tone;
    badge.textContent = text;
    slotNode.appendChild(badge);
  }

  // ---------------------------------------------------------------------------
  // KPI レンダリング (時間帯別最適化 6枚構成)
  // ---------------------------------------------------------------------------

  function renderKpis(primary, compare) {
    const t = primary.totals;
    const peak = t.peak;
    const isAvg = state.aggMode === 'avg';

    // 1. 売上実績
    if (dom['kpi-sales-label']) dom['kpi-sales-label'].textContent = isAvg ? '平均売上実績' : '売上合計実績';
    setTextWithPop('kpi-sales', Fmt.yen(t.sales));
    setText('kpi-sales-sub', peak.sales ? 'ピーク ' + peak.sales.label + '（' + Fmt.yen(peak.sales.value) + '）' : 'ピーク時間帯: -');

    // 2. 客数実績
    if (dom['kpi-customers-label']) dom['kpi-customers-label'].textContent = isAvg ? '平均客数実績' : '客数合計実績';
    setTextWithPop('kpi-customers', Fmt.integer(t.customers, ' 人'));
    setText('kpi-customers-sub', peak.customers ? 'ピーク ' + peak.customers.label + '（' + Fmt.integer(peak.customers.value, '人') + '）' : 'ピーク時間帯: -');

    // 3. 打数実績
    if (dom['kpi-items-label']) dom['kpi-items-label'].textContent = isAvg ? '平均買上打数' : '買上打数合計';
    setTextWithPop('kpi-items', Fmt.integer(t.items, ' 打数'));
    setText('kpi-items-sub', '買上打数: ' + Fmt.decimal(t.itemsPerCustomer, ' 打数/人'));

    // 4. 単価 (客単価 & 一品単価)
    setTextWithPop('kpi-avg-spend', Fmt.yen(t.avgSpend));
    setText('kpi-avg-price-sub', '一品単価: ' + Fmt.yen(t.avgItemPrice));

    // 5. 値引率 & 値引金額
    setTextWithPop('kpi-discount-rate', Fmt.percent(t.discountRate));
    setText('kpi-discount-rate-sub', '値引額 ' + Fmt.yen(t.discount) +
      (peak.discountRate ? ' ／ 最大 ' + peak.discountRate.label + '（' + Fmt.percent(peak.discountRate.value) + '）' : ''));

    // 6. ピーク構成比連動
    renderKpiPeakSplit(primary, compare);

    // 比較バッジ (1〜5)
    if (compare) {
      const c = compare.totals;
      const ratioBadge = (id, cur, base) => {
        const r = Fmt.ratio(cur, base);
        renderBadge(id, Fmt.isNum(r) ? r - 100 : null, '比較比 ' + Fmt.ratioText(r), 'up');
      };
      ratioBadge('kpi-sales-badge', t.sales, c.sales);
      ratioBadge('kpi-customers-badge', t.customers, c.customers);
      ratioBadge('kpi-items-badge', t.items, c.items);
      ratioBadge('kpi-price-badge', t.avgSpend, c.avgSpend);

      const d = Fmt.pointDiff(t.discountRate, c.discountRate);
      renderBadge('kpi-discount-rate-badge', d, '比較差 ' + Fmt.pointText(d), 'down');
    } else {
      ['kpi-sales-badge', 'kpi-customers-badge', 'kpi-items-badge', 'kpi-price-badge', 'kpi-discount-rate-badge']
        .forEach((id) => renderBadge(id, null, null));
    }

    // スパークライン
    const series = (key) => primary.slots.map((s) => (s.hasData ? s[key] : null));
    HourlyChart.renderSparkline(document.getElementById('spark-sales'), series('sales'), 'sales');
    HourlyChart.renderSparkline(document.getElementById('spark-customers'), series('customers'), 'customers');
    HourlyChart.renderSparkline(document.getElementById('spark-items'), series('items'), 'items');
    HourlyChart.renderSparkline(document.getElementById('spark-discount-rate'), series('discountRate'), 'discountRate');
  }

  function renderKpiPeakSplit(primary, compare) {
    const total = primary.totals.sales;
    const activeBands = state.timeBands.filter((b) => b.enabled);

    // タイトル更新: 有効な時間帯区分名に動的連動
    let titleText = '売上構成比';
    if (activeBands.length > 0 && activeBands.length <= 5) {
      titleText = activeBands.map((b) => b.name).join(' ／ ') + ' 売上構成比';
    } else if (activeBands.length > 5) {
      titleText = '時間帯別 売上構成比 (' + activeBands.length + '区分)';
    }
    setText('kpi-peak-split-title', titleText);

    const cardEl = document.querySelector('.kpi-card.peak-split');
    if (cardEl) {
      cardEl.dataset.bands = String(activeBands.length);
    }

    if (!Fmt.isNum(total) || total <= 0 || activeBands.length === 0) {
      setText('kpi-peak-split', '-');
      const emptySub = activeBands.length === 0
        ? '有効な時間帯区分がありません'
        : activeBands.map((b) => b.name + ' -').join(' ／ ');
      setText('kpi-peak-split-sub', emptySub);
      renderBadge('kpi-peak-split-badge', null, null);
      HourlyChart.renderBandSparkline(document.getElementById('spark-peak-split'), []);
      return;
    }

    // 各有効区分の売上および構成比を算出
    const bandStats = activeBands.map((b) => {
      const sales = primary.slots
        .filter((s) => s.hasData && s.hour >= b.from && s.hour <= b.to)
        .reduce((acc, s) => acc + (s.sales ?? 0), 0);
      const share = total > 0 ? (sales / total) * 100 : 0;
      return { band: b, sales, share };
    });

    // 全有効区分の構成比と金額を表示（5区分の場合もすべて表示）
    const textVal = bandStats.map((st) => st.band.name + ' ' + st.share.toFixed(1) + '%').join(' ／ ');
    const subVal = bandStats.map((st) => st.band.name + ' ' + Fmt.yen(st.sales)).join(' ／ ');

    setTextWithPop('kpi-peak-split', textVal);
    setText('kpi-peak-split-sub', subVal);

    // 時間帯区分に色分けした横棒グラフ（スパークライン）を描画
    HourlyChart.renderBandSparkline(document.getElementById('spark-peak-split'), bandStats);

    if (compare && compare.totals.sales > 0 && bandStats.length > 0) {
      const cTotal = compare.totals.sales;
      // 最も売上構成比の高い主力区分で比率差を算出
      const primaryLead = [...bandStats].sort((a, b) => b.sales - a.sales)[0];
      const leadBand = primaryLead.band;
      const cLeadSales = compare.slots
        .filter((s) => s.hasData && s.hour >= leadBand.from && s.hour <= leadBand.to)
        .reduce((acc, s) => acc + (s.sales ?? 0), 0);
      const cLeadShare = (cLeadSales / cTotal) * 100;
      const diff = primaryLead.share - cLeadShare;
      renderBadge(
        'kpi-peak-split-badge',
        diff,
        leadBand.name + '比率差 ' + (diff >= 0 ? '+' : '') + diff.toFixed(1) + 'pt',
        'up'
      );
    } else {
      renderBadge('kpi-peak-split-badge', null, null);
    }
  }

  function resetKpis() {
    ['kpi-sales', 'kpi-customers', 'kpi-items', 'kpi-avg-spend', 'kpi-discount-rate', 'kpi-peak-split'].forEach((id) => setText(id, '-'));
    setText('kpi-sales-sub', 'ピーク: -');
    setText('kpi-customers-sub', 'ピーク: -');
    setText('kpi-items-sub', '買上打数: - 打数/人');
    setText('kpi-avg-price-sub', '一品単価: -');
    setText('kpi-discount-rate-sub', '値引額: - ／ 最大: -');
    setText('kpi-peak-split-title', '朝 ／ 昼 ／ 夜 売上構成比');
    setText('kpi-peak-split-sub', '朝 - ／ 昼 - ／ 夜 -');
    ['kpi-sales-badge', 'kpi-customers-badge', 'kpi-items-badge', 'kpi-price-badge', 'kpi-discount-rate-badge', 'kpi-peak-split-badge']
      .forEach((id) => renderBadge(id, null, null));
    HourlyChart.renderBandSparkline(document.getElementById('spark-peak-split'), []);
  }

  function renderShareBar(primary) {
    const total = primary.totals.sales;
    dom['share-bar'].replaceChildren();
    dom['share-legend'].replaceChildren();
    if (!Fmt.isNum(total) || total <= 0) return;

    const activeBands = state.timeBands.filter((b) => b.enabled);
    if (activeBands.length === 0) {
      const msg = document.createElement('div');
      msg.className = 'share-legend-item';
      msg.textContent = '※表示対象の時間帯区分が選択されていません。「時間帯区分を設定」から区分を有効にしてください。';
      dom['share-legend'].appendChild(msg);
      return;
    }

    activeBands.forEach((band) => {
      const bandSales = primary.slots
        .filter((s) => s.hasData && s.hour >= band.from && s.hour <= band.to)
        .reduce((acc, s) => acc + (s.sales ?? 0), 0);
      const share = (bandSales / total) * 100;

      const segment = document.createElement('div');
      segment.className = 'share-segment';
      segment.style.backgroundColor = band.color || '#38bdf8';
      segment.style.setProperty('--share', share.toFixed(2));
      segment.textContent = share >= 6 ? share.toFixed(1) + '%' : '';
      const rangeText = String(band.from).padStart(2, '0') + ':00〜' + String(band.to).padStart(2, '0') + ':00';
      segment.setAttribute('title', band.name + ' (' + rangeText + '): ' + Fmt.yen(bandSales) + '（' + share.toFixed(1) + '%）');
      dom['share-bar'].appendChild(segment);

      const legend = document.createElement('span');
      legend.className = 'share-legend-item';
      const swatch = document.createElement('span');
      swatch.className = 'share-swatch';
      swatch.style.backgroundColor = band.color || '#38bdf8';
      const label = document.createElement('span');
      label.textContent = band.name + ' (' + rangeText + ') ';
      const value = document.createElement('strong');
      value.textContent = Fmt.yen(bandSales) + '（' + share.toFixed(1) + '%）';
      legend.append(swatch, label, value);
      dom['share-legend'].appendChild(legend);
    });
  }

  // ---------------------------------------------------------------------------
  // テーブル
  // ---------------------------------------------------------------------------

  function activeColumns() {
    return state.compare && state.primary ? TABLE_COLUMNS.concat(COMPARE_COLUMNS) : TABLE_COLUMNS;
  }

  function renderTableHeader() {
    const headerRow = dom['table-header-row'];
    if (!headerRow) return;
    headerRow.replaceChildren();
    let previousGroup = 'hour';

    activeColumns().forEach((col) => {
      const group = col.group || 'cmp';
      const th = document.createElement('th');
      th.scope = 'col';
      if (group !== previousGroup) th.className = group === 'cum' ? 'th-group-cum' : 'th-group-cmp';
      previousGroup = group;

      const isActive = state.sort.key === col.key;
      th.setAttribute('aria-sort', isActive ? (state.sort.direction === 'asc' ? 'ascending' : 'descending') : 'none');

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'th-sort-btn' + (col.key === 'hour' ? ' align-center' : '');
      button.setAttribute('aria-sort-active', String(isActive));
      button.textContent = col.label;
      const indicator = document.createElement('span');
      indicator.className = 'sort-indicator';
      indicator.setAttribute('aria-hidden', 'true');
      indicator.textContent = isActive ? (state.sort.direction === 'asc' ? '▲' : '▼') : '⇅';
      button.appendChild(indicator);
      button.addEventListener('click', () => changeSort(col.key));
      th.appendChild(button);
      headerRow.appendChild(th);
    });
  }

  function changeSort(key) {
    if (!state.primary) return;
    if (state.sort.key === key) {
      state.sort.direction = state.sort.direction === 'asc' ? 'desc' : 'asc';
    } else {
      state.sort = { key, direction: key === 'hour' ? 'asc' : 'desc' };
    }
    renderTableHeader();
    renderTable();
    persistCurrentState();
  }

  function compareValue(slot, col, compareSlot) {
    if (!col.source) return slot[col.key];
    if (!compareSlot || !compareSlot.hasData || !slot.hasData) return null;
    return col.mode === 'ratio'
      ? Fmt.ratio(slot[col.source], compareSlot[col.source])
      : Fmt.pointDiff(slot[col.source], compareSlot[col.source]);
  }

  function sortedSlotIndexes() {
    const primary = state.primary;
    const compare = state.compare;
    const col = activeColumns().find((c) => c.key === state.sort.key) || TABLE_COLUMNS[0];
    const indexes = primary.slots.map((_, i) => i);
    if (col.key === 'hour') {
      return state.sort.direction === 'asc' ? indexes : indexes.reverse();
    }
    const valueOf = (i) => compareValue(primary.slots[i], col, compare ? compare.slots[i] : null);
    const factor = state.sort.direction === 'asc' ? 1 : -1;
    return indexes.sort((a, b) => {
      const va = valueOf(a);
      const vb = valueOf(b);
      if (!Fmt.isNum(va) && !Fmt.isNum(vb)) return a - b;
      if (!Fmt.isNum(va)) return 1;
      if (!Fmt.isNum(vb)) return -1;
      return (va - vb) * factor || a - b;
    });
  }

  function columnMax(slots, key) {
    return slots.reduce((max, s) => (s.hasData && Fmt.isNum(s[key]) && s[key] > max ? s[key] : max), 0);
  }

  function createCell(text, classNames) {
    const td = document.createElement('td');
    if (classNames) td.className = classNames;
    td.textContent = text;
    return td;
  }

  function cmpCell(value, col) {
    const text = col.mode === 'ratio' ? Fmt.ratioText(value) : Fmt.pointText(value);
    let tone = 'text-diff-neutral';
    if (Fmt.isNum(value)) {
      const delta = col.mode === 'ratio' ? value - 100 : value;
      const isGood = col.mode === 'ratio' ? delta > 0 : delta < 0;
      if (delta !== 0) tone = isGood ? 'text-diff-up' : 'text-diff-down';
    }
    return createCell(text, 'text-right ' + tone);
  }

  function renderTable() {
    const primary = state.primary;
    const compare = state.compare;
    const body = dom['table-body'];
    if (!body) return;
    body.replaceChildren();
    rowByIndex.clear();

    const maxima = {};
    TABLE_COLUMNS.forEach((col) => { if (col.heat) maxima[col.key] = columnMax(primary.slots, col.key); });
    const peakSalesIndex = primary.totals.peak.sales ? primary.totals.peak.sales.index : null;

    sortedSlotIndexes().forEach((index) => {
      const slot = primary.slots[index];
      const compareSlot = compare ? compare.slots[index] : null;
      const tr = document.createElement('tr');
      tr.dataset.index = String(index);
      tr.tabIndex = 0;
      if (!slot.hasData) tr.classList.add('row-empty');

      const timeCell = createCell(slot.label, 'td-time');
      if (index === peakSalesIndex) {
        const mark = document.createElement('span');
        mark.className = 'peak-mark';
        mark.textContent = 'PEAK';
        mark.setAttribute('title', '売上ピーク時間帯');
        timeCell.appendChild(mark);
      }
      tr.appendChild(timeCell);

      TABLE_COLUMNS.slice(1).forEach((col) => {
        const value = slot.hasData ? slot[col.key] : null;
        const classes = ['text-right'];
        if (col.group === 'cum') classes.push('td-cum');
        if (col.key === 'cumSales') classes.push('td-cum-first');
        const td = createCell(col.format(value), classes.join(' '));
        if (col.heat && Fmt.isNum(value) && maxima[col.key] > 0) {
          td.classList.add('heat', 'heat-' + col.heat);
          td.style.setProperty('--heat', Math.max(0, value / maxima[col.key]).toFixed(3));
        }
        tr.appendChild(td);
      });

      if (compare) {
        COMPARE_COLUMNS.forEach((col, i) => {
          const td = cmpCell(compareValue(slot, col, compareSlot), col);
          if (i === 0) td.classList.add('td-cum-first');
          tr.appendChild(td);
        });
      }

      tr.addEventListener('mouseenter', () => onRowHover(index));
      tr.addEventListener('focus', () => onRowHover(index));
      tr.addEventListener('mouseleave', () => onRowHover(null));
      tr.addEventListener('blur', () => onRowHover(null));
      rowByIndex.set(index, tr);
      body.appendChild(tr);
    });

    renderTableFooter(primary, compare);
  }

  function renderTableFooter(primary, compare) {
    const foot = dom['table-foot'];
    if (!foot) return;
    foot.replaceChildren();
    const t = primary.totals;
    const lastActive = primary.slots.filter((s) => s.hasData).pop();

    const totalsByKey = {
      sales: t.sales,
      customers: t.customers,
      items: t.items,
      discount: t.discount,
      discountRate: t.discountRate,
      cumSales: lastActive ? lastActive.cumSales : null,
      cumCustomers: lastActive ? lastActive.cumCustomers : null,
      cumItems: lastActive ? lastActive.cumItems : null,
      cumDiscount: lastActive ? lastActive.cumDiscount : null,
      cumDiscountRate: lastActive ? lastActive.cumDiscountRate : null
    };

    const tr = document.createElement('tr');
    tr.appendChild(createCell(state.aggMode === 'avg' ? '平均' : '合計', 'td-time'));
    TABLE_COLUMNS.slice(1).forEach((col) => {
      const classes = ['text-right'];
      if (col.group === 'cum') classes.push('td-cum');
      if (col.key === 'cumSales') classes.push('td-cum-first');
      tr.appendChild(createCell(col.format(totalsByKey[col.key]), classes.join(' ')));
    });
    if (compare) {
      const c = compare.totals;
      COMPARE_COLUMNS.forEach((col, i) => {
        const value = col.mode === 'ratio' ? Fmt.ratio(t[col.source], c[col.source]) : Fmt.pointDiff(t[col.source], c[col.source]);
        const td = cmpCell(value, col);
        if (i === 0) td.classList.add('td-cum-first');
        tr.appendChild(td);
      });
    }
    foot.appendChild(tr);
  }

  function renderEmptyTable() {
    if (!dom['table-body']) return;
    dom['table-body'].replaceChildren();
    if (dom['table-foot']) dom['table-foot'].replaceChildren();
    rowByIndex.clear();
    const tr = document.createElement('tr');
    const td = createCell('CSVを読み込むと 08:00〜23:00 の時間帯別データを表示します', 'table-empty-cell');
    td.colSpan = activeColumns().length;
    tr.appendChild(td);
    dom['table-body'].appendChild(tr);
  }

  function onRowHover(index) {
    setActiveRow(index);
    HourlyChart.highlightIndex(index);
  }

  function setActiveRow(index) {
    if (state.activeRowIndex !== null && rowByIndex.has(state.activeRowIndex)) {
      rowByIndex.get(state.activeRowIndex).classList.remove('row-active');
    }
    state.activeRowIndex = index;
    if (index !== null && rowByIndex.has(index)) {
      rowByIndex.get(index).classList.add('row-active');
    }
  }

  // ---------------------------------------------------------------------------
  // 操作系
  // ---------------------------------------------------------------------------

  function toggleMetric(chip) {
    const key = chip.dataset.metric;
    if (!Object.prototype.hasOwnProperty.call(state.visibility, key)) return;
    state.visibility[key] = !state.visibility[key];
    chip.setAttribute('aria-pressed', String(state.visibility[key]));
    HourlyChart.setMetricVisibility(key, state.visibility[key]);
    persistCurrentState();
  }

  function toggleTable() {
    const container = dom['table-container'];
    const willShow = container.classList.contains('hidden');
    container.classList.toggle('hidden', !willShow);
    dom['btn-toggle-table'].textContent = willShow ? 'データ一覧を隠す ▲' : 'データ一覧を表示 ▼';
    dom['btn-toggle-table'].setAttribute('aria-expanded', String(willShow));
  }

  function sanitizeFileNamePart(text) {
    return String(text || '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\\/:*?"<>|\u0000-\u001F\u007F]/g, '_')
      .replace(/\s+/g, '_')
      .replace(/…$/, '')
      .slice(0, 40);
  }

  function exportPng() {
    if (!state.primary) return;
    const meta = state.primary.meta;
    const modeTag = state.aggMode === 'avg' ? '_平均' : '_合算';
    const name = ('時間帯別売上_' + sanitizeFileNamePart(meta.isoDate || '日付不明') + '_' + sanitizeFileNamePart(meta.storeName) + modeTag)
      .slice(0, MAX_EXPORT_NAME_LENGTH) + '.png';
    let title = '時間帯別 売上・客数・打数・値引率 ｜ ' + meta.dateLabel + ' ' + meta.storeName;
    if (state.compare) title += '  vs  ' + state.compare.meta.dateLabel + ' ' + state.compare.meta.storeName;
    try {
      HourlyChart.exportImage(name, title);
      showStatus('グラフをPNG画像として保存しました: ' + name, 'success');
    } catch (error) {
      console.error('[HourlySales] export failed', error);
      showStatus('PNG保存に失敗しました。', 'error');
    }
  }

  async function resetAllData() {
    state.rawMainFiles = [];
    state.rawCompareFiles = [];
    state.primary = null;
    state.compare = null;
    state.loadSequence.main++;
    state.loadSequence.compare++;
    state.sort = { key: 'hour', direction: 'asc' };
    state.activeRowIndex = null;
    state.timeBands = JSON.parse(JSON.stringify(DEFAULT_TIME_BANDS));
    updateFilePill('main', null);
    updateFilePill('compare', null);
    renderBandSettingsList();
    updateDashboard();

    if (HourlyStorage) {
      await HourlyStorage.clearState();
    }
    showStatus('読み込んだデータと保存データをすべてリセットしました。', 'info');
  }

  function showStatus(message, type, autoHideMs) {
    const banner = dom['status-message'];
    if (!banner) return;
    const allowed = ['info', 'success', 'error', 'warning'];
    const tone = allowed.includes(type) ? type : 'info';
    banner.textContent = message;
    banner.className = 'status-banner status-' + tone;
    if (state.statusTimerId !== null) {
      clearTimeout(state.statusTimerId);
      state.statusTimerId = null;
    }
    const delay = autoHideMs === undefined ? STATUS_AUTO_HIDE_MS : autoHideMs;
    if (delay > 0) {
      state.statusTimerId = setTimeout(() => {
        banner.classList.add('hidden');
        state.statusTimerId = null;
      }, delay);
    }
  }

  // ---------------------------------------------------------------------------
  // 全画面 / テーマ
  // ---------------------------------------------------------------------------

  function initFullscreen() {
    const button = dom['btn-fullscreen'];
    if (!button) return;
    if (!document.fullscreenEnabled) {
      button.disabled = true;
      button.title = 'このブラウザは全画面表示に対応していません';
      return;
    }
    button.addEventListener('click', async () => {
      try {
        if (document.fullscreenElement) {
          await document.exitFullscreen();
        } else {
          await document.documentElement.requestFullscreen();
        }
      } catch (error) {
        console.error('[HourlySales] fullscreen failed', error);
        showStatus('全画面表示を切り替えられませんでした。', 'error');
      }
    });
    document.addEventListener('fullscreenchange', () => {
      const isFull = Boolean(document.fullscreenElement);
      button.setAttribute('aria-pressed', String(isFull));
      const label = isFull ? '全画面表示を終了' : '全画面表示に切り替え';
      button.setAttribute('aria-label', label);
      button.title = label + 'ます';
    });
  }

  function readStoredTheme() {
    try {
      const stored = global.localStorage.getItem(THEME_STORAGE_KEY);
      return ALLOWED_THEMES.includes(stored) ? stored : 'dark';
    } catch (error) {
      return 'dark';
    }
  }

  function initTheme() {
    applyTheme(readStoredTheme(), false);
  }

  function toggleTheme() {
    const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    try {
      global.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch (error) {}
    applyTheme(next, true);
  }

  function applyTheme(theme, shouldRerender) {
    const safeTheme = ALLOWED_THEMES.includes(theme) ? theme : 'dark';
    document.documentElement.setAttribute('data-theme', safeTheme);
    const button = dom['btn-theme-toggle'];
    if (!button) return;
    const isLight = safeTheme === 'light';
    const label = isLight ? 'ダークモードに切り替え' : 'ライトモードに切り替え';
    button.setAttribute('aria-pressed', String(isLight));
    button.setAttribute('aria-label', label);
    button.title = label + 'ます';
    if (shouldRerender && state.primary) updateDashboard();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})(window);
