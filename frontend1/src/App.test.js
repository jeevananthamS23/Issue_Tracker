import { render, screen } from '@testing-library/react';
import App from './App';

test('renders community issue reporter logo or title', () => {
  render(<App />);
  const brandElements = screen.getAllByText(/Community Issue Reporter/i);
  expect(brandElements.length).toBeGreaterThanOrEqual(1);
});

test('renders CivicVision AI branding and primary navigation', () => {
  render(<App />);
  
  // Brand name presence in navbar and landing page
  const brandNames = screen.getAllByText(/CivicVision AI/i);
  expect(brandNames.length).toBeGreaterThanOrEqual(1);

  // Primary navigation items
  const reportActions = screen.getAllByText(/Report an Issue/i);
  expect(reportActions.length).toBeGreaterThanOrEqual(1);

  // Accessible mobile navigation toggle
  const mobileToggle = screen.getByRole('button', { name: /navigation menu/i });
  expect(mobileToggle).toBeInTheDocument();
  expect(mobileToggle).toHaveAttribute('aria-expanded', 'false');
  expect(mobileToggle).toHaveAttribute('aria-controls', 'primary-nav-links');
});
