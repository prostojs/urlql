import { Parser } from "./parser";
import { lex } from "./tokens";

// ─────────── Parser public result ───────────
/**
 * Object returned by parseUrlql().
 * Fully serialisable; no external types.
 */
export interface UrlqlQuery {
    /** Filter tree expressed with Mongo-compatible operators. */
    filter: FilterExpr & Record<string, Primitive>;

    /** Query controls */
    controls: {
        $sort?: Record<string, 1 | -1>;
        $skip?: number;
        $limit?: number;
        $count?: boolean;
        $select?: Record<string, 0 | 1>
    } & Record<string, string>;
}

/** Minimal set of node shapes we emit */
export type FilterExpr =
    | ComparisonNode
    | LogicalNode

export type ComparisonNode = Record<string,
    | Primitive
    | { [op in '$eq' | '$ne' | '$gt' | '$gte' | '$lt' | '$lte' | '$in' | '$nin' | '$regex' | '$exists']?: Primitive | Primitive[] }
>;

export type LogicalNode =
    | { $and: FilterExpr[] }
    | { $or: FilterExpr[] };

export type Primitive = string | number | boolean | null | RegExp | Date;

/**
 * Parse a **urlql** query string (everything after the `?` in a URL)
 * into a structured `{ filter, controls }` object.
 *
 * The string may contain:
 *   • logical connectors `&` (AND) and `^` (OR)  
 *   • comparison operators (=, !=, >, >=, <, <=, ~=, in‐list, nin‐list, between)  
 *   • grouping parentheses  
 *   • control keywords that start with `$` (e.g. `$select`, `$limit`, `$order`)
 *
 * All `%xx` escape sequences are decoded and `+` is converted to space before parsing.
 *
 * @param raw - Raw query string _without_ the leading “?” (e.g. `"age>=18&$limit=10"`).
 *              It can be the output of `location.search.slice(1)` or the literal
 *              query part received by an HTTP server.
 *
 * @returns {UrlqlQuery} An object with:
 * ```ts
 * {
 *   filter:   FilterExpr & Record<string, Primitive>;
 *   controls: {
 *     $sort?:   Record<string, 1 | -1>;
 *     $skip?:   number;
 *     $limit?:  number;
 *     $count?:  boolean;
 *     $select?: Record<string, 0 | 1>;
 *   } & Record<string, string>;   // any custom $keyword passes through
 * }
 * ```
 *
 * @example
 * ```ts
 * import { parseUrlql } from 'urlql';
 *
 * const qs = 'age>=18&status!=DELETED&$select=name,email&$limit=20';
 * const { filter, controls } = parseUrlql(qs);
 *
 * // filter   -> { age: { $gte: 18 }, status: { $ne: 'DELETED' } }
 * // controls -> { $select: { name: 1, email: 1 }, $limit: 20 }
 * ```
 */
export function parseUrlql(raw: string): UrlqlQuery {
    const parts = raw.split('&');

    const controlParts: string[] = [];
    const exprParts: string[] = [];

    for (const p of parts) {
        if (/^\$[A-Za-z0-9_!]+/.test(p) && !p.startsWith('$exists=') && !p.startsWith('$!exists=')) controlParts.push(p);
        else if (p.length) exprParts.push(p);
    }

    const result: UrlqlQuery = { filter: {}, controls: {} };

    // ── controls (also returns an optional extra filter) ──
    handleControls(controlParts, result);

    // ── main expression ──
    let exprFilter: FilterExpr = {};
    if (exprParts.length) {
        const rawExpr = exprParts.join('&');      // keep “&”
        const decoded = decodeURIComponent(rawExpr);
        const tokens = lex(decoded);
        const parser = new Parser(tokens);
        exprFilter = parser.parseExpression();
        parser.expectEof();
      }

    // ── merge filters  (extra goes into $and if both exist) ──
    result.filter = exprFilter as UrlqlQuery['filter'];

    return result;
}

/******************************************************************
 * 2. handleControls – implements all reserved keywords
 ******************************************************************/
function handleControls(parts: string[], out: UrlqlQuery) {
    for (const raw of parts) {
        const [key, ...rest] = raw.split('=');
        const value = decodeURIComponent(rest.join('=')); // keep '=' inside value, if any

        switch (key) {
            /* ---------- projection ---------- */
            case '$select': {
                out.controls.$select ??= {};
                value.split(',').forEach(f => {
                    if (!f) return;
                    if (f.startsWith('-')) out.controls.$select![f.slice(1)] = 0;
                    else out.controls.$select![f] = 1;
                });
                break;
            }

            /* ---------- sorting & paging ---------- */
            case '$order': {
                out.controls.$sort ??= {};
                value.split(',').forEach(f => {
                    if (!f) return;
                    if (f.startsWith('-')) out.controls!.$sort![f.slice(1)] = -1;
                    else out.controls!.$sort![f] = 1;
                });
                break;
            }
            case '$limit':
            case '$top':
                out.controls.$limit = Number(value);
                break;

            case '$skip':
                out.controls.$skip = Number(value);
                break;

            case '$count':
                out.controls.$count = true;
                break;

            /* ---------- unknown keyword ---------- */
            default:
                out.controls[key] = value;
        }
    }
  }