'use client';

import { useEffect } from 'react';
import { captureError, type ErrorBoundaryName } from './port';

/**
 * Report the error an error boundary is showing, once, after it renders. The
 * boundary's own UI (and its Retry) never waits on it; with error tracking off
 * it sends nothing. See `captureError` for what is and is not reported.
 */
export function useErrorReport(error: unknown, boundary: ErrorBoundaryName): void {
  useEffect(() => {
    captureError(error, boundary);
  }, [error, boundary]);
}
