export type DisconnectableDatabase = {
  disconnect: () => Promise<unknown> | unknown
}

/**
 * Own a database service for one standalone command and always close its pool.
 * CAP's base cds.shutdown() is server-oriented and does not disconnect a
 * database opened by a script that never started an HTTP server.
 */
export async function withStandaloneDatabase<
  Database extends DisconnectableDatabase,
  Result
>(
  connect: () => Promise<Database>,
  command: (database: Database) => Promise<Result>
): Promise<Result> {
  const database = await connect()
  try {
    return await command(database)
  } finally {
    await database.disconnect()
  }
}
