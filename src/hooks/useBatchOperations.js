// src/hooks/useBatchOperations.js
import { useReducer, useCallback, useRef } from 'react';

const DEFAULT_PROGRESS = {
  current: 0,
  total: 0,
  success: 0,
  failed: 0,
  currentBook: '',
};

const ACTION = {
  START: 'START',
  UPDATE: 'UPDATE',
  END: 'END',
  TOGGLE_FORCE_FRESH: 'TOGGLE_FORCE_FRESH',
  SET_FORCE_FRESH: 'SET_FORCE_FRESH',
  TOGGLE_DNA: 'TOGGLE_DNA',
};

function reducer(state, action) {
  switch (action.type) {
    case ACTION.START:
      return {
        ...state,
        active: { ...state.active, [action.op]: true },
        progress: {
          ...state.progress,
          [action.op]: { ...DEFAULT_PROGRESS, ...action.initial },
        },
      };

    case ACTION.UPDATE:
      return {
        ...state,
        progress: {
          ...state.progress,
          [action.op]: { ...state.progress[action.op], ...action.partial },
        },
      };

    case ACTION.END:
      return {
        ...state,
        active: { ...state.active, [action.op]: false },
        progress: {
          ...state.progress,
          [action.op]: { ...DEFAULT_PROGRESS },
        },
      };

    case ACTION.TOGGLE_FORCE_FRESH:
      return { ...state, forceFresh: !state.forceFresh };

    case ACTION.SET_FORCE_FRESH:
      return { ...state, forceFresh: action.value };

    case ACTION.TOGGLE_DNA:
      return { ...state, dnaEnabled: !state.dnaEnabled };

    default:
      return state;
  }
}

const initialState = {
  active: {},
  progress: {},
  forceFresh: false,
  dnaEnabled: false,
};

export function useBatchOperations() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const timersRef = useRef({});

  const start = useCallback((op, initial = {}) => {
    // Clear any pending end-timer for this operation
    if (timersRef.current[op]) {
      clearTimeout(timersRef.current[op]);
      delete timersRef.current[op];
    }
    dispatch({ type: ACTION.START, op, initial });
  }, []);

  const update = useCallback((op, partial) => {
    dispatch({ type: ACTION.UPDATE, op, partial });
  }, []);

  const end = useCallback((op, delayMs = 0) => {
    // Clear any previous timer for this operation
    if (timersRef.current[op]) {
      clearTimeout(timersRef.current[op]);
    }

    if (delayMs > 0) {
      timersRef.current[op] = setTimeout(() => {
        dispatch({ type: ACTION.END, op });
        delete timersRef.current[op];
      }, delayMs);
    } else {
      dispatch({ type: ACTION.END, op });
    }
  }, []);

  const isActive = useCallback((op) => {
    return !!state.active[op];
  }, [state.active]);

  const getProgress = useCallback((op) => {
    return state.progress[op] || { ...DEFAULT_PROGRESS };
  }, [state.progress]);

  const toggleForceFresh = useCallback(() => {
    dispatch({ type: ACTION.TOGGLE_FORCE_FRESH });
  }, []);

  const setForceFresh = useCallback((value) => {
    dispatch({ type: ACTION.SET_FORCE_FRESH, value });
  }, []);

  const toggleDna = useCallback(() => {
    dispatch({ type: ACTION.TOGGLE_DNA });
  }, []);

  // Check if any operation is currently active
  const anyActive = useCallback(() => {
    return Object.values(state.active).some(Boolean);
  }, [state.active]);

  return {
    start,
    update,
    end,
    isActive,
    getProgress,
    anyActive,
    forceFresh: state.forceFresh,
    toggleForceFresh,
    setForceFresh,
    dnaEnabled: state.dnaEnabled,
    toggleDna,
  };
}
