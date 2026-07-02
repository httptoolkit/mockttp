import { CustomError } from '@httptoolkit/util';

/**
 * Thrown to abort request handling cleanly - resetting/closing the connection rather than
 * reporting a server error. Recognised specially throughout the request pipeline (e.g. it
 * aborts & destroys the response instead of logging a failure and returning a 500).
 */
export class AbortError extends CustomError {
    constructor(
        message: string,
        readonly code: string
    ) {
        super(message);
    }
}
