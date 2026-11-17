# Match Cut eval rubric

Source: PRD "Backend: observability and quality evaluation". The LLM judge receives this rubric
(see `src/judge.ts`); people use it for the weekly review of 10 random briefs and every failed
criterion.

| Criterion     | How it is scored                                                               | Bar                        | Scored by                                                        |
| ------------- | ------------------------------------------------------------------------------ | -------------------------- | ---------------------------------------------------------------- |
| Accuracy      | Share of the breakdown's observations that contradict the human reference      | Under 5% wrong             | Judge, against the reference facts                               |
| Specificity   | Numeric details per breakdown (shot length, zoom %, words per line, BPM, wpm…) | At least 6                 | Code (`score.ts`)                                                |
| Executability | Every numbered prompt step maps to a capability-manifest operation             | 100%                       | Judge, step by step                                              |
| Adaptation    | Prompt reflects the goal, format and length, not the reference topic           | 90% of cases rated adapted | Judge, plus code checks for reframing and length steps           |
| Originality   | No copied script (13+ consecutive words), lyrics, or brand names               | 100%                       | Code (spoken lines, brand terms) plus judge                      |
| Honesty       | Unknowns are "unclear" rather than invented                                    | Reviewer spot-check        | Judge flags claims the reference says are absent; people confirm |

## Accuracy, in detail

The judge splits the breakdown into observations (the hook, each style field, each beat) and marks
each one against the reference facts:

- **consistent**: a fact supports it;
- **contradicted**: a fact says otherwise (this is "wrong");
- **unverifiable**: the facts don't cover it (excluded from the rate).

Wrong rate = contradicted ÷ (consistent + contradicted).

## Gate

`pnpm eval --gate` compares a run against `evals/baseline.json`. A change ships only if every
criterion's pass rate matches or beats the baseline (PRD: "No prompt or model change ships unless
it matches or beats the current version on a fixed golden set").
