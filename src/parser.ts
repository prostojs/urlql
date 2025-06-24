import { Token, TokenType } from "./tokens";
import { FilterExpr } from "./urlql";

export type SupportedOps = '$eq' | '$ne' | '$gt' | '$gte' | '$lt' | '$lte' | '$in' | '$nin' | '$regex' | '$exists';

export class Parser {
    private i = 0;
    constructor(private readonly t: Token[]) { }

    /** Helpers */
    private peek(offset = 0) { return this.t[this.i + offset]; }
    private consume(type?: TokenType) {
        const tok = this.t[this.i++];
        if (type && tok.type !== type) {
            throw new SyntaxError(`Expected ${type}, got "${tok.value}" at pos ${tok.pos}`);
        }
        return tok;
    }
    private match(type: TokenType) {
        if (this.peek()?.type === type) { this.consume(); return true; }
        return false;
    }
    expectEof() {
        if (this.i !== this.t.length)
            throw new SyntaxError(`Unexpected token at pos ${this.t[this.i]?.pos}. End of input expected.`);
    }

    private insights = new Map<string, Set<SupportedOps | '$select' | '$order'>>()

    captureInsights(field: string, op: SupportedOps | '$select' | '$order') {
        if (!this.insights.has(field)) {
            this.insights.set(field, new Set())
        }
        this.insights.get(field)!.add(op);
    }

    getInsights() {
        return this.insights;
    }

    /** === grammar methods === */

    /** expression := disjunction */
    parseExpression(): FilterExpr {
        return this.parseDisjunction();
    }

    parseDisjunction(): FilterExpr {
        let node = this.parseConjunction();
        const orNodes: FilterExpr[] = [node];

        while (this.match('or')) {
            orNodes.push(this.parseConjunction());
        }

        return orNodes.length === 1 ? node : { $or: orNodes };
    }

    parseConjunction(): FilterExpr {
        const nodes: FilterExpr[] = [this.parseTerm()];
        while (this.match('and')) nodes.push(this.parseTerm());

        if (nodes.length === 1) return nodes[0];

        // try flatten; if unsafe fall back to $and
        const merged = mergeConjunction(nodes);
        return merged ?? { $and: nodes };
    }

    parseTerm(): FilterExpr {
        /* group */
        if (this.match('lparen')) {
            const inside = this.parseDisjunction();
            this.consume('rparen');
            return inside;
        }

        /* BETWEEN: literal (<|<=) path (<|<=) literal */
        if (this.peek().type === 'number' || this.peek().type === 'string') {
            const lhsLit = this.parseLiteral();
            const firstOp = this.consume().type as TokenType; // op-lt / op-lte
            if (firstOp !== 'op-lt' && firstOp !== 'op-lte') {
                // rewind pointer - we actually parsed comparison starting with literal
                this.i -= 2;
            } else {
                // must be path next
                const field = this.consume('word').value;
                const secondOpTok = this.consume();
                if (secondOpTok.type !== 'op-lt' && secondOpTok.type !== 'op-lte') {
                    throw new SyntaxError(`Invalid between syntax at pos ${secondOpTok.pos}`);
                }
                const rhsLit = this.parseLiteral();
                const out: FilterExpr = {};
                const op1 = firstOp === 'op-lt' ? '$gt' : '$gte'
                const op2 = secondOpTok.type === 'op-lt' ? '$lt' : '$lte'
                out[field] = {
                    [op1]: lhsLit,
                    [op2]: rhsLit,
                };
                this.captureInsights(field, op1);
                this.captureInsights(field, op2);
                return out;
            }
        }

        /* $exists / $!exists  ================================================= */
        if (this.peek().type === 'keyword') {
            const kwTok = this.peek();
            if (kwTok.value === '$exists' || kwTok.value === '$!exists') {
                this.consume('keyword');               // consume keyword
                this.consume('op-eq');                 // '='
                const fields: string[] = [];
                fields.push(this.consume('word').value);
                while (this.match('comma')) fields.push(this.consume('word').value);
                for (const field of fields) {
                    this.captureInsights(field, '$exists');
                }
                return buildExists(fields, kwTok.value === '$exists');
            }
        }

        /* IN / NIN list   word {!} { lit , lit } */
        if (this.peek().type === 'word' && this.peek(1)?.type === 'lbrace' ||
            (this.peek(1)?.type === 'bang' && this.peek(2)?.type === 'lbrace')) {
            const field = this.consume('word').value;
            let negate = false;
            if (this.match('bang')) negate = true;
            this.consume('lbrace');
            const list: any[] = [];
            list.push(this.parseLiteral());
            while (this.match('comma')) list.push(this.parseLiteral());
            this.consume('rbrace');

            const out: FilterExpr = {};
            const op = negate ? '$nin' : '$in';
            out[field] = { [op]: list };
            this.captureInsights(field, op);
            return out;
        }

        /* comparison   path op lit */
        const fieldTok = this.consume('word');
        const opTok = this.consume() as Token;
        const lit = this.parseLiteral();
        const op = opMap[opTok.type];
        const field = fieldTok.value
        if (op === undefined)
            throw new SyntaxError(`Unsupported operator "${opTok.value}" at pos ${opTok.pos}`);

        this.captureInsights(field, op)
        return op === '$eq' ? { [field]: lit } : { [field]: { [op]: lit } };
    }

    parseLiteral(): any {
        const tok = this.consume();
        switch (tok.type) {
            case 'number': return Number(tok.value);
            case 'boolean': return tok.value === 'true';
            case 'null': return null;
            case 'regex': return new RegExp(tok.value.slice(1, tok.value.lastIndexOf('/')), tok.value.slice(tok.value.lastIndexOf('/') + 1));
            case 'word': return tok.value
            case 'string': return unescapeString(tok.value)
            default: throw new SyntaxError(`Unexpected literal "${tok.value}" at pos ${tok.pos}`);
        }
    }
}

const opMap: {
    [name in TokenType]?: SupportedOps
} = {
    'op-eq': '$eq',
    'op-ne': '$ne',
    'op-gt': '$gt',
    'op-gte': '$gte',
    'op-lt': '$lt',
    'op-lte': '$lte',
    'op-regex': '$regex',
};

function unescapeString(str: string): string {
    return str.replace(/(^'|'$)/gu, '');
}

/**
 * Attempt to merge an array of simple nodes produced by `parseTerm`.
 *  • Returns a single flattened object if safe.
 *  • Returns null when it hits a conflict or a nested logical node.
 *
 *  A “simple node” is one object with exactly ONE top-level key and that key
 *  is NOT $and / $or.  Example: { age:{ $gte:18 } }  or  { name:'John' }.
 */
function mergeConjunction(nodes: FilterExpr[]): FilterExpr | null {
    
    const merged: FilterExpr[] = []
    let currentMerge: FilterExpr = {}
    for (const node of nodes) {
        if ('$or' in node || '$and' in node) {
            merged.push(node)
            continue
        }
        for (const [key, val] of Object.entries(node)) {
            if (key in currentMerge) {
                // need to compare all the operators and merge if no conflicts occured
                const currentOps = isPrimitive(currentMerge[key]) ? ['$eq'] : Object.keys(currentMerge[key])
                const currentVal = currentMerge[key]
                const otherOps = isPrimitive(val) ? new Set('$eq') : new Set(Object.keys(val))
                const otherVal = val
                const intersects: boolean = currentOps.some((op) => otherOps.has(op))
                if (intersects) {
                    merged.push(currentMerge)
                    currentMerge = {}
                } else {
                    currentMerge[key] = {}
                    for (const op of currentOps) {
                        currentMerge[key][op as '$eq'] = isPrimitive(currentVal) ? currentVal : currentVal[op as '$eq']
                    }
                    for (const op of Array.from(otherOps)) {
                        currentMerge[key][op as '$eq'] = isPrimitive(otherVal) ? otherVal : otherVal[op as '$eq']
                    }
                }
            } else {
                currentMerge[key] = val
            }
        }
    }
    if (Object.keys(currentMerge).length > 0) {
        merged.push(currentMerge)
    }

    return merged.length > 1 ? { $and: merged } : merged[0] ?? null;
}

function isPrimitive(x: unknown): x is string | number | boolean | null | RegExp | Date {
    return (
        x === null ||
        typeof x === 'string' ||
        typeof x === 'number' ||
        typeof x === 'boolean' ||
        x instanceof RegExp ||
        x instanceof Date
    );
}
  

function buildExists(fields: string[], positive: boolean): FilterExpr {
    const out: FilterExpr = {};
    for (const f of fields) {
        out[f] = { $exists: positive }
    };
    return out;
}
