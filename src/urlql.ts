import { Parser, SupportedOps } from "./parser";
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

    /** Query Insights: a map of used fields with a set of used operators */
    insights: Map<string, Set<SupportedOps | '$select' | '$order'>>;
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

    for (const _p of parts) {
        const p = decodeURIComponent(_p);
        if (/^\$[A-Za-z0-9_!]+/.test(p) && !p.startsWith('$exists=') && !p.startsWith('$!exists=')) controlParts.push(p);
        else if (p.length) exprParts.push(p);
    }


    // ── controls (also returns an optional extra filter) ──
    const { controls, selectInsights, orderInsights } = handleControls(controlParts);

    const result: UrlqlQuery = { filter: {}, controls, insights: new Map() };

    // ── main expression ──
    let exprFilter: FilterExpr = {};
    let parser: Parser
    if (exprParts.length) {
        const rawExpr = exprParts.join('&');      // keep “&”
        // const decoded = decodeURIComponent(rawExpr);
        const tokens = lex(rawExpr);
        parser = new Parser(tokens);
        exprFilter = parser.parseExpression();
        parser.expectEof();
    } else {
        parser = new Parser([]);
    }
    for (const f of selectInsights) {
        parser.captureInsights(f, '$select');
    }
    for (const f of orderInsights) {
        parser.captureInsights(f, '$order');
    }
    result.insights = parser.getInsights();

    // ── merge filters  (extra goes into $and if both exist) ──
    result.filter = exprFilter as UrlqlQuery['filter'];

    return result;
}

/******************************************************************
 * 2. handleControls – implements all reserved keywords
 ******************************************************************/
function handleControls(parts: string[]): {
    controls: UrlqlQuery['controls'],
    selectInsights: Set<string>
    orderInsights: Set<string>
} {

    const controls = {} as UrlqlQuery['controls']
    const selectInsights = new Set<string>()
    const orderInsights = new Set<string>()
    for (const raw of parts) {
        const [key, ...rest] = raw.split('=');
        const value = decodeURIComponent(rest.join('=')); // keep '=' inside value, if any

        switch (key) {
            /* ---------- projection ---------- */
            case '$select': {
                controls.$select ??= {};
                value.split(',').forEach(f => {
                    if (!f) return;
                    selectInsights.add(f.replace(/^-/, ''))
                    if (f.startsWith('-')) controls.$select![f.slice(1)] = 0;
                    else controls.$select![f] = 1;
                });
                break;
            }

            /* ---------- sorting & paging ---------- */
            case '$sort':
            case '$order': {
                controls.$sort ??= {};
                value.split(',').forEach(f => {
                    if (!f) return;
                    orderInsights.add(f.replace(/^-/, ''))
                    if (f.startsWith('-')) controls!.$sort![f.slice(1)] = -1;
                    else controls!.$sort![f] = 1;
                });
                break;
            }
            case '$limit':
            case '$top':
                controls.$limit = Number(value);
                break;

            case '$skip':
                controls.$skip = Number(value);
                break;

            case '$count':
                controls.$count = true;
                break;

            /* ---------- unknown keyword ---------- */
            default:
                controls[key] = value;
        }
    }
    return {
        controls,
        selectInsights,
        orderInsights,
    }
  }