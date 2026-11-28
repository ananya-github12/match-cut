"use client";
/**
 * The channel's Shorts by date and outlier score (PRD-playbooks.md, Frontend additions):
 * compared breakouts highlighted, a "channel median" line at 1x. The score is Match Cut's own
 * calculation, labeled so, with its formula one click away. Log scale, so 0.5x and 2x sit at the
 * same distance from the median. Identity never relies on color alone: breakouts are circles,
 * typical Shorts squares, and a table view lists every point.
 */
import type { PlaybookResponse } from "@match-cut/core/playbooks/api";
import { useMemo, useState } from "react";
import { compact, day, P } from "../../lib/playbook-strings";
import css from "./playbook.module.css";

type Video = PlaybookResponse["videos"][number];

const W = 640;
const H = 260;
const PAD = { left: 44, right: 16, top: 12, bottom: 28 };
const TICKS = [0.125, 0.25, 0.5, 1, 2, 4, 8, 16, 32];

function kind(v: Video): "breakout" | "skipped" | "typical" | "other" {
  if (v.group === "outlier") return v.compared ? "breakout" : "skipped";
  if (v.group === "typical") return "typical";
  return "other";
}

export function Scatter({ playbook }: { playbook: PlaybookResponse }) {
  const [hover, setHover] = useState<number | null>(null);
  const points = useMemo(
    () => playbook.videos.filter((v) => v.outlier_score !== null && v.outlier_score > 0),
    [playbook.videos],
  );
  const notPlotted = playbook.videos.length - points.length;

  const times = points.map((v) => Date.parse(v.published_at));
  const t0 = playbook.window ? Date.parse(playbook.window.from) : Math.min(...times);
  const t1 = playbook.window ? Date.parse(playbook.window.to) : Math.max(...times);
  const logs = points.map((v) => Math.log2(v.outlier_score!));
  const yMin = Math.min(-1, Math.floor(Math.min(...logs, 0)));
  const yMax = Math.max(2, Math.ceil(Math.max(...logs, 0)));
  const x = (t: number) =>
    PAD.left + ((t - t0) / Math.max(1, t1 - t0)) * (W - PAD.left - PAD.right);
  const y = (score: number) =>
    PAD.top + ((yMax - Math.log2(score)) / (yMax - yMin)) * (H - PAD.top - PAD.bottom);
  const ticks = TICKS.filter((t) => Math.log2(t) >= yMin && Math.log2(t) <= yMax);
  const hovered = hover === null ? null : points[hover];

  return (
    <div className={css.chart} data-testid="scatter">
      <div className={css.label}>{P.scatterAxisY}</div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${P.scatterTitle}. ${points.filter((v) => kind(v) === "breakout").length} breakouts compared.`}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line className={css.gridLine} x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} />
            <text className={css.axisText} x={PAD.left - 6} y={y(t) + 4} textAnchor="end">
              {`${t}x`}
            </text>
          </g>
        ))}
        <line className={css.medianLine} x1={PAD.left} x2={W - PAD.right} y1={y(1)} y2={y(1)} />
        <text className={css.axisText} x={W - PAD.right} y={y(1) - 6} textAnchor="end">
          {P.medianLine}
        </text>
        <text className={css.axisText} x={PAD.left} y={H - 8}>
          {day(new Date(t0).toISOString())}
        </text>
        <text className={css.axisText} x={W - PAD.right} y={H - 8} textAnchor="end">
          {day(new Date(t1).toISOString())}
        </text>
        {/* Other Shorts first, so compared ones draw on top. */}
        {points
          .map((v, i) => ({ v, i }))
          .sort((a, b) => (kind(a.v) === "other" ? -1 : 0) - (kind(b.v) === "other" ? -1 : 0))
          .map(({ v, i }) => {
            const cx = x(Date.parse(v.published_at));
            const cy = y(v.outlier_score!);
            const k = kind(v);
            const mark =
              k === "typical" ? (
                <rect
                  className={css.dotTypical}
                  x={cx - 5}
                  y={cy - 5}
                  width={10}
                  height={10}
                  rx={2}
                />
              ) : (
                <circle
                  className={
                    k === "breakout"
                      ? css.dotBreakout
                      : k === "skipped"
                        ? css.dotSkipped
                        : css.dotOther
                  }
                  cx={cx}
                  cy={cy}
                  r={k === "other" ? 4 : 6}
                />
              );
            return (
              <g key={v.id} data-kind={k}>
                {mark}
                <circle
                  className={css.hit}
                  cx={cx}
                  cy={cy}
                  r={12}
                  tabIndex={0}
                  aria-label={`${v.title}: ${v.outlier_score!.toFixed(1)}x the median`}
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                />
              </g>
            );
          })}
      </svg>
      {hovered && (
        <div
          className={css.tooltip}
          role="status"
          style={{
            left: `${(x(Date.parse(hovered.published_at)) / W) * 100}%`,
            top: `${(y(hovered.outlier_score!) / H) * 100}%`,
            transform: "translate(-50%, calc(-100% - 12px))",
          }}
        >
          <strong>{hovered.title}</strong>
          <span>
            {day(hovered.published_at)} · {compact(hovered.views)} views
          </span>
          <span>
            {hovered.outlier_score!.toFixed(1)}x the median · {P.groupNames[hovered.group]}
          </span>
        </div>
      )}
      <div className={css.legend}>
        <span className={css.legendItem}>
          <span className={css.swatch} style={{ background: "var(--series-breakout)" }} />
          {P.legendBreakout}
        </span>
        <span className={css.legendItem}>
          <span
            className={`${css.swatch} ${css.swatchSquare}`}
            style={{ background: "var(--series-typical)" }}
          />
          {P.legendTypical}
        </span>
        <span className={css.legendItem}>
          <span className={css.swatch} style={{ background: "var(--series-other)" }} />
          {P.legendOther}
        </span>
      </div>
      {notPlotted > 0 && <div className={css.muted}>{P.notPlotted(notPlotted)}</div>}
      <details>
        <summary className={css.muted}>{P.scoreHow}</summary>
        <p className={css.muted}>{P.scoreFormula}</p>
      </details>
      <details>
        <summary className={css.muted}>{P.showTable}</summary>
        <table className={css.table}>
          <thead>
            <tr>
              <th>{P.tableTitle}</th>
              <th>{P.tableDate}</th>
              <th>{P.tableViews}</th>
              <th>{P.tableScore}</th>
              <th>{P.tableGroup}</th>
            </tr>
          </thead>
          <tbody>
            {playbook.videos.map((v) => (
              <tr key={v.id}>
                <td>{v.title}</td>
                <td>{day(v.published_at)}</td>
                <td className={css.num}>{v.views.toLocaleString("en-US")}</td>
                <td className={css.num}>
                  {v.outlier_score === null ? "-" : `${v.outlier_score.toFixed(1)}x`}
                </td>
                <td>{P.groupNames[v.group]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
