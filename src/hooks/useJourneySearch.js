import { useCallback, useEffect, useRef, useState } from 'react';
import { createSearchController, emptySearch } from '../lib/search-pipeline.js';

export function useJourneySearch() {
  const [state, setState] = useState(emptySearch);
  const controller = useRef(null);
  if (!controller.current) controller.current = createSearchController({ onState: setState });
  useEffect(() => () => controller.current.cancel({ silent: true }), []);
  const start = useCallback((query, options) => controller.current.start(query, options), []);
  const cancel = useCallback((options) => controller.current.cancel(options), []);
  return { state, start, cancel };
}
