# urlql

A **human‑readable URL query language** for GET requests.  It turns a browser‑friendly query string into a pair of plain JavaScript objects:

* **`filter`** – a structured predicate tree (comparison operators, `AND`/`OR`, lists, regexes, exists, between).
* **`controls`** – optional, query‑wide instructions such as paging, sort, projection or any custom `$keyword`.

The returned shape is intentionally **Mongo‑compatible**, so it can be passed straight to `collection.find()`.  *But nothing in urlql is Mongo‑specific*; the output is just JSON‑serialisable data.  Adapt it to SQL query builders, Elasticsearch DSL, or any datastore that understands the same operator concepts.

---

## Why urlql?

| Problem                                                                    | How urlql helps                                                        |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| GraphQL and POST‑JSON endpoints require specialised clients.               | urlql stays in the browser address bar – copy/paste, bookmark, share.  |
| OData’s `$filter=…` strings are verbose and percent‑encoded.               | urlql keeps tokens unescaped where allowed ( `&`, `^`, `(`, `)` ).     |
| Ad‑hoc debugging against REST services is slow when requests must be JSON. | urlql works with a **single GET** – perfect for cURL or a browser tab. |

---

## Quick‑start

```ts
import { parseUrlql } from 'urlql';

// everything after "?":
const qs = location.search.slice(1);
const { filter, controls } = parseUrlql(qs);
```

The parser is dependency‑free and returns:

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
}
```

### Using with MongoDB (optional)

```ts
collection.find(filter, {
  projection : controls.$select,
  sort       : controls.$sort,
  limit      : controls.$limit,
  skip       : controls.$skip,
});
```

Adapting to other engines is as simple as mapping the same keys.

---

## Language reference

### Field comparison operators

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

### Logical connectors

* `&` → **AND** (higher precedence)
* `^` → **OR**
* Parentheses `(...)` for grouping

### Literals

| Kind    | Example(s)                                        |
| ------- | ------------------------------------------------- |
| Number  | `42`, `-7`, `3.14`                                |
| String  | `name='John%20Doe'` (single quotes) or bare `Admin` |
| Boolean | `true`, `false`                                   |
| Null    | `null`                                            |
| RegExp  | `/pattern/i`                                      |

Spaces may be written as `%20`. `urlql` applies `decodeURIComponent` so mixed usage is fine.

### Control keywords (start with `$`)

| Keyword   | Example value                                         | Meaning               |
| --------- | ----------------------------------------------------- | --------------------- |
| `$select` | `name,-password`                                      | Field include/exclude |
| `$order`  | `-createdAt,score`                                    | Sort DESC / ASC       |
| `$limit`  | `50`                                                  | Limit maximum docs    |
| `$top`    | alias of `$limit`                                     |                       |
| `$skip`   | `100`                                                 | Skip (offset)         |
| `$count`  | *(present)*                                           | Return only doc count |
| *custom*  | Any other `$foo=bar` is stored intact in **controls** |                       |

---

## Worked examples

```text
# Simple list + paging
?$select=name,email&$limit=10&$skip=20&name~=/doe/i
```

```js
filter   = { name: { $regex: /doe/i } };
controls = { $select:{name:1,email:1}, $limit:10, $skip:20 };
```

```text
# Complex grouping
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

```text
# All together (URL‑encoded)
$select=firstName,-ssn&$order=-createdAt&age>=18&age<=30&name~=%2F^Jo%2Fi
```

---

## Percent‑encoding tips

* `'` → `%27`, space → `%20`, `/` → `%2F`.

---

## Porting urlql to other stores
The parser produces plain data.  To use with another database:

1. Convert logical operators `$and/$or` into the target’s conjunctions.
2. Map comparison keys (`$gt`, `$in`, etc.) to the engine’s predicate syntax.
3. Honour `controls` where they make sense (e.g. translate `$sort` to `ORDER BY`).

---

Contributions are welcome – open an issue or PR 🤘

---

## License
MIT © Artem Maltsev
