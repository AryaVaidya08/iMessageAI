/** Default cap on points handed to a chart. */
export const MAX_CHART_POINTS = 1000;

/**
 * Largest-Triangle-Three-Buckets downsampling. Keeps first and last points and
 * picks one visually-representative point per bucket. Returns the input
 * unchanged when it is already within `threshold`.
 */
export function lttb<T>(data: T[], threshold: number, getY: (d: T) => number): T[] {
  const n = data.length;
  if (threshold >= n) return data;
  if (threshold < 3) return data.slice(0, threshold);
  const out: T[] = [data[0]];
  const every = (n - 2) / (threshold - 2);
  let a = 0;
  for (let i = 0; i < threshold - 2; i++) {
    const nStart = Math.floor((i + 1) * every) + 1;
    const nEnd = Math.min(Math.floor((i + 2) * every) + 1, n);
    let avgX = 0;
    let avgY = 0;
    const len = Math.max(1, nEnd - nStart);
    for (let j = nStart; j < nEnd; j++) {
      avgX += j;
      avgY += getY(data[j]);
    }
    avgX /= len;
    avgY /= len;
    const start = Math.floor(i * every) + 1;
    const end = Math.floor((i + 1) * every) + 1;
    const ay = getY(data[a]);
    let best = -1;
    let bestIdx = start;
    for (let j = start; j < end; j++) {
      const area = Math.abs((a - avgX) * (getY(data[j]) - ay) - (a - j) * (avgY - ay));
      if (area > best) {
        best = area;
        bestIdx = j;
      }
    }
    out.push(data[bestIdx]);
    a = bestIdx;
  }
  out.push(data[n - 1]);
  return out;
}

/**
 * Min/max bucketing: splits the series into ~threshold/2 buckets and keeps the
 * lowest and highest point of each (in original order). Preserves spikes,
 * which suits count/bar charts. Output length is <= threshold.
 */
export function minMax<T>(data: T[], threshold: number, getY: (d: T) => number): T[] {
  const n = data.length;
  if (n <= threshold) return data;
  const buckets = Math.max(1, Math.floor(threshold / 2));
  const size = n / buckets;
  const out: T[] = [];
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor(b * size);
    const end = Math.min(n, Math.floor((b + 1) * size));
    if (start >= end) continue;
    let lo = start;
    let hi = start;
    for (let j = start + 1; j < end; j++) {
      const y = getY(data[j]);
      if (y < getY(data[lo])) lo = j;
      if (y > getY(data[hi])) hi = j;
    }
    if (lo === hi) out.push(data[lo]);
    else if (lo < hi) out.push(data[lo], data[hi]);
    else out.push(data[hi], data[lo]);
  }
  return out;
}

/** Cap a time series to MAX_CHART_POINTS (min/max keeps peaks visible). */
export function downsampleSeries<T>(data: T[], getY: (d: T) => number, max = MAX_CHART_POINTS): T[] {
  return minMax(data, max, getY);
}

/**
 * Merge adjacent points into equal-size groups, summing counts. Preserves
 * totals and uniform spacing (right for bar charts of counts). Each merged
 * point keeps the first member's other fields (e.g. its label).
 */
export function aggregateSum<T>(data: T[], getY: (d: T) => number, setY: (d: T, y: number) => T, max = MAX_CHART_POINTS): T[] {
  if (data.length <= max) return data;
  const group = Math.ceil(data.length / max);
  const out: T[] = [];
  for (let i = 0; i < data.length; i += group) {
    let sum = 0;
    for (let j = i; j < Math.min(i + group, data.length); j++) sum += getY(data[j]);
    out.push(setY(data[i], sum));
  }
  return out;
}
