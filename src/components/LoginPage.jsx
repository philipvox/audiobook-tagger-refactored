import { useState, useEffect } from 'react';
import { Lock } from 'lucide-react';
import { login, checkAuthStatus } from '../api';

export function LoginPage({ onLogin }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(null);

  useEffect(() => {
    checkAuthStatus().then(({ needs_setup }) => setNeedsSetup(needs_setup));
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(password);
      onLogin();
    } catch (err) {
      setError(err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-screen flex items-center justify-center bg-neutral-950">
      <div className="w-full max-w-sm mx-auto p-8">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-neutral-800 mb-4">
            <Lock className="w-8 h-8 text-neutral-400" />
          </div>
          <h1 className="text-xl font-semibold text-white">Audiobook Tagger</h1>
          <p className="text-sm text-neutral-500 mt-1">
            {needsSetup ? 'Set your admin password' : 'Enter your password'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={needsSetup ? 'Choose a password' : 'Password'}
            className="input w-full"
            autoFocus
          />

          {error && (
            <p className="text-red-400 text-sm text-center">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading || !password}
            className="btn btn-primary w-full"
          >
            {loading ? 'Authenticating...' : needsSetup ? 'Set Password & Login' : 'Login'}
          </button>
        </form>
      </div>
    </div>
  );
}
