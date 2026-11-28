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

## Playbooks

Source: PRD-playbooks.md, "Quality evaluation". `pnpm eval -- --set playbooks` builds a playbook for
each case in `evals/playbooks/cases.json` with the real pipeline and checks it in code
(`src/playbooks.ts`):

| Check    | Passes when                                                                                                                         |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| outcome  | The playbook succeeds, or fails with the expected code (and, for `NOT_ENOUGH_DATA`, the expected reasons)                           |
| faithful | Evidence and confidence equal the comparison; examples are real moments of breakouts with the value; counterexamples break the rule |
| planted  | Every planted pattern (mock channels) is a rule, and no other rule is high confidence                                               |
| warnings | The expected caveats are present                                                                                                    |
| recipe   | A playbook with rules has a recipe prompt template                                                                                  |
| apply    | Apply returns a prompt that passes v1's prompt checks and a shot list of 4 to 15 shots                                              |

People score what code can't, 1 to 5 each, on the `--review` sheet against the case's note:

| Criterion   | Question                                                                       |
| ----------- | ------------------------------------------------------------------------------ |
| Correctness | Do the rules match the note on why the channel's outliers worked?              |
| Usefulness  | Could an editor act on each rule without watching the channel?                 |
| Honesty     | Does "what the edit doesn't explain" name the topic, timing and other factors? |
| Originality | Is the recipe about craft, with none of the channel's words, names or topics?  |

A real channel runs only once someone has picked it and written its note (`status: "ready"`). The
golden channels start as mock channels with planted patterns; their notes describe the fixture.

## Gate

`pnpm eval --gate` compares a run against `evals/baseline.json`. A change ships only if every
criterion's pass rate matches or beats the baseline (PRD: "No prompt or model change ships unless
it matches or beats the current version on a fixed golden set").
