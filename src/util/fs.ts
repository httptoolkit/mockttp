/**
 * @module Internal
 */

import fs = require('fs');

export function readFile(filename: string, encoding: null): Promise<Buffer>;
export function readFile(filename: string, encoding: string): Promise<string>;
export function readFile(filename: string, encoding: string | null): Promise<string | Buffer> {
    return new Promise((resolve, reject) => {
        fs.readFile(filename, encoding, (err, contents: string | Buffer) => {
            if (err) reject(err);
            else resolve(contents);
        });
    });
}