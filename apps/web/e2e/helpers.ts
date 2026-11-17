import { expect, type Page } from "@playwright/test";

/** A fresh 11-character video ID, so pass 1 isn't served from cache. Mock lookup accepts any ID. */
export function freshId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let id = "e2e";
  for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

export const unique = (label: string) =>
  `${label} ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

/** Blocks third-party media (YouTube embeds, thumbnails) so tests don't need the internet. */
export async function blockThirdParty(page: Page) {
  await page.route(/youtube-nocookie\.com|ytimg\.com|youtube\.com/, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<html></html>" }),
  );
}

export async function openMatch(page: Page, query = "") {
  await blockThirdParty(page);
  await page.goto(`/${query}`);
  await page.getByRole("button", { name: "Match a reference" }).click();
  await expect(page.getByLabel("Reference link")).toBeVisible();
}

export async function fillAndMatch(page: Page, url: string, goal?: string) {
  await page.getByLabel("Reference link").fill(url);
  if (goal !== undefined) await page.getByLabel("What are you making?").fill(goal);
  await expect(page.getByTestId("match-button")).toBeEnabled();
  await page.getByTestId("match-button").click();
}

/** Records every stage label and whether the progress view ever appeared. */
export async function recordProgress(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __stages: string[]; __sawProgress: boolean };
    w.__stages = [];
    w.__sawProgress = false;
    new MutationObserver(() => {
      if (document.querySelector('[data-testid="progress"]')) w.__sawProgress = true;
      const label = document.querySelector('[data-testid="stage-label"]')?.textContent;
      if (label && w.__stages.at(-1) !== label) w.__stages.push(label);
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  return {
    stages: () => page.evaluate(() => (window as unknown as { __stages: string[] }).__stages),
    sawProgress: () =>
      page.evaluate(() => (window as unknown as { __sawProgress: boolean }).__sawProgress),
  };
}

export async function events(page: Page) {
  return page.evaluate(() => window.__matchCutEvents ?? []);
}
