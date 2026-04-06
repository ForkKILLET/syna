
import {} from '@/core/contract'
import { Service } from '@/core/service'
import {} from '@/index'

declare module '@/index' {
  export interface Contracts {
    [$ILogger]: ILogger
  }

  export interface Services {
    [$LoggerService]: LoggerService
  }
}

export const enum LogLevel {
  Debug,
  Info,
  Warn,
  Error,
}

export interface ILogger {
  level: LogLevel
  log(message: string, ...args: any[]): void
  warn(message: string, ...args: any[]): void
  error(message: string, ...args: any[]): void
}

export const $ILogger = Symbol('ILogger')

export const $LoggerService = Symbol('LoggerService')

export interface LoggerService extends ILogger {}

export const LoggerService = Service({
  id: $LoggerService,
  impl: $ILogger,
  deps: {},
  setup: () => {
    const createLogMethod = (level: LogLevel, method: 'debug' | 'info' | 'warn' | 'error') => {
      return (message: string, ...args: any[]) => {
        if (logger.level > level) return
        console[method](message, ...args)
      }
    }

    const logger = {
      level: LogLevel.Info,
      log: createLogMethod(LogLevel.Debug, 'debug'),
      info: createLogMethod(LogLevel.Info, 'info'),
      warn: createLogMethod(LogLevel.Warn, 'warn'),
      error: createLogMethod(LogLevel.Error, 'error'),
    }

    return logger
  },
})