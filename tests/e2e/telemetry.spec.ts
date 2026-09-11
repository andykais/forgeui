import { expect, test } from "@playwright/test";

/**
 * The Telemetry screen end to end (§7.1, §11.2): the rail item, both shapes of
 * a report, the filters, and the raw-entry sidebar. Browsing the app is what
 * fills the reports in, so this test's own page loads are the data.
 */
test("both shapes of a report, its filters, and a raw entry", async ({ page }) => {
  await page.goto("/generate");
  await expect(page.getByText("ComfyUI connected")).toBeVisible();

  // A top-level rail item, beside ComfyUI (§11.1).
  await page.getByRole("link", { name: "Telemetry" }).click();
  await expect(page).toHaveURL(/\/telemetry$/);

  // One tab per report, and the log's own size in the corner.
  for (const title of [
    "API Request Duration",
    "Output Size",
    "Model Size",
    "Memory Usage",
    "Telemetry Log Size",
  ]) {
    await expect(page.getByRole("button", { name: new RegExp(title) })).toBeVisible();
  }
  await expect(page.getByText(/telemetry\.db ·/)).toBeVisible();

  // The note about what an entry is rides an info icon rather than sitting
  // over the graph (§11.2).
  const info = page.locator(".titles .info");
  await expect(info).toHaveAttribute("title", /One entry per answered/);
  await expect(page.getByText("One entry per answered")).toHaveCount(0);

  // Both shapes, always: a timeline with marks in it, and a table under it.
  const chart = page.locator(".chart svg");
  await expect(chart).toBeVisible();
  await expect(page.locator(".chart path.bar").first()).toBeVisible();
  const rows = page.locator("tbody tr");
  await expect(rows.first()).toBeVisible();
  // The columns are the graphed value plus what can be filtered (§11.2).
  for (const column of ["When", "Duration", "Method", "Url", "Status"]) {
    await expect(
      page.getByRole("columnheader", { name: column }),
    ).toBeVisible();
  }

  // The graph switches to the smoothed line and back, and says so in the URL.
  await page.getByRole("button", { name: "Line" }).click();
  await expect(page).toHaveURL(/graph=line/);
  await expect(page.locator(".chart path.line")).toBeVisible();
  await page.getByRole("button", { name: "Bars" }).click();
  await expect(page).not.toHaveURL(/graph=line/);

  // A filter chip narrows both halves at once; its options come from the data.
  await page.getByRole("button", { name: /^Method:/ }).click();
  await page.getByRole("button", { name: /^✓?\s*GET/ }).first().click();
  await expect(page).toHaveURL(/method=GET/);
  await page.keyboard.press("Escape");
  await expect(rows.first()).toBeVisible();
  const methods = await page
    .locator("tbody tr td:nth-child(3)")
    .allInnerTexts();
  expect(methods.length).toBeGreaterThan(0);
  expect(methods.every((method) => method.trim() === "GET")).toBe(true);

  // Clicking a row opens the right-hand sidebar with the entry's raw data.
  await rows.first().click();
  const sidebar = page.locator(".sidebar");
  await expect(sidebar).toBeVisible();
  await expect(sidebar.getByText("Raw entry")).toBeVisible();
  await expect(sidebar.locator("pre")).toContainText('"report": "api_requests"');
  await expect(sidebar.locator("pre")).toContainText('"path"');
  await expect(page).toHaveURL(/entry=\d+/);

  // Esc closes it; the filter and the report survive a refresh, as links.
  await page.keyboard.press("Escape");
  await expect(sidebar).toBeHidden();
  await page.reload();
  await expect(page.getByRole("button", { name: /^Method: GET/ })).toBeVisible();

  // Another report, with no filters of its own and nothing recorded yet.
  await page.getByRole("button", { name: /Model Size/ }).click();
  await expect(page).toHaveURL(/report=model_size/);
  await expect(page.getByRole("button", { name: /^Model type:/ })).toBeVisible();
  // The method filter does not travel between reports (§7.1).
  await expect(page).not.toHaveURL(/method=/);

  // Memory Usage draws two lines, so it always carries a legend (§11.2).
  await page.getByRole("button", { name: /Memory Usage/ }).click();
  await expect(page).toHaveURL(/report=memory/);
  await expect(page.locator(".chart .legend")).toContainText("VRAM");
  await expect(page.locator(".chart .legend")).toContainText("RAM");
  await expect(page.getByRole("columnheader", { name: "Memory" })).toBeVisible();

  await page.getByRole("button", { name: /Telemetry Log Size/ }).click();
  await expect(page.getByRole("columnheader", { name: "Log size" })).toBeVisible();
  // The log records every report but itself, so no row here names it.
  const causes = await page.locator("tbody tr td:nth-child(3)").allInnerTexts();
  expect(causes.every((cause) => cause.trim() !== "telemetry_size")).toBe(true);
});
