// src/components/Toast.jsx
// General-purpose toast notification component for success, error, warning, and info messages

import { useState, useEffect, createContext, useContext, useCallback } from 'react';
import { CheckCircle, AlertCircle, AlertTriangle, Info, X } from 'lucide-react';

const TOAST_TYPES = {
  success: {
    icon: CheckCircle,
    bgColor: 'bg-green-950/90',
    borderColor: 'border-green-800',
    iconColor: 'text-green-400',
    textColor: 'text-green-100',
  },
  error: {
    icon: AlertCircle,
    bgColor: 'bg-red-950/90',
    borderColor: 'border-red-800',
    iconColor: 'text-red-400',
    textColor: 'text-red-100',
  },
  warning: {
    icon: AlertTriangle,
    bgColor: 'bg-yellow-950/90',
    borderColor: 'border-yellow-800',
    iconColor: 'text-yellow-400',
    textColor: 'text-yellow-100',
  },
  info: {
    icon: Info,
    bgColor: 'bg-blue-950/90',
    borderColor: 'border-blue-800',
    iconColor: 'text-blue-400',
    textColor: 'text-blue-100',
  },
};

// Individual Toast component
function ToastItem({ id, type = 'info', title, message, duration = 5000, onDismiss }) {
  const [isVisible, setIsVisible] = useState(false);
  const [isLeaving, setIsLeaving] = useState(false);
  const config = TOAST_TYPES[type] || TOAST_TYPES.info;
  const Icon = config.icon;

  useEffect(() => {
    // Trigger enter animation
    requestAnimationFrame(() => setIsVisible(true));

    // Auto-dismiss after duration
    if (duration > 0) {
      const timer = setTimeout(() => {
        handleDismiss();
      }, duration);
      return () => clearTimeout(timer);
    }
  }, [duration]);

  const handleDismiss = useCallback(() => {
    setIsLeaving(true);
    setTimeout(() => {
      onDismiss(id);
    }, 200);
  }, [id, onDismiss]);

  return (
    <div
      className={`
        ${config.bgColor} ${config.borderColor} border rounded-lg shadow-xl
        px-4 py-3 min-w-[300px] max-w-[450px] flex items-start gap-3
        transform transition-all duration-200 ease-out
        ${isVisible && !isLeaving ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'}
      `}
    >
      <Icon className={`w-5 h-5 flex-shrink-0 mt-0.5 ${config.iconColor}`} />
      <div className="flex-1 min-w-0">
        {title && (
          <div className={`font-medium text-sm ${config.textColor}`}>
            {title}
          </div>
        )}
        {message && (
          <div className={`text-sm ${title ? 'mt-1' : ''} text-gray-300`}>
            {message}
          </div>
        )}
      </div>
      <button
        onClick={handleDismiss}
        className="p-1 hover:bg-white/10 rounded transition-colors flex-shrink-0"
      >
        <X className="w-4 h-4 text-gray-400" />
      </button>
    </div>
  );
}

// Toast Container - renders all active toasts
function ToastContainer({ toasts, onDismiss }) {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2">
      {toasts.map((toast) => (
        <ToastItem
          key={toast.id}
          {...toast}
          onDismiss={onDismiss}
        />
      ))}
    </div>
  );
}

// Toast Context for global state management
const ToastContext = createContext(null);

let toastIdCounter = 0;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const addToast = useCallback(({ type = 'info', title, message, duration = 5000 }) => {
    const id = ++toastIdCounter;
    setToasts((prev) => [...prev, { id, type, title, message, duration }]);
    return id;
  }, []);

  const removeToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = {
    success: (title, message, duration) => addToast({ type: 'success', title, message, duration }),
    error: (title, message, duration) => addToast({ type: 'error', title, message, duration }),
    warning: (title, message, duration) => addToast({ type: 'warning', title, message, duration }),
    info: (title, message, duration) => addToast({ type: 'info', title, message, duration }),
    dismiss: removeToast,
  };

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={removeToast} />
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}
