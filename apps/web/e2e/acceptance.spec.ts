/**
 * PRD "Frontend acceptance criteria", in mock mode. One describe per checklist item.
 * VoiceOver on macOS and the Mac app can't be automated here; see the notes in the summary.
 */
import { expect, test, type Page, type Request } from "@playwright/test";
import {
  blockThirdParty,
  events,
  fillAndMatch,
  freshId,
  openMatch,
  recordProgress,
  unique,
} from "./helpers";

const ERROR_COPY: Record<string, { status: number; message: string; action: string | null }> = {
  INVALID_URL: {
    status: 400,
    message: "That doesn't look like a YouTube link.",
    action: "Fix the link",
  },
  UNSUPPORTED_SOURCE: {
    status: 400,
    message: "Match Cut works with single YouTube videos for now. Instagram and TikTok are coming.",
    action: "Fix the link",
  },
  INVALID_CLIP_RANGE: {
    status: 400,
    message: "The end time needs to be at least 3 seconds after the start, within 10 minutes.",
    action: null,
  },
  GOAL_TOO_LONG: {
    status: 400,
    message: "Keep the description under 1,500 characters.",
    action: null,
  },
  UNAUTHORIZED: { status: 401, message: "Your session has ended.", action: "Sign in again" },
  VIDEO_NOT_FOUND: {
    status: 404,
    message: "This video has been removed or the link is wrong.",
    action: "Try another link",
  },
  VIDEO_NOT_PUBLIC: {
    status: 422,
    message: "This video is private or unlisted. Match Cut can only watch public videos.",
    action: "Try another link",
  },
  VIDEO_RESTRICTED: {
    status: 422,
    message: "This video is age-restricted or blocked in our region.",
    action: "Try another link",
  },
  LIVE_NOT_SUPPORTED: {
    status: 422,
    message: "This video is live or hasn't premiered yet. Try again once it has ended.",
    action: "Try another link",
  },
  VIDEO_TOO_LONG: {
    status: 422,
    message: "This video is over 20 minutes. Pick the part you want, up to 10 minutes.",
    action: null,
  },
  NO_ANALYZABLE_CONTENT: {
    status: 422,
    message: "There isn't enough in this video to study. It may be too short or blank.",
    action: "Try another link",
  },
  CONTENT_BLOCKED: {
    status: 422,
    message: "This video can't be analyzed.",
    action: "Try another link",
  },
  RATE_LIMITED: {
    status: 429,
    message: "You've reached the limit for now. You can match another video in 2 minutes.",
    action: null,
  },
  CAPACITY_EXHAUSTED: {
    status: 503,
    message: "Match Cut is at capacity. Try again in a few minutes.",
    action: "Retry",
  },
  UPSTREAM_TIMEOUT: {
    status: 504,
    message: "This took too long. Shorter sections work faster.",
    action: "Retry",
  },
  UPSTREAM_ERROR: {
    status: 502,
    message: "Something went wrong while analyzing.",
    action: "Retry",
  },
  INVALID_MODEL_OUTPUT: {
    status: 502,
    message: "Something went wrong while analyzing.",
    action: "Retry",
  },
  INTERNAL: { status: 500, message: "Something went wrong while analyzing.", action: "Retry" },
};

function trackPosts(page: Page) {
  const posts: Request[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/api/mc/briefs")) posts.push(r);
  });
  return posts;
}

test.beforeAll(async ({ request }) => {
  // Warm up the dev server's routes so the 1-second preview check measures the app, not compilation.
  await request.get("/");
  await request.get("/api/mc/videos/mockShort01");
});

test.describe("1. URL formats", () => {
  const ID = "dQw4w9WgXcQ";
  const accepted = [
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}?si=abc`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/embed/${ID}`,
    `https://www.youtube.com/live/${ID}`,
    `https://m.youtube.com/watch?v=${ID}`,
    `https://music.youtube.com/watch?v=${ID}`,
    ID,
    `https://www.youtube.com/watch?v=${ID}&feature=share&utm_source=x`,
    `https://youtu.be/${ID}?t=42`,
    `https://www.youtube.com/watch?v=${ID}&list=PL123`,
    `  youtu.be/${ID}  `,
  ];
  const rejected: [string, string][] = [
    ["https://www.youtube.com/playlist?list=PL123", ERROR_COPY.UNSUPPORTED_SOURCE!.message],
    ["https://www.youtube.com/@creator", ERROR_COPY.UNSUPPORTED_SOURCE!.message],
    ["https://www.youtube.com/results?search_query=x", ERROR_COPY.UNSUPPORTED_SOURCE!.message],
    ["https://www.instagram.com/reel/abc/", ERROR_COPY.UNSUPPORTED_SOURCE!.message],
    ["https://www.tiktok.com/@a/video/1", ERROR_COPY.UNSUPPORTED_SOURCE!.message],
    ["https://bit.ly/3abc", ERROR_COPY.UNSUPPORTED_SOURCE!.message],
    ["not a link", ERROR_COPY.INVALID_URL!.message],
    ["https://youtu.be/short", ERROR_COPY.INVALID_URL!.message],
  ];

  test("every accepted format is accepted", async ({ page }) => {
    await openMatch(page);
    for (const url of accepted) {
      await page.getByLabel("Reference link").fill(url);
      await expect(page.getByTestId("link-error"), url).toHaveCount(0);
      await expect(page.getByTestId("preview"), url).toBeVisible();
      await expect(page.getByTestId("match-button"), url).toBeEnabled();
    }
  });

  test("every rejected format shows its message before submit", async ({ page }) => {
    const posts = trackPosts(page);
    await openMatch(page);
    for (const [url, message] of rejected) {
      await page.getByLabel("Reference link").fill(url);
      await expect(page.getByTestId("link-error"), url).toHaveText(
        new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
      await expect(page.getByTestId("match-button"), url).toBeDisabled();
    }
    expect(posts).toHaveLength(0);
  });

  test("blocked videos show the precheck's message before submit", async ({ page }) => {
    await openMatch(page);
    for (const [id, code] of [
      ["mockPrivat1", "VIDEO_NOT_PUBLIC"],
      ["mockGone001", "VIDEO_NOT_FOUND"],
      ["mockAgeRst1", "VIDEO_RESTRICTED"],
      ["mockLiveNw1", "LIVE_NOT_SUPPORTED"],
      ["mockTiny001", "NO_ANALYZABLE_CONTENT"],
    ] as const) {
      await page.getByLabel("Reference link").fill(id);
      await expect(page.getByTestId("link-error"), id).toContainText(ERROR_COPY[code]!.message);
      await expect(page.getByTestId("match-button")).toBeDisabled();
    }
  });
});

test("2. preview shows title, thumbnail and duration within 1 s of a valid link", async ({
  page,
}) => {
  await openMatch(page);
  const t0 = Date.now();
  await page.getByLabel("Reference link").fill("https://youtube.com/shorts/mockShort01");
  await expect(page.getByTestId("preview")).toBeVisible({ timeout: 1000 });
  expect(Date.now() - t0).toBeLessThan(1000);
  await expect(page.getByTestId("preview")).toContainText("Mock talking-head Short");
  await expect(page.getByTestId("preview")).toContainText("0:45");
  await expect(page.getByTestId("preview").locator("img")).toHaveCount(1);
});

test("3. format and length prefill from the open project", async ({ page }) => {
  await openMatch(page);
  await expect(page.getByLabel("Format")).toHaveValue("9:16");
  await expect(page.getByLabel("Length")).toHaveValue("30");
  await page.goto("/?aspect=16:9&length=60");
  await page.getByRole("button", { name: "Match a reference" }).click();
  await expect(page.getByLabel("Format")).toHaveValue("16:9");
  await expect(page.getByLabel("Length")).toHaveValue("60");
});

test("4. a cache hit renders the result with no progress view", async ({ page }) => {
  const goal = unique("cache hit");
  await openMatch(page);
  await fillAndMatch(page, "mockShort01", goal);
  await expect(page.getByTestId("result")).toBeVisible();
  await page.getByRole("button", { name: "Start over" }).click();
  const rec = await recordProgress(page);
  await page.getByTestId("match-button").click();
  await expect(page.getByTestId("result")).toBeVisible();
  expect(await rec.sawProgress()).toBe(false);
});

test.describe("5. stages and polling", () => {
  test("the stage label changes as the API reports each stage", async ({ page }) => {
    await openMatch(page);
    const rec = await recordProgress(page);
    await fillAndMatch(page, freshId(), unique("stages"));
    await expect(page.getByTestId("result")).toBeVisible();
    const stages = await rec.stages();
    expect(stages).toContain("Watching the reference");
    expect(stages).toContain("Writing your prompt");
    expect(stages.indexOf("Watching the reference")).toBeLessThan(
      stages.indexOf("Writing your prompt"),
    );
  });

  test("polling takes over if the stream drops", async ({ page }) => {
    await page.route("**/api/mc/briefs/*/events", (route) => route.abort());
    const polls: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "GET" && /\/api\/mc\/briefs\/brf_[0-9a-f]+$/.test(r.url()))
        polls.push(r.url());
    });
    await openMatch(page);
    await fillAndMatch(page, freshId(), unique("polling"));
    await expect(page.getByTestId("result")).toBeVisible();
    expect(polls.length).toBeGreaterThan(0);
  });
});

test("6. reloading mid-job resumes and shows the result", async ({ page }) => {
  await openMatch(page);
  await fillAndMatch(page, freshId(), unique("reload"));
  await expect(page.getByTestId("progress")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("result")).toBeVisible();
  await expect(page.getByTestId("prompt")).toContainText("reload");
});

test.describe("7. every error code shows its mapped message and action", () => {
  for (const [code, copy] of Object.entries(ERROR_COPY)) {
    test(code, async ({ page }) => {
      await page.route("**/api/mc/briefs", (route) =>
        route.fulfill({
          status: copy.status,
          contentType: "application/json",
          headers: code === "RATE_LIMITED" ? { "retry-after": "120" } : {},
          body: JSON.stringify({
            error: { code, message: "RAW UPSTREAM SECRET TEXT", retryable: false },
          }),
        }),
      );
      await openMatch(page);
      await fillAndMatch(page, "mockShort01");
      await expect(page.getByText(copy.message).first()).toBeVisible();
      if (copy.action)
        await expect(page.getByRole("button", { name: copy.action }).first()).toBeVisible();
      if (code === "RATE_LIMITED") {
        await expect(page.getByTestId("match-button")).toBeDisabled();
        await expect(page.getByTestId("match-button")).toContainText("Try again in");
      }
      if (code === "INVALID_CLIP_RANGE" || code === "VIDEO_TOO_LONG") {
        await expect(page.getByLabel("Start")).toBeVisible(); // clip range opened
      }
      await expect(page.getByText("RAW UPSTREAM SECRET TEXT")).toHaveCount(0);
    });
  }

  test("a job that fails shows the mapped message and Retry", async ({ page }) => {
    await openMatch(page);
    await fillAndMatch(page, "mockFailP1a", unique("fails"));
    await expect(page.getByTestId("error")).toContainText(ERROR_COPY.UPSTREAM_ERROR!.message);
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  });
});

test("8. partial results show the breakdown and a working Regenerate prompt", async ({ page }) => {
  await openMatch(page);
  await fillAndMatch(page, freshId(), unique("partial mockFailP2a"));
  await expect(page.getByTestId("partial")).toContainText(
    "The breakdown is ready, but the prompt didn't finish.",
  );
  await expect(page.getByText("How the reference is made")).toBeVisible();
  // The mock fails pass 2 for this goal; regenerate with a different one.
  await page.route("**/api/mc/briefs/*/regenerate", (route) =>
    route.continue({ postData: JSON.stringify({ goal: "a recovered prompt" }) }),
  );
  await page.getByRole("button", { name: "Regenerate prompt" }).click();
  await expect(page.getByTestId("prompt")).toContainText("a recovered prompt");
});

test("9. Send to Director posts the edited prompt and never runs without the click", async ({
  page,
}) => {
  await openMatch(page);
  await fillAndMatch(page, "mockShort01", unique("director"));
  await expect(page.getByTestId("prompt")).toBeVisible();
  const userBubbles = page.locator('[data-role="user"]');
  await expect(userBubbles).toHaveCount(0);
  await page.getByTestId("prompt").fill("1. My edited prompt for the Director.");
  await page.getByRole("button", { name: "Send to Director" }).click();
  await expect(userBubbles).toHaveText(["1. My edited prompt for the Director."]);
  await expect(page.locator('[data-role="director"]').last()).toContainText("plan the edit");
});

test("10. Regenerate keeps the breakdown and warns before replacing an edited prompt", async ({
  page,
}) => {
  await openMatch(page);
  await fillAndMatch(page, "mockShort01", unique("regen"));
  await expect(page.getByTestId("prompt")).toBeVisible();
  await page.getByTestId("prompt").fill("my hand edits");
  await expect(page.getByRole("button", { name: "Reset to original" })).toBeVisible();
  await page.getByRole("button", { name: "Regenerate", exact: true }).click();
  await expect(page.getByTestId("regen-warning")).toHaveText(
    "Your edits to the prompt will be replaced.",
  );
  const newGoal = unique("a recipe video");
  await page.getByLabel("What are you making?").fill(newGoal);
  await page.getByRole("button", { name: "Write new prompt" }).click();
  await expect(page.getByText("How the reference is made")).toBeVisible();
  await expect(page.getByTestId("prompt")).toContainText(newGoal);
  await expect(page.getByTestId("prompt")).not.toContainText("my hand edits");
});

test("11. embed-disabled videos show the thumbnail and an Open on YouTube link", async ({
  page,
}) => {
  await openMatch(page);
  await fillAndMatch(page, "mockNoEmbd1", unique("embed"));
  await expect(page.getByTestId("player-fallback")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open on YouTube" })).toHaveAttribute(
    "href",
    "https://www.youtube.com/watch?v=mockNoEmbd1",
  );
  await expect(
    page.getByText("The creator has turned off playback outside YouTube."),
  ).toBeVisible();
  await expect(page.getByTestId("player")).toHaveCount(0);
});

test("M9. the shot list shows what to film and plays the beat it recreates", async ({ page }) => {
  await openMatch(page);
  await fillAndMatch(page, "mockShort01", unique("shot list"));
  await expect(page.getByTestId("result")).toBeVisible();
  const list = page.getByTestId("shot-list");
  await expect(list.getByText("What to film")).toBeVisible();
  // The open project's 30 s target length, not the 45 s reference, sets the total.
  await expect(list.getByText(/^\d+ shots, about 30 s on screen in total\./)).toBeVisible();
  expect(await list.locator("li").count()).toBeGreaterThanOrEqual(4);
  await list.scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window.__matchCutEvents ?? []).filter((e) => e.name === "shot_list_viewed"),
      ),
    )
    .toHaveLength(1);
  await list.getByRole("button", { name: `Play the reference's "Question hook" beat` }).click();
  await expect(page.getByTestId("beat-detail")).toContainText("Question hook");
});

test.describe("12. offline", () => {
  test("before submit", async ({ page, context }) => {
    await openMatch(page);
    await page.getByLabel("Reference link").fill("mockShort01");
    await expect(page.getByTestId("match-button")).toBeEnabled();
    await context.setOffline(true);
    await expect(
      page.getByText("You're offline. Match Cut needs an internet connection."),
    ).toBeVisible();
    await expect(page.getByTestId("match-button")).toBeDisabled();
    await context.setOffline(false);
    await expect(page.getByTestId("match-button")).toBeEnabled();
  });

  test("during a wait, without losing the job", async ({ page, context }) => {
    await openMatch(page);
    await fillAndMatch(page, freshId(), unique("offline wait"));
    await expect(page.getByTestId("progress")).toBeVisible();
    await context.setOffline(true);
    await expect(page.getByText("You're offline. We'll pick up where we left off")).toBeVisible();
    await page.waitForTimeout(3000); // the job finishes server-side meanwhile
    await context.setOffline(false);
    await expect(page.getByTestId("result")).toBeVisible();
  });
});

test("13. the full flow works by keyboard", async ({ page }) => {
  await blockThirdParty(page);
  await page.goto("/");
  await page.getByLabel("Message").focus();
  await page.keyboard.type("/match");
  await page.keyboard.press("Enter");
  const link = page.getByLabel("Reference link");
  await expect(link).toBeVisible();
  await link.focus();
  await page.keyboard.type("mockShort01");
  await page.keyboard.press("Tab");
  await page.keyboard.type(unique("keyboard"));
  await expect(page.getByTestId("match-button")).toBeEnabled();
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(page.getByTestId("result")).toBeVisible();
  // Beats are buttons with names like "Hook, 0:00 to 0:03".
  const beat = page.getByRole("button", { name: /^Question hook, 0:00 to 0:03$/ });
  await beat.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("beat-detail")).toContainText("Question hook");
  // Cmd/Ctrl + Shift + C copies the prompt when the result is focused.
  await page.getByTestId("prompt").focus();
  await page.keyboard.press("ControlOrMeta+Shift+C");
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
});

test.describe("entry points", () => {
  test("pasting a link shows Match / Dismiss and starts nothing until Match", async ({ page }) => {
    const posts = trackPosts(page);
    await blockThirdParty(page);
    await page.goto("/");
    await page.getByLabel("Message").fill("https://youtube.com/shorts/mockShort01");
    await page.keyboard.press("Enter");
    await expect(page.getByText("Match this video's style?")).toBeVisible();
    expect(posts).toHaveLength(0);
    await page.getByRole("button", { name: "Match", exact: true }).click();
    await expect(page.getByLabel("Reference link")).toHaveValue(
      "https://youtube.com/shorts/mockShort01",
    );
    expect(posts).toHaveLength(0);
  });

  test("the Director starts the tool for 'make it look like this video'", async ({ page }) => {
    await blockThirdParty(page);
    await page.goto("/");
    await page
      .getByLabel("Message")
      .fill(`make my launch video look like this https://youtu.be/${freshId()}`);
    await page.keyboard.press("Enter");
    await expect(page.getByText("I'm studying that video")).toBeVisible();
    await expect(page.getByTestId("result")).toBeVisible();
    await expect(page.getByTestId("prompt")).toContainText("make my launch video look like this");
  });

  test("a deep link opens the input panel prefilled", async ({ page }) => {
    await blockThirdParty(page);
    await page.goto("/match?url=https%3A%2F%2Fyoutu.be%2FmockShort01");
    await expect(page.getByLabel("Reference link")).toHaveValue("https://youtu.be/mockShort01");
    await expect(page.getByTestId("preview")).toBeVisible();
  });

  test("the empty state offers a labeled example", async ({ page }) => {
    await openMatch(page);
    await expect(page.getByTestId("empty-state")).toContainText("Paste a reference");
    await page.getByRole("button", { name: "See an example" }).click();
    await expect(page.getByText("Example result")).toBeVisible();
    await expect(page.getByTestId("prompt")).toBeVisible();
  });
});

test.describe("actions", () => {
  test("cancel returns to the input with values kept", async ({ page }) => {
    await openMatch(page);
    const goal = unique("cancel me");
    await fillAndMatch(page, freshId(), goal);
    await expect(page.getByTestId("progress")).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByLabel("What are you making?")).toHaveValue(goal);
  });

  test("delete asks for confirmation and removes the brief from chat", async ({ page }) => {
    await openMatch(page);
    await fillAndMatch(page, "mockShort01", unique("delete"));
    await expect(page.getByTestId("result")).toBeVisible();
    await page.getByRole("button", { name: "Delete brief" }).click();
    await expect(page.getByText("Delete this brief?")).toBeVisible();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByTestId("match-session")).toHaveCount(0);
  });

  test("copy confirms with Copied for 2 seconds", async ({ page }) => {
    await openMatch(page);
    await fillAndMatch(page, "mockShort01", unique("copy"));
    await page.getByRole("button", { name: "Copy", exact: true }).click();
    await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("Edit my footage");
    await expect(page.getByRole("button", { name: "Copy", exact: true })).toBeVisible({
      timeout: 3000,
    });
  });
});

test("14a. link_validated carries the preview's duration when the user waits for it", async ({
  page,
}) => {
  await openMatch(page);
  await page.getByLabel("Reference link").fill(freshId());
  await expect(page.getByTestId("preview")).toBeVisible();
  const ev = (await events(page)).filter((e) => e.name === "link_validated");
  expect(ev.at(-1)!.props).toMatchObject({ valid: true, duration_seconds: 60 });
  await page.getByLabel("Reference link").fill("https://vimeo.com/1");
  await expect
    .poll(async () => (await events(page)).filter((e) => e.name === "link_validated").at(-1)!.props)
    .toMatchObject({
      valid: false,
      error_code: "UNSUPPORTED_SOURCE",
    });
});

test("14. analytics events fire with the listed properties", async ({ page }) => {
  await openMatch(page);
  await fillAndMatch(page, freshId(), unique("analytics"));
  await expect(page.getByTestId("result")).toBeVisible();
  await page.getByTestId("prompt").fill("edited text");
  await page.getByTestId("prompt").blur();
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await page.getByRole("button", { name: /^Problem setup, / }).click();
  await page.getByRole("button", { name: "Not helpful" }).click();
  await page.getByLabel("Too generic").check();
  await page.getByRole("button", { name: "Send feedback" }).click();
  await page.getByRole("button", { name: "Send to Director" }).click();
  await page.getByRole("button", { name: "Regenerate", exact: true }).click();
  await page.getByLabel("What are you making?").fill(unique("regen analytics"));
  await page.getByRole("button", { name: "Write new prompt" }).click();
  await expect(page.getByTestId("regenerating")).toHaveCount(0, { timeout: 15000 });
  await page.getByRole("button", { name: "Delete brief" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByTestId("match-session")).toHaveCount(0);

  const ev = await events(page);
  const byName = (n: string) => ev.filter((e) => e.name === n);
  for (const e of ev) {
    expect(e.props, e.name).toMatchObject({
      project_id: "demo-project",
      platform: "web",
      entry_point: "chat_action",
    });
  }
  expect(byName("match_opened")).toHaveLength(1);
  expect(byName("link_validated")).toHaveLength(1);
  expect(byName("link_validated")[0]!.props).toMatchObject({ valid: true });
  expect(byName("brief_requested")[0]!.props).toMatchObject({
    has_goal: true,
    format: "9:16",
    length_seconds: 30,
    has_clip: false,
    detail: "standard",
  });
  const done = byName("brief_succeeded")[0]!.props;
  expect(done).toMatchObject({ cached: false, warning_codes: [] });
  expect(done.brief_id).toMatch(/^brf_/);
  expect(typeof done.seconds_waited).toBe("number");
  expect(byName("prompt_edited")[0]!.props.chars_changed).toBeGreaterThan(0);
  expect(byName("prompt_copied")[0]!.props).toMatchObject({ edited: true });
  expect(byName("beat_clicked")[0]!.props).toMatchObject({ beat_index: 1 });
  expect(byName("brief_feedback")[0]!.props).toMatchObject({
    helpful: false,
    reasons: ["too_generic"],
  });
  expect(byName("prompt_sent_to_director")[0]!.props).toMatchObject({ edited: true });
  expect(byName("prompt_regenerated")[0]!.props).toMatchObject({ changed_fields: ["goal"] });
  expect(byName("brief_deleted")).toHaveLength(1);
});

test("14b. cancel, partial and failure events", async ({ page }) => {
  await openMatch(page);
  await fillAndMatch(page, freshId(), unique("cancel event"));
  await expect(page.getByTestId("progress")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByLabel("Reference link").fill(freshId());
  await page.getByLabel("What are you making?").fill(unique("mockFailP2a"));
  await page.getByTestId("match-button").click();
  await expect(page.getByTestId("partial")).toBeVisible();
  await page.getByRole("button", { name: "Start over" }).click();
  await page.getByLabel("Reference link").fill("mockFailP1a");
  await page.getByTestId("match-button").click();
  await expect(page.getByTestId("error")).toBeVisible();
  const ev = await events(page);
  expect(ev.find((e) => e.name === "brief_cancelled")?.props).toMatchObject({
    seconds_waited: expect.any(Number),
  });
  expect(ev.find((e) => e.name === "brief_partial")?.props).toMatchObject({
    seconds_waited: expect.any(Number),
  });
  expect(ev.find((e) => e.name === "brief_failed")?.props).toMatchObject({
    error_code: "UPSTREAM_ERROR",
  });
});

test("15. no request from the client goes to Gemini or the YouTube Data API", async ({ page }) => {
  const external: string[] = [];
  page.on("request", (r) => {
    if (
      /generativelanguage\.googleapis\.com|googleapis\.com\/youtube|aiplatform\.googleapis\.com/.test(
        r.url(),
      )
    ) {
      external.push(r.url());
    }
  });
  await openMatch(page);
  await fillAndMatch(page, freshId(), unique("no direct calls"));
  await expect(page.getByTestId("result")).toBeVisible();
  await page.getByRole("button", { name: "Regenerate", exact: true }).click();
  await page.getByRole("button", { name: "Write new prompt" }).click();
  await expect(page.getByTestId("prompt")).toBeVisible();
  expect(external).toEqual([]);
});
