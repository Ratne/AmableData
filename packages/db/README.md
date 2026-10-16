# @amable/db

Drizzle schemas for the installation D1 database and the per-tenant Durable Object
SQLite database, plus the versioned migration runner that applies pending migrations
at worker startup (D1) and on first access of each tenant DO. Migrations are ordered,
tracked in an applied-migrations table, and guarded by an advisory lease lock on D1.
