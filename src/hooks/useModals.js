import { useReducer, useCallback, useMemo } from 'react';

// All modal names managed by this hook
const MODAL_NAMES = [
  'edit',
  'rename',
  'bulkEdit',
  'export',
  'rescan',
  'push',
  'bulkCover',
  'series',
  'validation',
  'author',
  'batchFix',
];

// Build initial state: every modal closed, no associated data
function buildInitialState() {
  const visibility = {};
  MODAL_NAMES.forEach(name => { visibility[name] = false; });

  return {
    visibility,
    // Associated data keyed by modal name
    data: {
      edit: { group: null },
      push: { groups: [] },
      batchFix: {
        pending: { validation: 0, author: 0, series: 0 },
        selectedTypes: { validation: true, author: true, series: true },
        validationByType: {},
        selectedValidationTypes: {},
      },
    },
  };
}

const initialState = buildInitialState();

// Default data values used when closing a modal (to reset associated data)
const DATA_DEFAULTS = {
  edit: { group: null },
  push: { groups: [] },
  batchFix: {
    pending: { validation: 0, author: 0, series: 0 },
    selectedTypes: { validation: true, author: true, series: true },
    validationByType: {},
    selectedValidationTypes: {},
  },
};

function reducer(state, action) {
  switch (action.type) {
    case 'OPEN': {
      const { modal, data } = action;
      return {
        ...state,
        visibility: { ...state.visibility, [modal]: true },
        data: data
          ? { ...state.data, [modal]: { ...state.data[modal], ...data } }
          : state.data,
      };
    }

    case 'CLOSE': {
      const { modal } = action;
      const defaults = DATA_DEFAULTS[modal];
      return {
        ...state,
        visibility: { ...state.visibility, [modal]: false },
        // Reset associated data to defaults when closing, if defaults exist
        data: defaults
          ? { ...state.data, [modal]: { ...defaults } }
          : state.data,
      };
    }

    case 'SET_DATA': {
      const { modal, data } = action;
      return {
        ...state,
        data: {
          ...state.data,
          [modal]: { ...state.data[modal], ...data },
        },
      };
    }

    case 'TOGGLE_FIX_TYPE': {
      const { fixType } = action;
      const batchFix = state.data.batchFix;
      return {
        ...state,
        data: {
          ...state.data,
          batchFix: {
            ...batchFix,
            selectedTypes: {
              ...batchFix.selectedTypes,
              [fixType]: !batchFix.selectedTypes[fixType],
            },
          },
        },
      };
    }

    case 'TOGGLE_VALIDATION_TYPE': {
      const { issueType } = action;
      const batchFix = state.data.batchFix;
      return {
        ...state,
        data: {
          ...state.data,
          batchFix: {
            ...batchFix,
            selectedValidationTypes: {
              ...batchFix.selectedValidationTypes,
              [issueType]: !batchFix.selectedValidationTypes[issueType],
            },
          },
        },
      };
    }

    default:
      return state;
  }
}

/**
 * useModals - Manages all modal visibility and associated data via a single reducer.
 *
 * Usage:
 *   const modals = useModals();
 *
 *   modals.open('edit', { group: someGroup });
 *   modals.close('edit');
 *   modals.isOpen('edit');
 *
 *   modals.open('push', { groups: selectedGroups });
 *   modals.data.push.groups
 *
 *   modals.open('batchFix');
 *   modals.setBatchFixData({ pending: {...}, selectedTypes: {...} });
 *   modals.toggleFixType('validation');
 *   modals.toggleValidationType('missing_narrator');
 *   modals.data.batchFix.pending
 *   modals.data.batchFix.selectedTypes
 */
export function useModals() {
  const [state, dispatch] = useReducer(reducer, initialState);

  const open = useCallback((modal, data) => {
    dispatch({ type: 'OPEN', modal, data });
  }, []);

  const close = useCallback((modal) => {
    dispatch({ type: 'CLOSE', modal });
  }, []);

  const isOpen = useCallback((modal) => {
    return state.visibility[modal] || false;
  }, [state.visibility]);

  const setData = useCallback((modal, data) => {
    dispatch({ type: 'SET_DATA', modal, data });
  }, []);

  // Batch fix convenience methods
  const setBatchFixData = useCallback((data) => {
    dispatch({ type: 'SET_DATA', modal: 'batchFix', data });
  }, []);

  const toggleFixType = useCallback((fixType) => {
    dispatch({ type: 'TOGGLE_FIX_TYPE', fixType });
  }, []);

  const toggleValidationType = useCallback((issueType) => {
    dispatch({ type: 'TOGGLE_VALIDATION_TYPE', issueType });
  }, []);

  // Memoize the return object so consumers don't re-render on every dispatch
  // unless the underlying state actually changed
  return useMemo(() => ({
    open,
    close,
    isOpen,
    setData,
    data: state.data,

    // Batch fix helpers
    setBatchFixData,
    toggleFixType,
    toggleValidationType,
  }), [open, close, isOpen, setData, state.data, setBatchFixData, toggleFixType, toggleValidationType]);
}
