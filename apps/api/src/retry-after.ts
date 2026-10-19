import {
  HttpException,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { catchError, throwError, type Observable } from 'rxjs';

/**
 * How long a caller should wait before asking again after a write was refused
 * because the host's calendar could not be read. Short: the usual cause is a
 * blip at the calendar backend, and the visitor is waiting on the answer.
 */
export const CALENDAR_RETRY_AFTER_SECONDS = 5;

/**
 * A hold, booking, reschedule or confirmation refused with
 * `CALENDAR_UNAVAILABLE` is refused because the host's calendar could not be
 * read FRESH just then (fail closed, ADR 0009), not because the time is taken.
 * The status stays the documented 409 so no client changes meaning, and this
 * adds `Retry-After` so a client (an agent, the web) can tell the refusal is
 * worth retrying and when.
 */
@Injectable()
export class CalendarRetryAfterInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((err: unknown) => {
        if (err instanceof HttpException && isCalendarUnavailable(err.getResponse())) {
          const res = context.switchToHttp().getResponse<{
            headersSent?: boolean;
            setHeader?: (name: string, value: string) => void;
          }>();
          if (res && !res.headersSent) res.setHeader?.('Retry-After', String(CALENDAR_RETRY_AFTER_SECONDS));
        }
        return throwError(() => err);
      }),
    );
  }
}

function isCalendarUnavailable(body: unknown): boolean {
  return !!body && typeof body === 'object' && (body as { error?: unknown }).error === 'CALENDAR_UNAVAILABLE';
}
