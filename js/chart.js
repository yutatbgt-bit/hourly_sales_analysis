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
  const TOOLTIP_OFFSET_PX = 16;
  const EXPORT_HEADER_PX = 64;

  let mainChart = null;
  const sparkCharts = new Map();

  /** ツールチップ・ハイライト用に描画中のデータを保持 */
  const renderState = {
    primary: null,
    compare: null,
    tooltipElement: null,
    lastTooltipIndex: null,
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

  function buildTooltipContent(index) {
    const primarySlot = renderState.primary.slots[index];
    const compareSlot = renderState.compare ? renderState.compare.slots[index] : null;
    const fragment = document.createDocumentFragment();

    const title = el('div', 'tip-title');
    title.appendChild(el('span', null, primarySlot.label + ' 台'));
    title.appendChild(el('span', 'tip-title-sub', renderState.primary.meta.dateLabel + ' ' + renderState.primary.meta.storeName));
    fragment.appendChild(title);

    if (!primarySlot.hasData) {
      fragment.appendChild(el('div', 'tip-label', 'この時間帯のデータはありません（営業時間外）'));
      return fragment;
    }

    const hasCmp = Boolean(compareSlot && compareSlot.hasData);
    const ratioDiff = (key) => {
      if (!hasCmp) return null;
      const r = Fmt.ratio(primarySlot[key], compareSlot[key]);
      return diffNode('比 ' + Fmt.ratioText(r), Fmt.isNum(r) ? r - 100 : null, 'up');
    };
    const rateDiff = (key) => {
      if (!hasCmp) return null;
      const d = Fmt.pointDiff(primarySlot[key], compareSlot[key]);
      return diffNode(Fmt.pointText(d), d, 'down');
    };

    fragment.appendChild(el('div', 'tip-section-label', hasCmp ? '時間帯実績（右: 比較比）' : '時間帯実績'));
    fragment.appendChild(tipRow('dot-sales', '売上', Fmt.yen(primarySlot.sales), ratioDiff('sales')));
    fragment.appendChild(tipRow('dot-customers', '客数', Fmt.integer(primarySlot.customers, ' 人'), ratioDiff('customers')));
    fragment.appendChild(tipRow('dot-items', '打数', Fmt.integer(primarySlot.items, ' 打数'), ratioDiff('items')));
    fragment.appendChild(tipRow('dot-discount-rate', '値引率', Fmt.percent(primarySlot.discountRate), rateDiff('discountRate')));
    fragment.appendChild(tipRow('dot-discount', '値引金額', Fmt.yen(primarySlot.discount), ratioDiff('discount')));
    fragment.appendChild(tipRow('dot-derived', '客単価', Fmt.yen(primarySlot.avgSpend), ratioDiff('avgSpend')));
    fragment.appendChild(tipRow('dot-derived', '一品単価', Fmt.yen(primarySlot.avgItemPrice), ratioDiff('avgItemPrice')));

    const firstLabel = renderState.primary.totals.firstLabel || primarySlot.label;
    fragment.appendChild(el('div', 'tip-section-label', '累計（' + firstLabel + ' 〜 ' + primarySlot.label + ' 台）'));
    fragment.appendChild(tipRow('dot-cum', '売上累計', Fmt.yen(primarySlot.cumSales), ratioDiff('cumSales')));
    fragment.appendChild(tipRow('dot-cum', '客数累計', Fmt.integer(primarySlot.cumCustomers, ' 人'), ratioDiff('cumCustomers')));
    fragment.appendChild(tipRow('dot-cum', '打数累計', Fmt.integer(primarySlot.cumItems, ' 打数'), ratioDiff('cumItems')));
    fragment.appendChild(tipRow('dot-cum', '値引累計', Fmt.yen(primarySlot.cumDiscount), ratioDiff('cumDiscount')));
    fragment.appendChild(tipRow('dot-cum', '値引累計率', Fmt.percent(primarySlot.cumDiscountRate), rateDiff('cumDiscountRate')));

    if (renderState.compare && !hasCmp) {
      fragment.appendChild(el('div', 'tip-section-label', '比較データ: この時間帯のデータなし'));
    }
    return fragment;
  }

  function hideTooltip() {
    const tip = renderState.tooltipElement;
    if (!tip) return;
    tip.classList.remove('visible');
    tip.setAttribute('aria-hidden', 'true');
    renderState.lastTooltipIndex = null;
  }

  function externalTooltipHandler(context) {
    const tip = renderState.tooltipElement;
    const tooltip = context.tooltip;
    if (!tip || !renderState.primary) return;

    if (tooltip.opacity === 0 || !tooltip.dataPoints || tooltip.dataPoints.length === 0) {
      hideTooltip();
      return;
    }

    const index = tooltip.dataPoints[0].dataIndex;
    // マウス移動ごとの DOM 再構築を避け、時間帯が変わった時だけ作り直す
    if (renderState.lastTooltipIndex !== index) {
      tip.replaceChildren(buildTooltipContent(index));
      renderState.lastTooltipIndex = index;
    }

    const wrapper = tip.parentElement;
    const maxX = wrapper.clientWidth - tip.offsetWidth;
    const maxY = wrapper.clientHeight - tip.offsetHeight;
    let x = tooltip.caretX + TOOLTIP_OFFSET_PX;
    if (x > maxX) x = tooltip.caretX - tip.offsetWidth - TOOLTIP_OFFSET_PX;
    const y = Math.min(Math.max(tooltip.caretY - tip.offsetHeight / 2, 0), Math.max(maxY, 0));

    tip.style.setProperty('--tip-x', Math.max(0, Math.round(x)) + 'px');
    tip.style.setProperty('--tip-y', Math.round(y) + 'px');
    tip.classList.add('visible');
    tip.setAttribute('aria-hidden', 'false');
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
        interaction: { mode: 'index', intersect: false },
        onHover(event, elements) {
          const index = elements.length ? elements[0].index : null;
          if (index !== renderState.highlightIndex) {
            renderState.highlightIndex = index;
            mainChart.draw();
            if (renderState.onIndexHover) renderState.onIndexHover(index);
          }
        },
        plugins: {
          legend: { display: false }, // 指標チップが凡例を兼ねる
          tooltip: { enabled: false, external: externalTooltipHandler }
        },
        scales: buildScales(theme)
      },
      plugins: [createHighlightPlugin(theme)]
    });

    canvas.addEventListener('mouseleave', handleCanvasLeave);
    return mainChart;
  }

  function handleCanvasLeave() {
    renderState.highlightIndex = null;
    hideTooltip();
    if (mainChart) mainChart.draw();
    if (renderState.onIndexHover) renderState.onIndexHover(null);
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
      mainChart.tooltip.setActiveElements([], { x: 0, y: 0 });
      mainChart.update('none');
      hideTooltip();
      return;
    }
    const active = [];
    mainChart.data.datasets.forEach((dataset, datasetIndex) => {
      if (mainChart.isDatasetVisible(datasetIndex) && dataset.data[index] !== null) {
        active.push({ datasetIndex, index });
      }
    });
    const area = mainChart.chartArea;
    const position = { x: mainChart.scales.x.getPixelForValue(index), y: (area.top + area.bottom) / 2 };
    mainChart.setActiveElements(active);
    mainChart.tooltip.setActiveElements(active, position);
    mainChart.update('none');
    if (active.length === 0) hideTooltip();
  }

  /** KPI カード用スパークライン */
  function renderSparkline(canvas, values, metricKey) {
    if (!(canvas instanceof HTMLCanvasElement)) return;
    const existing = sparkCharts.get(canvas.id);
    if (existing) existing.destroy();

    const theme = readTheme();
    const color = theme.colors[metricKey] || theme.primary;
    const chart = new global.Chart(canvas, {
      type: 'line',
      data: {
        labels: values.map((_, i) => i),
        datasets: [{
          data: values,
          borderColor: color,
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.35,
          spanGaps: false,
          fill: 'origin',
          backgroundColor(context) {
            const area = context.chart.chartArea;
            if (!area) return withAlpha(color, 0.15);
            const gradient = context.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
            gradient.addColorStop(0, withAlpha(color, 0.35));
            gradient.addColorStop(1, withAlpha(color, 0));
            return gradient;
          }
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 700 },
        events: [],
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: { x: { display: false }, y: { display: false, beginAtZero: true } },
        layout: { padding: { top: 2, bottom: 0 } }
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
    setMetricVisibility,
    highlightIndex,
    exportImage: exportChartImage,
    destroyAll
  });
})(window);
