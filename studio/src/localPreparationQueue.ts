let queue = Promise.resolve()

/** The loopback worker runs one heavy job at a time across both decks and the library. */
export function queueLocalPreparation<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work)
  queue = next.then(() => {}, () => {})
  return next
}
