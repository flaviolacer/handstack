import { expect, test } from '@playwright/test';

test('frontend startup stays within the supported browser budget', async ({ page }) => {
  await page.goto('/chat', { waitUntil: 'load' });
  const timings = await page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
    return {
      domContentLoaded: navigation.domContentLoadedEventEnd,
      load: navigation.loadEventEnd,
      firstContentfulPaint:
        performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
    };
  });

  expect(timings.domContentLoaded).toBeLessThan(3_000);
  expect(timings.load).toBeLessThan(5_000);
  if (timings.firstContentfulPaint !== null) {
    expect(timings.firstContentfulPaint).toBeLessThan(3_000);
  }
});
