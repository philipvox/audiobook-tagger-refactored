import { Component } from 'react';

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('React Error Boundary caught an error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          height: '100vh', background: '#0a0a0a', color: '#e5e5e5', fontFamily: 'system-ui, sans-serif',
          padding: '2rem', textAlign: 'center',
        }}>
          <div style={{ fontSize: '2rem', marginBottom: '1rem' }}>Something went wrong</div>
          <p style={{ color: '#a3a3a3', maxWidth: '500px', lineHeight: 1.6 }}>
            The app encountered an unexpected error. Try refreshing the page.
          </p>
          <pre style={{
            background: '#171717', padding: '1rem', borderRadius: '0.5rem', marginTop: '1rem',
            fontSize: '0.8rem', color: '#ef4444', maxWidth: '600px', overflow: 'auto', textAlign: 'left',
          }}>
            {this.state.error?.message || 'Unknown error'}
          </pre>
          <button
            onClick={() => window.location.reload()}
            style={{
              marginTop: '1.5rem', padding: '0.75rem 2rem', background: '#262626',
              color: '#e5e5e5', border: '1px solid #404040', borderRadius: '0.5rem',
              cursor: 'pointer', fontSize: '0.9rem',
            }}
          >
            Refresh Page
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
