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
    "/api/seerr/popular",
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
  await expect(page.locator("#search-results .result-card h3")).toHaveText([
    "Orbit Nine",
  ]);
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .locator("#search-results")
    .getByRole("button", { name: "Request", exact: true })
    .click();
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
  test(`search cards have aligned footers and no overflow at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await login(page);
    await page.getByPlaceholder("Search movies and shows").fill("o");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.locator("#search-results .result-card")).toHaveCount(3);
    const section = page.locator("#search-section");
    await section.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    const geometry = await page
      .locator("#search-results .result-card")
      .evaluateAll((cards) =>
        cards.map((card) => {
          const box = card.getBoundingClientRect();
          const footer = card
            .querySelector(".result-action")
            .getBoundingClientRect();
          const action = card
            .querySelector(".result-action > *")
            ?.getBoundingClientRect() || footer;
          return {
            top: box.top,
            bottom: box.bottom,
            footerBottom: footer.bottom,
            actionCenter: action.top + action.height / 2,
          };
        }),
      );
    for (const card of geometry) {
      expect(Math.abs(card.bottom - card.footerBottom)).toBeLessThan(1);
      for (const other of geometry.filter(
        (other) => Math.abs(other.top - card.top) < 1,
      )) {
        expect(Math.abs(other.bottom - card.bottom)).toBeLessThan(1);
        expect(Math.abs(other.actionCenter - card.actionCenter)).toBeLessThan(
          1,
        );
      }
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await section.screenshot({ path: `${shots}/marquee-search-${width}.png` });
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
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .locator("#search-results")
    .getByRole("button", { name: "Request", exact: true })
    .click();
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
    const episode = page.locator(".entry[data-event]").first();
    await episode.click();
    const modal = page.locator("#episode-detail");
    await expect(modal).toBeVisible();
    await expect(page.locator("#episode-title")).toContainText("(2026)");
    await expect(page.locator("#episode-subtitle")).toContainText("S");
    await expect(page.locator("#episode-genres")).toContainText("Adventure");
    await expect(page.locator("#episode-meta")).toContainText(
      "Sample Network · 48 min",
    );
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
    await expect(page.locator("#popular-movies")).toContainText("Available");
    await expect(page.locator("#popular-movies")).toContainText("Requested");
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
    await expect(page.locator("#episode-subtitle")).toHaveText("Movie");
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
  await expect(page.locator("#requests-section h2")).toHaveText("Requests");
  await expect(page.locator(".request-row").first()).toContainText("by");
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
  expect(css).toContain(".popular-title");
});

for (const width of [1440, 393, 280]) {
  test(`search poster opens shared movie/TV details at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await login(page);
    await page.getByPlaceholder("Search movies and shows").fill("Signal");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page
      .locator('#search-results [data-detail-type="movie"]')
      .first()
      .click();
    await expect(page.locator("#episode-subtitle")).toHaveText("Movie");
    await page
      .locator("#episode-detail")
      .screenshot({ path: `${shots}/marquee-search-popup-${width}.png` });
    await page.keyboard.press("Escape");
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
    await page.goto("/");
    await page.getByRole("button", { name: "Explore demo" }).click();
    await expect(page.locator(".poster-card")).toHaveCount(18);
    const count = await page.locator(".poster-card").evaluateAll((cards) => {
      const right = document
        .querySelector(".poster-row")
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
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#episode-request").click();
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
          document.querySelector("#search-results").innerHTML = resultCardHtml(item);
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
    await expect(page.locator("#episode-facts")).toContainText("July 31, 2026");
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
  await page.locator("#recent .recent-detail").first().click();
  await expect(page.locator("#episode-genres")).toBeVisible();
  await expect(page.locator("#episode-meta")).toBeVisible();
  await expect(page.locator("#episode-genres-top")).toBeHidden();
  await expect(page.locator("#episode-more")).toBeHidden();
});

test("facts panel uses real images and SVG icons instead of emoji, so nothing depends on emoji fonts", async ({ page }) => {
  await login(page);
  await page.locator("#recent .recent-detail").first().click();
  const flags = page.locator("#episode-facts .country-flags img.flag");
  await expect(flags.first()).toBeVisible();
  const broken = await flags.evaluateAll((imgs) => imgs.filter((i) => !i.complete || i.naturalWidth === 0).length);
  expect(broken).toBe(0);
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

test("weather forecast shows three readable day tiles on phones", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 900 });
  await login(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByPlaceholder("City name").fill("Sample");
  await page.getByRole("button", { name: "Find city", exact: true }).click();
  await page.getByRole("button", { name: "Sample City, Example Region", exact: true }).click();
  await page.locator('[data-pref="weather"]').check();
  await page.getByRole("button", { name: "Close settings" }).click();
  const days = page.locator("#weather-forecast .forecast-day");
  await expect(days).toHaveCount(3);
  expect(await days.first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(14);
  const boxes = await days.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().right));
  expect(Math.max(...boxes)).toBeLessThanOrEqual(393);
});
