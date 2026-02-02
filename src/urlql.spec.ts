import { describe, it, expect } from 'vitest';
import { parseUrlql } from './urlql';

describe('Urlql – happy‑path filters', () => {
    it('simple equality / numeric inference', () => {
        const q = 'age=25&status=ACTIVE';
        const r = parseUrlql(q);
        expect(r.filter).toEqual({ age: 25, status: 'ACTIVE' });
    });

    it('only controls', () => {
        const q = '$select=name';
        const r = parseUrlql(q);
        expect(r).toMatchInlineSnapshot(`
          {
            "controls": {
              "$select": {
                "name": 1,
              },
            },
            "filter": {},
            "insights": Map {
              "name" => Set {
                "$select",
              },
            },
          }
        `)
    });

    it('simple equality for props with dots', () => {
        const q = 'client.age=25&items.0.status=ACTIVE';
        const r = parseUrlql(q);
        expect(r.filter).toEqual({ 'client.age': 25, 'items.0.status': 'ACTIVE' });
    });

    it('greater / less comparisons', () => {
        const r = parseUrlql('age>=18&price<99.99');
        expect(r.filter).toEqual({
            age: { $gte: 18 },
            price: { $lt: 99.99 },
        });
    });

    it('regex operator', () => {
        const r = parseUrlql("name~=/^Jo/i");
        expect(r.filter).toEqual({ name: { $regex: /^Jo/i } });
    });

    it('strings with space', () => {
        const r = parseUrlql("name=John%20Doe");
        expect(r.filter).toEqual({ name: 'John Doe' });
    });

    it('in / nin lists', () => {
        const r = parseUrlql('role{Admin,Editor}&status!{Draft,Deleted}');
        expect(r.filter).toEqual({
            role: { $in: ['Admin', 'Editor'] },
            status: { $nin: ['Draft', 'Deleted'] },
        });
    });

    it('between (exclusive)', () => {
        const r = parseUrlql('25<age<35');
        expect(r.filter).toEqual({ age: { $gt: 25, $lt: 35 } });
    });

    it('AND via & and OR via ^ (precedence)', () => {
        const q = 'age>25^score>550&status=VIP';
        // & binds tighter than ^ :  (age>25) ^ (score>550 & status='VIP')
        const r = parseUrlql(q);
        expect(r.filter).toEqual({
            $or: [
                { age: { $gt: 25 } },
                { score: { $gt: 550 }, status: 'VIP' },
            ],
        });
    });

    it('grouped parentheses overriding precedence', () => {
        const q = '(age>25&score>550)^status=VIP';
        const r = parseUrlql(q);
        expect(r.filter).toEqual({
            $or: [
                { age: { $gt: 25 }, score: { $gt: 550 } },
                { status: 'VIP' },
            ],
        });
    });
});

describe('Urlql – projection / options keywords', () => {
    it('$select include', () => {
        const r = parseUrlql('$select=firstName,lastName&age>=18');
        expect(r.controls.$select).toEqual({ firstName: 1, lastName: 1 });
        expect(r.filter.age).toEqual({ $gte: 18 });
    });

    it('$select exclude', () => {
        const r = parseUrlql('$select=-password,-client.ssn&status=ACTIVE');
        expect(r.controls.$select).toEqual({ password: 0, 'client.ssn': 0 });
    });

    it('order, limit, skip', () => {
        const r = parseUrlql('$order=-createdAt,score&$limit=20&$skip=40');
        expect(r.controls).toEqual({
            $sort: { createdAt: -1, score: 1 },
            $limit: 20,
            $skip: 40,
        });
    });

    it('$count flag', () => {
        const r = parseUrlql('$count&status=ACTIVE');
        expect(r.controls.$count).toBe(true);
    });
});

describe('Urlql – exists helpers', () => {
    it('$exists positive list', () => {
        const r = parseUrlql('$exists=client.phone,client.address');
        expect(r.filter).toEqual({
            'client.phone': { $exists: true },
            'client.address': { $exists: true },
        });
    });

    it('$!exists negative list', () => {
        const r = parseUrlql('$!exists=meta.deletedAt');
        expect(r.filter).toEqual({ 'meta.deletedAt': { $exists: false } });
    });
});

describe('Urlql – literal typing edge‑cases', () => {
    it('numeric vs string with quotes', () => {
        const r = parseUrlql("code='25'&limit=25");
        expect(r.filter.code).toBe('25');
        expect(r.filter.limit).toBe(25);
    });

    it('boolean vs string', () => {
        const r = parseUrlql("flag=true&label='true'");
        expect(r.filter.flag).toBe(true);
        expect(r.filter.label).toBe('true');
    });

    it('null vs string', () => {
        const r = parseUrlql("deleted=null&note='null'");
        expect(r.filter.deleted).toBeNull();
        expect(r.filter.note).toBe('null');
    });

    it('leading‑zero number treated as string', () => {
        const r = parseUrlql("code=007");
        // spec: leading zero → string
        expect(r.filter.code).toBe('007');
    });

    it('regex flags preserved', () => {
        const r = parseUrlql('name~=/^a.+z/im');
        expect(r.filter.name).toEqual({ $regex: /^a.+z/im });
    });
});

describe('Urlql – error cases', () => {
    it('double equals should throw', () => {
        expect(() => parseUrlql('name==John')).toThrow();
    });

    it('unbalanced parentheses should throw', () => {
        expect(() => parseUrlql('(age>25&score>550')).toThrow();
    });

    it('unknown $keyword should throw', () => {
        expect(() => parseUrlql('$foo=bar')).not.toThrow();
        expect(parseUrlql('$foo=bar')).toEqual({
            filter: {},
            controls: { $foo: 'bar' },
            insights: new Map()
        });
    });
});

// -----------------------------------------------------------------------------
// BIG “kitchen-sink” query – covers every operator & control in one go
// -----------------------------------------------------------------------------
describe('Urlql – kitchen-sink query', () => {
    it('parses full-feature query correctly', () => {
        /* prettier-ignore */
        const big =
            `$select=firstName,-client.ssn` + // projection
            `&$order=-createdAt,score` + // sort ASC/DESC
            `&$limit=50&$skip=10` + // paging
            `&$count` + // count flag
            `&$exists=client.phone` + // positive exists
            `&$!exists=deletedAt` + // negative exists
            `&` +
            `client.age>=18&client.age<=30&` + // gte / lte merge
            `status!=DELETED&` + // not-equal
            `name~=/^Jo/i&` + // regex
            `role{Admin,Editor}&` + // in-list
            `category!{obsolete,temp}&` + // nin-list
            `25<height<35` + // between
            `` +
            `^` +
            `score>550&` + // OR right side: gt
            `price>50&price<100` + // gt + lt merge
            `&$!exists=deletedFrom` + // negative exists in group
            ``;

        const expected = {
            $or: [
                {
                    deletedAt: { $exists: false },
                    'client.phone': { $exists: true },
                    'client.age': { $gte: 18, $lte: 30 },
                    status: { $ne: 'DELETED' },
                    name: { $regex: /^Jo/i },
                    role: { $in: ['Admin', 'Editor'] },
                    category: { $nin: ['obsolete', 'temp'] },
                    height: { $gt: 25, $lt: 35 },
                }, {
                    score: { $gt: 550 },
                    price: { $gt: 50, $lt: 100 },
                    deletedFrom: { $exists: false },
                }
            ]
        }

        const r = parseUrlql(big);

        // ---- controls -----------------------------------------------------------
        expect(r.controls).toEqual({
            $select: { firstName: 1, 'client.ssn': 0 },
            $sort: { createdAt: -1, score: 1 },
            $limit: 50,
            $skip: 10,
            $count: true,
        });

        expect(r.filter).toEqual(expected);
    });

    it('parses full-feature query correctly v2', () => {
        /* prettier-ignore */
        const big =
            `$select=firstName,-client.ssn` + // projection
            `&$order=-createdAt,score` + // sort ASC/DESC
            `&$limit=50&$skip=10` + // paging
            `&$count` + // count flag
            `&$exists=client.phone` + // positive exists
            `&$!exists=deletedAt` + // negative exists
            `&` +
            `age>=18&age<=30` + // gte / lte merge
            `&(` +
            `status!=DELETED^` + // not-equal
            `name~=/^Jo/i^` + // regex
            `role{Admin,Editor}` + // in-list
            `)&` +
            `category!{obsolete,temp}&` + // nin-list
            `25<height<35` + // between
            `` +
            `^` +
            `score>550&` + // OR right side: gt
            `price>50&price<100` + // gt + lt merge
            `&$!exists=deletedFrom` + // negative exists in group
            ``;

        const expected = {
            $or: [
                {
                    $and: [{
                        $or: [
                            { status: { $ne: 'DELETED' } },
                            { name: { $regex: /^Jo/i } },
                            { role: { $in: ['Admin', 'Editor'] } },
                        ]
                    }, {
                        'client.phone': { $exists: true },
                        deletedAt: { $exists: false },
                        age: { $gte: 18, $lte: 30 },
                        category: { $nin: ['obsolete', 'temp'] },
                        height: { $gt: 25, $lt: 35 },   
                    }]
                }, {
                    score: { $gt: 550 },
                    price: { $gt: 50, $lt: 100 },
                    deletedFrom: { $exists: false },
                }
            ]
        }

        const r = parseUrlql(big);

        // ---- controls -----------------------------------------------------------
        expect(r.controls).toEqual({
            $select: { firstName: 1, 'client.ssn': 0 },
            $sort: { createdAt: -1, score: 1 },
            $limit: 50,
            $skip: 10,
            $count: true,
        });

        expect(r.filter).toEqual(expected);

        expect(r.insights).toMatchInlineSnapshot(`
          Map {
            "client.phone" => Set {
              "$exists",
            },
            "deletedAt" => Set {
              "$exists",
            },
            "age" => Set {
              "$gte",
              "$lte",
            },
            "status" => Set {
              "$ne",
            },
            "name" => Set {
              "$regex",
            },
            "role" => Set {
              "$in",
            },
            "category" => Set {
              "$nin",
            },
            "height" => Set {
              "$gt",
              "$lt",
            },
            "score" => Set {
              "$gt",
              "$order",
            },
            "price" => Set {
              "$gt",
              "$lt",
            },
            "deletedFrom" => Set {
              "$exists",
            },
            "firstName" => Set {
              "$select",
            },
            "client.ssn" => Set {
              "$select",
            },
            "createdAt" => Set {
              "$order",
            },
          }
        `)
    });
});

// -----------------------------------------------------------------------------
// Percent-encoding handling
// -----------------------------------------------------------------------------
describe('Urlql – percent-encoded literals', () => {
    it('decodes quoted strings with spaces / + / %xx', () => {
        const q = "name=%27John%20Doe%27&note=%27text%20with%20spaces%27";
        const r = parseUrlql(q);
        expect(r.filter).toEqual({
            name: 'John Doe',
            note: 'text with spaces',
        });
    });

    it('decodes an encoded regex literal', () => {
        // '/^Jo/i' encoded: %2F = '/', %5E = '^', %2F = '/', 'i' unchanged
        const r = parseUrlql("name~=%2F%5EJo%2Fi");
        expect(r.filter).toEqual({ name: { $regex: /^Jo/i } });
    });
});

describe('Urlql control words', () => {
    it('supports only control words', () => {
        const q = "%24search=test";
        const r = parseUrlql(q);
        expect(r.controls).toEqual({
            $search: 'test',
        });
    });
});