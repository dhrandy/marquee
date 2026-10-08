import { test, expect } from "@playwright/test";
import fs from "node:fs";
const shots = process.env.CI ? "test-results/screenshots" : "/downloads";
fs.mkdirSync(shots, { recursive: true });
async function login(page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Explore demo" }).click();
  await expect(
    page.getByRole("heading", { name: "Recently added" }),
  ).toBeVisible();
  await expect(page.locator(".poster-card")).toHaveCount(6);
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
  await expect(page.locator(".weekday").first()).toHaveText("Mon");
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
  await page.getByRole("button", { name: "Sample City, Example Region", exact: true }).click();
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
    await expect(page.locator('[data-view="list"]')).toHaveAttribute(
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
  await expect(page.locator(".poster-card")).toHaveCount(6);
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
  await expect(page.locator(".poster-card h3")).toHaveText(
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
  await page.getByPlaceholder("Search movies and shows").fill("orbit");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator(".result-card h3")).toHaveText(["Orbit Nine"]);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Request", exact: true }).click();
  await expect(page.locator(".result-card .requested-label")).toHaveText(
    "Requested",
  );
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
  await page.getByPlaceholder("Search movies and shows").fill("anything");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator(".result-card h3")).toHaveText(
    "<img src=x onerror=alert(1)>",
  );
  await expect(page.locator(".result-card h3 img")).toHaveCount(0);
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
  await page.getByPlaceholder("Search movies and shows").fill("o");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator(".result-card")).toHaveCount(3);
  await page.mouse.move(0, 0);
  const section = page.locator("#search-section");
  await section.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const box = await section.boundingBox();
  await page.screenshot({
    path: `${shots}/marquee-search.png`,
    clip: { x: 0, y: Math.max(0, box.y - 10), width: 1440, height: Math.min(box.height + 20, 900) },
  });
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
  test(`search cards have aligned footers and no overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await login(page);
    await page.getByPlaceholder("Search movies and shows").fill("o");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.locator(".result-card")).toHaveCount(3);
    const section = page.locator("#search-section");
    await section.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    const geometry = await page.locator(".result-card").evaluateAll(cards => cards.map(card => {
      const box = card.getBoundingClientRect();
      const footer = card.querySelector(".result-action").getBoundingClientRect();
      const action = card.querySelector(".result-action > *").getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, footerBottom: footer.bottom, actionCenter: action.top + action.height / 2 };
    }));
    for (const card of geometry) {
      expect(Math.abs(card.bottom - card.footerBottom)).toBeLessThan(1);
      for (const other of geometry.filter(other => Math.abs(other.top - card.top) < 1)) {
        expect(Math.abs(other.bottom - card.bottom)).toBeLessThan(1);
        expect(Math.abs(other.actionCenter - card.actionCenter)).toBeLessThan(1);
      }
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await section.screenshot({ path: `${shots}/marquee-search-${width}.png` });
  });
}

test("search footers stay aligned with long titles, missing overviews, and after requesting", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route("**/api/seerr/search**", route => route.fulfill({ json: { results: [
    { id: 81, mediaType: "movie", title: "Short title", poster: "orbit", availability: 1 },
    { id: 82, mediaType: "tv", title: "A much longer title that wraps onto multiple lines in a card", poster: "north", overview: "A long overview. ".repeat(30), availability: 2, requested: true },
    { id: 83, mediaType: "movie", title: "In the library", poster: "hours", overview: "A short overview.", availability: 5 },
  ] } }));
  await login(page);
  await page.getByPlaceholder("Search movies and shows").fill("test");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator(".result-card")).toHaveCount(3);
  const centers = () => page.locator(".result-action > *").evaluateAll(actions => actions.map(action => {
    const box = action.getBoundingClientRect();
    return box.top + box.height / 2;
  }));
  let values = await centers();
  expect(Math.max(...values) - Math.min(...values)).toBeLessThan(1);
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Request", exact: true }).click();
  await expect(page.locator(".result-card .requested-label")).toHaveCount(2);
  values = await centers();
  expect(Math.max(...values) - Math.min(...values)).toBeLessThan(1);
});

for (const width of [1440, 393, 320, 280]) {
  test(`weather city picker and administrator name settings at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await login(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByPlaceholder('City name').fill('Sample');
    await page.getByRole('button', { name: 'Find city', exact: true }).click();
    await page.getByRole('button', { name: 'Sample City, Example Region', exact: true }).click();
    await page.locator('#weather-units').selectOption('celsius');
    await page.locator('[data-pref="weather"]').check();
    await expect(page.locator('#weather-content')).toContainText('20°C');
    await page.locator('#display-name').fill('Movie Room');
    await page.getByRole('button', { name: 'Save name', exact: true }).click();
    await expect(page.locator('#display-name-status')).toHaveText('Saved for everyone.');
    await expect(page.locator('.masthead .app-name')).toHaveText('Movie Room');
    await page.locator('#weather-settings').scrollIntoViewIfNeeded();
    await page.locator('#settings').screenshot({ path: `${shots}/marquee-settings-weather-${width}.png` });
    await page.locator('#display-name-settings').scrollIntoViewIfNeeded();
    await page.locator('#settings').screenshot({ path: `${shots}/marquee-settings-name-${width}.png` });
    expect(await page.locator('#settings').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await expect(page.locator('#weather-settings-status')).toHaveText('Saved to your account.');
    await page.getByRole('button', { name: 'Close settings' }).click();
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await expect(page.locator('#weather-content')).toContainText('20°C');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.locator('#weather-city-selected')).toHaveText('Sample City, Example Region');
    await page.locator('#display-name').fill('Marquee');
    await page.getByRole('button', { name: 'Save name', exact: true }).click();
    await expect(page.locator('#display-name-status')).toHaveText('Saved for everyone.');
  });
}

test("Seerr request buttons reflect movie/TV access and escape denial text", async ({ page }) => {
  await page.route("**/api/me", route => route.fulfill({ json: { name: "Demo viewer", canRequest: true, isAdmin: false, requestAccess: { movie: true, tv: false, tvReason: "TV requests are not permitted by Seerr." } } }));
  await login(page);
  await page.getByPlaceholder("Search movies and shows").fill("o");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator(".request-btn")).toHaveCount(1);
  await expect(page.locator(".request-unavailable")).toHaveText("TV requests are not permitted by Seerr.");
});

for (const width of [1440, 393, 320, 280]) {
  test(`chosen marquee logo renders in header and favicon at ${width}px`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 950 });
    await login(page);
    const logo = page.locator('.masthead .brand-mark');
    await expect(logo).toHaveAttribute('src', '/icons/header-logo-96.png');
    expect(await logo.evaluate(img => img.complete && img.naturalWidth === 112 && img.naturalHeight === 96)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `${shots}/marquee-logo-${width}.png` });
    await expect(page.locator('link[rel="icon"][type="image/png"]')).toHaveAttribute('href', '/favicon.png');
    expect((await request.get('/favicon.ico')).status()).toBe(200);
    await page.goto('/favicon.png');
    await page.screenshot({ path: `${shots}/marquee-favicon-${width}.png` });
  });
}
