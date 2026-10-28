/**
 * ECharts styling derived from the design tokens in styles/index.css. Colours
 * are read from CSS variables at call time, so charts always match the theme.
 */

export const SANS = '"IBM Plex Sans", system-ui, sans-serif';
export const MONO = '"IBM Plex Mono", ui-monospace, monospace';

function triplet(name: string): string {
  if (typeof window === 'undefined') return '128 128 128';
  return getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim() || '128 128 128';
}
/** Token → `rgb()` / `rgba()` string ECharts understands. */
export function tokenColor(name: string, alpha = 1): string {
  const [r, g, b] = triplet(name).split(/\s+/);
  return alpha >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function chartColors() {
  return {
    fg: tokenColor('fg'),
    fgSecondary: tokenColor('fg-secondary'),
    fgMuted: tokenColor('fg-muted'),
    line: tokenColor('line'),
    lineSubtle: tokenColor('line-subtle'),
    lineStrong: tokenColor('line-strong'),
    overlay: tokenColor('overlay'),
    surface: tokenColor('surface'),
    accent: tokenColor('accent'),
    accentSoft: tokenColor('accent', 0.14),
    accentFaint: tokenColor('accent', 0.02),
    success: tokenColor('success'),
    warning: tokenColor('warning'),
    danger: tokenColor('danger'),
    info: tokenColor('info'),
  };
}
export type ChartColors = ReturnType<typeof chartColors>;

/** Shared tooltip look — matches the app's overlay surfaces. */
export function tooltipStyle(c: ChartColors) {
  return {
    backgroundColor: c.overlay,
    borderColor: c.lineStrong,
    borderWidth: 1,
    padding: [8, 12],
    textStyle: { color: c.fg, fontSize: 12, fontFamily: SANS },
    extraCssText: 'border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,.45);',
  };
}

/** Value axis; pass a formatter (e.g. compact money) for labelled units. */
export function valueAxis(c: ChartColors, format?: (value: number) => string) {
  return {
    type: 'value',
    axisLabel: { color: c.fgMuted, fontSize: 11, fontFamily: MONO, ...(format ? { formatter: format } : {}) },
    splitLine: { lineStyle: { color: c.lineSubtle } },
    axisLine: { show: false },
    axisTick: { show: false },
  };
}

export function categoryAxis(c: ChartColors, data: string[]) {
  return {
    type: 'category',
    data,
    axisLabel: { color: c.fgMuted, fontSize: 11, fontFamily: SANS },
    axisLine: { lineStyle: { color: c.line } },
    axisTick: { show: false },
  };
}

/** Accent line + soft fading area — the standard "trend" series. */
export function trendSeries(c: ChartColors, name: string, data: number[]) {
  return {
    name,
    type: 'line',
    smooth: 0.25,
    showSymbol: false,
    symbolSize: 6,
    data,
    lineStyle: { color: c.accent, width: 2 },
    itemStyle: { color: c.accent },
    areaStyle: {
      color: {
        type: 'linear',
        x: 0,
        y: 0,
        x2: 0,
        y2: 1,
        colorStops: [
          { offset: 0, color: c.accentSoft },
          { offset: 1, color: c.accentFaint },
        ],
      },
    },
  };
}
