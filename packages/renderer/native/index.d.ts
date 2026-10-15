// Generated from napi-rs type metadata; do not edit.
/** Execute one bounded UTF-16-code-unit JSON request and return a result envelope. */
export function execute(request: string): string;
/** Measure bounded lossless UTF-16 directly, without JSON or code-unit arrays in JavaScript. */
export function displayWidth(request: string): number;
/** Look up one validated Unicode code point, including lone surrogate code-unit values. */
export function codePointWidth(code: number): number;
/** Transform bounded UTF-16 directly, preserving unpaired surrogates. */
export function stripAnsi(request: string): string;
/** Transform bounded UTF-16 directly, preserving unpaired surrogates. */
export function escapeControls(request: string): string;
/** Transform bounded UTF-16 directly, preserving unpaired surrogates. */
export function sanitizePasted(request: string): string;
/** Transform bounded UTF-16 and an integer column budget without JSON transport. */
export function truncateToWidth(request: string, budget: number): string;
/** Transform bounded UTF-16 and an integer column budget without JSON transport. */
export function tailToWidth(request: string, budget: number): string;
/** Transform bounded UTF-16 and an integer column budget without JSON transport. */
export function fitToWidth(request: string, budget: number): string;
/** Transform bounded UTF-16 and an integer column budget without JSON transport. */
export function chunkToWidth(request: string, budget: number): Array<string>;
/** Transform bounded UTF-16 and an integer column budget without JSON transport. */
export function wrapToWidth(request: string, budget: number): Array<string>;
