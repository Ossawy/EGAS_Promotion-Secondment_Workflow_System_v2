export async function runCli(
  main: () => Promise<void>,
  cleanup: () => Promise<void>,
  fallbackError: string
): Promise<void> {
  try {
    await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : fallbackError)
    process.exitCode = 1
  } finally {
    try {
      await cleanup()
    } catch (error) {
      console.error(error instanceof Error ? error.message : fallbackError)
      process.exitCode = 1
    }
  }
}
