export function shouldPassThrough(
  hostname: string | undefined,
  // Only one of these two should have values (validated above):
  passThroughPatterns: URLPattern[],
  interceptOnlyPatterns: URLPattern[] | undefined
): hostname is string {
  if (!hostname) return false;

  if (interceptOnlyPatterns) {
    return !interceptOnlyPatterns.some((pattern) =>
      pattern.test(`https://${hostname}`)
    );
  }

  return passThroughPatterns.some((pattern) =>
    pattern.test(`https://${hostname}`)
  );
}
