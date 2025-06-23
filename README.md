# urlql

A **human‑readable URL query language** for GET requests.  It turns a browser‑friendly query string into three plain JavaScript structures:

| Name           | What it contains                                                                                                    | Typical use‑case                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **`filter`**   | Predicate tree built from the query (`AND`/`OR`, comparisons, lists, regexes, exists, between).                     | Feed into a data‑layer (Mongo, SQL builder, Elasticsearch, etc.).           |
| **`controls`** | Global hints taken from `$keywords` (projection, sort, paging, custom flags).                                       | Apply limit/offset, create `ORDER BY`, choose columns, etc.                 |
| **`insights`** | `Map<string, Set<op>>` showing which **fields** appear in the query and with **which operators** (`$eq`, `$gt`, …). | Enforce white‑lists, build dynamic indexes, audit queries, security checks. |

The shapes are deliberately **Mongo‑compatible** (`$gt`, `$and`, …) so they can be passed to `collection.find()` directly.  But nothing is Mongo‑specific; the output is pure JSON‑serialisable data + `RegExp` objects.

---

## Why urlql?

| Pain point                                                       | urlql’s answer                                                       |
| ---------------------------------------------------------------- | -------------------------------------------------------------------- |
| GraphQL/JSON endpoints need POST bodies and specialised clients. | urlql stays entirely in the **address bar** – bookmark, share, cURL. |
| OData `$filter` strings are long and percent‑encoded.            | urlql keeps `&` `^` `(` `)` raw, so queries stay legible.            |
| Ad‑hoc debugging requires tools like Postman.                    | A single GET in the browser is enough.                               |
| Applications must enforce which fields a consumer may filter.    | `insights` tells you exactly which fields/operators were used.       |

---

## Quick‑start

```ts
import { parseUrlql } from 'urlql';

// everything after "?":
const qs = location.search.slice(1);
const { filter, controls, insights } = parseUrlql(qs);
```

Result interface (simplified):

```ts
interface UrlqlQuery {
  filter:   FilterExpr & Record<string, Primitive>;

  controls: {
    $sort?:   Record<string, 1 | -1>;   // standard keywords
    $skip?:   number;
    $limit?:  number;
    $count?:  boolean;
    $select?: Record<string, 0 | 1>;
  } & Record<string,string>;            // custom $keywords pass‑through

  insights: Map<string, Set<
    '$eq' | '$ne' | '$gt' | '$gte' | '$lt' | '$lte' | '$in' |
    '$nin' | '$regex' | '$exists'
  >>;
}
```

### Example – enforcing a whitelist

```ts
const SAFE_NUMERIC_ONLY = new Set(['$eq', '$gt', '$gte', '$lt', '$lte']);

for (const [field, ops] of insights) {
  if (field === 'price' && [...ops].some(op => !SAFE_NUMERIC_ONLY.has(op))) {
    throw new Error(`Price may only be filtered with numeric comparison ops`);
  }
}
```

---

## Language reference

### 1 Field comparison operators

| Syntax fragment                        | Parsed filter snippet                                    |
| -------------------------------------- | -------------------------------------------------------- |
| `status=OPEN`                          | `{status:'OPEN'}`                                        |
| `status!=CLOSED`                       | `{status:{$ne:'CLOSED'}}`                                |
| `age>18`  `age>=18`                    | `{age:{$gt:18}}`, `{age:{$gte:18}}`                      |
| `price<=9.99`                          | `{price:{$lte:9.99}}`                                    |
| `name~=/^Jo/i`                         | `{name:{$regex:/^Jo/i}}`                                 |
| `role{Admin,Editor}`                   | `{role:{$in:['Admin','Editor']}}`                        |
| `status!{X,Y}`                         | `{status:{$nin:['X','Y']}}`                              |
| `25<age<35`                            | `{age:{$gt:25,$lt:35}}`                                  |
| `$exists=phone`  `$!exists=archivedAt` | `{phone:{$exists:true}}`, `{archivedAt:{$exists:false}}` |

### 2 Logical connectors

* `&` → **AND** (higher precedence)
* `^` → **OR**
* Parentheses `(...)` for grouping

### 3 Literals & encoding rules

| Kind    | Example(s)                          |
| ------- | ----------------------------------- |
| Number  | `42`, `-7`, `3.14`                  |
| String  | `name='John%20Doe'` or bare `Admin` |
| Boolean | `true`, `false`                     |
| Null    | `null`                              |
| RegExp  | `/pattern/i`                        |

`urlql` runs `decodeURIComponent` on the expression part, so any `%xx` escapes are resolved. (The `+` shorthand for space **is not interpreted** in strings to avoid ambiguity with regex.)

### 4 Control keywords

| Keyword   | Example value                                       | Meaning               |
| --------- | --------------------------------------------------- | --------------------- |
| `$select` | `name,-password`                                    | Field include/exclude |
| `$order`  | `-createdAt,score`                                  | Sort DESC / ASC       |
| `$limit`  | `50`                                                | Limit max docs        |
| `$top`    | alias for `$limit`                                  |                       |
| `$skip`   | `100`                                               | Skip (offset)         |
| `$count`  | *present*                                           | Return only doc count |
| *custom*  | Any other `$foo=bar` kept untouched in **controls** |                       |

---

## Worked examples

```text
# 1. Simple list + paging + insights
?$select=name,email&$limit=10&name~=/doe/i
```

```js
filter   = { name: { $regex: /doe/i } };
controls = { $select:{name:1,email:1}, $limit:10 };
insights = Map { 'name' => Set(['$regex']) };
```

```text
# 2. Complex grouping
?(age>25&score>550)^status=VIP
```

```js
filter = {
  $or:[
    { age:{$gt:25}, score:{$gt:550} },
    { status:'VIP' }
  ]
};
```

`insights` here tells you `age` uses `$gt`, `score` uses `$gt`, `status` uses `$eq`.

```text
# 3. Kitchen‑sink query (shortened)
$exists=phone&age>=18&(status!=X^role{A,B})^price>50
```

Produces `filter`, `controls`, and an `insights` map with all operators used.

---

## Porting urlql to other stores

1. Translate logical nodes `$and/$or` into the target dialect.
2. Map comparison keys (`$gt`, `$in`, …) to the datastore’s predicate DSL.
3. Apply `controls` where relevant (projection, sorting, etc.).
4. Use `insights` to enforce per‑field policy.

A reference adapter for SQL builders is on the roadmap.

---

## Contributing / Roadmap

PRs and issues welcome – let’s evolve the language together 🛠️

---

## License

MIT © Artem Maltsev
