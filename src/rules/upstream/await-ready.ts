import type { EventEmitter } from 'events';

/**
 * Wait for a connection that's being set up to report that it's ready. If it errors,
 * closes or is aborted first, it's destroyed and this rejects (with the abort reason, if
 * it was aborted).
 */
export function awaitReady(
    connection: EventEmitter & { destroy(): void },
    readyEvent: string,
    signal: AbortSignal,
    closedError: () => Error
): Promise<void> {
    return new Promise((resolve, reject) => {
        const cleanUp = () => {
            signal.removeEventListener('abort', onAbort);
            connection.off('error', fail);
            connection.off('close', onClose);
            connection.off(readyEvent, onReady);
        };
        const fail = (error: Error) => {
            cleanUp();
            connection.destroy();
            reject(error);
        };
        const onAbort = () => fail(signal.reason);
        const onClose = () => fail(closedError());
        const onReady = () => {
            cleanUp();
            resolve();
        };

        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
        connection.once('error', fail);
        connection.once('close', onClose);
        connection.once(readyEvent, onReady);
    });
}
