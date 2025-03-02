/**
 * @since 1.0.0
 */
import * as Reactivity from "@effect/experimental/Reactivity"
import * as Client from "@effect/sql/SqlClient"
import type { Connection } from "@effect/sql/SqlConnection"
import * as Statement from "@effect/sql/Statement"
import * as Otel from "@opentelemetry/semantic-conventions"
import * as Config from "effect/Config"
import type { ConfigError } from "effect/ConfigError"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FiberRef from "effect/FiberRef"
import { identity } from "effect/Function"
import { globalValue } from "effect/GlobalValue"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import * as ExpoSqlite from "expo-sqlite"
import type { SQLiteVariadicBindParams } from "expo-sqlite"

/**
 * @category type ids
 * @since 1.0.0
 */
export const TypeId: unique symbol = Symbol.for(
  "@effect/sql-sqlite-expo/SqliteClient"
)

/**
 * @category type ids
 * @since 1.0.0
 */
export type TypeId = typeof TypeId

/**
 * @category models
 * @since 1.0.0
 */
export interface SqliteClient extends Client.SqlClient {
  readonly [TypeId]: TypeId
  readonly config: SqliteClientConfig

  /** Not supported in sqlite */
  readonly updateValues: never
}

/**
 * @category tags
 * @since 1.0.0
 */
export const SqliteClient = Context.GenericTag<SqliteClient>(
  "@effect/sql-sqlite-expo/SqliteClient"
)

/**
 * @category models
 * @since 1.0.0
 */
export interface SqliteClientConfig {
  readonly database: string
  readonly spanAttributes?: Record<string, unknown> | undefined
  readonly transformResultNames?: ((str: string) => string) | undefined
  readonly transformQueryNames?: ((str: string) => string) | undefined
}

/**
 * @category fiber refs
 * @since 1.0.0
 */
export const asyncQuery: FiberRef.FiberRef<boolean> = globalValue(
  "@effect/sql-sqlite-expo/Client/asyncQuery",
  () => FiberRef.unsafeMake(false)
)

/**
 * @category fiber refs
 * @since 1.0.0
 */
export const withAsyncQuery = <R, E, A>(effect: Effect.Effect<A, E, R>) => Effect.locally(effect, asyncQuery, true)

interface SqliteConnection extends Connection {}
let dbRef: unknown
/**
 * @category constructor
 * @since 1.0.0
 */
export const make = (
  options: SqliteClientConfig
): Effect.Effect<SqliteClient, never, Scope.Scope | Reactivity.Reactivity> =>
  Effect.gen(function*() {
    const compiler = Statement.makeCompilerSqlite(options.transformQueryNames)
    const transformRows = options.transformResultNames
      ? Statement.defaultTransforms(options.transformResultNames).array
      : undefined

    const makeConnection = Effect.gen(function*() {
      if (dbRef) return
      dbRef = true
      const db = ExpoSqlite.openDatabaseSync(options.database)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          try {
            db.closeSync()
          } catch {
            // nothing to do
          }
          dbRef = false
        })
      )
      const run = (sql: string, params: ReadonlyArray<Statement.Primitive> = []) =>
        Effect.succeed(
          db.getAllSync<any>(sql, ...(params as SQLiteVariadicBindParams))
        )

      return identity<SqliteConnection>({
        execute(sql, params, transformRows) {
          return transformRows
            ? Effect.map(run(sql, params), transformRows)
            : run(sql, params)
        },
        executeRaw(sql, params) {
          return run(sql, params)
        },
        executeValues(sql, params) {
          return Effect.map(run(sql, params), (results) => {
            if (results.length === 0) {
              return []
            }
            const columns = Object.keys(results[0])
            return results.map((row) => columns.map((column) => row[column]))
          })
        },
        executeUnprepared(sql, params, transformRows) {
          return this.execute(sql, params, transformRows)
        },
        executeStream() {
          return Effect.dieMessage("executeStream not implemented")
        }
      })
    })

    const semaphore = yield* Effect.makeSemaphore(1)
    const connection = yield* makeConnection

    const acquirer = semaphore.withPermits(1)(Effect.succeed(connection)) as Connection.Acquirer
    const transactionAcquirer = Effect.uninterruptibleMask((restore) =>
      Effect.as(
        Effect.zipRight(
          restore(semaphore.take(1)),
          Effect.tap(Effect.scope, (scope) => Scope.addFinalizer(scope, semaphore.release(1)))
        ),
        connection
      )
    ) as Connection.Acquirer

    return Object.assign(
      (yield* Client.make({
        acquirer,
        compiler,
        transactionAcquirer,
        spanAttributes: [
          ...(options.spanAttributes
            ? Object.entries(options.spanAttributes)
            : []),
          [Otel.SEMATTRS_DB_SYSTEM, Otel.DBSYSTEMVALUES_SQLITE]
        ],
        transformRows
      })) as SqliteClient,
      {
        [TypeId]: TypeId,
        config: options
      }
    )
  })

/**
 * @category layers
 * @since 1.0.0
 */
export const layerConfig = (
  config: Config.Config.Wrap<SqliteClientConfig>
): Layer.Layer<SqliteClient | Client.SqlClient, ConfigError> =>
  Layer.scopedContext(
    Config.unwrap(config).pipe(
      Effect.flatMap(make),
      Effect.map((client) =>
        Context.make(SqliteClient, client).pipe(
          Context.add(Client.SqlClient, client)
        )
      )
    )
  ).pipe(Layer.provide(Reactivity.layer))

/**
 * @category layers
 * @since 1.0.0
 */
export const layer = (
  config: SqliteClientConfig
): Layer.Layer<SqliteClient | Client.SqlClient, ConfigError> =>
  Layer.scopedContext(
    Effect.map(make(config), (client) =>
      Context.make(SqliteClient, client).pipe(
        Context.add(Client.SqlClient, client)
      ))
  ).pipe(Layer.provide(Reactivity.layer))

/**
 * @category transformations
 * @since 1.0.0
 */
export const transform = {
  /**
   * Transforms snake_case to camelCase
   *
   * @since 1.0.0
   */
  snakeToCamel: (str: string): string =>
    str
      .toLowerCase()
      .replace(/([-_][a-z])/g, (group) => group.replace(/[-_]/, "").toUpperCase()),

  /**
   * Transforms camelCase to snake_case
   *
   * @since 1.0.0
   */
  camelToSnake: (str: string): string => str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
}
