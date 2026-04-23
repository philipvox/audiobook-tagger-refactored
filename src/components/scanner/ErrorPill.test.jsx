import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ErrorPill } from './ErrorPill';

const detail = {
  stage: 'dna',
  kind: 'parse',
  message: 'JSON parse error at position 42',
  responsePreview: '<thinking>probably fantasy</thinking>{"tags":[oops',
  statusCode: 200,
  url: 'http://127.0.0.1:11434/api/chat',
};

describe('ErrorPill', () => {
  it('renders nothing when detail is absent', () => {
    const { container } = render(<ErrorPill detail={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders with aria-live=polite and role=alert (a11y)', () => {
    render(<ErrorPill detail={detail} />);
    const pill = screen.getByTestId('error-pill');
    expect(pill).toHaveAttribute('role', 'alert');
    expect(pill).toHaveAttribute('aria-live', 'polite');
  });

  it('shows the stage label and a truncated message in the collapsed state', () => {
    render(<ErrorPill detail={{ ...detail, message: 'x'.repeat(100) }} />);
    expect(screen.getByText('dna')).toBeInTheDocument();
    const button = screen.getByRole('button', { expanded: false });
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('expands to show full detail on click', () => {
    render(<ErrorPill detail={detail} />);
    const toggle = screen.getByRole('button', { expanded: false });
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { expanded: true })).toBeInTheDocument();
    // Full detail fields present
    expect(screen.getByText('kind:')).toBeInTheDocument();
    expect(screen.getByText('parse')).toBeInTheDocument();
    expect(screen.getByText('status:')).toBeInTheDocument();
    expect(screen.getByText('200')).toBeInTheDocument();
    expect(screen.getByText(/127.0.0.1:11434/)).toBeInTheDocument();
    // responsePreview visible
    expect(screen.getByText(/thinking/)).toBeInTheDocument();
  });

  it('copy button writes JSON to clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<ErrorPill detail={detail} />);
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    fireEvent.click(screen.getByRole('button', { name: /copy error detail as JSON/i }));
    expect(writeText).toHaveBeenCalledWith(JSON.stringify(detail, null, 2));
  });

  it('renders dismiss button only when onDismiss is provided', () => {
    const onDismiss = vi.fn();
    const { rerender } = render(<ErrorPill detail={detail} />);
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.queryByRole('button', { name: /Dismiss/i })).not.toBeInTheDocument();
    rerender(<ErrorPill detail={detail} onDismiss={onDismiss} />);
    expect(screen.getByRole('button', { name: /Dismiss/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Dismiss/i }));
    expect(onDismiss).toHaveBeenCalled();
  });

  it('uses error palette for severity=error', () => {
    render(<ErrorPill detail={detail} severity="error" />);
    const pill = screen.getByTestId('error-pill');
    expect(pill.className).toMatch(/red/);
  });

  it('uses warning palette for severity=warn (default)', () => {
    render(<ErrorPill detail={detail} />);
    const pill = screen.getByTestId('error-pill');
    expect(pill.className).toMatch(/amber/);
  });
});
