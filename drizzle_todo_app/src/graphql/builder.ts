/**
 * @module graphql/builder
 *
 * Summary
 * -------
 * Auto-generates an executable {@link GraphQLSchema} from a Drizzle ORM schema
 * module (a `* as schema` namespace of {@link Table} definitions and optional
 * `relations(...)` declarations) bound to a Drizzle DB instance. The output
 * schema exposes per-table CRUD with rich filtering, ordering, and pagination,
 * plus recursive nested-relation traversal.
 *
 * Typical Flow
 * ------------
 * 1. {@link introspectSchema} walks the schema namespace and produces a
 *    {@link SchemaIntrospection}: the set of tables (by SQL name and by JS
 *    export key) and a relation map (explicit `relations()` plus auto-detected
 *    single-column FKs, both forward "one" and inverse "many").
 * 2. **Pass 1** — for each table, {@link buildSchema} constructs:
 *      - a {@link GraphQLObjectType} with a *lazy* fields-thunk that mixes
 *        scalar columns and relation fields (so cyclic types resolve through
 *        the same registered object types — this is what enables recursion);
 *      - an `Insert` input ({@link buildInsertInput}) — required = `notNull &&
 *        !hasDefault && !generated`;
 *      - an `Update` input ({@link buildUpdateInput}) — every column optional;
 *      - a `Where` input and `OrderBy` input from {@link buildWhereInput} /
 *        {@link buildOrderByInput} in `./filters.js`.
 * 3. **Pass 2** — {@link addRootFields} wires per-table root fields onto
 *    `Query` and `Mutation`:
 *      - `<jsKey>(where?, orderBy?, limit?, offset?): [<Type>!]!`
 *      - `<jsKey>Single(where?, orderBy?): <Type>`
 *      - `insertInto<Type>(values: [<Type>Insert!]!): [<Type>!]!`
 *      - `update<Type>(set: <Type>Update!, where?): [<Type>!]!`
 *      - `deleteFrom<Type>(where?): [<Type>!]!`
 * 4. Resolvers translate inputs through {@link whereToSql} / {@link orderByToSql}
 *    and call Drizzle's `db.select()/insert()/update()/delete()` — mutations use
 *    `.returning()` so they emit the affected rows.
 *
 * Recursive relation resolution
 * -----------------------------
 * Each relation field on a parent {@link GraphQLObjectType} resolves by reading
 * the parent row's local columns and querying the referenced table with `eq()`
 * conditions joined to any `where` the caller passed at the relation site.
 * Because the relation field's `type` references the **same** registered
 * `GraphQLObjectType` for the referenced table, GraphQL execution naturally
 * recurses into nested relations on that type — so e.g. `todos { assigneeId {
 * todos { assigneeId { name } } } }` works out of the box without any extra
 * registration. See {@link buildRelationField}.
 *
 * Notes
 * -----
 * - A relation field with the same name as a scalar column **replaces** that
 *   column on the **output** type (so `assigneeId { name }` traverses to the
 *   referenced row). The scalar value is still reachable in `where`, `set`,
 *   Insert, and Update inputs because those iterate the unchanged column map.
 * - The relation resolver issues one query per relation field per parent row
 *   (no DataLoader batching). Acceptable for small/medium response sizes;
 *   batch externally if needed.
 * - Composite foreign keys are skipped by the auto-FK detector; declare
 *   relations explicitly via Drizzle's `relations(...)` for those.
 */
import {
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLInt,
  type GraphQLFieldConfig,
  type GraphQLFieldConfigMap,
  type GraphQLInputFieldConfigMap,
} from "graphql";
import {
  and,
  eq,
  getTableColumns,
  getTableName,
  inArray,
  type Column,
  type SQL,
} from "drizzle-orm";
import {
  buildOrderByInput,
  buildWhereInput,
  orderByToSql,
  whereToSql,
  type ColumnMap,
} from "./filters.js";
import { introspectSchema, type ExtractedRelation } from "./relations.js";
import { columnToBaseType, wrapNonNull } from "./types.js";

/**
 * Structural shape of a Drizzle DB instance accepted by {@link buildSchema}.
 *
 * Any object exposing the standard Drizzle query builders (`select`, `insert`,
 * `update`, `delete`) is acceptable — works across SQLite, Postgres, and MySQL
 * dialects. Mutations rely on `.returning()` being available on the dialect.
 */
export interface DrizzleLike {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
}

/**
 * Optional knobs for {@link buildSchema}.
 */
export interface BuildSchemaOptions {
  /**
   * Override the generated GraphQL type name for a given JS schema export key.
   * Default is the capitalized key (e.g. `todos` → `Todos`). The override is
   * also propagated to all per-table input names (`<TypeName>Insert`,
   * `<TypeName>Update`, `<TypeName>Where`, `<TypeName>OrderBy`).
   */
  typeNames?: Record<string, string>;
}

/** Capitalize first character of a string. */
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Internal per-table working set carried between passes of {@link buildSchema}.
 *
 * Holds both the Drizzle handles (table reference, columns, primary-key columns)
 * and the GraphQL types derived from them so that root resolvers and relation
 * resolvers can refer back to the same constructed types.
 */
interface TableMeta {
  /** JS export key in the user's schema namespace (also the root query field name). */
  jsKey: string;
  /** GraphQL ObjectType name (defaults to `cap(jsKey)`; mutations are named `insertInto<typeName>`, etc.). */
  typeName: string;
  /** Drizzle table reference, passed through to query builders. */
  table: any;
  /** Map of GraphQL field name → Drizzle Column (the field name equals the Drizzle JS key). */
  columns: ColumnMap;
  /** Primary-key columns; used as the default "local side" of relation joins when not specified. */
  pkColumns: Column[];
  objectType: GraphQLObjectType;
  insertInput: GraphQLInputObjectType;
  updateInput: GraphQLInputObjectType;
  whereInput: GraphQLInputObjectType;
  orderByInput: GraphQLInputObjectType;
}

/**
 * Build a GraphQL schema from a Drizzle DB and a Drizzle schema namespace.
 *
 * Walks the schema in two passes (object/input types first, then root fields)
 * so that mutually-referencing relation types can refer to each other's
 * registered {@link GraphQLObjectType}. See the module overview for the full
 * pipeline and recursion guarantees.
 *
 * @param db Drizzle DB instance (any dialect; must expose `select/insert/update/delete`).
 * @param schema Imported schema namespace, e.g. `import * as schema from "./schema.js"`.
 *               Tables and `relations(...)` declarations are detected via Drizzle's
 *               `is(value, Table)` / `is(value, Relations)` brand checks.
 * @param options Optional {@link BuildSchemaOptions} (e.g. type-name overrides).
 * @returns `{ schema }` where `schema` is the executable {@link GraphQLSchema}, ready
 *          to hand to graphql-yoga / Apollo / etc.
 *
 * @example
 * import * as dbSchema from "./schema.js";
 * import { db } from "./db.js";
 * import { buildSchema } from "./graphql/index.js";
 *
 * const { schema } = buildSchema(db, dbSchema);
 * // → exposes Query.todos, Query.todosSingle, Mutation.insertIntoTodos, etc.
 */
export function buildSchema(
  db: DrizzleLike,
  schema: Record<string, unknown>,
  options: BuildSchemaOptions = {},
): { schema: GraphQLSchema } {
  const intro = introspectSchema(schema);
  const metas = new Map<string, TableMeta>(); // keyed by SQL table name

  // Pass 1: build object types (with relation field thunks) + input types.
  for (const [jsKey, table] of intro.tablesByKey) {
    const sqlName = getTableName(table);
    const typeName = options.typeNames?.[jsKey] ?? cap(jsKey);
    const columns = getTableColumns(table) as ColumnMap;
    const pkColumns = Object.values(columns).filter((c: any) => c.primary);

    const objectType = new GraphQLObjectType({
      name: typeName,
      fields: () => buildObjectFields(meta, intro, metas, db),
    });
    const insertInput = buildInsertInput(typeName, columns);
    const updateInput = buildUpdateInput(typeName, columns);
    const whereInput = buildWhereInput(typeName, columns);
    const orderByInput = buildOrderByInput(typeName, columns);

    const meta: TableMeta = {
      jsKey,
      typeName,
      table,
      columns,
      pkColumns,
      objectType,
      insertInput,
      updateInput,
      whereInput,
      orderByInput,
    };
    metas.set(sqlName, meta);
  }

  // Pass 2: build root Query and Mutation.
  const queryFields: GraphQLFieldConfigMap<unknown, unknown> = {};
  const mutationFields: GraphQLFieldConfigMap<unknown, unknown> = {};
  for (const meta of metas.values()) {
    addRootFields(meta, queryFields, mutationFields, db);
  }

  return {
    schema: new GraphQLSchema({
      query: new GraphQLObjectType({ name: "Query", fields: queryFields }),
      mutation: Object.keys(mutationFields).length
        ? new GraphQLObjectType({ name: "Mutation", fields: mutationFields })
        : undefined,
    }),
  };
}

/**
 * Build the `<TypeName>Insert` input. Each field is required iff the column is
 * `notNull` AND has no default AND is not generated — defaults are passed
 * through to the database when the field is omitted at the GraphQL layer.
 */
function buildInsertInput(typeName: string, columns: ColumnMap): GraphQLInputObjectType {
  return new GraphQLInputObjectType({
    name: `${typeName}Insert`,
    fields: () => {
      const fields: GraphQLInputFieldConfigMap = {};
      for (const [name, col] of Object.entries(columns)) {
        const c: any = col;
        const required = c.notNull && !c.hasDefault && !(c as any).generated;
        const base = columnToBaseType(col);
        fields[name] = { type: wrapNonNull(base, required) };
      }
      return fields;
    },
  });
}

/**
 * Build the `<TypeName>Update` input. Every column field is optional so callers
 * can pass partial updates; only provided fields are sent to `db.update().set()`.
 */
function buildUpdateInput(typeName: string, columns: ColumnMap): GraphQLInputObjectType {
  return new GraphQLInputObjectType({
    name: `${typeName}Update`,
    fields: () => {
      const fields: GraphQLInputFieldConfigMap = {};
      for (const [name, col] of Object.entries(columns)) {
        fields[name] = { type: columnToBaseType(col) };
      }
      return fields;
    },
  });
}

/**
 * Lazy fields-thunk used by every per-table {@link GraphQLObjectType}.
 *
 * Emits one field per scalar column (default resolver reads from the source
 * row), then overlays relation fields. A relation field with the same name as
 * a scalar column **replaces** the scalar on the output type (the scalar value
 * is still reachable through `where` / `set` / Insert / Update inputs).
 *
 * Called via the GraphQL `fields: () => ...` thunk so that referenced object
 * types created in the same pass can be referenced before they are fully
 * registered — this is what enables cyclic relation types and recursive
 * traversal.
 */
function buildObjectFields(
  meta: TableMeta,
  intro: ReturnType<typeof introspectSchema>,
  metas: Map<string, TableMeta>,
  db: DrizzleLike,
): GraphQLFieldConfigMap<any, any> {
  const fields: GraphQLFieldConfigMap<any, any> = {};
  for (const [name, col] of Object.entries(meta.columns)) {
    fields[name] = {
      type: wrapNonNull(columnToBaseType(col), (col as any).notNull),
      resolve: (src) => src?.[name],
    };
  }

  const sqlName = getTableName(meta.table);
  const rels = intro.relations.get(sqlName) ?? [];
  for (const rel of rels) {
    const refMeta = metas.get(getTableName(rel.referencedTable));
    if (!refMeta) continue;
    // Relation field replaces a same-named scalar column on the output type.
    // The scalar FK column remains usable in `where` / `set` / Insert / Update inputs
    // because those input types iterate the column map, which is unchanged.
    fields[rel.fieldName] = buildRelationField(rel, meta, refMeta, db);
  }
  return fields;
}

/**
 * Build a relation field config for a parent table.
 *
 * "one" relations resolve to the single referenced row (or `null`); "many"
 * relations resolve to a non-null list and accept their own `where`,
 * `orderBy`, `limit`, `offset` arguments — composable with any conditions
 * implied by the parent row's local key. Both kinds resolve recursively
 * because the field's GraphQL type is the same registered ObjectType used at
 * the root, so nested selections traverse through {@link buildObjectFields}
 * again.
 *
 * Local/foreign columns come from the {@link ExtractedRelation} (explicit
 * `relations(...)` declarations or auto-derived FK/inverse). When a "many"
 * relation has no derived back-side, {@link guessForeignColumns} provides a
 * convention-based fallback (`<singularizedParentKey>Id`).
 */
function buildRelationField(
  rel: ExtractedRelation,
  parentMeta: TableMeta,
  refMeta: TableMeta,
  db: DrizzleLike,
): GraphQLFieldConfig<any, any> {

  const isMany = rel.kind === "many";
  const baseType = isMany
    ? new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(refMeta.objectType)))
    : refMeta.objectType;

  return {
    type: baseType,
    args: isMany
      ? {
          where: { type: refMeta.whereInput },
          orderBy: { type: refMeta.orderByInput },
          limit: { type: GraphQLInt },
          offset: { type: GraphQLInt },
        }
      : undefined,
    resolve: async (parent, args) => {
      const localCols = rel.fields ?? parentMeta.pkColumns;
      const refCols = rel.references ?? guessForeignColumns(parentMeta, refMeta);
      if (!localCols?.length || !refCols?.length) return isMany ? [] : null;

      const conds: SQL[] = [];
      for (let i = 0; i < refCols.length; i++) {
        const localKey = jsKeyOfColumn(parentMeta.columns, localCols[i]);
        if (!localKey) return isMany ? [] : null;
        const v = parent?.[localKey];
        if (v === undefined || v === null) return isMany ? [] : null;
        conds.push(eq(refCols[i], v));
      }

      const where = combineWhere(
        conds.length === 1 ? conds[0] : and(...conds),
        whereToSql(args?.where, refMeta.columns),
      );
      const order = orderByToSql(args?.orderBy, refMeta.columns);

      let q = db.select().from(refMeta.table as any).where(where);
      if (order.length) q = q.orderBy(...order);
      if (args?.limit != null) q = q.limit(args.limit);
      if (args?.offset != null) q = q.offset(args.offset);
      const rows = await q;
      return isMany ? rows : rows[0] ?? null;
    },
  };
}

/** Reverse-lookup the JS key of a Drizzle column inside a {@link ColumnMap}. */
function jsKeyOfColumn(columns: ColumnMap, col: Column): string | undefined {
  for (const [k, c] of Object.entries(columns)) if (c === col) return k;
  return undefined;
}

/**
 * Fallback for "many" relations when the referenced columns aren't known:
 * looks for a `<singularizedParentKey>Id` column on the referenced table
 * (e.g. parent `users` ⇒ `userId`). Returns `undefined` if no convention match.
 */
function guessForeignColumns(parent: TableMeta, ref: TableMeta): Column[] | undefined {
  const candidate = `${singularize(parent.jsKey)}Id`;
  const col = ref.columns[candidate];
  return col ? [col] : undefined;
}

/** Naive English singularizer used only by {@link guessForeignColumns}. */
function singularize(s: string): string {
  if (s.endsWith("ies")) return s.slice(0, -3) + "y";
  if (s.endsWith("s")) return s.slice(0, -1);
  return s;
}

/** AND-combine two optional Drizzle SQL fragments, dropping `undefined`s. */
function combineWhere(a: SQL | undefined, b: SQL | undefined): SQL | undefined {
  if (a && b) return and(a, b);
  return a ?? b;
}

/**
 * Attach the standard CRUD root fields for a table to the Query and Mutation
 * field maps:
 *
 * - `Query.<jsKey>(where?, orderBy?, limit?, offset?): [<Type>!]!`
 * - `Query.<jsKey>Single(where?, orderBy?): <Type>` (returns first match or null)
 * - `Mutation.insertInto<TypeName>(values: [<Type>Insert!]!): [<Type>!]!`
 * - `Mutation.update<TypeName>(set: <Type>Update!, where?): [<Type>!]!`
 * - `Mutation.deleteFrom<TypeName>(where?): [<Type>!]!`
 *
 * All mutation resolvers use Drizzle's `.returning()` so the response contains
 * the affected rows directly.
 */
function addRootFields(
  meta: TableMeta,
  queryFields: GraphQLFieldConfigMap<unknown, unknown>,
  mutationFields: GraphQLFieldConfigMap<unknown, unknown>,
  db: DrizzleLike,
) {
  const listType = new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(meta.objectType)));

  queryFields[meta.jsKey] = {
    type: listType,
    args: {
      where: { type: meta.whereInput },
      orderBy: { type: meta.orderByInput },
      limit: { type: GraphQLInt },
      offset: { type: GraphQLInt },
    },
    resolve: async (_, args) => {
      let q = db.select().from(meta.table).where(whereToSql(args?.where, meta.columns));
      const order = orderByToSql(args?.orderBy, meta.columns);
      if (order.length) q = q.orderBy(...order);
      if (args?.limit != null) q = q.limit(args.limit);
      if (args?.offset != null) q = q.offset(args.offset);
      return q;
    },
  };

  queryFields[`${meta.jsKey}Single`] = {
    type: meta.objectType,
    args: { where: { type: meta.whereInput }, orderBy: { type: meta.orderByInput } },
    resolve: async (_, args) => {
      const order = orderByToSql(args?.orderBy, meta.columns);
      let q = db.select().from(meta.table).where(whereToSql(args?.where, meta.columns)).limit(1);
      if (order.length) q = q.orderBy(...order);
      const rows = await q;
      return rows[0] ?? null;
    },
  };

  mutationFields[`insertInto${meta.typeName}`] = {
    type: listType,
    args: {
      values: {
        type: new GraphQLNonNull(
          new GraphQLList(new GraphQLNonNull(meta.insertInput)),
        ),
      },
    },
    resolve: async (_, args) => {
      const rows = await db.insert(meta.table).values(args.values).returning();
      return rows;
    },
  };

  mutationFields[`update${meta.typeName}`] = {
    type: listType,
    args: {
      set: { type: new GraphQLNonNull(meta.updateInput) },
      where: { type: meta.whereInput },
    },
    resolve: async (_, args) => {
      const rows = await db
        .update(meta.table)
        .set(args.set)
        .where(whereToSql(args?.where, meta.columns))
        .returning();
      return rows;
    },
  };

  mutationFields[`deleteFrom${meta.typeName}`] = {
    type: listType,
    args: { where: { type: meta.whereInput } },
    resolve: async (_, args) => {
      const rows = await db
        .delete(meta.table)
        .where(whereToSql(args?.where, meta.columns))
        .returning();
      return rows;
    },
  };
}
