import * as autocannon from 'autocannon';
import { expect } from '../test-utils';

export interface PerformanceResult {
    throughput: number; // req/sec
    latency: {
        mean: number;
        p50: number;
        p75: number;
        p90: number;
        p99: number;
        p99_9: number;
    };
    duration: number;
    requests: {
        total: number;
        average: number;
    };
    errors: number;
    timeouts: number;
}

export interface PerformanceTestOptions {
    url: string;
    duration?: number; // seconds
    connections?: number;
    pipelining?: number;
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    body?: string | Buffer;
    headers?: Record<string, string>;
}

/**
 * Run a performance test and return formatted results
 */
export async function runPerformanceTest(
    options: PerformanceTestOptions
): Promise<PerformanceResult> {
    const result = await autocannon({
        url: options.url,
        duration: options.duration || 10,
        connections: options.connections || 10,
        pipelining: options.pipelining || 1,
        method: options.method || 'GET',
        body: options.body,
        headers: options.headers
    });

    return {
        throughput: result.requests.average,
        latency: {
            mean: result.latency.mean,
            p50: result.latency.p50,
            p75: result.latency.p75,
            p90: result.latency.p90,
            p99: result.latency.p99,
            p99_9: result.latency.p99_9
        },
        duration: result.duration,
        requests: {
            total: result.requests.total,
            average: result.requests.average
        },
        errors: result.errors,
        timeouts: result.timeouts
    };
}

/**
 * Print performance results in a readable format
 */
export function printResults(name: string, result: PerformanceResult): void {
    console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${name}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Throughput:  ${result.throughput.toFixed(2)} req/sec
Total Reqs:  ${result.requests.total}
Duration:    ${result.duration}s

Latency:
  Mean:      ${result.latency.mean.toFixed(2)}ms
  p50:       ${result.latency.p50.toFixed(2)}ms
  p75:       ${result.latency.p75.toFixed(2)}ms
  p90:       ${result.latency.p90.toFixed(2)}ms
  p99:       ${result.latency.p99.toFixed(2)}ms
  p99.9:     ${result.latency.p99_9.toFixed(2)}ms

Errors:      ${result.errors}
Timeouts:    ${result.timeouts}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    `);
}

/**
 * Assert performance meets minimum thresholds
 */
export function assertPerformance(
    result: PerformanceResult,
    thresholds: {
        minThroughput?: number;
        maxP99Latency?: number;
        maxErrors?: number;
    }
): void {
    if (thresholds.minThroughput !== undefined) {
        expect(result.throughput).to.be.greaterThan(
            thresholds.minThroughput,
            `Throughput ${result.throughput.toFixed(2)} req/sec is below threshold ${thresholds.minThroughput} req/sec`
        );
    }

    if (thresholds.maxP99Latency !== undefined) {
        expect(result.latency.p99).to.be.lessThan(
            thresholds.maxP99Latency,
            `P99 latency ${result.latency.p99.toFixed(2)}ms exceeds threshold ${thresholds.maxP99Latency}ms`
        );
    }

    if (thresholds.maxErrors !== undefined) {
        expect(result.errors).to.be.lessThanOrEqual(
            thresholds.maxErrors,
            `Errors ${result.errors} exceeds threshold ${thresholds.maxErrors}`
        );
    }
}