import { expect, test, type Page } from "@playwright/test";

const ARTIFACTS = "e2e/artifacts";

/** One smoke journey through every view; `prefix` namespaces screenshots, `query` selects live vs mock. */
async function journey(page: Page, opts: { query: string; prefix: string; base?: string }) {
  const consoleErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  const shot = (name: string) => page.screenshot({ path: `${ARTIFACTS}/${opts.prefix}${name}.png`, fullPage: true });

  // Overview
  await page.goto(`${opts.base ?? ""}/${opts.query}`);
  await expect(page.getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "Overview", level: 2 })).toBeVisible();
  await expect(page).toHaveTitle(/Overview/);
  const equity = page.locator(".tile", { hasText: "Equity" }).first();
  // Money is displayed in AUD when an FX rate is available, USD otherwise.
  await expect(equity.locator(".value")).toHaveText(/(A\$|US\$|\$)\s?[\d,]+(\.\d+)?/);
  // Times are shown in Sydney time with the zone abbreviation.
  await expect(page.getByRole("region", { name: "Bot health" })).toContainText(/AE[DS]T/);
  const health = page.getByRole("region", { name: "Bot health" });
  await expect(health.getByText(/^(Healthy|Stalled)$/)).toBeVisible();
  await expect(page.locator(".refresh-state")).toHaveText("Live");
  await expect(page.locator(".refresh-ago")).toContainText(/updated/);
  // Charts must have rendered (not the lazy placeholder) before the screenshot.
  await expect(page.locator(".recharts-surface").first()).toBeVisible();
  await shot("overview");

  // Decisions: filtered chip
  await page.getByRole("link", { name: "Decisions" }).click();
  await expect(page).toHaveURL(/#\/decisions$/);
  await expect(page.getByRole("heading", { name: "Decisions", level: 2 })).toBeVisible();
  const chip = page.getByRole("button", { name: "filtered", exact: true });
  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  const badges = page.locator("table tbody tr:not(.detail) .action");
  const empty = page.getByText("No decisions.");
  await expect(badges.first().or(empty)).toBeVisible();
  // Wait until the filtered response has replaced the unfiltered one: every badge is "filtered".
  await expect
    .poll(async () => {
      const acts = await badges.evaluateAll((els) => els.map((e) => e.getAttribute("data-action")));
      return acts.every((a) => a === "filtered");
    })
    .toBe(true);
  await shot("decisions");

  // Candidates
  await page.getByRole("link", { name: "Candidates" }).click();
  await expect(page).toHaveURL(/#\/candidates$/);
  await expect(page.getByRole("heading", { name: "Latest screen" })).toBeVisible();
  await expect(page.locator("table tbody tr td.rank").first().or(page.getByText("No candidates in the latest screen."))).toBeVisible();
  await shot("candidates");

  // Activity
  await page.getByRole("link", { name: "Activity" }).click();
  await expect(page).toHaveURL(/#\/activity$/);
  await expect(page.getByRole("heading", { name: /^Notes/ })).toBeVisible();
  await expect(page.locator("ol.timeline li").first().or(page.getByText("No notes recorded."))).toBeVisible();
  await shot("activity");

  // Positions (screenshot only)
  await page.getByRole("link", { name: "Positions" }).click();
  await expect(page).toHaveURL(/#\/positions$/);
  await expect(page.getByRole("heading", { level: 2 }).first()).toBeVisible();
  await shot("positions");

  // Auto-refresh toggle: constant label, aria-pressed carries state, visible Live/Paused text.
  const toggle = page.getByRole("button", { name: "Auto-refresh", exact: true });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".refresh-state")).toHaveText("Paused");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");

  // Skip link moves focus into the main landmark (headless pages have no initial focus, so focus it directly).
  const skip = page.getByRole("link", { name: "Skip to content" });
  await skip.focus();
  await expect(skip).toBeVisible();
  await skip.press("Enter");
  await expect(page.locator("main#main")).toBeFocused();

  expect(consoleErrors, "console errors during journey").toEqual([]);
}

test("live dashboard smoke journey", async ({ page }) => {
  await journey(page, { query: "", prefix: "" });
});

// Mock mode (?mock=1) is compiled out of production builds; it only works under `npm run ui:dev`.
// Point MOCK_BASE_URL at a Vite dev server to run the deterministic journey.
const mockBase = process.env.MOCK_BASE_URL;
test("mock dashboard smoke journey (?mock=1, dev server only)", async ({ page }) => {
  test.skip(!mockBase, "set MOCK_BASE_URL=http://127.0.0.1:5173 with `npm run ui:dev` running");
  await journey(page, { query: "?mock=1", prefix: "mock-", base: mockBase });
});
