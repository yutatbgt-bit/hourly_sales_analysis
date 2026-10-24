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

  const PRIMARY_COMPARE_COLUMNS = Object.freeze([
    { key: 'cmpSales',        label: '売上 分析比', source: 'sales',        mode: 'ratio' },
    { key: 'cmpCustomers',    label: '客数 分析比', source: 'customers',    mode: 'ratio' },
    { key: 'cmpItems',        label: '打数 分析比', source: 'items',        mode: 'ratio' },
    { key: 'cmpDiscountRate', label: '値引率 差',   source: 'discountRate', mode: 'point' }
  ]);

  const state = {
    rawMainFiles: [],     // アップロードされた個別の解析済みデータセット配列
    rawCompareFiles: [],  // 比較スロットのデータセット配列
    aggMode: 'sum',       // 'sum' | 'avg'
    primary: null,        // 集約済みメインデータセット
    compare: null,        // 集約済み比較データセット
    tableView: 'primary', // 'primary' | 'compare' (テーブルに表示する対象)
    timeBands: JSON.parse(JSON.stringify(DEFAULT_TIME_BANDS)),
    visibility: { sales: true, customers: true, items: true, discountRate: true, discount: false },
    sort: { key: 'hour', direction: 'asc' },
    activeRowIndex: null,
    loadSequence: { main: 0, compare: 0 },
    statusTimerId: null,
    profiles: [HourlyStorage ? HourlyStorage.DEFAULT_PROFILE_NAME : 'デフォルト'],
    currentProfile: HourlyStorage ? HourlyStorage.DEFAULT_PROFILE_NAME : 'デフォルト'
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
      'share-bar-compare-container', 'share-bar-compare', 'share-meta-main', 'share-meta-compare',
      'share-legend', 'btn-toggle-band-settings', 'band-settings-panel', 'band-list', 'btn-add-band',
      'btn-close-band-settings', 'table-container', 'table-header-row', 'table-body', 'table-foot',
      'table-main-title', 'table-hint', 'table-view-toggle', 'btn-table-view-primary', 'btn-table-view-compare',
      'kpi-sales-label', 'kpi-customers-label', 'kpi-items-label', 'kpi-peak-split', 'kpi-peak-split-sub',
      'kpi-peak-split-badge',
      'kpi-sales-compare', 'kpi-customers-compare', 'kpi-items-compare',
      'kpi-avg-spend-compare', 'kpi-discount-rate-compare', 'kpi-peak-split-compare',
      'file-manager-dialog', 'file-manager-title', 'file-manager-subtitle', 'btn-close-file-manager',
      'cb-select-all-files', 'btn-delete-selected-files', 'btn-clear-slot-all', 'file-manager-list',
      'btn-add-more-files', 'btn-file-manager-done',
      'select-store-profile', 'btn-add-store-profile', 'btn-rename-store-profile', 'btn-delete-store-profile',
      'profile-dialog', 'profile-dialog-title', 'btn-close-profile-dialog', 'input-profile-name',
      'profile-error-message', 'btn-cancel-profile-dialog', 'btn-save-profile-dialog'
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
    setupFileManagerEvents();
    setupProfileEvents();

    if (dom['btn-mode-sum']) {
      dom['btn-mode-sum'].addEventListener('click', () => setAggMode('sum'));
    }
    if (dom['btn-mode-avg']) {
      dom['btn-mode-avg'].addEventListener('click', () => setAggMode('avg'));
    }

    if (dom['btn-table-view-primary']) {
      dom['btn-table-view-primary'].addEventListener('click', () => setTableView('primary'));
    }
    if (dom['btn-table-view-compare']) {
      dom['btn-table-view-compare'].addEventListener('click', () => setTableView('compare'));
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

    // 店舗プロファイル初期化 (ハッシュまたは保存済みリストから)
    await initProfiles();

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
      renderShareBar(state.primary, state.compare);
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
    await HourlyStorage.saveState(dataToSave, state.currentProfile);
  }

  async function restorePersistedState(targetProfile) {
    if (!HourlyStorage) return;
    try {
      const profileToLoad = targetProfile || state.currentProfile;
      const saved = await HourlyStorage.loadState(profileToLoad);
      if (!saved) {
        state.rawMainFiles = [];
        state.rawCompareFiles = [];
        state.primary = null;
        state.compare = null;
        state.aggMode = 'sum';
        state.activeRowIndex = null;
        state.timeBands = JSON.parse(JSON.stringify(DEFAULT_TIME_BANDS));
        updateFilePill('main', null);
        updateFilePill('compare', null);
        updateAggModeButtons();
        recomputeAggregates();
        updateDashboard();
        return;
      }

      state.rawMainFiles = (Array.isArray(saved.rawMainFiles) && saved.rawMainFiles.length > 0) ? saved.rawMainFiles : [];
      state.rawCompareFiles = (Array.isArray(saved.rawCompareFiles) && saved.rawCompareFiles.length > 0) ? saved.rawCompareFiles : [];
      state.aggMode = (saved.aggMode === 'sum' || saved.aggMode === 'avg') ? saved.aggMode : 'sum';
      state.timeBands = (Array.isArray(saved.timeBands) && saved.timeBands.length > 0) ? saved.timeBands : JSON.parse(JSON.stringify(DEFAULT_TIME_BANDS));
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
      } else {
        updateFilePill('main', null);
      }
      if (state.compare) {
        updateFilePill('compare', state.compare);
      } else {
        updateFilePill('compare', null);
      }
      updateDashboard();
      if (state.primary) {
        showStatus('「' + profileToLoad + '」の保存データを復元しました。', 'info');
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
   * 複数ファイルの非同期読み込み・解析（逐次メモリ解放 & メインスレッド開放型）
   * @param {Array<File>} files
   * @param {'main'|'compare'} slot
   */
  async function handleFiles(files, slot) {
    const csvFiles = files.filter((f) => /\.csv$/i.test(f.name));
    if (csvFiles.length === 0) {
      showStatus('CSVファイル (.csv) を指定してください。', 'error');
      return;
    }

    const totalCount = csvFiles.length;
    const sequence = ++state.loadSequence[slot];
    const isLargeBatch = totalCount >= 8;

    showStatus(totalCount + '件のファイルを読み込み解析中...', 'info', 0);

    const parsedSets = [];
    const errors = [];
    const BATCH_YIELD_INTERVAL = 3; // 3ファイルごとにメインスレッドを開放しGC機会を提供

    for (let i = 0; i < totalCount; i++) {
      if (sequence !== state.loadSequence[slot]) return;

      const file = csvFiles[i];

      // 大量ファイル処理時は進捗を更新し、メインスレッドを開放してUIの固まりとメモリ蓄積を防止
      if (isLargeBatch && (i % BATCH_YIELD_INTERVAL === 0 || i === totalCount - 1)) {
        showStatus('ファイル解析中: ' + (i + 1) + ' / ' + totalCount + '件 (' + Math.round(((i + 1) / totalCount) * 100) + '%)...', 'info', 0);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      if (file.size === 0) {
        errors.push(file.name + ': 空のファイルです');
        continue;
      }
      if (file.size > Parser.MAX_FILE_SIZE_BYTES) {
        errors.push(file.name + ': サイズ超過 (上限5MB)');
        continue;
      }

      try {
        let buffer = await file.arrayBuffer();
        const ds = Parser.parse(buffer, file.name);
        buffer = null; // バイナリバッファの参照を即時破棄してメモリ解放
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

    const existingList = slot === 'main' ? state.rawMainFiles : state.rawCompareFiles;
    let addedCount = 0;
    let updatedCount = 0;

    parsedSets.forEach((newDs) => {
      const existingIdx = existingList.findIndex(
        (oldDs) => oldDs.meta.fileName && oldDs.meta.fileName === newDs.meta.fileName
      );
      if (existingIdx >= 0) {
        existingList[existingIdx] = newDs;
        updatedCount++;
      } else {
        existingList.push(newDs);
        addedCount++;
      }
    });

    recomputeAggregates();
    updateDashboard();
    await persistCurrentState();

    // ファイル管理モーダルが開いていればリストも自動更新
    if (dom['file-manager-dialog'] && dom['file-manager-dialog'].open && activeFileManagerSlot === slot) {
      renderFileManagerList();
      if (dom['file-manager-title']) {
        dom['file-manager-title'].textContent =
          (slot === 'main' ? '分析データ' : '比較データ') + ' ファイル一覧 (' + existingList.length + '件)';
      }
    }

    const targetSet = slot === 'main' ? state.primary : state.compare;
    const slotName = slot === 'main' ? '分析データ' : '比較データ';
    let msg = slotName + 'に ' + parsedSets.length + 'ファイルを読み込みました（合計 ' + existingList.length + '件）: ' + targetSet.meta.dateLabel;
    if (updatedCount > 0 && addedCount > 0) {
      msg += ' （新規追加 ' + addedCount + '件 / 更新 ' + updatedCount + '件）';
    } else if (updatedCount > 0) {
      msg += ' （同名ファイルを更新 ' + updatedCount + '件）';
    } else if (existingList.length > parsedSets.length) {
      msg += ' （追加 ' + addedCount + '件）';
    }
    if (errors.length > 0) {
      msg += ' (※一部スキップ: ' + errors.join(', ') + ')';
      showStatus(msg, 'warning', 0);
    } else {
      showStatus(msg, 'success');
    }
  }

  function updateFilePill(slot, dataSet) {
    const isMain = slot === 'main';
    const pill = dom[isMain ? 'file-name-main' : 'file-name-compare'];
    if (!pill) return;

    if (!dataSet) {
      pill.textContent = isMain ? '分析: 未読込' : '比較: 未読込';
      pill.removeAttribute('title');
      pill.classList.add('hidden');
      return;
    }

    const prefix = isMain ? '分析: ' : '比較: ';
    const countText = dataSet.fileCount > 1 ? ' (' + dataSet.fileCount + '件)' : '';
    pill.textContent = prefix + dataSet.meta.dateLabel + ' ' + dataSet.meta.storeName + countText;
    pill.setAttribute(
      'title',
      (dataSet.fileCount > 1 ? 'クリックしてファイル一覧・個別クリアを開く\n' : 'クリックしてファイル情報を確認\n') +
      (dataSet.sourceFiles ? dataSet.sourceFiles.join('\n') : dataSet.meta.fileName)
    );
    pill.classList.remove('hidden');
  }

  function clearSlot(slot) {
    const isMain = slot === 'main';
    const rawFiles = isMain ? state.rawMainFiles : state.rawCompareFiles;
    if (rawFiles.length === 0) return;

    if (isMain) {
      state.rawMainFiles = [];
      state.primary = null;
    } else {
      state.rawCompareFiles = [];
      state.compare = null;
    }

    recomputeAggregates();
    updateDashboard();
    persistCurrentState();
    showStatus((isMain ? '分析データ' : '比較データ') + 'をクリアしました。', 'info');
  }

  // ---------------------------------------------------------------------------
  // ファイル管理ダイアログ (個別選択・クリア)
  // ---------------------------------------------------------------------------

  let activeFileManagerSlot = 'main';

  function setupFileManagerEvents() {
    if (dom['file-name-main']) {
      dom['file-name-main'].addEventListener('click', () => openFileManager('main'));
    }
    if (dom['file-name-compare']) {
      dom['file-name-compare'].addEventListener('click', () => openFileManager('compare'));
    }
    if (dom['btn-close-file-manager']) {
      dom['btn-close-file-manager'].addEventListener('click', closeFileManager);
    }
    if (dom['btn-file-manager-done']) {
      dom['btn-file-manager-done'].addEventListener('click', closeFileManager);
    }
    if (dom['btn-add-more-files']) {
      dom['btn-add-more-files'].addEventListener('click', () => {
        const input = activeFileManagerSlot === 'main' ? dom['file-input-main'] : dom['file-input-compare'];
        if (input) input.click();
      });
    }
    if (dom['file-manager-dialog']) {
      dom['file-manager-dialog'].addEventListener('click', (e) => {
        if (e.target === dom['file-manager-dialog']) closeFileManager();
      });
      dom['file-manager-dialog'].addEventListener('cancel', closeFileManager);
    }
    if (dom['cb-select-all-files']) {
      dom['cb-select-all-files'].addEventListener('change', (e) => {
        const list = dom['file-manager-list'];
        if (!list) return;
        const boxes = list.querySelectorAll('.file-item-cb');
        boxes.forEach((cb) => { cb.checked = e.target.checked; });
        updateSelectedDeleteButton();
      });
    }
    if (dom['btn-delete-selected-files']) {
      dom['btn-delete-selected-files'].addEventListener('click', removeSelectedFiles);
    }
    if (dom['btn-clear-slot-all']) {
      dom['btn-clear-slot-all'].addEventListener('click', clearSlotFromDialog);
    }
  }

  function openFileManager(slot) {
    const dialog = dom['file-manager-dialog'];
    if (!dialog) return;

    activeFileManagerSlot = slot;
    const isMain = slot === 'main';
    const rawFiles = isMain ? state.rawMainFiles : state.rawCompareFiles;
    if (!Array.isArray(rawFiles) || rawFiles.length === 0) return;

    const titleEl = dom['file-manager-title'];
    const subTitleEl = dom['file-manager-subtitle'];
    if (titleEl) {
      titleEl.textContent = (isMain ? '分析データ' : '比較データ') + ' ファイル一覧 (' + rawFiles.length + '件)';
    }
    if (subTitleEl) {
      subTitleEl.textContent = 'チェックしたファイルの一括削除、または行ごとの個別削除が可能です';
    }

    renderFileManagerList();

    if (dom['cb-select-all-files']) {
      dom['cb-select-all-files'].checked = false;
    }
    updateSelectedDeleteButton();

    if (typeof dialog.showModal === 'function') {
      dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function closeFileManager() {
    const dialog = dom['file-manager-dialog'];
    if (!dialog) return;
    if (typeof dialog.close === 'function') {
      dialog.close();
    } else {
      dialog.removeAttribute('open');
    }
  }

  function renderFileManagerList() {
    const list = dom['file-manager-list'];
    if (!list) return;
    list.replaceChildren();

    const isMain = activeFileManagerSlot === 'main';
    const rawFiles = isMain ? state.rawMainFiles : state.rawCompareFiles;

    if (rawFiles.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'file-manager-empty';
      empty.textContent = 'ファイルはありません。';
      list.appendChild(empty);
      return;
    }

    rawFiles.forEach((ds, index) => {
      const item = document.createElement('div');
      item.className = 'file-manager-item';

      const left = document.createElement('div');
      left.className = 'file-manager-item-left';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'file-item-cb';
      cb.dataset.index = String(index);
      cb.addEventListener('change', updateSelectedDeleteButton);

      const info = document.createElement('div');
      info.className = 'file-item-info';

      const name = document.createElement('div');
      name.className = 'file-item-name';
      name.textContent = ds.meta.fileName || ('ファイル ' + (index + 1));
      name.title = ds.meta.fileName || '';

      const meta = document.createElement('div');
      meta.className = 'file-item-meta';

      if (ds.meta.dateLabel) {
        const spanDate = document.createElement('span');
        spanDate.className = 'file-item-badge';
        spanDate.textContent = ds.meta.dateLabel;
        meta.appendChild(spanDate);
      }
      if (ds.meta.storeName) {
        const spanStore = document.createElement('span');
        spanStore.className = 'file-item-badge';
        spanStore.textContent = ds.meta.storeName;
        meta.appendChild(spanStore);
      }
      if (ds.totals && Fmt.isNum(ds.totals.sales)) {
        const spanSales = document.createElement('span');
        spanSales.className = 'file-item-badge';
        spanSales.textContent = '売上: ' + Fmt.yen(ds.totals.sales);
        meta.appendChild(spanSales);
      }
      if (ds.totals && Fmt.isNum(ds.totals.customers)) {
        const spanCust = document.createElement('span');
        spanCust.className = 'file-item-badge';
        spanCust.textContent = '客数: ' + Fmt.integer(ds.totals.customers, ' 人');
        meta.appendChild(spanCust);
      }

      info.append(name, meta);
      left.append(cb, info);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'btn-remove-single-file';
      removeBtn.textContent = '削除';
      removeBtn.title = (ds.meta.fileName || 'このファイル') + ' を削除';
      removeBtn.addEventListener('click', () => {
        removeSingleFile(index);
      });

      item.append(left, removeBtn);
      list.appendChild(item);
    });
  }

  function updateSelectedDeleteButton() {
    const list = dom['file-manager-list'];
    const deleteBtn = dom['btn-delete-selected-files'];
    if (!list || !deleteBtn) return;

    const checkedBoxes = list.querySelectorAll('.file-item-cb:checked');
    const count = checkedBoxes.length;
    deleteBtn.disabled = count === 0;
    deleteBtn.textContent = count > 0 ? '選択したファイルを削除 (' + count + '件)' : '選択したファイルを削除';
  }

  function removeSingleFile(index) {
    const isMain = activeFileManagerSlot === 'main';
    const rawFiles = isMain ? state.rawMainFiles : state.rawCompareFiles;
    if (index < 0 || index >= rawFiles.length) return;

    const removedName = rawFiles[index].meta.fileName || 'ファイル';
    rawFiles.splice(index, 1);

    recomputeAggregates();
    updateDashboard();
    persistCurrentState();

    if (rawFiles.length === 0) {
      closeFileManager();
      showStatus((isMain ? '分析データ' : '比較データ') + 'のファイルをすべて削除しました。', 'info');
    } else {
      renderFileManagerList();
      if (dom['file-manager-title']) {
        dom['file-manager-title'].textContent =
          (isMain ? '分析データ' : '比較データ') + ' ファイル一覧 (' + rawFiles.length + '件)';
      }
      updateSelectedDeleteButton();
      showStatus(removedName + ' を削除しました。（残り ' + rawFiles.length + '件）', 'info');
    }
  }

  function removeSelectedFiles() {
    const list = dom['file-manager-list'];
    if (!list) return;

    const checkedBoxes = Array.from(list.querySelectorAll('.file-item-cb:checked'));
    if (checkedBoxes.length === 0) return;

    const isMain = activeFileManagerSlot === 'main';
    const rawFiles = isMain ? state.rawMainFiles : state.rawCompareFiles;

    const indicesToDelete = new Set(checkedBoxes.map((cb) => Number(cb.dataset.index)));
    const remaining = rawFiles.filter((_, idx) => !indicesToDelete.has(idx));

    if (isMain) {
      state.rawMainFiles = remaining;
    } else {
      state.rawCompareFiles = remaining;
    }

    recomputeAggregates();
    updateDashboard();
    persistCurrentState();

    const deletedCount = checkedBoxes.length;
    if (remaining.length === 0) {
      closeFileManager();
      showStatus((isMain ? '分析データ' : '比較データ') + 'のファイルをすべて削除しました。', 'info');
    } else {
      renderFileManagerList();
      if (dom['file-manager-title']) {
        dom['file-manager-title'].textContent =
          (isMain ? '分析データ' : '比較データ') + ' ファイル一覧 (' + remaining.length + '件)';
      }
      if (dom['cb-select-all-files']) dom['cb-select-all-files'].checked = false;
      updateSelectedDeleteButton();
      showStatus(deletedCount + '件のファイルを削除しました。（残り ' + remaining.length + '件）', 'info');
    }
  }

  function clearSlotFromDialog() {
    const isMain = activeFileManagerSlot === 'main';
    clearSlot(activeFileManagerSlot);
    closeFileManager();
  }

  // ---------------------------------------------------------------------------
  // 店舗プロファイル管理 (複数店舗同時並行分析 & ストレージ分離)
  // ---------------------------------------------------------------------------

  let profileDialogMode = 'add'; // 'add' | 'rename'

  function getHashProfile() {
    const hash = global.location.hash || '';
    const match = hash.match(/(?:^|[#&])store=([^&]+)/);
    if (match && match[1]) {
      try {
        const decoded = decodeURIComponent(match[1]).trim();
        if (decoded && decoded.length <= 30 && !/[\u0000-\u001F\u007F<>"'&]/.test(decoded)) {
          return decoded;
        }
      } catch (e) {
        // デコード失敗時は無視
      }
    }
    return null;
  }

  function setHashProfile(profileName) {
    if (!profileName) return;
    const newHash = '#store=' + encodeURIComponent(profileName);
    if (global.location.hash !== newHash) {
      global.history.replaceState(null, '', newHash);
    }
  }

  async function initProfiles() {
    if (!HourlyStorage) return;
    try {
      const profiles = await HourlyStorage.getProfiles();
      state.profiles = Array.isArray(profiles) && profiles.length > 0 ? profiles : [HourlyStorage.DEFAULT_PROFILE_NAME];

      const hashStore = getHashProfile();
      if (hashStore) {
        if (!state.profiles.includes(hashStore)) {
          state.profiles.push(hashStore);
          await HourlyStorage.saveProfiles(state.profiles);
        }
        state.currentProfile = hashStore;
      } else {
        state.currentProfile = state.profiles[0] || HourlyStorage.DEFAULT_PROFILE_NAME;
        setHashProfile(state.currentProfile);
      }

      renderProfileSelect();
    } catch (e) {
      console.warn('[HourlySales] failed to init profiles:', e);
    }
  }

  function renderProfileSelect() {
    const select = dom['select-store-profile'];
    if (!select) return;
    select.replaceChildren();

    state.profiles.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p;
      opt.textContent = p;
      if (p === state.currentProfile) {
        opt.selected = true;
      }
      select.appendChild(opt);
    });
  }

  function setupProfileEvents() {
    const select = dom['select-store-profile'];
    if (select) {
      select.addEventListener('change', async () => {
        const nextProfile = select.value;
        if (nextProfile === state.currentProfile) return;
        await persistCurrentState();
        state.currentProfile = nextProfile;
        setHashProfile(state.currentProfile);
        await restorePersistedState();
        renderBandSettingsList();
        showStatus('店舗プロファイルを「' + state.currentProfile + '」に切り替えました。', 'info');
      });
    }

    if (dom['btn-add-store-profile']) {
      dom['btn-add-store-profile'].addEventListener('click', () => openProfileDialog('add'));
    }
    if (dom['btn-rename-store-profile']) {
      dom['btn-rename-store-profile'].addEventListener('click', () => openProfileDialog('rename'));
    }
    if (dom['btn-delete-store-profile']) {
      dom['btn-delete-store-profile'].addEventListener('click', handleDeleteProfile);
    }

    if (dom['btn-close-profile-dialog']) {
      dom['btn-close-profile-dialog'].addEventListener('click', closeProfileDialog);
    }
    if (dom['btn-cancel-profile-dialog']) {
      dom['btn-cancel-profile-dialog'].addEventListener('click', closeProfileDialog);
    }
    if (dom['btn-save-profile-dialog']) {
      dom['btn-save-profile-dialog'].addEventListener('click', handleSaveProfile);
    }

    const input = dom['input-profile-name'];
    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleSaveProfile();
        } else if (e.key === 'Escape') {
          closeProfileDialog();
        }
      });
    }

    const dialog = dom['profile-dialog'];
    if (dialog) {
      dialog.addEventListener('click', (e) => {
        if (e.target === dialog) closeProfileDialog();
      });
      dialog.addEventListener('cancel', closeProfileDialog);
    }

    global.addEventListener('hashchange', async () => {
      const hashStore = getHashProfile();
      if (hashStore && hashStore !== state.currentProfile) {
        if (!state.profiles.includes(hashStore)) {
          state.profiles.push(hashStore);
          if (HourlyStorage) await HourlyStorage.saveProfiles(state.profiles);
        }
        await persistCurrentState();
        state.currentProfile = hashStore;
        renderProfileSelect();
        await restorePersistedState();
        renderBandSettingsList();
      }
    });
  }

  function openProfileDialog(mode) {
    profileDialogMode = mode;
    const dialog = dom['profile-dialog'];
    const title = dom['profile-dialog-title'];
    const input = dom['input-profile-name'];
    const err = dom['profile-error-message'];
    if (!dialog || !input) return;

    if (err) {
      err.textContent = '';
      err.classList.add('hidden');
    }

    if (mode === 'add') {
      if (title) title.textContent = '新規店舗プロファイルを追加';
      input.value = '';
    } else {
      if (title) title.textContent = '店舗プロファイル名を変更';
      input.value = state.currentProfile;
    }

    if (typeof dialog.showModal === 'function') {
      dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
    input.focus();
  }

  function closeProfileDialog() {
    const dialog = dom['profile-dialog'];
    if (!dialog) return;
    if (typeof dialog.close === 'function') {
      dialog.close();
    } else {
      dialog.removeAttribute('open');
    }
  }

  async function handleSaveProfile() {
    const input = dom['input-profile-name'];
    if (!input) return;

    const rawName = input.value.trim();
    if (!rawName) {
      showProfileError('店舗名を入力してください。');
      return;
    }
    if (rawName.length > 30) {
      showProfileError('店舗名は30文字以内で入力してください。');
      return;
    }
    if (/[\u0000-\u001F\u007F<>"'&]/.test(rawName)) {
      showProfileError('店舗名に使用できない文字が含まれています。');
      return;
    }

    if (profileDialogMode === 'add') {
      if (state.profiles.includes(rawName)) {
        showProfileError('同名の店舗プロファイルが既に存在します。');
        return;
      }
      await persistCurrentState();
      state.profiles.push(rawName);
      if (HourlyStorage) await HourlyStorage.saveProfiles(state.profiles);
      state.currentProfile = rawName;
      setHashProfile(state.currentProfile);
      renderProfileSelect();
      closeProfileDialog();
      await restorePersistedState();
      renderBandSettingsList();
      showStatus('店舗プロファイル「' + rawName + '」を追加しました。', 'success');
    } else {
      const oldName = state.currentProfile;
      if (rawName === oldName) {
        closeProfileDialog();
        return;
      }
      if (state.profiles.includes(rawName)) {
        showProfileError('同名の店舗プロファイルが既に存在します。');
        return;
      }
      await persistCurrentState();
      if (HourlyStorage) {
        const currentData = await HourlyStorage.loadState(oldName);
        if (currentData) {
          await HourlyStorage.saveState(currentData, rawName);
        }
        await HourlyStorage.deleteProfile(oldName);
      }
      const idx = state.profiles.indexOf(oldName);
      if (idx !== -1) {
        state.profiles[idx] = rawName;
      } else {
        state.profiles.push(rawName);
      }
      if (HourlyStorage) await HourlyStorage.saveProfiles(state.profiles);
      state.currentProfile = rawName;
      setHashProfile(state.currentProfile);
      renderProfileSelect();
      closeProfileDialog();
      showStatus('店舗プロファイル名を「' + rawName + '」に変更しました。', 'success');
    }
  }

  function showProfileError(msg) {
    const err = dom['profile-error-message'];
    if (!err) return;
    err.textContent = msg;
    err.classList.remove('hidden');
  }

  async function handleDeleteProfile() {
    if (state.profiles.length <= 1) {
      showStatus('これ以上店舗プロファイルを削除できません（最低1店舗必要です）。', 'warning');
      return;
    }
    const targetName = state.currentProfile;
    const confirmed = global.confirm('店舗プロファイル「' + targetName + '」を削除しますか？\n（この店舗の保存データも消去されます）');
    if (!confirmed) return;

    if (HourlyStorage) {
      await HourlyStorage.deleteProfile(targetName);
    }
    state.profiles = state.profiles.filter((p) => p !== targetName);
    state.currentProfile = state.profiles[0] || (HourlyStorage ? HourlyStorage.DEFAULT_PROFILE_NAME : 'デフォルト');
    setHashProfile(state.currentProfile);
    renderProfileSelect();
    await restorePersistedState();
    renderBandSettingsList();
    showStatus('店舗プロファイル「' + targetName + '」を削除しました。', 'info');
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

    if (dom['table-view-toggle']) {
      dom['table-view-toggle'].classList.toggle('hidden', !compare);
    }
    if (!compare && state.tableView !== 'primary') {
      state.tableView = 'primary';
      if (dom['btn-table-view-primary']) dom['btn-table-view-primary'].classList.add('active');
      if (dom['btn-table-view-compare']) dom['btn-table-view-compare'].classList.remove('active');
      if (dom['table-main-title']) dom['table-main-title'].textContent = '時間帯別 実績一覧';
    }

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
    renderShareBar(primary, compare);
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

  function setCompareText(id, text) {
    const node = document.getElementById(id);
    if (!node) return;
    node.replaceChildren();
    if (!text) {
      node.classList.add('hidden');
      return;
    }
    const tag = document.createElement('span');
    tag.className = 'kpi-compare-tag';
    tag.textContent = '[比較]';
    const val = document.createElement('span');
    val.className = 'kpi-compare-num';
    val.textContent = ' ' + text;
    node.append(tag, val);
    node.classList.remove('hidden');
  }

  function hideCompareText(id) {
    const node = document.getElementById(id);
    if (!node) return;
    node.replaceChildren();
    node.classList.add('hidden');
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

    // 比較バッジおよび比較数値 (1〜5)
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

      // 比較データの実績数値を表示
      setCompareText('kpi-sales-compare', Fmt.yen(c.sales));
      setCompareText('kpi-customers-compare', Fmt.integer(c.customers, ' 人'));
      setCompareText('kpi-items-compare', Fmt.integer(c.items, ' 打数'));
      setCompareText('kpi-avg-spend-compare', '客単価: ' + Fmt.yen(c.avgSpend) + ' ／ 一品: ' + Fmt.yen(c.avgItemPrice));
      setCompareText('kpi-discount-rate-compare', '値引率: ' + Fmt.percent(c.discountRate) + '（' + Fmt.yen(c.discount) + '）');
    } else {
      ['kpi-sales-badge', 'kpi-customers-badge', 'kpi-items-badge', 'kpi-price-badge', 'kpi-discount-rate-badge']
        .forEach((id) => renderBadge(id, null, null));
      ['kpi-sales-compare', 'kpi-customers-compare', 'kpi-items-compare', 'kpi-avg-spend-compare', 'kpi-discount-rate-compare']
        .forEach(hideCompareText);
    }

    // スパークライン（比較データがある場合は点線で重ねて描画）
    const hasCompare = Boolean(compare);
    const series = (key) => primary.slots.map((s) => (s.hasData ? s[key] : null));
    const cSeries = (key) => (hasCompare ? compare.slots.map((s) => (s.hasData ? s[key] : null)) : null);

    HourlyChart.renderSparkline(document.getElementById('spark-sales'), series('sales'), 'sales', cSeries('sales'));
    HourlyChart.renderSparkline(document.getElementById('spark-customers'), series('customers'), 'customers', cSeries('customers'));
    HourlyChart.renderSparkline(document.getElementById('spark-items'), series('items'), 'items', cSeries('items'));
    HourlyChart.renderSparkline(document.getElementById('spark-discount-rate'), series('discountRate'), 'discountRate', cSeries('discountRate'));

    // スパークラインのミニ凡例表示制御
    ['spark-sales-legend', 'spark-customers-legend', 'spark-items-legend', 'spark-discount-rate-legend'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('hidden', !hasCompare);
    });
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
      hideCompareText('kpi-peak-split-compare');
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

    let cBandStats = null;
    if (compare && compare.totals.sales > 0 && bandStats.length > 0) {
      const cTotal = compare.totals.sales;
      cBandStats = activeBands.map((b) => {
        const sales = compare.slots
          .filter((s) => s.hasData && s.hour >= b.from && s.hour <= b.to)
          .reduce((acc, s) => acc + (s.sales ?? 0), 0);
        const share = cTotal > 0 ? (sales / cTotal) * 100 : 0;
        return { band: b, sales, share };
      });
      const cTextVal = cBandStats.map((st) => st.band.name + ' ' + st.share.toFixed(1) + '%').join(' ／ ');
      setCompareText('kpi-peak-split-compare', cTextVal);

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
      hideCompareText('kpi-peak-split-compare');
      renderBadge('kpi-peak-split-badge', null, null);
    }

    // 時間帯区分に色分けした横棒グラフ（スパークライン）を描画（比較データがある場合は上下2段）
    HourlyChart.renderBandSparkline(document.getElementById('spark-peak-split'), bandStats, cBandStats);
    const peakLegendEl = document.getElementById('spark-peak-split-legend');
    if (peakLegendEl) peakLegendEl.classList.toggle('hidden', !cBandStats);
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
    ['kpi-sales-compare', 'kpi-customers-compare', 'kpi-items-compare', 'kpi-avg-spend-compare', 'kpi-discount-rate-compare', 'kpi-peak-split-compare']
      .forEach(hideCompareText);
    ['spark-sales-legend', 'spark-customers-legend', 'spark-items-legend', 'spark-discount-rate-legend', 'spark-peak-split-legend']
      .forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.classList.add('hidden');
      });
    HourlyChart.renderBandSparkline(document.getElementById('spark-peak-split'), []);
  }

  function renderShareBar(primary, compare) {
    const total = primary.totals.sales;
    dom['share-bar'].replaceChildren();
    if (dom['share-bar-compare']) dom['share-bar-compare'].replaceChildren();
    dom['share-legend'].replaceChildren();
    if (dom['share-meta-main']) dom['share-meta-main'].textContent = '';
    if (dom['share-meta-compare']) dom['share-meta-compare'].textContent = '';

    if (!Fmt.isNum(total) || total <= 0) return;

    const activeBands = state.timeBands.filter((b) => b.enabled);
    if (activeBands.length === 0) {
      const msg = document.createElement('div');
      msg.className = 'share-legend-item';
      msg.textContent = '※表示対象の時間帯区分が選択されていません。「時間帯区分を設定」から区分を有効にしてください。';
      dom['share-legend'].appendChild(msg);
      if (dom['share-bar-compare-container']) dom['share-bar-compare-container'].classList.add('hidden');
      return;
    }

    // 分析データメタ情報
    if (dom['share-meta-main']) {
      dom['share-meta-main'].textContent =
        primary.meta.dateLabel + ' ' + primary.meta.storeName + ' （売上合計: ' + Fmt.yen(total) + '）';
    }

    // 分析データバー構築
    const primaryBandData = activeBands.map((band) => {
      const sales = primary.slots
        .filter((s) => s.hasData && s.hour >= band.from && s.hour <= band.to)
        .reduce((acc, s) => acc + (s.sales ?? 0), 0);
      const share = (sales / total) * 100;
      return { band, sales, share };
    });

    primaryBandData.forEach(({ band, sales, share }) => {
      const segment = document.createElement('div');
      segment.className = 'share-segment';
      segment.style.backgroundColor = band.color || '#38bdf8';
      segment.style.setProperty('--share', share.toFixed(2));
      segment.textContent = share >= 6 ? share.toFixed(1) + '%' : '';
      const rangeText = String(band.from).padStart(2, '0') + ':00〜' + String(band.to).padStart(2, '0') + ':00';
      segment.setAttribute('title', '【分析】' + band.name + ' (' + rangeText + '): ' + Fmt.yen(sales) + '（' + share.toFixed(1) + '%）');
      dom['share-bar'].appendChild(segment);
    });

    // 比較データが存在するか確認
    const hasCompare = !!(compare && compare.totals.sales > 0);
    let compareBandData = null;

    if (hasCompare) {
      const cTotal = compare.totals.sales;
      if (dom['share-meta-compare']) {
        dom['share-meta-compare'].textContent =
          compare.meta.dateLabel + ' ' + compare.meta.storeName + ' （売上合計: ' + Fmt.yen(cTotal) + '）';
      }

      compareBandData = activeBands.map((band) => {
        const sales = compare.slots
          .filter((s) => s.hasData && s.hour >= band.from && s.hour <= band.to)
          .reduce((acc, s) => acc + (s.sales ?? 0), 0);
        const share = cTotal > 0 ? (sales / cTotal) * 100 : 0;
        return { band, sales, share };
      });

      if (dom['share-bar-compare']) {
        compareBandData.forEach(({ band, sales, share }) => {
          const segment = document.createElement('div');
          segment.className = 'share-segment';
          segment.style.backgroundColor = band.color || '#38bdf8';
          segment.style.setProperty('--share', share.toFixed(2));
          segment.textContent = share >= 6 ? share.toFixed(1) + '%' : '';
          const rangeText = String(band.from).padStart(2, '0') + ':00〜' + String(band.to).padStart(2, '0') + ':00';
          segment.setAttribute('title', '【比較】' + band.name + ' (' + rangeText + '): ' + Fmt.yen(sales) + '（' + share.toFixed(1) + '%）');
          dom['share-bar-compare'].appendChild(segment);
        });
      }

      if (dom['share-bar-compare-container']) {
        dom['share-bar-compare-container'].classList.remove('hidden');
      }
    } else {
      if (dom['share-bar-compare-container']) {
        dom['share-bar-compare-container'].classList.add('hidden');
      }
    }

    // 凡例生成（比較データがある場合は分析 vs 比較の構成比と比率差を表示）
    primaryBandData.forEach((pData, idx) => {
      const band = pData.band;
      const rangeText = String(band.from).padStart(2, '0') + ':00〜' + String(band.to).padStart(2, '0') + ':00';
      const legend = document.createElement('span');
      legend.className = 'share-legend-item';

      const swatch = document.createElement('span');
      swatch.className = 'share-swatch';
      swatch.style.backgroundColor = band.color || '#38bdf8';

      const label = document.createElement('span');
      label.className = 'share-legend-label';
      label.textContent = band.name + ' (' + rangeText + '): ';

      const valMain = document.createElement('strong');
      valMain.className = 'share-legend-val';
      valMain.textContent = Fmt.yen(pData.sales) + '（' + pData.share.toFixed(1) + '%）';

      legend.append(swatch, label, valMain);

      if (hasCompare && compareBandData && compareBandData[idx]) {
        const cData = compareBandData[idx];
        const diffPt = pData.share - cData.share;
        const diffSpan = document.createElement('span');
        diffSpan.className = 'share-legend-diff';
        diffSpan.style.marginLeft = '6px';
        diffSpan.style.fontSize = '12px';
        diffSpan.style.color = 'var(--text-muted, #64748b)';

        const diffSign = diffPt > 0 ? '+' : '';
        const diffColor = Math.abs(diffPt) < 0.05 ? 'inherit' : (diffPt > 0 ? '#10b981' : '#ef4444');
        diffSpan.textContent = ' [比較: ' + Fmt.yen(cData.sales) + ' (' + cData.share.toFixed(1) + '%) / 差: ';

        const diffVal = document.createElement('span');
        diffVal.style.color = diffColor;
        diffVal.style.fontWeight = '600';
        diffVal.textContent = diffSign + diffPt.toFixed(1) + 'pt';

        const closeParen = document.createTextNode(']');
        diffSpan.append(diffVal, closeParen);
        legend.appendChild(diffSpan);
      }

      dom['share-legend'].appendChild(legend);
    });
  }

  // ---------------------------------------------------------------------------
  // テーブル
  // ---------------------------------------------------------------------------

  function setTableView(view) {
    if (state.tableView === view) return;
    state.tableView = view;
    if (dom['btn-table-view-primary']) {
      dom['btn-table-view-primary'].classList.toggle('active', view === 'primary');
    }
    if (dom['btn-table-view-compare']) {
      dom['btn-table-view-compare'].classList.toggle('active', view === 'compare');
    }
    if (dom['table-main-title']) {
      dom['table-main-title'].textContent = view === 'compare' ? '時間帯別 実績一覧（比較データ）' : '時間帯別 実績一覧（分析データ）';
    }
    renderTableHeader();
    renderTable();
  }

  function activeColumns() {
    if (!state.compare || !state.primary) return TABLE_COLUMNS;
    return state.tableView === 'compare'
      ? TABLE_COLUMNS.concat(PRIMARY_COMPARE_COLUMNS)
      : TABLE_COLUMNS.concat(COMPARE_COLUMNS);
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

  function compareValue(slot, col, otherSlot) {
    if (!col.source) return slot[col.key];
    if (!otherSlot || !otherSlot.hasData || !slot.hasData) return null;
    return col.mode === 'ratio'
      ? Fmt.ratio(slot[col.source], otherSlot[col.source])
      : Fmt.pointDiff(slot[col.source], otherSlot[col.source]);
  }

  function sortedSlotIndexes() {
    const isCompareView = state.tableView === 'compare' && state.compare;
    const currentDS = isCompareView ? state.compare : state.primary;
    const otherDS = isCompareView ? state.primary : state.compare;
    const col = activeColumns().find((c) => c.key === state.sort.key) || TABLE_COLUMNS[0];
    const indexes = currentDS.slots.map((_, i) => i);
    if (col.key === 'hour') {
      return state.sort.direction === 'asc' ? indexes : indexes.reverse();
    }
    const valueOf = (i) => compareValue(currentDS.slots[i], col, otherDS ? otherDS.slots[i] : null);
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
    const isCompareView = state.tableView === 'compare' && compare;
    const currentDS = isCompareView ? compare : primary;
    const otherDS = isCompareView ? primary : compare;
    const cmpCols = isCompareView ? PRIMARY_COMPARE_COLUMNS : COMPARE_COLUMNS;

    const body = dom['table-body'];
    if (!body) return;
    body.replaceChildren();
    rowByIndex.clear();

    const maxima = {};
    TABLE_COLUMNS.forEach((col) => { if (col.heat) maxima[col.key] = columnMax(currentDS.slots, col.key); });
    const peakSalesIndex = currentDS.totals.peak.sales ? currentDS.totals.peak.sales.index : null;

    sortedSlotIndexes().forEach((index) => {
      const slot = currentDS.slots[index];
      const otherSlot = otherDS ? otherDS.slots[index] : null;
      const tr = document.createElement('tr');
      tr.dataset.index = String(index);
      tr.tabIndex = 0;
      if (!slot.hasData) tr.classList.add('row-empty');

      const timeCell = createCell(slot.label, 'td-time');
      if (index === peakSalesIndex) {
        const mark = document.createElement('span');
        mark.className = 'peak-mark';
        mark.textContent = 'PEAK';
        mark.setAttribute('title', (isCompareView ? '比較' : '分析') + '売上ピーク時間帯');
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

      if (otherDS) {
        cmpCols.forEach((col, i) => {
          const td = cmpCell(compareValue(slot, col, otherSlot), col);
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

    renderTableFooter(currentDS, otherDS, cmpCols);
  }

  function renderTableFooter(currentDS, otherDS, cmpCols) {
    const foot = dom['table-foot'];
    if (!foot) return;
    foot.replaceChildren();
    const t = currentDS.totals;
    const lastActive = currentDS.slots.filter((s) => s.hasData).pop();

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
    if (otherDS && cmpCols) {
      const c = otherDS.totals;
      cmpCols.forEach((col, i) => {
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
      await HourlyStorage.clearState(state.currentProfile);
    }
    showStatus('「' + state.currentProfile + '」の読み込みデータと保存データをリセットしました。', 'info');
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
