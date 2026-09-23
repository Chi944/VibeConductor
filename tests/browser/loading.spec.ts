import { expect, test } from "@playwright/test";
import { EXAMPLES } from "../../shared/examples";

test("a delayed saved composition cannot overwrite edits after its dialog is closed", async ({
  page,
}) => {
  const score = { ...EXAMPLES[1].score, title: "Delayed saved idea" };
  await page.route("**/api/compositions", (route) =>
    route.fulfill({
      json: {
        compositions: [
          {
            id: score.id,
            title: score.title,
            updatedAt: "2026-09-23T00:00:00Z",
          },
        ],
      },
    }),
  );
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let received!: () => void;
  const requested = new Promise<void>((resolve) => {
    received = resolve;
  });
  await page.route(`**/api/compositions/${score.id}`, async (route) => {
    received();
    await delayed;
    await route.fulfill({
      json: { id: score.id, score, history: [], title: score.title },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open compositions" }).click();
  await page.getByRole("button", { name: /Delayed saved idea/ }).click();
  await requested;
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page
    .getByRole("textbox", { name: "Composition title" })
    .fill("Newer unsaved work");
  await page.getByRole("textbox", { name: "Composition title" }).press("Enter");
  const finished = page.waitForResponse((response) =>
    response.url().endsWith(`/api/compositions/${score.id}`),
  );
  release();
  await finished;
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("vibeconductor:draft:v1") || "{}")
            .score?.title,
      ),
    )
    .toBe("Newer unsaved work");
  await expect(
    page.getByRole("textbox", { name: "Composition title" }),
  ).toHaveValue("Newer unsaved work");
});

test("choosing an example invalidates an earlier saved-composition request", async ({
  page,
}) => {
  const score = { ...EXAMPLES[1].score, title: "Slow saved composition" };
  await page.route("**/api/compositions", (route) =>
    route.fulfill({
      json: {
        compositions: [
          {
            id: score.id,
            title: score.title,
            updatedAt: "2026-09-23T00:00:00Z",
          },
        ],
      },
    }),
  );
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let received!: () => void;
  const requested = new Promise<void>((resolve) => {
    received = resolve;
  });
  await page.route(`**/api/compositions/${score.id}`, async (route) => {
    received();
    await delayed;
    await route.fulfill({
      json: { id: score.id, score, history: [], title: score.title },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open compositions" }).click();
  await page.getByRole("button", { name: /Slow saved composition/ }).click();
  await requested;
  await page.locator(".example-choice").nth(2).click();
  const finished = page.waitForResponse((response) =>
    response.url().endsWith(`/api/compositions/${score.id}`),
  );
  release();
  await finished;
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("vibeconductor:draft:v1") || "{}")
            .score?.title,
      ),
    )
    .toBe(EXAMPLES[2].score.title);
  await expect(
    page.getByRole("textbox", { name: "Composition title" }),
  ).toHaveValue(EXAMPLES[2].score.title);
});
