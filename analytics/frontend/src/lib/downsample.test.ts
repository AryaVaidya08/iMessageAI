import { describe, expect, it } from "vitest";
import { aggregateSum, downsampleSeries, lttb, minMax } from "./downsample";

const series = (n: number) => Array.from({ length: n }, (_, i) => ({ x: i, y: i === 5000 ? 999 : i % 7 }));
const y = (d: { y: number }) => d.y;

describe("aggregateSum", () => {
  it("caps length and preserves total", () => {
    const s = Array.from({ length: 3500 }, (_, i) => ({ b: i, y: 2 }));
    const o = aggregateSum(s, y, (d, v) => ({ ...d, y: v }));
    expect(o.length).toBeLessThanOrEqual(1000);
    expect(o.reduce((a, d) => a + d.y, 0)).toBe(7000);
  });
});

describe("downsample", () => {
  it("returns input when small", () => {
    const s = series(10);
    expect(lttb(s, 100, y)).toBe(s);
    expect(minMax(s, 100, y)).toBe(s);
  });
  it("lttb caps length and keeps endpoints", () => {
    const s = series(20000);
    const o = lttb(s, 500, y);
    expect(o.length).toBe(500);
    expect(o[0]).toBe(s[0]);
    expect(o[o.length - 1]).toBe(s[s.length - 1]);
  });
  it("minMax caps length, preserves order and spike", () => {
    const s = series(20000);
    const o = downsampleSeries(s, y);
    expect(o.length).toBeLessThanOrEqual(1000);
    expect(o.some((d) => d.y === 999)).toBe(true);
    for (let i = 1; i < o.length; i++) expect(o[i].x).toBeGreaterThan(o[i - 1].x);
  });
});
