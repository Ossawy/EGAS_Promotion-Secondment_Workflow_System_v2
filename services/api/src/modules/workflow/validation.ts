import { AppError } from '../../shared/errors.ts'
import { text } from '../../shared/validation.ts'
import { WORKFLOW_TYPES, type WorkflowType } from './types.ts'

export interface CreateRequestInput {
  requestType: WorkflowType
  cycleYear: number
  formMonth: number
  formYear: number
}

function boundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new AppError(400, `${field} must be an integer between ${minimum} and ${maximum}`, 'WORKFLOW_VALIDATION_FAILED')
  }
  return value as number
}

export function createRequestInput(input: Record<string, unknown>): CreateRequestInput {
  if (typeof input.requestType !== 'string' || !(WORKFLOW_TYPES as readonly string[]).includes(input.requestType)) {
    throw new AppError(400, 'requestType must be PROMOTION or SECONDMENT', 'WORKFLOW_TYPE_INVALID')
  }
  return {
    requestType: input.requestType as WorkflowType,
    cycleYear: boundedInteger(input.cycleYear, 'cycleYear', 2000, 2200),
    formMonth: boundedInteger(input.formMonth, 'formMonth', 1, 12),
    formYear: boundedInteger(input.formYear, 'formYear', 2000, 2200)
  }
}

export function personnelNumber(value: unknown): string {
  return text(value, 'personnelNumber', 120)
}

export function noteText(value: unknown): string {
  return text(value, 'message', 2_000)
}
