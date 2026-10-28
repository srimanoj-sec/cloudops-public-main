import ReactEChartsCore from 'echarts-for-react/lib/core';
import type { EChartsReactProps } from 'echarts-for-react/lib/types';
import * as echarts from 'echarts/core';
import { BarChart, GraphChart, LineChart } from 'echarts/charts';
import {
  AxisPointerComponent,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
} from 'echarts/components';
import { LabelLayout } from 'echarts/features';
import { CanvasRenderer } from 'echarts/renderers';

/**
 * Tree-shaken ECharts: only the series/components the app draws. The default
 * `echarts-for-react` import pulls in the whole library (~1 MB) on the
 * dashboard — the landing page. Using a new series type (pie, heatmap…) or
 * component (dataZoom, markLine…)? Register it here, or it silently won't render.
 */
echarts.use([
  LineChart,
  BarChart,
  GraphChart,
  GridComponent,
  TooltipComponent,
  AxisPointerComponent,
  LegendComponent,
  TitleComponent,
  LabelLayout,
  CanvasRenderer,
]);

export function ReactECharts(props: Omit<EChartsReactProps, 'echarts'>) {
  return <ReactEChartsCore echarts={echarts} {...props} />;
}
