"use client";
/**
 * The channel's Shorts by date and outlier score (PRD-playbooks.md, Frontend additions):
 * compared breakouts highlighted, a "channel median" line at 1x. The score is Match Cut's own
 * calculation, labeled so, with its formula one click away. Log scale, so 0.5x and 2x sit at the
 * same distance from the median. Identity never relies on color alone: breakouts are circles,
 * typical Shorts squares, a breakout that couldn't be analyzed a hollow circle; the table view
 * lists every Short. Only compared points take keyboard focus, in date order; the rest are in
 * the table.
 */
import { MIN_AGE_DAYS, type PlaybookResponse } from "@match-cut/core/playbooks/api";
import { useMemo, useState } from "react";
import { compact, day, P } from "../../lib/playbook-strings";
import css from "./playbook.module.css";

type Video = PlaybookResponse["videos"][number];
type Kind = "breakout" | "skipped" | "typical" | "other";

const W = 640;
const H = 260;
const PAD = { left: 44, right: 16, top: 12, bottom: 28 };
const TICKS = [0.125, 0.25, 0.5, 1, 2, 4, 8, 16, 32];

function kind(v: Video): Kind {
  if (v.group === "outlier") return v.compared ? "breakout" : "skipped";
  if (v.group === "typical") return "typical";
  return "other";
}

/** Plot geometry: domain, ticks and scales. Exported for tests. */
export function geometry(points: Video[], window: PlaybookResponse["window"]) {
  const times = points.map((v) => Date.parse(v.published_at)).filter(Number.isFinite);
  const t0 = window ? Date.parse(window.from) : Math.min(...times);
  const t1 = window ? Date.parse(window.to) : Math.max(...times);
  const logs = points.map((v) => Math.log2(v.outlier_score!));
  const yMin = Math.min(-1, Math.floor(Math.min(0, ...logs)));
  const yMax = Math.max(2, Math.ceil(Math.max(0, ...logs)));
  const x = (t: number) =>
    PAD.left + ((t - t0) / Math.max(1, t1 - t0)) * (W - PAD.left - PAD.right);
  const y = (score: number) =>
    PAD.top + ((yMax - Math.log2(score)) / (yMax - yMin)) * (H - PAD.top - PAD.bottom);
  const ticks = TICKS.filter((t) => Math.log2(t) >= yMin && Math.log2(t) <= yMax);
  return { t0, t1, x, y, ticks };
}

export function Scatter({ playbook }: { playbook: PlaybookResponse }) {
  const [hover, setHover] = useState<string | null>(null);
  const points = useMemo(
    () => playbook.videos.filter((v) => v.outlier_score !== null && v.outlier_score > 0),
    [playbook.videos],
  );
  const tooNew = playbook.window?.too_new ?? 0;
  const hasSkipped = points.some((v) => kind(v) === "skipped");

  if (points.length === 0) {
    return <div className={css.muted}>{P.notPlotted(playbook.videos.length, MIN_AGE_DAYS)}</div>;
  }
  const { t0, t1, x, y, ticks } = geometry(points, playbook.window);
  const hovered = points.find((v) => v.id === hover) ?? null;
  // Other Shorts first (drawn underneath); compared ones on top, in date order for the keyboard.
  const ordered = [...points].sort(
    (a, b) =>
      Number(kind(a) !== "other") - Number(kind(b) !== "other") ||
      Date.parse(a.published_at) - Date.parse(b.published_at),
  );

  // The tooltip sits over its point, kept inside the plot, below the point near the top edge.
  const tip = hovered && {
    left: Math.min(80, Math.max(20, (x(Date.parse(hovered.published_at)) / W) * 100)),
    top: (y(hovered.outlier_score!) / H) * 100,
  };

  return (
    <div className={css.chart} data-testid="scatter">
      <div className={css.label}>{P.scatterAxisY}</div>
      <div className={css.plot}>
        <svg viewBox={`0 0 ${W} ${H}`} role="group" aria-label={P.scatterPoints}>
          {ticks.map((t) => (
            <g key={t} aria-hidden="true">
              <line className={css.gridLine} x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} />
              <text className={css.axisText} x={PAD.left - 6} y={y(t) + 4} textAnchor="end">
                {`${t}x`}
              </text>
            </g>
          ))}
          <g aria-hidden="true">
            <line className={css.medianLine} x1={PAD.left} x2={W - PAD.right} y1={y(1)} y2={y(1)} />
            <text className={css.axisText} x={W - PAD.right} y={y(1) - 6} textAnchor="end">
              {P.medianLine}
            </text>
            <text className={css.axisText} x={PAD.left} y={H - 8}>
              {Number.isFinite(t0) ? day(new Date(t0).toISOString()) : ""}
            </text>
            <text className={css.axisText} x={W - PAD.right} y={H - 8} textAnchor="end">
              {Number.isFinite(t1) ? day(new Date(t1).toISOString()) : ""}
            </text>
          </g>
          {ordered.map((v) => {
            const cx = x(Date.parse(v.published_at));
            const cy = y(v.outlier_score!);
            const k = kind(v);
            const focusable = k !== "other";
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
                  {...(focusable
                    ? {
                        tabIndex: 0,
                        role: "img",
                        "aria-label": `${P.groupNames[v.group]}: ${v.title}, ${day(v.published_at)}, ${v.outlier_score!.toFixed(1)}x the median`,
                      }
                    : { "aria-hidden": true })}
                  onMouseEnter={() => setHover(v.id)}
                  onMouseLeave={() => setHover(null)}
                  onFocus={() => setHover(v.id)}
                  onBlur={() => setHover(null)}
                />
              </g>
            );
          })}
        </svg>
        {hovered && tip && (
          <div
            className={css.tooltip}
            aria-hidden="true"
            style={{
              left: `${tip.left}%`,
              top: `${tip.top}%`,
              transform:
                tip.top < 35 ? "translate(-50%, 16px)" : "translate(-50%, calc(-100% - 12px))",
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
      </div>
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
        {hasSkipped && (
          <span className={css.legendItem}>
            <span
              className={css.swatch}
              style={{ border: "2px solid var(--series-breakout)", background: "transparent" }}
            />
            {P.legendSkipped}
          </span>
        )}
      </div>
      {tooNew > 0 && <div className={css.muted}>{P.notPlotted(tooNew, MIN_AGE_DAYS)}</div>}
      <details>
        <summary className={css.muted}>{P.scoreHow}</summary>
        <p className={css.muted}>{P.scoreFormula(MIN_AGE_DAYS)}</p>
      </details>
      <details>
        <summary className={css.muted}>{P.showTable}</summary>
        <table className={css.table}>
          <thead>
            <tr>
              <th scope="col">{P.tableTitle}</th>
              <th scope="col">{P.tableDate}</th>
              <th scope="col">{P.tableViews}</th>
              <th scope="col">{P.tableScore}</th>
              <th scope="col">{P.tableGroup}</th>
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
                <td>{kind(v) === "skipped" ? P.legendSkipped : P.groupNames[v.group]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
