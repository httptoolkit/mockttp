/**
 * An array of match/replace pairs. These will be applied to the initial value
 * like `input.replace(p1, p2)`, applied in the order provided. The first parameter
 * can be either a string or RegExp to match, and the second must be a string to
 * insert. The normal `str.replace` $ placeholders can be used in the second
 * argument, so that e.g. $1 will insert the 1st matched group.
 */
export type MatchReplacePairs = Array<[string | RegExp, string]>;

export function applyMatchReplace(input: string, matchReplace: MatchReplacePairs): string {
    let result = input;
    for (const [match, replacement] of matchReplace) {
        result = result.replace(match, replacement);
    }
    return result;
}

export type SerializedRegex = { regexSource: string, flags: string };

export const serializeRegex = (regex: RegExp): SerializedRegex => ({ regexSource: regex.source, flags: regex.flags });
export const deserializeRegex = (regex: SerializedRegex) => new RegExp(regex.regexSource, regex.flags);

export type SerializedMatchReplacePairs = Array<[SerializedRegex | string, string]>;

export const serializeMatchReplaceConfiguration = (matchReplace: MatchReplacePairs): SerializedMatchReplacePairs =>
    matchReplace.map(([match, result]) => [
        match instanceof RegExp ? serializeRegex(match) : match,
        result
    ]);

export const deserializeMatchReplaceConfiguration = (matchReplace: SerializedMatchReplacePairs): MatchReplacePairs =>
    matchReplace.map(([match, result]) => [
        typeof match !== 'string' && 'regexSource' in match
            ? deserializeRegex(match)
            : match,
        result
    ]);