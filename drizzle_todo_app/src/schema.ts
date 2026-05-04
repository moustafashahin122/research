import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
// user table
// assignee table
export const assignees = sqliteTable("assignees", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
export type Assignee = typeof assignees.$inferSelect;
export type NewAssignee = typeof assignees.$inferInsert;

export const todos = sqliteTable("todos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  completed: integer("completed", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  assigneeId: integer("assignee_id").references(() => assignees.id),
});

export type Todo = typeof todos.$inferSelect;
export type NewTodo = typeof todos.$inferInsert;
