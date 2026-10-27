import { render, screen, waitFor } from '@testing-library/react';
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

test('renders accessible loading skeleton state with screen reader announcement', () => {
  render(<App />);

  // Screen reader accessible loading announcement
  const loadingStatus = screen.getByRole('status');
  expect(loadingStatus).toBeInTheDocument();
  expect(loadingStatus).toHaveTextContent(/Loading recent community reports/i);
});
