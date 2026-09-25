import { defineConfig } from 'vitest/config'
import { WxtVitest } from 'wxt/testing/vitest-plugin'

export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    globals: true,
    // happy-dom, not jsdom: jsdom has no IntersectionObserver and returns undefined for innerText,
    // both of which the LinkedIn adapter depends on. See docs/architecture/technical-brief.md §8.
    environment: 'happy-dom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
  },
})
