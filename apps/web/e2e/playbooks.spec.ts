/**
 * M10.9: the playbook page and skills list (PRD-playbooks.md, Frontend additions) against the full
 * stack in mock mode. Each test uses its own mock channel, so the 24-hour playbook cache shared
 * across users doesn't hide the progress view.
 */
import { expect, test, type Page } from "@playwright/test";
import { blockThirdParty, events, recordProgress } from "./helpers";

async function openPlaybooks(page: Page) {
  await blockThirdParty(page);
  await page.goto("/playbooks");
  await expect(page.getByLabel("Channel")).toBeVisible();
}

async function build(page: Page, channel: string) {
  await page.getByLabel("Channel").fill(channel);
  await page.getByTestId("playbook-button").click();
}

const names = async (page: Page) => (await events(page)).map((e) => e.name);

test("a playbook: progress, scatter, rules with evidence, examples, apply and save as skill", async ({
  page,
}) => {
  await openPlaybooks(page);
  const progress = await recordProgress(page);
  await build(page, "@mockgolden04");

  // The channel appears as soon as it's resolved; progress counts the videos watched.
  await expect(page.getByTestId("channel-preview")).toContainText("@mockgolden04");
  await expect(page.getByTestId("scatter")).toBeVisible({ timeout: 45_000 });
  const stages = await progress.stages();
  expect(stages.some((s) => /^Watching \d+ of \d+$/.test(s))).toBe(true);

  // Scatter: labeled as Match Cut's calculation, formula one click away, table view.
  await expect(page.getByText("Outlier score (Match Cut's calculation)")).toBeVisible();
  await page.getByText("How is the outlier score calculated?").click();
  await expect(page.getByText(/views divided by the channel's median views/)).toBeVisible();
  await expect(page.getByText("channel median")).toBeVisible();

  // Rules: evidence in the PRD's words, a confidence badge, the caveat.
  const rules = page.getByTestId("rule");
  expect(await rules.count()).toBeGreaterThan(0);
  await expect(rules.first().getByTestId("evidence")).toHaveText(
    /^\d+ of \d+ breakouts · \d+ of \d+ typical$/,
  );
  await expect(rules.first().getByText(/(High|Medium) confidence/)).toBeVisible();
  await expect(page.getByText(/not proof of what caused the views/)).toBeVisible();

  // House style and what the edit doesn't explain are always visible.
  await expect(page.getByRole("heading", { name: "House style" })).toBeVisible();
  await expect(page.getByTestId("not-explained").locator("li").first()).toBeVisible();

  // An example clip opens the player at its moment.
  await rules
    .first()
    .getByRole("button", { name: /^Watch / })
    .first()
    .click();
  await expect(page.getByTestId("example-player")).toHaveAttribute(
    "src",
    /youtube-nocookie\.com\/embed\/m\w+\?.*start=\d+/,
  );

  // Apply: prompt and shots for the user's video, Copy and Send to Director.
  await page.getByLabel("What are you making?").fill("a video about my coffee cart");
  await page.getByLabel("Length (seconds)").fill("30");
  await page.getByTestId("apply-button").click();
  await expect(page.getByTestId("apply-prompt")).toContainText("my coffee cart");
  await expect(page.getByTestId("apply-shots").locator("li")).toHaveCount(4);
  await page.getByRole("button", { name: "Copy" }).click();
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
  await page.getByRole("button", { name: "Send to Director" }).click();
  await expect(page.getByText(/Director is a stub/)).toBeVisible();

  // Save as a skill.
  await page.getByLabel("Skill name").fill("Coffee cart hooks");
  await page.getByTestId("save-skill").click();
  await expect(page.getByText("Saved. Find it under Skills.")).toBeVisible();

  const seen = await names(page);
  for (const name of [
    "playbook_started",
    "playbook_completed",
    "rule_example_played",
    "playbook_applied",
    "skill_saved",
  ]) {
    expect(seen, name).toContain(name);
  }

  // The skills list: name, source, last used, Apply.
  await page.getByRole("link", { name: "Skills" }).first().click();
  const skill = page.getByTestId("skill").filter({ hasText: "Coffee cart hooks" });
  await expect(skill).toContainText("From a playbook: Mock Golden Channel 4");
  await expect(skill).toContainText("Not used yet");
  await skill.getByRole("button", { name: "Apply" }).click();
  await skill.getByLabel("What are you making?").fill("my bakery");
  await skill.getByTestId("apply-button").click();
  await expect(skill.getByTestId("apply-prompt")).toContainText("my bakery");
  await expect(skill).toContainText(/Last used/);
  expect(await names(page)).toContain("skill_applied");
});

test("a channel that doesn't exist shows the PRD's message", async ({ page }) => {
  await openPlaybooks(page);
  await build(page, "@mockgone");
  await expect(page.locator("#pb-error")).toHaveText(
    "We couldn't find that channel. Check the handle or paste one of its video links.",
  );
});

test("too little data explains what was found and offers a longer window", async ({ page }) => {
  await openPlaybooks(page);
  await build(page, "@mocktiny");
  const box = page.getByTestId("playbook-error");
  await expect(box).toContainText("Not enough recent Shorts to compare", { timeout: 30_000 });
  await expect(box).toContainText("Too few recent Shorts");
  await expect(box).toContainText(/Shorts at least 7 days old: \d+ found, 10 needed/);
  await expect(box.getByRole("button", { name: "Try 180 days" })).toBeVisible();
  await expect(box.getByRole("link", { name: "Analyze a single video instead" })).toBeVisible();
  expect(await names(page)).toContain("playbook_failed");
});

test("a running playbook can be cancelled", async ({ page }) => {
  await openPlaybooks(page);
  await build(page, "@mockgolden09");
  await expect(page.getByTestId("progress")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("Playbook cancelled.")).toBeVisible();
  await page.getByRole("button", { name: "Build another playbook" }).click();
  await expect(page.getByLabel("Channel")).toBeVisible();
});

test("the editor links to playbooks and skills", async ({ page }) => {
  await blockThirdParty(page);
  await page.goto("/");
  await page.getByRole("link", { name: "Playbooks" }).click();
  await expect(page.getByRole("heading", { name: "Channel playbook" })).toBeVisible();
  await page.getByRole("link", { name: "Skills" }).click();
  await expect(page.getByRole("heading", { name: "Skills", exact: true })).toBeVisible();
});
