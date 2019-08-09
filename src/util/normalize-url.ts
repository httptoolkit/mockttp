/**
 * @module Internal
 */

import * as _ from 'lodash';
import * as normalize from "normalize-url";

import { nthIndexOf } from './util';
import { isAbsoluteUrl } from './request-utils';

/** Normalizes URLs to the form used when matching them. This:
 *   - Normalize empty paths (example.com) to a single slash (example.com/)
 *   - Removes all query parameters
 *   - ...probably some other things?
 */
export const normalizeUrl =
    _.memoize(
        (url: string): string => {
            let normalized = normalize(url, {
                stripWWW: false,
                removeTrailingSlash: false, // Affects non-empty paths only
                removeQueryParameters: [/.*/],
            });

            // If the URL represents an empty path (absolute or relative), add a trailing slash
            if (isAbsoluteUrl(normalized)) {
                const pathIndex = nthIndexOf(normalized, '/', 3);
                if (pathIndex === -1) normalized += '/';
            } else if (normalized === '') {
                normalized = '/';
            }

            return normalized;
        }
    );
