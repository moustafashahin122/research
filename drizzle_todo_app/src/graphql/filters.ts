/**
 * @module graphql/filters
 *
 * Summary
 * -------
 * Per-table `Where` and `OrderBy` GraphQL input types plus the runtime
 * translators that turn user-supplied input values into Drizzle SQL fragments.
 * Used by both root resolvers (list/single/update/delete) and "many" relation
 * resolvers (which let callers narrow nested lists with the same filter
 * vocabulary).
 *
 * Filter vocabulary
 * -----------------
 * - Per column: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `notIn`, `like`,
 *   `ilike`, `isNull`.
 * - Logical combinators at the top level of `Where`: `AND: [..]`, `OR: [..]`,
 *   `NOT: { .. }`.
 * - Multiple operators on the same column AND together
 *   (e.g. `{ id: { gt: 5, lt: 10 } }`).
 *
 * `OrderBy` is an object with one direction per column:
 * `{ id: DESC, title: ASC }`. Direction values come from the shared
 * `OrderDirection` enum.
 */
import {
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  type GraphQLInputFieldConfigMap,
  type GraphQLInputType,
} from "graphql";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  ne,
  not,
  notInArray,
  or,
  type Column,
  type SQL,
} from "drizzle-orm";
import { columnToBaseType } from "./types.js";

/**
 * Map of GraphQL field name → Drizzle Column for one table.
 *
 * Throughout the builder the GraphQL field name is identical to the Drizzle
 * JS key (the keys in your `sqliteTable("...", { ... })` definition), so
 * resolvers can look up the column directly by the GraphQL field a caller
 * sends in `where` / `orderBy` / `set`.
 */
export interface ColumnMap {
  [gqlField: string]: Column;
}

/**
 * Build the shared `OrderDirection` GraphQL enum (`ASC` / `DESC`).
 *
 * Exported for callers that want to compose their own input types using the
 * same direction vocabulary; the builder caches a single instance internally
 * via {@link orderDirectionEnum}.
 */
export function buildOrderDirectionEnum(): GraphQLEnumType {
  return new GraphQLEnumType({
    name: "OrderDirection",
    values: { ASC: { value: "asc" }, DESC: { value: "desc" } },
  });
}

const orderDirectionEnum = buildOrderDirectionEnum();

/**
 * Build the recursive `<TypeName>Where` input for a table.
 *
 * The input type self-references through its `AND` / `OR` / `NOT` combinators
 * (defined inside the lazy fields-thunk to allow the recursive use). One
 * column-filter sub-input is generated per column via
 * {@link buildColumnFilterInput}.
 *
 * @param tableName GraphQL ObjectType name; used as the prefix for `<...>Where`
 *                  and per-column filter input names.
 * @param columns The table's GraphQL-field → column map.
 */
export function buildWhereInput(tableName: string, columns: ColumnMap): GraphQLInputObjectType {
  const self: GraphQLInputObjectType = new GraphQLInputObjectType({
    name: `${tableName}Where`,
    fields: () => {
      const fields: GraphQLInputFieldConfigMap = {
        AND: { type: new GraphQLList(new GraphQLNonNull(self)) },
        OR: { type: new GraphQLList(new GraphQLNonNull(self)) },
        NOT: { type: self },
      };
      for (const [name, col] of Object.entries(columns)) {
        fields[name] = { type: buildColumnFilterInput(tableName, name, col) };
      }
      return fields;
    },
  });
  return self;
}

/**
 * Build a per-column `<TableName>_<fieldName>_Filter` input exposing the
 * standard operator set. All operator fields are optional; multiple operators
 * on the same column are AND-combined by {@link whereToSql}.
 */
function buildColumnFilterInput(
  tableName: string,
  fieldName: string,
  col: Column,
): GraphQLInputObjectType {
  const base = columnToBaseType(col) as GraphQLInputType;
  return new GraphQLInputObjectType({
    name: `${tableName}_${fieldName}_Filter`,
    fields: {
      eq: { type: base },
      ne: { type: base },
      gt: { type: base },
      gte: { type: base },
      lt: { type: base },
      lte: { type: base },
      in: { type: new GraphQLList(new GraphQLNonNull(base)) },
      notIn: { type: new GraphQLList(new GraphQLNonNull(base)) },
      like: { type: base },
      ilike: { type: base },
      isNull: { type: GraphQLBoolean },
    },
  });
}

/**
 * Build the `<TypeName>OrderBy` input — one optional field per column whose
 * value is an {@link orderDirectionEnum} (`ASC` / `DESC`). Unspecified columns
 * are not added to the SQL ORDER BY clause.
 */
export function buildOrderByInput(tableName: string, columns: ColumnMap): GraphQLInputObjectType {
  return new GraphQLInputObjectType({
    name: `${tableName}OrderBy`,
    fields: () => {
      const fields: GraphQLInputFieldConfigMap = {};
      for (const name of Object.keys(columns)) {
        fields[name] = { type: orderDirectionEnum };
      }
      return fields;
    },
  });
}

/**
 * Translate a runtime `Where` input value into a Drizzle SQL condition.
 *
 * Rules:
 * - `null` / `undefined` input → no condition (`undefined` returned).
 * - Top-level `AND`/`OR` arrays recurse, dropping empty/`undefined` sub-results.
 * - Top-level `NOT` recurses and wraps with `not(...)`.
 * - Per-column entries iterate operator keys and append one SQL fragment per
 *   operator (multiple operators on the same column AND together).
 * - Unknown column keys are ignored — clients can't synthesize columns that
 *   weren't declared on the table.
 *
 * @param where The user-supplied input from `args.where`.
 * @param columns The table's GraphQL-field → column map, used to look up the
 *                Drizzle Column for each filter key.
 * @returns A single SQL fragment (multiple parts AND-combined) or `undefined`
 *          when no usable conditions were supplied.
 *
 * @example
 * whereToSql({ title: { ilike: "%buy%" }, completed: { eq: false } }, todoCols);
 * // → and(ilike(todos.title, "%buy%"), eq(todos.completed, false))
 */
export function whereToSql(
  where: Record<string, any> | null | undefined,
  columns: ColumnMap,
): SQL | undefined {
  if (!where) return undefined;
  const parts: SQL[] = [];
  for (const [key, val] of Object.entries(where)) {
    if (val == null) continue;
    if (key === "AND") {
      const inner = (val as any[]).map((w) => whereToSql(w, columns)).filter(Boolean) as SQL[];
      if (inner.length) parts.push(and(...inner)!);
      continue;
    }
    if (key === "OR") {
      const inner = (val as any[]).map((w) => whereToSql(w, columns)).filter(Boolean) as SQL[];
      if (inner.length) parts.push(or(...inner)!);
      continue;
    }
    if (key === "NOT") {
      const inner = whereToSql(val, columns);
      if (inner) parts.push(not(inner));
      continue;
    }
    const col = columns[key];
    if (!col) continue;
    for (const [op, opVal] of Object.entries(val)) {
      if (opVal === undefined || opVal === null) continue;
      switch (op) {
        case "eq": parts.push(eq(col, opVal as any)); break;
        case "ne": parts.push(ne(col, opVal as any)); break;
        case "gt": parts.push(gt(col, opVal as any)); break;
        case "gte": parts.push(gte(col, opVal as any)); break;
        case "lt": parts.push(lt(col, opVal as any)); break;
        case "lte": parts.push(lte(col, opVal as any)); break;
        case "in": parts.push(inArray(col, opVal as any[])); break;
        case "notIn": parts.push(notInArray(col, opVal as any[])); break;
        case "like": parts.push(like(col, opVal as any)); break;
        case "ilike": parts.push(ilike(col, opVal as any)); break;
        case "isNull": parts.push((opVal ? isNull : isNotNull)(col)); break;
      }
    }
  }
  if (!parts.length) return undefined;
  return parts.length === 1 ? parts[0] : and(...parts);
}

/**
 * Translate an `OrderBy` input into an ordered list of Drizzle `asc()` /
 * `desc()` fragments.
 *
 * Iteration order follows the keys as provided by the GraphQL client —
 * callers can specify a multi-column ordering by listing the fields in the
 * desired precedence (e.g. `{ priority: DESC, id: ASC }`).
 *
 * @param orderBy Map of column name → `"asc" | "desc"` (the {@link
 *                buildOrderDirectionEnum} resolves the GraphQL enum to these
 *                lowercase strings).
 * @param columns The table's GraphQL-field → column map.
 * @returns Array of SQL ORDER BY fragments; pass via spread to Drizzle's
 *          `.orderBy(...)`.
 */
export function orderByToSql(
  orderBy: Record<string, "asc" | "desc"> | null | undefined,
  columns: ColumnMap,
): SQL[] {
  if (!orderBy) return [];
  const out: SQL[] = [];
  for (const [k, dir] of Object.entries(orderBy)) {
    const col = columns[k];
    if (!col) continue;
    out.push(dir === "desc" ? desc(col) : asc(col));
  }
  return out;
}

/**
 * @internal
 * Re-exported placeholder kept for incremental refactors (the builder uses
 * `GraphQLInt` directly for `limit`/`offset`); not part of the public API.
 */
export const queryArgsType = { GraphQLInt };
