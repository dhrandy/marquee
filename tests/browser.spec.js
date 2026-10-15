import { test, expect } from "@playwright/test";
import fs from "node:fs";
const shots = process.env.CI ? "test-results/screenshots" : "/downloads";
fs.mkdirSync(shots, { recursive: true });
async function view(page, name) {
  await page.locator(`#page-nav button[data-page="${name}"]`).click();
}
async function login(page) {
  // Existing-user fixture: most tests exercise the search-enabled home page.
  await page.addInitScript(() => {
    const key = "marquee:Demo viewer:preferences";
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ search: true, watchNext: false, personalShelvesReset:true,continueWatching:false,nextUp:false,requests:true,libraryStats:false }));
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Explore demo" }).click();
  await expect(
    page.getByRole("heading", { name: "Recently added" }),
  ).toBeVisible();
  await expect(page.locator("#recent .poster-card")).toHaveCount(6);
  await expect(page.locator(".entry").first()).toBeVisible();
}
test("private APIs require login, writes reject cross-origin, and headers prevent crawl", async ({
  request,
}) => {
  for (const path of [
    "/api/recent",
    "/api/calendar",
    "/api/weather",
    "/api/me",
    "/api/seerr/popular",
    "/api/in-theaters",
    "/api/calendar-image/anything",
  ]) {
    expect((await request.get(path)).status()).toBe(401);
  }
  expect(
    (
      await request.post("/api/login", {
        data: {},
        headers: { Origin: "https://evil.invalid" },
      })
    ).status(),
  ).toBe(403);
  const response = await request.get("/");
  expect(response.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  expect(response.headers()["content-security-policy"]).toContain(
    "frame-ancestors 'none'",
  );
});
test("desktop navigation, status filters, settings, weather, and session invalidation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await login(page);
  await expect(page.locator('[data-view="agenda"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "Month", exact: true }).click();
  await expect(page.locator(".weekday").first()).toHaveText("Sun");
  const original = await page.locator("#calendar-title").textContent();
  await page.getByRole("button", { name: "Next period" }).click();
  await expect(page.locator("#calendar-title")).not.toHaveText(original);
  await page.getByRole("button", { name: "Today", exact: true }).click();
  for (const view of ["Week", "Day", "Agenda", "List", "Month"]) {
    await page.getByRole("button", { name: view, exact: true }).click();
    await expect(
      page.locator(`[data-view="${view.toLowerCase()}"]`),
    ).toHaveAttribute("aria-pressed", "true");
  }
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.locator('[data-type="tv"]').uncheck();
  await expect(
    page.locator(".entry").filter({ hasText: "North of Nowhere" }),
  ).toHaveCount(0);
  await page.locator('[data-type="tv"]').check();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByPlaceholder("City name").fill("Sample");
  await page.getByRole("button", { name: "Find city", exact: true }).click();
  await page
    .getByRole("button", { name: "Sample City, Example Region", exact: true })
    .click();
  await page.locator('[data-pref="weather"]').check();
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(page.locator("#weather-content")).toContainText("68°F");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator('[data-pref="recent"]').uncheck();
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(page.locator("#recent-section")).toBeHidden();
  await page.reload();
  await expect(page.locator("#recent-section")).toBeHidden();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Explore demo" }),
  ).toBeVisible();
  expect((await page.request.get("/api/recent")).status()).toBe(401);
});
for (const width of [393, 320, 280]) {
  test(`mobile ${width}px has no page overflow and all views remain usable`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 852 });
    await login(page);
    await expect(page.locator('[data-view="agenda"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "Month", exact: true }).click();
    await expect(page.locator("#scroll-hint")).toBeVisible();
    expect(
      await page
        .locator("#calendar")
        .evaluate((el) => el.scrollWidth > el.clientWidth),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}
test("screenshots for review", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1100 });
  await login(page);
  await page.screenshot({
    path: `${shots}/marquee-desktop.png`,
    fullPage: true,
  });
  await page
    .locator("#recent-section")
    .screenshot({ path: `${shots}/marquee-posters.png` });
  await page
    .locator("#calendar-section")
    .screenshot({ path: `${shots}/marquee-calendar.png` });
  await page.setViewportSize({ width: 393, height: 852 });
  await page.reload();
  await expect(page.locator("#recent .poster-card")).toHaveCount(6);
  await expect(page.locator(".entry").first()).toBeVisible();
  await page.screenshot({
    path: `${shots}/marquee-mobile.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 320, height: 640 });
  await page.reload();
  await expect(page.locator(".entry").first()).toBeVisible();
  await page.screenshot({ path: `${shots}/marquee-cover.png`, fullPage: true });
  expect(errors).toEqual([]);
});

test("shelf rows are not focus targets, so only the picked card can show a focus ring", async ({ page }) => {
  await login(page);
  const row = page.locator("#recent");
  expect(await row.evaluate((el) => el.tabIndex)).toBe(-1);
  const card = page.locator("#recent .recent-detail").nth(1);
  await card.click();
  await page.keyboard.press("Escape");
  expect(await row.evaluate((el) => el.matches(":focus, :focus-visible"))).toBe(false);
  expect(await page.locator("#recent :focus-visible").count()).toBeLessThanOrEqual(1);
});

test("library and calendar popups show the same facts panel as Seerr popups", async ({ page }) => {
  await login(page);
  const lookups = [];
  page.on("request", (r) => {
    if (/\/facts$|seerr\/details/.test(r.url())) lookups.push(r.url());
  });
  for (const selector of ["#recent .recent-detail", "#calendar [data-event]"]) {
    lookups.length = 0;
    await page.locator(selector).first().click();
    await expect(page.locator("#episode-facts .detail-fact").first()).toBeVisible();
    await expect(page.locator("#episode-facts .detail-score")).toHaveCount(4);
    expect(lookups).toHaveLength(1);
    await page.keyboard.press("Escape");
  }
  // A failed lookup just leaves the panel hidden.
  await page.route("**/api/library/*/facts", (route) =>
    route.fulfill({ json: { facts: null } }),
  );
  await view(page, "discover");
  await page.locator("#recent .recent-detail").nth(1).click();
  await expect(page.locator("#episode-detail")).toBeVisible();
  await expect(page.locator("#episode-facts")).toBeHidden();
});

test("popup overview sits under the title on desktop and stays in the body on phones", async ({ page }) => {
  await login(page);
  for (const [width, topVisible] of [[1440, true], [393, false]]) {
    await page.setViewportSize({ width, height: 900 });
    await page.locator("#calendar [data-event]").first().click();
    await expect(page.locator("#episode-overview-top")).toBeVisible({ visible: topVisible });
    await expect(page.locator("#episode-overview")).toBeVisible({ visible: !topVisible });
    if (topVisible) {
      // Overview follows the subtitle, meta and genre rows with no big gap.
      const gap = await page.evaluate(() => {
        const bottoms = ["#episode-subtitle", "#episode-meta-top", "#episode-genres-top"]
          .map((s) => document.querySelector(s).getBoundingClientRect())
          .filter((r) => r.height > 0)
          .map((r) => r.bottom);
        const top = document.querySelector("#episode-overview-top").getBoundingClientRect();
        return top.y - Math.max(...bottoms);
      });
      expect(gap).toBeGreaterThan(0);
      expect(gap).toBeLessThan(40);
    }
    await page.keyboard.press("Escape");
  }
});

test("login preview", async ({ page }) => {
  await page.route("**/api/config", (route) =>
    route.fulfill({ json: { demo: false, name: "Marquee" } }),
  );
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Sign in with Jellyfin" }),
  ).toBeVisible();
  await page.screenshot({ path: `${shots}/marquee-login.png` });
});

test("external titles are rendered as text, not executable markup", async ({
  page,
}) => {
  await page.route("**/api/recent", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: "x",
            title: "<img src=x onerror=alert(1)>",
            subtitle: "<script>alert(1)</script>",
            art: "placeholder",
          },
        ],
      },
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Explore demo" }).click();
  await expect(page.locator("#recent .poster-card h3")).toHaveText(
    "<img src=x onerror=alert(1)>",
  );
  await expect(page.locator(".poster-card h3 img")).toHaveCount(0);
  await expect(page.locator(".poster-card p script")).toHaveCount(0);
});

test("seerr routes require login", async ({ request }) => {
  for (const path of [
    "/api/seerr/search?query=x",
    "/api/seerr/image?path=/a.jpg",
    "/api/seerr/requests",
  ]) {
    expect((await request.get(path)).status()).toBe(401);
  }
  expect(
    (
      await request.post("/api/seerr/request", {
        data: { mediaType: "movie", mediaId: 1 },
      })
    ).status(),
  ).toBe(403); // no Origin header: blocked by the same-origin write guard before auth
});

test("demo search, request flow, requests list, and settings toggles", async ({
  page,
}) => {
  await login(page);
  await expect(page.locator("#requests-section .request-row")).toHaveCount(3);
  await view(page, "discover");
  await page.getByPlaceholder("Search movies and shows").fill("orbit");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator("#search-results .result-card h3")).toHaveText([
    "Orbit Nine",
  ]);
  await page
    .locator("#search-results")
    .getByRole("button", { name: "Request", exact: true })
    .click();
  await page.locator("#request-submit").click();
  await expect(
    page.locator("#search-results .result-card .poster-status"),
  ).toHaveAttribute("aria-label", "Processing");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator('[data-pref="requests"]').uncheck();
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(page.locator("#requests-section")).toBeHidden();
  await page.reload();
  await expect(page.locator("#requests-section")).toBeHidden();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator('[data-pref="requests"]').check();
  await page.locator('[data-pref="search"]').uncheck();
  await page.getByRole("button", { name: "Close settings" }).click();
  await view(page, "home");
  await expect(page.locator("#requests-section")).toBeVisible();
  await expect(page.locator("#search-section")).toBeHidden();
});

test("seerr titles are rendered as text, not executable markup", async ({
  page,
}) => {
  await page.route("**/api/seerr/search**", (route) =>
    route.fulfill({
      json: {
        results: [
          {
            id: 7,
            mediaType: "movie",
            title: "<img src=x onerror=alert(1)>",
            year: "2026",
            poster: null,
            overview: "<script>alert(1)</script>",
            availability: 1,
            requested: false,
          },
        ],
      },
    }),
  );
  await login(page);
  await view(page, "discover");
  await page.getByPlaceholder("Search movies and shows").fill("anything");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator("#search-results .result-card h3")).toHaveText(
    "<img src=x onerror=alert(1)>",
  );
  await expect(page.locator("#search-results .result-card h3 img")).toHaveCount(
    0,
  );
  await expect(page.locator(".result-overview script")).toHaveCount(0);
});

test("PWA manifest and service worker are served and linked", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    "href",
    "/manifest.webmanifest",
  );
  const manifest = await (await request.get("/manifest.webmanifest")).json();
  expect(manifest.name).toBe("Marquee");
  expect(manifest.display).toBe("standalone");
  expect(manifest.icons.length).toBe(4);
  for (const icon of manifest.icons) {
    const response = await request.get(icon.src);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("image/png");
  }
  expect((await request.get("/sw.js")).status()).toBe(200);
});

test("search section screenshot for review", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page);
  await view(page, "discover");
  await page.getByPlaceholder("Search movies and shows").fill("o");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator("#search-results .result-card")).toHaveCount(3);
  await page.mouse.move(0, 0);
  const section = page.locator("#search-section");
  await section.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const box = await section.boundingBox();
  await page.screenshot({
    path: `${shots}/marquee-search.png`,
    clip: {
      x: 0,
      y: Math.max(0, box.y - 10),
      width: 1440,
      height: Math.min(box.height + 20, 900),
    },
  });
  await view(page, "home");
  await page
    .locator("#requests-section")
    .screenshot({ path: `${shots}/marquee-requests.png` });
});

test("calendar remembers the last used view", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page);
  await page.getByRole("button", { name: "Agenda", exact: true }).click();
  await expect(page.locator('[data-view="agenda"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator("#calendar-title")).toContainText("-");
  await expect(page.locator(".agenda-view .entry").first()).toBeVisible();
  await page.reload();
  await expect(page.locator('[data-view="agenda"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "Week", exact: true }).click();
  await page.reload();
  await expect(page.locator('[data-view="week"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("hide-unmonitored filter drops unmonitored entries and persists", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page);
  await expect(
    page.locator(".entry").filter({ hasText: "After Hours" }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.locator("#hide-unmonitored").check();
  await expect(
    page.locator(".entry").filter({ hasText: "After Hours" }),
  ).toHaveCount(0);
  await expect(
    page.locator(".entry").filter({ hasText: "North of Nowhere" }).first(),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await expect(page.locator("#hide-unmonitored")).toBeChecked();
  await expect(
    page.locator(".entry").filter({ hasText: "After Hours" }),
  ).toHaveCount(0);
});

test("settings connection tests report results", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Jellyfin", exact: true }).click();
  await expect(page.locator("#connection-result")).toHaveText(
    "Jellyfin: connected.",
  );
  await expect(page.locator("#connection-result")).toHaveClass("conn-ok");
  await page.locator("#connection-result").scrollIntoViewIfNeeded();
  await page
    .locator("dialog#settings[open]")
    .first()
    .screenshot({ path: `${shots}/marquee-settings.png` })
    .catch(() => page.screenshot({ path: `${shots}/marquee-settings.png` }));
});

for (const width of [1440, 393, 320, 280]) {
  test(`search results are rows that fit at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await login(page);
    await view(page, "discover");
  await page.getByPlaceholder("Search movies and shows").fill("o");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.locator("#search-results .result-card")).toHaveCount(3);
    await page.waitForTimeout(400);
    const rows = await page.locator("#search-results .result-card").evaluateAll((cards) =>
      cards.map((c) => {
        const r = c.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, overflow: c.scrollWidth > c.clientWidth + 1 };
      }),
    );
    for (const row of rows) {
      expect(row.overflow).toBe(false);
      expect(row.left).toBeGreaterThanOrEqual(0);
      expect(row.right).toBeLessThanOrEqual(width);
    }
    for (let i = 1; i < rows.length; i++) expect(rows[i].top).toBeGreaterThanOrEqual(rows[i - 1].bottom);
  });
}

test("search footers stay aligned with long titles, missing overviews, and after requesting", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route("**/api/seerr/search**", (route) =>
    route.fulfill({
      json: {
        results: [
          {
            id: 81,
            mediaType: "movie",
            title: "Short title",
            poster: "orbit",
            availability: 1,
          },
          {
            id: 82,
            mediaType: "tv",
            title:
              "A much longer title that wraps onto multiple lines in a card",
            poster: "north",
            overview: "A long overview. ".repeat(30),
            availability: 2,
            requested: true,
          },
          {
            id: 83,
            mediaType: "movie",
            title: "In the library",
            poster: "hours",
            overview: "A short overview.",
            availability: 5,
          },
        ],
      },
    }),
  );
  await login(page);
  await view(page, "discover");
  await page.getByPlaceholder("Search movies and shows").fill("test");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator("#search-results .result-card")).toHaveCount(3);
  const centers = () =>
    page.locator("#search-results .result-action > *").evaluateAll((actions) =>
      actions.map((action) => {
        const box = action.getBoundingClientRect();
        return box.top + box.height / 2;
      }),
    );
  let values = await centers();
  expect(Math.max(...values) - Math.min(...values)).toBeLessThan(1);
  await page
    .locator("#search-results")
    .getByRole("button", { name: "Request", exact: true })
    .click();
  await page.locator("#request-submit").click();
  await expect(
    page.locator("#search-results .result-card .poster-status"),
  ).toHaveCount(3);
  values = await centers();
  expect(Math.max(...values) - Math.min(...values)).toBeLessThan(1);
});

for (const width of [1440, 393, 320, 280]) {
  test(`weather city picker and administrator name settings at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await login(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByPlaceholder("City name").fill("Sample");
    await page.getByRole("button", { name: "Find city", exact: true }).click();
    await page
      .getByRole("button", { name: "Sample City, Example Region", exact: true })
      .click();
    await page.locator("#weather-units").selectOption("celsius");
    await page.locator('[data-pref="weather"]').check();
    await expect(page.locator("#weather-content")).toContainText("20°C");
    await page.locator("#display-name").fill("Movie Room");
    await page.getByRole("button", { name: "Save name", exact: true }).click();
    await expect(page.locator("#display-name-status")).toHaveText(
      "Saved for everyone.",
    );
    await expect(page.locator(".masthead .app-name")).toHaveText("Movie Room");
    await page.locator("#weather-settings").scrollIntoViewIfNeeded();
    await page
      .locator("#settings")
      .screenshot({ path: `${shots}/marquee-settings-weather-${width}.png` });
    await page.locator("#display-name-settings").scrollIntoViewIfNeeded();
    await page
      .locator("#settings")
      .screenshot({ path: `${shots}/marquee-settings-name-${width}.png` });
    expect(
      await page
        .locator("#settings")
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await expect(page.locator("#weather-settings-status")).toHaveText(
      "Saved to your account.",
    );
    await page.getByRole("button", { name: "Close settings" }).click();
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await expect(page.locator("#weather-content")).toContainText("20°C");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.locator("#weather-city-selected")).toHaveText(
      "Sample City, Example Region",
    );
    await page.locator("#display-name").fill("Marquee");
    await page.getByRole("button", { name: "Save name", exact: true }).click();
    await expect(page.locator("#display-name-status")).toHaveText(
      "Saved for everyone.",
    );
  });
}

test("Seerr request buttons reflect movie/TV access and escape denial text", async ({
  page,
}) => {
  await page.route("**/api/me", (route) =>
    route.fulfill({
      json: {
        name: "Demo viewer",
        canRequest: true,
        isAdmin: false,
        requestAccess: {
          movie: true,
          tv: false,
          tvReason: "TV requests are not permitted by Seerr.",
        },
      },
    }),
  );
  await login(page);
  await view(page, "discover");
  await page.getByPlaceholder("Search movies and shows").fill("o");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator("#search-results .request-btn")).toHaveCount(1);
  await expect(page.locator("#search-results .request-unavailable")).toHaveCount(0);
  await page.evaluate(() => renderSearch([{ id: 444, mediaType: "tv", title: "New show", availability: 1 }]));
  await expect(page.locator("#search-results .request-unavailable")).toHaveText("TV requests are not permitted by Seerr.");
});

for (const width of [1440, 393, 320, 280]) {
  test(`chosen marquee logo renders in header and favicon at ${width}px`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    await login(page);
    const logo = page.locator(".masthead .brand-mark");
    await expect(logo).toHaveAttribute("src", "/icons/header-logo-96.png");
    expect(
      await logo.evaluate(
        (img) =>
          img.complete && img.naturalWidth === 112 && img.naturalHeight === 96,
      ),
    ).toBe(true);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `${shots}/marquee-logo-${width}.png` });
    await expect(
      page.locator('link[rel="icon"][type="image/png"]'),
    ).toHaveAttribute("href", "/favicon.png");
    expect((await request.get("/favicon.ico")).status()).toBe(200);
    await page.goto("/favicon.png");
    await page.screenshot({ path: `${shots}/marquee-favicon-${width}.png` });
  });
}

for (const width of [1440, 393, 320, 280]) {
  test(`episode details and premiere colors at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await login(page);
    await page.getByRole("button", { name: "Agenda", exact: true }).click();
    const premiere = page.locator(".entry.premiere").first();
    await expect(premiere).toBeVisible();
    await expect(premiere.locator(".entry-status")).toContainText(
      "Season premiere",
    );
    expect(await premiere.evaluate((el) => getComputedStyle(el).color)).toBe(
      "rgb(239, 207, 114)",
    );
    const episode = premiere; // Select a verified TV event, not a date-dependent first movie.
    await episode.click();
    const modal = page.locator("#episode-detail");
    await expect(modal).toBeVisible();
    await expect(page.locator("#episode-title")).toContainText("(2026)");
    await expect(page.locator("#episode-subtitle")).toContainText("S");
    await expect(page.locator("#episode-genres")).toContainText("Adventure");
    await expect(page.locator("#episode-meta")).toContainText("48 min");
    await expect(page.locator("#episode-network")).toHaveText("Network · Sample Network");
    await expect(page.locator("#episode-trailer")).toHaveAttribute(
      "href",
      /youtube.com\/results\?search_query=/,
    );
    expect(await modal.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
      true,
    );
    await modal.screenshot({ path: `${shots}/marquee-episode-${width}.png` });
    await page.getByRole("button", { name: "Close episode details" }).click();
    await expect(modal).not.toBeVisible();
    await episode.focus();
    await page.keyboard.press("Enter");
    await expect(modal).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(modal).not.toBeVisible();
  });
}

for (const width of [1440, 393, 320, 280]) {
  test(`popular poster rows at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await login(page);
    await expect(page.locator("#popular-movies .result-card")).toHaveCount(10);
    await expect(page.locator("#popular-tv .result-card")).toHaveCount(10);
    await expect(page.locator("#popular-movies .poster-status").first()).toHaveAttribute("aria-label", "In your library");
    await expect(page.locator("#popular-movies .row-cert")).toHaveCount(0);
    await expect(page.locator("#popular-tv .row-cert")).toHaveCount(0);
    for (const meta of await page.locator("#popular-section .result-meta").allTextContents()) expect(meta).not.toMatch(/Available|Processing|Requested/);
    await expect(page.locator("#popular-movies .result-meta").first()).toHaveText("Movie · 2026");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page
      .locator("#popular-section")
      .screenshot({ path: `${shots}/marquee-popular-${width}.png` });
  });
}

test("broken episode artwork falls back to the solid hero without a broken image icon", async ({
  page,
}) => {
  await page.route("**/api/calendar?**", (route) =>
    route.fulfill({
      json: {
        events: [
          {
            id: "broken",
            type: "tv",
            title: "Sample",
            subtitle: "S01E01",
            date: new Date().toISOString(),
            status: "upcoming",
            backdrop: "/api/calendar-image/broken",
          },
        ],
        warnings: [],
      },
    }),
  );
  await page.route("**/api/calendar-image/broken", (route) =>
    route.fulfill({ status: 404 }),
  );
  await login(page);
  await page.locator(".entry[data-event]").first().click();
  await expect(page.locator("#episode-detail")).toBeVisible();
  await expect(page.locator("#episode-backdrop")).toBeHidden();
  await page
    .locator("#episode-detail")
    .screenshot({ path: `${shots}/marquee-episode-fallback.png` });
});

test("top ten collapse and settings hiding persist", async ({ page }) => {
  await login(page);
  await page.locator("#popular-collapse").click();
  await expect(page.locator("#popular-content")).toBeHidden();
  await page
    .locator("#popular-section")
    .screenshot({ path: `${shots}/marquee-popular-collapsed.png` });
  await page.reload();
  await expect(page.locator("#popular-collapse")).toHaveAttribute(
    "aria-label",
    "Expand popular titles",
  );
  await page.locator("#popular-collapse").click();
  await expect(page.locator("#popular-content")).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator('[data-pref="popular"]').uncheck();
  await expect(page.locator("#popular-section")).toBeHidden();
});

test("top ten posters respond to desktop hover", async ({ page }) => {
  await login(page);
  const card = page.locator("#popular-movies .ranked-poster").first();
  await card.hover();
  await expect
    .poll(() =>
      card.locator("img").evaluate((el) => getComputedStyle(el).transform),
    )
    .not.toBe("none");
  await page
    .locator("#popular-section")
    .screenshot({ path: `${shots}/marquee-popular-hover.png` });
});

for (const width of [1440, 393, 280]) {
  test(`top-ten popup details at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await login(page);
    await page.locator("#popular-movies [data-detail-id]").first().click();
    await expect(page.locator("#episode-detail")).toBeVisible();
    await expect(page.locator("#episode-subtitle")).not.toContainText("Movie");
    await expect(page.locator("#episode-meta")).toContainText("Sample Network");
    await page
      .locator("#episode-detail")
      .screenshot({ path: `${shots}/marquee-popular-popup-${width}.png` });
    await page.keyboard.press("Escape");
    await page.locator("#popular-tv [data-detail-id]").first().focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#episode-subtitle")).toHaveText("TV series");
  });
}

test("weather refreshes on a 15-minute timer and stops when disabled", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByPlaceholder("City name").fill("Sample");
  await page.getByRole("button", { name: "Find city", exact: true }).click();
  await page
    .getByRole("button", { name: "Sample City, Example Region", exact: true })
    .click();
  await page.locator('[data-pref="weather"]').check();
  await expect(page.locator("#weather-content")).toContainText("68°F");
  await page.clock.install();
  await page.evaluate(() => scheduleWeather());
  let calls = 0;
  page.on("request", (req) => {
    if (req.url().includes("/api/weather?")) calls++;
  });
  await page.clock.fastForward(15 * 60 * 1000);
  await expect.poll(() => calls).toBe(1);
  await page.locator('[data-pref="weather"]').uncheck();
  await page.clock.fastForward(30 * 60 * 1000);
  expect(calls).toBe(1);
});

test("shared queue is titled Requests and keeps requester names", async ({
  page,
}) => {
  await login(page);
  await view(page, "home");
  await expect(page.locator("#requests-section h2")).toHaveText("Requests");
  await expect(page.locator(".request-row").first()).toContainText("by");
  await view(page, "home");
  await page
    .locator("#requests-section")
    .screenshot({ path: `${shots}/marquee-shared-requests.png` });
});

for (const width of [1440, 393, 280]) {
  test(`chevron collapse at ${width}px hides shelves and expands with keyboard`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await login(page);
    const toggle = page.getByRole("button", {
      name: "Collapse popular titles",
    });
    await toggle.click();
    await expect(page.locator("#popular-movies")).toBeHidden();
    await expect(page.locator("#popular-tv")).toBeHidden();
    await expect(page.locator("#popular-collapse")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await page
      .locator("#popular-section")
      .screenshot({ path: `${shots}/marquee-chevron-collapsed-${width}.png` });
    await page.keyboard.press("Enter");
    await expect(page.locator("#popular-movies")).toBeVisible();
    await page
      .locator(".popular-heading")
      .screenshot({ path: `${shots}/marquee-chevron-expanded-${width}.png` });
  });
}
test("installed service worker replaces stale cached styles with network version", async ({
  page,
}) => {
  await login(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise((resolve) =>
        navigator.serviceWorker.addEventListener("controllerchange", resolve, {
          once: true,
        }),
      );
    const cache = await caches.open("marquee-v5");
    await cache.put(
      "/style.css",
      new Response("/* stale marker */", {
        headers: { "Content-Type": "text/css" },
      }),
    );
    await cache.put(
      "/app.js",
      new Response("/* stale handler */", {
        headers: { "Content-Type": "application/javascript" },
      }),
    );
  });
  await page.reload();
  await expect(page.locator("#popular-collapse")).toBeVisible();
  await page.locator("#popular-collapse").click();
  await expect(page.locator("#popular-content")).toBeHidden();
  const css = await page.evaluate(async () =>
    (await fetch("/style.css")).text(),
  );
  expect(css).not.toContain("stale marker");
  expect(css).toContain(".popular-heading");
});

for (const width of [1440, 393, 280]) {
  test(`search poster opens shared movie/TV details at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await login(page);
    await view(page, "discover");
  await page.getByPlaceholder("Search movies and shows").fill("Signal");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page
      .locator('#search-results [data-detail-type="movie"]')
      .first()
      .click();
    await expect(page.locator("#episode-subtitle")).not.toContainText("Movie");
    await page
      .locator("#episode-detail")
      .screenshot({ path: `${shots}/marquee-search-popup-${width}.png` });
    await page.keyboard.press("Escape");
    await view(page, "discover");
  await page.getByPlaceholder("Search movies and shows").fill("North");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page
      .locator('#search-results [data-detail-type="tv"]')
      .first()
      .focus();
    await page.keyboard.press(" ");
    await expect(page.locator("#episode-subtitle")).toHaveText("TV series");
    await expect(page.locator("#episode-detail")).toBeVisible();
  });
}

for (const width of [1440, 1660, 393, 280]) {
  test(`denser poster preview at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.route("**/api/recent", async (route) => {
      const data = await (await route.fetch()).json();
      const original = data.items;
      data.items = Array.from({ length: 18 }, (_, i) => ({
        ...original[i % original.length],
        id: `synthetic-${i}`,
      }));
      await route.fulfill({ json: data });
    });
    await page.addInitScript(() => localStorage.setItem("marquee:Demo viewer:preferences", JSON.stringify({ search: true, watchNext: false, personalShelvesReset:true,continueWatching:false,nextUp:false,requests:true,libraryStats:false })));
    await page.goto("/");
    await page.getByRole("button", { name: "Explore demo" }).click();
    await expect(page.locator(".poster-card")).toHaveCount(18);
    const count = await page.locator(".poster-card").evaluateAll((cards) => {
      const right = document
        .querySelector("#recent.poster-row")
        .getBoundingClientRect().right;
      return cards.filter(
        (card) => card.getBoundingClientRect().right <= right + 1,
      ).length;
    });
    if (width >= 1200) expect(count).toBe(7);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await page
      .locator("#recent-section")
      .screenshot({ path: `${shots}/marquee-density-recent-${width}.png` });
    await page
      .locator("#popular-section")
      .screenshot({ path: `${shots}/marquee-density-popular-${width}.png` });
  });
}

for (const width of [1440, 393, 280]) {
  test(`recent popup uses exact media deep link at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.route("**/api/recent", async (route) => {
      const data = await (await route.fetch()).json();
      data.items[0].link =
        "https://media.example.test/web/index.html#!/details?id=actual-episode";
      data.items[0].detail = {
        title: "The Last Signal",
        year: "2026",
        subtitle: "Episode 4: Arrival",
        overview: "A fictional journey begins.",
        genres: ["Adventure"],
        runtime: 42,
      };
      await route.fulfill({ json: data });
    });
    await login(page);
    await page.locator(".recent-detail").first().click();
    await expect(page.locator("#episode-detail")).toBeVisible();
    await expect(page.locator("#episode-play")).toHaveAttribute(
      "href",
      "https://media.example.test/web/index.html#!/details?id=actual-episode",
    );
    await page
      .locator("#episode-detail")
      .screenshot({ path: `${shots}/marquee-recent-popup-${width}.png` });
    await page.keyboard.press("Escape");
    await page.locator("#popular-movies [data-detail-id]").first().click();
    await expect(page.locator("#episode-play")).toBeHidden();
    await expect(page.locator("#episode-play")).not.toHaveAttribute("href");
  });
}

for (const width of [1440, 393, 320, 280]) {
  test(`atmosphere popup preserves poster and fallback at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await login(page);
    await expect(page.locator('[data-view="agenda"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page
      .locator("#calendar-section")
      .screenshot({ path: `${shots}/marquee-agenda-default-${width}.png` });
    await page.locator(".recent-detail").first().click();
    await expect(page.locator("#episode-poster")).toBeVisible();
    await expect(page.locator("#episode-backdrop")).toBeVisible();
    await page.locator("#episode-poster").evaluate((img) => img.decode());
    expect(
      await page
        .locator("#episode-poster")
        .evaluate((img) => getComputedStyle(img).objectFit),
    ).toBe("contain");
    expect(
      await page
        .locator("#episode-detail")
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await page
      .locator("#episode-detail")
      .screenshot({ path: `${shots}/marquee-atmosphere-final-${width}.png` });
    await page.locator("#episode-close").click();
    await page.route("**/broken-backdrop", (route) =>
      route.fulfill({ status: 404 }),
    );
    await page.evaluate(() =>
      showDetail({
        title: "Fictional landscape test",
        subtitle: "Episode 4",
        poster: "/art/north.svg",
        backdrop: "/broken-backdrop",
      }),
    );
    await expect(page.locator("#episode-backdrop")).toHaveAttribute(
      "src",
      "/art/north.svg",
    );
    await expect(page.locator("#episode-poster")).toBeVisible();
  });
}

for (const width of [1440, 393, 280]) {
  test(`card scores have no source label and remain hideable at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.route("**/api/recent", (route) =>
      route.fulfill({
        json: {
          items: [
            {
              id: "fictional",
              title: "North of Nowhere",
              subtitle: "Season 1 · Episode 4",
              art: "north",
              rating: { value: 8.2, source: "Jellyfin community" },
              detail: {
                rating: { value: 8.2, source: "Jellyfin community" },
                genres: ["Drama"],
                runtime: 42,
              },
            },
          ],
        },
      }),
    );
    await page.goto("/");
    await page.getByRole("button", { name: "Explore demo" }).click();
    await expect(page.locator("#recent .media-rating")).toHaveText(
      "★ 8.2/10",
    );
    await page
      .locator("#recent-section")
      .screenshot({ path: `${shots}/marquee-ratings-card-${width}.png` });
    await page.locator(".recent-detail").click();
    await expect(page.locator("#episode-rating")).toHaveText(
      "★ 8.2/10",
    );
    await page
      .locator("#episode-detail")
      .screenshot({ path: `${shots}/marquee-ratings-popup-${width}.png` });
    await page.locator("#episode-close").click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.locator('[data-pref="ratings"]').uncheck();
    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(page.locator("#recent .media-rating")).toBeHidden();
    await page.locator(".recent-detail").click();
    await expect(page.locator("#episode-rating")).toBeHidden();
    await page.evaluate(() =>
      showDetail({ title: "No score", subtitle: "Movie" }),
    );
    await expect(page.locator("#episode-rating")).toHaveText("");
  });
}

for (const width of [1440, 393, 280]) {
  test(`all shelf arrows follow desktop-only policy ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await login(page);
    for (const selector of [".recent-controls", ".shelf-controls"]) {
      for (const el of await page.locator(selector).all())
        await expect(el)[width > 600 ? "toBeVisible" : "toBeHidden"]();
    }
    await page
      .locator("#popular-section")
      .screenshot({ path: `${shots}/marquee-shelf-arrows-${width}.png` });
    if (width > 600) {
      await page
        .getByRole("button", { name: "Next popular movies", exact: true })
        .click();
      await expect
        .poll(() =>
          page.locator("#popular-movies").evaluate((el) => el.scrollLeft),
        )
        .toBeGreaterThan(0);
      await page
        .getByRole("button", { name: "Previous popular movies", exact: true })
        .click();
      await expect
        .poll(() =>
          page.locator("#popular-movies").evaluate((el) => el.scrollLeft),
        )
        .toBe(0);
    }
  });
}
for (const width of [1440, 393, 320, 280]) {
  test(`accessibility requests footer and shortcut at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.route("**/api/me", (route) =>
      route.fulfill({
        json: {
          name: "Demo",
          isAdmin: true,
          canRequest: true,
          requestAccess: { movie: true, tv: true },
          jellyfinWebUrl: "https://media.example.test/",
        },
      }),
    );
    await login(page);
    await expect(page.locator("#jellyfin-home")).toHaveAttribute(
      "href",
      "https://media.example.test/",
    );
    await expect(page.locator("#jellyfin-home")).toHaveAttribute(
      "target",
      "_blank",
    );
    await page
      .locator(".masthead")
      .screenshot({ path: `${shots}/marquee-shortcut-${width}.png` });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.locator('[data-pref="colorblind"]')).not.toBeChecked();
    await page.locator('[data-pref="colorblind"]').check();
    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(page.locator("body")).toHaveClass("colorblind");
    await page
      .locator("#calendar-section")
      .screenshot({ path: `${shots}/marquee-colorblind-${width}.png` });
    await view(page, "home");
  await page.locator("#requests [data-detail-id]").first().focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#episode-detail")).toBeVisible();
    await expect(page.locator("#episode-poster")).toBeVisible();
    await expect(page.locator("#episode-play")).toBeHidden();
    await page
      .locator("#episode-detail")
      .screenshot({ path: `${shots}/marquee-request-popup-${width}.png` });
    await page.locator("#episode-close").click();
    await expect(page.locator("footer")).toContainText(
      "Your Media. Your Server. Your Way.",
    );
    await page
      .locator("footer")
      .screenshot({ path: `${shots}/marquee-footer-${width}.png` });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.reload();
    await expect(page.locator("body")).toHaveClass("colorblind");
  });
}

test("blue orange accessibility palette applies to every calendar view", async ({
  page,
}) => {
  const events = [
    ["cinema", "In cinemas"],
    ["available", "Available"],
    ["missing", "Missing"],
    ["upcoming", "Upcoming"],
    ["unreleased", "Unreleased"],
    ["premiere", "Season premiere"],
  ].map(([status, title], i) => ({
    id: `palette-${i}`,
    type: "tv",
    title,
    subtitle: "Sample episode",
    date: "2026-10-08T20:00:00Z",
    status: status === "premiere" ? "upcoming" : status,
    premiere: status === "premiere",
  }));
  await page.clock.setFixedTime(new Date("2026-10-08T12:00:00Z"));
  await page.route("**/api/calendar?**", (route) =>
    route.fulfill({ json: { events, warnings: [] } }),
  );
  await login(page);
  const normal = await page
    .locator(".entry.available")
    .evaluate((el) => getComputedStyle(el).color);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator('[data-pref="colorblind"]').check();
  await page.getByRole("button", { name: "Close settings" }).click();
  const colors = {
    cinema: "rgb(169, 199, 255)",
    available: "rgb(36, 168, 255)",
    missing: "rgb(255, 180, 91)",
    upcoming: "rgb(244, 245, 247)",
    unreleased: "rgb(150, 147, 139)",
    premiere: "rgb(255, 230, 107)",
  };
  expect(normal).not.toBe(colors.available);
  for (const view of ["Agenda", "Month", "Week", "Day", "List"]) {
    await page.getByRole("button", { name: view, exact: true }).click();
    for (const [status, color] of Object.entries(colors)) {
      expect(
        await page
          .locator(
            `#calendar .entry.${status}${status === "upcoming" ? ":not(.premiere)" : ""}`,
          )
          .first()
          .evaluate((el) => getComputedStyle(el).color),
      ).toBe(color);
      expect(
        await page
          .locator(`#calendar-section .legend .${status}`)
          .evaluate((el) => getComputedStyle(el).color),
      ).toBe(color);
    }
    await page.locator("#calendar-section").screenshot({
      path: `${shots}/marquee-deuteran-${view.toLowerCase()}.png`,
    });
  }
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator('[data-pref="colorblind"]').uncheck();
  await page.getByRole("button", { name: "Close settings" }).click();
  expect(
    await page
      .locator(".entry.available")
      .first()
      .evaluate((el) => getComputedStyle(el).color),
  ).toBe(normal);
});

for (const width of [393, 320, 280]) {
  test(`mobile form controls keep 16px text and zoom access at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 852 });
    await page.route("**/api/config", (route) =>
      route.fulfill({ json: { demo: false, name: "Marquee" } }),
    );
    await page.goto("/");
    const viewport = await page
      .locator('meta[name="viewport"]')
      .getAttribute("content");
    expect(viewport).not.toMatch(/maximum-scale|user-scalable\s*=\s*(no|0)/i);
    for (const input of await page.locator("#login-form input").all()) {
      expect(
        await input.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
      ).toBeGreaterThanOrEqual(16);
      await input.focus();
    }
    await page
      .locator("#login")
      .screenshot({ path: `${shots}/marquee-login-16px-${width}.png` });
    await page.unroute("**/api/config");
    await login(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    for (const input of await page.locator("input, select, textarea").all()) {
      expect(
        await input.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
      ).toBeGreaterThanOrEqual(16);
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page
      .locator("#settings")
      .screenshot({ path: `${shots}/marquee-settings-16px-${width}.png` });
  });
}

for (const width of [1440, 393, 320, 280]) {
  test(`content rating badge is readable and clears missing data at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await login(page);
    await page.evaluate(() =>
      showDetail({
        title: "Fictional Film",
        subtitle: "Movie",
        cast: ["Alex Sample", "Morgan Example", "Casey Demo", "Jamie Fiction"],
        contentRating: "PG-13",
        contentRatingRegion: "US",
        poster: "/art/north.svg",
        backdrop: "/art/north.svg",
        genres: ["Adventure"],
        runtime: 104,
        overview: "A fictional journey begins.",
        playLink: "https://media.example.test/",
      }),
    );
    await expect(page.locator("#episode-cast")).toContainText(
      "Cast: Alex Sample",
    );
    await expect(page.locator("#episode-content-rating")).toHaveText("PG-13");
    await expect(page.getByRole("link", { name: "Find trailer on YouTube", exact: true })).toBeVisible();
    expect(await page.locator("#episode-trailer img").evaluate(el => el.complete && el.naturalWidth > 0)).toBe(true);
    await expect(page.locator("#episode-content-rating")).toHaveAttribute(
      "title",
      "Content rating (US)",
    );
    expect(
      await page
        .locator("#episode-detail")
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await page
      .locator("#episode-detail")
      .screenshot({ path: `${shots}/marquee-content-rating-${width}.png` });
    await page.locator("#episode-close").click();
    await page.evaluate(() =>
      showDetail({ title: "Unknown rating", subtitle: "Movie" }),
    );
    await expect(page.locator("#episode-cast")).toBeHidden();
    await expect(page.locator("#episode-content-rating")).toBeHidden();
    await expect(page.locator("#episode-content-rating")).toHaveText("");
  });
}

for (const width of [1440, 393, 320, 280]) {
  test(`top ten popup requests use the same confirmed flow at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await login(page);
    const card = page
      .locator("#popular-section .result-card")
      .filter({ has: page.locator("[data-request]") })
      .first();
    await card.locator("[data-detail-id]").click();
    await expect(page.locator("#episode-request")).toBeVisible();
    await expect(page.locator("#episode-play")).toBeHidden();
    await page
      .locator("#episode-detail")
      .screenshot({ path: `${shots}/marquee-popup-request-${width}.png` });
    await page.locator("#episode-request").click();
    await page.locator("#request-submit").click();
    await expect(page.locator("#episode-request-status")).toHaveText(
      "Requested",
    );
    await expect(page.locator("#episode-request")).toBeHidden();
    await page.locator("#episode-close").click();
    const owned = page
      .locator("#popular-section .result-card")
      .filter({ has: page.locator('.poster-status[aria-label="In your library"]') })
      .first();
    await owned.locator("[data-detail-id]").click();
    await expect(page.locator("#episode-request")).toBeHidden();
  });
}

for (const width of [1440, 393, 320, 280]) {
  test(`request states agree in cards and popup at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await login(page);
    for (const mediaType of ["movie", "tv"]) {
      for (const [availability, requested, label] of [[2, false, "Pending"], [3, false, "Processing"], [4, false, "Partially available"], [5, false, "In your library"], [null, true, "Requested"]]) {
        await page.evaluate(({ mediaType, availability, requested }) => {
          const item = { id: 42, mediaId: 42, mediaType, availability, requested, title: "Fictional Processing Film", subtitle: "Movie", poster: "north" };
          document.querySelector("#search-results").innerHTML = resultCardHtml(item, true);
          showDetail({ ...item, poster: "/art/north.svg" });
        }, { mediaType, availability, requested });
        await expect(page.locator("#search-results .result-action")).toHaveText("");
        await expect(page.locator("#search-results .poster-status")).toHaveAttribute("aria-label", label);
        await expect(page.locator("#search-results [data-request]")).toHaveCount(0);
        await expect(page.locator("#episode-request")).toBeHidden();
        await expect(page.locator("#episode-poster-status .poster-status")).toHaveAttribute("aria-label", label);
        if (availability === 3 && mediaType === "movie") {
          await page.locator("#episode-detail").screenshot({ path: `${shots}/marquee-processing-popup-${width}.png` });
          await page.locator("#episode-close").click();
  await view(page, "discover");
          await page.locator("#search-results .result-card").screenshot({ path: `${shots}/marquee-processing-card-${width}.png` });
        } else await page.locator("#episode-close").click();
      }
    }
    await page.evaluate(() => showDetail({ mediaType: "movie", mediaId: 42, title: "New film", availability: 1, requested: false }));
    await expect(page.locator("#episode-request")).toBeVisible();
    await expect(page.locator("#episode-poster-status .poster-status")).toHaveCount(0);
  });
}

for (const width of [1440, 393]) {
  test(`status icon gallery preview at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await login(page);
    await page.evaluate(() => {
      const items = [
        { availability: 5, title: "In the library" },
        { availability: 3, title: "Processing film" },
        { availability: 2, title: "Pending approval" },
        { availability: 4, title: "Partial series" },
        { availability: 1, title: "New film" },
      ];
      document.querySelector("#popular-movies").innerHTML = items.map((item, i) => `<div class="ranked-poster"><span class="popular-rank">${i + 1}</span>${resultCardHtml({ ...item, id: 60 + i, mediaType: "movie", poster: ["north", "signal", "orbit", "hours", "coast"][i] })}</div>`).join("");
    });
    await page.locator("#popular-section").screenshot({ path: `${shots}/marquee-status-icons-${width}.png` });
  });
}

for (const width of [1440,393,320,280]) {
  test(`Seerr facts panel preview and missing-data reset at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height:1000 });
    await login(page);
    await page.evaluate(() => showDetail({ title:"Fictional Film", subtitle:"Movie", poster:"/art/north.svg", backdrop:"/art/north.svg", genres:["Adventure"], contentRating:"PG-13", runtime:104, cast:["Alex Sample","Morgan Example"], overview:"A fictional journey begins.", facts:{status:"Released",originalLanguage:"en",productionCountries:[{code:"US",name:"United States"},{code:"GB",name:"United Kingdom"}],scores:{critics:90,audience:97,imdb:8,tmdb:83},releases:[{type:"Theatrical",date:"2026-07-31",region:"US"},{type:"Digital",date:"2026-10-06",region:"US"},{type:"Physical",date:"2026-12-15",region:"US"}]}}));
    await expect(page.locator("#episode-facts")).toContainText("Released");
    await expect(page.locator("#episode-facts")).toContainText("Jul 31, 2026");
    await expect(page.locator("#episode-facts")).toContainText("English");
    expect(await page.locator(".release-label").first().evaluate(el => {
      const icon=el.firstElementChild.getBoundingClientRect(), label=el.lastElementChild.getBoundingClientRect();
      return label.left-icon.right <= 7 && Math.abs((label.top+label.height/2)-(icon.top+icon.height/2))<2;
    })).toBe(true);
    await expect(page.locator('#episode-facts [title="United States"]')).toBeVisible();
    expect(await page.locator("#episode-detail").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.locator("#episode-detail").screenshot({path:`${shots}/marquee-facts-${width}.png`});
    await page.locator("#episode-close").click();
    await page.evaluate(() => showDetail({title:"Library title",subtitle:"Movie"}));
    await expect(page.locator("#episode-facts")).toBeHidden();
    await expect(page.locator("#episode-facts")).toHaveText("");
  });
}

test("desktop popup puts meta and genres under the title and clamps long overviews; phones keep the body layout", async ({ page }) => {
  await page.route("**/api/recent", async (route) => {
    const res = await route.fetch();
    const data = await res.json();
    const long = "A long overview sentence that keeps going to test clamping. ".repeat(14);
    for (const item of data.items) item.detail.overview = long;
    await route.fulfill({ response: res, json: data });
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page);
  await view(page, "discover");
  await page.locator("#recent .recent-detail").first().click();
  await expect(page.locator("#episode-genres-top")).toBeVisible();
  await expect(page.locator("#episode-meta-top")).toBeVisible();
  await expect(page.locator("#episode-genres")).toBeHidden();
  const more = page.locator("#episode-more");
  await expect(more).toBeVisible();
  const clamped = await page.locator("#episode-overview-top").evaluate((el) => el.clientHeight);
  await more.click();
  await expect(more).toHaveText("Less");
  expect(await page.locator("#episode-overview-top").evaluate((el) => el.clientHeight)).toBeGreaterThan(clamped);
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 393, height: 850 });
  await view(page, "discover");
  await page.locator("#recent .recent-detail").first().click();
  await expect(page.locator("#episode-genres")).toBeVisible();
  await expect(page.locator("#episode-meta")).toBeVisible();
  await expect(page.locator("#episode-genres-top")).toBeHidden();
  await expect(page.locator("#episode-more")).toBeHidden();
});

test("facts panel uses real images and SVG icons instead of emoji, so nothing depends on emoji fonts", async ({ page }) => {
  await login(page);
  await view(page, "discover");
  await page.locator("#recent .recent-detail").first().click();
  const flags = page.locator("#episode-facts .country-flags img.flag");
  await expect(flags.first()).toBeVisible();
  await expect.poll(() => flags.evaluateAll((imgs) => imgs.filter((i) => !i.complete || i.naturalWidth === 0).length)).toBe(0);
  const text = await page.locator("#episode-facts").innerText();
  expect(text).not.toMatch(/[\u{1F000}-\u{1FFFF}\u2600-\u27BF]/u);
  await expect(page.locator("#episode-facts .score-mark svg").first()).toBeVisible();
  await expect(page.locator("#episode-facts .release-label svg").first()).toBeVisible();
  expect((await page.request.get("/flags/us.svg")).status()).toBe(200);
  expect((await page.request.get("/flags/zz.svg")).status()).toBe(404);
});

test("calendar movie entries open the same popup with a facts panel", async ({ page }) => {
  await login(page);
  const movie = page.locator("#calendar .entry.cinema, #calendar .entry.unreleased, #calendar .entry.available").filter({ hasText: /Orbit Nine|The Last Signal/ }).first();
  await expect(movie).toHaveAttribute("role", "button");
  await movie.click();
  await expect(page.locator("#episode-detail")).toBeVisible();
  await expect(page.locator("#episode-title")).toContainText(/Orbit Nine|The Last Signal/);
  await expect(page.locator("#episode-facts")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#episode-detail")).toBeHidden();
});

test("search is live: results follow typing after a pause, stale answers are ignored", async ({ page }) => {
  const seen = [];
  await page.route("**/api/seerr/search*", async (route) => {
    const q = new URL(route.request().url()).searchParams.get("query");
    seen.push(q);
    // The first query answers slowly, so it must not overwrite the newer one.
    if (q === "or") await new Promise((r) => setTimeout(r, 1200));
    const res = await route.fetch();
    await route.fulfill({ response: res }).catch(() => {});
  });
  await login(page);
  const box = page.getByPlaceholder("Search movies and shows");
  await box.pressSequentially("or", { delay: 20 });
  await page.waitForTimeout(350);
  await box.pressSequentially("bit", { delay: 20 });
  await expect(page.locator("#search-results .result-card h3").first()).toContainText(/orbit/i);
  await page.waitForTimeout(1500);
  await expect(page.locator("#search-results .result-card h3").first()).toContainText(/orbit/i);
  expect(seen).toEqual(["or", "orbit"]);
  await box.fill("");
  await expect(page.locator("#search-results .result-card")).toHaveCount(0);
});

test("weather forecast shows five readable day tiles on phones", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 900 });
  await login(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByPlaceholder("City name").fill("Sample");
  await page.getByRole("button", { name: "Find city", exact: true }).click();
  await page.getByRole("button", { name: "Sample City, Example Region", exact: true }).click();
  await page.locator('[data-pref="weather"]').check();
  await page.getByRole("button", { name: "Close settings" }).click();
  const days = page.locator("#weather-forecast .forecast-day");
  await expect(days).toHaveCount(5);
  expect(await days.first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(14);
  const boxes = await days.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().right));
  expect(Math.max(...boxes)).toBeLessThanOrEqual(393);
});

for (const width of [1440, 393]) {
  test(`request dialog: season picker and advanced options at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await login(page);
    await view(page, "discover");
  await page.getByPlaceholder("Search movies and shows").fill("harbor");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    let body = null;
    await page.route("**/api/seerr/request", async (route) => {
      body = route.request().postDataJSON();
      await route.continue();
    });
  await view(page, "discover");
    await page.locator("#search-results").getByRole("button", { name: "Request", exact: true }).first().click();
    const dialog = page.locator("dialog#request-dialog[open]");
    await expect(dialog.locator(".season-row input[data-season]")).toHaveCount(3);
    await expect(dialog.locator('input[data-season="1"]')).toBeDisabled();
    await expect(dialog.locator(".season-pill").first()).toHaveText("Available");
    await expect(dialog.locator('input[data-season="2"]')).toBeChecked();
    await dialog.locator("summary").click();
    await expect(dialog.locator("#request-profile")).toHaveValue("2");
    await expect(dialog.locator("#request-root")).toHaveValue("/tv");
    const box = await dialog.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `${shots}/marquee-request-dialog-${width}.png` });
    await dialog.locator('input[data-season="3"]').uncheck();
    await dialog.locator("#request-profile").selectOption("3");
    await dialog.locator("#request-submit").click();
    await expect.poll(() => body).toEqual({
      mediaType: "tv", mediaId: 105, seasons: [2],
      serverId: 1, profileId: 3, rootFolder: "/tv",
    });
  });
}

test("request dialog can be cancelled and needs a season", async ({ page }) => {
  await login(page);
  await view(page, "discover");
  await page.getByPlaceholder("Search movies and shows").fill("harbor");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await view(page, "discover");
  await page.locator("#search-results").getByRole("button", { name: "Request", exact: true }).first().click();
  const dialog = page.locator("dialog#request-dialog[open]");
  await dialog.locator('input[data-season="2"]').uncheck();
  await dialog.locator('input[data-season="3"]').uncheck();
  await expect(dialog.locator("#request-submit")).toBeDisabled();
  await dialog.locator("#request-cancel").click();
  await expect(page.locator("dialog#request-dialog[open]")).toHaveCount(0);
  await expect(page.locator("#search-results .result-card .request-btn").first()).toBeVisible();
});

for (const width of [1440, 393]) {
  test(`settings shows who is signed in at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await login(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const card = page.locator("#settings-user");
    await expect(card).toBeVisible();
    await expect(page.locator("#settings-username")).not.toHaveText("");
    await expect(page.locator("#settings-avatar")).toHaveText(/^\S$/);
    const box = await card.boundingBox();
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    await page.locator("#settings").screenshot({ path: `${shots}/marquee-settings-user-${width}.png` });
  });
}

test("request dialog still lets you request when the options cannot load", async ({ page }) => {
  await login(page);
  await view(page, "discover");
  await page.getByPlaceholder("Search movies and shows").fill("harbor");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.route("**/api/seerr/request-options*", (route) =>
    route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "Seerr could not be reached. boom" }) }),
  );
  let body = null;
  await page.route("**/api/seerr/request", async (route) => {
    body = route.request().postDataJSON();
    await route.continue();
  });
  await view(page, "discover");
  await page.locator("#search-results").getByRole("button", { name: "Request", exact: true }).first().click();
  const dialog = page.locator("dialog#request-dialog[open]");
  await expect(dialog.locator("#request-status")).toContainText("boom");
  await expect(dialog.locator("#request-submit")).toBeEnabled();
  await dialog.locator("#request-submit").click();
  await expect.poll(() => body).toEqual({ mediaType: "tv", mediaId: 105 });
});

for (const width of [1440, 393]) {
  test(`search redesign preview at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width > 500 ? 900 : 850 });
    await login(page);
    await view(page, "discover");
  await page.getByPlaceholder("Search movies and shows").fill("o");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.locator("#search-results .result-card")).toHaveCount(3);
    await expect(page.locator("#search-results .row-cert")).toHaveCount(3);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${shots}/marquee-search-redesign-${width}.png` });
  await view(page, "discover");
    await page.locator("#search-results .result-card h3").first().click();
    await expect(page.locator("#episode-detail[open]")).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${shots}/marquee-search-redesign-popup-${width}.png` });
  });
}

test("search can be cleared with the X button and with Escape", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  const input = page.getByPlaceholder("Search movies and shows");
  await expect(page.locator("#search-clear")).toBeHidden();
  await input.fill("o");
  await input.press("Enter");
  await expect(page.locator("#search-results .result-card")).toHaveCount(3);
  await expect(page.locator("#search-clear")).toBeVisible();
  await page.screenshot({ path: `${shots}/marquee-search-exit.png`, clip: { x: 0, y: 90, width: 900, height: 260 } });
  await page.locator("#search-clear").click();
  await expect(page.locator("#search-results .result-card")).toHaveCount(0);
  await expect(input).toHaveValue("");
  await expect(page.locator("#search-clear")).toBeHidden();
  await input.fill("o");
  await input.press("Enter");
  await expect(page.locator("#search-results .result-card")).toHaveCount(3);
  await input.press("Escape");
  await expect(page.locator("#search-results .result-card")).toHaveCount(0);
  await expect(input).toHaveValue("");
  await page.setViewportSize({ width: 393, height: 800 });
  await input.fill("o");
  await input.press("Enter");
  await expect(page.locator("#search-results .result-card")).toHaveCount(3);
  const box = await page.locator("#search-form").boundingBox();
  expect(box.x + box.width).toBeLessThanOrEqual(393);
});

for (const selected of ["2026-10-04", "2026-10-07", "2026-10-10", "2027-01-01", "2026-11-01"]) {
  test(`Sunday-first calendar boundaries and navigation on ${selected}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.clock.setFixedTime(new Date(`${selected}T12:00:00-05:00`));
    await login(page);
    const range = async (view) => {
      const response = page.waitForResponse(r => r.url().includes("/api/calendar?"));
      await page.getByRole("button", { name: view, exact: true }).click();
      const url = new URL((await response).url());
      await expect(page.locator("#refresh")).toBeEnabled();
      return { start: url.searchParams.get("start"), end: url.searchParams.get("end") };
    };
    await range("Month");
    await expect(page.locator(".weekday")).toHaveText(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
    const monthDates = await page.locator(".day-cell").evaluateAll(cells => cells.map(c => c.dataset.date));
    expect(new Date(`${monthDates[0]}T12:00:00`).getDay()).toBe(0);
    expect(new Date(`${monthDates.at(-1)}T12:00:00`).getDay()).toBe(6);
    expect(monthDates.length % 7).toBe(0);
    expect(monthDates).toContain(selected.slice(0, 8) + "01");
    const { start, end } = await range("Week");
    const weekDates = await page.locator(".day-cell").evaluateAll(cells => cells.map(c => c.dataset.date));
    expect(weekDates).toHaveLength(7);
    expect(weekDates).toContain(selected);
    expect(new Date(`${weekDates[0]}T12:00:00`).getDay()).toBe(0);
    expect(new Date(`${weekDates[6]}T12:00:00`).getDay()).toBe(6);
    const label = await page.evaluate(({ start, end }) => {
      const last = new Date(end); last.setDate(last.getDate() - 1);
      const options = { month: "short", day: "numeric" };
      return `${new Date(start).toLocaleDateString([], options)} - ${last.toLocaleDateString([], options)}`;
    }, { start, end });
    await expect(page.locator("#calendar-title")).toHaveText(label);
    await page.getByRole("button", { name: "Next period" }).click();
    await expect(page.locator(".day-cell").first()).not.toHaveAttribute("data-date", weekDates[0]);
    const next = await page.locator(".day-cell").first().getAttribute("data-date");
    const nextDate = new Date(`${weekDates[0]}T12:00:00`); nextDate.setDate(nextDate.getDate() + 7);
    expect(next).toBe(`${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, "0")}-${String(nextDate.getDate()).padStart(2, "0")}`);
    await page.getByRole("button", { name: "Previous period" }).click();
    await expect(page.locator(".day-cell").first()).toHaveAttribute("data-date", weekDates[0]);
    if (selected === "2026-10-07") {
      await page.locator("#calendar-section").screenshot({ path: `${shots}/marquee-sunday-week-desktop.png` });
      await page.setViewportSize({ width: 393, height: 852 });
      await page.locator("#calendar-section").screenshot({ path: `${shots}/marquee-sunday-week-mobile.png` });
    }
    const todayResponse = page.waitForResponse(r => r.url().includes("/api/calendar?"));
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await todayResponse;
    await expect(page.locator("#refresh")).toBeEnabled();
    const agenda = await range("Agenda");
    expect(await page.evaluate(start => {
      const date = new Date(start);
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    }, agenda.start)).toBe(selected);
  });
}

for (const width of [1440, 834, 393, 320, 280]) {
  test(`page spacing idle and search states at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1100 });
    await login(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByPlaceholder("City name").fill("Sample");
    await page.getByRole("button", { name: "Find city", exact: true }).click();
    await page.getByRole("button", { name: "Sample City, Example Region", exact: true }).click();
    await page.locator('[data-pref="weather"]').check();
    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(page.locator("#weather-content")).toContainText("68°F");
    const gap = () => page.evaluate(() => document.querySelector("#weather").getBoundingClientRect().top - document.querySelector("#search-form").getBoundingClientRect().bottom);
    const idleGap = await gap();
    if (width < 1100) expect(idleGap).toBe(57);
    await expect(page.locator("#search-status")).toBeHidden();
    await expect(page.locator("#search-results")).toBeHidden();
    await page.screenshot({ path: `${shots}/marquee-spacing-after-${width}.png`, fullPage: true });
    const input = page.getByPlaceholder("Search movies and shows");
    await input.fill("o");
    await input.press("Enter");
    await expect(page.locator("#search-results .result-card")).toHaveCount(3);
    await page.locator("#search-results").evaluate(el => Promise.all(el.getAnimations({ subtree: true }).map(animation => animation.finished)));
    await page.screenshot({ path: `${shots}/marquee-spacing-results-${width}.png`, fullPage: true });
    await input.press("Escape");
    await expect(page.locator("#search-results .result-card")).toHaveCount(0);
    expect(await gap()).toBe(idleGap);
    // Errors need their own space even when there are no result rows.
    await page.route("**/api/seerr/search?**", route => route.fulfill({ status: 503, json: { error: "Search temporarily unavailable" } }));
    await input.fill("error");
    await input.press("Enter");
    await expect(page.locator("#search-status")).toContainText("Search temporarily unavailable");
    await expect(page.locator("#search-status")).toBeVisible();
    await input.press("Escape");
    expect(await gap()).toBe(idleGap);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.locator('[data-pref="weather"]').uncheck();
    await page.locator('[data-pref="recent"]').uncheck();
    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(page.locator("#weather")).toBeHidden();
    await expect(page.locator("#recent-section")).toBeHidden();
    const hiddenGap = await page.evaluate(() => document.querySelector("#calendar-section").getBoundingClientRect().top - document.querySelector("#search-form").getBoundingClientRect().bottom);
    expect(hiddenGap).toBeGreaterThanOrEqual(24);
    expect(hiddenGap).toBeLessThanOrEqual(100);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

for (const [label, saved, enabled] of [
  ["fresh", null, true],
  ["legacy", { recent: true, calendar: true }, true],
  ["enabled", { search: true }, true],
  ["disabled", { search: false }, false],
]) {
  test(`search default preserves ${label} preferences`, async ({ page }) => {
    await page.setViewportSize({ width: 834, height: 1100 });
    await page.addInitScript(saved => {
      if (sessionStorage.getItem("search-default-seeded")) return;
      sessionStorage.setItem("search-default-seeded", "true");
      const key = "marquee:Demo viewer:preferences";
      if (saved === null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(saved));
    }, saved);
    await page.goto("/");
    await page.getByRole("button", { name: "Explore demo" }).click();
    await expect(page.locator("#recent .poster-card")).toHaveCount(6);
    await expect(page.locator("#search-section")).toBeVisible({ visible: enabled });
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("marquee:Demo viewer:preferences")).search)).toBe(enabled);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.locator('[data-pref="search"]')).toBeChecked({ checked: enabled });
    await page.locator('[data-pref="search"]').setChecked(!enabled);
    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(page.locator("#search-section")).toBeVisible({ visible: !enabled });
    await page.reload();
    await expect(page.locator("#recent .poster-card")).toHaveCount(6);
    await expect(page.locator("#search-section")).toBeVisible({ visible: !enabled });
    if (label === "fresh") {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.locator('[data-pref="search"]').check();
      await page.getByRole("button", { name: "Close settings" }).click();
      await page.screenshot({ path: `${shots}/marquee-search-default-on-tablet.png` });
      await page.setViewportSize({ width: 393, height: 852 });
      await page.screenshot({ path: `${shots}/marquee-search-default-on-phone.png` });
    }
  });
}

test("weather location is device opt-in, approximate, and falls back to configured city", async ({ page, context }) => {
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 35.123456, longitude: -80.987654 });
  await login(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.locator("#weather-location")).not.toBeChecked();
  await page.getByPlaceholder("City name").fill("Sample");
  await page.getByRole("button", { name: "Find city", exact: true }).click();
  await page.getByRole("button", { name: "Sample City, Example Region", exact: true }).click();
  await page.locator('[data-pref="weather"]').check();
  const located = page.waitForRequest(req => req.url().includes("/api/weather?") && new URL(req.url()).searchParams.get("latitude") === "35.12");
  await page.locator("#weather-location").check();
  const url = new URL((await located).url());
  expect(url.searchParams.get("longitude")).toBe("-80.99");
  await expect(page.locator("#weather-location-status")).toContainText("approximate location");
  await expect(page.locator(".forecast-icon")).toHaveCount(5);
  await expect(page.locator("#weather-content")).not.toContainText("Sample City");
  await page.addInitScript(() => Object.defineProperty(navigator, "geolocation", { value: { getCurrentPosition: (_success, fail) => fail({ code: 1 }) } }));
  await page.reload();
  await expect(page.locator("#weather-content")).toContainText("68°F");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.locator("#weather-location-status")).toContainText("Using your saved city");
});

test("personal shelves are opt-in, collapsible and account-scoped watchlist saves never request", async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await login(page);
  for (const key of ["watchlist", "continueWatching", "nextUp"]) await expect(page.locator(`#${key}-section`)).toBeHidden();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const key of ["watchlist", "continueWatching", "nextUp"]) await page.locator(`[data-pref="${key}"]`).check();
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(page.locator("#continueWatching-content .poster-card")).toHaveCount(3);
  await expect(page.locator("#nextUp-content .poster-card")).toHaveCount(2);
  await view(page, "home");
  await page.getByRole("button", { name: "Collapse Continue watching", exact: true }).click();
  await expect(page.locator("#continueWatching-content")).toBeHidden();
  await view(page, "home");
  await page.getByRole("button", { name: "Expand Continue watching", exact: true }).click();
  await view(page, "home");
  await page.locator("#continueWatching-content [data-personal]").first().click();
  await expect(page.locator("#episode-play")).toHaveAttribute("aria-label", "Resume in Jellyfin");
  await page.getByRole("button", { name: "Close episode details" }).click();
  let requests = 0;
  page.on("request", req => { if (req.url().endsWith("/api/seerr/request") && req.method() === "POST") requests++; });
  await view(page, "discover");
  await page.getByPlaceholder("Search movies and shows").fill("o");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator("#search-results .result-card")).toHaveCount(3);
  await view(page, "home");
  await page.locator("#continueWatching-content [data-personal]").first().click();
  await page.getByRole("button", { name: "Add to Jellyfin favorites", exact: true }).click();
  await expect(page.getByRole("button", { name: "Remove from Jellyfin favorites", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close episode details" }).click();
  await expect(page.locator("#watchlist-content .poster-card")).toHaveCount(1);
  expect(requests).toBe(0);
  await view(page, "discover");
  await page.getByPlaceholder("Search movies and shows").press("Escape");
  await page.screenshot({ path: `${shots}/marquee-personal-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 393, height: 852 });
  await page.screenshot({ path: `${shots}/marquee-personal-phone.png`, fullPage: true });
  const other = await context.browser().newContext();
  const otherPage = await other.newPage();
  await otherPage.goto("http://127.0.0.1:8739/");
  await otherPage.getByRole("button", { name: "Explore demo" }).click();
  expect((await (await otherPage.request.get("/api/watchlist")).json()).items).toHaveLength(0);
  await other.close();
  await view(page, "home");
  await page.locator(".watchlist-remove").click();
  await expect(page.locator("#watchlist-content .poster-card")).toHaveCount(0);
});

test("display sync is opt-in, filtered and restores the account choices", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.locator("#sync-display")).not.toBeChecked();
  await page.locator("#sync-display").check();
  await expect(page.locator("#sync-display-status")).toHaveText("Display settings synced.");
  await page.locator('[data-pref="calendar"]').uncheck();
  await expect.poll(async () => (await (await page.request.get("/api/display-preferences")).json()).preferences.calendar).toBe(false);
  await page.reload();
  await expect(page.locator("#calendar-section")).toBeHidden();
  const response = await page.request.post("/api/display-preferences", { headers: { Origin: "http://127.0.0.1:8739" }, data: { calendar: true, weatherLocation: true, token: "not-stored", userId: "other" } });
  expect(await response.json()).toEqual({ preferences: { calendar: true } });
  await page.reload();
  await expect(page.locator("#calendar-section")).toBeVisible();
  expect((await page.request.post("/api/display-preferences", { headers: { Origin: "http://127.0.0.1:8739" }, data: { search: "true" } })).status()).toBe(400);
  expect((await page.request.post("/api/watchlist", { headers: { Origin: "http://127.0.0.1:8739" }, data: { mediaType: "movie", mediaId: -1, saved: true } })).status()).toBe(400);
});

for (const width of [1440, 1100, 834, 393]) {
  test(`weather moves left when search is hidden at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await login(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByPlaceholder("City name").fill("Sample");
    await page.getByRole("button", { name: "Find city", exact: true }).click();
    await page.getByRole("button", { name: "Sample City, Example Region", exact: true }).click();
    await page.locator('[data-pref="weather"]').check();
    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(page.locator("#weather-content")).toContainText("68°F");
    const positions = () => page.evaluate(() => {
      const weather = document.querySelector("#weather").getBoundingClientRect();
      const content = document.querySelector("#weather-content").getBoundingClientRect();
      return { left: weather.left, center: (weather.left + weather.right) / 2, contentLeft: content.left, contentCenter: (content.left + content.right) / 2 };
    });
    if (width >= 1100) {
      const before = await positions();
      expect(Math.abs(before.contentCenter - before.center)).toBeLessThan(1);
    }
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.locator('[data-pref="search"]').uncheck();
    await page.getByRole("button", { name: "Close settings" }).click();
    const hidden = await positions();
    expect(Math.abs(hidden.contentLeft - hidden.left)).toBeLessThan(1);
    await page.screenshot({ path: `${shots}/marquee-weather-left-${width}.png` });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.locator('[data-pref="search"]').check();
    await page.getByRole("button", { name: "Close settings" }).click();
    if (width >= 1100) {
      const after = await positions();
      expect(Math.abs(after.contentCenter - after.center)).toBeLessThan(1);
    }
  });
}

for (const width of [1440, 393]) {
  test(`section order drag, server reload, hidden sections and reset at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 950 });
    await login(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.locator("#section-order-list li")).toHaveCount(14);
    const handle = page.getByRole("button", { name: "Drag Release calendar", exact: true });
    const target = page.locator('#section-order-list li[data-order-key="search"]');
    await handle.scrollIntoViewIfNeeded();
    const from = await handle.boundingBox(), to = await target.boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + 20, to.y + 18, { steps: 12 });
    await page.mouse.up();
    await expect(page.locator("#section-order-status")).toHaveText("Saved to your account.");
    await expect(page.locator("#section-order-list li").first()).toHaveAttribute("data-order-key", "calendar");
    await page.locator("#section-order-settings").screenshot({ path: `${shots}/marquee-order-settings-${width}.png` });
    await page.getByRole("button", { name: "Close settings" }).click();
    expect(await page.evaluate(() => document.querySelector("#calendar-section").getBoundingClientRect().top < document.querySelector("#search-section").getBoundingClientRect().top)).toBe(true);
    await page.screenshot({ path: `${shots}/marquee-order-dashboard-${width}.png` });
    await page.reload();
    await expect(page.locator("#recent .poster-card")).toHaveCount(6);
    expect(await page.evaluate(() => document.querySelector("#calendar-section").getBoundingClientRect().top < document.querySelector("#search-section").getBoundingClientRect().top)).toBe(true);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Move Weather down", exact: true }).click();
    await expect(page.locator("#section-order-status")).toHaveText("Saved to your account.");
    await page.locator('[data-pref="watchlist"]').check();
    await page.getByRole("button", { name: "Close settings" }).click();
    await view(page, "home");
    await expect(page.locator("#watchlist-section")).toBeVisible();
    await expect(page.locator("#watchlist-section").getByRole("button", { name: "Collapse Favorites" })).toBeVisible();
  await view(page, "home");
    await page.locator("#watchlist-section").getByRole("button", { name: "Collapse Favorites" }).click();
    await expect(page.locator("#watchlist-content")).toBeHidden();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Reset Discover order", exact: true }).click();
    await expect(page.locator("#section-order-list li").first()).toHaveAttribute("data-order-key", "search");
    await expect(page.locator("#section-order-status")).toHaveText("Saved to your account.");
  });
}

test("section ordering keeps separated search/weather and saves touch drag", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 393, height: 900 }, hasTouch: true, isMobile: true });
  const page = await context.newPage(); await login(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByPlaceholder("City name").fill("Sample");
  await page.getByRole("button", { name: "Find city", exact: true }).click();
  await page.getByRole("button", { name: "Sample City, Example Region", exact: true }).click();
  await page.locator('[data-pref="weather"]').check();
  const handle = page.getByRole("button", { name: "Drag Weather", exact: true });
  await handle.scrollIntoViewIfNeeded();
  const from = await handle.boundingBox();
  const to = await page.locator('[data-order-key="calendar"]').boundingBox();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x + 15, y: from.y + 15 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: to.x + 15, y: to.y + 15 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(page.locator("#section-order-status")).toHaveText("Saved to your account.");
  expect((await (await page.request.get("/api/section-order")).json()).order.filter(key => ["search", "weather", "recent", "calendar", "recommendations", "popular"].includes(key)).indexOf("weather")).toBe(3);
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(page.locator(".home-top-row")).toBeHidden();
  expect(await page.locator("#weather").evaluate(el => el.parentElement.tagName)).toBe("MAIN");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator("#weather").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${shots}/marquee-order-weather-separated.png` });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Reset Discover order", exact: true }).click();
  await expect(page.locator("#section-order-status")).toHaveText("Saved to your account.");
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(page.locator(".home-top-row")).toBeVisible();
  await context.close();
});

test("continue watching renders series, movies and episode labels without changing playback", async ({ page }) => {
  await page.setViewportSize({ width: 532, height: 900 });
  await page.route("**/api/library/great/facts", route => route.fulfill({ json: { facts: { scores: { imdb: 7.5 } }, mediaType: "tv", mediaId: 111 } }));
  await page.route("**/api/personal/continueWatching", route => route.fulfill({ json: { items: [
    { id: "great", title: "The Great", subtitle: "S2E4 · The Wedding", art: "north", progress: 50, remaining: 20, link: "https://jellyfin.example/episode-great", detail: { title: "The Great", subtitle: "S2E4 · The Wedding" } },
    { id: "landman", title: "Landman", subtitle: "2024 · Series", art: "coast", progress: 0, remaining: null, detail: {} },
    { id: "film", title: "A film", subtitle: "2026 · Movie", art: "signal", progress: 50, remaining: 20, detail: {} },
    { id: "episode", title: "A show", subtitle: "S2E3 · Episode title", art: "orbit", progress: 50, remaining: 20, detail: {} },
  ] } }));
  await login(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator('[data-pref="continueWatching"]').check();
  await page.getByRole("button", { name: "Close settings" }).click();
  await view(page, "home");
  const shelf = page.locator("#continueWatching-section");
  await expect(shelf).toContainText("S2E4 · The Wedding");
  await expect(shelf).toContainText("2024 · Series");
  await expect(shelf).toContainText("2026 · Movie");
  await expect(shelf).toContainText("S2E3 · Episode title");
  await shelf.screenshot({ path: `${shots}/marquee-episode-fixed.png` });
  await shelf.locator("[data-personal]").first().click();
  await expect(page.locator("#episode-subtitle")).toHaveText("S2E4 · The Wedding");
  await expect(page.locator("#episode-play")).toHaveAttribute("href", "https://jellyfin.example/episode-great");
  await expect(page.locator("#episode-play")).toHaveAttribute("aria-label", "Resume in Jellyfin");
  await expect(page.locator('#episode-poster-status [aria-label="In your library"]')).toBeVisible();
  await expect(page.locator("#episode-request")).toBeHidden();
  await expect(page.locator("#episode-facts")).toBeVisible();
  await expect(page.locator("#episode-save")).toBeVisible();
  await page.locator("#episode-detail").screenshot({ path: `${shots}/marquee-personal-popup-fixed.png` });
});

for (const width of [1440, 393, 280]) {
  test(`personal collapse arrows stay with reordered headers at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1100 });
    await login(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    for (const key of ["watchlist", "continueWatching", "nextUp"]) await page.locator(`[data-pref="${key}"]`).check();
    await page.getByRole("button", { name: "Close settings" }).click();
    await view(page, "home");
    for (const key of ["watchlist", "continueWatching", "nextUp"]) {
      const header = page.locator(`#${key}-section .section-heading`), button = header.locator("button");
      const heading = await header.locator("h2").boundingBox(), arrow = await button.boundingBox();
      expect(arrow.x).toBeGreaterThanOrEqual(heading.x + heading.width);
      expect(arrow.y + arrow.height).toBeLessThanOrEqual(heading.y + heading.height + 1);
      await expect(button.locator("svg")).toBeVisible();
      await button.click();
      await expect(button).toHaveAttribute("aria-expanded", "false");
      expect(await button.locator("svg").evaluate(el => getComputedStyle(el).transform)).not.toBe("none");
      await button.click();
    }
  await view(page, "home");
    await page.locator("#nextUp-section .section-heading").screenshot({ path: `${shots}/marquee-arrow-header-${width}.png` });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Move Next up down", exact: true }).click();
    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(page.locator("#nextUp-section h2")).toBeVisible();
  await view(page, "home");
    await page.locator("#nextUp-section").screenshot({ path: `${shots}/marquee-arrow-section-${width}.png` });
  });
}

test("media shelves auto-refresh quietly, skip disabled/hidden tabs, and defer focused cards/popouts", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 900 });
  await page.clock.install();
  await login(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.locator("#shelf-refresh-minutes")).toHaveValue("5");
  await page.locator('[data-pref="continueWatching"]').check();
  await page.locator('[data-pref="nextUp"]').check();
  await page.locator("#shelf-refresh-minutes").selectOption("1");
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.locator("#continueWatching-content .poster-card").first().waitFor({ state: "attached" });
  const recent = (await (await page.request.get("/api/recent")).json()).items;
  let calls = { recent: 0, continueWatching: 0, nextUp: 0, watchlist: 0 };
  let version = 0;
  await page.route("**/api/recent", route => { calls.recent++; route.fulfill({ json: { items: recent.map((item, i) => i === 0 ? { ...item, title: `Updated ${version}` } : item) } }); });
  for (const key of ["continueWatching", "nextUp"]) await page.route(`**/api/personal/${key}`, route => { calls[key]++; route.fulfill({ json: { items: [{ id: key, title: `Updated ${version}`, subtitle: "S1E2 · Test", art: "north", progress: version, remaining: 10, detail: { title: "Test" } }] } }); });
  await page.route("**/api/watchlist", route => { calls.watchlist++; route.fulfill({ json: { items: [] } }); });
  await page.evaluate(() => { document.activeElement.blur(); document.querySelector("#recent").scrollLeft = 80; });
  await page.clock.runFor(1000);
  const savedScroll = await page.locator("#recent").evaluate(el => el.scrollLeft);
  version = 1;
  await page.clock.runFor(75000);
  await expect(page.locator("#recent")).toContainText("Updated 1");
  expect(calls.continueWatching).toBe(0); expect(calls.nextUp).toBe(0);
  expect(calls.watchlist).toBe(0);
  expect(await page.locator("#recent").evaluate(el => el.scrollLeft)).toBe(savedScroll);
  const beforeNode = await page.locator("#recent .poster-card").first().elementHandle();
  await page.clock.runFor(75000);
  expect(await beforeNode.evaluate(el => el.isConnected)).toBe(true);
  await view(page, "discover");
  await page.locator("#recent .recent-detail").first().focus();
  const beforeCalls = { ...calls }; version = 2;
  await page.clock.runFor(75000);
  expect(calls).toEqual(beforeCalls);
  await page.evaluate(() => document.activeElement.blur());
  await page.clock.runFor(15000);
  await expect(page.locator("#recent")).toContainText("Updated 2");
  await page.locator("#recent .recent-detail").first().click();
  const popupTitle = await page.locator("#episode-title").textContent();
  const popupCalls = { ...calls }; version = 3;
  await page.clock.runFor(75000);
  expect(calls).toEqual(popupCalls);
  await expect(page.locator("#episode-title")).toHaveText(popupTitle);
  await page.getByRole("button", { name: "Close episode details" }).click();
  await page.evaluate(() => document.activeElement.blur());
  await page.clock.runFor(15000);
  await expect(page.locator("#recent")).toContainText("Updated 3");
  await page.evaluate(() => Object.defineProperty(document, "hidden", { configurable: true, value: true }));
  const hiddenCalls = { ...calls }; version = 4;
  await page.clock.runFor(75000);
  expect(calls).toEqual(hiddenCalls);
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: false }); document.dispatchEvent(new Event("visibilitychange")); });
  await expect(page.locator("#recent")).toContainText("Updated 4");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator('[data-pref="nextUp"]').uncheck();
  await page.locator('[data-pref="continueWatching"]').uncheck();
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.evaluate(() => document.activeElement.blur());
  const disabledCalls = { ...calls }; version = 5;
  await page.clock.runFor(75000);
  await expect(page.locator("#recent")).toContainText("Updated 5");
  expect(calls.nextUp).toBe(disabledCalls.nextUp); expect(calls.continueWatching).toBe(disabledCalls.continueWatching);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator("#shelf-refresh-minutes").selectOption("0");
  await page.getByRole("button", { name: "Close settings" }).click();
  const stoppedCalls = { ...calls };
  await page.clock.runFor(120000);
  expect(calls).toEqual(stoppedCalls);
});

test("auto refresh failures preserve loaded cards and slow requests never overlap", async ({ page }) => {
  await page.clock.install(); await login(page);
  await page.evaluate(() => { state.prefs.shelfRefreshMinutes = 1; persist(); document.activeElement.blur(); });
  await page.route("**/api/recent", route => route.fulfill({ status: 502, json: { error: "Unavailable" } }));
  await page.clock.runFor(75000);
  await expect(page.locator("#recent .poster-card")).toHaveCount(6);
  await expect(page.locator("#shelf-refresh-status")).toContainText("Keeping the last loaded shelves");
  let calls = 0, pending;
  await page.unroute("**/api/recent");
  await page.route("**/api/recent", route => { calls++; pending = route; });
  await page.clock.runFor(75000); await expect.poll(() => calls).toBe(1);
  await page.clock.runFor(180000); expect(calls).toBe(1);
  await pending.fulfill({ json: { items: [] } });
  await expect(page.locator("#recent")).toContainText("No recent titles");
});

for (const width of [1440, 834, 393, 280]) {
  test(`whole app audit enabled sections, dialogs, console and accessible controls at ${width}px`, async ({ page }) => {
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width, height: 1100 }); await login(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    for (const key of ["watchlist", "continueWatching", "nextUp", "weather"]) await page.locator(`[data-pref="${key}"]`).check();
    await page.getByPlaceholder("City name").fill("Sample");
    await page.getByRole("button", { name: "Find city", exact: true }).click();
    await page.getByRole("button", { name: "Sample City, Example Region", exact: true }).click();
    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(page.locator("#weather-content")).toContainText("68°F");
    await expect(page.locator("#continueWatching-content .poster-card")).toHaveCount(3);
    await expect(page.locator("#nextUp-content .poster-card")).toHaveCount(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const unnamed = await page.locator("button").evaluateAll(buttons => buttons.filter(el => el.getClientRects().length && !el.textContent.trim() && !el.getAttribute("aria-label") && !el.getAttribute("aria-labelledby") && !el.getAttribute("title")).map(el => el.outerHTML));
    expect(unnamed).toEqual([]);
    await view(page, "home");
    for (const key of ["continueWatching", "nextUp"]) {
      await page.locator(`#${key}-content [data-personal]`).first().click();
      await expect(page.locator("#episode-title")).not.toBeEmpty();
      await page.getByRole("button", { name: "Close episode details" }).click();
    }
    await page.screenshot({ path: `${shots}/marquee-audit-full-${width}.png`, fullPage: true });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.locator("#settings").screenshot({ path: `${shots}/marquee-audit-settings-${width}.png` });
    expect(errors).toEqual([]);
  });
}

test("refresh interval persists and syncs, collapsed shelves remain collapsed after updates", async ({ page }) => {
  await page.clock.install(); await login(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator("#shelf-refresh-minutes").selectOption("2");
  await page.locator("#sync-display").check();
  await expect.poll(async () => (await (await page.request.get("/api/display-preferences")).json()).preferences?.shelfRefreshMinutes).toBe(2);
  await page.locator('[data-pref="continueWatching"]').check();
  await page.getByRole("button", { name: "Close settings" }).click();
  await view(page, "home");
  await page.getByRole("button", { name: "Collapse Continue watching", exact: true }).click();
  await page.evaluate(() => document.activeElement.blur());
  await page.route("**/api/personal/continueWatching", route => route.fulfill({ json: { items: [{ id: "new", title: "Fresh episode", subtitle: "S1E3", art: "north", detail: {} }] } }));
  await page.clock.runFor(150000);
  await expect(page.locator("#continueWatching-content")).toBeHidden();
  await expect(page.locator("#continueWatching-content")).toContainText("Fresh episode");
  await page.reload();
  await expect(page.locator("#recent .poster-card")).toHaveCount(6);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.locator("#shelf-refresh-minutes")).toHaveValue("2");
  await expect(page.locator("#sync-display")).toBeChecked();
});

for (const width of [1440, 393]) {
  test(`watched badge preview is distinct from availability at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 950 });
    await login(page);
    const recent = (await (await page.request.get("/api/recent")).json()).items;
    await page.route("**/api/recent", route => route.fulfill({ json: { items: recent.map((item, i) => ({ ...item, watched: i < 2 ? true : null, watchedScope: i === 1 ? "season" : "movie" })) } }));
    await page.route("**/api/personal/nextUp", route => route.fulfill({ json: { items: [{ id: "episode", title: "Rewatch example", subtitle: "S2E4 · The Wedding", watched: true, watchedScope: "episode", art: "north", detail: { title: "Rewatch example", subtitle: "S2E4 · The Wedding" } }] } }));
    await page.locator("#refresh").click();
    await expect(page.locator("#recent .watched-badge")).toHaveCount(2);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.locator('[data-pref="nextUp"]').check();
    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(page.locator("#nextUp-content .watched-badge")).toHaveAttribute("aria-label", "Episode watched");
    await page.locator("#recent-section").screenshot({ path: `${shots}/marquee-watched-preview-${width}.png` });
  await view(page, "home");
    await page.locator("#nextUp-section").screenshot({ path: `${shots}/marquee-watched-episode-${width}.png` });
  await view(page, "discover");
    await page.locator("#recent .recent-detail").first().click();
    await expect(page.locator("#episode-poster-status .watched-badge")).toBeVisible();
    await expect(page.locator('#episode-poster-status [aria-label="In your library"]')).toBeVisible();
    await page.locator("#episode-detail").screenshot({ path: `${shots}/marquee-watched-popup-${width}.png` });
  });
}

for (const width of [1440, 393]) {
  test(`favorites heart, recommendations and my requests preview at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 }); await login(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.locator('[data-pref="watchlist"]').check();
    await page.locator('[data-pref="recommendations"]').check();
    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(page.locator("#recommendation-seed")).toContainText("Because you watched");
  await view(page, "discover");
    await page.locator("#recent .recent-detail").nth(1).click();
    // Demo library fixture has a known parent series identity, no Seerr dependency.
    await page.evaluate(() => { currentDetail.favoriteId = "demo-series"; currentDetail.favorite = false; setDetailSave(currentDetail); });
    await expect(page.locator("#episode-save")).toHaveAttribute("aria-pressed", "false");
    await page.locator("#episode-detail").screenshot({ path: `${shots}/marquee-heart-empty-${width}.png` });
    await page.getByRole("button", { name: "Add to Jellyfin favorites", exact: true }).click();
    await expect(page.locator("#episode-save")).toHaveAttribute("aria-pressed", "true");
    await page.locator("#episode-detail").screenshot({ path: `${shots}/marquee-heart-filled-${width}.png` });
    await page.getByRole("button", { name: "Close episode details" }).click();
    await expect(page.locator("#watchlist-content .poster-card")).toHaveCount(1);
  await view(page, "home");
    await page.locator("#watchlist-section").screenshot({ path: `${shots}/marquee-favorites-row-${width}.png` });
  await view(page, "discover");
    await page.locator("#recommendations-section").screenshot({ path: `${shots}/marquee-recommendations-${width}.png` });
  await view(page, "home");
    await page.locator("#requests-filter").selectOption("mine");
    await expect(page.locator("#requests .request-row")).toHaveCount(1);
  await view(page, "home");
    await page.locator("#requests-section").screenshot({ path: `${shots}/marquee-myrequests-${width}.png` });
  });
}

for (const width of [1440, 393, 280]) {
  test(`Maintainerr Leaving soon preview, defaults and safe popout at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 }); await login(page);
    await expect(page.locator("#leavingSoon-section")).toBeHidden();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.locator('[data-pref="leavingSoon"]').check();
    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(page.locator("#leavingSoon-content .poster-card")).toHaveCount(3);
    await expect(page.locator("#leavingSoon-section")).toContainText("eligibility, not guaranteed removal");
    await expect(page.locator("#leavingSoon-content .leaving-date").first()).toContainText("Eligible");
  await view(page, "home");
    await page.locator("#leavingSoon-section").screenshot({ path: `${shots}/marquee-leaving-soon-${width}.png` });
  await view(page, "home");
    await page.locator("#leavingSoon-content [data-personal]").first().click();
    await expect(page.locator("#episode-title")).toContainText(await page.locator("#leavingSoon-content h3").first().textContent());
    await page.getByRole("button", { name: "Close episode details" }).click();
    await page.getByRole("button", { name: "Collapse Leaving soon", exact: true }).click();
    await expect(page.locator("#leavingSoon-content")).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.reload(); await expect(page.locator("#leavingSoon-content")).toBeHidden();
  });
}


for (const width of [1440, 393, 280]) {
  test(`two focused tabs navigation preview at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/"); await page.getByRole("button", { name: "Explore demo" }).click();
    await expect(page.locator("#recent .poster-card")).toHaveCount(6);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    for (const key of ["watchlist", "continueWatching", "nextUp", "leavingSoon", "recommendations", "requests"]) await page.locator(`[data-pref="${key}"]`).check();
    await page.getByRole("button", { name: "Close settings" }).click();
    for (const view of ["discover", "home"]) {
      await page.locator(`button[data-page="${view}"]`).click();
      await expect(page.locator(`button[data-page="${view}"]`)).toHaveAttribute("aria-current", "page");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `${shots}/marquee-nav-${view}-${width}.png` });
    }
    await expect(page.locator("#calendar-section")).toBeHidden();
    await view(page, "home");
  await expect(page.locator("#requests-section")).toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.locator("#tab-order").selectOption("home");
    await expect(page.locator("#page-nav button").first()).toHaveText("On Jellyfin");
    await page.locator("#tab-order-settings").screenshot({ path: `${shots}/marquee-nav-settings-${width}.png` });
    await page.getByRole("button", { name: "Close settings" }).click();
    await page.reload(); await expect(page.locator('button[data-page="home"]')).toHaveAttribute("aria-current", "page");
  });
}

for (const width of [1440, 393, 280]) {
  test(`five day weather tab mockup at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 }); await page.goto("/");
    await page.getByRole("button", { name: "Explore demo" }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByPlaceholder("City name").fill("Sample");
    await page.getByRole("button", { name: "Find city", exact: true }).click();
    await page.getByRole("button", { name: "Sample City, Example Region", exact: true }).click();
    await page.locator('[data-pref="weather"]').check();
    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(page.locator("#weather-forecast .forecast-day")).toHaveCount(5);
    if (width >= 1100) {
      const alignment = await page.evaluate(() => ({
        left: document.querySelector("#view-kicker").getBoundingClientRect().top,
        right: document.querySelector("#weather .eyebrow").getBoundingClientRect().top,
        search: document.querySelector("#search-section").getBoundingClientRect().width,
        weather: document.querySelector("#weather").getBoundingClientRect().width,
      }));
      expect(Math.abs(alignment.left - alignment.right)).toBeLessThan(6);
      expect(Math.abs(alignment.search - alignment.weather)).toBeLessThan(2);
    }
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: `${shots}/marquee-nav-weather-${width}.png` });
    await page.locator("#weather").screenshot({ path: `${shots}/marquee-five-days-${width}.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("tab startup sync, empty states and shelf order stay independent", async ({ page }) => {
  await login(page);
  const order = (await (await page.request.get("/api/section-order")).json()).order;
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator("#sync-display").check();
  await page.locator("#tab-order").selectOption("home");
  for (const key of ["watchlist", "continueWatching", "nextUp", "leavingSoon", "requests"]) await page.locator(`[data-pref="${key}"]`).uncheck();
  await page.getByRole("button", { name: "Close settings" }).click();
  await view(page, "home");
  await expect(page.locator("#nothing")).toBeVisible();
  expect((await (await page.request.get("/api/section-order")).json()).order).toEqual(order);
  await expect.poll(async () => (await (await page.request.get("/api/display-preferences")).json()).preferences?.firstTab).toBe("home");
  await page.evaluate(() => localStorage.setItem("marquee:Demo viewer:preferences", JSON.stringify({ syncDisplay: true })));
  await page.reload();
  await expect(page.locator('#page-nav button[data-page="home"]')).toHaveAttribute("aria-current", "page");
  await view(page, "discover");
  await expect(page.locator("#nothing")).toBeHidden();
});

test("Home refreshes its active personal shelves without polling Discover", async ({ page }) => {
  await page.clock.install(); await login(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const key of ["continueWatching", "nextUp"]) await page.locator(`[data-pref="${key}"]`).check();
  // Isolate the personal-shelf timer from the independently tested Requests read.
  await page.locator('[data-pref="requests"]').uncheck();
  await page.locator("#shelf-refresh-minutes").selectOption("1");
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(page.locator("#continueWatching-content .poster-card")).toHaveCount(3);
  await expect(page.locator("#nextUp-content .poster-card")).toHaveCount(2);
  let recent = 0, personal = 0;
  await page.route("**/api/recent", route => { recent++; route.fulfill({ json: { items: [] } }); });
  for (const key of ["continueWatching", "nextUp"]) await page.route(`**/api/personal/${key}`, route => { personal++; route.fulfill({ json: { items: [] } }); });
  await view(page, "home"); await page.evaluate(() => document.activeElement.blur());
  // Fake timers advance before network reads resolve. Settle the page-entry
  // reads first, then advance a fresh full interval for the timer under test.
  await expect.poll(() => page.evaluate(() => !shelfRefreshBusy && shelfRequests.size === 0)).toBe(true);
  await page.clock.runFor(15000);
  await expect.poll(() => page.evaluate(() => !shelfRefreshBusy && shelfRequests.size === 0)).toBe(true);
  await page.clock.runFor(75000);
  try { await expect.poll(() => personal).toBeGreaterThanOrEqual(2); }
  catch (error) {
    const diagnostics = await page.evaluate(() => ({ page:dashboardPage,hidden:document.hidden,safe:safeShelfRefresh(),focus:document.activeElement?.tagName,busy:shelfRefreshBusy,now:Date.now(),interaction:shelfInteractionAt,loaded:{...shelfLastLoaded},prefs:[state.prefs.shelfRefreshMinutes,state.prefs.continueWatching,state.prefs.nextUp],timer:shelfTimer }));
    throw new Error(`Home refresh state: ${JSON.stringify(diagnostics)}; calls: ${personal}. ${error.message}`);
  }
  expect(recent).toBe(0);
});

for (const width of [1440, 393, 280]) {
  test(`page-specific shelf ordering preserves the other page at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 }); await login(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const keys = pageName => page.locator(`[data-order-page="${pageName}"] li`).evaluateAll(rows => rows.map(row => row.dataset.orderKey));
    const discover = await keys("discover"), home = await keys("home");
    expect(discover).toHaveLength(7); expect(home).toHaveLength(7);
    await page.getByRole("button", { name: "Move Continue watching up", exact: true }).click();
    expect(await keys("discover")).toEqual(discover);
    expect((await keys("home"))[0]).toBe("continueWatching");
    await page.getByRole("button", { name: "Move Release calendar up", exact: true }).click();
    const changedDiscover = await keys("discover"); expect(changedDiscover).not.toEqual(discover);
    await page.getByRole("button", { name: "Reset On Jellyfin order", exact: true }).click();
    expect(await keys("home")).toEqual(home); expect(await keys("discover")).toEqual(changedDiscover);
    await expect(page.locator('[data-order-page="home"] [data-order-key="nextUp"] [data-order-move="-1"]')).toBeDisabled();
    await expect(page.locator('[data-order-page="discover"] [data-order-key="search"] [data-order-move="-1"]')).toBeDisabled();
    await page.locator('[data-order-page="discover"]').screenshot({ path: `${shots}/marquee-order-discover-${width}.png` });
    await page.locator('[data-order-page="home"]').screenshot({ path: `${shots}/marquee-order-jellyfin-${width}.png` });
    expect(await page.locator("#settings").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.getByRole("button", { name: "Close settings" }).click(); await page.reload();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    expect(await keys("home")).toEqual(home); expect(await keys("discover")).toEqual(changedDiscover);
  });
}

for (const width of [1440, 834, 393, 360, 280]) {
  test(`twenty recommendations keep readable poster widths at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.route("**/api/recommendations", route => route.fulfill({ json: { seed: "Cops", items: Array.from({ length: 20 }, (_, i) => ({ id: 200 + i, mediaType: "tv", title: ["Rob Dyrdek's Fantasy Factory", "Counting Cars International", "Married at First Sight"][i % 3], year: String(2009 + i), rating: { value: 7.8, source: "TMDB" }, poster: ["north", "signal", "orbit"][i % 3], availability: i === 0 ? 5 : i === 1 ? 3 : 1 })) } }));
    await login(page); await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.locator('[data-pref="recommendations"]').check(); await page.getByRole("button", { name: "Close settings" }).click();
    const row = page.locator("#recommendations-content"), cards = row.locator(".result-card");
    await expect(cards).toHaveCount(20);
    await expect(row.locator(".media-rating")).toHaveCount(20);
    const recommendationPoster = await cards.first().locator(".poster-art").boundingBox();
    const popularPoster = await page.locator("#popular-movies .poster-art").first().boundingBox();
    expect(Math.abs(recommendationPoster.width - popularPoster.width)).toBeLessThan(1);
    expect(Math.abs(recommendationPoster.height - popularPoster.height)).toBeLessThan(1);
    const recentPoster = await page.locator("#recent .poster-art").first().boundingBox();
    expect(Math.abs(recommendationPoster.width - recentPoster.width)).toBeLessThan(1);
    expect(Math.abs(recommendationPoster.height - recentPoster.height)).toBeLessThan(1);
    const boxes = await cards.evaluateAll(els => els.map(el => ({ left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right, width: el.getBoundingClientRect().width })));
    for (let i = 0; i < boxes.length; i++) { expect(boxes[i].width).toBeGreaterThanOrEqual(width > 600 ? 140 : 90); if (i) expect(boxes[i].left).toBeGreaterThan(boxes[i-1].right); }
    expect(await row.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator("#recommendations-section").screenshot({ path: `${shots}/marquee-recommendations-full-${width}.png` });
    await row.evaluate(el => el.scrollLeft = el.scrollWidth); await expect(cards.last()).toBeInViewport();
  });
}

for (const width of [1440, 834, 393, 280]) {
  test(`poster sizes are consistent and device-only at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 }); await login(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    for (const key of ["continueWatching", "nextUp", "recommendations", "leavingSoon"]) await page.locator(`[data-pref="${key}"]`).check();
    await page.locator("#sync-display").check();
    let previous = 0;
    for (const size of ["small", "standard", "large"]) {
      await page.locator("#poster-size").selectOption(size);
      await page.getByRole("button", { name: "Close settings" }).click();
      await view(page, "discover");
      await expect(page.locator("#recommendations-content .result-card").first()).toBeVisible();
      const bounds = selector => page.locator(selector).first().boundingBox();
      const recent = await bounds("#recent .poster-art"); expect(recent.width).toBeGreaterThan(previous); previous = recent.width;
      for (const selector of ["#recommendations-content .poster-art", "#popular-movies .poster-art", "#popular-tv .poster-art"]) {
        const box = await bounds(selector); expect(Math.abs(box.width - recent.width)).toBeLessThan(1); expect(Math.abs(box.height - recent.height)).toBeLessThan(1);
      }
      await page.locator("#recent-section").screenshot({ path: `${shots}/marquee-poster-${size}-${width}.png` });
      await view(page, "home");
      for (const selector of ["#continueWatching-content .poster-art", "#nextUp-content .poster-art", "#leavingSoon-content .poster-art"]) {
        const box = await bounds(selector); expect(Math.abs(box.width - recent.width)).toBeLessThan(1); expect(Math.abs(box.height - recent.height)).toBeLessThan(1);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.getByRole("button", { name: "Settings", exact: true }).click();
    }
    await expect.poll(async () => (await (await page.request.get("/api/display-preferences")).json()).preferences?.firstTab).toBe("discover");
    expect((await (await page.request.get("/api/display-preferences")).json()).preferences).not.toHaveProperty("posterSize");
    await page.getByRole("button", { name: "Close settings" }).click(); await page.reload();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.locator("#poster-size")).toHaveValue("large");
    await page.locator("#poster-size").screenshot({ path: `${shots}/marquee-poster-size-settings-${width}.png` });
  });
}

for (const width of [1440, 393]) {
  test(`last five recommendations and purple scrollbars preview at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.route("**/api/recommendations", route => route.fulfill({ json: { seeds: ["Cops", "The Last Signal", "North of Nowhere", "Orbit Nine", "After Hours"], items: Array.from({ length: 20 }, (_, i) => ({ id: 300 + i, mediaType: i % 2 ? "movie" : "tv", title: ["Rob Dyrdek's Fantasy Factory", "A New Movie", "Counting Cars", "Another Movie"][i % 4], year: "2024", rating: { value: 7.8, source: "TMDB" }, poster: ["north", "signal", "orbit"][i % 3], availability: 1 })) } }));
    await login(page); await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.locator('[data-pref="recommendations"]').check(); await page.getByRole("button", { name: "Close settings" }).click();
    await expect(page.locator("#recommendation-seed")).toHaveText("Recent picks · Because you watched Cops, The Last Signal, North of Nowhere, Orbit Nine, After Hours");
    const row = page.locator("#recommendations-content");
    expect(await row.evaluate(el => getComputedStyle(el).scrollbarColor)).toBe("rgb(180, 154, 255) rgb(25, 28, 40)");
    await page.locator("#recommendations-section").screenshot({ path: `${shots}/marquee-last-five-${width}.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const options = {
      "library": '<path d="M4 4h4v16H4zM11 4h4v16h-4zM18 4l3 15-3 1-3-15z"/>',
      "screen": '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4m-2-10 5-3-5-3z"/>',
      "film": '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4m-11-2 5-3-5-3z"/>'
    };
    await view(page, "home");
    for (const [name, svg] of Object.entries(options)) {
      await page.locator('button[data-page="home"] svg').evaluate((el, content) => el.innerHTML = content, svg);
      await page.locator("#page-nav").screenshot({ path: `${shots}/marquee-icon-${name}-${width}.png` });
    }
  });
}

for (const width of [1440, 834, 393, 280]) {
  test(`small poster request icons fit in all sizes at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const items = Array.from({ length: 12 }, (_, i) => ({ id: 400 + i, mediaType: i % 2 ? "movie" : "tv", title: ["Short", "A much longer movie title wrapping over several lines", "Medium title"][i % 3], year: i % 3 ? "2024" : "", rating: i % 2 ? { value: 7.8, source: "TMDB" } : null, poster: ["north", "signal", "orbit"][i % 3], availability: i === 4 ? 5 : 1 }));
    await page.route("**/api/recommendations", route => route.fulfill({ json: { seeds: ["Cops", "A film"], items } }));
    await page.route("**/api/seerr/popular", route => route.fulfill({ json: { movies: items.map(item => ({ ...item, mediaType: "movie" })), tv: items.map(item => ({ ...item, mediaType: "tv" })) } }));
    await login(page); await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.locator('[data-pref="recommendations"]').check();
    for (const size of ["small", "standard", "large"]) {
      await page.locator("#poster-size").selectOption(size); await page.getByRole("button", { name: "Close settings" }).click();
      for (const selector of ["#recommendations-content", "#popular-movies", "#popular-tv"]) {
        const row = page.locator(selector); await expect(row.locator(".request-btn").first()).toBeVisible();
        await expect(row.locator(".result-action")).toHaveCount(0);
        const icons = await row.locator(".poster-request").evaluateAll(buttons => buttons.map(button => ({ button: button.getBoundingClientRect().toJSON(), poster: button.closest(".result-card").querySelector(".poster-art").getBoundingClientRect().toJSON() })));
        for (const { button, poster } of icons) { expect(button.width).toBe(36); expect(button.right).toBeLessThan(poster.right); expect(button.top).toBeGreaterThan(poster.top); }
        const posters = await row.locator(".poster-art").evaluateAll(elements => elements.map(el => el.getBoundingClientRect().top));
        expect(Math.max(...posters) - Math.min(...posters)).toBeLessThan(1);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.locator("#recommendations-section").screenshot({ path: `${shots}/marquee-request-icon-${size}-${width}.png` });
      await page.getByRole("button", { name: "Settings", exact: true }).click();
    }
  });
}

test("poster plus starts a request without opening details; popout still has full Request", async ({ page }) => {
  await page.route("**/api/recommendations", route => route.fulfill({ json: { seeds: ["Cops"], items: [{ id: 7, mediaType: "movie", title: "A film", poster: "signal", availability: 1 }] } }));
  await login(page); await page.getByRole("button", { name: "Settings", exact: true }).click(); await page.locator('[data-pref="recommendations"]').check(); await page.getByRole("button", { name: "Close settings" }).click();
  await page.locator("#recommendations-content .poster-request").click();
  await expect(page.locator("#request-dialog")).toBeVisible(); await expect(page.locator("#episode-detail")).not.toBeVisible();
  await page.locator("#request-dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await page.locator("#recommendations-content .poster-art").click();
  await expect(page.locator("#episode-detail")).toBeVisible(); await expect(page.locator("#episode-request")).toHaveText("Request");
});

for (const width of [1440,393,280]) {
  test(`TV network and popout play icon preview at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 }); await login(page);
    await page.evaluate(() => showDetail({ title: "North of Nowhere", subtitle: "S2E4 · A New Day", mediaType: "tv", network: "Sample Network", overview: "A team follows a strange signal across the mountains. Every clue points to a place that should not exist.", genres: ["Drama", "Mystery"], poster: "/art/north.svg", backdrop: "/art/north.svg", playLink: "https://example.test/jellyfin", availability: 5 }));
    await expect(page.locator("#episode-network")).toHaveText("Network · Sample Network");
    await expect(page.locator("#episode-play")).toHaveAttribute("aria-label", "Play in Jellyfin"); await expect(page.locator("#episode-play svg")).toBeVisible();
    await page.locator("#episode-detail").screenshot({ path: `${shots}/marquee-network-play-${width}.png` });
    await page.evaluate(() => showDetail({ title: "A Movie", mediaType: "movie", network: "A studio", poster: "/art/signal.svg" }));
    await expect(page.locator("#episode-network")).toBeHidden(); await expect(page.locator("#episode-play")).toBeHidden();
  });
}

for (const width of [1440, 834, 1024, 393]) {
  test(`shelf arrows match desktop or touch-width layout at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 }); await login(page);
    for (const selector of [".recent-controls", "#popular-section .shelf-controls"]) {
      const controls = page.locator(selector).first();
      if (width > 1100) await expect(controls).toBeVisible(); else await expect(controls).toBeHidden();
    }
    await page.locator("#recent-section").screenshot({ path: `${shots}/marquee-touch-arrows-${width}.png` });
  });
}

test("library TV popout fills its network after metadata lookup", async ({ page }) => {
  await login(page);
  await page.route("**/api/library/test-show/facts", route => route.fulfill({ json: { facts: { status: "Returning Series" }, network: "Sample Network", mediaType: "tv", mediaId: 42 } }));
  await page.evaluate(() => showDetail({ title: "Test Show", mediaType: "tv", poster: "/art/north.svg", factsUrl: "/api/library/test-show/facts" }));
  await expect(page.locator("#episode-network")).toHaveText("Network · Sample Network");
  await page.evaluate(() => showDetail({ title: "No Network", mediaType: "tv", poster: "/art/north.svg" }));
  await expect(page.locator("#episode-network")).toBeHidden();
});

for (const width of [1440,393]) {
  test(`watchlist heart preview in all sizes at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 }); await login(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click(); await page.locator('[data-pref="watchlist"]').check();
    await page.getByRole("button", { name: "Close settings" }).click(); await view(page,"home");
    await page.evaluate(() => renderPersonalShelf("watchlist", Array.from({ length: 12 }, (_, i) => ({ id: `preview-${i}`, favoriteId: `preview-${i}`, favorite: true, title: ["The Last Signal","North of Nowhere","After Hours"][i%3], subtitle: "2026 · Series", art: ["signal","north","orbit"][i%3], watched: i%2===0, watchedScope: "series" }))));
    for (const size of ["small","standard","large"]) {
      await page.getByRole("button", { name: "Settings", exact: true }).click(); await page.locator("#poster-size").selectOption(size); await page.getByRole("button", { name: "Close settings" }).click();
      await expect(page.locator("#watchlist-content .watchlist-remove").first()).toHaveAttribute("aria-pressed","true");
      await page.locator("#watchlist-section").screenshot({ path: `${shots}/marquee-watchlist-heart-${size}-${width}.png` });
    }
  });
}

test("watchlist heart removes a favorite without opening popout or requesting media", async ({ page }) => {
  await login(page); await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const key of ["watchlist","continueWatching"]) await page.locator(`[data-pref="${key}"]`).check();
  await page.getByRole("button", { name: "Close settings" }).click(); await view(page,"home");
  await page.locator("#continueWatching-content [data-personal]").first().click(); await page.getByRole("button", { name: "Add to Jellyfin favorites", exact: true }).click(); await page.getByRole("button", { name: "Close episode details" }).click();
  await expect(page.locator("#watchlist-content .poster-card")).toHaveCount(1);
  const posted = page.waitForRequest(request => request.url().endsWith("/api/watchlist") && request.method()==="POST");
  await page.locator("#watchlist-content .watchlist-remove").click();
  expect((await posted).postDataJSON().saved).toBe(false); await expect(page.locator("#watchlist-content .poster-card")).toHaveCount(0); await expect(page.locator("#episode-detail")).not.toBeVisible();
});

for (const width of [1440,393]) {
  test(`Jellyfin version Settings preview at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height:900 }); await login(page);
    await page.route("**/api/jellyfin-version", route => route.fulfill({ json: {version:"10.11.2", online: true} }));
    await page.getByRole("button", {name:"Settings",exact:true}).click();
    await expect(page.locator("#jellyfin-version")).toHaveText("Jellyfin server version: 10.11.2");
    await page.locator("#jellyfin-version").scrollIntoViewIfNeeded();
    await page.locator("#settings").screenshot({path:`${shots}/marquee-jellyfin-version-${width}.png`});
  });
}
test("Jellyfin version has honest demo, unavailable and text-only states", async ({ page }) => {
  await login(page); await page.getByRole("button", {name:"Settings",exact:true}).click();
  await expect(page.locator("#jellyfin-version")).toContainText("demo mode (no server connected)");
  await page.getByRole("button", {name:"Close settings"}).click();
  await page.route("**/api/jellyfin-version", route => route.fulfill({json:{version:null}}));
  await page.getByRole("button", {name:"Settings",exact:true}).click();
  await expect(page.locator("#jellyfin-version")).toHaveText("Jellyfin server version: unavailable");
  await page.getByRole("button", {name:"Close settings"}).click();
  await page.route("**/api/jellyfin-version", route => route.fulfill({json:{version:"<img src=x onerror=alert(1)>"}}));
  await page.getByRole("button", {name:"Settings",exact:true}).click();
  await expect(page.locator("#jellyfin-version")).toContainText("<img src=x onerror=alert(1)>");
  await expect(page.locator("#jellyfin-version img")).toHaveCount(0);
});

for (const width of [393,1440]) {
  test(`Settings icon guide in all poster sizes at ${width}px`, async ({page}) => {
    await page.setViewportSize({width,height:1200}); await login(page);
    await page.getByRole("button", {name:"Settings",exact:true}).click();
    for (const size of ["small","standard","large"]) {
      await page.locator("#poster-size").selectOption(size);
      await expect(page.locator("#icon-guide li")).toHaveCount(10);
      await expect(page.locator("#icon-guide button, #icon-guide a")).toHaveCount(0);
      await page.locator("#icon-guide").scrollIntoViewIfNeeded();
      const overflow = await page.locator("#settings").evaluate(el=>el.scrollWidth > el.clientWidth+1); expect(overflow).toBe(false);
      for (let index=0; index<1; index++) {
        const group = page.locator(".icon-guide-group").nth(index);
        await group.scrollIntoViewIfNeeded();
        await group.screenshot({path:`${shots}/marquee-icon-guide-${size}-${width}-group${index}.png`});
      }
    }
  });
}

test("Settings ends with Connections below the icon guide", async ({page}) => {
  await page.setViewportSize({width:393,height:1000}); await login(page);
  await page.getByRole("button",{name:"Settings",exact:true}).click();
  expect(await page.locator("#settings").evaluate(el=> {const guide=el.querySelector("#icon-guide"),connections=el.querySelector(".connections");return Boolean(guide.compareDocumentPosition(connections)&Node.DOCUMENT_POSITION_FOLLOWING);})).toBe(true);
  await page.locator("#settings").evaluate(el=>el.scrollTop=el.scrollHeight);
  await page.locator("#settings").screenshot({path:`${shots}/marquee-settings-guide-connections-393.png`});
  await page.setViewportSize({width:1440,height:1000}); await page.locator("#settings").evaluate(el=>el.scrollTop=el.scrollHeight);
  await page.locator("#settings").screenshot({path:`${shots}/marquee-settings-guide-connections-1440.png`});
});

for (const width of [393, 1440]) {
  test(`held status and defaults preview at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 950 });
    let status = { version: "10.11.2", online: true };
    await page.route("**/api/jellyfin-version", route => route.fulfill({ json: status }));

    await login(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.locator(".jellyfin-version-line .jellyfin-status")).toHaveAttribute("data-status", "online");
    await page.locator(".jellyfin-version-line").scrollIntoViewIfNeeded();
    await page.locator("#settings").screenshot({ path: `${shots}/marquee-held-status-settings-online-${width}.png` });
    status = { version: null, online: false };
    await page.getByRole("button", { name: "Close settings" }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.locator(".jellyfin-version-line .jellyfin-status")).toHaveAttribute("data-status", "offline");
    await page.locator(".jellyfin-version-line").scrollIntoViewIfNeeded();
    await page.locator("#settings").screenshot({ path: `${shots}/marquee-held-status-settings-offline-${width}.png` });
    await page.getByRole("button", { name: "Close settings" }).click();
    status = { version: "10.11.2", online: true };
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    // Reset this test account only. Each page must leave the other page alone.
    for (const label of ["Discover", "On Jellyfin"]) {
      await page.getByRole("button", { name: `Reset ${label} order`, exact: true }).click();
      await expect(page.locator("#section-order-status")).toHaveText("Saved to your account.");
    }
    const keys = page.locator("#section-order-list li");
    expect(await keys.evaluateAll(rows => rows.map(row => row.dataset.orderKey))).toEqual(["search", "weather", "recent", "calendar", "popular", "inTheaters", "recommendations", "nextUp", "continueWatching", "watchNext", "watchlist", "watchLater", "leavingSoon", "requests"]);
    await page.getByRole("button", { name: "Move Next up down", exact: true }).click();
    await expect(page.locator("#section-order-status")).toHaveText("Saved to your account.");
    const beforeHome = await page.locator('[data-order-page="home"] li').evaluateAll(rows => rows.map(row => row.dataset.orderKey));
    await page.getByRole("button", { name: "Reset Discover order", exact: true }).click();
    await expect(page.locator("#section-order-status")).toHaveText("Saved to your account.");
    expect(await page.locator('[data-order-page="home"] li').evaluateAll(rows => rows.map(row => row.dataset.orderKey))).toEqual(beforeHome);
    await page.getByRole("button", { name: "Reset On Jellyfin order", exact: true }).click();
    await expect(page.locator("#section-order-status")).toHaveText("Saved to your account.");
    await page.locator("#section-order-settings").screenshot({ path: `${shots}/marquee-held-default-orders-${width}.png` });
    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(page.locator("#jellyfin-header-status")).toBeVisible();
    await expect(page.locator("#jellyfin-header-status")).toHaveAttribute("data-status", "online");
    await page.locator(".masthead").screenshot({ path: `${shots}/marquee-held-status-header-${width}.png` });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.route("**/api/jellyfin-version", route => route.abort());
    await page.getByRole("button", { name: "Close settings" }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.locator(".jellyfin-version-line .jellyfin-status")).toHaveAttribute("data-status", "unknown");
  });
}

test("header status sits left of Jellyfin and uses colorblind colors", async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 900 });
  await page.route("**/api/jellyfin-version", route => route.fulfill({ json: { online: true, version: "10.11.2" } }));
  await login(page);
  const dot = page.locator(".account #jellyfin-header-status");
  await expect(dot).toBeVisible();
  await expect(dot).toHaveAttribute("aria-label", "Jellyfin online");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator('[data-pref="colorblind"]').check();
  await expect(dot).toHaveCSS("background-color", "rgb(36, 168, 255)");
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.route("**/api/jellyfin-version", route => route.fulfill({ json: { online: false, version: null } }));
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(dot).toHaveAttribute("aria-label", "Jellyfin offline");
  await expect(dot).toHaveCSS("background-color", "rgb(255, 180, 91)");
});

for (const width of [393, 1440, 280]) {
  test(`notification choices persist, start off and stay readable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await login(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Notifications", exact: true }).click();
    await expect(page.locator("#notify-requests")).not.toBeChecked();
    await expect(page.locator("#notify-show-list")).toContainText("No shows selected");
    await page.locator("#notify-find-shows").click();
    await page.getByRole("button", { name: "Add North of Nowhere", exact: true }).click();
    await expect(page.locator("#notify-save-status")).toHaveText("Saved to your account.");
    await expect(page.locator("[data-reminder-type=airs]")).not.toBeChecked();
    await expect(page.locator("[data-reminder-type=available]")).not.toBeChecked();
    await page.locator("[data-reminder-type=airs]").check();
    await page.locator("[data-reminder-type=available]").check();
    await page.locator("#notify-requests").check();
    await expect(page.locator("#notify-save-status")).toHaveText("Saved to your account.");
    await page.getByRole("button", { name: "Close settings" }).click();
    await page.reload(); await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Notifications", exact: true }).click();
    await expect(page.locator("#notify-requests")).toBeChecked();
    await expect(page.locator("[data-reminder-type=airs]")).toBeChecked();
    await expect(page.locator("[data-reminder-type=available]")).toBeChecked();
    await expect(page.locator("#notify-device-status")).toHaveText("Not enabled on this device.");
    expect(await page.locator("#settings").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    // Full component capture, not a clipped viewport. CSS change is capture-only.
    await page.addStyleTag({ url: "/style.css" });
    await page.locator("#notification-settings").screenshot({ path: `${shots}/marquee-notifications-built-${width}.png` });
    await page.getByRole("button", { name: "Remove North of Nowhere reminder", exact: true }).click();
    await expect(page.locator("#notify-save-status")).toHaveText("Saved to your account.");
    await expect(page.locator("#notify-show-list")).toContainText("No shows selected");
  });
}

for (const width of [393, 1440]) {
  test(`on-poster progress is clamped and fits every size at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 950 });
    await page.route("**/api/personal/continueWatching", route => route.fulfill({ json: { items: Array.from({ length: 12 }, (_, i) => ({ id: `progress-${i}`, title: ["North of Nowhere", "Wild Coast", "The Last Signal"][i % 3], subtitle: `S2E${i + 1} · Episode title`, art: ["north", "coast", "signal"][i % 3], progress: [42, 74, -5, 150][i % 4], remaining: 23, detail: {} })) } }));
    await login(page); await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.locator('[data-pref="continueWatching"]').check(); await page.getByRole("button", { name: "Close settings" }).click(); await view(page, "home");
    for (const size of ["small", "standard", "large"]) {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.locator("#poster-size").selectOption(size); await page.getByRole("button", { name: "Close settings" }).click();
      const bars = page.locator("#continueWatching-content .poster-art progress"); await expect(bars).toHaveCount(12);
      await expect(bars.nth(2)).toHaveAttribute("value", "0"); await expect(bars.nth(3)).toHaveAttribute("value", "100");
      const geometry = await page.locator("#continueWatching-content .poster-art").first().evaluate(art => {
        const a = art.getBoundingClientRect(), p = art.querySelector("progress").getBoundingClientRect(); return { bottom: Math.abs(a.bottom - p.bottom), height: p.height };
      });
      expect(geometry.bottom).toBeLessThanOrEqual(2); expect(geometry.height).toBe(5);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.locator("#continueWatching-section").screenshot({ path: `${shots}/marquee-progress-built-${size}-${width}.png` });
    }
  });
}

test("notification APIs enforce auth, origin, input limits and demo push safety", async ({ page, request }) => {
  expect((await request.get("/api/notifications")).status()).toBe(401);
  expect((await request.get("/api/notification-shows")).status()).toBe(401);
  await login(page);
  const status = await (await page.request.get("/api/notifications")).json();
  expect(status.enabled).toBe(false); expect(status.preferences.requests).toBe(false);
  expect((await page.request.post("/api/notifications", { headers: { Origin: "https://evil.invalid" }, data: { requests: true, shows: [], timezone: "America/New_York" } })).status()).toBe(403);
  expect((await page.request.post("/api/notifications", { headers: { Origin: "http://127.0.0.1:8739" }, data: { requests: true, shows: [], timezone: "invalid" } })).status()).toBe(400);
  expect((await page.request.post("/api/notifications/subscribe", { headers: { Origin: "http://127.0.0.1:8739" }, data: { endpoint: "https://127.0.0.1/private" } })).status()).toBe(400);
  expect((await page.request.post("/api/notifications/test", { headers: { Origin: "http://127.0.0.1:8739" }, data: {} })).status()).toBe(400);
});

for (const width of [393, 1440, 280]) {
  test(`status left of Jellyfin header preview at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.route("**/api/jellyfin-version", route => route.fulfill({ json: { online: true, version: "10.11.2" } }));
    await page.route("**/api/me", route => route.fulfill({ json: { name: "Demo", isAdmin: true, canRequest: true, requestAccess: { movie: true, tv: true }, jellyfinWebUrl: "https://media.example.test/" } }));
    await login(page);
    await expect(page.locator("#jellyfin-home")).toBeVisible();
    await page.locator("#demo-badge").evaluate(el => { el.hidden = true; });
    const dot = page.locator("#jellyfin-header-status");
    await expect(dot).toHaveAttribute("data-status", "online");
    const position = await page.evaluate(() => {
      const dot = document.querySelector("#jellyfin-header-status").getBoundingClientRect();
      const logo = document.querySelector("#jellyfin-home").getBoundingClientRect();
      const settings = document.querySelector("#settings-button").getBoundingClientRect();
      return { dotEnd: dot.right, logoStart: logo.left, logoEnd: logo.right, settingsStart: settings.left, centerDiff: Math.abs(dot.y + dot.height / 2 - logo.y - logo.height / 2) };
    });
    expect(position.dotEnd).toBeLessThan(position.logoStart);
    expect(position.logoEnd).toBeLessThan(position.settingsStart);
    expect(position.centerDiff).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator(".masthead").screenshot({ path: `${shots}/marquee-status-left-jellyfin-${width}.png` });
    await page.screenshot({ path: `${shots}/marquee-status-left-jellyfin-full-${width}.png` });
  });
}

for (const width of [393, 1440, 280]) {
  test(`dedicated Notifications settings tab at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1050 });
    await login(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const general = page.getByRole("tab", { name: "General", exact: true });
    const notifications = page.getByRole("tab", { name: "Notifications", exact: true });
    await expect(general).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#notification-settings")).toBeHidden();
    await page.locator("#settings").screenshot({ path: `${shots}/marquee-settings-general-tab-${width}.png` });
    await general.focus(); await page.keyboard.press("ArrowRight");
    await expect(notifications).toBeFocused();
    await expect(notifications).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#settings-general-panel")).toBeHidden();
    for (const id of ["notify-requests", "notify-enable", "notify-test", "notify-timezone", "notify-show-query", "notify-find-shows"]) await expect(page.locator(`#${id}`)).toBeVisible();
    await page.locator("#settings").screenshot({ path: `${shots}/marquee-settings-notifications-tab-${width}.png` });
    expect(await page.locator("#settings").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.keyboard.press("Home"); await expect(general).toBeFocused();
    await expect(page.locator("#notification-settings")).toBeHidden();
    await page.getByRole("button", { name: "Close settings" }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(general).toHaveAttribute("aria-selected", "true");
  });
}

for (const width of [393, 1440, 280]) {
  test(`show reminders search as typed without punctuation at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1050 });
    await login(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Notifications", exact: true }).click();
    const search = page.getByRole("textbox", { name: "Search shows", exact: true });
    await search.fill("rj decker");
    await expect(page.getByRole("button", { name: "Add R.J. Decker", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add North of Nowhere", exact: true })).toHaveCount(0);
    await page.locator("#notify-show-results").scrollIntoViewIfNeeded();
    await page.locator("#settings").screenshot({ path: `${shots}/marquee-reminder-rj-search-${width}.png` });
    await search.fill("rj deckr");
    await page.getByRole("button", { name: "Add R.J. Decker", exact: true }).click();
    await expect(page.locator("#notify-save-status")).toHaveText("Saved to your account.");
    await expect(page.locator("#notify-show-list")).toContainText("R.J. Decker");
    await search.fill("north");
    await expect(page.getByRole("button", { name: "Add North of Nowhere", exact: true })).toBeVisible();
    await page.locator("#notify-show-query").scrollIntoViewIfNeeded();
    await page.locator("#settings").screenshot({ path: `${shots}/marquee-notifications-live-search-${width}.png` });
    expect(await page.locator("#settings").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await search.fill("no such show");
    await expect(page.locator("#notify-search-status")).toHaveText("No matching shows in your Jellyfin library.");
    await search.fill("");
    await expect(page.getByRole("button", { name: "Add North of Nowhere", exact: true })).toBeVisible();
  });
}

test("show search ignores an older response after a new query", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Notifications", exact: true }).click();
  let release;
  let reached;
  const started = new Promise(resolve => { reached = resolve; });
  await page.route("**/api/notification-shows?query=old", async route => {
    reached(); await new Promise(resolve => { release = resolve; });
    await route.fulfill({ json: { shows: [{ id: "old", title: "Old response" }] } });
  });
  await page.getByRole("textbox", { name: "Search shows", exact: true }).fill("old");
  await started;
  await page.getByRole("textbox", { name: "Search shows", exact: true }).fill("north");
  await expect(page.getByRole("button", { name: "Add North of Nowhere", exact: true })).toBeVisible();
  release();
  await expect(page.getByRole("button", { name: "Add Old response", exact: true })).toHaveCount(0);
});

for (const width of [393, 1440]) {
  test(`In theaters works in every poster size at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1100 });
    const items = Array.from({ length: 12 }, (_, i) => ({ id: 9500 + i, mediaType: "movie", title: ["The Last Signal", "Orbit Nine", "Paper Moons"][i % 3], year: "2026", poster: ["signal", "orbit", "moons"][i % 3], availability: i === 0 ? 5 : i === 1 ? 2 : null, requested: i === 1 }));
    await page.route("**/api/in-theaters", route => route.fulfill({ json: { region: "US", items } }));
    await page.route("**/api/me", async route => { const response=await route.fetch(); if(response.status()!==200)return route.fulfill({response}); await route.fulfill({ json: { name: "Demo viewer", isAdmin: false, canRequest: true, requestAccess: { movie: true, tv: true, advanced: false } } }); });
    await login(page);
    await expect(page.locator("#inTheaters-content .result-card")).toHaveCount(12);
    await expect(page.locator("#inTheaters-content .result-card").nth(0).locator(".request-btn")).toHaveCount(0);
    await expect(page.locator("#inTheaters-content .result-card").nth(1).locator(".request-btn")).toHaveCount(0);
    await expect(page.locator("#inTheaters-content .result-card").nth(2).locator(".request-btn")).toHaveCount(1);
    for (const size of ["small", "standard", "large"]) {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.locator("#poster-size").selectOption(size);
      await page.getByRole("button", { name: "Close settings" }).click();
      await page.locator("#inTheaters-section").scrollIntoViewIfNeeded();
      const cardWidth = await page.locator("#inTheaters-content .result-card").first().evaluate(el => el.getBoundingClientRect().width);
      expect(cardWidth).toBeGreaterThan(90);
      const reference = await page.locator("#popular-movies .ranked-poster").first().evaluate(el => el.getBoundingClientRect().width);
      expect(Math.abs(cardWidth - reference)).toBeLessThanOrEqual(1);
      await page.locator("#inTheaters-section").screenshot({ path: `${shots}/marquee-theaters-${size}-${width}.png` });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.locator('[data-pref="inTheaters"]').uncheck();
    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(page.locator("#inTheaters-section")).toBeHidden();
    await page.reload(); await expect(page.locator("#inTheaters-section")).toBeHidden();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.locator('[data-pref="inTheaters"]').check();
    await page.getByRole("button", { name: "Close settings" }).click();
    await page.getByRole("button", { name: "On Jellyfin", exact: true }).click();
    await expect(page.locator("#inTheaters-section")).toBeHidden();
    await page.getByRole("button", { name: "Discover", exact: true }).click();
    await expect(page.locator("#inTheaters-section")).toBeVisible();
    let sent;
    await page.route("**/api/seerr/request", async route => { sent = route.request().postDataJSON(); await route.fulfill({ json: { ok: true, status: 1 } }); });
    page.once("dialog", dialog => dialog.accept());
    await page.locator("#inTheaters-content .result-card").nth(2).locator(".request-btn").click();
    await expect.poll(() => sent?.mediaId).toBe(9502);
    expect(sent.mediaType).toBe("movie");
    await expect(page.locator("#inTheaters-content .result-card").nth(2).locator(".request-btn")).toHaveCount(0);
  });
}

test("missing theater key stays a friendly shelf message and keeps Discover usable", async ({ page }) => {
  await page.route("**/api/in-theaters", route => route.fulfill({ status: 503, json: { error: "In theaters needs a TMDB API key in the server settings." } }));
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await login(page);
  await expect(page.locator("#inTheaters-status")).toHaveText("In theaters needs a TMDB API key in the server settings.");
  await expect(page.locator("#inTheaters-content .result-card")).toHaveCount(0);
  await expect(page.locator("#recent .poster-card")).toHaveCount(6);
  await expect(page.locator("#popular-movies .result-card")).toHaveCount(10);
  expect(errors).toEqual([]);
});

test("theater coverage caps older oversized responses at 25 without a cap notice", async ({ page }) => {
  const items = Array.from({ length: 60 }, (_, i) => ({ id: 9800 + i, mediaType: "movie", title: i === 45 ? "The Social Reckoning" : `Theater movie ${i + 1}`, poster: "signal", year: "2026", availability: null, requested: false }));
  await page.route("**/api/in-theaters", route => route.fulfill({ json: { items, region: "US", capped: true } }));
  await login(page);
  await expect(page.locator("#inTheaters-content .result-card")).toHaveCount(25);
  await expect(page.locator("#inTheaters-content .result-card").nth(24)).toContainText("Theater movie 25");
  await expect(page.locator("#inTheaters-content .result-card").first()).toContainText("Theater movie 1");
  await expect(page.locator("#inTheaters-status")).toBeHidden();
});

for (const width of [280, 393, 1440]) {
  test(`search magnifier is accessible and submits at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await login(page);
    const search = page.getByRole("button", { name: "Search", exact: true });
    await expect(search).toBeVisible();
    await expect(search).toHaveText("");
    await expect(search.locator("svg")).toHaveAttribute("aria-hidden", "true");
    const box = await search.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    await page.locator("#search-section").screenshot({ path: `${shots}/marquee-search-icon-${width}.png` });
    await page.getByPlaceholder("Search movies and shows").fill("Signal");
    await search.click();
    await expect(page.locator("#search-results .result-card").first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

for (const width of [280, 320, 393, 1440]) {
  test(`utility icon buttons keep labels and actions at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1050 });
    await login(page);
    await view(page, "discover");
    const refresh = page.getByRole("button", { name: "Refresh", exact: true });
    await expect(refresh).toHaveText("");
    await refresh.click();
    await expect(refresh).toBeEnabled();
    await page.locator(".calendar-toolbar").screenshot({ path: `${shots}/marquee-refresh-icon-${width}.png` });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const city = page.getByRole("button", { name: "Find city", exact: true });
    await expect(city).toHaveText("");
    await page.getByPlaceholder("City name").fill("Sample");
    await city.click();
    await expect(page.getByRole("button", { name: "Sample City, Example Region", exact: true })).toBeVisible();
    await page.locator("#weather-city-query").locator("..").screenshot({ path: `${shots}/marquee-city-icon-${width}.png` });
    await page.getByRole("tab", { name: "Notifications", exact: true }).click();
    const find = page.getByRole("button", { name: "Find shows", exact: true });
    await expect(find).toHaveText("");
    await page.getByRole("textbox", { name: "Search shows", exact: true }).fill("north");
    await find.click();
    await page.getByRole("button", { name: "Add North of Nowhere", exact: true }).click();
    await expect(page.locator("#notify-save-status")).toHaveText("Saved to your account.");
    const remove = page.getByRole("button", { name: "Remove North of Nowhere reminder", exact: true });
    await expect(remove).toHaveText("");
    for (const button of [find, remove]) {
      await expect(button.locator("svg")).toHaveAttribute("aria-hidden", "true");
      const box = await button.boundingBox(); expect(box.width).toBeGreaterThanOrEqual(button === remove ? 36 : 44); expect(box.height).toBeGreaterThanOrEqual(button === remove ? 36 : 44);
    }
    await page.locator("#notify-show-list").scrollIntoViewIfNeeded();
    const options = page.locator(".reminder-option");
    await expect(options).toHaveCount(2);
    const first = await options.nth(0).boundingBox(), second = await options.nth(1).boundingBox();
    if (width >= 393) expect(Math.abs(first.y - second.y)).toBeLessThanOrEqual(1);
    else expect(second.y).toBeGreaterThanOrEqual(first.y);
    expect(first.height).toBeGreaterThanOrEqual(32);
    await page.locator("#settings").screenshot({ path: `${shots}/marquee-reminder-icons-${width}.png` });
    await remove.click();
    await expect(page.locator("#notify-show-list")).toContainText("No shows selected");
    expect(await page.locator("#settings").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  });
}

for (const width of [1440,393,280]) {
  test(`current popup certification and embedded year at ${width}px`, async ({page}) => {
    await page.setViewportSize({width,height:1000}); await login(page);
    for (const [title,year,expected] of [["Brothers (2026)",2026,"Brothers (2026)"],["Brothers 2026",2026,"Brothers 2026"],["Brothers (2026) ",2026,"Brothers (2026) "],["2001: A Space Odyssey",1968,"2001: A Space Odyssey (1968)"],["Class of 1999",1990,"Class of 1999 (1990)"],["Brothers",2026,"Brothers (2026)"]]) {
      await page.evaluate(({title,year}) => showDetail({title,year,mediaType:"movie",subtitle:"2026 · Movie",contentRating:"PG-13",runtime:104}),{title,year});
      await expect(page.locator("#episode-title")).toHaveText(expected);
      await expect(page.locator("#episode-subtitle")).toHaveText("2026 · PG-13");
      await expect(page.locator("#episode-content-rating")).toBeHidden();
      await expect(page.locator("#episode-meta")).not.toContainText("Movie");
      expect(await page.locator("#episode-detail").evaluate(e=>e.scrollWidth<=e.clientWidth)).toBe(true);
      await page.locator("#episode-close").click();
    }
    await page.evaluate(()=>showDetail({title:"A series",mediaType:"tv",subtitle:"TV series",contentRating:"TV-14"}));
    await expect(page.locator("#episode-subtitle")).toHaveText("TV series");
    await expect(page.locator("#episode-certification-line")).toHaveText("TV-14");
    await page.locator("#episode-close").click();
    await page.evaluate(()=>showDetail({title:"Missing certification",mediaType:"movie",subtitle:"Movie"}));
    await expect(page.locator("#episode-subtitle")).toHaveText("");
  });
}

test("episode air date survives async series facts and never substitutes series premiere", async ({page})=>{
  await login(page);await page.route("**/api/library/air-date/facts",route=>route.fulfill({json:{mediaType:"tv",facts:{releases:[{type:"First aired",date:"2020-04-02",region:null}]}}}));
  await page.evaluate(()=>showDetail({title:"Example series",mediaType:"tv",subtitle:"S2E4 · Example episode",contentRating:"TV-14",episodeAirDate:"2026-10-09T20:00:00Z",factsUrl:"/api/library/air-date/facts"}));
  await expect(page.locator("#episode-air-date")).toContainText("Episode air date");
  await expect(page.locator("#episode-air-date-top")).toContainText("Oct 9, 2026");
  await expect(page.locator("#episode-facts")).toContainText("Apr 2, 2020");
  await page.locator("#episode-close").click();
  await page.evaluate(()=>showDetail({title:"Missing date",mediaType:"tv",subtitle:"S2E5"}));
  await expect(page.locator("#episode-air-date")).toBeHidden();
});

for(const width of [1440,393,280]) {
 test(`episode date placement and invalid-date reset at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:1000});await login(page);
  await page.evaluate(()=>showDetail({title:"Example",mediaType:"tv",subtitle:"S2E4",runtime:42,cast:["Example Actor"],episodeAirDate:"2026-10-08T00:00:00Z"}));
  if(width>600) {
   await expect(page.locator("#episode-air-date-top")).toBeVisible();
   await expect(page.locator("#episode-air-date")).toBeHidden();
   expect(await page.evaluate(()=>Math.abs(document.querySelector("#episode-meta-top").getBoundingClientRect().top-document.querySelector("#episode-air-date-top").getBoundingClientRect().top))).toBeLessThan(2);
  } else {
   await expect(page.locator("#episode-air-date")).toBeVisible();
   expect(await page.evaluate(()=>{const date=document.querySelector("#episode-air-date").getBoundingClientRect();return date.top>=document.querySelector("#episode-meta").getBoundingClientRect().bottom && date.bottom<=document.querySelector("#episode-cast").getBoundingClientRect().top;})).toBe(true);
  }
  await page.locator("#episode-close").click();
  await page.evaluate(()=>showDetail({title:"Invalid date",mediaType:"tv",subtitle:"S2E5",episodeAirDate:"2026-02-30"}));
  await expect(page.locator("#episode-air-date")).toBeHidden();await expect(page.locator("#episode-air-date-top")).toBeHidden();
 });
}

for(const width of [1440,393]) {
 test(`episode label appears once, never repeated with runtime at ${width}px`, async({page})=>{
  await page.setViewportSize({width,height:1000});await login(page);
  await page.evaluate(()=>showDetail({title:"Example series",mediaType:"tv",subtitle:"Episode 4: The Long Way Home",runtime:104,contentRating:"TV-14"}));
  await expect(page.locator("#episode-subtitle")).toContainText("Episode 4: The Long Way Home");
  await expect(page.locator("#episode-meta")).toHaveText("104 min");
  await expect(page.locator("#episode-meta-top")).toHaveText("104 min");
 });
}

for (const width of [1440, 834, 601, 393, 280]) {
  test(`detail icon actions sit beside Close on every size at ${width}px`, async ({page}) => {
    await page.setViewportSize({width,height:1000});
    await login(page);
    await page.evaluate(() => showDetail({title:"Toolbar test",subtitle:"Movie",mediaType:"movie",jellyfinId:"demo-episode",playLink:"https://jellyfin.example.com",runtime:100}));
    await expect(page.locator("#episode-play")).toBeVisible();
    await expect(page.locator("#episode-trailer")).toBeVisible();
    const styles=await page.locator("#episode-save, #episode-play, #episode-trailer, #episode-close").evaluateAll(els=>els.map(el=>{const s=getComputedStyle(el);return [s.width,s.height,s.borderWidth,s.borderStyle,s.borderColor,s.borderRadius,s.backgroundColor];}));
    expect(styles).toHaveLength(4);
    for(const style of styles) expect(style).toEqual(styles[0]);
    const desktop=width>600;
    expect(await page.locator(".episode-quick-actions").evaluate(el=>el.parentElement.className)).toBe("episode-toolbar");
    {
      const play=await page.locator("#episode-play").boundingBox(),close=await page.locator("#episode-close").boundingBox(),title=await page.locator("#episode-title").boundingBox();
      expect(Math.abs(play.y-close.y)).toBeLessThan(2);
      expect(play.x+play.width).toBeLessThan(close.x);
      expect(play.y+play.height).toBeLessThan(title.y);
    }
    await page.setViewportSize({width:desktop?393:1440,height:1000});
    expect(await page.locator(".episode-quick-actions").evaluate(el=>el.parentElement.className)).toBe("episode-toolbar");
    await page.locator("#episode-close").click();
    await expect(page.locator("#episode-detail")).not.toBeVisible();
  });
}

for (const width of [393,1440]) {
 test(`recommendation metadata follows title and scores align at ${width}px`, async ({page})=>{
  await page.setViewportSize({width,height:1000});await login(page);
  await page.getByRole("button",{name:"Settings",exact:true}).click();await page.locator('[data-pref="recommendations"]').check();await page.getByRole("button",{name:"Close settings"}).click();
  await page.evaluate(()=>{document.querySelector("#recommendations-content").innerHTML=["Law & Order: Special Victims Unit","Reacher","The Office"].map((title,i)=>resultCardHtml({id:800+i,title,mediaType:"tv",year:2026,contentRating:"TV-MA",poster:"north",rating:{value:8.1,source:"TMDB"}})).join("");});
  const positions=await page.locator('#recommendations-content .result-card').evaluateAll(cards=>cards.map(card=>({titleBottom:card.querySelector('.caption-copy h3').getBoundingClientRect().bottom,meta:card.querySelector('.caption-copy .result-meta').getBoundingClientRect().y,score:card.querySelector('.media-rating').getBoundingClientRect().y})));
  for(const value of positions){expect(value.meta-value.titleBottom).toBeGreaterThanOrEqual(0);expect(value.meta-value.titleBottom).toBeLessThan(8);expect(Math.abs(value.score-positions[0].score)).toBeLessThan(1);}
  await page.locator('#recommendations-content').screenshot({path:`${shots}/marquee-title-alignment-${width}.png`});
 });
}

for (const width of [393,1440]) {
 test(`credited streamers replace shelf type only, search keeps Movie at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:1000});await login(page);
  await page.evaluate(()=>{
    const items=[{id:901,title:"Netflix credit",streamer:"Netflix"},{id:902,title:"Apple credit",streamer:"Apple"},{id:903,title:"Studio credit",streamer:null}].map(item=>({...item,mediaType:"movie",year:2026,contentRating:"R",poster:"north"}));
    document.querySelector("#popular-movies").innerHTML=items.map(result=>`<div class="ranked-poster">${resultCardHtml(result)}</div>`).join("");
    renderSearch(items);
  });
  await expect(page.locator('#popular-movies .result-meta')).toHaveText(["Netflix · 2026 · R","Apple · 2026 · R","Movie · 2026 · R"]);
  for(const row of await page.locator('#search-results .result-meta').all()) await expect(row).toContainText("Movie · 2026");
 });
}

for (const width of [1440,393,280]) {
 test(`TV certification has its own line above episode and resets for movies at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:1000});await login(page);
  await page.evaluate(()=>showDetail({title:"Landman",year:2024,mediaType:"tv",subtitle:"S1E5 · Where is Home · TV-MA",contentRating:"TV-MA",runtime:65,episodeAirDate:"2024-12-08"}));
  await expect(page.locator('#episode-certification-line')).toHaveText("TV-MA");await expect(page.locator('#episode-certification-line')).toBeVisible();
  await expect(page.locator('#episode-subtitle')).toHaveText("S1E5 · Where is Home");
  const rating=await page.locator('#episode-certification-line').boundingBox(),episode=await page.locator('#episode-subtitle').boundingBox();expect(rating.y+rating.height).toBeLessThanOrEqual(episode.y);
  await page.evaluate(()=>showDetail({title:"No rating",mediaType:"tv",subtitle:"S1E1 · Pilot"}));await expect(page.locator('#episode-certification-line')).toBeHidden();await expect(page.locator('#episode-subtitle')).toHaveText("S1E1 · Pilot");
  await page.evaluate(()=>showDetail({title:"Movie",mediaType:"movie",subtitle:"2026 · Movie",contentRating:"R"}));await expect(page.locator('#episode-certification-line')).toBeHidden();await expect(page.locator('#episode-subtitle')).toHaveText("2026 · R");
 });
}

for(const width of [393,1440]){
 test(`TV network duplicates are removed from the detail at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:1000});await login(page);
  await page.evaluate(()=>showDetail({title:"Network test",mediaType:"tv",subtitle:"S1E1 · Pilot",network:"Paramount+, Paramount+, paramount+, Netflix",contentRating:"TV-MA"}));
  await expect(page.locator('#episode-network')).toHaveText("Network · Paramount+, Netflix");
  await page.evaluate(()=>showDetail({title:"No network",mediaType:"tv",subtitle:"S1E1"}));await expect(page.locator('#episode-network')).toBeHidden();
 });
}

test("expired-session account switch clears private facts and ignores old responses", async ({ page }) => {
  await login(page);
  let viewer = "first", calls = 0;
  await page.route("**/api/library/shared/facts", route => {
    calls++;
    route.fulfill({ json: { facts: { status: `${viewer} status`, scores: { imdb: 7.2 } }, mediaType: "tv", mediaId: 10, favoriteId: "shared", favorite: viewer === "first", watched: viewer === "first" } });
  });
  await page.evaluate(() => showDetail({ title: "Shared item", mediaType: "tv", factsUrl: "/api/library/shared/facts" }));
  await expect(page.locator("#episode-facts")).toContainText("first status");
  await page.locator("#episode-close").click();
  await page.route("**/api/accessibility-settings", route => route.fulfill({ status: 401, json: { error: "Please sign in." } }));
  await page.evaluate(() => api("/api/accessibility-settings").catch(() => {}));
  await expect(page.locator("#login")).toBeVisible();
  await expect(page.locator("#recent")).toBeEmpty();
  await page.unroute("**/api/accessibility-settings");
  viewer = "second";
  await page.evaluate(() => enter("Second viewer"));
  await page.evaluate(() => showDetail({ title: "Shared item", mediaType: "tv", factsUrl: "/api/library/shared/facts" }));
  await expect(page.locator("#episode-facts")).toContainText("second status");
  await expect(page.locator("#episode-save")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#episode-poster-status .watched-badge")).toHaveCount(0);
  expect(calls).toBe(2);
});
test("movie production company commas remain intact while TV duplicates dedupe", async ({ page }) => {
  await login(page);
  await page.evaluate(() => showDetail({ title: "Synthetic movie", mediaType: "movie", subtitle: "Movie", network: "First Company, Inc., Second Company, Inc.", runtime: 90 }));
  await expect(page.locator("#episode-meta-top")).toHaveText("First Company, Inc., Second Company, Inc. · 90 min");
});

test("all shelf renders preserve unchanged posters and unchanged cards", async ({ page }) => {
  await login(page);
  const result = await page.evaluate(() => {
    const outcomes = [];
    for (const selector of ["#recent", "#search-results", "#popular-movies", "#popular-tv", "#inTheaters-content", "#recommendations-content", "#continueWatching-content", "#nextUp-content", "#leavingSoon-content", "#watchlist-content"]) {
      const container = document.querySelector(selector);
      const html = '<article><img src="/art/north.svg" loading="lazy"><h3>A</h3></article><article><img src="/art/south.svg" loading="lazy"><h3>B</h3></article>';
      updateShelfHtml(container, html);
      const cards = [...container.children], images = [...container.querySelectorAll("img")];
      updateShelfHtml(container, html);
      const same = cards.every((card, i) => card === container.children[i]);
      updateShelfHtml(container, '<article><img src="/art/south.svg" loading="lazy"><h3>B changed</h3></article><article><img src="/art/north.svg" loading="lazy"><h3>A changed</h3></article>');
      outcomes.push({ selector, same, reordered: container.querySelectorAll("img")[0] === images[1] && container.querySelectorAll("img")[1] === images[0] });
    }
    return outcomes;
  });
  for (const item of result) { expect(item.same, item.selector).toBe(true); expect(item.reordered, item.selector).toBe(true); }
  await page.evaluate(() => updateShelfHtml(document.querySelector("#recent"), '<article><img src="/art/south.svg?poster-test=1" loading="eager"><h3>Before</h3></article>'));
  const image = await page.locator("#recent img").first().elementHandle();
  await expect.poll(() => image.evaluate(el => el.complete)).toBe(true);
  let imageRequests = 0;
  page.on("request", request => { if (request.url().includes("poster-test=1")) imageRequests++; });
  await page.evaluate(() => updateShelfHtml(document.querySelector("#recent"), '<article><img src="/art/south.svg?poster-test=1" loading="eager"><h3>New metadata</h3></article>'));
  expect(await image.evaluate(el => el.isConnected)).toBe(true);
  await page.waitForTimeout(100);
  expect(imageRequests).toBe(0);
});

test("loaded poster reorders do not issue new image requests, including moveBefore fallback", async ({ page }) => {
  await login(page);
  await page.evaluate(() => {
    document.querySelector("#recent").moveBefore = undefined;
    updateShelfHtml(document.querySelector("#recent"), '<article><img src="/art/north.svg?reorder=1" loading="eager"><h3>A</h3></article><article><img src="/art/south.svg?reorder=2" loading="eager"><h3>B</h3></article>');
  });
  await expect.poll(() => page.locator("#recent img").evaluateAll(els => els.every(el => el.complete))).toBe(true);
  let requests = 0; page.on("request", req => { if (req.url().includes("reorder=")) requests++; });
  await page.evaluate(() => updateShelfHtml(document.querySelector("#recent"), '<article><img src="/art/south.svg?reorder=2" loading="eager"><h3>B changed</h3></article><article><img src="/art/north.svg?reorder=1" loading="eager"><h3>A changed</h3></article>'));
  await page.waitForTimeout(100); expect(requests).toBe(0);
});

test("calendar Requests and Leaving soon refresh only on the visible active page and unchanged data is a no-op", async ({ page }) => {
  await page.clock.install(); await login(page);
  await page.evaluate(() => { state.prefs.shelfRefreshMinutes = 1; state.prefs.requests = true; state.prefs.calendar = true; state.prefs.leavingSoon = true; persist(); });
  let calls = { calendar: 0, requests: 0, leavingSoon: 0 };
  for (const [key, url] of Object.entries({ calendar: "**/api/calendar?*", requests: "**/api/seerr/requests*", leavingSoon: "**/api/leaving-soon" })) {
    await page.route(url, async route => { calls[key]++; const response = await route.fetch(); await route.fulfill({ response }); });
  }
  await view(page, "discover");
  await page.evaluate(() => document.activeElement.blur());
  await page.clock.runFor(75000);
  await expect.poll(() => calls.calendar).toBeGreaterThan(0);
  const calendarCalls = calls.calendar;
  const calendarNode = await page.locator("#calendar").evaluateHandle(el => el.firstChild);
  await page.clock.runFor(75000);
  await expect.poll(() => calls.calendar).toBeGreaterThan(calendarCalls);
  expect(await calendarNode.evaluate(el => el.isConnected)).toBe(true);
  await view(page, "home");
  await page.evaluate(() => document.activeElement.blur());
  await page.clock.runFor(75000);
  await expect.poll(() => calls.requests).toBeGreaterThan(0);
  await expect.poll(() => calls.leavingSoon).toBeGreaterThan(0);
  const requestsNode = await page.locator("#requests").evaluateHandle(el => el.firstChild);
  const leavingNode = await page.locator("#leavingSoon-content").evaluateHandle(el => el.firstChild);
  await page.clock.runFor(75000);
  expect(await requestsNode.evaluate(el => el.isConnected)).toBe(true);
  expect(await leavingNode.evaluate(el => el.isConnected)).toBe(true);
  await page.evaluate(() => Object.defineProperty(document, "hidden", { configurable: true, value: true }));
  const before = { ...calls };
  await page.clock.runFor(150000);
  expect(calls).toEqual(before);
});

for (const width of [393,834,1440]) test(`Popular metadata follows title and scores align at ${width}px`, async ({ page }) => {
  await page.setViewportSize({width,height:1000}); await login(page);
  for (const size of ["small","standard","large"]) {
    const result = await page.evaluate(size => {
      state.prefs.posterSize=size; applyPrefs();
      const container=document.querySelector("#popular-tv"); container.replaceChildren();
      updateShelfHtml(container,[{title:"Law & Order: Special Victims Unit",streamer:"TV",year:1999,contentRating:"TV-14"},{title:"Reacher",streamer:"Amazon",year:2022,contentRating:"TV-MA"},{title:"A very long show name here",streamer:"Long Network Name",year:2026,contentRating:"TV-MA"}].map((item,i)=>`<div class="ranked-poster">${resultCardHtml({...item,mediaType:"tv",id:i+1,poster:"signal",rating:{value:8.2,source:"TMDB"}})}</div>`).join(""));
      return [...container.querySelectorAll(".result-card")].map(card => {
        const title=card.querySelector(".caption-copy h3"),meta=card.querySelector(".caption-copy .result-meta");
        return {score:card.querySelector(".media-rating").getBoundingClientRect().top,gap:meta.getBoundingClientRect().top-title.getBoundingClientRect().bottom,metaBottom:meta.getBoundingClientRect().bottom};
      });
    }, size);
    for(const item of result) { expect(Math.abs(item.score-result[0].score),size).toBeLessThan(1); expect(item.gap,size).toBeGreaterThanOrEqual(0); expect(item.gap,size).toBeLessThan(8); expect(item.metaBottom,size).toBeLessThan(item.score); }
  }
});

for(const width of [393,1440]) test(`TV status includes season count and hides missing count at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:1000});await login(page);
  await page.evaluate(()=>showDetail({title:"Test series",mediaType:"tv",facts:{status:"Returning series",seasonCount:4}}));
  await expect(page.locator("#episode-facts")).toContainText("Returning series · 4 seasons");
  await page.evaluate(()=>renderDetailFacts({status:"Ended",seasonCount:1}));
  await expect(page.locator("#episode-facts")).toContainText("Ended · 1 season");
  await page.evaluate(()=>renderDetailFacts({status:"Returning series",seasonCount:null}));
  await expect(page.locator("#episode-facts")).not.toContainText("seasons");
  await page.evaluate(()=>renderDetailFacts({status:"Released"}));
  await expect(page.locator("#episode-facts")).toContainText("Released");
});

for(const width of [393,1440]) test(`network search choices preserve titles and browse newest shows at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:1000});await login(page);
 await page.route("**/api/networks?*",r=>r.fulfill({json:{networks:[{id:65,name:"History",country:"US"},{id:2360,name:"History",country:"CA"}]}}));
 await page.route("**/api/seerr/search?*",r=>{const url=new URL(r.request().url());const network=url.searchParams.get("network");return r.fulfill({json:{results:[{id:9001,mediaType:"tv",title:network?"New History series":"Title match",year:"2026",date:"2026-08-01",poster:"north"}],...(network?{network:{id:65,name:"History"},totalPages:2}:{})}});});
 await page.getByPlaceholder("Search movies and shows").fill("history");
 await expect(page.locator("#search-results")).toContainText("Title match");
 await expect(page.getByRole("button",{name:"History · US",exact:true})).toBeVisible();
 await page.getByRole("button",{name:"History · US",exact:true}).click();
 await expect(page.locator("#search-results")).toContainText("New History series");
 await expect(page.locator("#search-status")).toContainText("newest series premieres");
 await page.getByRole("button",{name:"Next",exact:true}).click();
 await expect(page.locator("#search-status")).toContainText("page 2");
 await page.getByRole("button",{name:"Back to title search",exact:true}).click();
 await expect(page.locator("#search-results")).toContainText("Title match");
 await page.locator("#search-clear").click();await expect(page.locator("#network-matches")).toBeEmpty();
});

 test("watch next stays on Jellyfin, collapses, follows settings and opens owned details",async({page})=>{
 await page.goto("/");await page.getByRole("button",{name:"Explore demo"}).click();await page.locator('[data-page="home"]').click();
 await expect(page.locator("#watchNext-section")).toBeVisible();await expect(page.locator("#watchNext-content .poster-card")).toHaveCount(3);
 await page.locator('[data-collapse="watchNext"]').click();await expect(page.locator("#watchNext-content")).toBeHidden();
 await page.locator('[data-collapse="watchNext"]').click();await page.locator('#watchNext-content [data-personal]').first().click();await expect(page.locator('#episode-detail')).toBeVisible();await expect(page.locator('#episode-detail [data-request]')).toHaveCount(0);await page.getByRole('button',{name:'Close episode details'}).click();
 await page.locator('[data-page="discover"]').click();await expect(page.locator('#watchNext-section')).toBeHidden();
 });

for(const width of [393,1440]) test(`watchnext genre/type cycles are instant, combined and persistent at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:1000});let reads=0;
 await page.route('**/api/personal/watchNext',route=>{reads++;return route.fulfill({json:{items:[
 {id:'movie-live',title:'Live movie',type:'movie',art:'signal',detail:{mediaType:'movie',genres:['Drama']}},
 {id:'movie-anim',title:'Animated movie',type:'movie',art:'north',detail:{mediaType:'movie',genres:[' Animation ']}},
 {id:'tv-anim',title:'Animated show',type:'tv',art:'orbit',detail:{mediaType:'tv',genres:['Animation']}},
 {id:'tv-live',title:'Live show',type:'tv',art:'coast',detail:{mediaType:'tv',genres:['Comedy']}},
 {id:'unknown',title:'Unknown genre',type:'movie',art:'signal',detail:{mediaType:'movie',genres:[]}}
 ]}})});
 await page.goto('/');await page.getByRole('button',{name:'Explore demo'}).click();await view(page,'home');
 const a=page.locator('[data-watch-next-filter="watchNextAnimation"]'),t=page.locator('[data-watch-next-filter="watchNextType"]'),cards=page.locator('#watchNext-content .poster-card');
 await expect(cards).toHaveCount(5);const initial=reads;await expect(a).toHaveText('Mixed');await expect(t).toHaveText('Both');
 await a.click();await expect(a).toHaveText('No animation');await expect(cards).toHaveCount(2);
 await t.click();await expect(t).toHaveText('Movies only');await expect(cards).toHaveCount(1);await expect(cards).toContainText('Live movie');
 await a.click();await expect(a).toHaveText('Animation only');await expect(cards).toHaveCount(1);await expect(cards).toContainText('Animated movie');
 await t.click();await expect(t).toHaveText('TV only');await expect(cards).toContainText('Animated show');await cards.first().locator('[data-personal]').click();await expect(page.locator('#episode-detail h2')).toHaveText('Animated show');await page.getByRole('button',{name:'Close episode details'}).click();
 await t.click();await expect(t).toHaveText('Both');await expect(cards).toHaveCount(2);expect(reads).toBe(initial);
 await page.locator('#watchNext-section').screenshot({path:`${shots}/watch-next-filters-${width}.png`});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.reload();await view(page,'home');await expect(a).toHaveText('Animation only');await expect(t).toHaveText('Both');await expect(cards).toHaveCount(2);
 await a.click();await expect(a).toHaveText('Mixed');await expect(cards).toHaveCount(5);
});

test('star watchlist only saves library titles and leaves catalog titles unstarred',async({page})=>{
 await login(page);await page.getByRole('button',{name:'Settings',exact:true}).click();await page.locator('[data-pref="watchLater"]').check();await page.locator('[data-pref="watchlist"]').check();await page.getByRole('button',{name:'Close settings'}).click();
 await page.locator('#recent [data-watch-key]').first().click();await view(page,'home');await expect(page.locator('#watchLater-content .poster-card')).toHaveCount(1);await expect(page.locator('#watchlist-content .poster-card')).toHaveCount(0);
 await page.locator('#watchLater-content [data-watch-later-index]').first().click();await expect(page.locator('#episode-star')).toHaveAttribute('aria-pressed','true');await page.getByRole('button',{name:'Close episode details'}).click();
 await view(page,'discover');await page.locator('#search-form input[name="query"]').fill('Orbit');await page.locator('#search-results .result-card').first().waitFor();await expect(page.locator('#search-results [data-watch-key]')).toHaveCount(0);await page.locator('#search-results [data-detail-id]').first().click();await expect(page.locator('#episode-star')).toBeHidden();await page.getByRole('button',{name:'Close episode details'}).click();await page.locator('#recent [data-recent-index]').first().click();await expect(page.locator('#episode-star')).toBeVisible();const geometry=await page.locator('#episode-star').evaluate(el=>{const s=getComputedStyle(el);return [s.width,s.height,s.borderRadius]});expect(geometry).toEqual(['42px','42px','8px']);await page.setViewportSize({width:393,height:1000});await page.screenshot({path:`${shots}/library-star-detail-393.png`});await page.setViewportSize({width:1440,height:900});await page.screenshot({path:`${shots}/library-star-detail-1440.png`});await page.getByRole('button',{name:'Close episode details'}).click();await page.locator('#recent [data-watch-key]').nth(2).click();await view(page,'home');await expect(page.locator('#watchLater-content .poster-card')).toHaveCount(2);
 await page.locator('#watchLater-section').screenshot({path:`${shots}/watchlater-preview-1440.png`});
 await page.setViewportSize({width:393,height:1000});await page.locator('#watchLater-section').screenshot({path:`${shots}/watchlater-preview-393.png`});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.locator('#watchLater-content [data-watch-key]').first().click();await expect(page.locator('#watchLater-content .poster-card')).toHaveCount(1);await page.reload();await view(page,'home');await expect(page.locator('#watchLater-content .poster-card')).toHaveCount(1);
});

for (const width of [393,1440]) test(`requested by certification line uses request names, settings and reset at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:1000});
 const named={mediaType:'tv',mediaId:77,title:'Sample Series',subtitle:'TV series',contentRating:'TV-14',year:'2026',network:'Sample Network',runtime:48,overview:'A fictional title used for layout testing.',genres:['Comedy'],poster:'/art/north.svg',availability:2,requested:true,facts:{status:'Returning Series',seasonCount:1,requestedBy:['Alex Sample','Morgan Example'],originalLanguage:'en'}};
 await page.route('**/api/seerr/details/**',route=>route.fulfill({json:route.request().url().endsWith('/77') ? named : {...named,mediaId:78,title:'No Request Series',availability:1,requested:false,facts:{status:'Returning Series'}}}));
 await page.route('**/api/seerr/search?**',route=>route.fulfill({json:{results:[{id:77,mediaType:'tv',title:'Sample Series',poster:'north',year:'2026',availability:2,requested:true},{id:78,mediaType:'tv',title:'No Request Series',poster:'orbit',year:'2026'}]}}));
 await login(page);await page.locator('#search-form input[name="query"]').fill('Sample');await page.locator('#search-results [data-detail-id="77"]').click();
 const row=page.locator('#episode-certification-line');
 await expect(row).toHaveText('TV-14 · Requested by Alex Sample, Morgan Example');await expect(row.locator('strong')).toHaveText('TV-14');expect(await page.locator('#episode-facts .detail-fact strong').allTextContents()).toEqual(['Status','Original language']);
 await page.locator('#episode-detail').screenshot({path:`${shots}/requestedby-${width}.png`});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.getByRole('button',{name:'Close episode details'}).click();await page.getByRole('button',{name:'Settings',exact:true}).click();await page.locator('[data-pref="requestedBy"]').uncheck();await page.getByRole('button',{name:'Close settings'}).click();await page.locator('#search-results [data-detail-id="77"]').click();await expect(row).not.toContainText("Requested by");await page.getByRole('button',{name:'Close episode details'}).click();
 await page.getByRole('button',{name:'Settings',exact:true}).click();await page.locator('[data-pref="requestedBy"]').check();await page.getByRole('button',{name:'Close settings'}).click();await page.locator('#search-results [data-detail-id="78"]').click();await expect(row).not.toContainText("Requested by");await page.getByRole('button',{name:'Close episode details'}).click();await page.locator('#search-results [data-detail-id="77"]').click();await expect(row).toContainText('Alex Sample');
});

for (const width of [393,1440]) test(`request filter hides Everyone for Seerr restricted accounts and recovers at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:1000});let restricted=true;
 await page.route('**/api/seerr/requests*',route=>route.fulfill({json:{viewAllRequests:!restricted,requests:[{id:1,title:'Sample request',mediaType:'tv',requestedBy:'Alex Sample',status:2}]}}));
 await page.addInitScript(()=>localStorage.setItem('marquee:Demo viewer:preferences',JSON.stringify({search:true,requests:true,watchNext:false,personalShelvesReset:true,continueWatching:false,nextUp:false})));await login(page);await view(page,'home');await page.locator('#requests-section').scrollIntoViewIfNeeded();await expect(page.locator('#requests-filter')).toHaveValue('mine');await expect(page.locator('#requests-filter option[value="all"]')).toHaveCount(0);
 await page.locator('#requests-section').screenshot({path:`${shots}/requests-restricted-${width}.png`});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 restricted=false;await page.reload();await view(page,'home');await expect(page.locator('#requests-filter option[value="all"]')).toBeEnabled();await expect(page.locator('#requests-filter')).toHaveValue('all');
});

for (const size of [{width:834,height:1194},{width:1194,height:834},{width:768,height:1024},{width:1024,height:768}]) test(`tablet sticky navigation reserves status bar at ${size.width}x${size.height}`,async({page})=>{
 await page.setViewportSize(size);await login(page);await page.evaluate(()=>document.documentElement.style.setProperty('--safe-top','24px'));
 await page.screenshot({path:`${shots}/ipad-top-${size.width}.png`});
 await page.evaluate(()=>scrollTo(0,140));await expect(page.locator('#page-nav')).toBeVisible();const nav=await page.locator('#page-nav').boundingBox(),button=await page.locator('#page-nav button').first().boundingBox();expect(nav.y).toBeGreaterThanOrEqual(0);expect(button.y).toBeGreaterThanOrEqual(24);expect(await page.locator('#page-nav').evaluate(el=>getComputedStyle(el).backgroundColor)).toBe('rgb(16, 18, 27)');
 await page.screenshot({path:`${shots}/ipad-scrolled-${size.width}.png`});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.evaluate(()=>scrollTo(0,0));const search=await page.locator('#search-form').boundingBox();expect(search.y).toBeGreaterThan(nav.height);
});

for (const saved of [false,true]) test(`personal section defaults are enabled unless saved off: ${saved}`,async({page})=>{
 if(saved)await page.addInitScript(()=>localStorage.setItem('marquee:Demo viewer:preferences',JSON.stringify({personalShelvesReset:true,continueWatching:false,nextUp:false,watchNext:false})));
 await page.goto('/');await page.getByRole('button',{name:'Explore demo'}).click();await view(page,'home');await page.getByRole('button',{name:'Settings',exact:true}).click();
 for(const key of ['continueWatching','nextUp','watchNext']){if(saved)await expect(page.locator(`[data-pref="${key}"]`)).not.toBeChecked();else await expect(page.locator(`[data-pref="${key}"]`)).toBeChecked();}
 await expect(page.locator('[data-pref="requests"]')).toBeChecked();await page.getByRole('button',{name:'Close settings'}).click();for(const key of ['continueWatching','nextUp','watchNext']){if(saved)await expect(page.locator(`#${key}-section`)).toBeHidden();else await expect(page.locator(`#${key}-section`)).toBeVisible();}
});

test('empty next up and continue watching hide and return when refreshed with items',async({page})=>{
 let empty=true;
 for(const key of ['continueWatching','nextUp'])await page.route(`**/api/personal/${key}`,route=>route.fulfill({json:{items:empty?[]:[{id:'sample',title:'Sample series',subtitle:'S1E2 · Sample episode',art:'north',detail:{}}]}}));
 await page.addInitScript(()=>localStorage.setItem('marquee:Demo viewer:preferences',JSON.stringify({continueWatching:true,nextUp:true,watchNext:false})));
 await login(page);await view(page,'home');for(const key of ['continueWatching','nextUp'])await expect(page.locator(`#${key}-section`)).toBeHidden();
 empty=false;await page.reload();await view(page,'home');for(const key of ['continueWatching','nextUp'])await expect(page.locator(`#${key}-section`)).toBeVisible();
 empty=true;await page.reload();await view(page,'home');for(const key of ['continueWatching','nextUp'])await expect(page.locator(`#${key}-section`)).toBeHidden();
});

for(const width of [280,393,834,1440]) test(`library count cards at bottom of Jellyfin, hideable and selectable at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:1000});
 await page.route('**/api/library-stats*',route=>{const selected=new URL(route.request().url()).searchParams.get('kidsLibrary') || 'kids';return route.fulfill({json:{libraries:[{id:'kids',name:'Kids Movies',type:'movies'},{id:'family',name:'Family Films',type:'movies'},{id:'kids-shows',name:'Kids Shows',type:'tvshows'}],kidsLibrary:selected,kidsShowsLibrary:'kids-shows',counts:{movies:selected==='kids'?1001:987,kidsMovies:selected==='kids'?167:181,tvShows:211,kidsShows:38,episodes:15834,kidsEpisodes:1422}}});});
 await page.addInitScript(()=>{const key='marquee:Demo viewer:preferences';if(!localStorage.getItem(key))localStorage.setItem(key,JSON.stringify({search:true,requests:true,watchNext:false,personalShelvesReset:true,continueWatching:false,nextUp:false,libraryStats:true}));});
 await login(page);await view(page,'home');await expect(page.locator('#libraryStats-content article')).toHaveCount(6);await expect(page.locator('#libraryStats-content')).toContainText('15,834');await expect(page.locator('#libraryStats-section')).not.toContainText('catalog');await expect(page.locator('#dashboard main > section').last()).toHaveAttribute('id','libraryStats-section');
 await page.locator('#libraryStats-section').scrollIntoViewIfNeeded();await page.locator('#libraryStats-section').screenshot({path:`${shots}/library-counts-${width}.png`});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await view(page,'discover');await expect(page.locator('#libraryStats-section')).toBeHidden();await view(page,'home');await page.getByRole('button',{name:'Settings',exact:true}).click();await page.locator('#kids-movies-library').selectOption('family');await expect(page.locator('#libraryStats-content')).toContainText('987');await page.locator('[data-pref="libraryStats"]').uncheck();await page.getByRole('button',{name:'Close settings'}).click();await expect(page.locator('#libraryStats-section')).toBeHidden();await page.reload();await view(page,'home');await expect(page.locator('#libraryStats-section')).toBeHidden();await page.getByRole('button',{name:'Settings',exact:true}).click();await page.locator('[data-pref="libraryStats"]').check();await expect(page.locator('#kids-movies-library')).toHaveValue('family');await page.getByRole('button',{name:'Close settings'}).click();await expect(page.locator('#libraryStats-section')).toBeVisible();
});

test('library counts reject stale responses, report errors without invented zeroes and keep unchanged cards',async({page})=>{
 let mode='ok';let release;
 await page.route('**/api/library-stats*',async route=>{if(mode==='slow')await new Promise(resolve=>release=resolve);if(mode==='error')return route.fulfill({status:502,json:{error:'Unavailable'}});return route.fulfill({json:{libraries:[],kidsLibrary:'',kidsShowsLibrary:'',counts:{movies:12,kidsMovies:0,tvShows:3,kidsShows:0,episodes:24,kidsEpisodes:0}}});});
 await page.goto('/');await page.getByRole('button',{name:'Explore demo'}).click();await view(page,'home');await expect(page.locator('#libraryStats-content article')).toHaveCount(6);
 await page.evaluate(()=>window.firstStat=document.querySelector('.library-stat'));await page.evaluate(()=>loadLibraryStats());expect(await page.evaluate(()=>window.firstStat===document.querySelector('.library-stat'))).toBe(true);
 mode='error';await page.evaluate(()=>loadLibraryStats());await expect(page.locator('#libraryStats-content article')).toHaveCount(0);await expect(page.locator('#libraryStats-status')).toContainText('could not be loaded');
 mode='slow';await page.evaluate(()=>{void loadLibraryStats();});await expect.poll(()=>Boolean(release)).toBe(true);await page.evaluate(()=>resetAccountState());release();await expect(page.locator('#libraryStats-content article')).toHaveCount(0);
});

test("old saved off Next up and Continue watching are turned on once, then choices stick", async ({ page }) => {
  await page.addInitScript(() => { if (!localStorage.getItem("marquee:Demo viewer:preferences")) localStorage.setItem("marquee:Demo viewer:preferences", JSON.stringify({ search: true, continueWatching: false, nextUp: false })); });
  await page.goto("/");
  await page.getByRole("button", { name: "Explore demo" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.locator('[data-pref="continueWatching"]')).toBeChecked();
  await expect(page.locator('[data-pref="nextUp"]')).toBeChecked();
  await page.locator('[data-pref="nextUp"]').uncheck();
  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.locator('[data-pref="nextUp"]')).not.toBeChecked();
  await expect(page.locator('[data-pref="continueWatching"]')).toBeChecked();
});
