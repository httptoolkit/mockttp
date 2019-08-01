/**
 * @module Internal
 */

import * as _ from 'lodash';
import * as normalize from "normalize-url";

/** Normalizes URLs to the form used when matching them. This:
 *   - Strips the trailing slash, iff that's the whole path
 *   - Removes all query parameters
 *   - ...probably some other things?
 */
export const normalizeUrl =
    _.memoize(
        (url: string): string => {
            return normalize(url, {
                stripWWW: false,
                removeTrailingSlash: false, // Affects non-empty paths only
                removeQueryParameters: [/.*/],
            });
        }
    );
