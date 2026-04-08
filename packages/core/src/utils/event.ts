import { ServiceId } from '@/core/service'
import { Effect } from './type'

export interface Events {
  'runtime/service/start': { serviceId: ServiceId, depName: string }
  'runtime/service/reuse': { serviceId: ServiceId, depName: string }
  'runtime/service/stop': { serviceId: ServiceId }
  'runtime/context/create': {}
  'runtime/context/dispose': {}
}

export type EventId = keyof Events

type Listener<K extends EventId> = (arg: Events[K]) => void
type TopListener = (arg: any) => void

export interface Emitter {
  on<K extends EventId>(event: K, listener: Listener<K>): Effect
  emit<K extends EventId>(event: K, arg: Events[K]): void
}

export const Emitter = (): Emitter => {
  const listenersMap: Record<string, Set<TopListener>> = {}

  return {
    on(eventId, listener): Effect {
      const listeners = listenersMap[eventId] ??= new Set() 
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    emit(eventId, arg): void {
      const listeners = listenersMap[eventId]
      listeners?.forEach(listener => listener(arg))
    },
  }
}