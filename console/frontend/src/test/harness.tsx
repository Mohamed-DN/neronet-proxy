import React from 'react';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import axe, { type AxeResults, type Result } from 'axe-core';
import { expect } from 'vitest';

import { ThemeProvider } from '../theme/ThemeProvider';
import { ToastProvider } from '../ui/Toast';
import { TooltipProvider } from '../ui/Tooltip';
import type { ThemeName } from '../ui/tokens';

interface Options extends Omit<RenderOptions, 'wrapper'> {
  theme?: ThemeName;
}

/**
 * Renders a primitive inside the providers it expects, with the document in a
 * known theme. i18n is initialised once in setup.ts, so a test asserts on real
 * English strings rather than on translation keys.
 */
export function renderUI(ui: React.ReactElement, { theme = 'light', ...options }: Options = {}): RenderResult {
  document.documentElement.setAttribute('data-theme', theme);
  return render(ui, {
    wrapper: ({ children }) => (
      <ThemeProvider>
        <TooltipProvider>
          <ToastProvider>{children}</ToastProvider>
        </TooltipProvider>
      </ThemeProvider>
    ),
    ...options
  });
}

function describeViolations(results: AxeResults, theme: string): string {
  return results.violations
    .map((violation: Result) => {
      const nodes = violation.nodes.map((node) => `      ${node.html}`).join('\n');
      return `  [${theme}] ${violation.id} (${violation.impact}): ${violation.help}\n${nodes}`;
    })
    .join('\n');
}

/**
 * Runs axe against the rendered container.
 *
 * jsdom computes no real colours, so the colour-contrast rule can only guess
 * and is disabled here: contrast is checked against the tokens themselves by
 * scripts/design/contrast.mjs, which measures the values rather than a
 * screenshot. Everything else - roles, names, labels, ARIA validity, required
 * children - is checked.
 */
export async function expectNoAxeViolations(container: HTMLElement, theme = 'light'): Promise<void> {
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false } },
    resultTypes: ['violations']
  });
  expect(results.violations, `axe violations:\n${describeViolations(results, theme)}`).toHaveLength(0);
}

/**
 * Renders the same element in both themes and asserts that neither has an axe
 * violation. Theme affects which elements are rendered in some primitives, so
 * checking one theme is not checking the other.
 */
export async function expectAccessibleInBothThemes(element: React.ReactElement): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    const { container, unmount } = renderUI(element, { theme });
    await expectNoAxeViolations(container, theme);
    unmount();
  }
}
