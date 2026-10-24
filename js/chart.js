/**
 * chart.js
 * Chart.js による時間帯別グラフ描画モジュール。
 *
 * - メイン複合グラフ: 売上(棒) / 客数・打数・値引率(折れ線) / 値引金額(棒・任意)
 * - 比較データは同系色の淡色・破線で重ね描き
 * - 累計値はグラフ化せず、カスタムツールチップ (DOM API のみで構築) に表示
 * - KPI カード用スパークライン
 */
(function (global) {
  'use strict';

  const Fmt = global.Fmt;

  /** 指標定義。色は CSS 変数から取得してテーマ切替に追従させる */
  const METRICS = Object.freeze({
    sales:        { label: '売上',     type: 'bar',  axis: 'ySales',     colorVar: '--accent-blue',   pointStyle: 'rect',     order: 10 },
    discount:     { label: '値引金額', type: 'bar',  axis: 'ySales',     colorVar: '--accent-amber',  pointStyle: 'rect',     order: 11 },
    customers:    { label: '客数',     type: 'line', axis: 'yCustomers', colorVar: '--accent-green',  pointStyle: 'circle',   order: 2 },
    items:        { label: '打数',     type: 'line', axis: 'yItems',     colorVar: '--accent-purple', pointStyle: 'triangle', order: 3 },
    discountRate: { label: '値引率',   type: 'line', axis: 'yRate',      colorVar: '--accent-rose',   pointStyle: 'rectRot',  order: 1 }
  });

  const METRIC_ORDER = Object.freeze(['sales', 'discount', 'customers', 'items', 'discountRate']);
  const FONT_NUM = "'Outfit', 'Inter', sans-serif";
  const TOOLTIP_OFFSET_X = 28;
  const TOOLTIP_OFFSET_Y = 18;
  const EXPORT_HEADER_PX = 64;

  let mainChart = null;
  const sparkCharts = new Map();

  /** ツールチップ・ハイライト用に描画中のデータを保持 */
  const renderState = {
    primary: null,
    compare: null,
    tooltipElement: null,
    lastTooltipKey: null,
    highlightIndex: null,
    onIndexHover: null
  };

  // ---------------------------------------------------------------------------
  // テーマ
  // ---------------------------------------------------------------------------

  function readTheme() {
    const styles = getComputedStyle(document.documentElement);
    const v = (name) => styles.getPropertyValue(name).trim();
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    const colors = {};
    METRIC_ORDER.forEach((key) => { colors[key] = v(METRICS[key].colorVar); });
    return {
      isLight,
      colors,
      textMuted: v('--text-muted'),
      textMain: v('--text-main'),
      primary: v('--primary'),
      bg: isLight ? '#ffffff' : v('--bg-color'),
      grid: isLight ? 'rgba(15, 23, 42, 0.07)' : 'rgba(255, 255, 255, 0.06)',
      pointBorder: isLight ? '#ffffff' : '#070d19',
      highlight: isLight ? 'rgba(180, 83, 9, 0.08)' : 'rgba(212, 175, 55, 0.09)'
    };
  }

  /** #rrggbb → rgba(r,g,b,a) */
  function withAlpha(hex, alpha) {
    const match = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!match) return hex;
    const int = parseInt(match[1], 16);
    return 'rgba(' + ((int >> 16) & 255) + ', ' + ((int >> 8) & 255) + ', ' + (int & 255) + ', ' + alpha + ')';
  }

  // ---------------------------------------------------------------------------
  // データセット生成
  // ---------------------------------------------------------------------------

  function buildDataset(metricKey, dataSet, series, theme, visible, hasCompare) {
    const def = METRICS[metricKey];
    const color = theme.colors[metricKey];
    const isCompare = series === 'compare';
    const values = dataSet.slots.map((slot) => (slot.hasData ? slot[metricKey] : null));
    const seriesSuffix = hasCompare ? (isCompare ? '（比較）' : '（分析）') : '';

    const common = {
      label: def.label + seriesSuffix,
      data: values,
      yAxisID: def.axis,
      hidden: !visible,
      metricKey,
      series,
      pointStyle: def.pointStyle
    };

    if (def.type === 'bar') {
      return Object.assign(common, {
        type: 'bar',
        backgroundColor: withAlpha(color, isCompare ? 0.18 : (metricKey === 'sales' ? 0.62 : 0.55)),
        hoverBackgroundColor: withAlpha(color, isCompare ? 0.32 : 0.85),
        borderColor: withAlpha(color, isCompare ? 0.6 : 1),
        borderWidth: isCompare ? { top: 1.5, left: 1, right: 1, bottom: 0 } : 1.5,
        borderDash: isCompare ? [4, 3] : [],
        borderRadius: { topLeft: 5, topRight: 5 },
        borderSkipped: 'bottom',
        barPercentage: hasCompare ? 0.92 : (metricKey === 'sales' ? 0.68 : 0.4),
        categoryPercentage: 0.78,
        order: def.order + (isCompare ? 1 : 0)
      });
    }

    return Object.assign(common, {
      type: 'line',
      borderColor: isCompare ? withAlpha(color, 0.55) : color,
      backgroundColor: isCompare ? withAlpha(color, 0.55) : color,
      borderWidth: isCompare ? 1.8 : 2.8,
      borderDash: isCompare ? [6, 5] : [],
      pointRadius: isCompare ? 2.5 : 4,
      pointHoverRadius: isCompare ? 5 : 7.5,
      pointBackgroundColor: isCompare ? withAlpha(color, 0.55) : color,
      pointBorderColor: theme.pointBorder,
      pointBorderWidth: isCompare ? 1 : 2,
      tension: 0.3,
      // 欠損(営業時間外)は線を繋がず途切れさせ、0 との誤認を防ぐ
      spanGaps: false,
      order: def.order + (isCompare ? 5 : 0)
    });
  }

  function buildScales(theme) {
    const tickFont = { family: FONT_NUM, size: 11 };
    const axisTitle = (text, color) => ({ display: true, text, color, font: { size: 12, weight: '600' } });
    return {
      x: {
        grid: { display: false },
        ticks: { color: theme.textMuted, font: { family: FONT_NUM, size: 12, weight: '600' } },
        title: axisTitle('時間帯', theme.textMuted)
      },
      ySales: {
        type: 'linear',
        position: 'left',
        beginAtZero: true,
        display: 'auto',
        title: axisTitle('売上 / 値引 (千円)', theme.colors.sales),
        ticks: {
          color: theme.colors.sales,
          font: tickFont,
          callback: (val) => (Fmt.isNum(val) ? Number(Math.round(val / 1000)).toLocaleString() : '')
        },
        grid: { color: theme.grid }
      },
      yCustomers: {
        type: 'linear',
        position: 'right',
        beginAtZero: true,
        display: 'auto',
        title: axisTitle('客数 (人)', theme.colors.customers),
        ticks: { color: theme.colors.customers, font: tickFont, callback: (val) => Fmt.integer(val) },
        grid: { drawOnChartArea: false }
      },
      yItems: {
        type: 'linear',
        position: 'right',
        beginAtZero: true,
        display: 'auto',
        title: axisTitle('打数 (打数)', theme.colors.items),
        ticks: { color: theme.colors.items, font: tickFont, callback: (val) => Fmt.integer(val) },
        grid: { drawOnChartArea: false }
      },
      yRate: {
        type: 'linear',
        position: 'right',
        beginAtZero: true,
        display: 'auto',
        title: axisTitle('値引率 (%)', theme.colors.discountRate),
        ticks: { color: theme.colors.discountRate, font: tickFont, callback: (val) => Number(val).toFixed(1) + '%' },
        grid: { drawOnChartArea: false }
      }
    };
  }

  /** ホバー中 / 表と連動中の時間帯を縦帯でハイライトするプラグイン */
  function createHighlightPlugin(theme) {
    return {
      id: 'hourHighlight',
      beforeDatasetsDraw(chart) {
        const index = renderState.highlightIndex;
        if (index === null || index === undefined) return;
        const xScale = chart.scales.x;
        const area = chart.chartArea;
        const slotWidth = area.width / chart.data.labels.length;
        const centerX = xScale.getPixelForValue(index);
        const ctx = chart.ctx;
        ctx.save();
        ctx.fillStyle = theme.highlight;
        ctx.fillRect(centerX - slotWidth / 2, area.top, slotWidth, area.bottom - area.top);
        ctx.restore();
      }
    };
  }

  // ---------------------------------------------------------------------------
  // カスタムツールチップ (DOM API のみ。innerHTML 不使用)
  // ---------------------------------------------------------------------------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  /**
   * @param {'up'|'down'|null} goodDirection 比較で「増加が良い」なら 'up'
   */
  function diffNode(text, numericDiff, goodDirection) {
    const node = el('span', 'tip-diff', text);
    if (Fmt.isNum(numericDiff) && numericDiff !== 0 && goodDirection) {
      const isUp = numericDiff > 0;
      const isGood = goodDirection === 'up' ? isUp : !isUp;
      node.classList.add(isGood ? 'text-diff-up' : 'text-diff-down');
    } else {
      node.classList.add('text-diff-neutral');
    }
    return node;
  }

  function tipRow(dotClass, label, valueText, diff) {
    const row = el('div', 'tip-row');
    row.appendChild(el('span', 'tip-dot ' + dotClass));
    row.appendChild(el('span', 'tip-label', label));
    row.appendChild(el('span', 'tip-value', valueText));
    row.appendChild(diff || el('span', 'tip-diff'));
    return row;
  }

  function buildTooltipContent(index, targetSeries) {
    const isCompare = targetSeries === 'compare' && renderState.compare;
    const activeDS = isCompare ? renderState.compare : renderState.primary;
    const baselineDS = isCompare ? renderState.primary : renderState.compare;

    const activeSlot = activeDS.slots[index];
    const baselineSlot = baselineDS ? baselineDS.slots[index] : null;
    const fragment = document.createDocumentFragment();

    const title = el('div', 'tip-title');
    const titleLeft = el('div', 'tip-title-left');

    if (renderState.compare) {
      const badgeClass = isCompare ? 'tip-badge-compare' : 'tip-badge-main';
      const badgeText = isCompare ? '比較データ' : '分析データ';
      titleLeft.appendChild(el('span', 'tip-series-badge ' + badgeClass, badgeText));
    }
    titleLeft.appendChild(el('span', null, activeSlot.label + ' 台'));
    title.appendChild(titleLeft);

    title.appendChild(el('span', 'tip-title-sub', activeDS.meta.dateLabel + ' ' + activeDS.meta.storeName));
    fragment.appendChild(title);

    if (!activeSlot.hasData) {
      fragment.appendChild(el('div', 'tip-label', 'この時間帯のデータはありません（営業時間外）'));
      return fragment;
    }

    const hasBase = Boolean(baselineSlot && baselineSlot.hasData);
    const ratioDiff = (key) => {
      if (!hasBase) return null;
      const r = Fmt.ratio(activeSlot[key], baselineSlot[key]);
      const prefix = isCompare ? '分析比 ' : '比較比 ';
      return diffNode(prefix + Fmt.ratioText(r), Fmt.isNum(r) ? r - 100 : null, 'up');
    };
    const rateDiff = (key) => {
      if (!hasBase) return null;
      const d = Fmt.pointDiff(activeSlot[key], baselineSlot[key]);
      const prefix = isCompare ? '分析差 ' : '比較差 ';
      return diffNode(prefix + Fmt.pointText(d), d, 'down');
    };

    const sectionTitle = hasBase
      ? (isCompare ? '時間帯実績（右: 対 分析比）' : '時間帯実績（右: 対 比較比）')
      : '時間帯実績';
    fragment.appendChild(el('div', 'tip-section-label', sectionTitle));
    fragment.appendChild(tipRow('dot-sales', '売上', Fmt.yen(activeSlot.sales), ratioDiff('sales')));
    fragment.appendChild(tipRow('dot-customers', '客数', Fmt.integer(activeSlot.customers, ' 人'), ratioDiff('customers')));
    fragment.appendChild(tipRow('dot-items', '打数', Fmt.integer(activeSlot.items, ' 打数'), ratioDiff('items')));
    fragment.appendChild(tipRow('dot-discount-rate', '値引率', Fmt.percent(activeSlot.discountRate), rateDiff('discountRate')));
    fragment.appendChild(tipRow('dot-discount', '値引金額', Fmt.yen(activeSlot.discount), ratioDiff('discount')));
    fragment.appendChild(tipRow('dot-derived', '客単価', Fmt.yen(activeSlot.avgSpend), ratioDiff('avgSpend')));
    fragment.appendChild(tipRow('dot-derived', '一品単価', Fmt.yen(activeSlot.avgItemPrice), ratioDiff('avgItemPrice')));

    const firstLabel = activeDS.totals.firstLabel || activeSlot.label;
    fragment.appendChild(el('div', 'tip-section-label', '累計（' + firstLabel + ' 〜 ' + activeSlot.label + ' 台）'));
    fragment.appendChild(tipRow('dot-cum', '売上累計', Fmt.yen(activeSlot.cumSales), ratioDiff('cumSales')));
    fragment.appendChild(tipRow('dot-cum', '客数累計', Fmt.integer(activeSlot.cumCustomers, ' 人'), ratioDiff('cumCustomers')));
    fragment.appendChild(tipRow('dot-cum', '打数累計', Fmt.integer(activeSlot.cumItems, ' 打数'), ratioDiff('cumItems')));
    fragment.appendChild(tipRow('dot-cum', '値引累計', Fmt.yen(activeSlot.cumDiscount), ratioDiff('cumDiscount')));
    fragment.appendChild(tipRow('dot-cum', '値引累計率', Fmt.percent(activeSlot.cumDiscountRate), rateDiff('cumDiscountRate')));

    if (baselineDS && !hasBase) {
      fragment.appendChild(el('div', 'tip-section-label', (isCompare ? '分析データ' : '比較データ') + ': この時間帯のデータなし'));
    }
    return fragment;
  }

  function hideTooltip() {
    const tip = renderState.tooltipElement;
    if (!tip) return;
    tip.classList.remove('visible');
    tip.setAttribute('aria-hidden', 'true');
    renderState.lastTooltipKey = null;
  }

  /**
   * 指定座標 (mouseX, mouseY) に存在する棒グラフ要素を厳密に検出する。
   * 条件:
   * 1. Y軸の0メモリ(0軸)から下から1メモリ目(第1目盛線)の間のみ反応 (firstTickY <= mouseY <= zeroY)
   *    ※ 1メモリ目より上の領域(グラフ上部・中腹)では完全に反応を遮断
   * 2. 分析データまたは比較データの棒グラフの幅内かつバー内であること
   */
  function getBarAtCoords(chart, mouseX, mouseY) {
    if (!chart || !chart.chartArea) return null;
    const area = chart.chartArea;
    if (mouseX < area.left || mouseX > area.right || mouseY < area.top || mouseY > area.bottom) {
      return null;
    }

    // Y軸 (ySales) の 0 軸および「下から1メモリ目」の Y 座標を取得
    const yScale = chart.scales.ySales;
    if (!yScale) return null;

    const zeroY = yScale.getPixelForValue(0);

    // 0 より大きい最小の目盛り値 (下から1メモリ目) を特定
    let firstTickValue = null;
    if (Array.isArray(yScale.ticks)) {
      for (let i = 0; i < yScale.ticks.length; i++) {
        const val = yScale.ticks[i].value;
        if (Fmt.isNum(val) && val > 0) {
          if (firstTickValue === null || val < firstTickValue) {
            firstTickValue = val;
          }
        }
      }
    }
    const firstTickY = firstTickValue !== null
      ? yScale.getPixelForValue(firstTickValue)
      : (area.bottom - (area.bottom - area.top) / 7);

    // Canvas の Y 座標は画面上が小さく画面下が大きいため、
    // 「0メモリから1メモリ目の間」は firstTickY <= mouseY <= zeroY となる
    // 1メモリ目より上 (mouseY < firstTickY) は完全に無効化
    if (mouseY < firstTickY || mouseY > zeroY + 4) {
      return null;
    }

    for (let datasetIndex = 0; datasetIndex < chart.data.datasets.length; datasetIndex++) {
      if (!chart.isDatasetVisible(datasetIndex)) continue;
      const dataset = chart.data.datasets[datasetIndex];
      if (dataset.type !== 'bar') continue;

      const meta = chart.getDatasetMeta(datasetIndex);
      if (!meta || meta.hidden) continue;

      for (let index = 0; index < meta.data.length; index++) {
        const bar = meta.data[index];
        if (bar && typeof bar.inRange === 'function' && bar.inRange(mouseX, mouseY)) {
          return {
            datasetIndex,
            index,
            series: dataset.series || 'main',
            element: bar
          };
        }
      }
    }
    return null;
  }

  /**
   * ツールチップの内容構築と位置決めを行う。
   * カーソルの斜め右上（右端付近では左上）に十分な余白を空けて表示し、操作と視認性を向上させる。
   * @param {number} index 時間帯スロットインデックス
   * @param {'main'|'compare'} targetSeries 対象系列
   * @param {number} cursorX カーソルのCanvas内X座標
   * @param {number} cursorY カーソルのCanvas内Y座標
   */
  function positionAndShowTooltip(index, targetSeries, cursorX, cursorY) {
    const tip = renderState.tooltipElement;
    if (!tip || !renderState.primary) return;

    const cacheKey = index + '_' + targetSeries;
    if (renderState.lastTooltipKey !== cacheKey) {
      tip.replaceChildren(buildTooltipContent(index, targetSeries));
      renderState.lastTooltipKey = cacheKey;
    }

    const wrapper = tip.parentElement;
    if (!wrapper) return;

    const wrapperW = wrapper.clientWidth;
    const wrapperH = wrapper.clientHeight;
    const tipW = tip.offsetWidth;
    const tipH = tip.offsetHeight;

    // 水平方向 (X): カーソルから横に離す (デフォルトは右側)
    let x = cursorX + TOOLTIP_OFFSET_X;
    // 右端をはみ出す場合はカーソルより左側へ離して表示
    if (x + tipW > wrapperW - 12) {
      x = cursorX - tipW - TOOLTIP_OFFSET_X;
    }
    // 左端のはみ出し防止
    if (x < 8) {
      x = Math.max(8, Math.min(x, wrapperW - tipW - 8));
    }

    // 垂直方向 (Y): 合わせたカーソルの「もう少し右上、または左上」
    // ツールチップの下部がカーソルより上に位置するように配置
    let y = cursorY - tipH - TOOLTIP_OFFSET_Y;

    // 上端をはみ出す場合（カーソルがグラフ上部にある場合）
    if (y < 8) {
      y = 8;
    }
    // 下端のはみ出し防止
    if (y + tipH > wrapperH - 8) {
      y = Math.max(8, wrapperH - tipH - 8);
    }

    tip.style.setProperty('--tip-x', Math.round(x) + 'px');
    tip.style.setProperty('--tip-y', Math.round(y) + 'px');
    tip.classList.add('visible');
    tip.setAttribute('aria-hidden', 'false');
  }

  function handleCanvasMouseMove(event) {
    if (!mainChart) return;
    const canvas = mainChart.canvas;
    const rect = canvas.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;

    const hit = getBarAtCoords(mainChart, mouseX, mouseY);
    if (hit) {
      const isNewIndex = (renderState.highlightIndex !== hit.index);
      renderState.highlightIndex = hit.index;

      mainChart.setActiveElements([{ datasetIndex: hit.datasetIndex, index: hit.index }]);
      mainChart.draw();

      positionAndShowTooltip(hit.index, hit.series, mouseX, mouseY);

      if (isNewIndex && renderState.onIndexHover) {
        renderState.onIndexHover(hit.index);
      }
    } else {
      if (renderState.highlightIndex !== null) {
        renderState.highlightIndex = null;
        mainChart.setActiveElements([]);
        mainChart.draw();
        hideTooltip();
        if (renderState.onIndexHover) {
          renderState.onIndexHover(null);
        }
      }
    }
  }

  function handleCanvasLeave() {
    renderState.highlightIndex = null;
    hideTooltip();
    if (mainChart) {
      mainChart.setActiveElements([]);
      mainChart.draw();
    }
    if (renderState.onIndexHover) renderState.onIndexHover(null);
  }

  // ---------------------------------------------------------------------------
  // 公開 API
  // ---------------------------------------------------------------------------

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {HTMLElement} tooltipElement
   * @param {object} primary  HourlyParser.parse の結果
   * @param {object|null} compare
   * @param {Record<string, boolean>} visibility 指標ごとの表示状態
   * @param {(index: number|null) => void} onIndexHover グラフ→表連動用
   */
  function renderMainChart(canvas, tooltipElement, primary, compare, visibility, onIndexHover) {
    if (!(canvas instanceof HTMLCanvasElement)) throw new TypeError('Canvas要素が不正です。');
    if (!primary) throw new TypeError('描画対象のデータがありません。');

    destroyMainChart();
    const theme = readTheme();
    renderState.primary = primary;
    renderState.compare = compare || null;
    renderState.tooltipElement = tooltipElement;
    renderState.onIndexHover = typeof onIndexHover === 'function' ? onIndexHover : null;
    renderState.highlightIndex = null;
    hideTooltip();

    const hasCompare = Boolean(compare);
    const datasets = [];
    METRIC_ORDER.forEach((key) => {
      if (key === 'discount' && !primary.hasDiscountColumn) return;
      const visible = Boolean(visibility[key]);
      datasets.push(buildDataset(key, primary, 'main', theme, visible, hasCompare));
      if (hasCompare) datasets.push(buildDataset(key, compare, 'compare', theme, visible, hasCompare));
    });

    mainChart = new global.Chart(canvas, {
      type: 'bar',
      data: { labels: primary.slots.map((s) => s.label), datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 650, easing: 'easeOutQuart' },
        events: ['resize'], // Chart.js 内蔵ホバーによる折れ線や余白の誤検知を遮断し、canvas イベントで棒グラフ上のみを厳格判定
        plugins: {
          legend: { display: false },
          tooltip: { enabled: false }
        },
        scales: buildScales(theme)
      },
      plugins: [createHighlightPlugin(theme)]
    });

    canvas.addEventListener('mousemove', handleCanvasMouseMove);
    canvas.addEventListener('mouseleave', handleCanvasLeave);
    return mainChart;
  }

  /** 指標の表示切替 (分析・比較の両系列を同時に切り替える) */
  function setMetricVisibility(metricKey, visible) {
    if (!mainChart) return;
    mainChart.data.datasets.forEach((dataset, i) => {
      if (dataset.metricKey === metricKey) mainChart.setDatasetVisibility(i, visible);
    });
    mainChart.update();
  }

  /** 表の行ホバーからグラフの該当時間帯をハイライトし、ツールチップを表示する */
  function highlightIndex(index) {
    if (!mainChart) return;
    renderState.highlightIndex = index;
    if (index === null || index === undefined) {
      mainChart.setActiveElements([]);
      mainChart.draw();
      hideTooltip();
      return;
    }
    const active = [];
    let barEl = null;
    mainChart.data.datasets.forEach((dataset, datasetIndex) => {
      if (mainChart.isDatasetVisible(datasetIndex) && dataset.data[index] !== null) {
        active.push({ datasetIndex, index });
        if (!barEl && dataset.type === 'bar') {
          const meta = mainChart.getDatasetMeta(datasetIndex);
          if (meta && meta.data && meta.data[index]) {
            barEl = meta.data[index];
          }
        }
      }
    });

    mainChart.setActiveElements(active);
    mainChart.draw();

    if (active.length > 0 && barEl) {
      positionAndShowTooltip(index, 'main', barEl.x, barEl.y);
    } else {
      hideTooltip();
    }
  }

  /**
   * KPI カード用スパークライン
   * @param {HTMLCanvasElement} canvas
   * @param {Array<number|null>} values 分析データ
   * @param {string} metricKey 指標キー
   * @param {Array<number|null>|null} compareValues 比較データ（任意）
   */
  function renderSparkline(canvas, values, metricKey, compareValues) {
    if (!(canvas instanceof HTMLCanvasElement)) return;
    const existing = sparkCharts.get(canvas.id);
    if (existing) existing.destroy();

    const theme = readTheme();
    const color = theme.colors[metricKey] || theme.primary;
    const hasCompare = Boolean(
      Array.isArray(compareValues) &&
      compareValues.length > 0 &&
      compareValues.some((v) => Fmt.isNum(v) && v > 0)
    );

    const labels = (values && values.length > 0 ? values : (compareValues || [])).map((_, i) => i);

    const datasets = [
      {
        label: '分析データ',
        data: values,
        borderColor: color,
        borderWidth: 2,
        borderDash: [],
        pointRadius: 0,
        tension: 0.35,
        spanGaps: false,
        fill: 'origin',
        order: 2,
        backgroundColor(context) {
          const area = context.chart.chartArea;
          if (!area) return withAlpha(color, hasCompare ? 0.08 : 0.15);
          const gradient = context.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
          gradient.addColorStop(0, withAlpha(color, hasCompare ? 0.22 : 0.35));
          gradient.addColorStop(1, withAlpha(color, 0));
          return gradient;
        }
      }
    ];

    if (hasCompare) {
      datasets.push({
        label: '比較データ',
        data: compareValues,
        borderColor: withAlpha(color, 0.75),
        borderWidth: 1.6,
        borderDash: [3.5, 3],
        pointRadius: 0,
        tension: 0.35,
        spanGaps: false,
        fill: false,
        order: 1
      });
    }

    const chart = new global.Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 600 },
        events: [],
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: {
          x: { display: false },
          y: { display: false, beginAtZero: true }
        },
        layout: { padding: { top: 3, bottom: 0, left: 1, right: 1 } }
      }
    });
    sparkCharts.set(canvas.id, chart);
  }

  /**
   * KPIカード用の時間帯区分色分け横棒グラフ（スパークライン）を描画。
   * 比較データがある場合は上下2段（分析 / 比較）で比較表示する。
   * @param {HTMLCanvasElement} canvas
   * @param {Array<{ band: object, sales: number, share: number }>} bandStats
   * @param {Array<{ band: object, sales: number, share: number }>|null} compareBandStats
   */
  function renderBandSparkline(canvas, bandStats, compareBandStats) {
    if (!(canvas instanceof HTMLCanvasElement)) return;
    const existing = sparkCharts.get(canvas.id);
    if (existing) {
      existing.destroy();
      sparkCharts.delete(canvas.id);
    }

    const activeStats = (bandStats || []).filter((st) => st.sales > 0);
    const totalSales = activeStats.reduce((acc, st) => acc + st.sales, 0);
    if (totalSales <= 0) return;

    const hasCompare = Boolean(compareBandStats && compareBandStats.length > 0 && compareBandStats.some((st) => st.sales > 0));
    const cTotalSales = hasCompare ? compareBandStats.reduce((acc, st) => acc + (st.sales || 0), 0) : 0;

    const labels = hasCompare ? ['分析', '比較'] : ['構成比'];
    const barThickness = hasCompare ? 8 : 16;
    const count = activeStats.length;

    const datasets = activeStats.map((st, i) => {
      let borderRadius = 0;
      if (count === 1) {
        borderRadius = 3;
      } else if (i === 0) {
        borderRadius = { topLeft: 3, bottomLeft: 3, topRight: 0, bottomRight: 0 };
      } else if (i === count - 1) {
        borderRadius = { topRight: 3, bottomRight: 3, topLeft: 0, bottomLeft: 0 };
      }

      const primaryShare = (st.sales / totalSales) * 100;
      let data = [primaryShare];

      if (hasCompare) {
        const cMatch = compareBandStats.find((cs) => cs.band.id === st.band.id);
        const compareShare = (cMatch && cTotalSales > 0) ? (cMatch.sales / cTotalSales) * 100 : 0;
        data = [primaryShare, compareShare];
      }

      return {
        label: st.band.name,
        data,
        backgroundColor: st.band.color || '#38bdf8',
        borderWidth: 0,
        barThickness,
        borderRadius
      };
    });

    const chart = new global.Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 400 },
        events: [],
        plugins: {
          legend: { display: false },
          tooltip: { enabled: false }
        },
        scales: {
          x: { display: false, stacked: true, min: 0, max: 100 },
          y: { display: false, stacked: true }
        },
        layout: { padding: { top: hasCompare ? 4 : 8, bottom: 4, left: 0, right: 0 } }
      }
    });
    sparkCharts.set(canvas.id, chart);
  }

  /**
   * テーマ背景とタイトルを付与した高解像度 PNG を保存する。
   * @param {string} fileName 無害化済みファイル名
   * @param {string} titleText 画像上部に描くタイトル
   */
  function exportChartImage(fileName, titleText) {
    if (!mainChart) throw new Error('保存対象のグラフがありません。');
    hideTooltip();

    const theme = readTheme();
    const source = mainChart.canvas;
    const ratio = mainChart.currentDevicePixelRatio || 1;
    const header = Math.round(EXPORT_HEADER_PX * ratio);

    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = source.width;
    exportCanvas.height = source.height + header;
    const ctx = exportCanvas.getContext('2d');
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
    ctx.fillStyle = theme.textMain;
    ctx.font = '600 ' + Math.round(18 * ratio) + "px 'Inter', 'Meiryo', sans-serif";
    ctx.textBaseline = 'middle';
    ctx.fillText(titleText, Math.round(16 * ratio), Math.round(header / 2));
    ctx.drawImage(source, 0, header);

    exportCanvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      link.rel = 'noopener';
      document.body.appendChild(link);
      link.click();
      link.remove();
      // クリック直後に revoke するとダウンロードが中断されるブラウザがあるため遅延させる
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'image/png');
  }

  function destroyMainChart() {
    if (mainChart) {
      mainChart.canvas.removeEventListener('mousemove', handleCanvasMouseMove);
      mainChart.canvas.removeEventListener('mouseleave', handleCanvasLeave);
      mainChart.destroy();
      mainChart = null;
    }
    hideTooltip();
  }

  function destroyAll() {
    destroyMainChart();
    sparkCharts.forEach((chart) => chart.destroy());
    sparkCharts.clear();
    renderState.primary = null;
    renderState.compare = null;
  }

  global.HourlyChart = Object.freeze({
    METRICS,
    renderMain: renderMainChart,
    renderSparkline,
    renderBandSparkline,
    setMetricVisibility,
    highlightIndex,
    exportImage: exportChartImage,
    destroyAll
  });
})(window);
