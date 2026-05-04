# Top 10 Backend Frameworks with PostgreSQL: ORMs and RBAC Comparison

*Research compiled: 2026-05-03*

This document compares the ten most-used backend web frameworks that pair well with PostgreSQL, their dominant ORMs, and how each approaches Role-Based Access Control (RBAC). Selection is based on the 2025 Stack Overflow Developer Survey, State of JS 2025, JetBrains Developer Ecosystem 2025, and current GitHub adoption metrics.

---

## 1. Executive Summary Table

| # | Framework | Language | Primary ORM(s) | Built-in Auth/RBAC | Common RBAC Library | Postgres RLS Friendly |
|---|-----------|----------|----------------|--------------------|---------------------|-----------------------|
| 1 | **Express.js** | Node.js | Sequelize, Prisma, Drizzle, TypeORM | None | `accesscontrol`, `casbin`, custom middleware | Manual (via `SET LOCAL`) |
| 2 | **NestJS** | TypeScript | TypeORM, Prisma, MikroORM | Guards (auth primitive only) | `@casl/ability`, `@casl/prisma`, `nest-casl` | Via Prisma middleware / interceptors |
| 3 | **Django** | Python | Django ORM | Yes — Users, Groups, Permissions | `django-guardian`, `django-rules`, `django-rbac`, `django-rls` | Excellent — `django-rls`, raw SQL hooks |
| 4 | **FastAPI** | Python | SQLAlchemy 2.x, SQLModel, Tortoise | None | `fastapi-permissions`, `casbin`, dependency-injection patterns | Manual via SQLAlchemy `event` hooks |
| 5 | **Flask** | Python | SQLAlchemy (Flask-SQLAlchemy) | None | `Flask-Security-Too`, `Flask-Principal`, `Flask-RBAC`, `Flask-Authorize` | `flask-sqlalchemy-rls` |
| 6 | **Spring Boot** | Java/Kotlin | Hibernate (JPA), jOOQ, Spring Data JDBC | Yes — Spring Security | Spring Security `@PreAuthorize`, ACL module, Keycloak | Via Hibernate filters or custom interceptors |
| 7 | **ASP.NET Core** | C# | Entity Framework Core (Npgsql) | Yes — ASP.NET Identity | Policy-based authorization, `IAuthorizationHandler` | EF Core query filters; manual RLS |
| 8 | **Ruby on Rails** | Ruby | ActiveRecord | Devise (auth) | Pundit, CanCanCan, Action Policy | `activerecord-tenant-row-level-security` |
| 9 | **Laravel** | PHP | Eloquent | Gates & Policies (built-in) | `spatie/laravel-permission`, `bouncer`, `laratrust` | Manual; Gates + global scopes |
| 10 | **Phoenix** | Elixir | Ecto | None (Pow / phx.gen.auth for auth) | `Bodyguard`, `Permit`, `Canary`, `LetMe` | Via Ecto multi-tenant + RLS |

> Honorable mentions outside the top 10: **Go (Gin / Echo / Fiber + GORM + Casbin)**, **Hono**, **Actix/Axum (Rust + SeaORM/Diesel)**. Go is included as a deep-dive at the end since its usage rivals several entries above in cloud-native contexts.

---

## 2. Selection Methodology

The list reflects the intersection of:

- **Stack Overflow 2025 Developer Survey** — Express, ASP.NET Core, Spring Boot, Django, FastAPI, NestJS, Flask, and Laravel all rank in the top "Web Frameworks and Technologies" used professionally.
- **State of JS 2025** — Express dominates Node usage; NestJS leads in enterprise satisfaction and growth.
- **JetBrains Developer Ecosystem 2025** — Django and FastAPI lead Python web; Spring Boot leads JVM.
- **PostgreSQL Compatibility** — every framework on this list has a first-class Postgres adapter (psycopg, Npgsql, pg, postgrex, JDBC Postgres, etc.) and an ORM that supports JSONB, arrays, and `LISTEN/NOTIFY` either natively or through escape hatches.

---

## 3. Per-Framework Deep Dives

### 3.1 Express.js (Node.js)

- **Latest:** Express 5.x (released 2024, mainstream by 2026).
- **ORMs:** Sequelize (mature), **Prisma** (most popular in 2026 surveys), Drizzle (rising — type-safe SQL builder), TypeORM, Knex.js.
- **Postgres features:** Prisma supports JSONB, arrays, `Citext`, full-text search, `LISTEN/NOTIFY` via raw queries, multi-schema, and row-level security through `$extends` middleware. Drizzle exposes Postgres-specific column types directly.
- **Migrations:** Prisma Migrate, Sequelize CLI, Drizzle Kit, Knex migrations.
- **RBAC approach:** Express ships **no auth or authz primitives**. Patterns:
  - **Custom role-checking middleware** — most common: `function requireRole(role) { return (req,res,next) => req.user.role===role ? next() : res.sendStatus(403); }`.
  - **`accesscontrol`** npm package — declarative `grant`/`deny` with attribute-level filtering.
  - **`node-casbin`** with `casbin-pg-adapter` — supports RBAC, ABAC, ACL models; policies stored in Postgres `casbin_rule` table; rules editable at runtime.
- **Postgres RLS integration:** manual; typical pattern is connection-scoped `SET LOCAL app.current_user_id = ...` inside an Express middleware before delegating to the ORM.
- **Example:**
  ```js
  app.get('/admin', auth, requireRole('admin'), handler);
  // or with Casbin
  const enforcer = await casbin.newEnforcer('rbac_model.conf', adapter);
  app.use(async (req,res,next) => {
    const ok = await enforcer.enforce(req.user.id, req.path, req.method);
    ok ? next() : res.sendStatus(403);
  });
  ```

### 3.2 NestJS (TypeScript)

- **Latest:** NestJS 11 (2025/2026).
- **ORMs:** **Prisma** is the most popular pairing in 2026; TypeORM (legacy default), MikroORM (gaining ground for DDD/Unit-of-Work), Drizzle.
- **Postgres features:** Through Prisma — JSONB, arrays, full-text search, `pg_trgm`, multi-schema, `pgvector` (via preview). MikroORM adds rich Postgres-specific identity-map handling.
- **Migrations:** Prisma Migrate, TypeORM `migration:generate`, MikroORM CLI.
- **RBAC approach:** NestJS provides **Guards** as the primitive. Real RBAC is built on top:
  - **`@Roles()` decorator + `RolesGuard`** — the official docs pattern; metadata read with `Reflector`.
  - **`@casl/ability` + `@casl/prisma`** — by far the most popular declarative library; `defineAbilitiesFor(user)` returns an `Ability` instance; `accessibleBy(ability).Post` translates rules into a Prisma `where` clause for **query-level enforcement** (the row-level security pattern without DB RLS).
  - **`nest-casl`**, **`nest-access-control`** — wrapper modules.
- **Postgres RLS integration:** rarely native; CASL-on-Prisma effectively implements row scoping at the application layer. For true DB RLS, use Prisma `$extends` to inject `SET LOCAL` per request.
- **Example:**
  ```ts
  @UseGuards(JwtAuthGuard, AbilitiesGuard)
  @CheckAbilities({ action: Action.Update, subject: 'Post' })
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdatePostDto) { ... }
  ```

### 3.3 Django (Python)

- **Latest:** Django 5.2 LTS (2025/2026).
- **ORM:** Django ORM (built-in). Alternatives sometimes layered: SQLAlchemy via `django-sqlalchemy`, but rare.
- **Postgres features:** **Best-in-class first-party Postgres support.** `django.contrib.postgres` provides `JSONField`, `ArrayField`, `HStoreField`, `RangeField`, `SearchVector`/`SearchQuery` for full-text search, trigram similarity, `unaccent`, `BRIN` indexes, generated columns (5.x), composite primary keys (5.2), and Postgres-specific constraints.
- **Migrations:** Built-in `makemigrations`/`migrate`; supports `RunSQL`, `RunPython`, RLS policies via raw migrations.
- **RBAC approach:** **Most batteries-included of any framework.**
  - **Built-in `auth` system** — `User`, `Group`, `Permission` tables created out of the box. `user.has_perm('app.change_post')`, `@permission_required`, `PermissionRequiredMixin` for class-based views.
  - **`django-guardian`** — adds object-level (per-row) permissions stored in a generic table.
  - **`django-rules`** — predicate-based, rule objects composed with `&`, `|`, `~`; integrates with the standard permission API. No DB tables needed.
  - **`django-rbac`** / **`django-prbac`** — parameterized RBAC with role hierarchies.
  - **`django-rls`** — modern (2025+) library that maps Django models to Postgres RLS policies and sets session GUCs automatically per request.
- **Postgres RLS integration:** **Excellent.** `django-rls` declares policies directly on models; the request middleware sets `SET LOCAL app.user_id = ...`. Multi-tenant SaaS often pairs Django + RLS for defense-in-depth.
- **Example:**
  ```python
  from django.contrib.auth.decorators import permission_required
  @permission_required('blog.change_post', raise_exception=True)
  def edit(request, pk): ...

  # Object-level with django-rules
  @rules.predicate
  def is_author(user, post): return post.author == user
  rules.add_perm('blog.change_post', is_author | is_admin)
  ```

### 3.4 FastAPI (Python)

- **Latest:** FastAPI 0.115+ (Pydantic v2 era, async-first).
- **ORMs:** **SQLAlchemy 2.x** (async, the de facto choice), **SQLModel** (Tiangolo's own; SQLAlchemy + Pydantic), Tortoise ORM, Piccolo.
- **Postgres features:** SQLAlchemy 2.x supports JSONB, arrays, `pgvector` (via `pgvector-python`), full-text search, async `asyncpg` driver, server-side cursors. Alembic for migrations.
- **Migrations:** **Alembic** (industry standard for SQLAlchemy projects).
- **RBAC approach:** No built-in authz; idiomatic pattern is **dependency injection**.
  - **Custom `Depends()` chains** — `current_user: User = Depends(get_current_user)`, then `require_role("admin")` returning a dependency.
  - **`fastapi-permissions`** — ACL-style; resources declare `__acl__`, dependency raises `403`.
  - **`casbin`** Python binding with `casbin-sqlalchemy-adapter` for Postgres-backed dynamic policies.
  - **External authorization** is increasingly common: Auth0 FGA, Permit.io, Cerbos PDP, OPA — invoked from a FastAPI dependency.
- **Postgres RLS integration:** Strong patterns published; SQLAlchemy `event.listens_for(engine, "checkout")` sets the session GUC; Alembic migration installs `CREATE POLICY`. Used heavily for multi-tenant SaaS.
- **Example:**
  ```python
  def require_role(role: str):
      def dep(user: User = Depends(get_current_user)):
          if role not in user.roles:
              raise HTTPException(403)
          return user
      return dep

  @router.delete("/posts/{id}")
  def delete(id: int, user: User = Depends(require_role("admin"))): ...
  ```

### 3.5 Flask (Python)

- **Latest:** Flask 3.x.
- **ORMs:** **Flask-SQLAlchemy** (wrapping SQLAlchemy), Peewee, MongoEngine (NoSQL).
- **Postgres features:** Inherits SQLAlchemy's full Postgres support — JSONB, arrays, RLS, full-text. `psycopg3` is the modern driver.
- **Migrations:** **Alembic** via `Flask-Migrate`.
- **RBAC approach:** No built-in authz; rich ecosystem of small libraries.
  - **Flask-Security-Too** — the maintained successor to Flask-Security; ships User/Role models, `@roles_required('admin')`, `@roles_accepted('a','b')`, `@permissions_required`. Uses `SQLAlchemyUserDatastore`.
  - **Flask-Principal** — identity/permission/need pattern; signal-based.
  - **Flask-RBAC** — declarative role hierarchies attached to models.
  - **Flask-Authorize** — combines RBAC + group/owner/world Unix-style permissions per record.
  - **`oso`** (cross-language) — popular for fine-grained policies.
- **Postgres RLS integration:** `flask-sqlalchemy-rls` is the dedicated library; ties RLS policies to `current_user`.
- **Example:**
  ```python
  from flask_security import roles_required
  @app.route('/admin')
  @roles_required('admin')
  def admin(): ...
  ```

### 3.6 Spring Boot (Java / Kotlin)

- **Latest:** Spring Boot 3.4 (2025/2026), Spring Security 6.x, Java 21 LTS.
- **ORMs:** **Hibernate (JPA)** is the default; **Spring Data JPA** as the repository abstraction. **jOOQ** for SQL-first; **Spring Data JDBC** for simpler aggregates.
- **Postgres features:** Hibernate dialect supports JSONB (`@JdbcTypeCode(SqlTypes.JSON)`), arrays, `Hypersistence Utils` library is the standard add-on for `JsonbType`, `IntArrayType`, ranges, hstore. PgJDBC driver supports `LISTEN/NOTIFY`, COPY, logical replication.
- **Migrations:** **Flyway** or **Liquibase** (both first-class in Spring Boot autoconfig).
- **RBAC approach:** **Spring Security is the gold standard for JVM authz.**
  - **Built-in `Role`/`Authority` model** — `GrantedAuthority`, `hasRole('ADMIN')`, `hasAuthority('SCOPE_read')`.
  - **Method security** — `@EnableMethodSecurity` + `@PreAuthorize("hasRole('ADMIN') and #post.owner == authentication.name")`. SpEL gives ABAC-like power.
  - **HTTP filter chain** — `http.authorizeHttpRequests(a -> a.requestMatchers("/admin/**").hasRole("ADMIN"))`.
  - **Spring Security ACL module** — domain-object / row-level permissions stored in 4 ACL tables.
  - **External:** Keycloak, Okta, Auth0, OPA via `spring-cloud-security`.
- **Postgres RLS integration:** Hibernate `@Filter` provides app-level row scoping; for true DB RLS, intercept connection acquisition (`AbstractDataSourceBasedMultiTenantConnectionProviderImpl`) to set `SET app.user_id`.
- **Example:**
  ```java
  @PreAuthorize("hasRole('ADMIN') or #post.author == authentication.name")
  @PutMapping("/posts/{id}")
  public Post update(@PathVariable Long id, @P("post") @RequestBody Post post) { ... }
  ```

### 3.7 ASP.NET Core (C#)

- **Latest:** ASP.NET Core 10 (.NET 10, 2025 release).
- **ORM:** **Entity Framework Core 10** with **Npgsql.EntityFrameworkCore.PostgreSQL**. Dapper is a popular micro-ORM alternative.
- **Postgres features:** Npgsql provides native JSONB (mapped to `JsonDocument` or POCOs), arrays (`int[]`, `string[]`), ranges, `tstzrange`, `hstore`, `LTree`, full-text search (`EF.Functions.ToTsVector`), `pgvector`, and `LISTEN/NOTIFY` via raw connection.
- **Migrations:** EF Core Migrations (`dotnet ef migrations add`).
- **RBAC approach:**
  - **ASP.NET Identity** — built-in `IdentityUser`, `IdentityRole`, claims; works with EF Core + Postgres.
  - **`[Authorize(Roles = "Admin")]`** — simple roles attribute.
  - **Policy-based authorization** (preferred modern pattern) — `services.AddAuthorization(o => o.AddPolicy("CanEditPost", p => p.RequireRole("Editor").RequireClaim("dept","content")))`. Policies combine roles, claims, and custom `IAuthorizationRequirement` + `AuthorizationHandler<T>` for ABAC and resource-based checks (`authorizationService.AuthorizeAsync(user, post, "EditPost")`).
  - **External:** OpenIddict, IdentityServer (Duende), Keycloak.
- **Postgres RLS integration:** EF Core **global query filters** give app-level row scoping (`modelBuilder.Entity<Post>().HasQueryFilter(p => p.TenantId == _tenantId)`). For DB RLS, hook `DbConnection.StateChange` to issue `SET LOCAL`.
- **Example:**
  ```csharp
  [Authorize(Policy = "CanEditPost")]
  [HttpPut("posts/{id}")]
  public async Task<IActionResult> Update(int id, Post post) {
      var ok = await _authz.AuthorizeAsync(User, post, "EditPost");
      if (!ok.Succeeded) return Forbid();
      ...
  }
  ```

### 3.8 Ruby on Rails

- **Latest:** Rails 8.0 (Nov 2024); Rails 8.1 in 2026.
- **ORM:** **ActiveRecord** (built-in). Sequel is an alternative.
- **Postgres features:** ActiveRecord is exceptionally well-integrated with Postgres — JSONB, arrays, ranges, hstore, citext, UUIDs (now default in Rails 8 generators), full-text search via `pg_search` gem, materialized views via `scenic`, structure.sql, deferrable FKs, generated columns, virtual columns.
- **Migrations:** Built-in DSL; `rails db:migrate`. Strong RLS support via `activerecord-tenant-row-level-security`.
- **RBAC approach:** **Devise** for auth; choice of authz gem:
  - **Pundit** — policy classes per resource (`PostPolicy#update?`); `authorize @post`; **policy scopes** (`Pundit.policy_scope(user, Post)`) translate authz into ActiveRecord scopes — the standard way to implement row-level filtering at the query layer.
  - **CanCanCan** — single `Ability` class enumerating rules with `can :update, Post, user_id: user.id`. Conditions are translated into `WHERE` clauses for `accessible_by(current_ability)`.
  - **Action Policy** — modern, Pundit-like with pre-checks, caching, and namespaces; gaining adoption in 2025/2026.
  - **`pundit_rbac`** — adds explicit Role/Permission tables on top of Pundit.
- **Postgres RLS integration:** `activerecord-tenant-row-level-security` and Citus's tooling; pattern is per-request `SET LOCAL` in an `around_action`.
- **Example:**
  ```ruby
  # app/policies/post_policy.rb
  class PostPolicy < ApplicationPolicy
    def update? = user.admin? || record.author_id == user.id
    class Scope < Scope
      def resolve
        user.admin? ? scope.all : scope.where(author: user)
      end
    end
  end
  # controller
  def update; authorize @post; @post.update!(post_params); end
  ```

### 3.9 Laravel (PHP)

- **Latest:** Laravel 11 (2024) / Laravel 12 (Feb 2025).
- **ORM:** **Eloquent** (built-in ActiveRecord-style). Query Builder + raw for SQL-first work.
- **Postgres features:** Eloquent supports JSONB columns with `->>` arrow accessors, array casts, full-text indexes via Laravel Scout (with `pgsql` driver), schema builder for ranges and `gin`/`gist` indexes. Migrations via `artisan make:migration`.
- **Migrations:** Built-in; supports raw SQL for RLS policies.
- **RBAC approach:** Laravel ships **Gates and Policies** out of the box.
  - **Gates** — closures registered in `AuthServiceProvider`: `Gate::define('edit-post', fn(User $u, Post $p) => $u->id === $p->user_id)`. Check with `$user->can('edit-post', $post)` or `@can` Blade directive.
  - **Policies** — class per model: `PostPolicy@update`. Auto-discovered, integrates with `authorize('update', $post)` in controllers.
  - **`spatie/laravel-permission`** — by far the dominant package. Adds `HasRoles`/`HasPermissions` traits; tables `roles`, `permissions`, `model_has_roles`, `model_has_permissions`, `role_has_permissions`. Supports multiple guards, teams (multi-tenant), wildcard permissions. `@role`, `@can`, `$user->hasRole('admin')`, `$user->givePermissionTo('edit articles')`.
  - **`silber/bouncer`** — alternative; capability-based with eloquent-friendly API.
  - **`santigarcor/laratrust`** — RBAC + teams.
- **Postgres RLS integration:** Manual; usually combined with Eloquent global scopes for tenant_id, plus optional Postgres RLS policies set via raw migrations; session var bound in middleware via `DB::statement("SET app.user_id = ?", [auth()->id()])`.
- **Example:**
  ```php
  // With spatie/laravel-permission
  Route::put('/posts/{post}', [PostController::class,'update'])
      ->middleware('permission:edit posts');

  // Or with built-in policy
  public function update(Request $r, Post $post) {
      $this->authorize('update', $post);
      $post->update($r->validated());
  }
  ```

### 3.10 Phoenix (Elixir)

- **Latest:** Phoenix 1.8 (2025/2026).
- **ORM:** **Ecto** (the standard data-mapper-style toolkit; not strict ORM but the equivalent layer). Postgres adapter is the default.
- **Postgres features:** Ecto handles JSONB (`:map` type), arrays, custom types, `Ecto.Multi` for atomic transactions, `Ecto.Adapters.SQL.query!` for raw SQL, full-text search via fragments, `LISTEN/NOTIFY` via Postgrex notifications, prepared statements by default, and excellent connection pooling (DBConnection).
- **Migrations:** `mix ecto.gen.migration`; supports raw SQL for RLS policies and custom types.
- **RBAC approach:** No built-in RBAC; established libraries:
  - **Bodyguard** — `Policy` behaviour with `authorize/3` callback per context; `Bodyguard.Schema` integrates with Ecto query scopes (`scope/3` filters queries by user permissions).
  - **Permit** — newer (2024+), inspired by CanCanCan; ships as `permit`, `permit_ecto` (rule → Ecto query translation), `permit_phoenix` (LiveView/controller hooks). Best fit for Phoenix LiveView apps.
  - **Canada / Canary** — older but still used; `Canada.Can` protocol implementation.
  - **LetMe** — declarative DSL with policy modules.
- **Postgres RLS integration:** Phoenix multi-tenancy pattern combines Ecto's `:prefix` (Postgres schema-per-tenant) with optional RLS policies; session GUCs set inside `Ecto.Multi` or `Repo.checkout`.
- **Example:**
  ```elixir
  defmodule MyApp.Blog.Policy do
    @behaviour Bodyguard.Policy
    def authorize(:update_post, %User{role: :admin}, _), do: true
    def authorize(:update_post, %User{id: id}, %Post{author_id: id}), do: true
    def authorize(_, _, _), do: false
  end
  # in controller
  with :ok <- Bodyguard.permit(Blog.Policy, :update_post, current_user, post) do
    Blog.update_post(post, params)
  end
  ```

---

## 4. Honorable Mention: Go (Gin / Echo / Fiber)

Go web frameworks belong on any 2026 backend list, particularly for cloud-native and microservice work.

- **Frameworks:** Gin, Echo, Fiber, Chi; standard library `net/http` increasingly competitive after Go 1.22 routing.
- **ORM:** **GORM** is dominant; **sqlc** (compile-time SQL → Go code) is the modern alternative; Ent (Facebook), Bun, SQLBoiler.
- **Postgres features:** `pgx` is the high-performance driver; supports JSONB, arrays, `LISTEN/NOTIFY`, COPY, prepared statements, Postgres-specific types via custom scanners. GORM works through `pgx` or `lib/pq`.
- **RBAC:** **Casbin** is the de facto authorization engine for Go — RBAC, ABAC, ACL, RESTful patterns; `gorm-adapter` persists policies to Postgres in a `casbin_rule` table; runtime policy reload supported. Common scaffolds: `gin-admin`, `go-admin`.

```go
e, _ := casbin.NewEnforcer("rbac_model.conf", gormadapter.NewAdapterByDB(db))
r.Use(func(c *gin.Context) {
    user := c.GetString("user")
    if ok, _ := e.Enforce(user, c.Request.URL.Path, c.Request.Method); !ok {
        c.AbortWithStatus(403); return
    }
    c.Next()
})
```

---

## 5. Comparative Analysis

### 5.1 RBAC Maturity (out of the box)

| Tier | Frameworks | Notes |
|------|-----------|-------|
| **Best built-in** | Django, Spring Boot, ASP.NET Core, Laravel | Ship with role/permission models, decorators/attributes/annotations, and integrate cleanly with their ORM. |
| **Strong ecosystem, no built-in** | Rails (with Devise+Pundit), NestJS (with CASL), Flask (with Flask-Security-Too) | Idiomatic pattern is well-known; minimal glue. |
| **DIY with mature libraries** | FastAPI, Express, Phoenix, Go | Flexible but each team picks its own stack; less convention. |

### 5.2 Row-Level Authorization Approaches

Three architectural strategies appear across the ecosystem:

1. **Database-enforced (Postgres RLS)** — strongest defense-in-depth; bypass-proof. Best support: Django (`django-rls`), Rails (RLS gems), FastAPI/Flask (SQLAlchemy hooks). Spring Boot and ASP.NET need custom connection interceptors.
2. **ORM query-rewriting** — CASL (NestJS/Express + Prisma), Pundit Scopes (Rails), Bodyguard Schema scope (Phoenix), EF Core global query filters (.NET), Hibernate `@Filter` (Spring). Permissions translated into `WHERE` clauses.
3. **Application predicate checks** — `@PreAuthorize` (Spring), Policies (Laravel/Rails), `authorize` in Bodyguard. Best for action-level decisions but does not filter list queries.

Production multi-tenant SaaS typically combines (1) for safety + (2) for ergonomics.

### 5.3 ABAC / Fine-Grained Capabilities

| Approach | Frameworks |
|----------|-----------|
| Native attribute/expression in policy | Spring Boot (SpEL), ASP.NET Core (handlers), Laravel Gates closures |
| Library-driven | CASL (Node), oso (cross-lang), Casbin (Node/Go/Python/Java), Cerbos, OPA |
| External PDP (modern trend) | Auth0 FGA, Permit.io, Cerbos PDP, Topaz/Aserto, OpenFGA |

The 2026 trend is clear: large multi-tenant SaaS apps are extracting authorization to **external policy decision points (OpenFGA / Cerbos / Permit)** so the same rules apply across multiple services — regardless of framework.

### 5.4 PostgreSQL Feature Coverage by ORM

| ORM | JSONB | Arrays | Full-text | RLS friendly | LISTEN/NOTIFY |
|-----|:-----:|:------:|:---------:|:------------:|:-------------:|
| Django ORM | ✅ native | ✅ native | ✅ `SearchVector` | ✅ excellent | ⚠ raw |
| SQLAlchemy 2.x | ✅ native | ✅ native | ✅ via `func.to_tsvector` | ✅ via events | ✅ asyncpg |
| ActiveRecord | ✅ native | ✅ native | ✅ via `pg_search` gem | ✅ via gems | ⚠ raw |
| Eloquent | ✅ via casts | ⚠ casts | ⚠ Scout/raw | ⚠ manual | ⚠ raw |
| Hibernate/JPA | ✅ via Hypersistence | ✅ via Hypersistence | ⚠ native query | ⚠ via filters | ⚠ raw via JDBC |
| EF Core (Npgsql) | ✅ native | ✅ native | ✅ `EF.Functions` | ⚠ query filters | ⚠ raw |
| Prisma | ✅ native | ✅ native | ✅ preview | ⚠ via `$extends` | ❌ (raw) |
| TypeORM | ✅ native | ✅ native | ⚠ raw | ⚠ subscribers | ⚠ raw |
| Drizzle | ✅ native | ✅ native | ✅ helpers | ✅ session API | ✅ `pg` driver |
| Ecto | ✅ native | ✅ native | ⚠ fragments | ✅ via prefix/RLS | ✅ Postgrex |
| GORM | ✅ via tags | ✅ via custom | ⚠ raw | ⚠ manual | ⚠ pgx raw |

### 5.5 Strengths & Weaknesses for RBAC

| Framework | Strengths | Weaknesses |
|-----------|-----------|-----------|
| **Django** | Most batteries-included; object-level via `django-guardian`; best Postgres RLS story (`django-rls`); admin UI for role management | Sync ORM (async support is partial); permissions tied to model meta — refactors are noisy |
| **Spring Boot** | SpEL in `@PreAuthorize` is extremely expressive; mature ACL module; Keycloak/OAuth2 integration is best-in-class | Heavyweight; permission tables not opinionated; ACL module has steep learning curve |
| **ASP.NET Core** | Cleanest policy abstraction (`AuthorizationHandler<T,Resource>`); resource-based authz is first-class | Identity tables verbose; multi-tenant RLS requires custom connection interceptor |
| **Laravel** | Spatie permission is delightful; gates+policies cover 80% of needs without packages | No native object-level; multi-tenant requires careful global scopes |
| **Rails** | Pundit + scopes pattern is elegant; Action Policy adds caching & namespaces; great Postgres integration | Authorization is gem choice — fragmentation across projects |
| **NestJS** | CASL-on-Prisma gives unified rule definition + query filter; testable Guards | Required setup is non-trivial; CASL learning curve |
| **FastAPI** | Dependency injection makes per-route authz trivial; great for external PDPs | No conventions; team reinvents middleware each project |
| **Express** | Maximum flexibility; works with any authz library | Easy to ship insecure code; no opinionated defaults |
| **Flask** | Many small libraries to choose from; Flask-Security-Too is solid | Library fragmentation; some packages unmaintained |
| **Phoenix** | Functional pattern fits authorization well; Permit + LiveView is excellent for real-time apps | Smaller ecosystem; fewer drop-in solutions |
| **Go (Gin/Echo)** | Casbin is mature, language-agnostic, supports many models; great for microservices | Verbose; manual wiring; no convention for permissions UI |

---

## 6. Recommendations by Use Case

### Small REST API / Internal tool
- **Django** if Python team — `django.contrib.auth` + admin + ORM gets you to production fastest.
- **Laravel** if PHP team — Gates + Spatie covers most needs immediately.
- **Rails** if Ruby team — Devise + Pundit, scaffold-driven.

### Enterprise application (regulated, audited)
- **Spring Boot + Spring Security + Keycloak + Postgres RLS** — strongest auditing, OAuth2/OIDC, and JVM ecosystem.
- **ASP.NET Core + Identity + Policy authorization** — equivalent strength on .NET; superb tooling and Azure AD integration.

### Multi-tenant SaaS (strict tenant isolation required)
- **Django + `django-rls` + Postgres RLS** — best out-of-box story; tenant guard is at the database level.
- **FastAPI + SQLAlchemy + Alembic + Postgres RLS** — preferred when async and OpenAPI are priorities.
- **NestJS + Prisma + CASL + Postgres RLS via `$extends`** — best DX in the TypeScript world; CASL doubles as query filter.

### High-throughput microservices
- **Go (Gin/Echo) + sqlc + Casbin** with policies in a shared Postgres or Redis adapter.
- **NestJS + Prisma + external PDP (Cerbos/OpenFGA)** for polyglot environments.

### Real-time / collaborative applications
- **Phoenix + LiveView + Permit + Ecto** — authorization integrates naturally with LiveView mounts and event handlers; pairs well with Postgres `LISTEN/NOTIFY`.

### Fine-grained / Google-Zanzibar-style authorization
- Any framework + **OpenFGA**, **Auth0 FGA**, **SpiceDB**, or **Cerbos** as a separate service. Framework choice matters less than the PDP.

---

## 7. Sources

- [Stack Overflow Developer Survey 2025 – Most popular technologies](https://survey.stackoverflow.co/2025/developers/)
- [State of JS / Best backend frameworks 2026](https://www.quartzdevs.com/resources/best-backend-frameworks-2026-top-server-side-tools)
- [12 Best Backend Frameworks 2026 – Index.dev](https://www.index.dev/blog/best-backend-frameworks-ranked)
- [Wasp – Best Frameworks for Web Dev 2026](https://wasp.sh/resources/2026/02/24/best-frameworks-web-dev-2026)
- [Django RLS – Postgres Row Level Security for Django](https://django-rls.com/)
- [pganalyze – Using Postgres RLS in Python and Django](https://pganalyze.com/blog/postgres-row-level-security-django-python)
- [Complete Guide to PostgreSQL RLS in Django (2026)](https://medium.com/django-journal/complete-guide-to-postgresql-rls-in-django-multi-tenant-security-2026-874deafe877f)
- [django-guardian, django-rules, django-prbac packages](https://d.djangopackages.org/packages/p/django-rbac/)
- [Permit.io – FastAPI RBAC Full Implementation Tutorial](https://www.permit.io/blog/fastapi-rbac-full-implementation-tutorial)
- [Auth0 – Implementing RBAC with FastAPI + Auth0 FGA](https://auth0.com/blog/implementing-rbac-fastapi-auth0-fga/)
- [FastAPI + SQLAlchemy + Postgres RLS multitenancy](https://adityamattos.com/multi-tenancy-in-python-fastapi-and-sqlalchemy-using-postgres-row-level-security)
- [NestJS Authorization Docs](https://docs.nestjs.com/security/authorization)
- [Mastering Complex RBAC in NestJS with CASL + Prisma](https://blog.devgenius.io/mastering-complex-rbac-in-nestjs-integrating-casl-with-prisma-orm-for-granular-authorization-767941a05ef1)
- [Prisma – Enterprise-ready database for NestJS apps](https://www.prisma.io/nestjs)
- [Spring Boot + Spring Security + Postgres JWT example (BezKoder)](https://www.bezkoder.com/spring-boot-security-postgresql-jwt-authentication/)
- [Baeldung – Spring Security Roles and Privileges](https://www.baeldung.com/role-and-privilege-for-spring-security-registration)
- [Spring Boot 123 – Method Security with @PreAuthorize](https://www.springboot-123.com/en/blog/spring-boot-method-security-preauthorize-guide/)
- [Microsoft Learn – Role-based authorization in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/security/authorization/roles)
- [Microsoft Learn – Policy-based authorization](https://learn.microsoft.com/en-us/aspnet/core/security/authorization/policies)
- [Neon – ASP.NET Identity authentication with Postgres](https://neon.com/guides/aspnet-identity-auth)
- [Spatie – laravel-permission documentation](https://spatie.be/docs/laravel-permission/v7/introduction)
- [Neon – Fine-Grained Authorization in Laravel with Postgres](https://neon.com/guides/laravel-authorization)
- [Pundit GitHub repo](https://github.com/varvet/pundit)
- [Saeloun – Rails Authorization Patterns: Pundit, CanCanCan, Action Policy](https://blog.saeloun.com/2026/04/28/rails-authorization-patterns-complete-guide)
- [pundit_rbac](https://github.com/jkamenik/pundit_rbac)
- [AppSignal – Authorization and Policy Scopes for Phoenix Apps](https://blog.appsignal.com/2021/11/02/authorization-and-policy-scopes-for-phoenix-apps.html)
- [Bodyguard for Phoenix](https://github.com/schrockwell/bodyguard)
- [Curiosum – Authorization in Elixir: Permit Library](https://curiosum.com/blog/authorization-access-control-elixirconf)
- [Apache Casbin](https://casbin.apache.org/)
- [node-casbin (Apache)](https://github.com/casbin/node-casbin)
- [casbin/gorm-adapter (Postgres-backed policies)](https://github.com/casbin/gorm-adapter)
- [LyricTian/gin-admin – RBAC scaffold (Gin + GORM + Casbin)](https://github.com/LyricTian/gin-admin)
- [Flask-Security-Too / Flask-RBAC docs](https://flask-rbac.readthedocs.io/)
- [Flask-Authorize](https://flask-authorize.readthedocs.io/)
- [flask-sqlalchemy-rls (Postgres RLS)](https://github.com/charliewolf/flask-sqlalchemy-rls)
- [Aserto – Building RBAC in Node](https://www.aserto.com/blog/building-rbac-in-node)
