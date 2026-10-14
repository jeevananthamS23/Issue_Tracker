import { render, screen } from '@testing-library/react';
import App from './App';

test('renders community issue reporter logo or title', () => {
  render(<App />);
  const brandElements = screen.getAllByText(/Community Issue Reporter/i);
  expect(brandElements.length).toBeGreaterThanOrEqual(1);
});
