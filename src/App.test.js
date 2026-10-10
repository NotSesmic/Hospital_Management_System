import { render, screen } from '@testing-library/react';
import App from './App';

beforeEach(() => {
  sessionStorage.clear();
  global.fetch = jest.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));
});

test('shows the sign-in screen when there is no session', () => {
  render(<App />);
  expect(screen.getByText(/welcome back/i)).toBeInTheDocument();
  expect(screen.getByPlaceholderText(/email address/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
});
