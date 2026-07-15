type EventMap = object
type Listener<T> = (payload: T) => void

export class TypedEventEmitter<Events extends EventMap> {
  private readonly listeners = new Map<keyof Events, Set<Listener<unknown>>>()

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    const listeners = this.listeners.get(event) ?? new Set<Listener<unknown>>()
    listeners.add(listener as Listener<unknown>)
    this.listeners.set(event, listeners)
    return () => this.off(event, listener)
  }

  once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    const unsubscribe = this.on(event, (payload) => {
      unsubscribe()
      listener(payload)
    })
    return unsubscribe
  }

  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    const listeners = this.listeners.get(event)
    listeners?.delete(listener as Listener<unknown>)
    if (listeners?.size === 0) this.listeners.delete(event)
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const listeners = this.listeners.get(event)
    if (!listeners) return
    for (const listener of [...listeners]) {
      try {
        listener(payload)
      } catch (error) {
        queueMicrotask(() => {
          throw error
        })
      }
    }
  }

  clear(): void {
    this.listeners.clear()
  }
}
